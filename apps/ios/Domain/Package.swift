// swift-tools-version: 6.2
import PackageDescription

let memberImportVisibility: [SwiftSetting] = [.enableUpcomingFeature("MemberImportVisibility")]
let syncCore: Target.Dependency = .product(name: "SyncCore", package: "Sync")
let syncAPI: Target.Dependency = .product(name: "SyncAPI", package: "Sync")
let syncEngine: Target.Dependency = .product(name: "SyncEngine", package: "Sync")
let syncTesting: Target.Dependency = .product(name: "SyncTesting", package: "Sync")

let package = Package(
  name: "WindmillDomain",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "DomainKit", targets: ["DomainKit"]),
    .library(name: "DomainKitTesting", targets: ["DomainKitTesting"]),
  ],
  dependencies: [
    .package(path: "../Sync"),
    .package(url: "https://github.com/swiftlang/swift-syntax.git", exact: "602.0.0"),
  ],
  targets: [
    .target(name: "DomainKitNFC"),
    .target(name: "DomainKit", dependencies: ["DomainKitNFC", syncCore, syncAPI], swiftSettings: memberImportVisibility),
    .target(name: "DomainKitTesting", dependencies: ["DomainKit", syncCore, syncAPI, syncEngine, syncTesting]),
    .testTarget(name: "DomainKitTests", dependencies: ["DomainKit", syncCore, syncAPI, syncTesting], exclude: ["Attacks"]),
    .testTarget(
      name: "DomainKitTestingTests",
      dependencies: [
        "DomainKit", "DomainKitTesting", syncCore, syncAPI, syncTesting,
        .product(name: "SyncReplica", package: "Sync"), .product(name: "SyncModelServer", package: "Sync"),
      ]),
    .testTarget(
      name: "LayeringTests",
      dependencies: [.product(name: "SwiftParser", package: "swift-syntax"), .product(name: "SwiftSyntax", package: "swift-syntax")],
      exclude: ["Fixtures"]),
  ],
  swiftLanguageModes: [.v6]
)
