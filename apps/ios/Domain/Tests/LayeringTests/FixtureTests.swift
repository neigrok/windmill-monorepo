import Foundation
import Testing

// Every rule against its fixtures: each finding it must report, and the controls it must pass.
@Suite struct FixtureTests {
  @Test(arguments: try SourceFixture.all())
  func sourceFixture(_ fixture: SourceFixture) {
    let rules = ModuleSourceRules(module: fixture.module, declaredDependencies: [], packageModules: [])
    #expect(rules.findings(in: fixture.text, file: fixture.name).sorted().map(\.withoutFile) == fixture.expected)
  }

  @Test(arguments: try WorldCase.all())
  func worldCase(_ worldCase: WorldCase) async throws {
    let findings = try await Shell.offThePool {
      try Scratch.withDirectory { root in
        try worldCase.materialize(into: root)
        return Layering.findings(in: try World.read(root: root, build: try RunningBuild.current.get()))
      }
    }
    #expect(findings.map(\.description) == worldCase.expected)
  }

  @Test(arguments: try WorkflowCase.all())
  func workflowCase(_ workflowCase: WorkflowCase) throws {
    #expect(try Workflows.findings(in: workflowCase.directory).sorted().map(\.description) == workflowCase.expected)
  }

  @Test(.enabled(if: Shell.isInstalled("xcodegen"), "XcodeGen is installed"), arguments: try AppCase.all())
  func appCase(_ appCase: AppCase) async throws {
    let findings = try await Shell.offThePool {
      try Scratch.withDirectory { root in
        try Fixture.copy(Checkout.fixtures.appending(path: "Apps"), into: root)
        return try AppProject.findings(root: root, spec: appCase.spec)
      }
    }
    #expect(findings.sorted().map(\.withoutFile) == appCase.expected)
  }

  @Test(arguments: [
    ("602.0.0", "6.2.4", [String]()),
    ("602.0.0", "6.2", []),
    ("601.0.1", "6.2.4", ["Package.resolved: parser-version swift-syntax 601.0.1 for Swift 6.2.4 (602)"]),
    ("603.0.0", "6.2.4", ["Package.resolved: parser-version swift-syntax 603.0.0 for Swift 6.2.4 (602)"]),
  ])
  func parserVersion(pinned: String, compiler: String, expected: [String]) {
    let resolved = #"{"pins": [{"identity": "swift-syntax", "state": {"version": "\#(pinned)"}}]}"#
    let findings = SourceRules.parserVersionFindings(resolved: resolved, file: "Package.resolved", compilerVersion: compiler)
    #expect(findings.map(\.description) == expected)
  }
}

// A Swift file judged as one module's source; its header names the module (`// module: X`) and each finding (`// expect: …`).
struct SourceFixture: Sendable, CustomTestStringConvertible {
  let name: String
  let module: String
  let expected: [String]
  let text: String

  var testDescription: String { name }

  static func all() throws -> [SourceFixture] {
    let directory = Checkout.fixtures.appending(path: "Sources")
    return try Fixture.names(in: directory, suffix: ".swift").map { name in
      let text = try String(contentsOf: directory.appending(path: name), encoding: .utf8)
      let header = Fixture.header(of: text)
      guard let module = header["module"]?.first else { throw Unreadable(name, "no `// module:` header") }
      return SourceFixture(name: name, module: module, expected: header["expect"] ?? [], text: text)
    }
  }
}

// Worlds/base, a §2.1 world every rule passes, or a case holding only what it changes of base; expected.txt lists its findings.
struct WorldCase: Sendable, CustomTestStringConvertible {
  let name: String
  let expected: [String]

  var testDescription: String { name }

  static let worlds = Checkout.fixtures.appending(path: "Worlds")
  static let base = "base"

  static func all() throws -> [WorldCase] {
    try Fixture.names(in: worlds, suffix: "").map { name in
      WorldCase(name: name, expected: try Fixture.expected(in: worlds.appending(path: name)))
    }
  }

  func materialize(into root: URL) throws {
    try Fixture.copy(Self.worlds.appending(path: Self.base), into: root)
    if name != Self.base { try Fixture.copy(Self.worlds.appending(path: name), into: root) }
  }
}

// A directory of workflows, with its expected.txt.
struct WorkflowCase: Sendable, CustomTestStringConvertible {
  let directory: URL
  let expected: [String]

  var testDescription: String { directory.lastPathComponent }

  static func all() throws -> [WorkflowCase] {
    let workflows = Checkout.fixtures.appending(path: "Workflows")
    return try Fixture.names(in: workflows, suffix: "").map { name in
      WorkflowCase(directory: workflows.appending(path: name), expected: try Fixture.expected(in: workflows.appending(path: name)))
    }
  }
}

// An XcodeGen spec of Apps/ whose header lists its findings (`# expect: …`); a spec without one is only included by others.
struct AppCase: Sendable, CustomTestStringConvertible {
  let spec: String
  let expected: [String]

  var testDescription: String { spec }

  static func all() throws -> [AppCase] {
    let apps = Checkout.fixtures.appending(path: "Apps")
    return try Fixture.names(in: apps, suffix: ".yml").compactMap { spec in
      let expected = Fixture.header(of: try String(contentsOf: apps.appending(path: spec), encoding: .utf8), comment: "#")["expect"]
      return expected.map { AppCase(spec: spec, expected: $0) }
    }
  }
}

// A fixture holds no real manifest or link for the closed world to judge: `X.fixture` copies out as `X`, `X.symlink` as a link.
enum Fixture {
  static let expectedFile = "expected.txt"

  static func names(in directory: URL, suffix: String) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { !$0.hasPrefix(".") && $0.hasSuffix(suffix) }.sorted()
  }

  static func expected(in directory: URL) throws -> [String] {
    try String(contentsOf: directory.appending(path: expectedFile), encoding: .utf8).split(separator: "\n").map(String.init)
  }

  static func header(of text: String, comment: String = "//") -> [String: [String]] {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).prefix { line in
      line.hasPrefix("\(comment) module: ") || line.hasPrefix("\(comment) expect: ")
    }
    return lines.reduce(into: [:]) { header, line in
      let (key, value) = (line.dropFirst(comment.count + 1).prefix { $0 != ":" }, line.drop { $0 != ":" }.dropFirst(2))
      header[String(key), default: []] += value == "pass" ? [] : [String(value)]
    }
  }

  static func copy(_ source: URL, into root: URL) throws {
    let files = FileManager.default.enumerator(at: source, includingPropertiesForKeys: [.isRegularFileKey])
    while let file = files?.nextObject() as? URL {
      let path = file.relativePath(from: source)
      guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true, path != expectedFile else { continue }
      let target = root.appending(path: path.hasSuffix(".fixture") || path.hasSuffix(".symlink") ? (path as NSString).deletingPathExtension : path)
      try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: target)
      if path.hasSuffix(".symlink") {
        let destination = try String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        try FileManager.default.createSymbolicLink(atPath: target.path, withDestinationPath: destination)
      } else {
        try FileManager.default.copyItem(at: file, to: target)
      }
    }
  }
}
