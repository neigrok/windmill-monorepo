import Foundation
import SyncCore

// `swift run SyncSchemaGen` regenerates Sources/SyncSchema from the product registries, every *.registry.json in
// packages/api-contract/sync but the test-only probe's. `--check` writes nothing and exits 1 when a checked-in file
// differs from what the registries generate.

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments == [] || arguments == ["--check"] else {
  print("usage: swift run SyncSchemaGen [--check]")
  exit(2)
}
let checking = arguments == ["--check"]
let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let target = package.appendingPathComponent("Sources/SyncSchema")
let files = FileManager.default

do {
  var root = package
  while !files.fileExists(atPath: root.appendingPathComponent(SchemaSources.directory).path) {
    guard root.path != "/" else { throw GenerationError(description: "no \(SchemaSources.directory) above \(package.path)") }
    root.deleteLastPathComponent()
  }
  let contract = root.appendingPathComponent(SchemaSources.directory)
  let registries = try files.contentsOfDirectory(atPath: contract.path)
    .filter { $0.hasSuffix(".registry.json") && $0 != "probe.registry.json" }
    .map { name in RegistryFile(name: name, json: try JSON(parsing: [UInt8](Data(contentsOf: contract.appendingPathComponent(name))))) }
  let generated = try SchemaSources.files(from: registries)
  let present = files.fileExists(atPath: target.path) ? try files.contentsOfDirectory(atPath: target.path) : []
  let existing = try Dictionary(uniqueKeysWithValues: present.filter { $0.hasSuffix(".swift") }
    .map { name in (name, [UInt8](try Data(contentsOf: target.appendingPathComponent(name)))) })
  let stale = SchemaSources.stale(generated, existing: existing)
  if checking {
    guard stale.isEmpty else {
      print("Sources/SyncSchema is stale (\(stale.joined(separator: ", "))): run swift run SyncSchemaGen")
      exit(1)
    }
    print("Sources/SyncSchema is current")
    exit(0)
  }
  try files.createDirectory(at: target, withIntermediateDirectories: true)
  for file in generated where stale.contains(file.name) {
    try file.text.write(to: target.appendingPathComponent(file.name), atomically: true, encoding: .utf8)
  }
  for name in stale where !generated.contains(where: { $0.name == name }) {
    try files.removeItem(at: target.appendingPathComponent(name))
  }
  print(stale.isEmpty ? "Sources/SyncSchema is current" : "wrote Sources/SyncSchema: \(stale.joined(separator: ", "))")
} catch {
  print("SyncSchemaGen: \(error)")
  exit(1)
}
