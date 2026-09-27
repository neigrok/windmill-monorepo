import Foundation
import Synchronization

// §2.1: the packages, closed: where each lives, the packages it may depend on and who may use them, the modules it holds.
struct PackagePlacement: Sendable {
  enum Use: Sendable {
    case any
    case onlyByTarget(String)
    case onlyProduct(String)
  }

  let name: String
  let directory: String
  let dependencies: [String: Use]
  let modules: Set<String>

  var manifestPath: String { "\(directory)/Package.swift" }

  static let all = [
    PackagePlacement(
      name: "WindmillSync", directory: "Sync", dependencies: ["grdb.swift": .onlyByTarget("SyncStore")],
      modules: [
        "SyncCore", "SyncAPI", "SyncSchema", "SyncReplica", "SyncStore", "SyncModelServer", "SyncEngine", "SyncIOS", "SyncSchemaGen",
        "SyncTesting",
      ]),
    PackagePlacement(
      name: "WindmillDomain", directory: "Domain", dependencies: ["Sync": .any, "swift-syntax": .onlyByTarget("LayeringTests")],
      modules: ["DomainKitNFC", "DomainKit", "DomainKitTesting", "GymDomain", "JournalDomain"]),
    PackagePlacement(
      name: "WindmillKit", directory: "WindmillKit", dependencies: ["Domain": .any, "Sync": .any],
      modules: ["WindmillPlatform", "WindmillGym", "WindmillJournal"]),
    PackagePlacement(
      name: "SyncTestingSurface", directory: "SyncTestingSurface", dependencies: ["Sync": .onlyProduct("SyncTesting")], modules: []),
  ]

  static let executables: Set<String> = ["SyncSchemaGen"]

  static func kind(of module: String) -> String { executables.contains(module) ? "executable" : "regular" }
}

// The iOS tree as the build resolves it: its paths but build state, and each §2.1 package's manifest, dump and sources.
struct World: Sendable {
  let root: URL
  let tree: FileTree
  let packages: [LocalPackage]
  let build: RunningBuild

  static func read(root: URL, build: RunningBuild) throws -> World {
    let tree = try FileTree.read(root)
    let packages = try PackagePlacement.all
      .filter { tree.entries[$0.manifestPath] == .file }
      .map { try LocalPackage.read($0, root: root, tree: tree) }
    return World(root: root, tree: tree, packages: packages, build: build)
  }

  // Where a package dependency lives: a local package's directory under the root, or a remote package's identity.
  func location(of dependency: PackageDependency, from package: LocalPackage) -> String {
    switch dependency.location {
    case .local(let path): root.appending(path: "\(package.placement.directory)/\(path)").standardized.relativePath(from: root)
    case .remote: dependency.identity
    }
  }

  func manifest(of dependency: PackageDependency, from package: LocalPackage) -> PackageDump? {
    switch dependency.location {
    case .local: packages.first { $0.placement.directory == location(of: dependency, from: package) }?.manifest
    case .remote: build.remotePackages[dependency.identity]
    }
  }

  // §2.2: a dependency on a library product counts as a dependency on every target the product bundles.
  func modules(of dependency: TargetDependency, in package: LocalPackage) -> [String] {
    switch dependency {
    case .target(let name): return [name]
    case .byName(let name):
      if package.manifest.targets.contains(where: { $0.name == name }) { return [name] }
      let bundling = package.manifest.dependencies.compactMap { manifest(of: $0, from: package)?.products.first { $0.name == name } }.first
      return bundling?.targets ?? [name]
    case .product(let name, let packageName):
      let owner = package.manifest.dependencies.first { $0.identity == packageName?.lowercased() }
      return owner.flatMap { manifest(of: $0, from: package)?.products.first { $0.name == name }?.targets } ?? [name]
    }
  }

  func dependencies(of target: PackageDump.Target, in package: LocalPackage) -> [String] {
    target.dependencies.flatMap { modules(of: $0, in: package) }
  }

  func productOwner(of dependency: TargetDependency, in package: LocalPackage) -> (package: String, product: String)? {
    guard case .product(let name, let packageName) = dependency,
      let owner = package.manifest.dependencies.first(where: { $0.identity == packageName?.lowercased() })
    else { return nil }
    return (location(of: owner, from: package), name)
  }

  // §2.3: a package module is a module of a package here or of a remote package they resolve.
  var packageModules: Set<String> {
    let remote = packages.flatMap(\.manifest.dependencies).compactMap { build.remotePackages[$0.identity] }
    return Set((packages.map(\.manifest) + remote).flatMap(\.targets).filter { !$0.isTest }.map(\.name))
  }
}

struct LocalPackage: Sendable {
  let placement: PackagePlacement
  let manifestSource: String
  let manifest: PackageDump
  let sources: [String: [SourceFile]]

  static func read(_ placement: PackagePlacement, root: URL, tree: FileTree) throws -> LocalPackage {
    let manifests = try tree.manifests(in: placement.directory).map { path in
      "\(path)\n\(try String(contentsOf: root.appending(path: path), encoding: .utf8))"
    }
    let manifest = try ManifestDumps.shared.dump(root.appending(path: placement.directory), manifests: manifests.joined(separator: "\n"))
    let modules = manifest.targets.filter { !$0.isTest }
    let sources = try modules.map { target in
      try tree.sourceFiles(of: target, in: placement.directory).map { path in
        SourceFile(path: path, text: try String(contentsOf: root.appending(path: path), encoding: .utf8))
      }
    }
    return LocalPackage(
      placement: placement,
      manifestSource: try String(contentsOf: root.appending(path: placement.manifestPath), encoding: .utf8),
      manifest: manifest,
      sources: Dictionary(zip(modules.map(\.name), sources)) { first, _ in first })
  }
}

// Fixture worlds share most manifests: each manifest text is dumped once per run, and a second reader waits for the first.
final class ManifestDumps: Sendable {
  static let shared = ManifestDumps()

  private let entries = Mutex<[String: Entry]>([:])

  func dump(_ directory: URL, manifests: String) throws -> PackageDump {
    let entry = entries.withLock { entries in
      if let entry = entries[manifests] { return entry }
      let entry = Entry()
      entries[manifests] = entry
      return entry
    }
    return try entry.dump.withLock { dump in
      if let dump { return dump }
      let dumped = try SwiftPM.dumpPackage(at: directory)
      dump = dumped
      return dumped
    }
  }

  private final class Entry: Sendable {
    let dump = Mutex<PackageDump?>(nil)
  }
}

struct SourceFile: Sendable {
  let path: String
  let text: String
}

struct FileTree: Sendable {
  enum Kind: Sendable {
    case file
    case directory
    case symbolicLink
  }

  let entries: [String: Kind]

  static func read(_ root: URL) throws -> FileTree {
    let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey]
    guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else {
      throw Unreadable(root.path, "not a directory")
    }
    var entries: [String: Kind] = [:]
    for case let url as URL in walk {
      if isBuildState(url.lastPathComponent) { walk.skipDescendants(); continue }
      let values = try url.resourceValues(forKeys: Set(keys))
      entries[url.relativePath(from: root)] = values.isSymbolicLink == true ? .symbolicLink : values.isDirectory == true ? .directory : .file
    }
    return FileTree(entries: entries)
  }

  static func isBuildState(_ name: String) -> Bool { name == ".build" || name == ".swiftpm" || name.hasSuffix(".xcodeproj") }

  // A package's manifests: Package.swift and any version-specific Package@swift-*.swift beside it.
  func manifests(in package: String) -> [String] {
    entries.keys.filter { path in
      let name = String(path.dropFirst(package.count + 1))
      let manifest = name == "Package.swift" || name.hasPrefix("Package@swift") && name.hasSuffix(".swift")
      return path.hasPrefix("\(package)/") && !name.contains("/") && manifest
    }.sorted()
  }

  // The Swift files SwiftPM compiles into a target: under its path, within `sources` if given, outside `exclude`. SwiftPM
  // reads a file's extension without its case, so `Clock.Swift` compiles as Swift.
  func sourceFiles(of target: PackageDump.Target, in package: String) -> [String] {
    let root = "\(package)/\(target.path ?? "Sources/\(target.name)")".trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let included = target.sources.map { $0.map { "\(root)/\($0)" } } ?? [root]
    let excluded = target.exclude.map { "\(root)/\($0)" }
    func within(_ path: String, _ roots: [String]) -> Bool { roots.contains { path == $0 || path.hasPrefix("\($0)/") } }
    return entries.filter { path, kind in
      kind == .file && path.lowercased().hasSuffix(".swift") && within(path, included) && !within(path, excluded)
    }.keys.sorted()
  }
}
