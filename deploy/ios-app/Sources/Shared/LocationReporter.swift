import CoreLocation
import Foundation
import WebKit
#if canImport(UIKit)
import UIKit
#endif

/// Tells the assistant where Alex is, sparingly.
///
/// Alex, 2026-09-06: "send a location every so often … helpful for the
/// repo to understand where Alex is and where he has been."
///
/// Sparingly means: the OS decides when. iOS's significant-change service
/// (a fix when he moves roughly 500 m, at most every few minutes) and visit
/// detection (arrival at and departure from a place he stayed) — a handful to
/// a few dozen points a day, and nothing at all while he sits still. Plus one
/// fix at launch, so opening the app answers "where is he now". No timer, no
/// continuous tracking; there is no code path here that asks for location
/// more often than the system offers it.
///
/// The privacy line is that the *phone* names the place. Reverse geocoding
/// runs on the device and the server receives "City Airport Airport" next
/// to the coordinate; the server never has to send a coordinate of his to
/// anyone to find out what it is.
///
/// Contract (Obligations-Dev-Server, 2026-09-06): POST /api/location with one point
/// {lat, lon, accuracy_m, at_ms, place, source, platform} or {points: [...]}
/// up to 200. at_ms is the fix time, not the send time. Repeats within a
/// minute and 15 m are dropped server-side, so resending on failure is safe.
@MainActor
final class LocationReporter: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationReporter()

    struct Point: Codable, Equatable {
        var lat: Double
        var lon: Double
        var accuracy_m: Double
        var at_ms: Int
        var place: String?
        var source: String
        var platform: String
    }

    @Published private(set) var authorization = "not asked"
    @Published private(set) var lastReport = "nothing sent yet"
    @Published private(set) var queued = 0

    private let manager = CLLocationManager()
    private var began = false
    private var askedForAlways = false
    private var pendingSource: String?
    private var flushing = false

    /// Points not yet accepted by the server, on disk so a background wake
    /// that cannot reach the server still keeps its fix.
    private var queue: [Point] {
        didSet {
            queued = queue.count
            let data = try? JSONEncoder().encode(queue)
            UserDefaults.standard.set(data, forKey: "location.queue")
        }
    }

    private var lastPlace: (CLLocation, String)?

    override private init() {
        let data = UserDefaults.standard.data(forKey: "location.queue")
        queue = data.flatMap { try? JSONDecoder().decode([Point].self, from: $0) } ?? []
        super.init()
        queued = queue.count
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// Called at every launch — including the background relaunch iOS does
    /// for a significant-change or visit event, where recreating the
    /// manager and re-starting monitoring is how the event gets delivered.
    func start() {
        authorize()
    }

    /// One fix now, tagged with why. "launch" at start, "manual" from the
    /// Mac menu or the page's `window.obligationsApp.sendLocation()`.
    func requestOnce(source: String) {
        guard began else { return }
        pendingSource = source
        manager.requestLocation()
    }

    // MARK: - Authorization

    private func authorize() {
        switch manager.authorizationStatus {
        case .notDetermined:
            authorization = "asking"
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            authorization = "while using"
            #if os(iOS)
            // Significant changes and visits only arrive in the background
            // with Always. Ask once; if he says no, the app still reports a
            // fix each time it is opened.
            if !askedForAlways {
                askedForAlways = true
                manager.requestAlwaysAuthorization()
            }
            #endif
            begin()
        case .authorizedAlways:
            authorization = "always"
            begin()
        case .denied, .restricted:
            authorization = "denied"
        @unknown default:
            authorization = "unknown"
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.authorize() }
    }

    private func begin() {
        guard !began else { return }
        began = true
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }
        #if os(iOS)
        manager.startMonitoringVisits()
        #endif
        Log.write("location: monitoring started (\(authorization))")
        requestOnce(source: "launch")
        Task { await flush() }
    }

    // MARK: - Fixes

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            let source = self.pendingSource ?? "significant"
            self.pendingSource = nil
            await self.record(location, source: source)
        }
    }

    #if os(iOS)
    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        // A visit is reported twice: on arrival (departure unknown) and again
        // on departure. Each becomes a point stamped with the latest known
        // time, so the server sees when he got there and when he left.
        let at = visit.departureDate == .distantFuture ? visit.arrivalDate : visit.departureDate
        let location = CLLocation(coordinate: visit.coordinate, altitude: 0,
                                  horizontalAccuracy: visit.horizontalAccuracy, verticalAccuracy: -1,
                                  timestamp: at == .distantPast ? Date() : at)
        Task { @MainActor in await self.record(location, source: "visit") }
    }
    #endif

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Log.write("location: \(error.localizedDescription)")
        Task { @MainActor in self.pendingSource = nil }
    }

    private func record(_ location: CLLocation, source: String) async {
        guard location.horizontalAccuracy >= 0 else { return }
        let done = beginBackgroundWork()
        defer { done() }
        let place = await placeName(for: location)
        let point = Point(lat: location.coordinate.latitude, lon: location.coordinate.longitude,
                          accuracy_m: location.horizontalAccuracy,
                          at_ms: Int(location.timestamp.timeIntervalSince1970 * 1000),
                          place: place, source: source, platform: ObligationsConfig.platform)
        queue.append(point)
        if queue.count > 200 { queue.removeFirst(queue.count - 200) }
        Log.write("location: \(source) \(place ?? "?") ±\(Int(location.horizontalAccuracy))m")
        await flush()
    }

    /// The device names the place. Prefer a point of interest, then what
    /// the geocoder calls the spot, then the town. Cached for the last spot
    /// so a visit's arrival and departure do not geocode twice.
    private func placeName(for location: CLLocation) async -> String? {
        if let (at, name) = lastPlace, at.distance(from: location) < 100 { return name }
        do {
            let marks = try await CLGeocoder().reverseGeocodeLocation(location)
            guard let mark = marks.first else { return nil }
            let name = mark.areasOfInterest?.first ?? mark.name ?? mark.locality ?? mark.administrativeArea
            if let name { lastPlace = (location, name) }
            return name
        } catch {
            Log.write("location: geocode failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Sending

    /// POST whatever is queued, natively. Unlike device registration this
    /// cannot go through the page: the OS wakes the app in the background
    /// with no web view loaded. So the request carries the assistant's cookies
    /// copied out of the web view's store — the same Access session, sent
    /// by URLSession instead of fetch().
    func flush() async {
        guard !flushing, !queue.isEmpty else { return }
        flushing = true
        defer { flushing = false }

        guard let cookie = await obligationsCookieHeader() else {
            lastReport = "waiting for sign-in (\(queue.count) queued)"
            return
        }
        let batch = Array(queue.prefix(200))
        var request = URLRequest(url: ObligationsConfig.origin.appendingPathComponent("api/location"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 20
        request.httpBody = try? JSONEncoder().encode(["points": batch])

        do {
            let (data, response) = try await Self.session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data.prefix(200), encoding: .utf8) ?? ""
            switch status {
            case 200..<300:
                queue.removeFirst(batch.count)
                let count = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["count"] as? Int
                lastReport = "\(batch.count) sent \(Date().formatted(date: .omitted, time: .shortened))"
                    + (count.map { ", server has \($0)" } ?? "")
                Log.write("location: posted \(batch.count) point(s), HTTP \(status) \(text)")
            case 400:
                // The server named a bad field; resending the same batch
                // would fail the same way forever. Drop it and say so.
                queue.removeFirst(batch.count)
                lastReport = "rejected: \(text)"
                Log.write("location: rejected, dropped \(batch.count): \(text)")
            case 401, 403:
                lastReport = "not signed in (\(queue.count) queued)"
                Log.write("location: HTTP \(status), keeping \(queue.count)")
            default:
                lastReport = "HTTP \(status) (\(queue.count) queued)"
                Log.write("location: HTTP \(status) \(text), keeping \(queue.count)")
            }
        } catch {
            lastReport = "\(error.localizedDescription) (\(queue.count) queued)"
            Log.write("location: \(error.localizedDescription), keeping \(queue.count)")
        }
    }

    /// GET /api/location's `now`, for the Mac status window.
    func fetchNow() async -> String {
        guard let cookie = await obligationsCookieHeader() else { return "not signed in" }
        var request = URLRequest(url: ObligationsConfig.origin.appendingPathComponent("api/location"))
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.httpShouldHandleCookies = false
        do {
            let (data, _) = try await Self.session.data(for: request)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let now = json["now"] as? [String: Any], let place = now["place"] as? String
            else { return "nothing recorded yet" }
            let since = now["since"] as? String ?? "?"
            let age = now["age_min"] as? Int
            return "at \(place) since \(since)" + (age.map { " (\($0) min ago)" } ?? "")
        } catch {
            return error.localizedDescription
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()

    private func obligationsCookieHeader() async -> String? {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        let ours = cookies.filter { ObligationsConfig.host.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
        guard ours.contains(where: { $0.name.hasPrefix("CF_Authorization") }) else { return nil }
        return ours.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    /// On iOS a wake for a location event gives the app seconds. Asking for
    /// a background task stretches that to cover a geocode and a POST.
    private func beginBackgroundWork() -> () -> Void {
        #if os(iOS)
        var id = UIBackgroundTaskIdentifier.invalid
        id = UIApplication.shared.beginBackgroundTask(withName: "location") {
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
        return {
            if id != .invalid { UIApplication.shared.endBackgroundTask(id); id = .invalid }
        }
        #else
        return {}
        #endif
    }
}
