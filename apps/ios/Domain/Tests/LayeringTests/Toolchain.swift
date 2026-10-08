import Foundation
import SwiftParser
import SwiftSyntax

enum Checkout {
  static let iosRoot: URL = {
    var directory = URL(fileURLWithPath: #filePath)
    while Array(directory.pathComponents.suffix(2)) != ["apps", "ios"] {
      precondition(directory.pathComponents.count > 1, "LayeringTests lives under apps/ios")
      directory.deleteLastPathComponent()
    }
    return directory
  }()
  static let repositoryRoot = iosRoot.deletingLastPathComponent().deletingLastPathComponent()
  static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures")
}

extension URL {
  // The path below `base`, with every directory on the way resolved but a link at the end kept as the link.
  func relativePath(from base: URL) -> String {
    let path = deletingLastPathComponent().resolvingSymlinksInPath().pathComponents + [lastPathComponent]
    let prefix = base.resolvingSymlinksInPath().pathComponents
    let shared = zip(path, prefix).prefix { $0 == $1 }.count
    return (Array(repeating: "..", count: prefix.count - shared) + path.dropFirst(shared)).joined(separator: "/")
  }
}

// The build this test bundle came from: its compiler, the PackageDescription API manifests compile against, its remote packages.
struct RunningBuild: Sendable {
  let compilerVersion: String
  let packageDescriptionNames: Set<String>
  let remotePackages: [String: PackageDump]

  static let current = Result { try RunningBuild.read() }

  static func read() throws -> RunningBuild {
    RunningBuild(
      compilerVersion: try compilerVersion(),
      packageDescriptionNames: try packageDescriptionNames(),
      remotePackages: try remotePackages(of: try scratchDirectory()))
  }

  static func compilerVersion() throws -> String {
    let banner = try Shell.run(["swift", "--version"])
    guard let match = banner.firstMatch(of: /Swift version (\d+\.\d+(\.\d+)?)/) else { throw Unreadable("swift --version", banner) }
    return String(match.1)
  }

  static func packageDescriptionNames() throws -> Set<String> {
    let info = try JSONDecoder().decode(TargetInfo.self, from: Data(try Shell.run(["swift", "-print-target-info"]).utf8))
    let module = URL(fileURLWithPath: info.paths.runtimeResourcePath).appending(path: "pm/ManifestAPI/PackageDescription.swiftmodule")
    let interfaces = try FileManager.default.contentsOfDirectory(atPath: module.path).filter { $0.hasSuffix(".swiftinterface") }.sorted()
    guard let interface = interfaces.first else { throw Unreadable(module.path, "no .swiftinterface") }
    let names = DeclaredNames(viewMode: .sourceAccurate)
    names.walk(Parser.parse(source: try String(contentsOf: module.appending(path: interface), encoding: .utf8)))
    return names.found
  }

  static func scratchDirectory() throws -> URL {
    var directory = Bundle(for: BundleMarker.self).bundleURL
    while !FileManager.default.fileExists(atPath: directory.appending(path: "workspace-state.json").path) {
      guard directory.pathComponents.count > 1 else { throw Unreadable("the test bundle's scratch directory", "no workspace-state.json") }
      directory = directory.deletingLastPathComponent()
    }
    return directory
  }

  static func remotePackages(of scratch: URL) throws -> [String: PackageDump] {
    let state = try JSONDecoder().decode(WorkspaceState.self, from: Data(contentsOf: scratch.appending(path: "workspace-state.json")))
    let checkouts = state.object.dependencies.filter { $0.packageRef.kind == "remoteSourceControl" }
    return try Dictionary(uniqueKeysWithValues: checkouts.map { dependency in
      (dependency.packageRef.identity, try SwiftPM.dumpPackage(at: scratch.appending(path: "checkouts/\(dependency.subpath)")))
    })
  }

  private final class BundleMarker {}

  private struct TargetInfo: Decodable {
    struct Paths: Decodable { let runtimeResourcePath: String }
    let paths: Paths
  }

  private struct WorkspaceState: Decodable {
    struct Object: Decodable { let dependencies: [Dependency] }
    struct Dependency: Decodable {
      struct Reference: Decodable { let identity: String; let kind: String }
      let packageRef: Reference
      let subpath: String
    }
    let object: Object
  }

  private final class DeclaredNames: SyntaxVisitor {
    var found: Set<String> = []

    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: ProtocolDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: TypeAliasDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: AssociatedTypeDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: EnumCaseElementSyntax) -> SyntaxVisitorContinueKind { add(node.name) }
    override func visit(_ node: IdentifierPatternSyntax) -> SyntaxVisitorContinueKind { add(node.identifier) }
    override func visit(_ node: CodeBlockSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: AccessorBlockSyntax) -> SyntaxVisitorContinueKind { .skipChildren }

    func add(_ name: TokenSyntax) -> SyntaxVisitorContinueKind {
      let bare = name.text.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
      if bare.first.map({ $0.isLetter || $0 == "_" }) == true { found.insert(bare) }
      return .visitChildren
    }
  }
}

enum SwiftPM {
  static func dumpPackage(at directory: URL) throws -> PackageDump {
    try Scratch.withDirectory { scratch in
      let json = try Shell.run(["swift", "package", "--package-path", directory.path, "--scratch-path", scratch.path, "dump-package"])
      var dump = try JSONDecoder().decode(PackageDump.self, from: Data(json.utf8))
      for index in dump.dependencies.indices {
        if case .local(let path) = dump.dependencies[index].location {
          dump.dependencies[index].location = .local(URL(fileURLWithPath: path).relativePath(from: directory))
        }
      }
      return dump
    }
  }
}

enum Shell {
  static func run(_ command: [String]) throws -> String {
    try Scratch.withDirectory { scratch in
      let output = scratch.appending(path: "stdout"), errors = scratch.appending(path: "stderr")
      FileManager.default.createFile(atPath: output.path, contents: nil)
      FileManager.default.createFile(atPath: errors.path, contents: nil)
      let outputHandle = try FileHandle(forWritingTo: output), errorHandle = try FileHandle(forWritingTo: errors)
      defer { try? outputHandle.close(); try? errorHandle.close() }
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = command
      process.standardOutput = outputHandle
      process.standardError = errorHandle
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        throw CommandFailed(command: command, status: process.terminationStatus, errors: try String(contentsOf: errors, encoding: .utf8))
      }
      return try String(contentsOf: output, encoding: .utf8)
    }
  }

  // A test runs its tools on a thread of its own, so waiting on a process leaves Swift Testing's threads to other tests.
  static func offThePool<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(with: Result(catching: body)) }
    }
  }

  static func isInstalled(_ tool: String) -> Bool {
    (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").contains { directory in
      FileManager.default.isExecutableFile(atPath: "\(directory)/\(tool)")
    }
  }
}

enum Scratch {
  static func withDirectory<T>(_ body: (URL) throws -> T) throws -> T {
    let temporaryDirectory = ProcessInfo.processInfo.environment["TMPDIR"]
      .flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil }
      ?? FileManager.default.temporaryDirectory
    let directory = temporaryDirectory.appending(path: "layering-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    return try body(directory)
  }
}

struct CommandFailed: Error, CustomStringConvertible {
  let command: [String]
  let status: Int32
  let errors: String

  var description: String { "\(command.joined(separator: " ")) exited \(status): \(errors)" }
}

struct Unreadable: Error, CustomStringConvertible {
  let what: String
  let why: String

  init(_ what: String, _ why: String) {
    self.what = what
    self.why = why
  }

  var description: String { "cannot read \(what): \(why)" }
}
