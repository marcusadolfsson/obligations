import SwiftUI
import WebKit

struct MacContentView: View {
    @ObservedObject private var controller = WebController.shared

    var body: some View {
        ZStack {
            MacWebView(controller: controller)
            if let error = controller.loadError {
                ErrorOverlay(message: error) { controller.reload() }
            }
        }
        .background(Color("PageBackground"))
        .navigationTitle(controller.title)
    }
}

struct MacWebView: NSViewRepresentable {
    let controller: WebController
    func makeNSView(context: Context) -> WKWebView { controller.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
