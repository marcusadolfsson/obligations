import AppKit
import Darwin

/// "Sign in with Claude" for the assistant server on this Mac.
///
/// Alex, 2026-10-01: "use the claude login token process from Curated." So
/// this is Curated's menubar/Sources/Curated/ClaudeSignIn.swift with three
/// changes, each one about where the line between the two apps runs:
///
/// - **The binary** is the installed `~/.local/bin/claude` and nothing else.
///   Curated also tried the SDK's copy inside its own bundle; the assistant's SDK
///   copy lives in the repo's node_modules, which the agent can write — and
///   Obligations.app, which holds Full Disk Access, must never run anything the agent
///   can write. `~/.local` is outside what the server's sandbox may write.
/// - **The token** goes to `~/.obligations-server/claude-token` (700/600), the file
///   Obligations Server's launcher reads at boot — outside the sandbox, which denies
///   that folder, so the agent can use the credential but cannot read the file.
/// - **Afterwards** the server is restarted, because the launcher only reads
///   the token when it starts.
///
/// What `setup-token` does, established by running it (Curated's notes): it
/// opens the browser at Claude's sign-in page; either the page hands the result
/// back over localhost and the token appears with no code, or it shows a code to
/// paste; the CLI exchanges it and prints a long-lived `sk-ant-oat01-…` token.
/// It is an Ink program and prints nothing on plain pipes, hence the pty.
///
/// The token passes through here and nowhere else. It is never logged.
@MainActor
final class ClaudeSignIn {
    static let shared = ClaudeSignIn()

    private var session: SetupTokenSession?

    static var binary: URL? {
        let installed = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin/claude")
        return FileManager.default.isExecutableFile(atPath: installed.path) ? installed : nil
    }

    static var tokenDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".obligations-server", isDirectory: true)
    }
    static var tokenFile: URL { tokenDirectory.appendingPathComponent("claude-token") }

    /// Whether a token is on file — without reading it.
    static var hasToken: Bool { FileManager.default.fileExists(atPath: tokenFile.path) }

    var running: Bool { session != nil }

    func start(then done: @escaping @MainActor () -> Void) {
        guard session == nil else { return }
        guard let binary = Self.binary else {
            Dialogs.info("Cannot sign in from here",
                         message: "Claude Code is not installed at ~/.local/bin/claude.")
            return
        }
        guard let session = SetupTokenSession(binary: binary) else {
            Dialogs.info("Cannot sign in from here", message: "The sign-in helper would not start.")
            return
        }
        self.session = session

        Task {
            // Either sign will do — the prompt, or the URL beside it — and not
            // seeing either is no reason to give up while the program still
            // runs. Curated's first version gave up after twenty seconds on one
            // exact phrase and killed a sign-in that was still in the browser.
            _ = await session.waitFor(timeout: 30) {
                SetupTokenSession.isAskingForCode($0) || $0.contains("claude.com/cai/oauth/authorize")
            }
            guard session.isRunning else {
                finish(failure: session.lastWords() ?? "The sign-in program stopped before it asked for a code.")
                return
            }
            askForCode(session, then: done)
        }
    }

    /// The dialog closes by itself when a token appears or the CLI stops —
    /// the usual route needs no code at all (see the header).
    private func askForCode(_ session: SetupTokenSession, then done: @escaping @MainActor () -> Void) {
        Dialogs.codePrompt(
            "Sign in with Claude",
            message: "Claude's sign-in page has opened in your browser. Sign in and authorise. "
                + "If the page says you are all set, this closes by itself; if it shows you a code, paste it here.",
            placeholder: "Code from the browser",
            reopen: { if let url = session.signInURL { NSWorkspace.shared.open(url) } },
            cancel: { [weak self] in self?.finish(failure: nil) },
            closeWhen: { session.token != nil || !session.isRunning },
            closed: { [weak self] in Task { await self?.collectToken(session, then: done) } }
        ) { [weak self] code in
            guard session.isRunning else {
                self?.finish(failure: "The sign-in expired before the code arrived. Start again — "
                    + "the code only works for the sign-in that produced it.")
                return
            }
            session.send(code + "\r")
            Task { await self?.collectToken(session, then: done) }
        }
    }

    private func collectToken(_ session: SetupTokenSession, then done: @escaping @MainActor () -> Void) async {
        _ = await session.waitFor(timeout: 60) { SetupTokenSession.token(in: $0) != nil || $0.contains("rror") }
        guard let token = session.token else {
            finish(failure: session.lastWords() ?? "Claude did not hand back a token. The code may have expired — try again.")
            return
        }
        if let why = Self.store(token) {
            finish(failure: why)
            return
        }
        finish(failure: nil)
        Log.write("claude sign-in: token stored; restarting the server to pick it up")
        done()
    }

    /// Curated's `setToken`, in Swift: shape-checked, 700 and 600.
    static func store(_ raw: String) -> String? {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.range(of: #"^sk-ant-[A-Za-z0-9_\-]{20,}$"#, options: .regularExpression) != nil else {
            return "That does not look like a token from `claude setup-token`."
        }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: tokenDirectory, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tokenDirectory.path)
            let tmp = tokenDirectory.appendingPathComponent(".claude-token.tmp")
            guard fm.createFile(atPath: tmp.path, contents: Data((token + "\n").utf8),
                                attributes: [.posixPermissions: 0o600]) else {
                return "Could not write the token file."
            }
            if rename(tmp.path, tokenFile.path) != 0 {
                try? fm.removeItem(at: tmp)
                return "Could not move the token file into place."
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Without a reason it was a success or a deliberate cancel. On failure,
    /// what the CLI said goes to the log first — redacted — so the next "it did
    /// not work" can be read rather than guessed at.
    private func finish(failure: String?) {
        if let failure, let session {
            Log.write("claude sign-in failed: \(failure)\n\(session.redactedTail())")
        }
        session?.stop()
        session = nil
        if let failure {
            Dialogs.info("Could not sign in with Claude", message: failure)
        }
    }
}
