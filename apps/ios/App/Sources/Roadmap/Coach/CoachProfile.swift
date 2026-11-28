import Foundation
import Agent
import DomainKit
import RoadmapDomain
import SyncCore

// Roadmap Coach §8, engine D-3: roadmap's profile for the Coach engine, as plain data. Its words are the contract's files,
// which the app carries as they are (packages/api-contract/roadmap/coach); its tools are catalog roadmap/1's abilities that
// run on the copy, `list_trees` in a conversation about all roadmaps and the direct writes in one about a roadmap; the model
// class, effort, output and limits are §8's. A proposal is not offered yet: the gate refuses one as not offered.
struct CoachProfile {
  // The words a turn's model reads (first-content.json and refusals.json beside the prompt).
  struct Words: Decodable {
    struct Leads: Decodable {
      let roadmap: String
      let allRoadmaps: String
    }
    struct Earlier: Decodable {
      let marker: String
      let person: String
      let coach: String
    }
    let contextLeads: Leads
    let earlierConversation: Earlier
    let pictureOnlyQuestion: String
  }

  static let name = "roadmap.coach"
  static let version = 1
  static let label = "roadmap.coach.turn"
  // §8: the earlier conversation the first content carries, at most 24 turns and 24,000 bytes.
  static let historyTurns = 24
  static let historyBytes = 24_000

  let prompt: String
  let words: Words
  let refusals: [String: String]
  // Each ability of catalog roadmap/1 as the model reads it, by name: its description and input schema.
  let described: [String: (description: String, input: JSON)]

  // The words as the app's bundle carries them, in its `coach` folder, and the catalog beside them.
  init(bundle: Bundle = .main) throws {
    let file = { (name: String, kind: String, folder: String?) throws -> Data in
      guard let url = bundle.url(forResource: name, withExtension: kind, subdirectory: folder) else { throw CocoaError(.fileNoSuchFile) }
      return try Data(contentsOf: url)
    }
    prompt = String(decoding: try file("prompt", "md", "coach"), as: UTF8.self)
    words = try JSONDecoder().decode(Words.self, from: try file("first-content", "json", "coach"))
    refusals = try JSONDecoder().decode([String: String].self, from: try file("refusals", "json", "coach"))
    let catalog = try JSON(parsing: Array(try file("catalog", "json", nil)))
    described = Dictionary(uniqueKeysWithValues: try catalog.member("abilities").asArray().map { ability in
      (try ability.member("name").asString(), (try ability.member("description").asString(), try ability.member("input")))
    })
  }

  // The profile of a turn under `seat`, about one roadmap (`about`) or all of the person's: the reads, and the direct
  // writes in a roadmap Coach `writes` in, the person's own.
  func profile(seat: Agent.Seat.Kind, about: String?, writes: Bool) throws -> Profile {
    let offered = Catalog.roadmap.abilities.filter { ability in
      guard ability.agent == .runs else { return false }
      if ability.name == "list_trees" { return about == nil }
      return ability.kind == .read || (about != nil && writes)
    }
    let tools: [JSON] = offered.map { ability in
      ["name": .string(ability.name), "description": .string(described[ability.name]?.description ?? ""),
       "input": described[ability.name]?.input ?? ability.input, "countsAsWrite": .bool(ability.kind != .read)]
    }
    let value: JSON = [
      "name": .string(Self.name), "version": JSON(Self.version), "system": [.string(prompt)],
      "firstContent": ["historyPrefix": "", "contextPrefix": "", "questionPrefix": "", "emptyQuestion": .string(words.pictureOnlyQuestion)],
      "refusals": .object(JSON.Object(uniqueKeysWithValues: refusals.map { ($0.key, JSON.string($0.value)) })),
      "tools": .array(tools), "groups": [], "model": "large", "effort": seat == .bound ? "medium" : "low",
      "output": ["maxTokens": 2_000, "minTokens": 1_024], "label": .string(Self.label),
      "limits": ["modelCalls": 8, "abilityCalls": 12, "writes": 6],
    ]
    return try Profile(value)
  }

  // The earlier conversation as one block, oldest first, each message under its speaker's name: the last 24 turns, fewer
  // where they pass 24,000 bytes; nothing where there is none.
  func history(_ messages: [CoachMessage]) -> String {
    var kept = Array(messages.suffix(Self.historyTurns * 2))
    let earlier = words.earlierConversation
    let line = { (message: CoachMessage) in "\n\n\(message.isCoach ? earlier.coach : earlier.person): \(message.text)" }
    while !kept.isEmpty, (earlier.marker + kept.map(line).joined()).utf8.count > Self.historyBytes { kept.removeFirst() }
    return kept.isEmpty ? "" : earlier.marker + kept.map(line).joined()
  }

  // The context as the model reads it: its lead, then the context in canonical form.
  func context(_ told: JSON, about: String?) -> String {
    (about == nil ? words.contextLeads.allRoadmaps : words.contextLeads.roadmap) + "\n" + told.jcsText
  }
}
