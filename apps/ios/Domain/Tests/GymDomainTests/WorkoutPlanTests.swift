import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
import Testing

struct WorkoutPlanTests {
  static let now: Int64 = 1_800_000_000_000
  static let routineId = ID<Routine>(RecordID("routine1"))
  static let sessionId = ID<Session>(RecordID("session1"))
  static let entries = [
    RoutineEntry(exerciseId: ID("squat001"), sets: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 3), restSeconds: 180),
    RoutineEntry(exerciseId: ID("pullup01"), sets: Array(repeating: SetTarget(reps: 8, weightKg: 10), count: 3), restSeconds: 120),
  ]

  // A phone with three movements of its own, the routine of two of them on the log, and its workout started from it.
  static func phone() throws -> Harness {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: now), rules: GymServerRules())
    for (id, equipment) in [("squat001", "barbell"), ("pullup01", "bodyweight"), ("facepull", "cable")] {
      _ = try h.runner.run(CreateExercise(Exercise(id: ID(RecordID(id)), name: id, pattern: "pull", equipment: equipment, stepKg: 2.5)))
    }
    var routine = Draft(new: Routine(id: routineId, name: "Upper A", entries: entries))
    try #require(saved(h.runner.save(&routine, SaveRoutine.self)))
    h.sync()
    _ = try #require(committed(h.runner.run(StartSession(id: sessionId, routineId: routineId))))
    h.sync()
    return h
  }

  static func plan(_ h: Harness) throws -> SessionPlan? { try h.drawn(Session.self).first { $0.id == sessionId }?.plan }

  static func revise(_ h: Harness, _ operations: [WorkoutPlan.Operation]) throws -> Outcome<Void, GymRefusal> {
    try h.runner.run(ReviseWorkoutPlan(sessionId: sessionId, base: try plan(h), operations: operations))
  }

  static func set(_ h: Harness, _ exercise: String) -> TrainingSet {
    TrainingSet(id: h.runner.mint(TrainingSet.self), sessionId: sessionId, exerciseId: ID(RecordID(exercise)), weightKg: 10, reps: 8,
                completedAt: Instant(ms: h.clock.nowMs()))
  }

  @Test func aRevisionLandsOnEveryPhoneAsTheWholePlan() throws {
    let a = try Self.phone(), b = a.device()
    a.sync()
    #expect(try Self.revise(a, [.retarget(index: 1, set: 0, target: SetTarget(reps: 6, weightKg: 12.5)), .addMovement(ID("facepull"))]).receipt != nil)
    let revised = SessionPlan(routine: "Upper A", entries: [
      Self.entries[0],
      RoutineEntry(exerciseId: ID("pullup01"), sets: [SetTarget(reps: 6, weightKg: 12.5), SetTarget(reps: 8, weightKg: 10), SetTarget(reps: 8, weightKg: 10)],
                   restSeconds: 120),
      RoutineEntry(exerciseId: ID("facepull")),
    ])
    #expect(try Self.plan(a) == revised)
    a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(try Self.plan(b) == revised)
    #expect(try b.stored(Routine.self).map(\.entries) == [Self.entries])
  }

  // Two phones edit the plan they both read: the one that lands second was guarded on a plan that moved, so the log refuses
  // it as stale and its phone draws the first edit, which it may edit again.
  @Test func anEditOfAPlanAnotherPhoneChangedReturnsAsAStaleNotice() throws {
    let a = try Self.phone(), b = a.device()
    a.sync()
    #expect(try Self.revise(a, [.removeMovement(index: 1)]).receipt != nil)
    #expect(try Self.revise(b, [.setRest(index: 1, restSeconds: 90)]).receipt != nil)
    #expect(try Self.plan(b)?.entries.map(\.restSeconds) == [180, 90])
    a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(try b.notices(GymRefusal.self).map(\.refusal) == [.stale(Self.sessionId.ref, .notice)])
    #expect(try Self.plan(b)?.entries.map(\.exerciseId) == [ID("squat001")])
    #expect(try Self.revise(b, [.setRest(index: 0, restSeconds: 90)]).receipt != nil)
    a.sync()
    #expect(try Self.plan(a)?.entries == [RoutineEntry(exerciseId: ID("squat001"), sets: Self.entries[0].sets, restSeconds: 90)])
  }

  // A logged set locks its movement, and a deleted one keeps it locked until its delete lands; the other movements and new
  // ones stay open throughout.
  @Test func aLoggedSetLocksItsMovementUntilItsDeleteLands() throws {
    let a = try Self.phone()
    let pull = Self.set(a, "pullup01")
    #expect(try committed(a.runner.run(AppendSet(pull))) == pull.id)
    let locked = GymRefusal(Refused(Gym.Codes.planLogged, subject: Self.sessionId.ref, detail: ["exerciseId": "pullup01"], path: .predicted))
    #expect(try Self.revise(a, [.setRest(index: 1, restSeconds: 90)]).refusal == locked)
    #expect(try Self.revise(a, [.setRest(index: 0, restSeconds: 150)]).receipt != nil)
    let removal = try #require(try a.runner.run(DeleteSet(pull.id)).receipt)
    #expect(try Self.revise(a, [.setRest(index: 1, restSeconds: 90)]).refusal == locked)
    #expect(try a.runner.undo(removal.gestureId))
    _ = try #require(try a.runner.run(DeleteSet(pull.id)).receipt)
    a.advance(ms: Constants.holdMs)
    a.sync()
    #expect(try Self.revise(a, [.setRest(index: 1, restSeconds: 90)]).receipt != nil)
    a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(try Self.plan(a)?.entries.map(\.restSeconds) == [150, 90])
  }

  @Test(arguments: try Contract.vectors("gym/domain/workout-plan-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let fields = try Fields(input)
    let result: JSON
    if let action = vector.input["action"] {
      guard try action.asString() == "ReviseWorkoutPlan" else { throw ContractError("no workout plan action \(action)") }
      let revise = ReviseWorkoutPlan(sessionId: try fields.ref("sessionId", Session.self), base: try SessionPlan.decode(input["base"]),
                                     operations: try input.member("operations").asArray().map(WorkoutPlan.Operation.init(form:)))
      result = try corpus.decision(of: revise, vector, result: { _ in .null }, refusal: \.form)
    } else {
      result = try corpus.read(vector, in: Session.scope) { read in
        switch try vector.input.member("read").asString() {
        case "Prefill":
          let log = try TrainingLog(read)
          let last = log.lastTime(for: try fields.ref("exerciseId", Exercise.self))
          let today = log.sets(session: try fields.ref("todaySessionId", Session.self)).filter { $0.exerciseId == last.exerciseId }
          let prefill = Prefill.of(todaySets: today, planEntry: try fields.optionalValue("planEntry", of: RoutineEntry.self), lastTime: last)
          return ["weightKg": .of(prefill.weightKg), "reps": JSON(prefill.reps)]
        case "TrainingHistory":
          let history = try TrainingHistory(read)
          let id = ID<Session>(RecordID(try input.member("args").asArray()[0].asString()))
          switch try fields.string("method") {
          case "session": return history.session(id)
          case "review": return history.review(id)
          case let method: throw ContractError("no workout plan history read \(method)")
          }
        case "PlanChanges":
          let changes = try PlanChanges(read, session: try fields.ref("sessionId", Session.self))
          return ["changes": .array(changes.changes.map(\.json)), "changeCount": JSON(changes.changeCount), "offer": .string(changes.offer.rawValue)]
        case let read: throw ContractError("no workout plan read \(read)")
        }
      }
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}

extension WorkoutPlan.Operation {
  // An operation as packages/api-contract/gym/domain/README.md writes it.
  init(form: JSON) throws {
    let f = try Fields(form)
    self = switch try f.string("op") {
    case "retarget": .retarget(index: try f.int("index"), set: try f.int("set"), target: try f.value("target", of: SetTarget.self))
    case "add_set": .addSet(index: try f.int("index"))
    case "remove_set": .removeSet(index: try f.int("index"), set: try f.int("set"))
    case "swap": .swap(index: try f.int("index"), exerciseId: try f.ref("exerciseId", Exercise.self))
    case "add_movement": .addMovement(try f.ref("exerciseId", Exercise.self))
    case "remove_movement": .removeMovement(index: try f.int("index"))
    case "set_rest": .setRest(index: try f.int("index"), restSeconds: try f.optionalInt("restSeconds"))
    case let op: throw ContractError("no plan operation \(op)")
    }
  }
}
