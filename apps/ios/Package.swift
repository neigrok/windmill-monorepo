// swift-tools-version:5.9
import PackageDescription

// The Windmill iOS superapp as a Swift package: one app target mounting three product module
// libraries (roadmap / notes / gym) over a shared WindmillPlatform — the native mirror of web/
// (shell + design-system + products). Modules stay independently mountable; the app is the only
// thing that knows all three exist. Builds and tests today with `swift build && swift test` — the
// gym ladder is pinned to packages/api-contract/gym-ladder.json, the golden its web twin also
// runs. The SwiftUI/Xcode app wrapper (Info.plist, asset catalog, entitlements) is the next wave.
let package = Package(
    name: "Windmill",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .executable(name: "Windmill", targets: ["Windmill"]),
        .library(name: "WindmillPlatform", targets: ["WindmillPlatform"]),
    ],
    targets: [
        .target(name: "WindmillPlatform"),
        .target(name: "WindmillRoadmap", dependencies: ["WindmillPlatform"]),
        .target(name: "WindmillNotes", dependencies: ["WindmillPlatform"]),
        .target(name: "WindmillGym", dependencies: ["WindmillPlatform"]),
        .executableTarget(
            name: "Windmill",
            dependencies: ["WindmillPlatform", "WindmillRoadmap", "WindmillNotes", "WindmillGym"]
        ),
        .testTarget(name: "WindmillGymTests", dependencies: ["WindmillGym"]),
    ]
)
