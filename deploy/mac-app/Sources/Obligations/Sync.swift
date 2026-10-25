import AppKit
import Foundation

/// One thing that gets extracted here and pushed to the assistant.
struct SyncJob: Identifiable, Hashable {
    let id: String
    let title: String
    /// Script in the app bundle's Resources.
    let script: String
    let arguments: [String]
    /// Where the extract lands on the server, under `Config.remoteRoot`.
    let remotePath: String
    /// The safety net: how long without a push before it runs anyway.
    ///
    /// Since 2026-09-20 this is no longer the normal path — `Watch` reports a
    /// change and the job runs within seconds. It stays as the floor under
    /// everything the watcher cannot see: a change made while the machine was
    /// asleep, a file descriptor that died, a source with no notification.
    let interval: TimeInterval

    /// Shortest gap between two pushes of this job, when the watcher is the
    /// one asking. Without it an active conversation is a push per reply.
    let minimumGap: TimeInterval
    /// What it needs before it can work at all.
    let needs: Requirement

    enum Requirement { case fullDiskAccess, contacts, reminders, none }

    static let all: [SyncJob] = [
        // On change, within seconds, and hourly regardless. Messages are the
        // one source where latency is visible to Alex: a reply he owes shows
        // up on /tasks only after a sync.
        SyncJob(id: "imessage", title: "iMessage",
                script: "imessage-extract.py", arguments: ["--days", "14"],
                remotePath: "integrations/imessage.json",
                interval: 60 * 60, minimumGap: 60, needs: .fullDiskAccess),

        // On change, hourly regardless. A connected call closes an obligation — see
        // spoke_since() in imessage-diff.py — so this is not merely a log.
        SyncJob(id: "calls", title: "Phone Calls",
                script: "call-log-extract.py", arguments: [],
                remotePath: "integrations/calls.json",
                interval: 60 * 60, minimumGap: 60, needs: .fullDiskAccess),

        // On change, six-hourly regardless. Names change rarely, and the assistant resolves handles at
        // read time, so a stale contacts file costs nothing but a phone number
        // shown where a name would be.
        SyncJob(id: "contacts", title: "Contacts",
                script: "contacts-extract.py", arguments: [],
                remotePath: "integrations/contacts.json",
                interval: 6 * 60 * 60, minimumGap: 5 * 60, needs: .contacts),

        // On his tick, and every quarter hour for the mirror. In-process
        // (Reminders.swift),
        // not as a script: EventKit's grant belongs to the signed bundle. Also
        // the writer — it brings the Obligations list in line with the mirror first,
        // so what it pushes describes the list as it now is.
        SyncJob(id: "reminders", title: "Reminders",
                script: "", arguments: [],
                // The one job whose interval is still the point. The writer
                // has to ASK the assistant what it wants — the server holds no
                // credentials into this Mac and cannot tell us — so the mirror
                // is polled. The watcher only makes his own tick immediate.
                remotePath: Reminders.extractPath,
                interval: 15 * 60, minimumGap: 30, needs: .reminders),
    ]
}

/// What happened last time, per job. Persisted, because "when did this last
/// work" must survive a restart — that is the question the menu exists to
/// answer, and an app that forgets it every launch answers it wrongly.
struct SyncState: Codable, Equatable {
    var lastAttempt: Date?
    var lastSuccess: Date?
    var lastError: String?
    var lastBytes: Int?

    /// The newest message that has actually reached the assistant, as a raw
    /// chat.db `date`. Only meaningful for the iMessage job.
    ///
    /// Recorded from a read taken BEFORE the extract, so it is conservative by
    /// construction: anything that arrives mid-extract leaves the mark behind
    /// and earns another pass, which is the safe direction to be wrong in.
    var watermark: Int64?

    /// Deliberately separate from `lastError`: a job can be failing now and
    /// still have succeeded this morning, and the menu should say both. One
    /// combined field forces a choice between "it is broken" and "the data is
    /// fresh", which are different questions.
    var isFailing: Bool { lastError != nil }
}

@MainActor
final class SyncEngine: ObservableObject {

    static let shared = SyncEngine()

    @Published private(set) var state: [String: SyncState] = [:]
    @Published private(set) var running: String?
    @Published private(set) var paused = false

    /// Shortest gap between two extracts triggered by new messages rather than
    /// by the schedule. Without a floor, an active conversation would push a
    /// whole snapshot for every reply.
    nonisolated static let behindMinimumGap: TimeInterval = 5 * 60

    /// The newest message in chat.db, or nil if it cannot be read.
    ///
    /// One indexed `MAX(date)` — milliseconds against 272,776 rows — which is
    /// what makes asking on every tick affordable.
    nonisolated static func newestMessage() -> Int64? {
        let db = Permissions.messagesDatabase.path
        guard let r = try? Runner.run("/usr/bin/sqlite3",
                                      ["-readonly", db, "SELECT MAX(date) FROM message;"],
                                      timeout: 30), r.ok else { return nil }
        return Int64(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Is the assistant missing messages this Mac can already see?
    ///
    /// This replaced waiting a fixed five minutes after a wake, and then
    /// polling until chat.db stopped moving. Both inferred completeness from
    /// quiescence, which is a guess: a database that has gone quiet because
    /// iCloud has not started yet looks exactly like one that has finished.
    ///
    /// Comparing the newest row against the newest row actually pushed is not a
    /// guess. On 2026-09-08 it would have said, at any moment after the backlog
    /// landed, that 173 messages sat past the mark — no timer, no threshold, no
    /// twenty-minute cap.
    nonisolated static func isBehind(_ state: SyncState?) -> Bool {
        guard let watermark = state?.watermark, let newest = newestMessage() else { return false }
        return newest > watermark
    }

    private var timer: Timer?
    private var watch: Watch?
    /// Jobs a source says have changed, waiting for their turn and their floor.
    private var pending: Set<String> = []
    private let queue = DispatchQueue(label: "com.example.obligations.sync")
    private let store = Config.support.appendingPathComponent("sync-state.json")

    init() {
        load()
    }

    func start() {
        // One tick a minute drives everything; each job decides whether it is
        // due. The alternative — a timer per job — is four things to get wrong
        // and four things to invalidate when the machine wakes from sleep.
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer!, forMode: .common)

        // The normal path since 2026-09-20: the source says it changed and the
        // job runs within seconds. The timer above is what catches whatever
        // the watchers cannot see.
        watch = Watch { [weak self] job in
            Task { @MainActor in self?.sourceChanged(job) }
        }
        watch?.start()

        // On wake, just look. The watermark comparison below does the rest:
        // as the backlog lands, chat.db advances past what was last pushed and
        // the next tick fetches it. Nothing here has to know how long iCloud
        // will take, which is the question no version of a timer could answer.
        NotificationCenter.default.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
                Log.write("woke")
                Task { @MainActor in SyncEngine.shared.tick() }
            }

        tick()
    }

    func setPaused(_ value: Bool) {
        paused = value
        Log.write(value ? "sync paused" : "sync resumed")
        if !value { tick() }
    }

    /// A source changed. Mark it and try now; `tick` decides if it may run.
    private func sourceChanged(_ id: String) {
        guard let job = SyncJob.all.first(where: { $0.id == id }) else { return }
        pending.insert(job.id)
        tick()
    }

    private func tick() {
        guard !paused, running == nil else { return }
        let now = Date()
        for job in SyncJob.all {
            let last = state[job.id]?.lastAttempt ?? .distantPast
            let due = now.timeIntervalSince(last) >= job.interval

            // Changed, and far enough from the last push. A job still pending
            // when its floor has not elapsed stays pending — the next tick,
            // at most a minute later, picks it up.
            let changed = pending.contains(job.id)
                && now.timeIntervalSince(last) >= job.minimumGap

            // Ahead of schedule when the assistant is demonstrably missing
            // messages. Bounded so a live conversation cannot turn every reply
            // into a push, and only for iMessage — calls and contacts have no
            // equivalent signal and no comparable urgency.
            let behind = job.id == "imessage"
                && now.timeIntervalSince(last) >= Self.behindMinimumGap
                && Self.isBehind(state[job.id])

            if due || behind || changed {
                if changed && !due { Log.write("\(job.id): changed — syncing") }
                else if behind && !due { Log.write("\(job.id): behind the assistant — syncing early") }
                pending.remove(job.id)
                run(job)
                return                      // one at a time; the next tick takes the next
            }
        }
    }

    /// "Force Sync" — every job, now, regardless of when it last ran.
    func syncAll() {
        guard running == nil else { return }
        runSequentially(Array(SyncJob.all))
    }

    func run(_ job: SyncJob) {
        guard running == nil else { return }
        runSequentially([job])
    }

    private func runSequentially(_ jobs: [SyncJob]) {
        guard let job = jobs.first else { running = nil; return }
        running = job.id
        let rest = Array(jobs.dropFirst())

        queue.async { [weak self] in
            let outcome = Self.perform(job)
            Task { @MainActor in
                guard let self else { return }
                var s = self.state[job.id] ?? SyncState()
                s.lastAttempt = Date()
                switch outcome {
                case .success(let bytes, let mark):
                    s.lastSuccess = Date()
                    s.lastError = nil
                    s.lastBytes = bytes
                    if let mark { s.watermark = mark }
                    Log.write("\(job.id): synced \(bytes) bytes")
                case .failure(let why):
                    s.lastError = why
                    Log.write("\(job.id): \(why)")
                }
                self.state[job.id] = s
                self.save()
                self.running = nil
                if !rest.isEmpty { self.runSequentially(rest) }
            }
        }
    }

    private enum Outcome { case success(bytes: Int, watermark: Int64?), failure(String) }

    /// Extract to a temp file, then push. Never the other way round.
    ///
    /// If extraction fails the copy on the server is left exactly as it was:
    /// stale data the assistant can date is better than no data, and the brief
    /// reports staleness itself. Writing an empty file on failure would make a
    /// broken Mac look like a quiet week.
    private nonisolated static func perform(_ job: SyncJob) -> Outcome {
        if case .reminders = job.needs {
            let result = Reminders.sync()
            if let problem = result.problem { return .failure(problem) }
            return .success(bytes: result.bytes ?? 0, watermark: nil)
        }
        guard let resources = Bundle.main.resourceURL else {
            return .failure("the app bundle has no Resources directory")
        }
        let script = resources.appendingPathComponent(job.script)
        guard FileManager.default.fileExists(atPath: script.path) else {
            return .failure("missing from the bundle: \(job.script)")
        }

        if case .fullDiskAccess = job.needs, !Permissions.hasFullDiskAccess() {
            return .failure("needs Full Disk Access")
        }
        if case .contacts = job.needs, !Permissions.hasContacts() {
            return .failure("needs Contacts access")
        }

        Config.ensureSupport()
        let out = Config.support.appendingPathComponent("\(job.id).json")

        // Before the extract, not after. If messages land while it runs they
        // are past this mark, so the next tick sees the machine as behind and
        // fetches them. Reading afterwards would claim they had been sent.
        let mark = job.id == "imessage" ? newestMessage() : nil

        let result: Runner.Result
        do {
            result = try Runner.run(Config.python,
                                    [script.path] + job.arguments + ["--out", out.path],
                                    timeout: 180)
        } catch {
            return .failure(error.localizedDescription)
        }
        guard result.ok else { return .failure(result.problem) }

        // The extractors write JSON; an empty or truncated file means the run
        // half-worked, and pushing it would overwrite good data with bad.
        let attributes = try? FileManager.default.attributesOfItem(atPath: out.path)
        let bytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        guard bytes > 2 else {
            return .failure("produced no output; the copy on the assistant is untouched")
        }

        if let why = Transport.push(out, to: job.remotePath) { return .failure(why) }
        return .success(bytes: bytes, watermark: mark)
    }

    /// One pass of every job, synchronously, for `Obligations --sync-now`.
    ///
    /// The scheduled path waits for a job to fall due — contacts every six
    /// hours — which is the wrong tool when the question is "does the extractor
    /// I just changed still parse the local store". Runs on whatever thread
    /// calls it and returns what happened rather than logging and hoping.
    nonisolated static func runAllOnce() -> [String] {
        SyncJob.all.map { job in
            // Deliberately does not move the watermark: this runs in a
            // one-shot process that exits, so the mark it wrote would be
            // invisible to the app anyway. The running app then sees itself
            // behind and syncs once more, which is the safe direction — an
            // extra extract rather than a missed one.
            switch perform(job) {
            case .success(let bytes, _): return "\(job.id): synced \(bytes) bytes"
            case .failure(let why):      return "\(job.id): FAILED — \(why)"
            }
        }
    }

    // MARK: - persistence

    private func load() {
        guard let data = try? Data(contentsOf: store),
              let decoded = try? JSONDecoder().decode([String: SyncState].self, from: data)
        else { return }
        state = decoded
    }

    private func save() {
        Config.ensureSupport()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(state) { try? data.write(to: store) }
    }
}
