// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "SyncTestingSurface",
  platforms: [.iOS(.v18), .macOS(.v15)],
  dependencies: [.package(path: "../Sync")],
  targets: [
    .testTarget(name: "SyncTestingSurfaceTests", dependencies: [.product(name: "SyncTesting", package: "Sync")]),
  ],
  swiftLanguageModes: [.v6]
)
