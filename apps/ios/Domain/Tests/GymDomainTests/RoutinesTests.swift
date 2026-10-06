import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct RoutinesTests {
  static let entry = RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 5, weightKg: 80)], restSeconds: 120)

  @Test func performedZeroLoadTargetsRemainExplicitAndCanBeSaved() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let target = SetTarget(reps: 10, weightKg: 0)
    #expect(try target.validated(at: "sets.0") == target)
    var routine = Draft(new: Routine(id: phone.runner.mint(Routine.self), name: "Bodyweight", entries: [RoutineEntry(exerciseId: ID("dip"), sets: [target])]))
    #expect(saved(phone.runner.save(&routine, SaveRoutine.self)))
    phone.sync()
    #expect(try phone.drawn(Routine.self).first?.entries == [RoutineEntry(exerciseId: ID("dip"), sets: [target])])
    #expect(try phone.notices(GymRefusal.self).isEmpty)
    #expect(throws: Violation.self) { try SetTarget(reps: 10, weightKg: 0.001).validated(at: "sets.0") }
  }

  static func add(_ phone: Harness, name: String = "Lower A", position: Int = 0) throws -> ID<Routine> {
    var draft = Draft(new: Routine(id: phone.runner.mint(Routine.self), name: name, position: position, entries: [entry]))
    try #require(saved(phone.runner.save(&draft, SaveRoutine.self)))
    return draft.id
  }

  @Test func theRoutineAndItsOrderedTargetsAgreeWithTheRegistry() throws {
    let sample = Routine(id: ID("routine1"), name: "Lower A", entries: [Self.entry, RoutineEntry(exerciseId: ID("dip"))])
    try RegistryCheck.entity(Routine.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
    #expect(try RoutineEntry(Fields(Self.entry.json)) == Self.entry)
    #expect(try SessionPlan.decode(SessionPlan(sample).json) == SessionPlan(sample))
  }

  @Test func untouchedRoutineFieldsMergeAcrossPhonesAndTheEditedFieldIsGuarded() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let id = try Self.add(a)
    a.sync()
    var mine = try #require(try a.runner.open(id))
    var theirs = try #require(try b.runner.open(id))
    mine.current.name = "Lower B"
    theirs.current.entries = [RoutineEntry(exerciseId: ID("dip"))]
    #expect(saved(a.runner.save(&mine, SaveRoutine.self)))
    #expect(saved(b.runner.save(&theirs, SaveRoutine.self)))
    a.sync()
    let merged = try #require(try b.drawn(Routine.self).first)
    #expect(merged.fields == ["name": "Lower B", "position": 0, "entries": .array([RoutineEntry(exerciseId: ID("dip")).json])])
    mine = try #require(try a.runner.open(id))
    theirs = try #require(try b.runner.open(id))
    mine.current.name = "From A"
    theirs.current.name = "From B"
    #expect(saved(a.runner.save(&mine, SaveRoutine.self)))
    a.sync()
    #expect(refused(b.runner.save(&theirs, SaveRoutine.self)) == .stale(id.ref, .predicted))
    #expect(theirs.isDirty)
  }

  @Test func routineReorderIsAtomicAndADeleteCanBeUndoneBeforeItsWindowEnds() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let one = try Self.add(phone)
    let two = try Self.add(phone, name: "Upper A", position: 1)
    #expect(unchanged(try phone.runner.run(ReorderRoutines([one, two]))) != nil)
    #expect(try phone.runner.run(ReorderRoutines([two, one])).receipt != nil)
    #expect(try Routine.ordered(phone.drawn(Routine.self)).map(\.id) == [two, one])
    let deletion = try #require(try phone.runner.run(DeleteRoutine(one)).receipt)
    #expect(deletion.releaseAt == 1_800_000_000_000 + Constants.holdMs)
    #expect(try phone.drawn(Routine.self).map(\.id) == [two])
    #expect(try phone.runner.undo(deletion.gestureId))
    #expect(try Routine.ordered(phone.drawn(Routine.self)).map(\.id) == [two, one])
  }

  @Test(arguments: try Contract.vectors("gym/domain/routines-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result: JSON
    if let action = vector.input["action"] {
      switch try action.asString() {
      case "SaveRoutine":
        let value = try Routine(form: input.member("routine"))
        result = try corpus.save(SaveRoutine.self, vector, opening: Routine(id: value.id), edit: { $0 = value }, result: \.form, refusal: \.form)
      case "CreateRoutine":
        result = try corpus.decision(of: SaveRoutine(creating: Routine(form: input.member("routine"))), vector, result: \.form, refusal: \.form)
      case "ReorderRoutines":
        let ids = try input.member("order").asArray().map { ID<Routine>(try RecordID(json: $0)) }
        result = try corpus.decision(of: ReorderRoutines(ids), vector, result: { _ in .null }, refusal: \.form)
      case "DeleteRoutine":
        result = try corpus.decision(of: DeleteRoutine(ID(try RecordID(json: input.member("id")))), vector, result: { _ in .null }, refusal: \.form)
      case let name: throw ContractError("no routine action \(name)")
      }
    } else {
      do {
        result = try corpus.read(vector, in: Routine.scope) { read in
          switch try vector.input.member("read").asString() {
          case "Routines":
            return .array(try Routine.ordered(read.repository(Routine.self).all(in: .drawn)).map { ["id": $0.id.json, "fields": .object(fields: $0.fields)] })
          case "RoutineMetadata":
            let id = ID<Routine>(try RecordID(json: input.member("id")))
            let value = try #require(try read.repository(Routine.self).find(id, in: .drawn))
            return ["revision": .of(value.revision), "createdEntries": .of(value.createdEntries), "createdDoor": .of(value.createdDoor),
                    "fields": .object(fields: value.fields)]
          case "SessionPlan": return try SessionPlan.decode(input["plan"])?.json ?? .null
          case let name: throw ContractError("no routine read \(name)")
          }
        }
      } catch let error as DecodeError {
        result = ["decodeError": ["type": .string(error.type), "field": .string(error.field), "reason": .string(error.reason)]]
      }
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}
