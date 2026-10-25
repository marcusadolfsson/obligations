import Foundation

/// Sending approved drafts — the port of `deploy/integrations/imessage-send.py`.
///
/// This is the only thing in the app that acts outward as Alex. Everything
/// else reads and pushes; this produces something other people receive. The two
/// refusals below are the point of this file, not decoration, and they are
/// ported literally rather than reinterpreted:
///
///   1. Only `status: approved` is sent. A draft the agent wrote is never sent,
///      no matter what it says about itself. Checked twice — once in the remote
///      grep, once after fetching the file, because a discard can race the run.
///   2. The recipient must already appear in a recent thread. An injected
///      instruction's most likely move is "text this number", and a handle
///      nobody has ever messaged Alex from is exactly the shape of that
///      attack. If the known-handle list cannot be read the answer is *unknown*,
///      not *empty*, and nothing is sent at all.
///
/// Never retries. A message that silently arrives twice is worse than one that
/// visibly did not arrive: a failed send is marked `failed` and left for a
/// human, and no path here re-sends it.
///
/// Sending is off until switched on, and `OutboxSender.enabled` is persisted.
/// That is not timidity — while `com.example.obligations.imessage-send` is still
/// loaded, both would poll the same outbox on the same minute and the same
/// approved draft could go out twice. Retiring the LaunchAgent is the act that
/// makes turning this on safe, and the menu says so.
enum Outbox {

    /// A runaway loop upstream should not become a hundred texts.
    static let maxPerRun = 5
    static let maxCharacters = 2000

    struct Draft {
        let path: String
        let to: String
        let text: String
        let status: String
        /// When Alex approved it, if the draft records that. Absent for a
        /// draft whose `approved_at` is "-" or unparseable.
        let approvedAt: Date?
    }

    /// How old an approval may be and still send.
    ///
    /// On 2026-09-08 a draft approved before the weekend sent the moment the
    /// Mac woke, telling someone Alex was "out tomorrow for Labor Day" on the
    /// Tuesday morning after Labor Day, about a meeting that had already
    /// happened. Nothing was wrong with the sender: it did exactly what it was
    /// told, two days after the sentence stopped being true.
    ///
    /// A day is deliberately generous — the point is to catch a draft that has
    /// outlived its own content, not to police punctuality. An approval this
    /// old is marked failed and left for a human, which is recoverable; sending
    /// it is not.
    static let maxApprovalAge: TimeInterval = 24 * 60 * 60

    enum Outcome {
        case sent(to: String, characters: Int)
        case wouldSend(characters: Int)
        case refused(path: String, why: String)
        case failed(path: String, why: String)
    }

    // MARK: - the remote outbox

    private static func ssh(_ command: String, timeout: TimeInterval = 60) throws -> Runner.Result {
        try Runner.run("/usr/bin/ssh", [
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            Config.host, command,
        ], timeout: timeout)
    }

    /// Paths of drafts the assistant says are approved.
    static func approvedPaths() throws -> [String] {
        if Config.isLocal { return try localApproved(in: Config.localRoot) }
        let outbox = "\(Config.remoteRoot)/outbox"
        let result = try ssh("grep -l '^status: approved' \(outbox)/*.md 2>/dev/null || true")
        guard result.ok else {
            throw Runner.Failure.launch("cannot reach \(Config.host): \(result.problem)")
        }
        return result.stdout.split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { $0.hasSuffix(".md") }
    }

    /// Handles the assistant has actually seen a conversation with.
    ///
    /// Read from the extract the assistant already holds rather than from chat.db,
    /// so the allowlist is the same set of people the agent could see when it
    /// drafted — no wider. Returns nil when it cannot be determined, which the
    /// caller must treat as "send nothing".
    static func knownHandles() -> Set<String>? {
        let raw: Data?
        if Config.isLocal {
            raw = Transport.fetch("integrations/imessage.json")
        } else if let result = try? ssh("cat \(Config.remoteRoot)/integrations/imessage.json"), result.ok {
            raw = result.stdout.data(using: .utf8)
        } else {
            raw = nil
        }
        guard let data = raw,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let threads = json["threads"] as? [[String: Any]]
        else { return nil }

        var handles = Set<String>()
        for thread in threads {
            for handle in (thread["participants"] as? [String]) ?? [] {
                let trimmed = handle.trimmingCharacters(in: .whitespaces).lowercased()
                if !trimmed.isEmpty { handles.insert(trimmed) }
            }
        }
        return handles
    }

    /// The comparison form: `phone_key`/`email_key` from handles.py, in Swift.
    ///
    /// imessage-send.py stripped punctuation but not the country code, so a
    /// draft to "5550000002" was refused against a stored "+15550000002". It
    /// failed closed, which is the right direction, but the refusal it produced
    /// is the *injection* message — "recipient is not in any recent thread" —
    /// so a formatting difference read as an attack, and the person who wrote
    /// the draft had no way to tell the two apart.
    ///
    /// Last ten digits is the rule handles.py already uses to resolve contacts,
    /// calls and messages, so matching it here makes four things agree rather
    /// than three. Long international numbers keep their full digit string, so
    /// two genuinely different numbers still cannot collide.
    static func normalise(_ handle: String) -> String {
        let trimmed = handle.trimmingCharacters(in: .whitespaces).lowercased()
        if trimmed.contains("@") { return trimmed }              // email_key
        let digits = trimmed.filter(\.isNumber)
        guard !digits.isEmpty else { return trimmed }
        return digits.count >= 10 ? String(digits.suffix(10)) : digits
    }

    /// Split `---` front matter from the body. Same shape the drafts are
    /// written in, and the same tolerance for a file without any.
    static func parseFront(_ text: String) -> (meta: [String: String], body: String) {
        guard text.hasPrefix("---\n"),
              let end = text.range(of: "\n---\n", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
                  ?? text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
        else { return ([:], text) }

        let header = String(text[text.index(text.startIndex, offsetBy: 4)..<end.lowerBound])
        var meta: [String: String] = [:]
        for line in header.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces)
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            meta[key] = value
        }
        return (meta, String(text[end.upperBound...]))
    }

    static func fetch(_ path: String) -> Draft? {
        let text: String
        if Config.isLocal {
            return fetchLocal(path)
        } else {
            guard let result = try? ssh("cat '\(path)'"), result.ok else { return nil }
            text = result.stdout
        }
        let (meta, body) = parseFront(text)
        return Draft(path: path,
                     to: meta["to"] ?? "",
                     text: String(body.trimmingCharacters(in: .whitespacesAndNewlines)
                                      .prefix(maxCharacters)),
                     status: meta["status"] ?? "",
                     approvedAt: meta["approved_at"].flatMap(Stamp.minute.date(from:)))
    }

    // MARK: - sending

    /// AppleScript via osascript, with the recipient and body passed as argv and
    /// never interpolated into the script source. A message containing a quote
    /// or a backslash must not be able to change what AppleScript executes —
    /// the text being sent is attacker-influenced by construction.
    ///
    /// Requires Automation permission for Messages, which is a different grant
    /// from Full Disk Access and is prompted on the first send.
    static func send(to: String, text: String) -> Runner.Result? {
        let script = """
        on run argv
          set theTo to item 1 of argv
          set theText to item 2 of argv
          tell application "Messages"
            set targetService to 1st account whose service type = iMessage
            set targetBuddy to participant theTo of targetService
            send theText to targetBuddy
          end tell
        end run
        """
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("obligations-send-\(UUID().uuidString).applescript")
        guard (try? script.write(to: path, atomically: true, encoding: .utf8)) != nil else { return nil }
        defer { try? FileManager.default.removeItem(at: path) }
        return try? Runner.run("/usr/bin/osascript", [path.path, to, text], timeout: 60)
    }

    /// Rewrite status and the receipt line in place, on the assistant.
    static func mark(_ path: String, status: String, extraLine: String) {
        let key = extraLine.split(separator: ":").first.map(String.init) ?? "note"
        if Config.isLocal { markLocal(path, status: status, key: key, line: extraLine); return }
        _ = try? ssh("sed -i 's/^status: .*/status: \(status)/' '\(path)' && "
                     + "sed -i 's/^\(key): .*/\(extraLine)/' '\(path)'")
    }

    /// Refuse loudly and leave it for a human. Same sanitisation as the Python:
    /// the reason goes into a sed replacement, so slashes and quotes come out.
    static func refuse(_ path: String, _ reason: String) {
        let safe = String(reason.replacingOccurrences(of: "/", with: " ")
            .replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "\n", with: " ")
            .prefix(180))
        mark(path, status: "failed", extraLine: "error: \(safe)")
    }

    // MARK: - the server on this Mac

    /// The approved drafts in the local repo's outbox, by absolute path.
    ///
    /// What `grep -l '^status: approved'` did over ssh, with one difference
    /// that is the point: only the FRONT MATTER is read for the status. A body
    /// line that happens to say "status: approved" — the agent writes bodies —
    /// is not an approval. (grep had the same blind spot; nothing exploited it.)
    static func fetchLocal(_ path: String) -> Draft? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        let (meta, body) = parseFront(String(decoding: data, as: UTF8.self))
        return Draft(path: path,
                     to: meta["to"] ?? "",
                     text: String(body.trimmingCharacters(in: .whitespacesAndNewlines)
                                      .prefix(maxCharacters)),
                     status: meta["status"] ?? "",
                     approvedAt: meta["approved_at"].flatMap(Stamp.minute.date(from:)))
    }

    static func localApproved(in root: URL) throws -> [String] {
        let dir = root.appendingPathComponent("outbox", isDirectory: true)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
            throw Runner.Failure.launch("no outbox at \(dir.path)")
        }
        return names.filter { $0.hasSuffix(".md") }.sorted().compactMap { name in
            let path = dir.appendingPathComponent(name).path
            guard let data = FileManager.default.contents(atPath: path) else { return nil }
            let (meta, _) = parseFront(String(decoding: data, as: UTF8.self))
            return meta["status"] == "approved" ? path : nil
        }
    }

    /// The receipt, written into the draft's front matter: `status:` and one
    /// receipt line (`sent_at:` or `error:`), each replaced where it stands.
    ///
    /// Replaces two `sed -i` calls over ssh — GNU syntax, which BSD sed on this
    /// Mac reads as a backup suffix and would have failed every receipt. Only
    /// the front matter is touched, and the file is replaced by rename so the
    /// server's next read sees the old receipt or the new one, never half.
    /// The dispatcher commits it, as it always has: Obligations.app does not commit.
    static func markLocal(_ path: String, status: String, key: String, line: String) {
        let fm = FileManager.default
        guard let data = fm.contents(atPath: path) else { return }
        let text = String(decoding: data, as: UTF8.self)
        guard text.hasPrefix("---\n"),
              let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 4)..<text.endIndex)
        else { return }
        let front = text[text.index(text.startIndex, offsetBy: 4)..<end.lowerBound]
        var lines = front.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var sawKey = false
        for i in lines.indices {
            if lines[i].hasPrefix("status:") { lines[i] = "status: \(status)" }
            else if lines[i].hasPrefix("\(key):") { lines[i] = line; sawKey = true }
        }
        if !sawKey { lines.append(line) }
        let rewritten = "---\n" + lines.joined(separator: "\n") + String(text[end.lowerBound...])
        let tmp = path + ".obligations-app.tmp"
        guard fm.createFile(atPath: tmp, contents: Data(rewritten.utf8)) else { return }
        if rename(tmp, path) != 0 { try? fm.removeItem(atPath: tmp) }
    }

    /// `Obligations --outbox-selftest`: the local outbox paths against a scratch
    /// repo — never his. What is checked is what a mistake would cost: a body
    /// line read as approval, a receipt that clobbers the message, a draft
    /// without a receipt line left without one.
    static func selfTest() -> [String] {
        var lines: [String] = []
        var failed = false
        func check(_ what: String, _ ok: Bool) {
            lines.append("\(ok ? "ok  " : "FAIL") \(what)"); if !ok { failed = true }
        }
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("obligations-outbox-selftest-\(UUID().uuidString)")
        let outbox = root.appendingPathComponent("outbox")
        try? fm.createDirectory(at: outbox, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let approved = outbox.appendingPathComponent("a.md")
        let draft = outbox.appendingPathComponent("b.md")
        let sneaky = outbox.appendingPathComponent("c.md")
        try? "---\ntype: outbox\nto: +15550000001\nstatus: approved\napproved_at: 2026-10-01 10:00\nsent_at: -\nerror: -\n---\n\nHello there\n"
            .write(to: approved, atomically: true, encoding: .utf8)
        try? "---\ntype: outbox\nto: +15550000002\nstatus: draft\n---\n\nNot yet\n"
            .write(to: draft, atomically: true, encoding: .utf8)
        try? "---\ntype: outbox\nto: +15550000003\nstatus: draft\n---\n\nstatus: approved\n"
            .write(to: sneaky, atomically: true, encoding: .utf8)

        // The local functions are called directly, against this scratch root.
        // NOT by flipping serverMode/localRoot: those are shared preferences,
        // and a running Obligations.app would read them mid-test — and could send the
        // scratch draft above as a real text.

        let found = (try? localApproved(in: root)) ?? []
        check("finds the approved draft", found == [approved.path])
        check("a body line saying 'status: approved' is not an approval", !found.contains(sneaky.path))
        let d = fetchLocal(approved.path)
        check("reads the draft: recipient and text", d?.to == "+15550000001" && d?.text == "Hello there")

        markLocal(approved.path, status: "sent", key: "sent_at", line: "sent_at: 2026-10-01 10:01")
        let after = (try? String(contentsOf: approved, encoding: .utf8)) ?? ""
        check("the receipt sets status", after.contains("\nstatus: sent\n"))
        check("and replaces sent_at where it stands", after.contains("\nsent_at: 2026-10-01 10:01\n")
              && !after.contains("sent_at: -"))
        check("and leaves error and the body alone", after.contains("\nerror: -\n") && after.hasSuffix("\n\nHello there\n"))
        check("a sent draft is no longer approved", ((try? localApproved(in: root)) ?? []).isEmpty)

        markLocal(draft.path, status: "failed", key: "error",
                  line: "error: recipient is not in any recent thread; refusing to send")
        let refused = (try? String(contentsOf: draft, encoding: .utf8)) ?? ""
        check("a refusal with no error line gains one", refused.contains("\nstatus: failed\n")
              && refused.contains("\nerror: recipient is not in any recent thread"))
        check("and keeps its body", refused.hasSuffix("\n\nNot yet\n"))
        let leftovers = ((try? fm.contentsOfDirectory(atPath: outbox.path)) ?? []).filter { $0.hasSuffix(".tmp") }
        check("no temp files left behind", leftovers.isEmpty)

        lines.append(failed ? "FAILED" : "ALL PASSED")
        return lines
    }

    // MARK: - one pass

    /// Everything above, in the order imessage-send.py does it. Blocking;
    /// callers are on a background queue.
    static func runOnce(dryRun: Bool) -> [Outcome] {
        let paths: [String]
        do {
            paths = try approvedPaths()
        } catch {
            return [.failed(path: "outbox", why: error.localizedDescription)]
        }
        guard !paths.isEmpty else { return [] }

        // Unknown, not empty. If the allowlist cannot be read then every
        // recipient is unverifiable, and the only safe answer is to send none.
        guard let allowed = knownHandles() else {
            return [.failed(path: "outbox",
                            why: "could not read the known-handles list; refusing to send anything")]
        }
        let allowedNormalised = Set(allowed.map(normalise))

        var outcomes: [Outcome] = []
        for path in paths.prefix(maxPerRun) {
            guard let draft = fetch(path) else { continue }

            // Re-checked after fetching: the grep that found this file ran a
            // moment ago, and a discard in between must win.
            guard draft.status == "approved" else { continue }

            // A dry run reports and writes nothing. imessage-send.py marks a
            // refused draft `failed` on the assistant before it checks --dry-run,
            // so its dry run is not actually dry: it rewrites the very files it
            // claims only to report on. Not ported.
            guard !draft.to.isEmpty, !draft.text.isEmpty else {
                let why = "draft has no recipient or no text"
                if !dryRun { refuse(path, why) }
                outcomes.append(.refused(path: path, why: why))
                continue
            }
            // Only when the draft says when it was approved. A missing or "-"
            // value is left alone rather than refused: adding a refusal that
            // fires on drafts the assistant has always written this way would stop
            // sending altogether, which is a worse failure than the one being
            // fixed.
            if let approvedAt = draft.approvedAt,
               Date().timeIntervalSince(approvedAt) > maxApprovalAge {
                let age = Int(Date().timeIntervalSince(approvedAt) / 3600)
                let why = "approved \(age)h ago; too old to send without being approved again"
                if !dryRun { refuse(path, why) }
                outcomes.append(.refused(path: path, why: why))
                continue
            }
            guard allowedNormalised.contains(normalise(draft.to)) else {
                let why = "recipient is not in any recent thread; refusing to send"
                if !dryRun { refuse(path, why) }
                outcomes.append(.refused(path: path, why: why))
                continue
            }

            if dryRun {
                outcomes.append(.wouldSend(characters: draft.text.count))
                continue
            }

            guard let result = send(to: draft.to, text: draft.text) else {
                refuse(path, "could not run osascript")
                outcomes.append(.failed(path: path, why: "could not run osascript"))
                continue
            }
            if result.ok {
                let stamp = Stamp.minute.string(from: Date())
                mark(path, status: "sent", extraLine: "sent_at: \(stamp)")
                outcomes.append(.sent(to: draft.to, characters: draft.text.count))
            } else {
                // No retry, deliberately. Marked failed and left alone.
                refuse(path, result.problem)
                outcomes.append(.failed(path: path, why: result.problem))
            }
        }
        return outcomes
    }
}

enum Stamp {
    static let minute: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()
}

/// The 60-second poll, and what the menu shows about it.
///
/// Deliberately not a `SyncJob` on the SyncEngine queue. Sending is the
/// interactive path — Alex taps Send and expects the message to go, not to go
/// after a 14-day iMessage extract finishes — and the engine runs one job at a
/// time by design. Reading and sending have different urgency and stay separate,
/// as they were as two LaunchAgents.
@MainActor
final class OutboxSender: ObservableObject {

    static let shared = OutboxSender()

    /// Off until switched on. See the note in `Outbox`: with the LaunchAgent
    /// still loaded, both senders would poll the same outbox and one approved
    /// draft could go out twice.
    @Published private(set) var enabled: Bool {
        didSet { UserDefaults.standard.set(enabled, forKey: "outboxEnabled") }
    }

    @Published private(set) var lastRun: Date?
    @Published private(set) var lastSent: Date?
    @Published private(set) var lastMessage: String?
    @Published private(set) var running = false

    private var timer: Timer?
    private let queue = DispatchQueue(label: "com.example.obligations.outbox")

    init() {
        enabled = UserDefaults.standard.bool(forKey: "outboxEnabled")
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        RunLoop.main.add(timer!, forMode: .common)
        poll()
    }

    func setEnabled(_ value: Bool) {
        enabled = value
        Log.write(value ? "outbox: sending enabled" : "outbox: sending disabled")
        if value { poll() }
    }

    /// A pass that sends nothing, to prove the refusals work before switching on.
    func dryRun() { poll(dryRun: true) }

    func poll(dryRun: Bool = false) {
        guard !running, dryRun || enabled else { return }
        running = true
        queue.async { [weak self] in
            let outcomes = Outbox.runOnce(dryRun: dryRun)
            Task { @MainActor in
                guard let self else { return }
                self.running = false
                self.lastRun = Date()
                // A clean poll with nothing approved produces no outcome, so
                // without this the last failure stayed on the menu for as
                // long as nothing was sent: a 27-minute overnight blip on
                // 2026-09-09 read as "broken since yesterday" eight hours
                // after the link came back.
                if outcomes.isEmpty { self.lastMessage = nil }
                for outcome in outcomes {
                    switch outcome {
                    case .sent(_, let characters):
                        // The recipient is not logged. This log is read while
                        // screen-sharing and pasted into bug reports, and who
                        // Alex texts is not part of diagnosing the sender.
                        self.lastSent = Date()
                        self.lastMessage = "sent \(characters) chars"
                        Log.write("outbox: sent \(characters) chars")
                    case .wouldSend(let characters):
                        self.lastMessage = "dry run: would send \(characters) chars"
                        Log.write("outbox: dry run — would send \(characters) chars")
                    case .refused(_, let why):
                        self.lastMessage = why
                        Log.write("outbox: REFUSED — \(why)")
                    case .failed(_, let why):
                        self.lastMessage = why
                        Log.write("outbox: \(why)")
                    }
                }
            }
        }
    }
}
