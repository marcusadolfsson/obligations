import SwiftUI

/// Shown over the web view when a load fails outright — no network, DNS,
/// the tailnet down. Everything that renders as a page (an Access error,
/// a 502 from the origin) is the page's own business and stays a page.
struct ErrorOverlay: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.secondary)
            Text("Can't reach the assistant")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0xC9 / 255, green: 0x64 / 255, blue: 0x42 / 255))
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color("PageBackground"))
    }
}
