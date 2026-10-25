import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let controller: WebController

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeUIView(context: Context) -> WKWebView {
        let webView = controller.webView
        // Pull to refresh. The pages are fetch → cards with no refresh of
        // their own, and "is this current?" is the first question on a phone
        // that was in a pocket for an hour. WebController ends it on load.
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject {
        let controller: WebController
        init(controller: WebController) { self.controller = controller }
        @objc func refresh() { controller.reload() }
    }
}
