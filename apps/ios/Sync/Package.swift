// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "WindmillSync",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "SyncCore", targets: ["SyncCore"]),
    .library(name: "SyncTesting", targets: ["SyncTesting"]),
  ],
  targets: [
    .target(name: "SyncCore"),
    .target(name: "SyncTesting", dependencies: ["SyncCore"]),
    .testTarget(name: "SyncCoreTests", dependencies: ["SyncCore", "SyncTesting"]),
    .testTarget(name: "SyncConformanceTests", dependencies: ["SyncCore", "SyncTesting"]),
  ],
  swiftLanguageModes: [.v6]
)
