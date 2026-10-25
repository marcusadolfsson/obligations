import AppKit
import EventKit
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

@main
struct ObligationsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    // Shared instances rather than @StateObject, because MenuBarExtra's content
    // is LAZY: it is not built until the menu is first opened. State owned by
    // that view would mean nothing syncs until Alex clicks the icon, which is
    // the one behaviour a background agent must not have. The delegate starts
    // the engine at launch; the view only observes it.
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var accounts = AccountStore.shared
    @ObservedObject private var model = AppModel.shared
    @ObservedObject private var sender = OutboxSender.shared
    @ObservedObject private var server = ServerMonitor.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView(engine: engine, accounts: accounts, model: model, sender: sender, server: server)
        } label: {
            // A shape, not a colour: the menu bar is monochrome, and a status
            // that reads only as a colour is invisible to a good number of
            // people and against a busy wallpaper.
            Image(systemName: model.iconName)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        Config.ensureSupport()

        // `Obligations --outbox-dry-run` performs one outbox pass that sends nothing
        // and prints what it would have done, then exits. The refusals in
        // Outbox.swift are a second implementation of the ones in
        // imessage-send.py, and a divergence between them is not the kind of
        // thing to discover by watching real messages go out. This exercises
        // the actual code path against the actual outbox.
        if CommandLine.arguments.contains("--outbox-dry-run") {
            for outcome in Outbox.runOnce(dryRun: true) {
                switch outcome {
                case .sent(_, let characters):     print("SENT \(characters) chars (unexpected in a dry run)")
                case .wouldSend(let characters):   print("WOULD SEND \(characters) chars")
                case .refused(let path, let why):  print("REFUSED \(path): \(why)")
                case .failed(let path, let why):   print("FAILED \(path): \(why)")
                }
            }
            print("dry run complete")
            exit(0)
        }

        // `Obligations --google-client-check` says which OAuth client each account
        // would consent against, and where it was found, without opening a
        // browser. Picking the wrong client is not visible at consent time —
        // it fails later, against the wrong project — so being able to see the
        // resolution is worth more than being able to see the flow.
        if CommandLine.arguments.contains("--google-client-check") {
            for id in ["gmail", "calendar", "drive", "work", "newco"] {
                let account = GoogleAccount(id: id, label: id, address: nil, scopes: [],
                                            addedAt: nil, lastChecked: nil, lastError: nil)
                if let found = GoogleAuth.Keys.discover(for: account) {
                    let short = found.keys.clientId.prefix(14)
                    print("\(id.padding(toLength: 9, withPad: " ", startingAt: 0)) \(short)… from \(found.source)")
                } else {
                    print("\(id.padding(toLength: 9, withPad: " ", startingAt: 0)) would ask for a file")
                }
            }
            exit(0)
        }

        // `Obligations --mapping-check` proves id → directory → id survives for every
        // capability and for a second organisation, and prints the table so it
        // can be read against stateDir() in google-auth.mjs without reading
        // either implementation. The one remaining cross-language pair is the
        // only place this class of bug can still hide.
        if CommandLine.arguments.contains("--mapping-check") {
            // The round-trip check this replaced is gone with the table it
            // tested. Keying grants by account rather than capability removed
            // the special cases that made a round trip worth proving: it is now
            // id → deploy/google/<id> in both directions, with the legacy
            // directories as a read-only fallback during migration.
            //
            // What is worth printing instead is where each account's grant
            // would be looked for, since that is the surviving cross-language
            // pair with stateDirs() in google-auth.mjs.
            for id in ["personal", "work", "gmail", "calendar", "drive"] {
                print("\(id.padding(toLength: 11, withPad: " ", startingAt: 0)) "
                      + GoogleAccount.stateDirs(id).joined(separator: "  →  "))
            }
            exit(0)
        }

        // `open -a Obligations --args --sync-now` runs every extractor once and
        // writes the result to a file. Must be launched by LaunchServices, not
        // from a shell: TCC attributes a shell-launched binary to the shell's
        // responsible process, which has neither Full Disk Access nor Contacts,
        // and every job then fails for a reason that has nothing to do with the
        // extractor being tested.
        // `open -a Obligations --args --reminders-check` reads the Obligations list and
        // the mirror and writes what a pass WOULD do to reminders-check.txt,
        // changing nothing. Same code path as the writer, with write: false.
        if CommandLine.arguments.contains("--reminders-check") {
            var lines: [String] = []
            if !Reminders.hasAccess() {
                lines.append("no Reminders access")
            } else if let data = Transport.fetch(Reminders.mirrorPath) {
                switch ReminderMirror.decode(data) {
                case .failure(let why): lines.append("mirror refused: \(why)")
                case .success(let mirror):
                    let plan = Reminders.apply(mirror, store: EKEventStore(), write: false)
                    lines.append("mirror: schema \(mirror.schema.map(String.init) ?? "none"), \(mirror.items.count) items, \(mirror.complete.count) to complete")
                    for why in mirror.rejected { lines.append("skipped entry: \(why)") }
                    lines.append("plan: \(plan.summary)")
                    lines.append("would create: \(plan.created.prefix(10).joined(separator: ", "))")
                    lines.append("would update: \(plan.updated.prefix(10).joined(separator: ", "))")
                    lines.append("would complete: \(plan.completed.prefix(10).joined(separator: ", "))")
                    lines.append("his own named: \(mirror.own.count); would complete \(plan.ownCompleted.count), held \(plan.ownHeld.count)")
                    for why in plan.ownSkipped { lines.append("his own skipped: \(why)") }
                    for p in plan.problems { lines.append("problem: \(p)") }
                }
            } else {
                lines.append("could not fetch \(Reminders.mirrorPath)")
            }
            lines.append("writer: \(Reminders.writerDisabledReason().map { "OFF — \($0)" } ?? "on")")
            lines.append("his own reminders: \(Reminders.ownArmedReason().map { "OFF — \($0)" } ?? "armed")")
            Config.ensureSupport()
            try? lines.joined(separator: "\n").write(
                to: Config.support.appendingPathComponent("reminders-check.txt"),
                atomically: true, encoding: .utf8)
            exit(0)
        }

        // Completing HIS reminders. Armed only when Alex says so — this is
        // the one path that writes outside the Obligations list.
        // `open -n -a Obligations --args --watch-selftest` proves the file watcher
        // wakes on a write, without waiting for someone to text him.
        if CommandLine.arguments.contains("--watch-selftest") {
            let lines = Watch.selfTest()
            Config.ensureSupport()
            try? lines.joined(separator: "\n").write(
                to: Config.support.appendingPathComponent("watch-selftest.txt"),
                atomically: true, encoding: .utf8)
            for line in lines { Log.write("watch selftest: \(line)") }
            exit(lines.contains { $0.contains("FAIL") } ? 1 : 0)
        }

        if CommandLine.arguments.contains("--reminders-own-on") {
            Reminders.armOwn()
            print("completing his own reminders: armed")
            exit(0)
        }

        if CommandLine.arguments.contains("--reminders-writer-on") {
            Reminders.enableWriter()
            print("reminders writer: on")
            exit(0)
        }

        // `Obligations --outbox-selftest`: the local outbox reader and receipt writer,
        // against a scratch folder. Touches nothing of his.
        if CommandLine.arguments.contains("--outbox-selftest") {
            let lines = Outbox.selfTest()
            for line in lines { print(line) }
            exit(lines.last == "ALL PASSED" ? 0 : 1)
        }

        if CommandLine.arguments.contains("--sync-now") {
            let lines = SyncEngine.runAllOnce()
            Config.ensureSupport()
            try? lines.joined(separator: "\n").write(
                to: Config.support.appendingPathComponent("sync-now.txt"),
                atomically: true, encoding: .utf8)
            for line in lines { Log.write("sync-now: \(line)") }
            exit(lines.contains { $0.contains("FAILED") } ? 1 : 0)
        }

        // `open -a Obligations --args --contacts-schema` reports where the Contacts
        // store keeps birthdays. Counts and column names only — never a value:
        // the question is whether the field is readable, and the answer does not
        // require reading anyone's date.
        if CommandLine.arguments.contains("--contacts-schema") {
            let root = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/AddressBook")
            var lines: [String] = []
            let found = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "abcddb" }) ?? []
            lines.append("stores: \(found.count)")
            for db in found {
                lines.append("### \(db.lastPathComponent)")
                let queries = [
                    "birthday-ish columns in ZABCDRECORD":
                        "SELECT name FROM pragma_table_info('ZABCDRECORD') WHERE name LIKE '%BIRTH%';",
                    "non-null ZBIRTHDAY":
                        "SELECT count(*) FROM ZABCDRECORD WHERE ZBIRTHDAY IS NOT NULL;",
                    "total records":
                        "SELECT count(*) FROM ZABCDRECORD;",
                    "tables mentioning DATE":
                        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%DATE%';",
                ]
                for key in queries.keys.sorted() {
                    let r = try? Runner.run("/usr/bin/sqlite3",
                                            ["-readonly", db.path, queries[key]!], timeout: 30)
                    let out = (r?.ok ?? false)
                        ? r!.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                        : "ERROR \(r?.problem ?? "no result")"
                    lines.append("  \(key): \(out.isEmpty ? "(none)" : out)")
                }
            }
            Config.ensureSupport()
            try? lines.joined(separator: "\n").write(
                to: Config.support.appendingPathComponent("contacts-schema.txt"),
                atomically: true, encoding: .utf8)
            exit(0)
        }

        // `open -a Obligations --args --imessage-freshness` answers one question: is
        // the newest row in chat.db newer than what the extract produced?
        //
        // If the database itself is stale, no amount of fixing the reader helps
        // — Messages was not receiving. If it is fresh and the extract is not,
        // the read is at fault. Those have opposite fixes and the file's own
        // timestamp cannot tell them apart, which is how a current-looking file
        // carried two-day-old content.
        //
        // Timestamps and counts only, never message text.
        if CommandLine.arguments.contains("--imessage-freshness") {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let db = home.appendingPathComponent("Library/Messages/chat.db")
            var lines: [String] = []
            for suffix in ["", "-wal", "-shm"] {
                let url = URL(fileURLWithPath: db.path + suffix)
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
                let mod = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                    .contentModificationDate
                lines.append("chat.db\(suffix): "
                             + (size.map { "\($0) bytes" } ?? "absent")
                             + (mod.map { ", modified \(Stamp.minute.string(from: $0))" } ?? ""))
            }
            let queries = [
                "1 newest message in db":
                    "SELECT datetime(MAX(date)/1000000000 + 978307200,'unixepoch','localtime') FROM message;",
                // Arithmetic on the strftime result, not a bare comparison
                // against it: strftime returns TEXT, and SQLite orders every
                // INTEGER below every TEXT, so `date > strftime(...)` is false
                // for all rows and reports a silent zero.
                "2 messages since 2026-09-06 12:25":
                    "SELECT count(*) FROM message WHERE date > (strftime('%s','2026-09-06 12:25:00') - 978307200) * 1000000000;",
                "5 newest 6 message times":
                    "SELECT datetime(date/1000000000 + 978307200,'unixepoch','localtime') FROM message ORDER BY date DESC LIMIT 6;",
                "3 journal mode": "PRAGMA journal_mode;",
                "4 total messages": "SELECT count(*) FROM message;",
            ]
            for key in queries.keys.sorted() {
                let r = try? Runner.run("/usr/bin/sqlite3",
                                        ["-readonly", db.path, queries[key]!], timeout: 30)
                lines.append("\(key): " + ((r?.ok ?? false)
                    ? r!.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                    : "ERROR \(r?.problem ?? "no result")"))
            }
            Config.ensureSupport()
            try? lines.joined(separator: "\n").write(
                to: Config.support.appendingPathComponent("imessage-freshness.txt"),
                atomically: true, encoding: .utf8)
            exit(0)
        }

        // `Obligations --retire` stands this machine down as the Obligations client:
        // sending off, and no longer a login item. Written when the collector
        // moved to the Mac mini, because the dangerous state during a migration
        // is two machines polling one outbox — the same approved draft goes to
        // a real person twice, and nothing can recall it.
        //
        // Deliberately leaves the bundle, the grants and the local state alone.
        // Retiring is not uninstalling: if the new machine turns out to be
        // wrong, turning this one back on should be a decision rather than a
        // rebuild.
        if CommandLine.arguments.contains("--retire") {
            UserDefaults.standard.set(false, forKey: "outboxEnabled")
            UserDefaults.standard.synchronize()
            var lines = ["sending: off"]
            do {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                    lines.append("login item: unregistered")
                } else {
                    lines.append("login item: was not enabled (\(SMAppService.mainApp.status.rawValue))")
                }
            } catch {
                lines.append("login item: COULD NOT UNREGISTER — \(error.localizedDescription)")
            }
            lines.append("bundle and grants left in place; --sync-now and the menu still work")
            for line in lines { print(line); Log.write("retire: \(line)") }
            exit(0)
        }

        // `Obligations --reconcile [--write]` drives the assistant's own reconciler.
        // Check-only by default, matching the server's default and for the same
        // reason: it rewrites the two files that decide what may be done to
        // Alex's mail.
        if CommandLine.arguments.contains("--reconcile") {
            let apply = CommandLine.arguments.contains("--write")
            let outcome = Reconcile.run(apply: apply)
            for step in outcome.steps {
                print("\(step.ok ? "ok  " : "FAIL") \(step.name): \(step.detail)")
            }
            if outcome.deferredRestart { print("restart deferred — a job is running") }
            exit(outcome.ok ? 0 : 1)
        }

        // `Obligations --google-import` adopts the assistant's grants and exits. Same work
        // the menu button does, runnable without a click so it can be verified
        // and so a rebuilt Mac can be put back without opening anything.
        if CommandLine.arguments.contains("--google-import") {
            Task { @MainActor in
                let (added, problems) = await GoogleAuth.importFromObligations()
                for account in added {
                    AccountStore.shared.add(account)
                    let state = account.lastError.map { "STALE — \($0)" } ?? "working"
                    let off = account.disabled.isEmpty ? ""
                        : " | granted not in use: \(account.disabled.map(\.rawValue).joined(separator: ","))"
                    print("\(account.id): \(account.address ?? "address unknown")"
                          + " | in \(account.remoteStateDir)"
                          + " | granted: \(account.granted.map(\.rawValue).sorted().joined(separator: ","))"
                          + " | in use: \(account.inUse.map(\.rawValue).sorted().joined(separator: ","))"
                          + off + " | \(state)")
                }
                for problem in problems { print("problem: \(problem)") }
                print("imported \(added.count)")
                exit(0)
            }
            return
        }

        // `Obligations --login-item-status` answers "will this come back after a
        // reboot?" without a reboot. The app registers itself only when it is
        // not already enabled, so a quiet log is ambiguous — it means either
        // registered long ago or never tried, and those differ by a background
        // agent that silently stops existing.
        if CommandLine.arguments.contains("--login-item-status") {
            let status = SMAppService.mainApp.status
            let text: String
            switch status {
            case .enabled:        text = "enabled — starts at login"
            case .notRegistered:  text = "NOT REGISTERED — will not start at login"
            case .notFound:       text = "NOT FOUND — macOS cannot see this bundle"
            case .requiresApproval:
                text = "REQUIRES APPROVAL — registered, but switched off in "
                     + "System Settings > General > Login Items"
            @unknown default:     text = "unknown (\(status.rawValue))"
            }
            print("login item: \(text)")
            print("bundle: \(Bundle.main.bundleURL.path)")
            exit(0)
        }

        // `Obligations --call-schema` prints the call database's columns. The app is
        // the only thing here with Full Disk Access, so questions about what
        // that database can answer — voicemail being the one that prompted it —
        // have to be asked from inside the bundle rather than from a shell.
        if CommandLine.arguments.contains("--call-schema") {
            let db = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/CallHistoryDB/CallHistory.storedata")
            // -readonly rather than a file: URI: the path contains a space, and
            // an unencoded space in a URI fails as "unable to open", which reads
            // exactly like a permissions problem and is not one.
            // Every table, not just ZCALLRECORD. Asking one table what the
            // database can answer is how "there is no voicemail here" got said
            // out loud about a store that had never been looked at whole.
            let sql = """
            SELECT m.name || ' :: ' || group_concat(p.name, ', ')
              FROM sqlite_master m
              JOIN pragma_table_info(m.name) p
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
             GROUP BY m.name ORDER BY m.name;
            """
            //
            // Writes to a file rather than stdout, because this only answers
            // correctly when LaunchServices starts the app — `open -a Obligations
            // --args --call-schema`. Run the same binary from a shell and TCC
            // attributes the read to the shell's responsible process, which
            // does not have Full Disk Access, and the probe reports "could not
            // read" about a database the app itself reads every 30 minutes.
            let result = try? Runner.run("/usr/bin/sqlite3",
                                         ["-readonly", db.path, sql], timeout: 30)
            let body = (result?.ok ?? false)
                ? result!.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                : "could not read \(db.path)\n\(result?.problem ?? "no result")"
            let out = Config.support.appendingPathComponent("call-schema.txt")
            Config.ensureSupport()
            try? body.write(to: out, atomically: true, encoding: .utf8)
            print(body)
            exit(0)
        }

        // `open -a Obligations --args --voicemail-probe` lists the telephony stores.
        // They are TCC-protected, so a shell gets "Operation not permitted" and
        // this app is the only thing on the Mac that can see inside them.
        // Scoped to the two known locations rather than taking a path argument:
        // a signed app with Full Disk Access should not grow a general file
        // browser to answer one question.
        if CommandLine.arguments.contains("--voicemail-probe") {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let roots = [
                home.appendingPathComponent("Library/Group Containers/group.com.apple.telephonyutilities.callservicesd"),
                home.appendingPathComponent("Library/Containers/com.apple.mobilephone/Data/Library"),
                home.appendingPathComponent("Library/Application Support/CallHistoryDB"),
            ]
            var lines: [String] = []
            for root in roots {
                lines.append("### \(root.path)")
                guard let walk = FileManager.default.enumerator(
                    at: root, includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey],
                    options: [.skipsHiddenFiles]) else {
                    lines.append("  (cannot enumerate)")
                    continue
                }
                var shown = 0
                for case let url as URL in walk {
                    if url.pathComponents.contains("Caches") { continue }
                    let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
                    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                    let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
                    lines.append("  \(relative)\(isDir ? "/" : " [\(size)]")")
                    shown += 1
                    if shown > 400 { lines.append("  …truncated"); break }
                }
                if shown == 0 { lines.append("  (empty)") }
            }
            let body = lines.joined(separator: "\n")
            Config.ensureSupport()
            try? body.write(to: Config.support.appendingPathComponent("voicemail-probe.txt"),
                            atomically: true, encoding: .utf8)
            exit(0)
        }

        Log.write("obligations app starting")

        AppModel.shared.attach(engine: .shared, store: .shared)
        SyncEngine.shared.start()
        // Its own timer, not a SyncJob: sending is the interactive path and must
        // not queue behind a 14-day extract. Does nothing until switched on.
        OutboxSender.shared.start()
        // The assistant server on this Mac (Obligations Server.app): read its heartbeat
        // every fifteen seconds. Does nothing if it is not installed.
        ServerMonitor.shared.start()
        registerLoginItem()
    }

    /// Launch at login, replacing four LaunchAgent plists.
    ///
    /// SMAppService is the supported route on macOS 13+; the old
    /// `~/Library/LaunchAgents/com.example.obligations.*.plist` files should be
    /// unloaded once this app is running, or both will extract and the pair
    /// will race on the same output paths. `build.sh --uninstall-agents` does
    /// that; the README says so too.
    private func registerLoginItem() {
        do {
            if SMAppService.mainApp.status != .enabled {
                try SMAppService.mainApp.register()
                Log.write("registered as a login item")
            }
        } catch {
            // Not fatal: the app works, it just will not come back after a
            // reboot. Saying so is better than a silent half-install, which is
            // exactly how the old setup failed.
            Log.write("could not register as a login item: \(error.localizedDescription)")
        }
    }
}

/// The bits of state the menu shows that are not the sync engine's own.
@MainActor
final class AppModel: ObservableObject {

    static let shared = AppModel()

    @Published var fullDiskAccess = false
    @Published var contacts = false
    @Published var reminders = false
    @Published var busy: String?

    private(set) weak var engine: SyncEngine?
    private(set) weak var store: AccountStore?

    init() {
        refreshPermissions()
        // Re-check when the app is brought forward: granting Full Disk Access
        // in System Settings does not notify us, and a menu that still says
        // "off" after the user has just turned it on is the thing that makes
        // people conclude the app is broken.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refreshPermissions() }
            }
    }

    func attach(engine: SyncEngine, store: AccountStore) {
        self.engine = engine
        self.store = store
    }

    func refreshPermissions() {
        fullDiskAccess = Permissions.hasFullDiskAccess()
        contacts = Permissions.hasContacts()
        reminders = Reminders.hasAccess()
    }

    func askForReminders() {
        Reminders.requestAccess { [weak self] granted in
            self?.reminders = granted
            if !granted { Reminders.openSettings() }
        }
    }

    func askForContacts() {
        Permissions.requestContacts { [weak self] granted in
            self?.contacts = granted
            if !granted { Permissions.openContactsSettings() }
        }
    }

    // MARK: - overall status

    var iconName: String {
        if !fullDiskAccess || !contacts { return "obligations.head.profile" }
        return "obligations"
    }

    var overallColor: Color {
        guard let engine else { return .secondary }
        // A server that is meant to be running and is not outranks everything:
        // no briefs, no triage, no pushes, and nothing else on this menu says so.
        if ServerMonitor.shared.isProblem { return .red }
        if !fullDiskAccess || !contacts { return .orange }
        return engine.state.values.contains(where: { $0.isFailing }) ? .red : .green
    }

    var overallSummary: String {
        if case .down = ServerMonitor.shared.state { return "Obligations server is DOWN" }
        if case .needsApproval = ServerMonitor.shared.state { return "Obligations server needs approval" }
        if ServerMonitor.shared.claudeMissing { return "Obligations server: sign in with Claude" }
        if !fullDiskAccess { return "Full Disk Access needed" }
        if !contacts { return "Contacts access needed" }
        guard let engine else { return "starting…" }
        let failing = engine.state.values.filter { $0.isFailing }.count
        if failing > 0 { return "\(failing) of \(SyncJob.all.count) syncs failing" }
        let oldest = SyncJob.all.compactMap { engine.state[$0.id]?.lastSuccess }.min()
        if oldest == nil { return "nothing synced yet" }
        return "all synced · oldest \(Ago.text(oldest))"
    }

    // MARK: - google accounts

    /// Pick the OAuth client JSON, choose what this account is for, then run the
    /// browser flow and push the result to the assistant.
    /// Ask what the account is for, find the OAuth client, then run the browser
    /// flow and push the result to the assistant.
    ///
    /// The question comes first now. It used to ask for the client file and
    /// then what it was for, which is backwards: what it is for determines
    /// *which* client is correct, and in every ordinary case the client is
    /// already on the assistant and need not be asked for at all.
    func addAccount() {
        guard let id = askName() else { return }
        let existing = store?.accounts.first { $0.id == id }
        guard let choice = askCapabilities(for: existing, id: id) else { return }

        guard confirmMailMigration(choice, existing: existing) else { return }

        let probe = existing ?? GoogleAccount(id: id, label: id, address: nil, scopes: [],
                                              addedAt: Date(), lastChecked: nil, lastError: nil)
        guard let keys = resolveKeys(for: probe) else { return }
        authorize(keys: keys, account: probe, adding: choice.capabilities)
    }

    /// Re-consent an existing grant, asking for exactly what it already has.
    func reauthorize(_ account: GoogleAccount) {
        guard confirmMailMigration(Kind(id: account.id, capabilities: account.granted),
                                   existing: account) else { return }
        guard let keys = resolveKeys(for: account) else { return }
        authorize(keys: keys, account: account, adding: account.granted)
    }

    /// The client for this account, asking only when there is genuinely nothing
    /// to find — a first grant for an organisation with its own Cloud project.
    private func resolveKeys(for account: GoogleAccount) -> GoogleAuth.Keys? {
        if let found = GoogleAuth.Keys.discover(for: account) {
            Log.write("google: \(account.id) using the OAuth client from \(found.source)")
            return found.keys
        }

        let panel = NSOpenPanel()
        panel.title = "The OAuth client JSON for \(account.label)"
        // Said out loud because the picker now only appears in the case where
        // choosing the wrong file is actually possible: a new organisation,
        // whose client is not the one the other accounts use.
        panel.message = "No existing client was found for \(account.id). Choose the OAuth "
            + "client JSON downloaded from that organisation's Google Cloud project."
        panel.allowedContentTypes = [UTType.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return nil }

        guard let keys = try? GoogleAuth.Keys(contentsOf: url) else {
            present("Not an OAuth client", GoogleAuth.Failure.badClientFile.localizedDescription)
            return nil
        }
        return keys
    }

    private func authorize(keys: GoogleAuth.Keys, account: GoogleAccount,
                           adding: [GoogleCapability]) {
        // The union, always. Google returns a token carrying only what was asked
        // for, so requesting just the new capability would drop the old ones —
        // enabling Drive would appear to break mail. include_granted_scopes is
        // belt and braces on top of asking for everything.
        let wanted = Set(account.granted).union(adding)
        let scopes = Array(Set(wanted.flatMap(\.scopes))).sorted()
        let incremental = !account.granted.isEmpty

        busy = "waiting for Google"
        Task { @MainActor in
            defer { busy = nil }
            do {
                let tokens = try await GoogleAuth.authorize(keys: keys, scopes: scopes,
                                                            incremental: incremental)
                var updated = account
                // What Google actually granted, which is not always what was
                // asked: a scope missing from the consent screen comes back
                // absent rather than as an error.
                updated.scopes = (tokens["scope"] as? String)?
                    .split(separator: " ").map(String.init) ?? scopes
                updated.address = await GoogleAuth.identify(tokens, scopes: updated.scopes)
                    ?? account.address
                updated.addedAt = account.addedAt ?? Date()
                updated.lastChecked = Date()
                updated.lastError = nil
                updated.sourceDir = GoogleAccount.newLayoutDir(account.id)

                let supersedes = askWhatThisReplaces(for: updated)
                try GoogleAuth.persist(tokens, keys: keys, scopes: updated.scopes,
                                       for: updated, supersedes: supersedes)

                if let why = GoogleAuth.upload(updated) {
                    updated.lastError = "saved here but not uploaded: \(why)"
                    present("Not uploaded",
                            "The grant is on this Mac but did not reach \(Config.obligationsName).\n\n\(why)")
                }
                store?.add(updated)
                for old in supersedes { store?.forget(old) }
                Log.write("google: granted \(account.id) "
                          + "(\(updated.granted.map(\.rawValue).sorted().joined(separator: ",")))"
                          + (supersedes.isEmpty ? "" : " superseding \(supersedes.joined(separator: ","))"))

                let missing = Set(scopes).subtracting(updated.scopes)
                if !missing.isEmpty {
                    present("Some scopes were not granted",
                            "Google did not return:\n\n"
                            + missing.map { "  • " + ($0.split(separator: "/").last.map(String.init) ?? $0) }
                                .joined(separator: "\n")
                            + "\n\nThey are missing from the consent screen, or were declined.")
                }
                if updated.granted.contains(.mail) || updated.granted.contains(.send) {
                    reconcileNow(because: "\(updated.id) is a mail account")
                }
            } catch {
                present("Could not connect", error.localizedDescription)
                Log.write("google: \(account.id) failed — \(error.localizedDescription)")
            }
        }
    }

    /// Ask the assistant to bring `.mcp.json` back in step with the grants.
    ///
    /// Runs the server's own reconciler rather than editing anything from here:
    /// the rules deciding what may be done to Alex's mail stay in one place,
    /// on the machine that holds the lock. What the app removes is the part
    /// that was only ever ceremony — four commands pasted into a terminal after
    /// every mail grant, which is the step that gets skipped, and skipping it
    /// leaves mail reading a grant nothing updates any more.
    func reconcileNow(because reason: String) {
        busy = "reconciling"
        Task { @MainActor in
            defer { busy = nil }
            let outcome = await Task.detached { Reconcile.run(apply: true) }.value
            for step in outcome.steps {
                Log.write("reconcile: \(step.name) — \(step.ok ? "ok" : "FAILED") — \(step.detail)")
            }
            let body = outcome.steps
                .map { "\($0.ok ? "✓" : "✗")  \($0.name) — \($0.detail)" }
                .joined(separator: "\n")

            if outcome.deferredRestart {
                present("Reconciled — restart still needed",
                        "\(reason), so .mcp.json was brought back in step.\n\n\(body)\n\n"
                        + "The restart was skipped because a job is running, and restarting "
                        + "obligations-agent would kill it mid-flight. The new config takes effect "
                        + "at the next restart; press Reconcile again once the job finishes.")
            } else if !outcome.ok {
                present("Reconcile did not finish",
                        "\(body)\n\nMail may still be reading the old path. The commands are "
                        + "in deploy/reconcile-mcp.mjs on \(Config.obligationsName) if this needs doing "
                        + "by hand.")
            } else {
                present("Reconciled", body)
            }
        }
    }

    /// Which capability-keyed grants this new one replaces.
    ///
    /// Asked rather than inferred, and only about accounts that share this
    /// grant's address: matching identities across tokens is exactly what the
    /// server said it could not do, and a wrong answer here deletes a mailbox
    /// from `accounts()` — the failure being that the extractor stops reading
    /// an inbox nobody notices is missing.
    private func askWhatThisReplaces(for account: GoogleAccount) -> [String] {
        guard let address = account.address, let store else { return [] }
        let candidates = store.accounts.filter {
            $0.id != account.id && $0.isLegacyLayout
                && $0.address?.lowercased() == address.lowercased()
        }
        guard !candidates.isEmpty else { return [] }

        let names = candidates.map(\.id).sorted()
        let alert = NSAlert()
        alert.messageText = "Replace the older grants for \(address)?"
        alert.informativeText =
            "These still exist under the old capability-keyed layout and are the same "
            + "account:\n\n  \(names.joined(separator: ", "))\n\n"
            + "Marking them replaced stops the assistant listing one mailbox twice. Their files "
            + "are left on disk untouched — this only records that \(account.id) supersedes "
            + "them, and it can be undone by editing credentials.json."
        alert.addButton(withTitle: "Mark replaced")
        alert.addButton(withTitle: "Leave them")
        return alert.runModal() == .alertFirstButtonReturn ? names : []
    }

    /// Adopt the grants already on the assistant, so the menu stops claiming there
    /// are none while three of them work.
    func importAccounts() {
        guard let store else { return }
        busy = "importing"
        Task { @MainActor in
            defer { busy = nil }
            let (added, problems) = await GoogleAuth.importFromObligations()
            for account in added {
                store.add(account)
                Log.write("google: imported \(account.id)"
                          + (account.lastError == nil ? "" : " — \(account.lastError!)"))
            }
            if added.isEmpty, !problems.isEmpty {
                present("Nothing imported", problems.joined(separator: "\n"))
            } else if !problems.isEmpty {
                present("Imported \(added.count), with problems",
                        problems.joined(separator: "\n"))
            }
        }
    }

    /// Spend each refresh token to find out whether it still works. See
    /// GoogleAuth.check — it changes nothing.
    func checkAccounts() {
        guard let store else { return }
        busy = "checking"
        Task { @MainActor in
            defer { busy = nil }
            for account in store.accounts {
                let problem = await GoogleAuth.check(account)
                store.update(account.id) { $0.lastChecked = Date(); $0.lastError = problem }
                if let problem { Log.write("google: \(account.id) — \(problem)") }
            }
        }
    }

    // MARK: - dialogs

    private struct Kind { let id: String; let capabilities: [GoogleCapability] }

    /// Which capabilities, for which account — checkboxes rather than a single
    /// kind picked once.
    ///
    /// The old dialog asked "what is this account FOR", which is the question
    /// that produced the bug: it made the capability the identity, so there
    /// could be exactly one calendar and one Drive. An account can now have any
    /// combination, and several accounts can each have the same one.
    ///
    /// Existing capabilities are pre-ticked and cannot be unticked here.
    /// Consenting again cannot narrow a token — a scope only leaves by revoking
    /// the whole grant — so offering to untick would claim a revocation this
    /// dialog does not perform. Switching one off is a policy decision and
    /// lives on the server in integrations/google-policy.json.
    private func askCapabilities(for account: GoogleAccount?, id: String) -> Kind? {
        let already = Set(account?.granted ?? [])

        let alert = NSAlert()
        alert.messageText = account == nil
            ? "What should the assistant be able to do with \(id)?"
            : "Add capabilities to \(account?.address ?? id)"
        alert.informativeText =
            "Mail reads and files. Send is separate, still asks you in the chat, and is "
            + "refused in scheduled jobs. Calendar grants events only, never other people's "
            + "diaries. Drive grants drive.file — the assistant sees only files it created, "
            + "never the rest of your Drive."
            + (already.isEmpty ? "" :
               "\n\nAlready granted and ticked: \(already.map(\.label).sorted().joined(separator: ", ")). "
               + "Consenting again cannot remove a scope, so these cannot be unticked. "
               + "Switching one off is a policy change on the assistant, not a re-grant.")

        let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 260, height: 92))
        stack.orientation = .vertical
        stack.alignment = .leading
        var boxes: [GoogleCapability: NSButton] = [:]
        for capability in GoogleCapability.allCases {
            let box = NSButton(checkboxWithTitle: capability.label, target: nil, action: nil)
            let has = already.contains(capability)
            box.state = has ? .on : .off
            box.isEnabled = !has
            boxes[capability] = box
            stack.addArrangedSubview(box)
        }
        alert.accessoryView = stack
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }

        let picked = GoogleCapability.allCases.filter { boxes[$0]?.state == .on }
        guard !picked.isEmpty else { return nil }
        return Kind(id: id, capabilities: picked)
    }

    /// Confirm before moving a working mail grant out from under the MCP server.
    ///
    /// `.mcp.json` names deploy/gmail-state and deploy/gmail-state-work directly —
    /// the MCP server reads those paths itself rather than through
    /// google-auth.mjs — so re-granting a mail account writes its token to
    /// deploy/google/<id> and mail MCP keeps reading the old path until
    /// deploy/reconcile-mcp.mjs is run. That is a command someone runs, not a
    /// race, but it is a step between here and working mail and it is invisible
    /// from this side.
    ///
    /// A confirmation rather than a refusal now that reconciliation exists, and
    /// rather than nothing because the thing briefly broken is the integration
    /// Alex uses all day. Calendar and Drive skip this entirely — nothing but
    /// our own code reads those.
    ///
    /// Returns true when it is safe to continue.
    private func confirmMailMigration(_ kind: Kind, existing: GoogleAccount?) -> Bool {
        let touchesMail = kind.capabilities.contains(.mail) || kind.capabilities.contains(.send)
        guard touchesMail, let existing, existing.isLegacyLayout,
              existing.granted.contains(.mail) || existing.granted.contains(.send)
        else { return true }

        let alert = NSAlert()
        alert.messageText = "Mail will need one command afterwards"
        alert.informativeText =
            "\(existing.id)'s grant lives in \(existing.remoteStateDir), and .mcp.json names "
            + "that path directly. This moves the token to "
            + "\(GoogleAccount.newLayoutDir(existing.id)), so mail MCP reads the old path "
            + "until the assistant reconciles:\n\n"
            + "  node deploy/reconcile-mcp.mjs          (check)\n"
            + "  node deploy/reconcile-mcp.mjs --write  (apply)\n\n"
            + "The app runs this for you straight afterwards and reports what happened — "
            + "it only defers the restart if a job is mid-run, since restarting obligations-agent "
            + "would kill it. Until reconciliation completes, mail triage reads a grant that "
            + "is no longer being updated."
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func askName() -> String? {
        let alert = NSAlert()
        alert.messageText = "Short name for this mailbox"
        alert.informativeText = "Lowercase letters, digits and underscore. It becomes the tool "
            + "prefix on the server (mcp__work__search_emails) and the state directory name."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        field.placeholderString = "work"
        alert.accessoryView = field
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }

        let name = field.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        // Same rule add-mailbox.mjs enforces. Rejecting here beats discovering
        // it three steps later, after a browser round trip.
        guard name.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil else {
            present("Not a usable name", "Use lowercase letters, digits and underscore, "
                    + "starting with a letter. Got: \(field.stringValue)")
            return nil
        }
        return name
    }

    private func present(_ title: String, _ body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
