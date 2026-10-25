import AppKit
import Contacts
import Foundation

/// The two macOS grants this app cannot work without, and a straight answer
/// about whether it has them.
///
/// This is the part the old setup got wrong in a way that cost real time. The
/// launchd agents ran `/usr/bin/python3`, so the Full Disk Access grant had to
/// be attached to the *interpreter*, and the probe that checked it wrote to
/// `/dev/null` — which cannot be chmod'ed, so the probe failed for a reason
/// that had nothing to do with permissions and produced a confident, wrong
/// diagnosis about Contacts and FaceTime. Two extractors had never once run.
///
/// A signed app fixes the mechanism: the bundle is the responsible process, so
/// the grant follows the app and survives an OS Python update. What it does not
/// fix is the reporting, which is why every check here answers by *doing the
/// thing* — reading the actual database, asking the actual store — rather than
/// inferring from a proxy.
enum Permissions {

    static let messagesDatabase = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Messages/chat.db")

    /// The call history store, for the watcher. The extractor finds it for
    /// itself; this is only the directory to watch for changes.
    static let callsDatabase = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/CallHistoryDB/CallHistory.storedata")

    /// Can this process actually read the Messages database?
    ///
    /// Opening it for reading is the only honest test. `chat.db` exists whether
    /// or not the grant is present, so a `fileExists` check reports success
    /// while every sync fails.
    static func hasFullDiskAccess() -> Bool {
        do {
            let handle = try FileHandle(forReadingFrom: messagesDatabase)
            defer { try? handle.close() }
            // SQLite's header is 16 bytes. Reading one byte proves the sandbox
            // let us in, which is the whole question.
            let got = (try handle.read(upToCount: 1))?.isEmpty == false
            note(got ? nil : "opened chat.db but read nothing from it")
            return got
        } catch {
            // The reason matters and used to be discarded. A TCC refusal and a
            // missing file both made this return false, which sent the last
            // diagnosis in exactly the wrong direction for an hour. Logged only
            // when it changes, because this runs on every menu refresh.
            let why = error as NSError
            note("cannot read chat.db: \(why.domain) \(why.code) — \(why.localizedDescription)")
            return false
        }
    }

    /// Log a permission failure once per distinct reason.
    private static var lastNote: String?
    private static let noteLock = NSLock()
    private static func note(_ message: String?) {
        noteLock.lock()
        defer { noteLock.unlock() }
        guard message != lastNote else { return }
        lastNote = message
        if let message { Log.write(message) }
    }

    static func hasContacts() -> Bool {
        CNContactStore.authorizationStatus(for: .contacts) == .authorized
    }

    /// Ask for Contacts. macOS shows the prompt once, ever — after a refusal
    /// this returns immediately and the only route is System Settings, which is
    /// why the menu offers that too rather than a button that silently does
    /// nothing the second time.
    @MainActor
    static func requestContacts(_ done: @escaping @MainActor (Bool) -> Void) {
        // Activate first. This app is LSUIElement, so clicking its menu does not
        // make it the active application, and macOS will not put a consent
        // dialog in front of an app that is not frontmost. CNContactStore
        // reports that suppressed prompt as an immediate denial — indis-
        // tinguishable in the log from a refusal the user actually saw and
        // clicked, which is what sent this hunt after a stale TCC record for an
        // hour when nothing was stale.
        NSApp.activate(ignoringOtherApps: true)
        CNContactStore().requestAccess(for: .contacts) { granted, error in
            if let error {
                let why = error as NSError
                Log.write("contacts access: \(why.domain) \(why.code) — \(why.localizedDescription)")
            }
            Task { @MainActor in done(granted) }
        }
    }

    /// Full Disk Access cannot be requested by an app at all — there is no API,
    /// by design. The only path is the user adding the app in System Settings,
    /// so the honest thing is to open the exact pane rather than describe it.
    static func openFullDiskAccessSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
    }

    static func openContactsSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")
    }

    private static func open(_ string: String) {
        guard let url = URL(string: string) else { return }
        NSWorkspace.shared.open(url)
    }
}
