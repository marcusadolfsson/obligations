import Foundation
import WebKit

/// Tells the assistant about this device's push token.
///
/// The token goes up through the page, not through URLSession: a `fetch` run
/// inside the web view carries the Cloudflare Access cookie the page already
/// holds, so the server takes the identity from the same verified JWT it
/// takes everything else from, and the app never touches an Access cookie or
/// a service token. The price is that registration can only happen while a
/// repo page is loaded and signed in — so it is attempted after every page
/// load until it succeeds, a few times per launch, and again next launch.
///
/// Contract (Obligations-Dev-Server, 2026-09-05): POST /api/devices with
/// {platform, token, bundle, env, name}; idempotent, keyed by token; DELETE
/// /api/devices {token} to unregister.
@MainActor
final class DeviceRegistration: ObservableObject {
    static let shared = DeviceRegistration()

    enum State: Equatable {
        case waiting                 // no token from APNs yet
        case noToken(String)         // APNs refused to issue one
        case pending                 // have a token, not yet accepted by the server
        case registered(Date)
        case failed(String)          // last attempt's reason; will retry
    }

    @Published private(set) var token: String?
    @Published private(set) var state: State = .waiting

    private var registeredToken: String?
    private var attemptsThisLaunch = 0
    private let maxAttemptsPerLaunch = 4

    var payload: [String: Any]? {
        guard let token else { return nil }
        return [
            "platform": ObligationsConfig.platform,
            "token": token,
            "bundle": ObligationsConfig.bundleID,
            "env": ObligationsConfig.apsEnvironment,
            "name": ObligationsConfig.deviceName,
            "app": "\(ObligationsConfig.version) (\(ObligationsConfig.build))",
        ]
    }

    func received(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Log.write("APNs token \(hex.prefix(8))…, \(ObligationsConfig.apsEnvironment), \(ObligationsConfig.platform)")
        token = hex
        if hex != registeredToken {
            state = .pending
            attemptsThisLaunch = 0
            // Only if the web view already exists: on a background relaunch
            // (a location event) there is no page, and creating one here
            // would load the whole site with nobody looking. The next
            // foreground page load registers.
            if WebController.exists { Task { await register(in: WebController.shared.webView) } }
        }
    }

    func failed(_ error: Error) {
        Log.write("APNs registration failed: \(error.localizedDescription)")
        state = .noToken(error.localizedDescription)
    }

    /// Called by WebController when a repo page finishes loading.
    func pageDidLoad(_ webView: WKWebView) {
        Task { await register(in: webView) }
    }

    /// Forget that the server has this token, so the next page load re-sends
    /// it. For the status window's "Register again".
    func retry() {
        registeredToken = nil
        attemptsThisLaunch = 0
        if token != nil { state = .pending }
        Task { await register(in: WebController.shared.webView) }
    }

    private func register(in webView: WKWebView) async {
        guard let token, token != registeredToken,
              attemptsThisLaunch < maxAttemptsPerLaunch,
              let url = webView.url, ObligationsConfig.isObligations(url), !webView.isLoading,
              let payload else { return }
        attemptsThisLaunch += 1

        let outcome = await call(webView, method: "POST", body: payload)
        switch outcome.status {
        case 200..<300:
            registeredToken = token
            state = .registered(Date())
            Log.write("device registered (\(outcome.status))")
        case 401, 403:
            // The page loaded but the session is not accepted — mid sign-in,
            // or an expired Access cookie about to bounce. Next load, then.
            state = .failed("not signed in (\(outcome.status))")
            Log.write("device registration: not signed in (\(outcome.status))")
        case 404:
            // The server does not have the endpoint yet. Pushes still arrive
            // by the old route; stop hammering it this launch.
            attemptsThisLaunch = maxAttemptsPerLaunch
            state = .failed("server has no /api/devices yet")
            Log.write("device registration: /api/devices not there yet")
        default:
            state = .failed("HTTP \(outcome.status) \(outcome.text)")
            Log.write("device registration failed: HTTP \(outcome.status) \(outcome.text)")
        }
    }

    /// DELETE /api/devices {token}. Nothing in the UI calls this on iOS —
    /// there is no sign-out — but the Mac status window offers it.
    func unregister() async {
        guard let token else { return }
        let outcome = await call(WebController.shared.webView, method: "DELETE", body: ["token": token])
        if (200..<300).contains(outcome.status) {
            registeredToken = nil
            attemptsThisLaunch = maxAttemptsPerLaunch   // and do not re-register until next launch
            state = .pending
            Log.write("device unregistered")
        } else {
            Log.write("unregister failed: HTTP \(outcome.status) \(outcome.text)")
        }
    }

    private func call(_ webView: WKWebView, method: String, body: [String: Any]) async -> (status: Int, text: String) {
        // Runs in the page: same-origin, so the Access cookie rides along.
        // Status 0 is a thrown fetch (offline, or the page navigated away).
        let script = """
        try {
          const r = await fetch('/api/devices', {
            method: method, credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: r.status, text: (await r.text()).slice(0, 200) };
        } catch (e) {
          return { status: 0, text: String(e) };
        }
        """
        do {
            let result = try await webView.callAsyncJavaScript(
                script, arguments: ["method": method, "body": body], in: nil, contentWorld: .page)
            let dict = result as? [String: Any] ?? [:]
            return (dict["status"] as? Int ?? 0, dict["text"] as? String ?? "")
        } catch {
            return (0, error.localizedDescription)
        }
    }
}
