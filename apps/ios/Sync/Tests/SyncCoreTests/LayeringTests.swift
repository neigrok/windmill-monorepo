import Foundation
import Testing

// SyncCore is pure: it imports nothing but the modules allowed here, so no UI, networking or storage.

struct LayeringTests {
  @Test func syncCoreImportsOnlyCryptoKit() throws {
    let allowed: Set<String> = ["CryptoKit"]
    let sources = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/SyncCore")
    let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }
    let importLine = #/
      \s* (?: @\w+ (?: \( [^)]* \) )? \s+ )*
      (?: (?: public | package | internal | fileprivate | private ) \s+ )?
      import \s+ (?: (?: typealias | struct | class | enum | protocol | let | var | func ) \s+ )?
      ( [A-Za-z_] [A-Za-z0-9_]* ) .*
    /#
    let imports = try files.flatMap { file in
      try String(contentsOf: file, encoding: .utf8).split(separator: "\n").compactMap { line in
        line.wholeMatch(of: importLine).map { "\(file.lastPathComponent) imports \($0.1)" }
      }
    }
    #expect(!files.isEmpty)
    #expect(imports.filter { !allowed.contains(String($0.split(separator: " ").last!)) } == [])
  }
}
