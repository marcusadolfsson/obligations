import AppKit
import Contacts
import EventKit
import Foundation

/// Noticing that a source changed, instead of asking every fifteen minutes.
///
/// Alex, 2026-09-20: "we want to modify Obligations.app pushes on change instead
/// of on a timer." A timer is wrong in both directions at once — it waits up
/// to fifteen minutes to notice a text that arrived a second ago, and it wakes
/// up to push an unchanged snapshot on the quiet afternoons that are most of
/// them.
///
/// Each source says when it changed, in its own way:
///
/// - **chat.db and CallHistory** — a `DispatchSource` on the database, on its
///   `-wal` sibling, AND on the enclosing directory. All three are needed and
///   the first version had only the directory, which does not fire at all for
///   an ordinary write: a directory reports entries appearing and disappearing,
///   not bytes landing in a file that is already there. Messages writes into
///   `chat.db-wal` for minutes at a time, so the watcher stayed silent and the
///   watermark check pushed instead — right answer, wrong path, and it would
///   have looked like "pushes on change" working. SQLite also replaces these
///   files on checkpoint, which is why a file source that sees `.delete` or
///   `.rename` re-opens the path a second later rather than watching a file
///   nothing writes to any more.
/// - **Contacts** — `CNContactStoreDidChange`.
/// - **Reminders** — `.EKEventStoreChanged`, which is also how his tick
///   reaches the assistant within seconds rather than at the next quarter hour.
///
/// Two things make this safe to act on. A burst is **coalesced**: one text is
/// one push, and twenty texts in a minute are also one push. And a change is
/// only ever a *hint* — it marks the job pending, and the engine decides
/// whether to run it, so the floor between two pushes still holds.
///
/// The timer does not go away; it becomes the **safety net**, an hour rather
/// than a quarter of one. Nothing here can see a change that happened while
/// the machine was asleep, a watcher can die with its file descriptor, and a
/// missed event on this path is a message the assistant never learns about. The
/// wake notification and the watermark check cover the same ground from the
/// other side.
@MainActor
final class Watch {

    /// How long to wait for a burst to finish before calling it a change.
    /// Long enough that a conversation is one push; short enough that the
    /// repo has a message about a meeting before the meeting.
    private static let quiet: TimeInterval = 20

    /// Held for as long as the app runs, on purpose. EventKit posts
    /// `.EKEventStoreChanged` from a live store; the sync path creates one per
    /// pass and lets it go, so with no store of our own the notification never
    /// arrives and his tick waits for the quarter-hour poll — the exact
    /// latency this change exists to remove.
    private var eventStore: EKEventStore?

    private var sources: [DispatchSourceFileSystemObject] = []
    /// Paths with a live file source, so a directory event does not stack
    /// a second watcher on the same file every time anything happens.
    private var watched: Set<String> = []
    private var observers: [NSObjectProtocol] = []
    private var pending: [String: Timer] = [:]
    private let changed: (String) -> Void
    private let startedAt = Date()

    /// - Parameter changed: called with a job id once a burst has settled.
    init(changed: @escaping (String) -> Void) {
        self.changed = changed
    }

    func start() {
        watchDatabase(Permissions.messagesDatabase, for: "imessage")
        watchDatabase(Permissions.callsDatabase, for: "calls")

        observe(.CNContactStoreDidChange, "contacts")
        if Reminders.hasAccess() {
            eventStore = EKEventStore()
            observe(.EKEventStoreChanged, "reminders")
        } else {
            Log.write("watch: no Reminders access yet — that job stays on the quarter-hour")
        }
    }

    /// A SQLite database is three moving parts and one directory.
    private func watchDatabase(_ db: URL, for job: String) {
        // Said out loud, per file. A watcher that cannot open chat.db falls
        // back to the hourly net and to the watermark check, and both of
        // those look like success from the outside — the failure this says
        // out loud is "pushes on change" silently becoming "pushes hourly".
        let onDB = watchPath(db, for: job)
        let wal = URL(fileURLWithPath: db.path + "-wal")
        let onWAL = watchPath(wal, for: job)
        if !onDB {
            Log.write("watch: CANNOT open \(db.lastPathComponent) for \(job) (errno \(errno)) "
                      + "— it will sync on the hourly net instead of on change")
        }
        watchDirectory(of: db, for: job)
        Log.write("watch: \(job) — \(db.lastPathComponent) \(onDB ? "yes" : "NO"), "
                  + "-wal \(onWAL ? "yes" : "not present yet")")
    }

    /// Watch one file, and re-open it if it is replaced.
    ///
    /// A missing `-wal` is normal — SQLite creates it when it needs it — so a
    /// failure to open is logged only once, by the directory watcher, and this
    /// stays quiet: the directory event fires when the file appears, and the
    /// re-arm below picks it up.
    @discardableResult
    private func watchPath(_ file: URL, for job: String) -> Bool {
        let fd = open(file.path, O_EVTONLY)
        guard fd >= 0 else { watched.remove(file.path); return false }
        watched.insert(file.path)
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .delete, .rename, .attrib, .link],
            queue: .main)
        source.setEventHandler { [weak self, weak source] in
            guard let self else { return }
            let data = source?.data ?? []
            Task { @MainActor in
                self.sawEvent(job, file.path, data)
                self.noteChange(job)
                // Checkpointed away: the descriptor now names a file nothing
                // writes to. Drop it and take the path again.
                if data.contains(.delete) || data.contains(.rename) {
                    self.rearm(source, file, for: job)
                }
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        sources.append(source)
        return true
    }

    private func watching(_ file: URL) -> Bool { watched.contains(file.path) }

    private func rearm(_ old: DispatchSourceFileSystemObject?, _ file: URL, for job: String) {
        if let old {
            old.cancel()
            sources.removeAll { $0 === old }
        }
        watched.remove(file.path)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            Task { @MainActor in self?.watchPath(file, for: job) }
        }
    }

    /// Watch the directory a database lives in — for the files themselves
    /// appearing, being replaced, or being checkpointed away.
    ///
    /// Opening it needs Full Disk Access, the same grant the extract needs. If
    /// it fails the job still runs on the safety net, so this logs and carries
    /// on rather than failing the app — but it says which, because "pushes on
    /// change" quietly degrading to "pushes hourly" is exactly the kind of
    /// silence this repo treats as a bug.
    private func watchDirectory(of file: URL, for job: String) {
        let directory = file.deletingLastPathComponent()
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else {
            Log.write("watch: cannot watch \(directory.lastPathComponent) for \(job) "
                      + "(errno \(errno)) — that job stays on the hourly net")
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .rename, .delete, .link, .attrib],
            queue: .main)
        source.setEventHandler { [weak self, weak source] in
            Task { @MainActor in
                guard let self else { return }
                self.sawEvent(job, directory.path, source?.data ?? [])
                self.noteChange(job)
                // A -wal that has just been created is one nothing is watching
                // yet; taking the path again is cheap and idempotent enough.
                let wal = URL(fileURLWithPath: file.path + "-wal")
                if FileManager.default.fileExists(atPath: wal.path), !self.watching(wal) {
                    self.watchPath(wal, for: job)
                }
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        sources.append(source)
        watched.insert(file.path)
        watched.insert(file.path + "-wal")
        Log.write("watch: \(job) directory \(directory.lastPathComponent)")
    }

    private func observe(_ name: Notification.Name, _ job: String) {
        let token = NotificationCenter.default.addObserver(
            forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    // Contacts and EventKit both announce a change as the app
                    // starts, every time. Acting on it pushed a 300KB contacts
                    // snapshot on every restart for no reason.
                    guard Date().timeIntervalSince(self.startedAt) > 5 else {
                        Log.write("watch: ignoring \(job) notification at launch")
                        return
                    }
                    self.noteChange(job)
                }
            }
        observers.append(token)
        Log.write("watch: \(job) on \(name.rawValue)")
    }

    /// One line per path per minute, so "did the watcher see it" is
    /// answerable from the log the morning after rather than by guessing.
    /// A raw event is not a sync: it says the source moved, and the engine
    /// still decides. Throttled because chat.db-wal moves constantly while a
    /// conversation is open.
    private var lastSaid: [String: Date] = [:]

    private func sawEvent(_ job: String, _ path: String, _ mask: DispatchSource.FileSystemEvent) {
        let now = Date()
        if let said = lastSaid[path], now.timeIntervalSince(said) < 60 { return }
        lastSaid[path] = now
        var names: [String] = []
        if mask.contains(.write) { names.append("write") }
        if mask.contains(.extend) { names.append("extend") }
        if mask.contains(.delete) { names.append("delete") }
        if mask.contains(.rename) { names.append("rename") }
        if mask.contains(.attrib) { names.append("attrib") }
        if mask.contains(.link) { names.append("link") }
        Log.write("watch event: \(job) \((path as NSString).lastPathComponent) "
                  + "\(names.isEmpty ? "?" : names.joined(separator: "+"))")
    }

    /// Restart the quiet timer. The change is reported only once it stops.
    private func noteChange(_ job: String) {
        pending[job]?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: quietOverride ?? Self.quiet, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.pending[job] = nil
                self?.changed(job)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        pending[job] = timer
    }

    /// `--watch-selftest`: does a write to a watched file actually wake us?
    ///
    /// The same `watchPath` the real sources use, pointed at a scratch file in
    /// the app's own support directory, written to twice. It answers the
    /// question his message traffic cannot answer on a quiet evening — and it
    /// is what caught the first version, where a directory-only watcher never
    /// fired for a write and the watermark check covered for it.
    static func selfTest() -> [String] {
        var lines: [String] = []
        let sem = DispatchSemaphore(value: 0)
        var fired = 0

        Config.ensureSupport()
        let file = Config.support.appendingPathComponent("watch-selftest.tmp")
        FileManager.default.createFile(atPath: file.path, contents: Data("one\n".utf8))

        let watcher = Watch { _ in fired += 1; sem.signal() }
        watcher.quietOverride = 1
        _ = watcher.watchPath(file, for: "selftest")
        lines.append("watching \(file.lastPathComponent)")

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            if let h = try? FileHandle(forWritingTo: file) {
                h.seekToEndOfFile()
                h.write(Data("two\n".utf8))
                try? h.close()
            }
        }

        let deadline = Date().addingTimeInterval(10)
        while fired == 0, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        lines.append(fired > 0 ? "a write fired the watcher: PASS"
                               : "a write did NOT fire the watcher: FAIL")
        try? FileManager.default.removeItem(at: file)
        return lines
    }

    /// Shorter quiet period, for the self test only.
    fileprivate var quietOverride: TimeInterval?

    deinit {
        for source in sources { source.cancel() }
        for token in observers { NotificationCenter.default.removeObserver(token) }
    }
}
