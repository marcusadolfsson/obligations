// swift-tools-version:5.9
import PackageDescription

// SwiftPM builds the executable; build.sh assembles it into Obligations.app.
//
// Deliberately not an Xcode project: the thing that needs to be reproducible is
// the bundle layout and the signature, and a .xcodeproj is a large binary-ish
// file to review in a repo whose whole point is that its history is readable.
let package = Package(
    name: "Obligations",
    platforms: [.macOS(.v13)],          // MenuBarExtra and SMAppService
    targets: [
        .executableTarget(
            name: "Obligations",
            path: "Sources/Obligations"
        )
    ]
)
