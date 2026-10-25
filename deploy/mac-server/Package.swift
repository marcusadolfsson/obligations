// swift-tools-version:5.9
import PackageDescription

// Obligations Server.app: a headless bundle whose only job is to give the assistant
// server its own identity on the Mac mini — one with no privacy grants — and
// to start it inside the Seatbelt profile. It has no UI. Obligations.app drives it.
//
// Why a separate bundle and not a helper inside Obligations.app: macOS attributes a
// process to the app bundle its executable lives in. A launchd agent whose
// program sat inside Obligations.app would be Obligations.app as far as TCC is concerned —
// Full Disk Access, Contacts, Reminders, and permission to drive Messages.
let package = Package(
    name: "ObligationsServer",
    platforms: [.macOS(.v13)],          // SMAppService.agent
    targets: [
        .executableTarget(
            name: "ObligationsServer",
            path: "Sources/ObligationsServer"
        )
    ]
)
