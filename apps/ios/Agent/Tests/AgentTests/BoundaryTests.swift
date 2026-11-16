import Foundation
import Testing

struct BoundaryTests {
  @Test func engineNamesOnlyItsOwnVocabularyAndSyncCore() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let sources = try FileManager.default.contentsOfDirectory(at: root.appending(path: "Sources/Agent"), includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }.sorted { $0.path < $1.path }
    #expect(!sources.isEmpty)
    let findings = try sources.flatMap { file in
      try Self.violations(String(contentsOf: file, encoding: .utf8)).map { file.lastPathComponent + ": " + $0 }
    }
    #expect(findings == [])
  }

  @Test func boundaryRejectsProductNamesAndPlatformImports() throws {
    #expect(try Self.violations("import Foundation\nstruct GymHost {}\nlet journal = 1\nlet roadmap = 2") ==
      ["product: gym", "product: journal", "product: roadmap", "import: Foundation"])
    #expect(try Self.violations("import SyncCore\nstruct Profile {}") == [])
  }

  static func violations(_ source: String) throws -> [String] {
    var findings = ["gym", "journal", "roadmap"].filter { source.lowercased().contains($0) }.map { "product: " + $0 }
    let pattern = try NSRegularExpression(pattern: #"\bimport\s+([A-Za-z][A-Za-z0-9]*)"#)
    let text = source as NSString
    for match in pattern.matches(in: source, range: NSRange(location: 0, length: text.length)) {
      let module = text.substring(with: match.range(at: 1))
      if module != "SyncCore" { findings.append("import: " + module) }
    }
    return findings
  }
}
