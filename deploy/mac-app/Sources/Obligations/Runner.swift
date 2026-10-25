import Foundation

/// Running a subprocess and getting all three of its answers back.
///
/// Every failure this app can have that is not a permissions failure comes out
/// of here, so it captures stdout, stderr and the exit status rather than any
/// two of them. The scripts it runs are careful to say why they failed on
/// stderr; throwing that away and reporting "exit 1" is how a Mac agent ends up
/// with a diagnosis nobody can act on.
struct Runner {

    struct Result {
        let status: Int32
        let stdout: String
        let stderr: String

        var ok: Bool { status == 0 }

        /// The most useful line to show a human, shortest first.
        var problem: String {
            let err = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if !err.isEmpty { return err.split(separator: "\n").last.map(String.init) ?? err }
            let out = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if !out.isEmpty { return out.split(separator: "\n").last.map(String.init) ?? out }
            return "exited \(status) with no output"
        }
    }

    enum Failure: Error, LocalizedError {
        case launch(String)
        case timedOut(TimeInterval)

        var errorDescription: String? {
            switch self {
            case .launch(let why): return why
            case .timedOut(let s): return "gave up after \(Int(s))s"
            }
        }
    }

    /// Run to completion. Blocking — callers are on a background queue.
    ///
    /// The timeout is not optional and there is no unbounded overload: a sync
    /// that hangs holds the serial queue, and then nothing syncs again until
    /// the app is restarted. A wedged `scp` to an unreachable host is the
    /// obvious way in.
    static func run(_ launchPath: String,
                    _ arguments: [String],
                    timeout: TimeInterval = 120,
                    environment: [String: String]? = nil) throws -> Result {

        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        if let environment {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        }

        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err

        // Read both pipes on background queues while the process runs. Reading
        // after waitUntilExit deadlocks the moment a script writes more than a
        // pipe buffer, which the contacts extractor (1085 people) does easily.
        var outData = Data(), errData = Data()
        let lock = NSLock()
        let group = DispatchGroup()
        for (pipe, isOut) in [(out, true), (err, false)] {
            group.enter()
            DispatchQueue.global().async {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                lock.lock()
                if isOut { outData = data } else { errData = data }
                lock.unlock()
                group.leave()
            }
        }

        do {
            try process.run()
        } catch {
            throw Failure.launch("could not run \(launchPath): \(error.localizedDescription)")
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            _ = group.wait(timeout: .now() + 2)
            throw Failure.timedOut(timeout)
        }
        process.waitUntilExit()
        _ = group.wait(timeout: .now() + 5)

        lock.lock()
        defer { lock.unlock() }
        return Result(status: process.terminationStatus,
                      stdout: String(decoding: outData, as: UTF8.self),
                      stderr: String(decoding: errData, as: UTF8.self))
    }
}
