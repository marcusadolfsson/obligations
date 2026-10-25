import AppKit
import CryptoKit
import Foundation
import Network

/// The OAuth dance, in the app instead of a script Alex runs by hand.
///
/// Same flow `deploy/integrations/calendar-auth.mjs` performs, for the same
/// reason: a Desktop OAuth client redirects to `http://127.0.0.1:<port>`, so
/// something local has to be listening. `ASWebAuthenticationSession` cannot be
/// used here — it intercepts a custom URL scheme, and Google issues those only
/// to iOS/Android client types, not the Desktop client this uses.
///
/// PKCE is on. A client secret shipped inside an app is not a secret, and the
/// verifier is what stops another local process that observes the redirect from
/// redeeming the code.
enum GoogleAuth {

    struct Keys {
        let clientId: String
        let clientSecret: String
        let raw: Data                 // the original file, uploaded verbatim

        init(contentsOf url: URL) throws {
            try self.init(data: try Data(contentsOf: url))
        }

        init(data: Data) throws {
            guard let top = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let root = (top["installed"] ?? top["web"]) as? [String: Any],
                  let id = root["client_id"] as? String,
                  let secret = root["client_secret"] as? String
            else { throw Failure.badClientFile }
            clientId = id
            clientSecret = secret
            raw = data
        }

        /// The OAuth client for this account, without asking for a file.
        ///
        /// Adding an account used to open a file picker for the client JSON
        /// downloaded from Google Cloud, which meant knowing which of several
        /// near-identical files was the right one — and picking wrong produces a
        /// grant that consents against the wrong project and fails later, not
        /// at the picker.
        ///
        /// The client is not secret in any case: this is a Desktop client, and
        /// Google says so explicitly, which is why PKCE carries the security
        /// here. But it is also not *one* client — `work` lives in its own Cloud
        /// project with its own consent screen, while `gmail` and `calendar`
        /// share the primary one — so a single value compiled into the app
        /// would be wrong for any second organisation. Discovery beats a
        /// constant for the same reason the state-dir mapping is a function.
        ///
        /// Order: a grant this Mac already made, then the same account's grant
        /// on the assistant, then — only for the two ids known to live in the
        /// primary project — that project's client. A genuinely new
        /// organisation has no client to find, and the picker is the honest
        /// answer rather than silently consenting it against someone else's
        /// project.
        /// Order: a grant this Mac already made, then every directory this
        /// account's grant could be in — new layout first, then the
        /// capability-keyed one it may not have been migrated out of yet.
        ///
        /// The old "borrows the primary project's client" rule is gone with the
        /// capability table. It existed because `calendar` and `drive` were
        /// separate identities that had no client of their own; now they are
        /// capabilities of an account that has one. A genuinely new account has
        /// no client to find, and the picker is the honest answer rather than
        /// silently consenting it against another organisation's project.
        static func discover(for account: GoogleAccount) -> (keys: Keys, source: String)? {
            let name = "gcp-oauth.keys.json"

            let local = account.localStateDir.appendingPathComponent(name)
            if let data = try? Data(contentsOf: local), let keys = try? Keys(data: data) {
                return (keys, "this Mac")
            }
            for dir in GoogleAccount.stateDirs(account.id) {
                if let data = Transport.fetch("\(dir)/\(name)"), let keys = try? Keys(data: data) {
                    return (keys, "\(Config.obligationsName): \(dir)")
                }
            }
            return nil
        }
    }

    enum Failure: Error, LocalizedError {
        case badClientFile
        case refused(String)
        case noRefreshToken
        case listener(String)
        case cancelled

        var errorDescription: String? {
            switch self {
            case .badClientFile:
                return "that file has no client_id/client_secret — is it the OAuth client JSON?"
            case .refused(let why):
                return why
            case .noRefreshToken:
                return "Google returned no refresh token, so the grant would die in an hour. "
                     + "That happens when the client was already approved and the consent "
                     + "prompt was skipped. Revoke it at myaccount.google.com/permissions "
                     + "and try again."
            case .listener(let why):
                return "could not listen for the redirect: \(why)"
            case .cancelled:
                return "cancelled"
            }
        }
    }

    // MARK: - the grant

    /// - Parameter incremental: pass true when adding a capability to an account
    ///   that already has a grant. Google otherwise returns a token carrying
    ///   only what was just asked for, so enabling Drive on a mail account would
    ///   silently stop mail working — the new capability appearing to break the
    ///   old one. `include_granted_scopes` is what makes the returned token the
    ///   union rather than the replacement.
    static func authorize(keys: Keys, scopes: [String],
                          incremental: Bool = false) async throws -> [String: Any] {
        let verifier = Self.randomURLSafe(32)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded()
        let stateToken = Self.randomURLSafe(16)

        let server = LoopbackServer()
        let port = try server.start()
        defer { server.stop() }

        let redirect = "http://127.0.0.1:\(port)"
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            .init(name: "client_id", value: keys.clientId),
            .init(name: "redirect_uri", value: redirect),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: scopes.joined(separator: " ")),
            // Both are needed for a refresh token: offline asks for one, and
            // consent forces the prompt even when this client was already
            // approved. Without it a re-run yields an access token only, and the
            // file written is useless an hour later.
            .init(name: "access_type", value: "offline"),
            .init(name: "prompt", value: "consent"),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: stateToken),
        ]
        if incremental {
            components.queryItems?.append(.init(name: "include_granted_scopes", value: "true"))
        }
        guard let consent = components.url else { throw Failure.refused("could not build the consent URL") }

        NSWorkspace.shared.open(consent)
        let code = try await server.awaitCode(expectedState: stateToken, timeout: 300)

        let tokens = try await exchange([
            "code": code,
            "client_id": keys.clientId,
            "client_secret": keys.clientSecret,
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        ])
        guard tokens["refresh_token"] is String else { throw Failure.noRefreshToken }
        return tokens
    }

    /// Is this grant still good?
    ///
    /// The only honest test is to spend the refresh token, so this does. It
    /// changes nothing: a refresh returns a new *access* token and leaves the
    /// refresh token alone, so probing is free and there is nothing to write
    /// back or re-upload afterwards.
    ///
    /// Returns nil when healthy, or the reason it is not.
    static func check(_ account: GoogleAccount) async -> String? {
        let credentials = account.localStateDir.appendingPathComponent("credentials.json")
        let keysFile = account.localStateDir.appendingPathComponent("gcp-oauth.keys.json")
        guard let keys = try? Keys(contentsOf: keysFile),
              let data = try? Data(contentsOf: credentials),
              let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokens = top["tokens"] as? [String: Any],
              let refresh = tokens["refresh_token"] as? String
        else { return "no local copy of this grant — re-add the account" }

        do {
            _ = try await exchange([
                "client_id": keys.clientId,
                "client_secret": keys.clientSecret,
                "refresh_token": refresh,
                "grant_type": "refresh_token",
            ])
            return nil
        } catch Failure.refused(let why) where why.contains("invalid_grant") {
            // The one worth naming precisely. It is almost always an OAuth app
            // left in External+Testing, whose refresh tokens expire after seven
            // days — and Google's own wording ("Token has been expired or
            // revoked") sends you looking in entirely the wrong place.
            return "Google refused the refresh token. Either it was revoked, or the "
                 + "OAuth app is in Testing mode — those tokens expire after 7 days. "
                 + "Make the app Internal, then re-add this account."
        } catch {
            return error.localizedDescription
        }
    }

    private static func exchange(_ form: [String: String]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(form.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value)"
        }.joined(separator: "&").utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let error = (json["error"] as? String) ?? "HTTP \(status)"
            let detail = (json["error_description"] as? String) ?? ""
            throw Failure.refused("\(error) \(detail)".trimmingCharacters(in: .whitespaces))
        }
        return json
    }

    // MARK: - writing it down

    /// Write the grant in exactly the shape `deploy/mcp/google-auth.mjs` reads,
    /// which is also what `@klodr/gmail-mcp` writes. One shape, one parser: a
    /// second would be a second thing to keep in step.
    static func persist(_ tokens: [String: Any], keys: Keys, scopes: [String],
                        for account: GoogleAccount, supersedes: [String] = []) throws {
        let dir = account.localStateDir
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])

        let expiresIn = (tokens["expires_in"] as? Double) ?? 3600
        var payload: [String: Any] = [
            "tokens": [
                "access_token": tokens["access_token"] as? String ?? "",
                "refresh_token": tokens["refresh_token"] as? String ?? "",
                "scope": tokens["scope"] as? String ?? scopes.joined(separator: " "),
                "token_type": tokens["token_type"] as? String ?? "Bearer",
                "expiry_date": Date().timeIntervalSince1970 * 1000 + expiresIn * 1000,
            ],
            "scopes": scopes,
        ]
        // What this grant replaces, and whose it is. Both are declared rather
        // than inferred: `accounts()` on the server drops a superseded
        // capability-keyed directory so one mailbox does not appear twice, and
        // nothing can work out whose Drive a drive.file token belongs to.
        // Never the account's own id. A grant that supersedes itself removes
        // itself from accounts() and the account vanishes while its token sits
        // there working — which is exactly what happened to work when the flag
        // was passed by hand. The caller already filters this out; it is
        // repeated here because the cost of the guard is a line and the cost of
        // missing it is an account that disappears.
        let replaced = supersedes.filter { $0 != account.id }
        if !replaced.isEmpty { payload["supersedes"] = replaced }
        if let address = account.address { payload["address"] = address }
        let credentials = dir.appendingPathComponent("credentials.json")
        try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
            .write(to: credentials)
        try FileManager.default.setAttributes([.posixPermissions: 0o600],
                                              ofItemAtPath: credentials.path)

        let keysOut = dir.appendingPathComponent("gcp-oauth.keys.json")
        try keys.raw.write(to: keysOut)
        try FileManager.default.setAttributes([.posixPermissions: 0o600],
                                              ofItemAtPath: keysOut.path)
    }

    /// Both files, to the state directory the server expects. Returns nil on
    /// success or the reason it failed.
    static func upload(_ account: GoogleAccount) -> String? {
        if let why = Transport.ensureRemoteDirectory(account.remoteStateDir) {
            return "could not create \(account.remoteStateDir) on \(Config.obligationsName): \(why)"
        }
        for name in ["credentials.json", "gcp-oauth.keys.json"] {
            let local = account.localStateDir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: local.path) else {
                return "missing locally: \(name)"
            }
            if let why = Transport.push(local, to: "\(account.remoteStateDir)/\(name)") {
                return why
            }
        }
        return nil
    }

    // MARK: - adopting what already exists

    /// Take over the grants the assistant already holds.
    ///
    /// Every grant here was made by `install-gmail.sh` or `calendar-auth.mjs`
    /// and lives only on the server, so the app knew about none of them and
    /// said "No accounts yet" while three worked. That is precisely the wrong
    /// status this app exists to stop reporting, and re-consenting three
    /// working grants through a browser would be a silly way to fix a display
    /// problem — the tokens are fine, only the app's knowledge of them is
    /// missing.
    ///
    /// Read from the assistant rather than from `~/obligations`, because the app must not
    /// need a checkout of the repo on this machine — see Config.support.
    ///
    /// Each adopted grant is verified by spending its refresh token, so an
    /// import reports what is actually working rather than what has files on
    /// disk. That also yields the address, so the menu can name the account.
    static func importFromObligations() async -> (added: [GoogleAccount], problems: [String]) {
        let found = await Task.detached { Self.grantsOnObligations() }.value
        let policy = await Task.detached { Self.disabledByPolicy() }.value
        guard !found.isEmpty else {
            return ([], ["no grants found on \(Config.obligationsName)"])
        }

        var added: [GoogleAccount] = []
        var problems: [String] = []

        for (id, dir, credentials, keysData) in found {
            var account = GoogleAccount(
                id: id,
                label: id,
                address: (try? addressRecorded(in: credentials)) ?? nil,
                scopes: (try? scopes(in: credentials)) ?? [],
                addedAt: Date(),
                lastChecked: Date(),
                lastError: nil,
                sourceDir: dir,
                disabled: policy[id] ?? [])

            do {
                try write(credentials: credentials, keys: keysData, for: account)
            } catch {
                problems.append("\(id): could not save locally — \(error.localizedDescription)")
                continue
            }

            // Spend the refresh token. A grant with files but no working token
            // is the case worth catching on the way in, not at 07:00.
            if let problem = await check(account) {
                account.lastError = problem
            } else if account.address == nil,
                      let keys = try? Keys(data: keysData),
                      let refresh = try? refreshToken(in: credentials) {
                // Only when the grant did not record one. Asking Google is the
                // fallback, not the source of truth: the recorded address is
                // what the server believes, and identify() answers nil for a
                // token whose scopes cannot name their owner. Overwriting
                // unconditionally turned a known address into "unknown" for the
                // one account that had every capability.
                let fresh = try? await exchange([
                    "client_id": keys.clientId,
                    "client_secret": keys.clientSecret,
                    "refresh_token": refresh,
                    "grant_type": "refresh_token",
                ])
                if let fresh { account.address = await identify(fresh, scopes: account.scopes) }
            }
            added.append(account)
        }
        return (added, problems)
    }

    /// `(id, directory, credentials.json, gcp-oauth.keys.json)` for every grant
    /// on the assistant, in both layouts. Blocking — ssh, off the main actor.
    ///
    /// Mirrors `accounts()` on the server, including the part that matters most:
    /// a migrated grant declares what it replaces, and the superseded
    /// capability-keyed directory is then not an account any more. Without that
    /// one mailbox appears twice — once as `personal`, once as `gmail` — and
    /// the duplicate reads as real volume rather than a half-finished
    /// migration.
    private nonisolated static func grantsOnObligations() -> [(id: String, dir: String, credentials: Data, keys: Data)] {
        var candidates: [(id: String, dir: String)] = []
        for line in grantDirectoryListing().split(separator: "\n") {
            var path = line.trimmingCharacters(in: .whitespaces)
            guard !path.isEmpty else { continue }
            if path.hasSuffix("/") { path.removeLast() }
            let name = (path as NSString).lastPathComponent

            if path.contains("/\(GoogleAccount.googleDir)/") {
                candidates.append((name, "\(GoogleAccount.googleDir)/\(name)"))
            } else if let id = legacyId(forDirectory: name) {
                candidates.append((id, "deploy/\(name)"))
            }
        }

        var out: [(id: String, dir: String, credentials: Data, keys: Data)] = []
        var superseded = Set<String>()
        for candidate in candidates {
            guard let credentials = Transport.fetch("\(candidate.dir)/credentials.json"),
                  let keys = Transport.fetch("\(candidate.dir)/gcp-oauth.keys.json")
            else { continue }
            if let top = try? JSONSerialization.jsonObject(with: credentials) as? [String: Any],
               let replaced = top["supersedes"] as? [String] {
                superseded.formUnion(replaced)
            }
            out.append((candidate.id, candidate.dir, credentials, keys))
        }
        // A superseded id is no longer an account. Only drop the legacy copy:
        // the migrated grant keeps its own slug even if the names collide.
        return out.filter { !(superseded.contains($0.id) && !$0.dir.hasPrefix(GoogleAccount.googleDir)) }
    }

    /// Every grant directory, both layouts, one per line — what `ls -d` printed
    /// over ssh, and on the server on this Mac the same listing read directly.
    /// Empty when the assistant cannot be reached: no grants found, not an error.
    private nonisolated static func grantDirectoryListing() -> String {
        if Config.isLocal {
            let fm = FileManager.default
            let root = Config.localRoot
            var out: [String] = []
            let google = root.appendingPathComponent(GoogleAccount.googleDir)
            for name in (try? fm.contentsOfDirectory(atPath: google.path)) ?? [] {
                var isDir: ObjCBool = false
                let path = google.appendingPathComponent(name).path
                if fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue { out.append(path + "/") }
            }
            let deploy = root.appendingPathComponent("deploy")
            for name in (try? fm.contentsOfDirectory(atPath: deploy.path)) ?? [] where name.contains("state") {
                var isDir: ObjCBool = false
                let path = deploy.appendingPathComponent(name).path
                if fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue { out.append(path) }
            }
            return out.sorted().joined(separator: "\n")
        }
        // One round trip: both layouts, directories only.
        guard let listing = try? Runner.run("/usr/bin/ssh", [
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", Config.host,
            "ls -d \(Config.remoteRoot)/\(GoogleAccount.googleDir)/*/ "
            + "\(Config.remoteRoot)/deploy/*state* 2>/dev/null || true",
        ], timeout: 30), listing.ok else { return "" }
        return listing.stdout
    }

    /// Inverse of `GoogleAccount.legacyDirs`, for the old layout only.
    private nonisolated static func legacyId(forDirectory name: String) -> String? {
        switch name {
        case "gmail-state": return "gmail"
        case "calendar-state": return "calendar"
        case "drive-state": return "drive"
        default:
            guard name.hasPrefix("gmail-state-") else { return nil }
            let id = String(name.dropFirst("gmail-state-".count))
            return id.isEmpty ? nil : id
        }
    }

    /// Capabilities the server has switched off for an account.
    ///
    /// Read from integrations/google-policy.json, never inferred: a token cannot
    /// express "granted but not in use", which is exactly the distinction the
    /// policy file exists to carry.
    private nonisolated static func disabledByPolicy() -> [String: [GoogleCapability]] {
        guard let data = Transport.fetch("integrations/google-policy.json"),
              let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        var out: [String: [GoogleCapability]] = [:]
        for (account, value) in top where !account.hasPrefix("$") {
            guard let entry = value as? [String: Any],
                  let names = entry["disabled"] as? [String] else { continue }
            out[account] = names.compactMap(GoogleCapability.init(rawValue:))
        }
        return out
    }

    /// What Google actually granted.
    ///
    /// `tokens.scope` first, and the top-level `scopes` array only as a
    /// fallback — the same field `credentials()` reads on the server, for a
    /// reason that is not cosmetic. The array is what the installer asked for
    /// and it is not even written in one format: @klodr/gmail-mcp records
    /// `["gmail.modify","gmail.send"]` while calendar-auth.mjs records full
    /// URLs. Matching capability scopes against the array therefore found
    /// nothing for exactly the two mail accounts, which reported as having no
    /// capabilities at all while working perfectly.
    ///
    /// `tokens.scope` is the space-separated string Google returned, always in
    /// full-URL form, and it is what was granted rather than what was
    /// requested — the distinction that matters when a consent screen silently
    /// omits a scope.
    private static func scopes(in credentials: Data) throws -> [String] {
        let top = try JSONSerialization.jsonObject(with: credentials) as? [String: Any]
        if let granted = (top?["tokens"] as? [String: Any])?["scope"] as? String {
            let parsed = granted.split(whereSeparator: \.isWhitespace).map(String.init)
            if !parsed.isEmpty { return parsed }
        }
        return (top?["scopes"] as? [String]) ?? []
    }

    /// The address the CLI recorded at grant time, if it did. Preferred over
    /// asking Google again: it is what the server believes, and a grant whose
    /// only capability is drive.file cannot answer the question at all.
    private static func addressRecorded(in credentials: Data) throws -> String? {
        let top = try JSONSerialization.jsonObject(with: credentials) as? [String: Any]
        return top?["address"] as? String
    }

    private static func refreshToken(in credentials: Data) throws -> String? {
        let top = try JSONSerialization.jsonObject(with: credentials) as? [String: Any]
        return (top?["tokens"] as? [String: Any])?["refresh_token"] as? String
    }

    /// Both files, at the permissions `persist` uses. Written verbatim: the
    /// shape on the assistant is what the server parses, and re-encoding it here
    /// would be a second chance to disagree with it.
    private static func write(credentials: Data, keys: Data, for account: GoogleAccount) throws {
        let dir = account.localStateDir
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        for (data, name) in [(credentials, "credentials.json"), (keys, "gcp-oauth.keys.json")] {
            let url = dir.appendingPathComponent(name)
            try data.write(to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                  ofItemAtPath: url.path)
        }
    }

    /// Whose account is this? Asked once, after a grant, so the menu shows an
    /// address rather than an opaque id.
    ///
    /// Deliberately asked of an API the grant already covers, rather than of
    /// `/oauth2/v3/userinfo` — that needs `openid`/`email`, and widening the
    /// grant so a menu can print a nicer label is a bad trade. A gmail token
    /// answers this from the mailbox profile; a calendar token from the primary
    /// calendar, whose id *is* the address.
    static func identify(_ tokens: [String: Any], scopes: [String]) async -> String? {
        guard let access = tokens["access_token"] as? String else { return nil }

        // A drive.file token can answer neither question below, and asking it
        // the calendar one produces a 403 that reads like a broken grant. No
        // label beats a wrong diagnosis; the menu falls back to the account's
        // own name.
        if scopes.contains(where: { $0.contains("drive") }) { return nil }

        let (url, field): (String, String) =
            scopes.contains(where: { $0.contains("gmail") })
            ? ("https://gmail.googleapis.com/gmail/v1/users/me/profile", "emailAddress")
            // calendarList/primary, not calendars/primary. Both have the
            // address as their id, but calendars.get needs calendar.readonly
            // or the full scope — neither of which this grant has, nor should —
            // while calendarList.get is exactly what calendarlist.readonly
            // covers. Against the narrower endpoint the answer is a silent nil
            // and the menu shows an account with no name.
            : ("https://www.googleapis.com/calendar/v3/users/me/calendarList/primary", "id")

        var request = URLRequest(url: URL(string: url)!)
        request.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json[field] as? String
    }

    /// CryptoKit's CSPRNG rather than SecRandomCopyBytes — same entropy source,
    /// one fewer framework, and no unsafe pointer to get wrong.
    private static func randomURLSafe(_ bytes: Int) -> String {
        SymmetricKey(size: .init(bitCount: bytes * 8))
            .withUnsafeBytes { Data($0) }
            .base64URLEncoded()
    }
}

extension Data {
    /// base64url, no padding — what OAuth PKCE requires.
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// A one-shot HTTP listener for the OAuth redirect.
///
/// It answers exactly one request and then stops. Long-lived local listeners in
/// a menu bar app are a standing attack surface for something that is needed
/// for about fifteen seconds a year.
///
/// ## Why `@unchecked Sendable`
///
/// It is reached from three places that are genuinely concurrent: the Network
/// framework's queue (`newConnectionHandler`, `receive`), the global queue that
/// arms the timeout, and whatever task is awaiting `awaitCode`. All mutable
/// state — `continuation`, `finished`, `expectedState` — is guarded by `lock`,
/// and `finish()` is the single write path, so the first caller wins and every
/// later one returns without touching the continuation. Resuming a
/// continuation twice is a crash, not a warning, which is exactly why that is
/// funnelled through one lock-guarded function rather than checked at each
/// call site.
///
/// `listener` and `connection` are written once at setup and once at teardown
/// from the same caller. `@unchecked` is the accurate word here: the invariant
/// is real, and it is held by the lock rather than by the type system.
private final class LoopbackServer: @unchecked Sendable {

    private var listener: NWListener?
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<String, Error>?
    private var finished = false
    private let lock = NSLock()

    func start() throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        // IPv4 only: the redirect URL says 127.0.0.1, and a listener that also
        // answers on ::1 is surface for no benefit.
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }

        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)     // ephemeral port
        } catch {
            throw GoogleAuth.Failure.listener(error.localizedDescription)
        }
        self.listener = listener

        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: .global())

        guard ready.wait(timeout: .now() + 5) == .success,
              let port = listener.port?.rawValue, port != 0 else {
            listener.cancel()
            throw GoogleAuth.Failure.listener("no port after 5s")
        }
        return port
    }

    func awaitCode(expectedState: String, timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            self.expectedState = expectedState
            lock.unlock()

            // Fires whether or not the browser ever comes back. finish() is
            // idempotent under the lock, so a redirect arriving at the same
            // moment as this timeout resolves the continuation exactly once.
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(.failure(GoogleAuth.Failure.refused("no response within \(Int(timeout))s")))
            }
        }
    }

    private var expectedState = ""

    private func accept(_ connection: NWConnection) {
        self.connection = connection
        connection.start(queue: .global())
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else { return }
            self.handle(request, on: connection)
        }
    }

    private func handle(_ request: String, on connection: NWConnection) {
        // "GET /?code=...&state=... HTTP/1.1"
        let target = request.split(separator: "\n").first
            .flatMap { $0.split(separator: " ").dropFirst().first }
            .map(String.init) ?? "/"
        let items = URLComponents(string: "http://127.0.0.1\(target)")?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }

        var title = "Connected", body = "You can close this tab."
        var outcome: Result<String, Error>

        if value("state") != expectedState {
            title = "Rejected"; body = "That response did not match this request."
            outcome = .failure(GoogleAuth.Failure.refused(
                "the redirect did not come from this request (state mismatch)"))
        } else if let error = value("error") {
            title = "Refused"; body = "Google said: \(error)"
            outcome = .failure(GoogleAuth.Failure.refused("Google refused consent: \(error)"))
        } else if let code = value("code") {
            outcome = .success(code)
        } else {
            title = "Nothing to do"; body = "No code in that request."
            outcome = .failure(GoogleAuth.Failure.cancelled)
        }

        let html = """
        <!doctype html><meta charset=utf-8>
        <body style="font:16px -apple-system,system-ui;padding:3rem;max-width:32rem">
        <h1>\(title)</h1><p>\(body)</p></body>
        """
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
            + "Content-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n\(html)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
        finish(outcome)
    }

    private func finish(_ result: Result<String, Error>) {
        lock.lock()
        guard !finished, let continuation else { lock.unlock(); return }
        finished = true
        self.continuation = nil
        lock.unlock()
        continuation.resume(with: result)
    }

    func stop() {
        listener?.cancel()
        connection?.cancel()
        listener = nil
        connection = nil
    }
}
