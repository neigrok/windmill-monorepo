import Foundation
import SyncCore

// `swift run CatalogGen` regenerates each product's Coach/Catalog.generated.swift from its ability catalog; `--check`
// refuses a stale file.

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments == [] || arguments == ["--check"] else {
  print("usage: swift run CatalogGen [--check]")
  exit(2)
}
let checking = arguments == ["--check"]
let files = FileManager.default

do {
  let anchor = CatalogSource.all[0].catalogFile
  var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  while !files.fileExists(atPath: root.appendingPathComponent(anchor).path) {
    guard root.path != "/" else { throw GenerationError(description: "no \(anchor) above \(#filePath)") }
    root.deleteLastPathComponent()
  }
  var stale = false
  for source in CatalogSource.all {
    let catalog = try JSON(parsing: [UInt8](Data(contentsOf: root.appendingPathComponent(source.catalogFile))))
    let generated = try source.text(from: catalog)
    let target = root.appendingPathComponent(source.generatedFile)
    let existing = files.fileExists(atPath: target.path) ? [UInt8](try Data(contentsOf: target)) : []
    let current = existing == Array(generated.utf8)
    if checking {
      print(current ? "\(source.generatedFile) is current" : "\(source.generatedFile) is stale: run swift run CatalogGen")
      stale = stale || !current
      continue
    }
    if !current { try generated.write(to: target, atomically: true, encoding: .utf8) }
    print(current ? "\(source.generatedFile) is current" : "wrote \(source.generatedFile)")
  }
  exit(stale ? 1 : 0)
} catch {
  print("CatalogGen: \(error)")
  exit(1)
}
