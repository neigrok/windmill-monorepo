// swift-tools-version: 6.2
import PackageDescription

// The engine-API targets, which domain packages compile against, follow the domain kit's source rules (ER-13).
let engineAPI: [SwiftSetting] = [.enableUpcomingFeature("MemberImportVisibility")]

let package = Package(
  name: "WindmillSync",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "SyncCore", targets: ["SyncCore"]),
    .library(name: "SyncAPI", targets: ["SyncAPI"]),
    .library(name: "SyncSchema", targets: ["SyncSchema"]),
    .library(name: "SyncReplica", targets: ["SyncReplica"]),
    .library(name: "SyncStore", targets: ["SyncStore"]),
    .library(name: "SyncEngine", targets: ["SyncEngine"]),
    .library(name: "SyncModelServer", targets: ["SyncModelServer"]),
    .library(name: "SyncTesting", targets: ["SyncTesting"]),
  ],
  dependencies: [.package(url: "https://github.com/groue/GRDB.swift", from: "7.0.0")],
  targets: [
    .target(name: "SyncCore", swiftSettings: engineAPI),
    .target(name: "SyncAPI", dependencies: ["SyncCore"], swiftSettings: engineAPI),
    .target(name: "SyncSchema", dependencies: ["SyncCore"], swiftSettings: engineAPI),
    .executableTarget(name: "SyncSchemaGen", dependencies: ["SyncCore"]),
    .target(name: "SyncReplica", dependencies: ["SyncCore", "SyncAPI"]),
    .target(name: "SyncStore", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", .product(name: "GRDB", package: "GRDB.swift")]),
    .target(name: "SyncEngine", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore"]),
    .target(name: "SyncModelServer", dependencies: ["SyncCore"]),
    .target(name: "SyncTesting", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore", "SyncEngine", "SyncModelServer"]),
    .testTarget(name: "SyncCoreTests", dependencies: ["SyncCore", "SyncTesting"]),
    .testTarget(name: "SyncAPITests", dependencies: ["SyncCore", "SyncAPI"]),
    .testTarget(name: "SyncSchemaTests", dependencies: ["SyncCore", "SyncSchema", "SyncTesting"]),
    .testTarget(name: "SyncSchemaGenTests", dependencies: ["SyncCore", "SyncSchemaGen"]),
    .testTarget(name: "SyncReplicaTests", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncModelServer", "SyncTesting"]),
    .testTarget(name: "SyncStoreTests", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore", "SyncTesting"]),
    .testTarget(name: "SyncEngineTests", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore", "SyncEngine", "SyncModelServer", "SyncTesting"]),
    .testTarget(name: "SyncModelServerTests", dependencies: ["SyncCore", "SyncModelServer", "SyncTesting"]),
    .testTarget(name: "SyncConformanceTests", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncModelServer", "SyncTesting"]),
    .testTarget(name: "SyncTestingTests", dependencies: ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore", "SyncEngine", "SyncModelServer", "SyncTesting"]),
  ],
  swiftLanguageModes: [.v6]
)
