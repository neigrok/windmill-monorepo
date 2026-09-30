import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// The gym's rule book against its refusal and its pinned file, and every LOCAL rule against its vectors. Each feature's
// tests check its own entities against the registry and run its own actions' vectors.
struct GymRulesTests {
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
}

extension GymRefusal {
  // The form packages/api-contract/gym/domain/README.md states; a feature's own case adds its line here and there.
  var form: JSON {
    switch self {
    case .invalid(let violation): ["invalid": violation.form]
    case .stale(let subject, let path): ["stale": ["subject": subject.form, "path": path.form]]
    case .future(let subject, let path): ["future": ["subject": subject.form, "path": path.form]]
    case .gone(let subject, let path): ["gone": ["subject": subject.form, "path": path.form]]
    case .taken(let subject, let path): ["taken": ["subject": subject.form, "path": path.form]]
    case .full(let type, let cap, let path): ["full": ["type": .string(type), "cap": JSON(cap), "path": path.form]]
    case .other(let refused): ["other": refused.form]
    }
  }
}
