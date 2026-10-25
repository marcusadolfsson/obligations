import SwiftUI
import UserNotifications

@main
struct ObligationsMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var controller = WebController.shared
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        // One window, not a group: there is one web view and one session.
        // Closing it hides it; the Dock icon or a tapped push brings it back.
        Window("Obligations", id: "main") {
            MacContentView()
                .frame(minWidth: 480, minHeight: 480)
        }
        .defaultSize(width: 1100, height: 820)
        .commands {
            CommandMenu("Go") {
                Button("Back") { controller.goBack() }
                    .keyboardShortcut("[", modifiers: .command)
                    .disabled(!controller.canGoBack)
                Button("Forward") { controller.goForward() }
                    .keyboardShortcut("]", modifiers: .command)
                    .disabled(!controller.canGoForward)
                Divider()
                Button("Today") { controller.home() }
                    .keyboardShortcut("h", modifiers: [.command, .shift])
                Button("Reload") { controller.reload() }
                    .keyboardShortcut("r", modifiers: .command)
                Divider()
                Button("Send Location Now") { LocationReporter.shared.requestOnce(source: "manual") }
                    .keyboardShortcut("l", modifiers: [.command, .option])
                Button("Status…") { openWindow(id: "status") }
                    .keyboardShortcut("i", modifiers: [.command, .option])
            }
        }

        Window("Status", id: "status") {
            StatusView()
        }
        .defaultSize(width: 460, height: 420)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        PushCoordinator.shared.start()
        LocationReporter.shared.start()
    }

    func application(_ application: NSApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        DeviceRegistration.shared.received(deviceToken: deviceToken)
    }

    func application(_ application: NSApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        DeviceRegistration.shared.failed(error)
    }

    /// Stay running with the window closed, like Mail. Pushes are delivered
    /// by the system either way; this is so a tap opens the page in a
    /// warm web view instead of relaunching and signing in.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
