import Foundation
import SyncCore

// `swift run GymCatalogGen` regenerates Sources/GymDomain/Coach/Catalog.generated.swift from the gym ability catalog;
// `--check` refuses a stale file.

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments == [] || arguments == ["--check"] else {
  print("usage: swift run GymCatalogGen [--check]")
  exit(2)
}
let checking = arguments == ["--check"]
let files = FileManager.default

do {
  var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  while !files.fileExists(atPath: root.appendingPathComponent(CatalogSources.catalogFile).path) {
    guard root.path != "/" else { throw GenerationError(description: "no \(CatalogSources.catalogFile) above \(#filePath)") }
    root.deleteLastPathComponent()
  }
  let catalog = try JSON(parsing: [UInt8](Data(contentsOf: root.appendingPathComponent(CatalogSources.catalogFile))))
  let generated = try CatalogSources.text(from: catalog)
  let target = root.appendingPathComponent(CatalogSources.generatedFile)
  let existing = files.fileExists(atPath: target.path) ? [UInt8](try Data(contentsOf: target)) : []
  let current = existing == Array(generated.utf8)
  if checking {
    print(current ? "\(CatalogSources.generatedFile) is current" : "\(CatalogSources.generatedFile) is stale: run swift run GymCatalogGen")
    exit(current ? 0 : 1)
  }
  if !current { try generated.write(to: target, atomically: true, encoding: .utf8) }
  print(current ? "\(CatalogSources.generatedFile) is current" : "wrote \(CatalogSources.generatedFile)")
} catch {
  print("GymCatalogGen: \(error)")
  exit(1)
}
