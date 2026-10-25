import Foundation

/// A capability is a scope in a token, not a directory.
///
/// This mirrors `CAPABILITY` in deploy/mcp/google-auth.mjs. It replaced a table
/// keyed by capability name, which made the capability the identity — many
/// mailboxes were possible but exactly one calendar and one Drive, and a second
/// account had no way to say it had Drive too.
enum GoogleCapability: String, CaseIterable, Codable {
    case mail, send, calendar, drive

    /// The scope that proves it. Same pairs as the server's CAPABILITY map.
    var scope: String {
        switch self {
        case .mail:     return "https://www.googleapis.com/auth/gmail.modify"
        case .send:     return "https://www.googleapis.com/auth/gmail.send"
        case .calendar: return "https://www.googleapis.com/auth/calendar.events"
        case .drive:    return "https://www.googleapis.com/auth/drive.file"
        }
    }

    /// Everything asking for this capability must request. `calendar` needs
    /// calendarlist.readonly for discovery — without it events.list can only
    /// name `primary` and every shared calendar is invisible — and `mail`
    /// carries send separately so that send can be granted without being used.
    var scopes: [String] {
        switch self {
        case .calendar:
            return [scope, "https://www.googleapis.com/auth/calendar.calendarlist.readonly"]
        default:
            return [scope]
        }
    }

    var label: String {
        switch self {
        case .mail: return "Mail"
        case .send: return "Send"
        case .calendar: return "Calendar"
        case .drive: return "Drive"
        }
    }

    static func granted(in scopes: [String]) -> [GoogleCapability] {
        allCases.filter { scopes.contains($0.scope) }
    }
}

enum GoogleScope {
    /// Never offered by the app, and listed here so the reason sits next to the
    /// thing it forbids rather than only in CLAUDE.md:
    ///
    /// - `gmail.settings.basic` creates filters. A filter is a standing rule
    ///   that keeps acting after the session ends, which is the one category of
    ///   capability the assistant must never hold.
    /// - `gmail.labels` — Superhuman does the filing; a second classifier over
    ///   the same mail is worse than either alone.
    /// - `calendar` (full) reaches other people's diaries.
    /// - `drive` (full) sees every file he owns; `drive.file` sees only what
    ///   this app created, which is what the job needs.
    static let neverOffer = ["gmail.settings.basic", "gmail.labels",
                             "https://www.googleapis.com/auth/calendar",
                             "https://www.googleapis.com/auth/drive"]
}

/// A Google account the assistant holds a grant for.
///
/// The slug is who it IS — `personal`, `work` — never what it does. One account,
/// one token, every scope it has been granted.
struct GoogleAccount: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var address: String?
    var scopes: [String]
    var addedAt: Date?
    var lastChecked: Date?
    var lastError: String?

    /// The directory this grant was actually read from, relative to the repo
    /// root. Absent for a grant made under the new layout, where it is derived.
    ///
    /// Kept rather than recomputed because during migration the same account can
    /// legitimately live in the old place: `gmail` still resolves to
    /// deploy/gmail-state until it is re-granted, and the local mirror has to
    /// match or `Keys.discover` looks in the wrong directory.
    var sourceDir: String?

    /// Capabilities disabled by policy on the server — granted, deliberately
    /// unused. Never inferred from the token: the token cannot express it.
    var disabled: [GoogleCapability] = []

    // MARK: - where the grant lives

    static let googleDir = "deploy/google"

    /// Where a NEW grant is written. Mirrors `stateDir()` on the server.
    static func newLayoutDir(_ id: String) -> String { "\(googleDir)/\(id)" }

    /// The old capability-keyed locations, while they still exist. Mirrors
    /// `legacyDirs()` on the server.
    static func legacyDirs(_ id: String) -> [String] {
        switch id {
        case "gmail":    return ["deploy/gmail-state"]
        case "calendar": return ["deploy/calendar-state"]
        case "drive":    return ["deploy/drive-state"]
        default:         return ["deploy/gmail-state-\(id)"]
        }
    }

    /// Everywhere this account's grant might be, newest naming first. Mirrors
    /// `stateDirs()` on the server, and the order matters for the same reason:
    /// a re-granted account must win over the directory it replaced.
    static func stateDirs(_ id: String) -> [String] {
        [newLayoutDir(id)] + legacyDirs(id)
    }

    /// Where this particular grant is — the directory it was read from, or the
    /// new layout for one that has not been read from anywhere yet.
    var remoteStateDir: String { sourceDir ?? Self.newLayoutDir(id) }

    var localStateDir: URL {
        Config.support.appendingPathComponent(remoteStateDir, isDirectory: true)
    }

    /// Whether this grant still lives in a capability-keyed directory.
    var isLegacyLayout: Bool { sourceDir.map { $0.hasPrefix(Self.googleDir) == false } ?? false }

    // MARK: - capabilities

    /// What the token carries.
    var granted: [GoogleCapability] { GoogleCapability.granted(in: scopes) }

    /// What the assistant will actually use: granted, minus disabled.
    ///
    /// The gap is deliberately visible. A scope cannot be narrowed — once
    /// drive.file is in a token nothing removes it but revoking the whole grant
    /// — so switching a capability off is a decision about what the assistant WILL
    /// use, not what it CAN. The UI must say "granted, not in use" rather than
    /// implying a revocation it does not perform.
    var inUse: [GoogleCapability] { granted.filter { !disabled.contains($0) } }

    var isStale: Bool { lastError != nil }
}

/// The accounts, on disk.
@MainActor
final class AccountStore: ObservableObject {

    static let shared = AccountStore()

    @Published private(set) var accounts: [GoogleAccount] = []

    private let file = Config.support.appendingPathComponent("accounts.json")

    init() { load() }

    func add(_ account: GoogleAccount) {
        accounts.removeAll { $0.id == account.id }
        accounts.append(account)
        accounts.sort { $0.id < $1.id }
        save()
    }

    func replaceAll(_ new: [GoogleAccount]) {
        accounts = new.sorted { $0.id < $1.id }
        save()
    }

    func update(_ id: String, _ change: (inout GoogleAccount) -> Void) {
        guard let i = accounts.firstIndex(where: { $0.id == id }) else { return }
        change(&accounts[i])
        save()
    }

    /// An account already holding a grant for this address, under any slug.
    /// Used to offer extending it rather than creating a second identity.
    func withAddress(_ address: String) -> GoogleAccount? {
        accounts.first { $0.address?.lowercased() == address.lowercased() }
    }

    /// Deliberately does not revoke at Google or delete anything on the server.
    ///
    /// Removing a row here stops the app managing that grant; the token on the
    /// repo keeps working. Making this button also revoke would mean one
    /// mis-click silently breaks mail triage — and the recovery is a browser
    /// round trip. Revoking is a deliberate act at
    /// myaccount.google.com/permissions.
    func forget(_ id: String) {
        accounts.removeAll { $0.id == id }
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: file),
              let decoded = try? JSONDecoder().decode([GoogleAccount].self, from: data)
        else { return }
        accounts = decoded
    }

    private func save() {
        Config.ensureSupport()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(accounts) { try? data.write(to: file) }
    }
}
