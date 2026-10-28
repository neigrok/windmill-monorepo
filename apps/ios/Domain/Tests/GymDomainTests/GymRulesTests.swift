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
                   "catalogue-actions.json", "preferences-actions.json", "proposals-actions.json", "recovery-actions.json", "training-actions.json",
                   "training-reads.json", "units.json"]
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
    let result = try vector.input["nonFinite"].map { try nonFiniteEntity(vector, override: $0) } ?? ProductCorpus(GymRules.book).value(vector)
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  func nonFiniteEntity(_ vector: Vector, override: JSON) throws -> JSON {
    let input = vector.input
    let moment = Moment(now: Instant(ms: try input.member("now").asInteger()),
                        zone: FixedZone(offsetSeconds: Int(try input.member("offsetSeconds").asInteger())))
    let weight: Double = switch try override.member("value").asString() {
    case "NaN": .nan
    case "Infinity": .infinity
    case "-Infinity": -.infinity
    default: throw ContractError("unknown non-finite number")
    }
    let path = try override.member("path").asString()
    switch try input.member("entity").asString() {
    case "set":
      guard path == "weightKg" else { throw ContractError("unknown set numeric override") }
      var value = try TrainingSet(form: input)
      value.weightKg = weight
      return checked(value, at: moment)
    case "routine":
      guard path == "entries.0.sets.0.weightKg" else { throw ContractError("unknown routine numeric override") }
      var value = try Routine(form: input)
      value.entries[0].sets![0].weightKg = weight
      return checked(value, at: moment)
    case "proposal":
      var value = try Proposal(form: input)
      switch path {
      case "changes.0.before.sets.0.weightKg": value.changes[0].before!.sets![0].weightKg = weight
      case "changes.0.after.sets.0.weightKg": value.changes[0].after!.sets![0].weightKg = weight
      default: throw ContractError("unknown proposal numeric override")
      }
      return checked(value, at: moment)
    default: throw ContractError("unknown numeric override entity")
    }
  }

  func checked<E: Writable>(_ value: E, at moment: Moment) -> JSON {
    do throws(Violation) { return ["fields": .object(fields: try Valid(value, at: moment).value.fields)] }
    catch { return ["violation": error.form] }
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
