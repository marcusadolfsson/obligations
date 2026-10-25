import Foundation

/// Getting a file to the assistant.
///
/// **Push, never pull.** The server holds no credentials into this Mac; the Mac
/// decides what leaves and when. That is a deliberate property of the whole
/// integration and predates this app — `imessage-sync.sh` says the same thing.
/// A pull agent on the server would be more convenient and would invert it.
enum Transport {

    /// Returns nil on success, or the reason it failed.
    ///
    /// Not `throws`: every caller wants to record the reason as a string and
    /// carry on, and the one thing that must not happen is a transport failure
    /// taking down the sync loop.
    static func push(_ local: URL, to remotePath: String) -> String? {
        if Config.isLocal { return copyIn(local, to: remotePath) }
        let destination = "\(Config.host):\(Config.remoteRoot)/\(remotePath)"
        do {
            // BatchMode stops ssh from sitting at a passphrase prompt forever
            // in a process with no terminal — which is a hang, not an error,
            // and would wedge the sync queue until the app restarted.
            let result = try Runner.run("/usr/bin/scp", [
                "-q",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10",
                local.path, destination,
            ], timeout: 60)
            if result.ok { return nil }
            return "could not reach \(Config.host): \(result.problem)"
        } catch {
            return "scp: \(error.localizedDescription)"
        }
    }

    /// Make a directory on the server before writing into it.
    ///
    /// The one failure Alex actually hit by hand: scp into a directory that
    /// does not exist fails with `dest open ... Failure`, which does not say
    /// "no such directory".
    static func ensureRemoteDirectory(_ path: String) -> String? {
        if Config.isLocal {
            do {
                try FileManager.default.createDirectory(
                    at: inRepo(path), withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
                try FileManager.default.setAttributes([.posixPermissions: 0o700],
                                                      ofItemAtPath: inRepo(path).path)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        do {
            let result = try Runner.run("/usr/bin/ssh", [
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10",
                Config.host,
                // Quoted so a space in the path cannot become two arguments.
                "mkdir -p '\(Config.remoteRoot)/\(path)' && chmod 700 '\(Config.remoteRoot)/\(path)'",
            ], timeout: 30)
            return result.ok ? nil : result.problem
        } catch {
            return error.localizedDescription
        }
    }

    /// Read one file from the assistant.
    ///
    /// This is not the "pull" the README rules out. That invariant is about
    /// direction of *control*: the assistant holds no credentials into this Mac and
    /// cannot reach in. The Mac asking for a file over its own outbound ssh
    /// keeps that intact, and the outbox sender already depends on it — reading
    /// the known-handles list is what makes its allowlist no wider than what
    /// the agent could see. What would break the invariant is an agent on the
    /// server initiating, and nothing here does.
    ///
    /// Returns nil rather than throwing: every caller has a fallback and none
    /// of them should fail loudly because the assistant was briefly unreachable.
    static func fetch(_ remotePath: String) -> Data? {
        if Config.isLocal { return FileManager.default.contents(atPath: inRepo(remotePath).path) }
        guard let result = try? Runner.run("/usr/bin/ssh", [
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            Config.host,
            "cat '\(Config.remoteRoot)/\(remotePath)'",
        ], timeout: 30), result.ok else { return nil }
        return result.stdout.data(using: .utf8)
    }

    /// Is the assistant reachable at all? Used by the menu so "everything is
    /// failing" can be reported once, as one cause, rather than three times as
    /// three symptoms.
    static func reachable() -> Bool {
        if Config.isLocal {
            return FileManager.default.fileExists(atPath: Config.localRoot.appendingPathComponent(".git").path)
        }
        return (try? Runner.run("/usr/bin/ssh", [
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
            Config.host, "true",
        ], timeout: 15))?.ok ?? false
    }

    // MARK: - the server on this Mac

    /// A repo-relative path, or an absolute one, as a file URL in the local repo.
    static func inRepo(_ path: String) -> URL {
        path.hasPrefix("/") ? URL(fileURLWithPath: path)
                            : Config.localRoot.appendingPathComponent(path)
    }

    /// What scp did, without the network: write next to the destination, then
    /// rename over it, so the server — which reads these files every minute —
    /// never sees half an extract. 600, as they were on linuxbox: these are his
    /// messages, calls and contacts, and the grants that read his mail.
    static func copyIn(_ local: URL, to path: String) -> String? {
        let fm = FileManager.default
        let dest = inRepo(path)
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try Data(contentsOf: local)
            let tmp = dest.deletingLastPathComponent()
                .appendingPathComponent(".\(dest.lastPathComponent).obligations-app.tmp")
            guard fm.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                return "could not write \(tmp.path)"
            }
            if rename(tmp.path, dest.path) != 0 {
                let why = String(cString: strerror(errno))
                try? fm.removeItem(at: tmp)
                return "could not move into place: \(why)"
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
