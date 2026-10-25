import AppKit
import Foundation

/// The assistant server on this Mac, as the Obligations menu sees and drives it.
///
/// Alex, 2026-10-01: "add the server status to the existing Obligations app, we
/// don't need a separate UI for the server." Obligations Server.app is headless; this
/// is its only face.
///
/// How it sees: `.log/server-status.json`, the heartbeat the server writes each
/// minute (deploy/agent-service/heartbeat.mjs), and `obligations-server status` from
/// the Obligations Server bundle. Never HTTP — every route needs a Cloudflare Access
/// token — and never anything from the repo: the agent can write the repo, and
/// this app holds Full Disk Access.
///
/// How it drives: `obligations-server register|enable|disable`, run from
/// /Applications (not the repo), and `launchctl kickstart`/`kill` on the two
/// labels. The server's own `enabled` switch is a preference the server's
/// sandbox cannot write.
@MainActor
final class ServerMonitor: ObservableObject {

    static let shared = ServerMonitor()

    nonisolated static let launcher = "/Applications/Obligations Server.app/Contents/MacOS/obligations-server"
    nonisolated static let serverLabel = "com.example.obligations.server"
    nonisolated static let dispatchLabel = "com.example.obligations.dispatch"

    /// A heartbeat older than this means the server is not running. It writes
    /// one a minute; three missed is down, not slow.
    nonisolated static let staleAfter: TimeInterval = 180

    struct Heartbeat: Equatable {
        var at: Date
        var stamp: String
        var busy: String?
        var lastJob: String?
        var lastJobAt: String?
        var claude: String
        var modelEnabled: Bool?
    }

    enum State: Equatable {
        case notInstalled                 // no Obligations Server.app
        case notRegistered                // installed, agents not registered
        case needsApproval                // registered; approve in Login Items
        case off                          // registered, this Mac is not the server
        case starting                     // enabled, no fresh heartbeat yet
        case up(Heartbeat)
        case down(since: Date?)           // enabled, heartbeat stale
    }

    @Published private(set) var state: State = .notInstalled
    @Published private(set) var lastReconcile: String?
    @Published private(set) var working: String?

    private var timer: Timer?
    private var launcherStatus: [String: Any] = [:]
    private var enabledAt: Date?

    func start() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    // MARK: - reading

    var installed: Bool { FileManager.default.isExecutableFile(atPath: Self.launcher) }

    func refresh() {
        guard installed else { state = .notInstalled; return }
        Task.detached {
            let status = Self.launcherJSON(["status"]) ?? [:]
            let beat = Self.readHeartbeat()
            await MainActor.run { self.apply(status: status, heartbeat: beat) }
        }
    }

    private func apply(status: [String: Any], heartbeat: Heartbeat?) {
        launcherStatus = status
        if pendingRestart {
            if let what = Self.busyWith() { working = "restart waits for \(what)" }
            else { working = nil; restart() }
        }
        let agents = status["agents"] as? [String: String] ?? [:]
        let server = agents[Self.serverLabel] ?? "unknown"
        let enabled = status["enabled"] as? Bool ?? false

        if server == "requires-approval" { state = .needsApproval; return }
        if server != "enabled" { state = .notRegistered; return }
        if !enabled { state = .off; enabledAt = nil; return }

        if let heartbeat, Date().timeIntervalSince(heartbeat.at) < Self.staleAfter {
            state = .up(heartbeat)
        } else if let since = enabledAt, Date().timeIntervalSince(since) < Self.staleAfter {
            state = .starting
        } else {
            state = .down(since: heartbeat?.at)
        }
    }

    nonisolated static func readHeartbeat() -> Heartbeat? {
        let file = Config.localRoot.appendingPathComponent(".log/server-status.json")
        guard let data = FileManager.default.contents(atPath: file.path),
              let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let epoch = doc["at_epoch"] as? Double ?? (doc["at_epoch"] as? Int).map(Double.init)
        else { return nil }
        let last = doc["last_job"] as? [String: Any]
        return Heartbeat(at: Date(timeIntervalSince1970: epoch),
                         stamp: doc["at"] as? String ?? "",
                         busy: doc["busy"] as? String,
                         lastJob: last?["name"] as? String,
                         lastJobAt: last?["at"] as? String,
                         claude: doc["claude"] as? String ?? "unknown",
                         modelEnabled: doc["model_enabled"] as? Bool)
    }

    nonisolated static func launcherJSON(_ args: [String]) -> [String: Any]? {
        guard let r = try? Runner.run(launcher, args, timeout: 20), r.ok,
              let data = r.stdout.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - what the menu shows

    var isProblem: Bool {
        switch state {
        case .down, .needsApproval: return true
        default: return false
        }
    }

    var headline: String {
        switch state {
        case .notInstalled: return "Not installed on this Mac"
        case .notRegistered: return "Installed, not set up"
        case .needsApproval: return "Waiting for approval in Login Items"
        case .off: return "Off — this Mac is not the assistant's server"
        case .starting: return "Starting…"
        case .up(let h): return h.busy.map { "Running — \($0)" } ?? "Running"
        case .down(let since): return since.map { "DOWN — last heard \(Ago.text($0))" } ?? "DOWN — never heard from"
        }
    }

    var detail: String? {
        guard case .up(let h) = state else {
            if case .down = state { return "launchd restarts it on a crash; if it stays down, the log is in ~/Library/Logs/Obligations Server" }
            return nil
        }
        var parts: [String] = []
        if let job = h.lastJob, let at = h.lastJobAt { parts.append("last \(job) at \(at.suffix(5))") }
        switch h.claude {
        case "token": parts.append("Claude: signed in")
        case "api-key": parts.append("Claude: API key")
        case "login": parts.append("Claude: CLI login")
        default: parts.append("Claude: NOT SIGNED IN")
        }
        if h.modelEnabled == false { parts.append("model switch OFF") }
        return parts.joined(separator: " · ")
    }

    var claudeMissing: Bool {
        if case .up(let h) = state { return h.claude == "none" }
        return false
    }

    // MARK: - driving

    /// First run: register Obligations Server's two launchd agents. They start, see
    /// they are not enabled, and exit — nothing runs until `turnOn`.
    func install() {
        run("installing") {
            let r = try? Runner.run(Self.launcher, ["register"], timeout: 30)
            return r.map { $0.ok ? nil : $0.stdout + $0.problem } ?? "could not run the launcher"
        }
    }

    /// Make this Mac the assistant's server. Asked, not assumed: two servers
    /// running the same jobs is the failure this whole migration is ordered
    /// around (the September outbox rule — never both — for the whole server).
    func turnOn() {
        Dialogs.confirm(
            "Make this Mac the assistant's server?",
            message: "Only once linuxbox has stopped — its agent, its dispatcher and its tunnel. "
                + "Two servers would run the same jobs and send the same pushes twice.\n\n"
                + "This also switches Obligations.app to the repo on this Mac instead of linuxbox.",
            action: "linuxbox is stopped — turn on"
        ) { [weak self] in
            self?.run("starting") {
                guard (try? Runner.run(Self.launcher, ["enable"], timeout: 10))?.ok == true else {
                    return "could not enable Obligations Server"
                }
                Config.isLocal = true
                Log.write("server: this Mac is now the assistant's server; Obligations.app talks to the local repo")
                Self.kickstart(Self.serverLabel, restart: false)
                Self.kickstart(Self.dispatchLabel, restart: false)
                return nil
            }
            self?.enabledAt = Date()
        }
    }

    /// Stop it, and keep it stopped: disable first, so launchd's KeepAlive
    /// does not bring it straight back.
    func turnOff() {
        Dialogs.confirm(
            "Stop the assistant server?",
            message: "Nothing runs until you turn it back on: no briefs, no triage, no pushes. "
                + "Obligations.app keeps reading this Mac's repo.",
            action: "Stop", destructive: true
        ) { [weak self] in
            self?.run("stopping") {
                _ = try? Runner.run(Self.launcher, ["disable"], timeout: 10)
                Self.kill(Self.serverLabel)
                Log.write("server: stopped from the menu")
                return nil
            }
        }
    }

    /// Restart — but never mid-run. A restart during a job costs the run;
    /// one in the window after a brief's job_done (its digest and audit) sent
    /// a brief out without its digest on 2026-09-30. So a busy server gets the
    /// restart queued, and it fires on the first refresh that finds it idle.
    func restart() {
        if let what = Self.busyWith() {
            pendingRestart = true
            working = "restart waits for \(what)"
            Log.write("server: restart asked from the menu; waiting for \(what) to finish")
            return
        }
        pendingRestart = false
        run("restarting") {
            Self.kickstart(Self.serverLabel, restart: true)
            Log.write("server: restarted from the menu")
            return nil
        }
        enabledAt = Date()
    }

    private var pendingRestart = false

    /// What the server is in the middle of, or nil when idle — deploy/idle.sh,
    /// in Swift: the last start/finish event in .log/agent-service.log. A
    /// `*_start` (a chat turn, a job, or the post-brief digest and audit) with
    /// no finish after it is busy. Reading the log is reading data; nothing in
    /// the repo is run.
    nonisolated static func busyWith() -> String? {
        let log = Config.localRoot.appendingPathComponent(".log/agent-service.log")
        guard let handle = try? FileHandle(forReadingFrom: log) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 262_144 ? size - 262_144 : 0)
        let tail = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
        let watched = ["turn_start", "turn_ok", "turn_stopped", "turn_failed",
                       "job_start", "job_done", "job_failed", "post_job_start", "post_job_done"]
        for line in tail.split(separator: "\n").reversed() {
            guard let r = line.range(of: #""event":"([a-z_]+)""#, options: .regularExpression) else { continue }
            let event = line[r].replacingOccurrences(of: "\"event\":", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            guard watched.contains(event) else { continue }
            guard event.hasSuffix("_start") else { return nil }
            if let n = line.range(of: #""name":"[^"]+""#, options: .regularExpression) {
                let name = line[n].dropFirst(8).dropLast()
                return event == "post_job_start" ? "the \(name) brief's digest" : "the \(name) job"
            }
            return event == "turn_start" ? "a chat turn" : "a run"
        }
        return nil
    }

    /// After "Sign in with Claude": the launcher reads the token only when it
    /// starts, so a running server needs a restart to use it. One that is off
    /// picks it up when it is turned on.
    func restartForToken() {
        switch state {
        case .up, .down, .starting: restart()
        default: break
        }
    }

    private func run(_ what: String, _ body: @escaping @Sendable () -> String?) {
        working = what
        Task.detached {
            let problem = body()
            await MainActor.run {
                self.working = nil
                if let problem { Dialogs.info("Obligations Server", message: problem) }
                self.refresh()
            }
        }
    }

    nonisolated static func kickstart(_ label: String, restart: Bool) {
        let target = "gui/\(getuid())/\(label)"
        _ = try? Runner.run("/bin/launchctl", ["kickstart"] + (restart ? ["-k"] : []) + [target], timeout: 20)
    }

    nonisolated static func kill(_ label: String) {
        _ = try? Runner.run("/bin/launchctl", ["kill", "SIGTERM", "gui/\(getuid())/\(label)"], timeout: 20)
    }
}
