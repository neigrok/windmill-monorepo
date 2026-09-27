import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// The gym's declarations against the registry and its pinned book, and its corpus: the LOCAL rules against their vectors,
// the actions against theirs.
struct GymRulesTests {
  @Test func everyEntityAgreesWithTheRegistry() throws {
    let sample = Note(id: ID("note0001"), title: "How I want to be talked to", body: "Blunt. No pep talks.")
    try RegistryCheck.entity(Note.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test func everyCodeMapsAndEveryLocalRuleHasVectors() throws {
    try RuleBookCheck.check(GymRules.book, refusal: GymRefusal.self, vectors: "gym/domain/values.json")
  }

  @Test func theBookIsThePinnedOne() throws {
    try RuleBookParity.check(GymRules.book, file: "gym/domain/rules.json")
  }

  @Test(arguments: try Contract.vectors("gym/domain/values.json"))
  func localRule(_ vector: Vector) throws {
    let result = try ProductCorpus(GymRules.book).value(vector)
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  @Test(arguments: try Contract.vectors("gym/domain/actions.json"))
  func action(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result = switch try vector.input.member("action").asString() {
    case "SaveNoteCall":
      try corpus.decision(of: SaveNoteCall(try Note(form: input.member("note"))), vector, result: \.json, refusal: \.form)
    case let action: throw ContractError("no gym action \(action)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}

extension GymRefusal {
  // The form packages/api-contract/gym/domain/README.md states.
  var form: JSON {
    switch self {
    case .invalid(let violation): ["invalid": violation.form]
    case .stale(let subject, let path): ["stale": ["subject": subject.form, "path": path.form]]
    case .gone(let subject, let path): ["gone": ["subject": subject.form, "path": path.form]]
    case .taken(let subject, let path): ["taken": ["subject": subject.form, "path": path.form]]
    case .full(let type, let cap, let path): ["full": ["type": .string(type), "cap": JSON(cap), "path": path.form]]
    case .other(let refused): ["other": refused.form]
    }
  }
}
