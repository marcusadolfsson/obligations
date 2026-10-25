import Foundation

/// Making the assistant's MCP config agree with a grant the app just wrote.
///
/// The app does not edit `.mcp.json`. It asks the assistant to reconcile itself,
/// which is a different thing and preserves the property that matters: the
/// logic deciding what may be done to Alex's mail lives on the machine that
/// holds the lock, in one place, reviewed as part of that repo. This drives it
/// remotely so the alternative — four commands pasted into a terminal after
/// every mail grant — does not become the step that gets skipped.
///
/// Deliberately still not automatic on a timer. Every run here is caused by a
/// person granting something or pressing a button, at a moment they chose.
/// Config that rewrites itself on a schedule is the thing worth avoiding, not
/// config that is rewritten when a human changes the grants it describes.
enum Reconcile {

    struct Step {
        let name: String
        let ok: Bool
        let detail: String
    }

    struct Outcome {
        var steps: [Step] = []
        /// True when a restart was skipped because a job was mid-run.
        var deferredRestart = false
        var ok: Bool { steps.allSatisfy(\.ok) }
    }

    /// node is not on PATH for a non-interactive ssh — it lives under nvm, and
    /// systemd has no more PATH than ssh does. Globbed rather than pinned: a
    /// version in the path breaks at the next upgrade, and a verification step
    /// that fails for an unrelated reason is worse than none, because the
    /// honest reading of a broken check is "skip it".
    private static let node = "$(ls -d ~/.nvm/versions/node/*/bin/node | tail -1)"

    private static func ssh(_ command: String, timeout: TimeInterval = 120) -> Runner.Result? {
        try? Runner.run("/usr/bin/ssh", [
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            Config.host, command,
        ], timeout: timeout)
    }

    /// Job containers in flight. `obligations-agent` is the service itself and
    /// `obligations-tunnel` is long-lived; anything else on that image is work.
    ///
    /// Restarting the service under a running job kills it mid-flight, and a
    /// half-written triage is worse than a config that is stale for another
    /// hour — the stale config fails loudly on the next run, the killed job
    /// leaves state nobody reconciles.
    static func jobsInFlight() -> [String] {
        guard let result = ssh("docker ps --format '{{.Names}}\t{{.Image}}'", timeout: 30),
              result.ok else { return [] }
        return result.stdout.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\t")
            guard parts.count == 2, parts[1].hasPrefix("obligations:") else { return nil }
            let name = String(parts[0])
            return (name == "obligations-agent" || name == "obligations-tunnel") ? nil : name
        }
    }

    /// check → write → restart → verify, stopping at the first failure.
    ///
    /// - Parameter apply: false runs only the check, which changes nothing and
    ///   exits non-zero on drift. That is the default on the server for a
    ///   reason and it stays available here.
    static func run(apply: Bool) -> Outcome {
        if Config.isLocal { return runLocal(apply: apply) }
        var outcome = Outcome()
        let root = Config.remoteRoot

        // 1. Check. Non-zero means drift, which is information rather than
        //    failure, so it is not treated as a failed step.
        guard let check = ssh("cd \(root) && \(node) deploy/reconcile-mcp.mjs 2>&1") else {
            outcome.steps.append(Step(name: "check", ok: false,
                                      detail: "could not reach \(Config.host)"))
            return outcome
        }
        let drift = !check.ok
        outcome.steps.append(Step(name: "check", ok: true,
                                  detail: drift ? summarise(check.stdout) : "no drift"))
        guard drift else { return outcome }
        guard apply else {
            outcome.steps.append(Step(name: "write", ok: true, detail: "not applied (check only)"))
            return outcome
        }

        // 2. Write.
        guard let write = ssh("cd \(root) && \(node) deploy/reconcile-mcp.mjs --write 2>&1"),
              write.ok else {
            outcome.steps.append(Step(name: "write", ok: false,
                                      detail: "reconcile --write failed"))
            return outcome
        }
        outcome.steps.append(Step(name: "write", ok: true, detail: summarise(write.stdout)))

        // 3. Restart, unless something is mid-run.
        let running = jobsInFlight()
        guard running.isEmpty else {
            outcome.deferredRestart = true
            outcome.steps.append(Step(name: "restart", ok: true,
                                      detail: "deferred — \(running.joined(separator: ", ")) still running"))
            return outcome
        }
        guard let restart = ssh("sudo -n systemctl restart obligations-agent 2>&1", timeout: 90),
              restart.ok else {
            outcome.steps.append(Step(name: "restart", ok: false,
                                      detail: "systemctl restart failed"))
            return outcome
        }
        outcome.steps.append(Step(name: "restart", ok: true, detail: "obligations-agent restarted"))

        // 4. Verify, in the container — the MCP server is installed nowhere
        //    else, so on the host it has nothing to ask.
        guard let verify = ssh("docker run --rm -v ~/\(root):/obligations -e OBLIGATIONS=/obligations "
                               + "--entrypoint node obligations:latest /obligations/deploy/mcp-check.mjs 2>&1",
                               timeout: 180) else {
            outcome.steps.append(Step(name: "verify", ok: false, detail: "mcp-check did not run"))
            return outcome
        }
        outcome.steps.append(Step(name: "verify", ok: verify.ok, detail: summarise(verify.stdout)))
        return outcome
    }

    /// The last few meaningful lines. These tools are chatty and the menu is
    /// 340 points wide.
    private static func summarise(_ text: String) -> String {
        let lines = text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return lines.suffix(3).joined(separator: " · ")
    }

    // MARK: - the server on this Mac

    /// On the Mac the server reconciles itself; this only asks.
    ///
    /// Obligations.app must not run reconcile-mcp.mjs here: it is repo code, the
    /// agent can write the repo, and Obligations.app holds Full Disk Access. So it
    /// drops `.log/run-reconcile`, and the server — sandboxed, already the
    /// thing that reads .mcp.json — runs it on its next idle tick, writes
    /// `.log/reconcile-last.json`, and exits for launchd to bring it back with
    /// the new config (heartbeat.mjs). No docker, no sudo, no ssh.
    ///
    /// A check-only run (apply: false) is not offered here: the server only
    /// knows how to apply, and applying only ever adds.
    static func runLocal(apply: Bool) -> Outcome {
        var outcome = Outcome()
        let fm = FileManager.default
        let log = Config.localRoot.appendingPathComponent(".log", isDirectory: true)
        let flag = log.appendingPathComponent("run-reconcile")
        let result = log.appendingPathComponent("reconcile-last.json")
        guard apply else {
            outcome.steps.append(Step(name: "check", ok: true,
                detail: "the server on this Mac reconciles when asked; there is no separate check"))
            return outcome
        }
        let asked = Date()
        try? fm.createDirectory(at: log, withIntermediateDirectories: true)
        guard fm.createFile(atPath: flag.path, contents: Data()) else {
            outcome.steps.append(Step(name: "ask", ok: false, detail: "could not write \(flag.path)"))
            return outcome
        }
        outcome.steps.append(Step(name: "ask", ok: true, detail: "asked the server"))

        // It acts on an idle tick — once a minute, and never mid-job. A brief
        // can hold it for a while, so wait long enough to be useful and then
        // say plainly that the request is still standing.
        let deadline = asked.addingTimeInterval(300)
        while Date() < deadline {
            if let attrs = try? fm.attributesOfItem(atPath: result.path),
               let modified = attrs[.modificationDate] as? Date, modified >= asked,
               let data = fm.contents(atPath: result.path),
               let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                let ok = doc["ok"] as? Bool ?? false
                outcome.steps.append(Step(name: "write", ok: ok,
                    detail: summarise(doc["output"] as? String ?? "")))
                outcome.steps.append(Step(name: "restart", ok: true,
                    detail: "the server restarts itself with the new config"))
                return outcome
            }
            Thread.sleep(forTimeInterval: 2)
        }
        outcome.deferredRestart = true
        outcome.steps.append(Step(name: "write", ok: true,
            detail: "still waiting — the server is busy; it will reconcile on its next idle minute"))
        return outcome
    }
}
