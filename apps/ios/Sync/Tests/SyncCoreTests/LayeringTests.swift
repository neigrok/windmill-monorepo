import Foundation
import Testing

// The package's layers, read from its sources: each target imports only what the table allows, so SyncCore, SyncAPI
// and SyncReplica stay pure (no UI, networking or storage) and GRDB appears only in SyncStore. The engine-API targets
// follow the domain kit's source rules (ER-13).

struct LayeringTests {
  static let allowed: [String: Set<String>] = [
    "SyncCore": ["CryptoKit"],
    "SyncAPI": ["SyncCore"],
    "SyncReplica": ["SyncCore", "SyncAPI"],
    "SyncStore": ["SyncCore", "SyncAPI", "SyncReplica", "GRDB", "Foundation"],
    "SyncTesting": ["SyncCore", "SyncAPI", "SyncReplica", "Foundation"],
  ]

  static let engineAPI = ["SyncCore", "SyncAPI"]

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
    var violations: [String] = []
    for file in try Self.files(of: target) {
      for (number, line) in file.lines.enumerated() {
        let place = "\(target)/\(file.name):\(number + 1)"
        if let match = line.wholeMatch(of: Self.importLine), !match.attributes.isEmpty || match.access != nil {
          violations.append("\(place) decorates an import")
        }
        if line.trimmingCharacters(in: .whitespaces).hasPrefix("#if") { violations.append("\(place) compiles conditionally") }
        if line.range(of: "random", options: .caseInsensitive) != nil { violations.append("\(place) names randomness `random`") }
      }
    }
    #expect(violations == [])
  }
}
