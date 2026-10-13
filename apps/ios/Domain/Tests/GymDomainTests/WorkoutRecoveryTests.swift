import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

// A saved copy the phone would hold after a sign-in, written straight into the device key.
struct SaveSignedOutWorkouts: Action {
  let workouts: [SignedOutWorkout]
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> [SignedOutWorkout] { try SignedOutWorkout.read(read) }
  func decide(_ loaded: [SignedOutWorkout], ids: IDSource) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    plan.device(SignedOutWorkout.key, .object(JSON.Object(uniqueKeysWithValues: (loaded + workouts).map { ($0.session.id.description, $0.json) })))
    return .write(plan)
  }
}

struct WorkoutRecoveryTests {
  static let now = TrainingTests.now
  let squat = ID<Exercise>("recovery-squat")

  func harness() throws -> Harness {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: Self.now), account: "recovery", rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    _ = try h.runner.run(CreateExercise(Exercise(id: squat, name: "Recovery squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))
    h.sync()
    return h
  }

  func finished(_ id: String, from start: Int64, to finish: Int64, sets: [Int64] = [1_000], routine: Routine? = nil, closedBy: String = "finish") -> SignedOutWorkout {
    let session = Session(id: ID(RecordID(id)), startedAt: Instant(ms: start), finishedAt: Instant(ms: finish), closedBy: closedBy,
                          routineId: routine?.id, plan: routine.map(SessionPlan.init))
    return SignedOutWorkout(session: session, sets: sets.enumerated().map { index, offset in
      TrainingSet(id: ID(RecordID("\(id)-set-\(index)")), sessionId: session.id, exerciseId: squat, weightKg: 60, reps: 5,
                  note: "Private set note", completedAt: Instant(ms: start + offset))
    })
  }

  func open(_ id: String, from start: Int64, sets: [Int64] = [1_000]) -> SignedOutWorkout {
    let session = Session(id: ID(RecordID(id)), startedAt: Instant(ms: start))
    return SignedOutWorkout(session: session, sets: sets.enumerated().map { index, offset in
      TrainingSet(id: ID(RecordID("\(id)-set-\(index)")), sessionId: session.id, exerciseId: squat, weightKg: 60, reps: 5, completedAt: Instant(ms: start + offset))
    })
  }

  func review(_ h: Harness) throws -> [WorkoutRecovery] {
    let notices = try h.notices(GymRefusal.self)
    return try h.runner.read(Gym.scope) { read in
      WorkoutRecovery.review(try SignedOutWorkout.read(read), notices: notices, log: try TrainingLog(read), catalogue: try Catalogue(read))
    }
  }

  func describe(_ review: WorkoutRecovery) -> String {
    "\(review.id) \(review.reason.rawValue) \(review.retry) notices=\(review.noticeIds.count) stranded=\(review.strandedSets.map(\.id.description)) fix=\(review.canFix)"
  }

  @Test func reviewNamesEveryRefusalTheAccountOrThePhoneGives() throws {
    let h = try harness(), day = Self.now - 86_400_000
    let refused: [(SignedOutWorkout, RefusalCode, JSON?)] = [
      (finished("a-overlap", from: day, to: day + 60_000), Gym.Codes.sessionOverlap, nil),
      (finished("b-id-taken", from: day + 100_000, to: day + 160_000), .idTaken, nil),
      (finished("c-instant", from: day + 200_000, to: day + 260_000), Gym.Codes.badInstant, nil),
      (finished("d-exercise", from: day + 300_000, to: day + 360_000), Gym.Codes.unknownExercise, nil),
      (finished("e-parent-dead", from: day + 400_000, to: day + 460_000), .parentDead, nil),
      (finished("f-conflict", from: day + 500_000, to: day + 560_000), Gym.Codes.payloadConflict, nil),
      (finished("g-stale-copy", from: day + 600_000, to: day + 660_000), .stale, nil),
    ]
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: refused.map(\.0)))
    h.sync()
    for (workout, code, detail) in refused {
      #expect(try h.runner.run(AdoptWorkout(workout.session.id, mode: .keep)).receipt != nil)
      h.server.refuse(code: code, detail: detail)
      h.sync()
    }
    let openWorkout = open("h-open-start", from: day + 700_000)
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [openWorkout]))
    #expect(try h.runner.run(AdoptWorkout(openWorkout.session.id, mode: .restart)).receipt != nil)
    h.server.refuse(code: Gym.Codes.sessionOpen)
    h.sync()
    #expect(try h.drawn(Session.self).isEmpty)
    #expect(try h.notices(GymRefusal.self).count == 8)

    let landed = finished("i-landed", from: day + 800_000, to: day + 860_000)
    #expect(try h.runner.run(landed.importAction).receipt != nil)
    h.sync()
    let saving = finished("n-saving", from: day + 900_000, to: day + 960_000)
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [
      finished("j-many-sets", from: day + 1_000_000, to: day + 1_300_000, sets: (0..<201).map { Int64($0) }),
      finished("k-late-set", from: day + 1_400_000, to: day + 1_460_000, sets: [70_000]),
      finished("l-crossing", from: day + 830_000, to: day + 890_000),
      finished("m-unsent", from: day + 1_500_000, to: day + 1_560_000),
      saving, open("o-open-again", from: day + 1_600_000),
    ]))
    #expect(try h.runner.run(AdoptWorkout(saving.session.id, mode: .keep)).receipt != nil)
    _ = try h.runner.run(StartSession(id: ID("account-open"), startedAt: Instant(ms: Self.now - 60_000)))

    let reviews = try review(h)
    #expect(reviews.map(describe) == [
      "a-overlap session-overlap importWorkout notices=1 stranded=[] fix=true",
      "b-id-taken id-taken importWorkout notices=1 stranded=[] fix=false",
      "c-instant bad-instant importWorkout notices=1 stranded=[] fix=true",
      "d-exercise unknown-exercise importWorkout notices=1 stranded=[] fix=true",
      "e-parent-dead other importWorkout notices=1 stranded=[] fix=true",
      "f-conflict id-taken importWorkout notices=1 stranded=[] fix=false",
      "g-stale-copy other importWorkout notices=1 stranded=[] fix=true",
      "h-open-start session-open restartWorkout notices=1 stranded=[] fix=true",
      "j-many-sets too-many-sets importWorkout notices=0 stranded=[] fix=true",
      "k-late-set bad-instant importWorkout notices=0 stranded=[] fix=true",
      "l-crossing session-overlap importWorkout notices=0 stranded=[] fix=true",
      "m-unsent unsent importWorkout notices=0 stranded=[] fix=true",
      "o-open-again session-open restartWorkout notices=0 stranded=[] fix=true",
    ])
    let notices = try h.notices(GymRefusal.self)
    #expect(reviews.prefix(8).map(\.noticeIds) == notices.map { [$0.id] })
    #expect(reviews.prefix(8).map(\.refusal) == notices.map(\.refusal))
    #expect(reviews[0].movementNames == [squat: "Recovery squat"])
    #expect(reviews[9].refusal == .badInstant(Refused(Gym.Codes.badInstant, subject: ID<Session>("k-late-set").ref, path: .predicted)))
    #expect(reviews[10].refusal == .sessionOverlap(Refused(Gym.Codes.sessionOverlap, subject: ID<Session>("l-crossing").ref, detail: ["sessionId": landed.session.id.json], path: .predicted)))
    #expect(reviews[11].refusal == nil)
    #expect(reviews[12].refusal == .sessionOpen(Refused(Gym.Codes.sessionOpen, subject: ID<Session>("o-open-again").ref, path: .predicted)))
    if case .invalid(let violation) = reviews[8].refusal { #expect(violation.rule == "session.sets") } else { Issue.record("201 sets are refused by the import's own check") }
  }

  @Test func fixRevisesTheCopyAndChecksItBeforeTheAccount() throws {
    let routine = Routine(id: ID("fix-routine"), name: "Private routine", entries: [RoutineEntry(exerciseId: squat)])
    let original = finished("fixed-copy", from: Self.now - 100_000, to: Self.now - 80_000, sets: [1_000, 2_000], routine: routine, closedBy: "stale")
    var fix = WorkoutFix(original)
    #expect(!fix.isChanged && fix.hasRoutine && fix.keepsRoutine && !fix.isOpen && fix.workout == original)
    #expect(fix.sets.map(\.id) == original.sets.map(\.id))
    fix.keepsRoutine = false
    fix.startedAt = Instant(ms: Self.now - 90_000); fix.finishedAt = Instant(ms: Self.now - 70_000)
    fix.sets[0].weightKg = 62.5; fix.sets[0].completedAt = Instant(ms: Self.now - 85_000); fix.sets[0].note = ""
    fix.sets[1].completedAt = Instant(ms: Self.now - 75_000)
    let revised = fix.workout
    #expect(fix.isChanged && revised.session == Session(id: original.session.id, startedAt: fix.startedAt, finishedAt: fix.finishedAt, closedBy: "finish"))
    #expect(revised.sets == [
      TrainingSet(id: original.sets[0].id, sessionId: original.session.id, exerciseId: squat, weightKg: 62.5, reps: 5, completedAt: Instant(ms: Self.now - 85_000)),
      TrainingSet(id: original.sets[1].id, sessionId: original.session.id, exerciseId: squat, weightKg: 60, reps: 5, note: "Private set note", completedAt: Instant(ms: Self.now - 75_000)),
    ])
    let moment = Moment(now: Instant(ms: Self.now), zone: FixedZone(offsetSeconds: 0))
    #expect(fix.refusal(at: moment, among: []) == nil)
    let crossing = Session(id: ID("account-earlier"), startedAt: Instant(ms: Self.now - 72_000), finishedAt: Instant(ms: Self.now - 10_000), closedBy: "finish")
    #expect(fix.refusal(at: moment, among: [crossing, original.session]) == .sessionOverlap(Refused(Gym.Codes.sessionOverlap, subject: original.session.id.ref, detail: ["sessionId": crossing.id.json], path: .predicted)))
    fix.sets.removeLast()
    fix.finishedAt = Instant(ms: Self.now - 86_000)
    #expect(fix.refusal(at: moment, among: []) == .badInstant(Refused(Gym.Codes.badInstant, subject: original.session.id.ref, path: .predicted)))
    fix.sets[0].reps = 0
    fix.finishedAt = Instant(ms: Self.now - 70_000)
    #expect(fix.refusal(at: moment, among: []) == .invalid(Violation(rule: "set.reps", path: "reps", reason: .below(min: 1))))
    fix.sets[0].reps = 5; fix.finishedAt = nil
    #expect(fix.isOpen && fix.workout.session.isOpen && fix.workout.session.closedBy == nil)
    let accountOpen = Session(id: ID("account-open"), startedAt: Instant(ms: Self.now - 5_000))
    #expect(fix.refusal(at: moment, among: [accountOpen, original.session]) == .sessionOpen(Refused(Gym.Codes.sessionOpen, subject: original.session.id.ref, path: .predicted)))
    fix.markFinished()
    #expect(fix.finishedAt == Instant(ms: Self.now - 85_000) && fix.workout.session.closedBy == "finish")
    #expect(fix.refusal(at: moment, among: [accountOpen]) == nil)
    #expect(WorkoutFix(finished("stale-kept", from: Self.now - 50_000, to: Self.now - 40_000, closedBy: "stale")).workout.session.closedBy == "stale")
  }

  @Test func keepRefusesWhatThePhoneSeesAndLandsTheRevisedCopy() throws {
    let h = try harness()
    let landed = finished("on-the-log", from: Self.now - 100_000, to: Self.now - 80_000)
    #expect(try h.runner.run(landed.importAction).receipt != nil)
    h.sync()
    let saved = finished("crossing", from: Self.now - 90_000, to: Self.now - 70_000, sets: [1_000, 15_000])
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [saved]))
    #expect(try h.runner.run(AdoptWorkout(saved.session.id, mode: .keep)).refusal
      == .sessionOverlap(Refused(Gym.Codes.sessionOverlap, subject: saved.session.id.ref, detail: ["sessionId": landed.session.id.json], path: .predicted)))
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) } == [saved])
    #expect(try h.runner.read(Gym.scope) { try $0.commands().isEmpty })
    var fix = WorkoutFix(saved)
    fix.startedAt = Instant(ms: Self.now - 60_000); fix.finishedAt = Instant(ms: Self.now - 40_000)
    fix.sets[0].completedAt = Instant(ms: Self.now - 59_000); fix.sets[1].completedAt = Instant(ms: Self.now - 45_000)
    #expect(try h.runner.run(AdoptWorkout(saved.session.id, mode: .keep, revised: fix.workout)).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) } == [fix.workout])
    let command = try #require(try h.runner.read(Gym.scope) { try $0.commands().first })
    #expect(command.command.name == Gym.Commands.importSession && command.command.args["startedAt"] == .of(fix.startedAt) && command.command.args["finishedAt"] == .of(fix.finishedAt))
    h.sync()
    #expect(try h.notices(GymRefusal.self).isEmpty)
    #expect(try h.stored(Session.self).map(\.id) == [saved.session.id, landed.session.id])
    #expect(try h.stored(TrainingSet.self).filter { $0.sessionId == saved.session.id }.map(\.completedAt) == [Instant(ms: Self.now - 59_000), Instant(ms: Self.now - 45_000)])
    #expect(try h.runner.run(AdoptWorkout(saved.session.id, mode: .keep)).refusal == .taken(saved.session.id.ref, .predicted))
    #expect(try h.runner.run(ReconcileAdoptedWorkouts()).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0).isEmpty })
  }

  @Test func aServerRefusalLeavesTheCopyAndRetryQueuesAFreshImport() throws {
    let h = try harness()
    let saved = finished("refused-once", from: Self.now - 100_000, to: Self.now - 80_000)
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [saved]))
    let first = try #require(try h.runner.run(AdoptWorkout(saved.session.id, mode: .keep)).receipt)
    h.server.refuse(code: Gym.Codes.sessionOverlap, detail: ["sessionId": "elsewhere"])
    h.sync()
    #expect(try h.drawn(Session.self).isEmpty)
    #expect(try h.runner.read(Gym.scope) { try $0.commands().isEmpty })
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) } == [saved])
    let notice = try #require(try h.notices(GymRefusal.self).first)
    #expect(notice.gestureId == first.gestureId && notice.subject == saved.session.id.ref)
    #expect(try review(h).map(describe) == ["refused-once session-overlap importWorkout notices=1 stranded=[] fix=true"])
    let retried = try #require(try h.runner.run(AdoptWorkout(saved.session.id, mode: .keep)).receipt)
    #expect(retried.gestureId != first.gestureId)
    #expect(try h.runner.run(AdoptWorkout(saved.session.id, mode: .keep)).receipt == nil)
    #expect(try review(h).isEmpty)
    h.sync()
    #expect(try h.stored(Session.self).map(\.id) == [saved.session.id])
    #expect(try h.stored(TrainingSet.self).map(\.id) == saved.sets.map(\.id))
    #expect(try h.notices(GymRefusal.self).map(\.id) == [notice.id])
  }

  @Test func discardDropsOneSavedCopyAndTheRowWithTheLast() throws {
    let h = try harness()
    let first = finished("discard-first", from: Self.now - 100_000, to: Self.now - 90_000)
    let second = finished("discard-second", from: Self.now - 80_000, to: Self.now - 70_000)
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [first, second]))
    #expect(try h.runner.run(DiscardSignedOutWorkout(first.session.id)).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) } == [second])
    #expect(try h.runner.run(DiscardSignedOutWorkout(first.session.id)).receipt == nil)
    #expect(try h.runner.run(DiscardSignedOutWorkout(second.session.id)).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try $0.device(SignedOutWorkout.key) } == nil)
    #expect(try h.runner.read(Gym.scope) { try $0.commands().isEmpty })
    #expect(try review(h).isEmpty)
  }

  @Test func restartResubmitsAnOpenWorkoutsStartWithoutJoiningAndItsSetsFollow() throws {
    let h = try harness()
    let saved = open("reopened", from: Self.now - 30_000, sets: [1_000, 2_000])
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [saved]))
    #expect(try h.runner.run(AdoptWorkout(saved.session.id, mode: .restart)).receipt != nil)
    let start = try #require(try h.runner.read(Gym.scope) { try $0.commands().first })
    #expect(start.command.name == Gym.Commands.start && start.command.args["joinOpenSession"] == false && start.command.args["id"] == saved.session.id.json)
    #expect(try h.drawn(Session.self).map(\.isOpen) == [true])
    #expect(try h.drawn(TrainingSet.self).isEmpty)
    for set in saved.sets { #expect(try h.runner.run(AppendSet(set)).receipt != nil) }
    h.sync()
    #expect(try h.stored(Session.self).map { ($0.id, $0.isOpen) }.elementsEqual([(saved.session.id, true)], by: ==))
    #expect(try h.stored(TrainingSet.self).map(\.id) == saved.sets.map(\.id))
    #expect(try h.runner.run(AdoptWorkout(saved.session.id, mode: .restart)).refusal == .taken(saved.session.id.ref, .predicted))
    let another = open("second-open", from: Self.now - 10_000)
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [another]))
    #expect(try h.runner.run(AdoptWorkout(another.session.id, mode: .restart)).refusal == .sessionOpen(Refused(Gym.Codes.sessionOpen, subject: another.session.id.ref, path: .predicted)))
    let closed = finished("already-finished", from: Self.now - 200_000, to: Self.now - 190_000)
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [closed]))
    #expect(try h.runner.run(AdoptWorkout(closed.session.id, mode: .restart)).refusal == .sessionFinished(Refused(Gym.Codes.sessionFinished, subject: closed.session.id.ref, path: .predicted)))
    #expect(try h.runner.run(ReconcileAdoptedWorkouts()).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0).map(\.session.id) } == [closed.session.id, another.session.id])
  }

  @Test func strandedSetsReturnToTheirWorkoutOrMakeASeparateOne() throws {
    let h = try harness()
    let id = ID<Session>("landed-open"), start = Instant(ms: Self.now - 100_000)
    #expect(try h.runner.run(StartSession(id: id, startedAt: start)).receipt != nil)
    h.sync()
    let inside = TrainingSet(id: ID("inside-set"), sessionId: id, exerciseId: squat, weightKg: 60, reps: 5, completedAt: Instant(ms: Self.now - 90_000))
    let late = TrainingSet(id: ID("late-set"), sessionId: id, exerciseId: squat, weightKg: 65, reps: 3, kind: "drop", rpe: 8, note: "Private late note", completedAt: Instant(ms: Self.now - 50_000))
    #expect(try h.runner.run(AppendSet(inside)).receipt != nil)
    #expect(try h.runner.run(AppendSet(late)).receipt != nil)
    #expect(try h.runner.run(FinishSession(id: id, finishedAt: Instant(ms: Self.now - 70_000))).receipt != nil)
    let saved = SignedOutWorkout(session: Session(id: id, startedAt: start), sets: [inside, late])
    _ = try h.runner.run(SaveSignedOutWorkouts(workouts: [saved]))
    h.server.refuse(next: 2, code: Gym.Codes.sessionFinished)
    h.sync()
    #expect(try h.stored(Session.self).map { ($0.id, $0.finishedAt) }.elementsEqual([(id, Instant(ms: Self.now - 70_000))], by: ==))
    #expect(try h.stored(TrainingSet.self).isEmpty)
    #expect(try h.notices(GymRefusal.self).map(\.subject) == [inside.id.ref, late.id.ref])
    #expect(try review(h).map(describe) == ["landed-open session-finished restoreSets notices=2 stranded=[\"inside-set\", \"late-set\"] fix=false"])
    let notices = try h.notices(GymRefusal.self)
    #expect(notices.map(saved.owns) == [true, true])
    #expect(notices.map(SignedOutWorkout(session: saved.session, sets: [inside]).owns) == [true, false])

    #expect(try h.runner.run(RecoverStrandedSets(id, .intoWorkout)).receipt != nil)
    let correction = try #require(try h.runner.read(Gym.scope) { try $0.commands().first })
    #expect(correction.command.name == Gym.Commands.correctSession && correction.command.args["preserveOtherSets"] == true)
    #expect(correction.command.args["startedAt"] == .of(start) && correction.command.args["finishedAt"] == .of(Instant(ms: Self.now - 70_000)))
    #expect(correction.command.args["sets"] == .array([CorrectedSet(id: inside.id, exerciseId: squat, setNumber: 1, weightKg: 60, reps: 5, completedAt: inside.completedAt, rpe: nil, note: "", rpeNamed: true, kind: "working").json]))
    #expect(try h.drawn(TrainingSet.self).map(\.id) == [inside.id])
    #expect(try review(h).map(describe) == ["landed-open session-finished restoreSets notices=2 stranded=[\"late-set\"] fix=false"])
    #expect(try h.runner.run(RecoverStrandedSets(id, .intoWorkout)).receipt == nil)
    #expect(try h.runner.run(RecoverStrandedSets(id, .separately)).receipt != nil)
    let separate = try #require(try h.runner.read(Gym.scope) { try $0.commands().last })
    #expect(separate.command.name == Gym.Commands.importSession && separate.command.args["id"] != id.json)
    #expect(separate.command.args["startedAt"] == .of(late.completedAt) && separate.command.args["finishedAt"] == .of(late.completedAt))
    #expect(separate.command.args["sets"] == .array([ImportedSet(id: late.id, exerciseId: squat, weightKg: 65, reps: 3, completedAt: late.completedAt, kind: "drop", rpe: 8, note: "Private late note", rpeNamed: true).json]))
    #expect(try h.runner.run(RecoverStrandedSets(id, .separately)).receipt == nil)
    #expect(try review(h).isEmpty && h.notices(GymRefusal.self).count == 2)
    h.sync()
    #expect(try h.notices(GymRefusal.self).count == 2)
    let sessions = try h.stored(Session.self)
    #expect(sessions.count == 2 && sessions.first { $0.id == id }?.finishedAt == Instant(ms: Self.now - 70_000))
    let separateSession = try #require(sessions.first { $0.id != id })
    #expect(separateSession.startedAt == late.completedAt && separateSession.finishedAt == late.completedAt && separateSession.closedBy == "finish")
    let sets = try h.stored(TrainingSet.self)
    #expect(sets.map { ($0.id, $0.sessionId) }.elementsEqual([(inside.id, id), (late.id, separateSession.id)], by: ==))
    #expect(sets.first?.setNumber == 1)
    #expect(sets.map(\.note) == ["", "Private late note"])
    #expect(try h.runner.run(ReconcileAdoptedWorkouts()).receipt != nil)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0).isEmpty })
    #expect(try h.runner.run(RecoverStrandedSets(id, .intoWorkout)).receipt == nil)
  }
}
