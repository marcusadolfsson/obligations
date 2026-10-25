import AppKit
import SwiftUI

/// What drops down from the menu bar.
///
/// The whole app is one question — *is the assistant getting what it needs from
/// this Mac?* — so the answer is at the top, in one line, before any detail.
/// The old setup answered it only by reading four log files in
/// `~/Library/Logs`, which meant nobody answered it and two extractors were
/// broken for days.
struct MenuView: View {
    @ObservedObject var engine: SyncEngine
    @ObservedObject var accounts: AccountStore
    @ObservedObject var model: AppModel
    @ObservedObject var sender: OutboxSender
    @ObservedObject var server: ServerMonitor

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            if server.installed {
                serverSection
                Divider()
            }
            syncs
            Divider()
            outbox
            Divider()
            googleAccounts
            Divider()
            footer
        }
        .padding(12)
        .frame(width: 340)
    }

    // MARK: - header

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.overallColor)
                .frame(width: 8, height: 8)
            Text(model.overallSummary)
                .font(.system(size: 12, weight: .medium))
            Spacer()
            if engine.running != nil {
                ProgressView().controlSize(.small)
            }
        }
    }

    // MARK: - syncs

    private var syncs: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(SyncJob.all) { job in
                let state = engine.state[job.id]
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(job.title).font(.system(size: 12, weight: .medium))
                        Spacer()
                        Text(Ago.text(state?.lastSuccess))
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    if let error = state?.lastError {
                        // The failure is shown in full rather than truncated to
                        // a chip. "needs Full Disk Access" and "could not reach
                        // linuxbox" are different actions, and a red dot is not
                        // the difference.
                        Text(error)
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if state?.lastSuccess == nil && state?.lastError == nil {
                        Text("not run yet").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { engine.run(job) }
            }

            HStack {
                Button("Force Sync") { engine.syncAll() }
                    .disabled(engine.running != nil)
                Button(engine.paused ? "Resume" : "Pause") { engine.setPaused(!engine.paused) }
                Spacer()
            }
        }
    }

    // MARK: - outbox

    /// The one outward-acting thing in the app, so it says plainly whether it is
    /// on. "Sending is off" is a fact Alex needs at a glance — an approved
    /// message that never goes and never errors is this feature's worst failure,
    /// and it is exactly what a silently-off sender looks like.
    private var outbox: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Outbox").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if sender.running { ProgressView().controlSize(.small) }
            }

            HStack {
                Text(sender.enabled ? "Sending approved drafts" : "Sending is off")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(sender.enabled ? .primary : .secondary)
                Spacer()
                // The poll time, not the send time: "21h ago" beside an
                // error read as an outage of that length when it was the
                // last successful send and the error was hours stale.
                Text(sender.enabled ? "checked \(Ago.text(sender.lastRun))" : "")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }

            if sender.enabled, let sent = sender.lastSent {
                Text("last sent \(Ago.text(sent))")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }

            if let message = sender.lastMessage {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(message.contains("refus") ? .red : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !sender.enabled {
                Text("The imessage-send LaunchAgent may still be running. Turn this on "
                     + "only once it is retired, or an approved draft can go out twice.")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Button(sender.enabled ? "Turn Off" : "Turn On") {
                    sender.setEnabled(!sender.enabled)
                }
                Button("Dry Run") { sender.dryRun() }
                    .disabled(sender.running)
                Spacer()
            }
        }
    }

    // MARK: - server

    /// The assistant server on this Mac — Obligations Server.app's only face. Alex,
    /// 2026-10-01: "add the server status to the existing Obligations app".
    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Server").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if server.working != nil { ProgressView().controlSize(.small) }
            }

            Text(server.headline)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(server.isProblem ? .red : .primary)
            if let detail = server.detail {
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(server.claudeMissing ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                switch server.state {
                case .notInstalled:
                    EmptyView()
                case .notRegistered:
                    Button("Install server") { server.install() }
                case .needsApproval:
                    Button("Open Login Items") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!)
                    }
                case .off:
                    Button("Turn on…") { server.turnOn() }
                case .starting, .up, .down:
                    Button("Restart") { server.restart() }
                    Button("Stop…") { server.turnOff() }
                }
                Button(ClaudeSignIn.hasToken ? "Sign in again…" : "Sign in with Claude…") {
                    ClaudeSignIn.shared.start { server.restartForToken() }
                }
                .disabled(ClaudeSignIn.shared.running)
                Spacer()
            }
            .font(.system(size: 11))
        }
    }

    // MARK: - permissions

    @ViewBuilder
    private var permissionWarnings: some View {
        if !model.fullDiskAccess {
            Row(text: "Full Disk Access is off — iMessage and Calls cannot read anything.",
                action: "Open Settings") { Permissions.openFullDiskAccessSettings() }
        }
        if !model.contacts {
            Row(text: "Contacts access is off — names will not resolve.",
                action: "Grant") { model.askForContacts() }
        }
        if !model.reminders {
            Row(text: "Reminders access is off — ticks will not close tasks.",
                action: "Grant") { model.askForReminders() }
        }
        if let off = Reminders.writerTurnedOffReason() {
            Row(text: "The Obligations list stopped updating: \(off)",
                action: "Turn back on") { Reminders.enableWriter() }
        }
    }

    // MARK: - google

    private var googleAccounts: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Google").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)

            if accounts.accounts.isEmpty {
                // Not "No accounts yet": the grants usually exist already, made
                // by the installer scripts, and this app simply has not been
                // told about them. Saying "none" about a working setup is the
                // wrong-status failure the whole menu exists to avoid.
                Text(Config.isLocal
                     ? "None listed yet. The grants are in this Mac's Obligations repo — import to manage them here."
                     : "None on this Mac. Grants made by the installer scripts live on "
                       + "\(Config.host) — import to manage them here.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(accounts.accounts) { account in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(account.address ?? account.label)
                            .font(.system(size: 12, weight: .medium))
                        Spacer()
                        Text(account.id).font(.system(size: 10)).foregroundStyle(.secondary)
                    }

                    // Granted and in-use are shown separately because they
                    // differ in a way no setting can close: a scope cannot be
                    // narrowed, so a capability switched off is still in the
                    // token. Printing only "Mail, Calendar" would imply Drive
                    // had been removed when it had merely been set aside.
                    HStack(spacing: 4) {
                        Text(account.inUse.isEmpty
                             ? "nothing in use"
                             : account.inUse.map(\.label).joined(separator: ", "))
                            .font(.system(size: 11))
                        if !account.disabled.isEmpty {
                            Text("· granted, not in use: "
                                 + account.disabled.map(\.label).joined(separator: ", "))
                                .font(.system(size: 11))
                                .foregroundStyle(.orange)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)

                    if account.isLegacyLayout {
                        Text("in \(account.remoteStateDir) — not migrated yet")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    if let error = account.lastError {
                        Text(error)
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Re-authorise") { model.reauthorize(account) }
                            .font(.system(size: 11))
                    } else {
                        Text("checked \(Ago.text(account.lastChecked))")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
            }

            HStack {
                Button("Add…") { model.addAccount() }
                Button("Import") { model.importAccounts() }
                Button("Check Now") { model.checkAccounts() }
                    .disabled(accounts.accounts.isEmpty)
                Button("Reconcile") { model.reconcileNow(because: "asked from the menu") }
                Spacer()
                if let busy = model.busy {
                    Text(busy).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            permissionWarnings
            HStack {
                // Where the assistant is: this Mac's repo once it is the server, else linuxbox.
                Text(Config.isLocal ? "this Mac" : Config.host)
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Log") { NSWorkspace.shared.open(Config.logFile) }
                    .font(.system(size: 11))
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .font(.system(size: 11))
            }
        }
    }

    private struct Row: View {
        let text: String
        let action: String
        let run: () -> Void
        var body: some View {
            HStack(alignment: .top, spacing: 6) {
                Text(text).font(.system(size: 11)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(action, action: run).font(.system(size: 11))
            }
        }
    }
}

/// "4 minutes ago", or "never".
///
/// A menu that shows an absolute timestamp makes the reader do the subtraction,
/// and the only question being asked is how stale it is.
enum Ago {
    static func text(_ date: Date?) -> String {
        guard let date else { return "never" }
        let seconds = Int(Date().timeIntervalSince(date))
        switch seconds {
        case ..<0: return "just now"
        case 0..<90: return "just now"
        case 90..<5400: return "\(seconds / 60)m ago"
        case 5400..<172800: return "\(seconds / 3600)h ago"
        default: return "\(seconds / 86400)d ago"
        }
    }
}
