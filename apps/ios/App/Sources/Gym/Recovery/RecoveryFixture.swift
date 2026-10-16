import Foundation
import DomainKit
import GymDomain
import SyncCore
import SyncEngine
import SyncSchema

// `-board recovery`: a signed-in account whose phone holds a saved workout for every reason the log can give, reached
// through the real engine — the phone's own checks (a crossing, a late set, a missing movement, over 200 sets),
// refusals from the model server, and a set a landed workout refused.
// `recovery-paused` revokes the session first, so one workout waits on its way and the rest wait on sign-in.
enum RecoveryFixture {
  #if DEBUG && targetEnvironment(simulator)
  struct Save: Action {
    let workouts: [SignedOutWorkout]
    var scope: ScopeRef { Gym.scope }
    func load(_ read: Reader) throws -> [SignedOutWorkout] { try SignedOutWorkout.read(read) }
    func decide(_ saved: [SignedOutWorkout], ids: IDSource) -> Decision<Void, GymRefusal> {
      var plan = Plan()
      plan.device(SignedOutWorkout.key, .object(JSON.Object(uniqueKeysWithValues: (saved + workouts).map { ($0.session.id.description, $0.json) })))
      return .write(plan)
    }
  }
  #endif

  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("recovery") else { return false }
    model.openRoom(.gym)
    let gym = model.gym
    do {
      guard let runtime = gym.runtime, let server = runtime.auth.fake else { throw AppFailure(message: "no model server") }
      let identity = server.identity(email: "recovery-fixture@example.com")
      _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
      await runtime.engine.start()
      try await settled(gym) { $0.log?.firstPullComplete == true }
      let seed = Seed(gym: gym, now: try gym.runner.moment().now.ms)
      if board == "recovery-paused" {
        try await seed.paused(runtime: runtime, token: identity.token)
      } else {
        try await seed.everyReason(runtime: runtime, server: server)
      }
      gym.refresh(); gym.error = nil; gym.refusal = nil
    } catch {
      NSLog("Recovery fixture failed: %@", String(describing: error))
      gym.error = "The recovery fixture could not be prepared."
    }
    return true
    #else
    return false
    #endif
  }

  #if DEBUG && targetEnvironment(simulator)
  static func settled(_ gym: GymModel, _ ready: (GymModel) -> Bool) async throws {
    for _ in 0..<100 {
      gym.refresh()
      if ready(gym) { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw AppFailure(message: "the recovery fixture did not settle")
  }

  struct Seed {
    static let hour: Int64 = 3_600_000
    static let day: Int64 = 86_400_000
    let gym: GymModel
    let now: Int64

    func routine(_ name: String, _ exercise: String) throws -> Routine {
      var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: name, entries: [RoutineEntry(exerciseId: ID(RecordID(exercise)))]))
      guard case .saved = gym.runner.save(&draft, SaveDraft<Routine, GymRefusal>.self) else { throw AppFailure(message: "routine refused") }
      return draft.current
    }

    // A copy of `count` sets three minutes apart from `start`; `finish` nil leaves it open.
    func copy(_ id: String, routine: Routine?, exercise: String, start: Int64, finish: Int64?, count: Int,
              late: Bool = false) -> SignedOutWorkout {
      let session = Session(id: ID(RecordID(id)), startedAt: Instant(ms: start), finishedAt: finish.map(Instant.init(ms:)),
                            closedBy: finish == nil ? nil : "finish", routineId: routine?.id, plan: routine.map(SessionPlan.init))
      return SignedOutWorkout(session: session, sets: (0..<count).map { index -> TrainingSet in
        let last = index == count - 1
        let completed: Int64 = start + Int64(index + 1) * 180_000 + (late && last ? Self.day : 0)
        return TrainingSet(id: ID(RecordID("\(id)-set-\(index)")), sessionId: session.id, exerciseId: ID(RecordID(exercise)),
                           weightKg: index == 0 ? 60 : 80, reps: index == 0 ? 8 : 5, kind: index == 0 ? "warmup" : "working",
                           rpe: last ? 8 : nil, completedAt: Instant(ms: completed))
      })
    }

    func run<A: Action>(_ action: A) throws where A.Refusal == GymRefusal {
      guard try gym.runner.run(action).refusal == nil else { throw AppFailure(message: "fixture action refused") }
    }

    // Each copy the account refuses goes alone, so the model server's refusal answers its import and nothing else.
    func refused(_ workout: SignedOutWorkout, _ code: RefusalCode, runtime: AppRuntime, server: JournalModelTransport) async throws {
      try run(Save(workouts: [workout]))
      server.state.withLock { $0.server.refuse(code: code) }
      try run(AdoptWorkout(workout.session.id, mode: .keep))
      await runtime.engine.flushOnLeave()
    }

    func everyReason(runtime: AppRuntime, server: JournalModelTransport) async throws {
      let push = try routine("Push A", "bench-press"), pull = try routine("Pull A", "barbell-row"), legs = try routine("Legs", "back-squat")
      let crossed = ID<Session>(RecordID("fixture-account-lower"))
      try run(ImportSession(id: crossed, startedAt: Instant(ms: now - 2 * Self.day), finishedAt: Instant(ms: now - 2 * Self.day + Self.hour),
        sets: [ImportedSet(id: ID(RecordID("fixture-account-lower-set")), exerciseId: ID("back-squat"), weightKg: 100, reps: 5,
                           completedAt: Instant(ms: now - 2 * Self.day + 600_000))]))
      let landed = ID<Session>(RecordID("fixture-landed-push"))
      try run(StartSession(id: landed, routineId: push.id, startedAt: Instant(ms: now - 3 * Self.day)))
      await runtime.engine.flushOnLeave()
      let stranded = TrainingSet(id: ID(RecordID("fixture-stranded-set")), sessionId: landed, exerciseId: ID("bench-press"),
                                 weightKg: 82.5, reps: 5, completedAt: Instant(ms: now - 3 * Self.day + 300_000))
      server.state.withLock { $0.server.refuse(code: Gym.Codes.sessionFinished) }
      try run(AppendSet(stranded))
      try run(FinishSession(id: landed, finishedAt: Instant(ms: now - 3 * Self.day + 600_000)))
      try run(Save(workouts: [SignedOutWorkout(session: Session(id: landed, startedAt: Instant(ms: now - 3 * Self.day), routineId: push.id,
                                                                plan: SessionPlan(push)), sets: [stranded])]))
      await runtime.engine.flushOnLeave()
      try run(StartSession(id: ID(RecordID("fixture-account-open")), startedAt: Instant(ms: now - 1_200_000)))
      gym.refresh(); gym.workout.reconcile()
      guard gym.hideWorkout() else { throw AppFailure(message: "the account workout stayed in front") }
      await runtime.engine.flushOnLeave()
      try await refused(copy("fixture-id-taken", routine: nil, exercise: "barbell-row", start: now - 6 * Self.day, finish: now - 6 * Self.day + Self.hour, count: 4), .idTaken, runtime: runtime, server: server)
      try await refused(copy("fixture-parent-dead", routine: nil, exercise: "overhead-press", start: now - 7 * Self.day, finish: now - 7 * Self.day + Self.hour, count: 3), .parentDead, runtime: runtime, server: server)
      try run(Save(workouts: [
        copy("fixture-missing-movement", routine: nil, exercise: "fixture-retired-movement", start: now - 5 * Self.day, finish: now - 5 * Self.day + Self.hour, count: 3),
        copy("fixture-open-copy", routine: pull, exercise: "barbell-row", start: now - 3 * Self.hour, finish: nil, count: 3),
        copy("fixture-overlap", routine: push, exercise: "bench-press", start: now - 2 * Self.day + 1_800_000, finish: now - 2 * Self.day + 2 * Self.hour, count: 12),
        copy("fixture-late-set", routine: legs, exercise: "back-squat", start: now - 4 * Self.day, finish: now - 4 * Self.day + Self.hour, count: 4, late: true),
        copy("fixture-many-sets", routine: nil, exercise: "bench-press", start: now - 8 * Self.day, finish: now - 8 * Self.day + 3 * Self.hour, count: 201),
        copy("fixture-unsent", routine: nil, exercise: "romanian-deadlift", start: now - 9 * Self.day, finish: now - 9 * Self.day + Self.hour, count: 3),
      ]))
      await runtime.engine.flushOnLeave()
      try await settled(gym) { $0.workoutsToReview.count == 9 }
    }

    func paused(runtime: AppRuntime, token: SessionToken) async throws {
      let push = try routine("Push A", "bench-press")
      let sending = copy("fixture-sending", routine: push, exercise: "bench-press", start: now - Self.day, finish: now - Self.day + Self.hour, count: 6)
      try run(Save(workouts: [sending, copy("fixture-unsent", routine: nil, exercise: "back-squat", start: now - 2 * Self.day, finish: now - 2 * Self.day + Self.hour, count: 3)]))
      try await runtime.auth.logout(token: token)
      try run(AdoptWorkout(sending.session.id, mode: .keep))
      await runtime.engine.flushOnLeave()
      try await settled(gym) { $0.authPaused && $0.workoutsToReview.count == 1 }
    }
  }
  #endif
}
