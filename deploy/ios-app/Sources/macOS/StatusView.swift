import SwiftUI

/// What the server has been told about this Mac, and the app's log tail.
/// Exists so "did the push registration work?" has an answer that is not
/// Console.app. iOS has no equivalent view; the page can read the same
/// thing from `window.obligationsApp.push`.
struct StatusView: View {
    @ObservedObject private var registration = DeviceRegistration.shared
    @ObservedObject private var location = LocationReporter.shared
    @ObservedObject private var log = Log.shared
    @State private var now = "…"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                row("bundle", ObligationsConfig.bundleID)
                row("platform", "\(ObligationsConfig.platform), \(ObligationsConfig.deviceName)")
                row("APNs", ObligationsConfig.apsEnvironment)
                row("token", registration.token ?? "—")
                row("server", stateText)
                Divider()
                row("location", location.authorization)
                row("last sent", location.lastReport + (location.queued > 0 ? " · \(location.queued) queued" : ""))
                row("obligations says", now)
            }
            .font(.system(.body, design: .monospaced))
            .textSelection(.enabled)

            HStack {
                Button("Send Location Now") { LocationReporter.shared.requestOnce(source: "manual") }
                Button("Register again") { registration.retry() }
                    .disabled(registration.token == nil)
                Button("Unregister") { Task { await registration.unregister() } }
                    .disabled(registration.token == nil)
                Spacer()
                if let token = registration.token {
                    Button("Copy token") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(token, forType: .string)
                    }
                }
            }

            Divider()
            ScrollView {
                Text(log.lines.joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .padding(16)
        .task { now = await LocationReporter.shared.fetchNow() }
    }

    private var stateText: String {
        switch registration.state {
        case .waiting: return "waiting for a token"
        case .noToken(let why): return "no token: \(why)"
        case .pending: return "not yet registered"
        case .registered(let at): return "registered \(at.formatted(date: .omitted, time: .shortened))"
        case .failed(let why): return "failed: \(why)"
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).lineLimit(2).truncationMode(.middle)
        }
    }
}
