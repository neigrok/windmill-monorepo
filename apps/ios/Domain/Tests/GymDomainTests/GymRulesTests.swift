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
  @Test func everySharedFileHasARunner() throws {
    let handled = ["rules.json", "values.json", "notes-actions.json", "bodyweight-actions.json", "routines-actions.json",
                   "catalogue-actions.json", "preferences-actions.json", "proposals-actions.json", "training-actions.json", "training-reads.json", "units.json"]
    #expect(try Contract.files(under: "gym/domain") == handled.map { "gym/domain/" + $0 }.sorted())
  }

  @Test func aNotesServerTimestampIsOptionalAndNeverWritten() throws {
    let old = try Note(form: ["id": "note0001", "fields": ["title": "Rest", "body": "Pause"]])
    let authored = try Note(form: ["id": "note0001", "fields": ["title": "Rest", "body": "Pause", "updatedAt": 1_800_000_000_000]])
    #expect(old.updatedAt == nil && authored.updatedAt == Instant(ms: 1_800_000_000_000))
    #expect(authored.fields == old.fields)
  }
  @Test func everyCodeMapsAndEveryLocalRuleHasVectors() throws {
    let files = try Contract.files(under: "gym/domain").filter { $0.hasSuffix("-actions.json") }
    try RuleBookCheck.check(GymRules.book, refusal: GymRefusal.self, vectors: "gym/domain/values.json", actionVectors: files)
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
    case .sessionFinished(let r): ["sessionFinished": r.form]
    case .sessionOpen(let r): ["sessionOpen": r.form]
    case .sessionOverlap(let r): ["sessionOverlap": r.form]
    case .payloadConflict(let r): ["payloadConflict": r.form]
    case .unknownExercise(let r): ["unknownExercise": r.form]
    case .badInstant(let r): ["badInstant": r.form]
    case .proposalSettled(let r): ["proposalSettled": r.form]
    case .proposalSuperseded(let r): ["proposalSuperseded": r.form]
    case .other(let refused): ["other": refused.form]
    }
  }
}
