import Foundation
import Testing

// The package's layers, read from its sources: each target imports only what the table allows, so SyncCore, SyncAPI,
// SyncSchema and SyncReplica stay pure (no UI, networking or storage), GRDB appears only in SyncStore, and UIKit only in
// SyncIOS. The engine-API targets follow the domain kit's source rules (ER-13).

struct LayeringTests {
  static let allowed: [String: Set<String>] = [
    "SyncCore": ["CryptoKit"],
    "SyncAPI": ["SyncCore"],
    "SyncSchema": ["SyncCore"],
    "SyncSchemaGen": ["SyncCore", "Foundation"],
    "SyncReplica": ["SyncCore", "SyncAPI"],
    "SyncStore": ["SyncCore", "SyncAPI", "SyncReplica", "GRDB", "Foundation"],
    "SyncEngine": ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore", "Foundation", "Network", "Observation", "Synchronization"],
    "SyncIOS": ["SyncEngine", "Foundation", "Security", "Synchronization", "UIKit"],
    "SyncModelServer": ["SyncCore"],
    "SyncTesting": ["SyncCore", "SyncAPI", "SyncReplica", "SyncStore", "SyncEngine", "SyncModelServer", "Foundation", "Synchronization"],
  ]

  static let engineAPI = ["SyncCore", "SyncAPI", "SyncSchema"]

  static let sources = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Sources")

  static var importLine: Regex<(Substring, attributes: Substring, access: Substring?, module: Substring)> { #/
    \s* (?<attributes> (?: @\w+ (?: \( [^)]* \) )? \s+ )* )
    (?<access> (?: public | package | internal | fileprivate | private ) \s+ )?
    import \s+ (?: (?: typealias | struct | class | enum | protocol | let | var | func ) \s+ )?
    (?<module> [A-Za-z_] [A-Za-z0-9_]* ) .*
  /# }

  static func files(of target: String) throws -> [(name: String, lines: [Substring])] {
    let directory = sources.appendingPathComponent(target)
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }
      .map { ($0.lastPathComponent, try String(contentsOf: $0, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)) }
  }

  @Test(arguments: allowed.keys.sorted())
  func eachTargetImportsOnlyWhatItsLayerAllows(_ target: String) throws {
    let files = try Self.files(of: target)
    let imports = files.flatMap { file in
      file.lines.compactMap { $0.wholeMatch(of: Self.importLine).map { (file: file.name, module: String($0.module)) } }
    }
    #expect(!files.isEmpty)
    #expect(imports.filter { !Self.allowed[target]!.contains($0.module) }.map { "\($0.file) imports \($0.module)" } == [])
  }

  @Test func onlySyncCoresDigestFileImportsCryptoKit() throws {
    let importing = try Self.files(of: "SyncCore").filter { file in file.lines.contains { $0.wholeMatch(of: Self.importLine) != nil } }
    #expect(importing.map(\.name) == ["Digest.swift"])
  }

  // ER-13: no import attribute, no access-modified import, no `#if`, and no randomness named `random`.
  @Test(arguments: engineAPI)
  func theEngineAPIFollowsTheKitsSourceRules(_ target: String) throws {
    let violations = try Self.files(of: target).flatMap { file in
      file.lines.enumerated().flatMap { Self.violations(of: $0.element, at: "\(target)/\(file.name):\($0.offset + 1)") }
    }
    #expect(violations == [])
  }

  // The rules read tokens: the text inside a string literal and a comment is none (the kit's §2.3), so a registry value
  // SyncSchema carries as a string names nothing.
  @Test func theSourceRulesReadTokensNotStringsOrComments() {
    let lines: [Substring] = [
      #"    "enum": ["random", "typed"],"#, #"  let pick = "a \"random\" one" // a random pick"#, "  let random = 1",
      #"  static let order = "shuffled"; let randomOrder = order"#, "@_exported import SyncCore", "#if DEBUG",
    ]
    #expect(lines.enumerated().flatMap { Self.violations(of: $0.element, at: "line \($0.offset + 1)") } == [
      "line 3 names randomness `random`", "line 4 names randomness `random`", "line 5 decorates an import",
      "line 6 compiles conditionally",
    ])
  }

  static func violations(of line: Substring, at place: String) -> [String] {
    var found: [String] = []
    if let match = line.wholeMatch(of: importLine), !match.attributes.isEmpty || match.access != nil {
      found.append("\(place) decorates an import")
    }
    if line.trimmingCharacters(in: .whitespaces).hasPrefix("#if") { found.append("\(place) compiles conditionally") }
    let code = line.replacing(#/"(?:[^"\\]|\\.)*"/#, with: #""""#).replacing(#///.*/#, with: "")
    if code.range(of: "random", options: .caseInsensitive) != nil { found.append("\(place) names randomness `random`") }
    return found
  }
}
