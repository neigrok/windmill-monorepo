// swift-tools-version: 6.2
import PackageDescription

let platformSettings: [SwiftSetting] = [
  .defaultIsolation(MainActor.self), .treatAllWarnings(as: .error), .treatWarning("DeprecatedDeclaration", as: .warning),
]

let package = Package(
  name: "WindmillKit", platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "WindmillPlatform", targets: ["WindmillPlatform"])],
  dependencies: [.package(path: "../Agent"), .package(path: "../Sync")],
  targets: [
    .target(name: "WindmillPlatform", dependencies: [.product(name: "Agent", package: "Agent"),
      .product(name: "SyncCore", package: "Sync"), .product(name: "SyncAPI", package: "Sync"),
      .product(name: "SyncEngine", package: "Sync")], swiftSettings: platformSettings),
    .testTarget(name: "WindmillPlatformTests", dependencies: ["WindmillPlatform", .product(name: "Agent", package: "Agent"),
      .product(name: "SyncCore", package: "Sync"), .product(name: "SyncAPI", package: "Sync"),
      .product(name: "SyncTesting", package: "Sync"), .product(name: "SyncModelServer", package: "Sync")]),
  ], swiftLanguageModes: [.v6])
