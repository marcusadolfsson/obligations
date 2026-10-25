import AppKit
import EventKit
import Foundation

/// The Apple Reminders bridge — the EventKit half.
///
/// Alex, 2026-09-18. The server half (`deploy/reminders-bridge.mjs`,
/// `sources/apple-reminders.mjs`) was built first; this is the Mac side of the
/// two files it agreed on:
///
///     Mac →  integrations/reminders-apple.json   everything in his lists
///     Mac ←  integrations/reminders-mirror.json  what the "Obligations" list holds
///
/// Runs in-process rather than as a bundled Python script like the other
/// three jobs. EventKit's grant is TCC against the signed bundle, and a
/// subprocess would be attributed to itself — the same reason `--sync-now`
/// must be launched through LaunchServices.
///
/// ## The rules, and why each is enforced here rather than trusted
///
/// - **No alarms, ever.** The dispatcher owns the push channel, its daily
///   budget and its quiet hours, and it cannot see an alarm Apple fires. The
///   mirror carries `"alarms": false` so this checks it on every pass instead
///   of remembering it; a mirror without it is refused whole.
/// - **Dates, never times.** A reminder with an hour on it is one Apple
///   alerts on, which is an alarm by another name.
/// - **Only the list called "Obligations"** — with one fenced exception.
///   Creates and edits happen only there. The exception is `completeOwn()`:
///   completing one of HIS reminders, named by identifier, when he closed the
///   linked task himself. It may only tick, is armed separately, and only by
///   him (`--reminders-own-on`).
/// - **Never delete.** Completing is the strongest verb, as archive is for
///   mail. There is no call to `remove` anywhere in this file.
/// - **What he added himself is his.** A reminder in the Obligations list with no
///   obligation id is never modified.
/// - **A duplicate is the failure mode.** Every create is keyed on the
///   obligation id as read back from EventKit at the start of the same pass,
///   completed reminders included — a tick he made an hour ago must not be
///   read as "missing" and recreated. After the pass every id is read back
///   again; if any cannot be found exactly once, the writer turns itself off
///   and says so, because it would rather mirror nothing than mirror twice.
enum Reminders {

    static let listName = "Obligations"

    /// Where the obligation id lives on a reminder. EventKit has no custom
    /// field, iCloud rewrites some fields and he edits titles, so it is
    /// written twice and read from either:
    ///
    /// - the **URL**, `https://obligations.example.com/todo#pane=<id>` — which is
    ///   also his tap back into the page;
    /// - a **trailing notes line** `obligations:<id>`. Last line only, and it must
    ///   start with `obligations:` — a note that merely mentions the assistant is not a
    ///   marker. The server's reader applies the same rule.
    ///
    /// If both are present and disagree, the reminder is unreadable, and an
    /// unreadable repo reminder stops the writer: that is precisely the case
    /// in which a create would duplicate.
    static let pageBase = "https://obligations.example.com/todo#pane="
    static let notesMarker = "obligations:"

    // MARK: - permission

    static func hasAccess() -> Bool {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        if #available(macOS 14.0, *) { return status == .fullAccess }
        return status == .authorized
    }

    /// Same shape as `Permissions.requestContacts`, for the same reason: this
    /// is an LSUIElement app, and macOS will not show a consent dialog for an
    /// app that is not frontmost — it reports the suppressed prompt as a
    /// refusal instead.
    @MainActor
    static func requestAccess(_ done: @escaping @MainActor (Bool) -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        let store = EKEventStore()
        let finish: (Bool, Error?) -> Void = { granted, error in
            if let error {
                let why = error as NSError
                Log.write("reminders access: \(why.domain) \(why.code) — \(why.localizedDescription)")
            }
            Task { @MainActor in done(granted) }
        }
        if #available(macOS 14.0, *) {
            store.requestFullAccessToReminders(completion: finish)
        } else {
            store.requestAccess(to: .reminder, completion: finish)
        }
    }

    static func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - the job

    /// One pass: bring the Obligations list in line with the mirror, then extract
    /// and push. That order so the extract describes the list as it now is.
    ///
    /// A writer failure never stops the reader. His ticks reaching the assistant
    /// matter more than the assistant's items reaching him, and the reader has no
    /// way to cause a duplicate.
    static func sync() -> (bytes: Int?, problem: String?, writer: String) {
        guard hasAccess() else { return (nil, "needs Reminders access", "not run") }
        let store = EKEventStore()

        let writer: String
        if let off = writerDisabledReason() {
            writer = "off — \(off)"
        } else if let data = Transport.fetch(mirrorPath) {
            switch ReminderMirror.decode(data) {
            case .failure(let why): writer = "refused the mirror — \(why)"
            case .success(let mirror):
                writer = apply(mirror, store: store, write: true).summary
            }
        } else {
            writer = "could not fetch the mirror; list left as it was"
        }
        Log.write("reminders writer: \(writer)")

        Config.ensureSupport()
        let out = Config.support.appendingPathComponent("reminders-apple.json")
        do {
            let data = try extract(store: store)
            try data.write(to: out, options: .atomic)
            if let why = Transport.push(out, to: extractPath) { return (nil, why, writer) }
            return (data.count, nil, writer)
        } catch {
            return (nil, "extract failed: \(error.localizedDescription)", writer)
        }
    }

    static let extractPath = "integrations/reminders-apple.json"
    static let mirrorPath = "integrations/reminders-mirror.json"

    // MARK: - reading

    /// Everything open in every list, plus what was completed in the last
    /// week — a tick is the whole point of reading it, and a week covers a
    /// Mac that slept through a weekend.
    static func extract(store: EKEventStore) throws -> Data {
        let calendars = store.calendars(for: .reminder)
        let weekAgo = Date().addingTimeInterval(-7 * 24 * 3600)

        let open = fetch(store, store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: calendars))
        let done = fetch(store, store.predicateForCompletedReminders(
            withCompletionDateStarting: weekAgo, ending: nil, calendars: calendars))

        guard let open, let done else {
            throw NSError(domain: "Reminders", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "EventKit did not answer within 60 seconds"])
        }

        let items = (open + done).map(record)
            .sorted { ($0["list"] as? String ?? "", $0["title"] as? String ?? "")
                    < ($1["list"] as? String ?? "", $1["title"] as? String ?? "") }

        let doc: [String: Any] = [
            "generated_at": Clock.now(),
            "source": "Obligations.app EventKit",
            "lists": calendars.map(\.title).sorted(),
            "completed_since": Clock.format(weekAgo),
            "count": items.count,
            "reminders": items,
        ]
        return try JSONSerialization.data(withJSONObject: doc,
                                          options: [.prettyPrinted, .sortedKeys])
    }

    private static func record(_ r: EKReminder) -> [String: Any] {
        var out: [String: Any] = [
            // calendarItemIdentifier, not calendarItemExternalIdentifier: iCloud
            // rewrites the external one, and an id that changes under the assistant
            // turns one reminder into two obligations.
            "id": r.calendarItemIdentifier,
            "list": r.calendar?.title ?? "",
            "title": r.title ?? "",
            "completed": r.isCompleted,
            "has_alarm": !(r.alarms ?? []).isEmpty,
        ]
        // A date, or "YYYY-MM-DD HH:MM" when he set a time on his own one.
        let due = r.dueDateComponents.flatMap { c -> String? in
            guard let day = Clock.day(c) else { return nil }
            return Clock.time(c).map { "\(day) \($0)" } ?? day
        }
        out["notes"] = r.notes ?? NSNull()
        out["due"] = due ?? NSNull()
        out["priority"] = priorityName(r.priority) ?? NSNull()
        out["created"] = r.creationDate.map(Clock.format) ?? NSNull()
        out["completed_at"] = r.completionDate.map(Clock.format) ?? NSNull()
        out["url"] = r.url?.absoluteString ?? NSNull()
        out["obligations_id"] = obligationsId(r) ?? NSNull()
        return out
    }

    /// EventKit's fetch is callback-only. This runs on the sync queue, never
    /// the main thread, so waiting on it is fine; nil means it never answered.
    private static func fetch(_ store: EKEventStore, _ predicate: NSPredicate) -> [EKReminder]? {
        let done = DispatchSemaphore(value: 0)
        var result: [EKReminder]?
        store.fetchReminders(matching: predicate) { found in
            result = found ?? []
            done.signal()
        }
        return done.wait(timeout: .now() + 60) == .success ? result : nil
    }

    enum Marker: Equatable { case none, id(String), conflict(String) }

    static func marker(_ r: EKReminder) -> Marker {
        let fromNotes = idFromNotes(r.notes)
        let fromURL = idFromURL(r.url)
        switch (fromNotes, fromURL) {
        case (nil, nil): return .none
        case let (a?, b?) where a != b: return .conflict("notes say \(a), url says \(b)")
        case let (a?, _): return .id(a)
        case let (_, b?): return .id(b)
        }
    }

    static func obligationsId(_ r: EKReminder) -> String? {
        if case .id(let id) = marker(r) { return id }
        return nil
    }

    static func idFromNotes(_ notes: String?) -> String? {
        guard let notes else { return nil }
        let last = notes.split(separator: "\n", omittingEmptySubsequences: false)
            .last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        guard last.hasPrefix(notesMarker) else { return nil }
        let id = String(last.dropFirst(notesMarker.count)).trimmingCharacters(in: .whitespaces)
        return id.isEmpty || id.contains(" ") ? nil : id
    }

    static func idFromURL(_ url: URL?) -> String? {
        guard let s = url?.absoluteString, s.hasPrefix(pageBase) else { return nil }
        let id = String(s.dropFirst(pageBase.count)).removingPercentEncoding ?? ""
        return id.isEmpty ? nil : id
    }

    static func url(for id: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let safe = id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
        return URL(string: pageBase + safe)
    }

    /// His notes from the mirror, then the marker as the last line.
    static func notes(for item: ReminderMirror.Item) -> String {
        let body = (item.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return (body.isEmpty ? "" : body + "\n\n") + notesMarker + item.id
    }

    /// EKReminder.priority: 0 none, 1–4 high, 5 medium, 6–9 low.
    static func priorityName(_ p: Int) -> String? {
        switch p {
        case 1...4: return "high"
        case 5:     return "normal"
        case 6...9: return "low"
        default:    return nil
        }
    }

    /// "normal" is written as no flag rather than as medium: Reminders shows
    /// a mark for any priority, and most of the list is normal.
    static func priorityValue(_ name: String?) -> Int {
        switch name {
        case "high": return 1
        case "low":  return 9
        default:     return 0
        }
    }

    // MARK: - writing

    struct Plan {
        var created: [String] = []
        var updated: [String] = []
        var completed: [String] = []
        var skipped: [String] = []
        var problems: [String] = []
        var aborted: String?
        /// His own reminders, completed because he closed the task here.
        var ownCompleted: [String] = []
        /// Named in complete[] but not acted on, each with the reason.
        var ownSkipped: [String] = []
        /// Named, valid, and waiting only because the path is not armed.
        var ownHeld: [String] = []

        var summary: String {
            if let aborted { return "mirrored nothing — \(aborted)" }
            var parts = ["\(created.count) created", "\(updated.count) updated",
                         "\(completed.count) completed"]
            if !skipped.isEmpty { parts.append("\(skipped.count) skipped") }
            if !ownCompleted.isEmpty { parts.append("\(ownCompleted.count) of his completed") }
            if !ownHeld.isEmpty { parts.append("\(ownHeld.count) of his held (not armed)") }
            if !ownSkipped.isEmpty {
                parts.append("\(ownSkipped.count) of his skipped: " + ownSkipped.joined(separator: "; "))
            }
            if !problems.isEmpty { parts.append("PROBLEMS: " + problems.joined(separator: "; ")) }
            return parts.joined(separator: ", ")
        }
    }

    /// Make the Obligations list match the mirror. With `write: false` it reads
    /// everything and changes nothing — `--reminders-check` uses that, so the
    /// plan he is shown is computed by the same code that would act on it.
    static func apply(_ mirror: ReminderMirror, store: EKEventStore, write: Bool) -> Plan {
        var plan = Plan()
        if !mirror.rejected.isEmpty {
            plan.problems.append("\(mirror.rejected.count) mirror entr\(mirror.rejected.count == 1 ? "y" : "ies") skipped: "
                                 + mirror.rejected.prefix(3).joined(separator: "; "))
        }

        guard mirror.alarms == false else {
            plan.aborted = "the mirror does not say \"alarms\": false"
            return plan
        }

        let list: EKCalendar?
        switch obligationsList(store, create: write) {
        case .success(let found): list = found
        case .failure(let why):
            plan.aborted = "\(why)"
            return plan
        }

        // Read fresh, completed included. Every create is keyed on this.
        // No list yet (a dry run before the first write) is an empty list.
        let existing: [EKReminder]
        if let list {
            guard let found = fetch(store, store.predicateForReminders(in: [list])) else {
                plan.aborted = "could not read the Obligations list back from EventKit"
                return plan
            }
            existing = found
        } else {
            existing = []
        }

        var byId: [String: [EKReminder]] = [:]
        for r in existing {
            switch marker(r) {
            case .none:
                continue    // his own; never touched
            case .conflict(let why):
                // Ours, and unreadable — exactly the case where creating
                // would duplicate.
                plan.aborted = "a reminder in the Obligations list carries two different ids (\(why))"
                return plan
            case .id(let id):
                byId[id, default: []].append(r)
            }
        }

        let dupes = byId.filter { $0.value.count > 1 }.keys.sorted()
        if !dupes.isEmpty {
            // Already duplicated, by something. Do not guess which is real.
            plan.aborted = "\(dupes.count) obligation id(s) already appear twice in the Obligations list: "
                + dupes.prefix(3).joined(separator: ", ")
            return plan
        }

        let completing = Set(mirror.complete)
        var touched: [EKReminder] = []

        for item in mirror.items {
            if completing.contains(item.id) { continue }     // complete wins

            if let r = byId[item.id]?.first {
                // Present — open or already ticked. Ticked is his answer and
                // stays ticked; the server closes it from the extract.
                if r.isCompleted { plan.skipped.append(item.id); continue }
                if drift(r, item) {
                    if write { set(r, from: item); touched.append(r) }
                    plan.updated.append(item.id)
                }
                continue
            }

            if write, let list {
                let r = EKReminder(eventStore: store)
                r.calendar = list
                set(r, from: item)
                touched.append(r)
            }
            plan.created.append(item.id)
        }

        for id in mirror.complete.sorted() {
            guard let r = byId[id]?.first else { continue }   // nothing to complete
            if r.isCompleted { continue }
            if write { r.isCompleted = true; touched.append(r) }
            plan.completed.append(id)
        }

        if write, !touched.isEmpty, let list {
            saveObligations(touched, list: list, store: store, plan: &plan)
            if plan.aborted != nil { return plan }
        }

        completeOwn(mirror.own, store: store, write: write, plan: &plan)
        return plan
    }

    private static func saveObligations(_ touched: [EKReminder], list: EKCalendar,
                                  store: EKEventStore, plan: inout Plan) {
        for r in touched {
            // Last line before anything is saved: the list, and no alarms.
            guard r.calendar?.calendarIdentifier == list.calendarIdentifier else {
                plan.problems.append("refused to save outside the Obligations list")
                continue
            }
            r.alarms = nil
            do { try store.save(r, commit: false) }
            catch { plan.problems.append("save: \(error.localizedDescription)") }
        }
        do { try store.commit() }
        catch {
            store.reset()
            plan.aborted = "EventKit refused the commit: \(error.localizedDescription)"
            return
        }

        verify(plan: &plan, store: store, list: list)
    }

    // MARK: - his own reminders

    /// Complete reminders in HIS lists, one at a time, by identifier.
    ///
    /// The only path that touches a list other than Obligations, so it is fenced
    /// harder than the rest and switched off until Alex says yes on the Mac.
    /// The server queues one only for a close he made himself — the To Do page,
    /// or ticking the Obligations copy — so what arrives here is his decision by
    /// another route, never the assistant's judgement.
    ///
    /// - **Complete only.** `isCompleted = true` and nothing else: no title,
    ///   notes, date, alarm or list is written, and nothing is created.
    /// - **Only what is named.** Resolved by calendarItemIdentifier. Not found
    ///   is a skip, never a search by title.
    /// - **The list must match.** A reminder in a different list than the entry
    ///   says means identifiers moved under us: skip, and say so.
    /// - **A different title is completed anyway, and reported** — iCloud may
    ///   have synced an edit he made.
    /// - Never a reminder in the Obligations list, and never one carrying a repo id:
    ///   those are ours and go through the id path above.
    private static func completeOwn(_ entries: [ReminderMirror.Own], store: EKEventStore,
                                    write: Bool, plan: inout Plan) {
        guard !entries.isEmpty else { return }
        let armed = ownArmedReason() == nil
        var touched: [(EKReminder, ReminderMirror.Own)] = []

        for e in entries {
            let tag = "\(e.reminder.prefix(8))…"
            guard let listName = e.list, !listName.isEmpty else {
                plan.ownSkipped.append("\(tag) names no list to check against"); continue
            }
            guard let r = store.calendarItem(withIdentifier: e.reminder) as? EKReminder else {
                plan.ownSkipped.append("\(tag) not found"); continue
            }
            let actual = r.calendar?.title ?? ""
            if actual == Reminders.listName {
                plan.ownSkipped.append("\(tag) is in the Obligations list, not one of his"); continue
            }
            if marker(r) != .none {
                plan.ownSkipped.append("\(tag) carries a repo id, so it is not his"); continue
            }
            if actual != listName {
                plan.ownSkipped.append("\(tag) is in \(actual), entry says \(listName) — identifiers may have moved")
                plan.problems.append("his reminder \(tag) is not in the list the server named")
                continue
            }
            if r.isCompleted { continue }                 // already done; the queue will empty
            if let t = e.title, (r.title ?? "") != t {
                plan.problems.append("his reminder \(tag) is titled differently than the server said; completed anyway")
            }
            guard armed else { plan.ownHeld.append(tag); continue }
            if write { touched.append((r, e)) }
            plan.ownCompleted.append(tag)
        }

        guard write, !touched.isEmpty else { return }

        var before: [String: (calendar: String, title: String)] = [:]
        for (r, e) in touched {
            before[e.reminder] = (r.calendar?.calendarIdentifier ?? "", r.title ?? "")
            r.isCompleted = true                          // the whole write
            do { try store.save(r, commit: false) }
            catch { plan.problems.append("save of his reminder: \(error.localizedDescription)") }
        }
        do { try store.commit() }
        catch {
            store.reset()
            plan.problems.append("EventKit refused to complete his reminders: \(error.localizedDescription)")
            plan.ownCompleted.removeAll()
            return
        }

        // Read each back through a fresh store: completed, same list, same title.
        let fresh = EKEventStore()
        for (_, e) in touched {
            guard let again = fresh.calendarItem(withIdentifier: e.reminder) as? EKReminder,
                  let was = before[e.reminder],
                  again.isCompleted,
                  again.calendar?.calendarIdentifier == was.calendar,
                  (again.title ?? "") == was.title else {
                disableOwn("a completed reminder of his did not read back as completed and unchanged")
                plan.problems.append("his reminders failed read-back; that path turned off")
                return
            }
        }
    }

    /// Read every id we just wrote back through a fresh store. If any is not
    /// there exactly once, the id does not survive the round trip on this
    /// machine, and the next pass would create it again — so stop now.
    private static func verify(plan: inout Plan, store: EKEventStore, list: EKCalendar) {
        let fresh = EKEventStore()
        guard let again = fresh.calendar(withIdentifier: list.calendarIdentifier),
              let items = fetch(fresh, fresh.predicateForReminders(in: [again])) else {
            disableWriter("could not re-read the Obligations list after writing")
            plan.problems.append("could not verify; writer turned off")
            return
        }
        var counts: [String: Int] = [:]
        for r in items { if let id = obligationsId(r) { counts[id, default: 0] += 1 } }
        let bad = (plan.created + plan.updated + plan.completed).filter { counts[$0] != 1 }
        if !bad.isEmpty {
            disableWriter("\(bad.count) id(s) did not read back exactly once after writing, e.g. \(bad[0])")
            plan.problems.append("\(bad.count) id(s) failed to read back; writer turned off")
        }
    }

    private static func drift(_ r: EKReminder, _ item: ReminderMirror.Item) -> Bool {
        if (r.title ?? "") != item.title { return true }
        if (r.notes ?? "") != notes(for: item) { return true }
        if r.dueDateComponents.flatMap(Clock.day) != item.due { return true }
        if r.dueDateComponents.flatMap(Clock.time) != nil { return true }   // a time crept in
        if r.priority != priorityValue(item.priority) { return true }
        if r.url != (item.url ?? url(for: item.id)) { return true }
        return false
    }

    private static func set(_ r: EKReminder, from item: ReminderMirror.Item) {
        r.title = item.title
        r.notes = notes(for: item)
        r.url = item.url ?? url(for: item.id)
        r.priority = priorityValue(item.priority)
        // Year, month, day and nothing else. No hour means no alert.
        r.dueDateComponents = item.due.flatMap(Clock.components)
        r.alarms = nil
    }

    /// The one list this writes to. Created if missing — making the list it
    /// was asked to fill is not touching another one — in the same account
    /// as his default reminders list, so it syncs to his phone.
    static func obligationsList(_ store: EKEventStore, create: Bool) -> Result<EKCalendar?, Why> {
        let named = store.calendars(for: .reminder).filter { $0.title == listName }
        if named.count > 1 { return .failure(Why("there are \(named.count) lists called \(listName)")) }
        if let list = named.first {
            return list.allowsContentModifications
                ? .success(list) : .failure(Why("the \(listName) list is read-only"))
        }
        guard create else { return .success(nil) }   // dry run, no list yet
        guard let source = store.defaultCalendarForNewReminders()?.source else {
            return .failure(Why("no reminders account to create the \(listName) list in"))
        }
        let list = EKCalendar(for: .reminder, eventStore: store)
        list.title = listName
        list.source = source
        do {
            try store.saveCalendar(list, commit: true)
            Log.write("reminders: created the \(listName) list in \(source.title)")
            return .success(list)
        } catch {
            return .failure(Why("could not create the \(listName) list: \(error.localizedDescription)"))
        }
    }

    // MARK: - the off switch

    private static let disabledKey = "remindersWriterDisabled"

    /// Set only when the writer stopped itself — a failed read-back. Not
    /// set merely because it was never armed; the menu warns on this one.
    static func writerTurnedOffReason() -> String? {
        UserDefaults.standard.string(forKey: disabledKey)
    }

    private static let armedKey = "remindersWriterArmed"
    private static let ownArmedKey = "remindersOwnCompleteArmed"
    private static let ownDisabledKey = "remindersOwnCompleteDisabled"

    /// Completing HIS reminders is armed separately, and only by Alex.
    static func ownArmedReason() -> String? {
        if let reason = UserDefaults.standard.string(forKey: ownDisabledKey) { return reason }
        if !UserDefaults.standard.bool(forKey: ownArmedKey) { return "not armed — waiting on Alex" }
        return nil
    }

    static func disableOwn(_ why: String) {
        UserDefaults.standard.set("\(Clock.now()): \(why)", forKey: ownDisabledKey)
        Log.write("reminders: completing his own reminders TURNED OFF — \(why)")
    }

    static func armOwn() {
        UserDefaults.standard.removeObject(forKey: ownDisabledKey)
        UserDefaults.standard.set(true, forKey: ownArmedKey)
        Log.write("reminders: completing his own reminders armed")
    }

    /// Off until armed, deliberately. The server session asked to check what
    /// the reader pushes before anything is written to his Obligations list, and a
    /// fresh install should not start writing the moment Reminders is granted.
    static func writerDisabledReason() -> String? {
        if let reason = UserDefaults.standard.string(forKey: disabledKey) { return reason }
        if !UserDefaults.standard.bool(forKey: armedKey) {
            return "not armed yet — reading only"
        }
        return nil
    }

    static func disableWriter(_ why: String) {
        UserDefaults.standard.set("\(Clock.now()): \(why)", forKey: disabledKey)
        Log.write("reminders writer TURNED OFF — \(why)")
    }

    /// Only from the menu or `--reminders-writer-on`, by a person who has read
    /// why it turned off.
    static func enableWriter() {
        UserDefaults.standard.removeObject(forKey: disabledKey)
        UserDefaults.standard.set(true, forKey: armedKey)
        Log.write("reminders writer turned back on")
    }
}

// MARK: - the mirror file

struct ReminderMirror {
    struct Item {
        let id: String
        let title: String
        let notes: String?
        let due: String?        // YYYY-MM-DD
        let priority: String?   // high | normal | low
        let url: URL?
    }

    /// One of HIS reminders, named by its own identifier.
    struct Own {
        let reminder: String    // calendarItemIdentifier
        let list: String?       // for the sanity check, never for finding it
        let title: String?      // for the log and the sanity check
    }

    let alarms: Bool?
    let schema: Int?
    let items: [Item]
    let complete: [String]
    let own: [Own]
    /// Entries skipped as unreadable, each with the reason. Reported, never fatal.
    let rejected: [String]

    /// Tolerant of the id's field name and of `complete` being ids or objects,
    /// strict about everything that could cause a wrong write: an item with no
    /// id or no title, or a due date that is not a bare date, refuses the file.
    /// The schemas this reader knows. 1: id-only complete[]. 2: adds the
    /// { reminder, list, title } entry for one of his own reminders.
    static let knownSchemas: Set<Int> = [1, 2]

    /// Two levels of refusal, deliberately different.
    ///
    /// **The file** is refused only for what makes every write unsafe: not
    /// JSON, a different list, or (in `apply`) no `"alarms": false`.
    ///
    /// **An entry** that cannot be read is skipped and reported, never allowed
    /// to take the file down with it. A refused file freezes the Obligations list,
    /// and a frozen list looks exactly like a list with nothing to do — the
    /// failure the whole bridge exists to prevent. A skipped item is simply
    /// neither created nor changed; a skipped completion is simply not done.
    static func decode(_ data: Data) -> Result<ReminderMirror, Why> {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(Why("not a JSON object"))
        }
        if let list = root["list"] as? String, list != Reminders.listName {
            return .failure(Why("the mirror is for a list called \(list), not \(Reminders.listName)"))
        }
        var rejected: [String] = []
        let schema = root["schema"] as? Int
        if let schema, !knownSchemas.contains(schema) {
            rejected.append("schema \(schema) is newer than this build; reading what it can")
        }

        let idKeys = ["id", "obligations_id", "obligation_id"]
        func idOf(_ o: [String: Any]) -> String? {
            for k in idKeys { if let s = o[k] as? String, !s.isEmpty { return s } }
            return nil
        }

        var items: [Item] = []
        for (n, raw) in ((root["items"] as? [Any]) ?? []).enumerated() {
            guard let raw = raw as? [String: Any] else { rejected.append("item \(n) is not an object"); continue }
            guard let id = idOf(raw) else { rejected.append("item \(n) has no id"); continue }
            guard let title = raw["title"] as? String, !title.isEmpty else {
                rejected.append("item \(id) has no title"); continue
            }
            if let d = raw["due"] as? String, d.count > 10 {
                rejected.append("item \(id) has a due time (\(d)); dates only"); continue
            }
            let due = raw["due"] as? String
            if let due, Clock.components(due) == nil {
                rejected.append("item \(id) has an unreadable due date \(due)"); continue
            }
            let url = (raw["url"] as? String).flatMap(URL.init(string:))
            // The url is one of the two places the id is read back from. One
            // naming a different obligation would conflict with itself next pass.
            if let url, let other = Reminders.idFromURL(url), other != id {
                rejected.append("item \(id) has a url for \(other)"); continue
            }
            if let p = raw["priority"] as? String, !["high", "normal", "low"].contains(p) {
                rejected.append("item \(id) has an unknown priority \(p)"); continue
            }
            items.append(Item(id: id, title: title,
                              notes: raw["notes"] as? String,
                              due: due,
                              priority: raw["priority"] as? String,
                              url: url))
        }

        // An id listed twice: drop every copy. Keeping "the first" would let
        // a reordered mirror pick a different one next pass.
        let counts = Dictionary(items.map { ($0.id, 1) }, uniquingKeysWith: +)
        let twice = counts.filter { $0.value > 1 }.keys.sorted()
        if !twice.isEmpty {
            rejected.append("listed twice, so not mirrored: " + twice.joined(separator: ", "))
            items.removeAll { counts[$0.id, default: 0] > 1 }
        }

        var complete: [String] = []
        var own: [Own] = []
        for (n, raw) in ((root["complete"] as? [Any]) ?? []).enumerated() {
            if let s = raw as? String, !s.isEmpty { complete.append(s); continue }
            guard let o = raw as? [String: Any] else {
                rejected.append("complete[\(n)] is not readable"); continue
            }
            // Checked before idOf: an entry naming one of his reminders must
            // never be read as a Obligations-list obligation id.
            if o["reminder"] != nil {
                guard let r = o["reminder"] as? String, !r.isEmpty else {
                    rejected.append("complete[\(n)] names an empty reminder"); continue
                }
                own.append(Own(reminder: r, list: o["list"] as? String, title: o["title"] as? String))
            } else if let id = idOf(o) {
                complete.append(id)
            } else {
                rejected.append("complete[\(n)] has no id or reminder a schema-\(schema.map(String.init) ?? "?") reader knows")
            }
        }

        return .success(ReminderMirror(alarms: root["alarms"] as? Bool, schema: schema,
                                       items: items, complete: complete, own: own,
                                       rejected: rejected))
    }
}

// MARK: - stamps

/// Local wall clock, `YYYY-MM-DD HH:MM`, no offset — the repo's one format.
/// The formatter is the outbox's `Clock.minute`, so the two cannot drift.
enum Clock {
    static func now() -> String { format(Date()) }
    static func format(_ d: Date) -> String { Stamp.minute.string(from: d) }

    static func day(_ c: DateComponents) -> String? {
        guard let y = c.year, let m = c.month, let d = c.day else { return nil }
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    static func time(_ c: DateComponents) -> String? {
        guard let h = c.hour else { return nil }
        return String(format: "%02d:%02d", h, c.minute ?? 0)
    }

    static func components(_ day: String) -> DateComponents? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]), (1...31).contains(parts[2]) else {
            return nil
        }
        return DateComponents(year: parts[0], month: parts[1], day: parts[2])
    }
}

/// `Result` needs an `Error`; every failure here is a sentence for the log.
struct Why: Error, CustomStringConvertible {
    let description: String
    init(_ s: String) { description = s }
}
