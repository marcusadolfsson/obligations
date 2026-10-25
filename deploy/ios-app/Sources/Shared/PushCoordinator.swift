import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Asks for permission, asks APNs for a token, and turns a tapped
/// notification into a page in the web view.
@MainActor
final class PushCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCoordinator()

    /// A tap that arrived before the web view existed (cold launch from a
    /// notification). WebController consumes it when it starts.
    var pendingURL: URL?

    func start() {
        UNUserNotificationCenter.current().delegate = self
        Task {
            do {
                let granted = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
                Log.write(granted ? "notifications allowed" : "notifications declined")
            } catch {
                Log.write("notification authorization: \(error.localizedDescription)")
            }
            // Register either way. A declined prompt still yields a token, and
            // the server would rather know the device than not; what it may
            // not do is show anything until he changes his mind in Settings.
            #if os(macOS)
            NSApplication.shared.registerForRemoteNotifications()
            #else
            UIApplication.shared.registerForRemoteNotifications()
            #endif
        }
    }

    // Both delegate methods below are the completion-handler forms, on purpose.
    //
    // They were `async` until 2026-09-20. Swift bridges an async delegate
    // method by running it on the cooperative pool and calling UIKit's
    // completion handler from whatever thread the task finished on — and on
    // iOS 27 that handler (-[UIApplication _updateSnapshotAndStateRestoration…])
    // asserts "Call must be made on main thread". It only fired on a COLD
    // launch from a tapped notification, so a warm-tap test passed and every
    // real tap from the lock screen killed the app. The handler is now called
    // on the main queue, explicitly, and nothing here is async.

    /// Show a push even while the app is in front. He may be on /chat when
    /// a prep note lands; the banner is how he learns it exists.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async { completionHandler([.banner, .list, .sound]) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let url = Self.url(from: response.notification.request.content.userInfo)
        DispatchQueue.main.async {
            if let url { PushCoordinator.shared.open(url) }
            completionHandler()
        }
    }

    /// The server's payload carries {"obligations": {"kind", "url", "id"}}. Only
    /// `url` matters here; the page it names is where the rest is shown.
    nonisolated static func url(from userInfo: [AnyHashable: Any]) -> URL? {
        guard let vault = userInfo["obligations"] as? [String: Any],
              let path = vault["url"] as? String else { return nil }
        return ObligationsConfig.resolve(path)
    }

    func open(_ url: URL) {
        Log.write("push opened \(url.path)\(url.fragment.map { "#\($0)" } ?? "")")
        if WebController.exists {
            WebController.shared.load(url)
        } else {
            pendingURL = url
        }
    }
}
