import Foundation
import Testing

// The compile attacks of domain-kit.md §13 and §16.2: every file under Attacks/ is compiled to SIL, so the data-race
// diagnostics run too, against the modules this build made, over the probe domain in Attacks/ProbeDomain.swift, either as product-domain code (`domain.*`) or as UI
// code (`ui.*`: main-actor by default, warnings as errors but deprecations, as §2.4 item 3 sets WindmillKit). A `fail`
// attack must not compile, with the error its first line expects; a `pass` control must compile clean.
struct AttackTests {
  @Test(arguments: try Attack.all())
  func attack(_ attack: Attack) throws {
    let (status, output) = try Compiler.shared.compile(attack)
    let errors = output.split(separator: "\n").filter { $0.contains("error: ") }.map { String($0.split(separator: "error: ", maxSplits: 1).last ?? "") }
    guard let expected = attack.expected else {
      #expect(status == 0 && errors.isEmpty, "\(attack) should compile:\n\(output)")
      return
    }
    #expect(status != 0, "\(attack) compiled")
    #expect(errors.contains { $0.contains(expected) }, "\(attack) failed otherwise:\n\(errors.joined(separator: "\n"))")
    #expect(!output.contains("no such module"), "\(attack) could not load its modules:\n\(output)")
  }
}

struct Attack: Sendable, CustomTestStringConvertible {
  enum Mode: String, Sendable {
    case domain, ui
  }

  let file: URL
  let mode: Mode
  let expected: String?

  static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Attacks")

  static func all() throws -> [Attack] {
    try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("domain.") || $0.lastPathComponent.hasPrefix("ui.") }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
      .map(Attack.init)
  }

  init(_ file: URL) throws {
    let parts = file.lastPathComponent.split(separator: ".")
    guard parts.count == 4, let mode = Mode(rawValue: String(parts[0])), ["fail", "pass"].contains(parts[1]) else {
      throw AttackError("\(file.lastPathComponent) is not <domain|ui>.<fail|pass>.<name>.swift")
    }
    let firstLine = try String(contentsOf: file, encoding: .utf8).split(separator: "\n").first.map(String.init) ?? ""
    self.file = file
    self.mode = mode
    expected = parts[1] == "fail" ? String(firstLine.dropFirst("// expect: ".count)) : nil
    guard expected == nil || firstLine.hasPrefix("// expect: ") else { throw AttackError("\(file.lastPathComponent) states no expected error") }
  }

  var testDescription: String { file.lastPathComponent }
}

struct AttackError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

// The build's modules, found beside the test bundle, and the probe domain module every attack imports, emitted once per
// run into the build's own scratch directory.
final class Compiler: Sendable {
  static let shared = Compiler()

  let modules: URL
  let workspace: URL
  let target: String
  let probeDomain: Result<Void, AttackError>

  init() {
    let products = Bundle(for: Compiler.self).bundleURL.deletingLastPathComponent()
    let (modules, workspace) = (products.appendingPathComponent("Modules"), products.appendingPathComponent("DomainKitAttacks"))
    let target = "\(products.deletingLastPathComponent().lastPathComponent)15.0"
    try? FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
    self.modules = modules
    self.workspace = workspace
    self.target = target
    probeDomain = Result { () throws(AttackError) in
      let emitted = Compiler.swiftc(Compiler.common(modules: modules, workspace: workspace, target: target) + Attack.Mode.domain.flags + [
        "-emit-module", "-module-name", "ProbeDomain", "-emit-module-path", workspace.appendingPathComponent("ProbeDomain.swiftmodule").path,
        Attack.directory.appendingPathComponent("ProbeDomain.swift").path,
      ])
      guard emitted.status == 0 else { throw AttackError("the probe domain did not compile:\n\(emitted.output)") }
    }
  }

  func compile(_ attack: Attack) throws -> (status: Int32, output: String) {
    try probeDomain.get()
    return Compiler.swiftc(Compiler.common(modules: modules, workspace: workspace, target: target) + attack.mode.flags + [
      "-emit-sil", "-o", "/dev/null", "-module-name", "Attack", attack.file.path,
    ])
  }

  static func common(modules: URL, workspace: URL, target: String) -> [String] {
    ["-swift-version", "6", "-parse-as-library", "-target", target, "-sdk", sdk, "-I", workspace.path, "-I", modules.path,
     "-module-cache-path", workspace.appendingPathComponent("ModuleCache").path]
  }

  static let sdk = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]).output.trimmingCharacters(in: .whitespacesAndNewlines)

  static func swiftc(_ arguments: [String]) -> (status: Int32, output: String) {
    run("/usr/bin/xcrun", ["swiftc"] + arguments)
  }

  static func run(_ executable: String, _ arguments: [String]) -> (status: Int32, output: String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    do {
      try process.run()
    } catch {
      return (-1, "\(executable) did not start: \(error)")
    }
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: output, as: UTF8.self))
  }
}

extension Attack.Mode {
  var flags: [String] {
    switch self {
    case .domain: ["-enable-upcoming-feature", "MemberImportVisibility"]
    case .ui: ["-default-isolation", "MainActor", "-warnings-as-errors", "-Wwarning", "DeprecatedDeclaration"]
    }
  }
}
