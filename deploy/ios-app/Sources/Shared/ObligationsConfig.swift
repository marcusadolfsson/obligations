import Foundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Where the assistant is, and what this build is.
enum ObligationsConfig {

    /// The only origin this app is for. Everything else a link points at
    /// opens in the system browser — see WebController's navigation policy.
    static let origin = URL(string: "https://obligations.example.com")!
    static var host: String { origin.host! }

    static var bundleID: String { Bundle.main.bundleIdentifier ?? "com.example.obligations.app" }
    static var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }
    static var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0" }

    /// What POST /api/devices calls this device. iPad is its own answer
    /// because a push routed to "the phone" should not land on the iPad on
    /// the desk and count as delivered.
    static var platform: String {
        #if os(macOS)
        return "macos"
        #else
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        #endif
    }

    static var deviceName: String {
        #if os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return UIDevice.current.name
        #endif
    }

    /// Which APNs gateway can reach this build: "sandbox" for a development
    /// profile, "production" for a distribution one. Read from the
    /// provisioning profile Xcode embedded, because that is the thing that
    /// actually decides — a Debug build exported through TestFlight is
    /// production, and the server sending to the wrong gateway gets a
    /// BadDeviceToken with no other clue.
    static var apsEnvironment: String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        if let env = provisioningAPSEnvironment() { return env }
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
        #endif
    }

    private static func provisioningAPSEnvironment() -> String? {
        #if os(macOS)
        let url = Bundle.main.bundleURL.appendingPathComponent("Contents/embedded.provisionprofile")
        #else
        let url = Bundle.main.bundleURL.appendingPathComponent("embedded.mobileprovision")
        #endif
        // The profile is CMS-signed, but the plist inside is plain text, and
        // the one key we want is unambiguous. No need to parse the envelope.
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let key = text.range(of: "aps-environment</key>") else { return nil }
        let after = text[key.upperBound...].prefix(120)
        if after.contains("development") { return "sandbox" }
        if after.contains("production") { return "production" }
        return nil
    }

    /// Appended to WebKit's user agent so it matches Safari's.
    ///
    /// Not vanity: Google's sign-in page refuses embedded web views by looking
    /// for exactly this tail, and Cloudflare Access sends every unauthenticated
    /// request through Google. Without it the first launch is a
    /// "disallowed_useragent" error page and no cookie is ever set. The
    /// version numbers only have to look like a Safari that exists.
    static var userAgentSuffix: String {
        #if os(macOS)
        return "Version/18.5 Safari/605.1.15"
        #else
        // WKWebView on iPad renders the desktop site by default and sends a
        // Macintosh user agent, so it gets Safari-on-Mac's tail too.
        if UIDevice.current.userInterfaceIdiom == .pad { return "Version/18.5 Safari/605.1.15" }
        return "Version/18.5 Mobile/15E148 Safari/604.1"
        #endif
    }

    static func isObligations(_ url: URL) -> Bool {
        url.host?.lowercased() == host
    }

    /// Turns the `url` from a push payload into something to load. A path
    /// ("/digest#pane=x") is resolved against the origin; an absolute URL is
    /// accepted only if it is the assistant. Nothing else — a push is trusted to
    /// choose a page, not to send the app anywhere on the web.
    static func resolve(_ string: String) -> URL? {
        if string.hasPrefix("/") { return URL(string: string, relativeTo: origin)?.absoluteURL }
        guard let url = URL(string: string), url.scheme == "https", isObligations(url) else { return nil }
        return url
    }
}
