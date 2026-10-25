import SwiftUI

struct ContentView: View {
    @ObservedObject private var controller = WebController.shared

    var body: some View {
        ZStack {
            // Paints the strip under the status bar in the page's colour.
            Color("PageBackground").ignoresSafeArea()

            // Top edge respected: the page's header is sticky at top:0 and
            // does not pad for a status bar, because until now it always had
            // Safari's chrome above it. Bottom and sides are the page's —
            // it pads with env(safe-area-inset-bottom) — and the keyboard is
            // WebKit's, which adjusts its own scroll view; letting SwiftUI
            // shrink the view as well would move the composer twice.
            WebView(controller: controller)
                .ignoresSafeArea(.container, edges: [.bottom, .horizontal])
                .ignoresSafeArea(.keyboard)

            if let error = controller.loadError {
                ErrorOverlay(message: error) { controller.reload() }
            }
        }
    }
}
