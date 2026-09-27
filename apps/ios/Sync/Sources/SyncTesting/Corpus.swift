import Foundation
import SyncCore

// The golden corpus of engine.md §11.1: its location, the role of each file, and its vectors.

public enum CorpusRole: String, Sendable, CaseIterable {
  case all, server, client
}

public struct CorpusFile: Sendable, Hashable, CustomStringConvertible {
  public let path: String
  public let role: CorpusRole

  public var directory: String {
    path.contains("/") ? String(path.prefix { $0 != "/" }) : "."
  }

  public var description: String { "\(path) (\(role.rawValue))" }
}

public struct CorpusVector: Sendable, CustomStringConvertible {
  public let file: String
  public let name: String
  public let input: JSON
  public let expect: JSON

  public var description: String { "\(file) · \(name)" }
}

public enum CorpusError: Error, CustomStringConvertible {
  case notFound
  case unclassified(String)
  case malformed(file: String, reason: String)

  public var description: String {
    switch self {
    case .notFound: "no packages/api-contract/sync/corpus above this file; set WINDMILL_SYNC_CORPUS"
    case .unclassified(let path): "\(path) has no role in Corpus.roles"
    case .malformed(let file, let reason): "\(file): \(reason)"
    }
  }
}

public enum Corpus {
  // corpus/README.md's role table: a directory entry ends in "/"; a file's own entry wins over its directory's.
  public static let roles: [(entry: String, role: CorpusRole)] = [
    ("constants.json", .all), ("stamp/", .all), ("hlc/tick.json", .all), ("hlc/observe.json", .all), ("jcs/", .all),
    ("join/", .all), ("derive/", .all), ("identity/seeded.json", .all), ("digest/", .all), ("protocol/", .all),
    ("identity/table.json", .server), ("admit/", .server), ("text/", .server), ("push/serve.json", .server),
    ("pull/serve.json", .server), ("pull/hello.json", .server), ("machine/scope.json", .server),
    ("hlc/offset.json", .client), ("hlc/jump.json", .client), ("fracindex/", .client), ("view/", .client), ("commit/", .client),
    ("coalesce/", .client), ("hold/", .client), ("refusal/", .client), ("write/", .client), ("lineage/", .client),
    ("pull/pages.json", .client), ("machine/intent.json", .client), ("machine/replica.json", .client),
  ]

  // The client files written in the client-step language (corpus/README.md "Client steps").
  public static let clientStepFiles = [
    "commit/deltas.json", "commit/grouping.json", "commit/guards.json", "commit/ids.json", "commit/retire.json",
    "commit/throws.json", "coalesce/blocked.json", "coalesce/cancel.json", "coalesce/join.json", "hold/release.json",
    "hold/undo.json", "refusal/base-unknown.json", "refusal/fold.json", "refusal/restamp.json", "refusal/transport.json",
    "write/map.json", "lineage/signin.json", "lineage/signout.json", "lineage/start.json", "pull/pages.json",
  ]

  // Vectors whose expectation breaks a rule of engine.md, reported to the contract owner; each runs as a known issue.
  public static let defects: [String: String] = [
    "lineage/start.json · engine start releases every held entry, and the instance takes a fresh actor that its next commit uses (web: no fork guard)":
      "the input outbox holds g1/0 and the step's commit mints g1 again, so the expected outbox holds two entries with local id g1/0; §2.5 makes local ids unique on the device",
    "lineage/signin.json · a dormant replica of A is rebound; the anon entries, notices and new device rows move after its own":
      "the input notice's content is {d: []}, which no engine writes (§7.7 step 4 content leaves out empty parts)",
  ]

  public static func role(of path: String) -> CorpusRole? {
    roles.first { $0.entry == path }?.role ?? roles.first { $0.entry.hasSuffix("/") && path.hasPrefix($0.entry) }?.role
  }

  public static func root() throws -> URL {
    if let override = ProcessInfo.processInfo.environment["WINDMILL_SYNC_CORPUS"] {
      return URL(fileURLWithPath: override, isDirectory: true)
    }
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while directory.path != "/" {
      let candidate = directory.appendingPathComponent("packages/api-contract/sync/corpus", isDirectory: true)
      if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
      directory = directory.deletingLastPathComponent()
    }
    throw CorpusError.notFound
  }

  // The test-only product the corpus is written against, beside the corpus.
  public static func probeRegistryFile() throws -> JSON {
    let file = try root().deletingLastPathComponent().appendingPathComponent("probe.registry.json")
    return try JSON(parsing: [UInt8](Data(contentsOf: file)))
  }

  public static func probeRegistry() throws -> Registry {
    try Registry(json: probeRegistryFile())
  }

  public static func paths() throws -> [String] {
    let root = try root()
    guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { throw CorpusError.notFound }
    return walk.compactMap { $0 as? URL }
      .filter { ["json", "jsonl"].contains($0.pathExtension) }
      .map { String($0.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1)) }
      .sorted()
  }

  public static func files() throws -> [CorpusFile] {
    try paths().map { path in
      guard let role = role(of: path) else { throw CorpusError.unclassified(path) }
      return CorpusFile(path: path, role: role)
    }
  }

  // A `.json` file is its vectors; `constants.json` and each `.jsonl` transcript are one vector each.
  public static func vectors(in file: CorpusFile) throws -> [CorpusVector] {
    let bytes = [UInt8](try Data(contentsOf: try root().appendingPathComponent(file.path)))
    if file.path.hasSuffix(".jsonl") {
      let lines = try bytes.split(separator: UInt8(ascii: "\n")).map { try JSON(parsing: Array($0)) }
      return [CorpusVector(file: file.path, name: "transcript", input: .array(lines), expect: .null)]
    }
    let document = try JSON(parsing: bytes)
    guard case .array(let entries) = document else {
      return [CorpusVector(file: file.path, name: "the whole file", input: .null, expect: document)]
    }
    return try entries.map { entry in
      let vector = try entry.asObject()
      try vector.expectKeys(required: ["name", "input", "expect"])
      return CorpusVector(file: file.path, name: try vector.member("name").asString(), input: try vector.member("input"),
                          expect: try vector.member("expect"))
    }
  }
}
