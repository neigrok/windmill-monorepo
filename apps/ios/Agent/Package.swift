// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "WindmillAgent", platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "Agent", targets: ["Agent"])],
  dependencies: [.package(path: "../Sync")],
  targets: [
    .target(name: "Agent", dependencies: [.product(name: "SyncCore", package: "Sync")],
            swiftSettings: [.enableUpcomingFeature("MemberImportVisibility")]),
    .testTarget(name: "AgentTests", dependencies: ["Agent", .product(name: "SyncCore", package: "Sync")]),
  ], swiftLanguageModes: [.v6])
