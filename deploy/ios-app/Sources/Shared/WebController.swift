import Combine
import Foundation
import WebKit
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The one web view, and the rules about what it may do.
///
/// A single instance for the app's lifetime: the page keeps the Access cookie
/// in its data store, the drawer keeps its transcript, and a second web view
/// would be a second session with neither.
@MainActor
final class WebController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {

    static private(set) var exists = false
    static let shared: WebController = {
        let c = WebController()
        exists = true
        return c
    }()

    let webView: WKWebView

    @Published private(set) var title = "Obligations"
    @Published private(set) var loadError: String?
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false

    private var observers: [NSKeyValueObservation] = []
    private var cancellables: Set<AnyCancellable> = []

    override private init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()            // persistent: the Access cookie lives here
        config.applicationNameForUserAgent = ObligationsConfig.userAgentSuffix
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        #endif
        config.userContentController.addUserScript(
            WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(BridgeHandler(), name: "obligations")

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The site's swipe-back is history-based (pushState), so WebKit's own
        // edge-swipe is the right implementation and needs no help.
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        #if os(iOS)
        // The page sets viewport-fit=cover and pads its bottom with
        // env(safe-area-inset-bottom); the view handles the top (see
        // ContentView). Neither wants UIKit's automatic insets on top.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.backgroundColor = UIColor(named: "PageBackground")
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.underPageBackgroundColor = webView.backgroundColor
        #else
        webView.underPageBackgroundColor = NSColor(named: "PageBackground") ?? .windowBackgroundColor
        #endif

        observers = [
            webView.observe(\.title) { [weak self] wv, _ in
                Task { @MainActor in self?.title = wv.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Obligations" }
            },
            webView.observe(\.canGoBack) { [weak self] wv, _ in Task { @MainActor in self?.canGoBack = wv.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] wv, _ in Task { @MainActor in self?.canGoForward = wv.canGoForward } },
        ]

        // Tell the page when the push state changes, so /system can show it.
        DeviceRegistration.shared.$state
            .sink { [weak self] _ in self?.publishBridgeState() }
            .store(in: &cancellables)

        if let pending = PushCoordinator.shared.pendingURL {
            PushCoordinator.shared.pendingURL = nil
            load(pending)
        } else {
            load(ObligationsConfig.origin)
        }
    }

    // MARK: - Driving it

    func load(_ url: URL) {
        loadError = nil
        webView.load(URLRequest(url: url))
    }

    func reload() {
        loadError = nil
        if let url = webView.url, url.scheme != nil { webView.reload() } else { load(ObligationsConfig.origin) }
    }

    func home() { load(ObligationsConfig.origin) }
    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }

    // MARK: - What the page can see

    /// `window.obligationsApp` at document start, so the page can tell it is inside
    /// the app (no "add to home screen" hint, no Safari share sheet) and can
    /// read the push registration state. `html.obligations-app` for CSS.
    private static var bridgeScript: String {
        """
        window.obligationsApp = { platform: "\(ObligationsConfig.platform)", version: "\(ObligationsConfig.version)",
                            build: "\(ObligationsConfig.build)", push: { state: "waiting" } };
        window.obligationsApp.sendLocation = () => webkit.messageHandlers.obligations.postMessage({ cmd: "location" });
        if (document.documentElement) document.documentElement.classList.add("obligations-app");
        """
    }

    private func publishBridgeState() {
        let reg = DeviceRegistration.shared
        let state: String
        switch reg.state {
        case .waiting: state = "waiting"
        case .noToken(let why): state = "no token: \(why)"
        case .pending: state = "pending"
        case .registered: state = "registered"
        case .failed(let why): state = "failed: \(why)"
        }
        let js = """
        if (window.obligationsApp) window.obligationsApp.push = { state: \(Self.jsString(state)),
          token: \(Self.jsString(reg.token ?? "")), env: \(Self.jsString(ObligationsConfig.apsEnvironment)) };
        """
        webView.evaluateJavaScript(js) { _, _ in }
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }

    // MARK: - Navigation policy

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }

        // mailto:, tel:, sms:, facetime: belong to the system.
        if let scheme = url.scheme?.lowercased(), !["https", "http", "about", "blob", "data"].contains(scheme) {
            openExternally(url)
            return decisionHandler(.cancel)
        }

        // A link tapped on a repo page that leads off the assistant opens in the
        // browser. Only that case: redirects, form posts and script
        // navigations are left alone, because sign-in bounces through
        // cloudflareaccess.com and accounts.google.com and must stay in here
        // for the cookie to land in this web view — and while we are on one
        // of those pages, its own links (another account, a help page) are
        // part of signing in.
        let onObligations = webView.url.map(ObligationsConfig.isObligations) ?? true
        if action.navigationType == .linkActivated, onObligations, !ObligationsConfig.isObligations(url),
           action.targetFrame?.isMainFrame ?? true {
            openExternally(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // Something the web view cannot show (an attachment download): hand
        // the URL to the browser, which can save it. WebKit shows PDFs and
        // images itself, so this is rare.
        if response.isForMainFrame, !response.canShowMIMEType, let url = response.response.url {
            openExternally(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadError = nil
        endRefresh()
        if let url = webView.url, ObligationsConfig.isObligations(url) {
            publishBridgeState()
            DeviceRegistration.shared.pageDidLoad(webView)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        endRefresh()
        let e = error as NSError
        // Not failures: a load superseded by another, or a navigation the
        // policy above cancelled on purpose.
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
        if e.domain == WKError.errorDomain, e.code == 102 { return }   // WebKitErrorFrameLoadInterruptedByPolicyChange
        Log.write("load failed: \(e.domain) \(e.code) \(e.localizedDescription)")
        loadError = e.localizedDescription
    }

    /// WebKit's content process died (memory, mostly). Reload rather than
    /// show a blank view forever.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.write("web content process terminated; reloading")
        webView.reload()
    }

    // MARK: - Windows and popups

    /// target=_blank (the markdown renderer's external links) and
    /// window.open. There is one web view: a repo URL loads here, anything
    /// else goes to the browser. Returning nil tells WebKit no window opened.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        let onObligations = webView.url.map(ObligationsConfig.isObligations) ?? true
        if ObligationsConfig.isObligations(url) || !onObligations {
            webView.load(action.request)
        } else {
            openExternally(url)
        }
        return nil
    }

    func openExternally(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    private func endRefresh() {
        #if os(iOS)
        webView.scrollView.refreshControl?.endRefreshing()
        #endif
    }
}

/// What the page may ask the app to do. One verb so far. The page is the
/// the assistant's own UI, but a handler is still a door, so it recognises exactly
/// the commands listed here and nothing else.
private final class BridgeHandler: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, ObligationsConfig.isObligations(url),
              let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "location":
            Task { @MainActor in LocationReporter.shared.requestOnce(source: "manual") }
        default:
            Log.write("bridge: unknown command \(cmd)")
        }
    }
}
