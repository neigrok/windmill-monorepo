// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WindmillKit",
    // iOS only: build and test with xcodebuild against a simulator.
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
        .testTarget(name: "WindmillRoadmapTests", dependencies: ["WindmillRoadmap"]),
        .testTarget(name: "WindmillJournalTests", dependencies: ["WindmillJournal"]),
        .testTarget(name: "WindmillGymTests", dependencies: ["WindmillGym"]),
    ]
)
