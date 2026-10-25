import SwiftUI
import UserNotifications

@main
struct ObligationsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

/// Only for the two things SwiftUI's lifecycle does not expose: the APNs
/// token callbacks. Everything else is in Shared/.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // The notification delegate must be in place before this returns,
        // or a tap that launched the app is delivered to nobody.
        PushCoordinator.shared.start()
        // Also on the background relaunch iOS does for a location event
        // (launchOptions[.location]): re-creating the manager here is what
        // makes that event arrive.
        LocationReporter.shared.start()
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        DeviceRegistration.shared.received(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        DeviceRegistration.shared.failed(error)
    }
}
