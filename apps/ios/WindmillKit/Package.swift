// swift-tools-version:5.9
import PackageDescription

// WindmillKit — every line of the native superapp that isn't the app bundle itself: one shared
// WindmillPlatform (account, wire, chrome) and one library per product, mounted by the app target
// next door in apps/ios/App. It is a package rather than a folder of app sources so the module
// boundary is enforced by the compiler, not by a convention: WindmillJournal cannot reach into
// WindmillGym because it does not depend on it, which is STRUCTURE.md's one rule stated as a build
// graph. `swift build && swift test` runs the whole thing without Xcode, which is what CI does.
let package = Package(
    name: "WindmillKit",
    // iOS only, deliberately. The UI uses modifiers that exist nowhere else (the tab-bar toolbar
    // background, keyboard types, navigation-bar title modes), and making it also compile for a Mac
    // it will never run on would cost a scatter of #if os(iOS) through the view code and buy
    // nothing. Build and test with xcodebuild against a simulator — see README.
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "WindmillPlatform", targets: ["WindmillPlatform"]),
        .library(name: "WindmillJournal", targets: ["WindmillJournal"]),
        .library(name: "WindmillRoadmap", targets: ["WindmillRoadmap"]),
        .library(name: "WindmillGym", targets: ["WindmillGym"]),
    ],
    targets: [
        .target(name: "WindmillPlatform"),
        .target(name: "WindmillRoadmap", dependencies: ["WindmillPlatform"]),
        .target(name: "WindmillJournal", dependencies: ["WindmillPlatform"]),
        .target(name: "WindmillGym", dependencies: ["WindmillPlatform"]),
        .testTarget(name: "WindmillPlatformTests", dependencies: ["WindmillPlatform"]),
        .testTarget(name: "WindmillJournalTests", dependencies: ["WindmillJournal"]),
        .testTarget(name: "WindmillGymTests", dependencies: ["WindmillGym"]),
    ]
)
