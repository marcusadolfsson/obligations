import Foundation

/// Where things are and how often they happen.
///
/// Everything here was a constant scattered across four plists and three shell
/// scripts. `install-mac.sh` substituted `__PYTHON__` and `__HOME__` into the
/// plists at install time, which meant the values that actually ran were in
/// generated files nobody read — and one of them silently pointed at a Python
/// that could not open `chat.db`.
enum Config {

    /// The tailnet name of the assistant. Push-only: the server never holds
    /// credentials into this Mac, and the Mac decides what leaves and when.
    /// That property is why this is scp-out rather than a pull agent, and it
    /// should survive any rewrite of the transport.
    static var host: String {
        get { defaults.string(forKey: "host") ?? "linuxbox" }
        set { defaults.set(newValue, forKey: "host") }
    }

    /// Where the assistant is, since the server moved onto this Mac (2026-10-01).
    ///
    /// `remote` is linuxbox over ssh/scp, as it was. `local` is the server on
    /// this Mac: the repo is a folder, read and written directly. Remote stays
    /// the default until cutover, and stays available through the soak week so
    /// rolling back to linuxbox is a switch rather than a rebuild.
    ///
    /// Local does not loosen the invariant this file states above — the Mac
    /// decides what leaves and when. What changes is how far it travels: a file
    /// in the repo is the whole exchange, in both directions, and Obligations.app
    /// still never runs anything from it (the agent can write the repo).
    static var isLocal: Bool {
        get { defaults.string(forKey: "serverMode") == "local" }
        set { defaults.set(newValue ? "local" : "remote", forKey: "serverMode") }
    }

    /// Where the assistant is, in words, for anything the menu or a dialog says.
    /// `host` is for ssh; this is for people. After cutover it is this Mac,
    /// and a message naming linuxbox would send him to a machine that no longer
    /// runs the assistant.
    static var obligationsName: String { isLocal ? "the assistant on this Mac" : host }

    /// The working copy the server on this Mac runs from.
    static var localRoot: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let path = defaults.string(forKey: "localRoot") ?? home.appendingPathComponent("Developer/obligations").path
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    /// Path to the repo on the server, relative to the ssh login directory.
    static var remoteRoot: String {
        get { defaults.string(forKey: "remoteRoot") ?? "obligations" }
        set { defaults.set(newValue, forKey: "remoteRoot") }
    }

    /// Everything the app writes lives here — extracts before upload, OAuth
    /// tokens, logs. Deliberately not `~/obligations`: the app replaces the scripts,
    /// so it must not need a checkout of the repo on this machine.
    static var support: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
        return base.appendingPathComponent("Obligations", isDirectory: true)
    }

    static var logFile: URL { support.appendingPathComponent("obligations-app.log") }

    /// The interpreter used for the bundled extractors.
    ///
    /// `/usr/bin/python3` and not a `which python3` lookup, on purpose: a
    /// Homebrew or pyenv Python is a different binary with a different TCC
    /// identity, and the whole reason the app exists is that Full Disk Access
    /// attaches to *this signed bundle* as the responsible process. A python
    /// somewhere else in PATH would silently lose that and fail to read
    /// chat.db — which is exactly the failure mode install-mac.sh had.
    static let python = "/usr/bin/python3"

    static func ensureSupport() {
        try? FileManager.default.createDirectory(at: support,
                                                 withIntermediateDirectories: true)
    }

    private static var defaults: UserDefaults { .standard }
}

/// A line in the app's log, and on stderr when run from a terminal.
enum Log {
    private static let queue = DispatchQueue(label: "com.example.obligations.log")
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"      // local, like everything in the repo
        return f
    }()

    static func write(_ message: String) {
        let line = "\(stamp.string(from: Date()))  \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
        queue.async {
            Config.ensureSupport()
            let url = Config.logFile
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(line.utf8))
            } else {
                try? Data(line.utf8).write(to: url)
            }
        }
    }
}
