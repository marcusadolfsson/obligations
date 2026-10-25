import Foundation
import os

/// One line per thing that happened, to the unified log and to a short
/// in-memory tail the Mac's status window shows. Console.app filter:
/// subsystem com.example.obligations.app.
@MainActor
final class Log: ObservableObject {
    static let shared = Log()
    @Published private(set) var lines: [String] = []

    nonisolated private static let logger = Logger(subsystem: ObligationsConfig.bundleID, category: "app")
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    nonisolated static func write(_ message: String) {
        logger.notice("\(message, privacy: .public)")
        Task { @MainActor in
            shared.lines.append("\(stamp.string(from: Date()))  \(message)")
            if shared.lines.count > 200 { shared.lines.removeFirst(shared.lines.count - 200) }
        }
    }
}
