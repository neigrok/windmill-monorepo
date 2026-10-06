import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncSchema
import SyncCore
import SyncEngine
import SyncModelServer
import SyncStore
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct RenameMovementTests {
  func fixture(account: String? = nil) -> (Harness, GymModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: account,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }

  @Test func nameRefusalsNoChangeAndCounterMatchAndroidCodePoints() {
    #expect(MovementName.problem(" \n\t ") == "Name it to save it.")
    #expect(MovementName.problem(String(repeating: "a", count: 61)) == "Use 60 characters or fewer.")
    #expect(MovementName.problem("  Row \n") == nil)
    #expect(!MovementName.changed(from: "Row", to: " Row \n"))
    #expect(MovementName.changed(from: "Row", to: "Renamed row"))
    #expect(MovementName.counter(String(repeating: "a", count: 47)) == nil)
    #expect(MovementName.counter(String(repeating: "a", count: 48)) == "48/60")
    let scalars = String(repeating: "😀", count: 61)
    #expect(MovementName.capped(scalars) == String(repeating: "😀", count: 60))
    #expect(MovementName.counter(MovementName.capped(scalars)) == "60/60")
    #expect(MovementName.capped(String(repeating: "e\u{301}", count: 31)).unicodeScalars.count == 60)
  }

  @Test func anonymousCatalogueRenameRefusesAndCustomRenameCanStayOnDevice() throws {
    let (harness, gym) = fixture()
    let seed = try #require(gym.catalogue.find(ID("back-squat")))
    #expect(!gym.renameMovement(seed, to: "My squat"))
    #expect(gym.error == "renaming a catalog movement needs your account — sign in first")
    #expect(gym.catalogue.find(seed.id) == seed)
    let custom = Exercise(id: gym.runner.mint(Exercise.self), name: "Custom squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)
    gym.run(CreateExercise(custom))
    #expect(gym.renameMovement(custom, to: " Renamed squat "))
    let renamed = try #require(gym.catalogue.find(custom.id))
    #expect(renamed.id == custom.id && renamed.name == "Renamed squat" && renamed.aliases == ["Custom squat"])
    #expect(MovementPickerOptions.matching(query: "custom squat", catalogue: gym.catalogue.exercises, selected: [], log: gym.log).matches.first?.id == custom.id)
    harness.sync(); gym.refresh()
    #expect(harness.server.rows(Gym.scope, of: nil).isEmpty)
  }

  @Test func renameKeepsRoutinePlanSetAndRecordIdentities() throws {
    let (harness, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "Custom press", pattern: "press", equipment: "barbell", stepKg: 2.5)
    gym.run(CreateExercise(exercise))
    var routine = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Press day", entries: [RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 8, weightKg: 60)])]))
    _ = gym.save(&routine)
    let sessionId = gym.runner.mint(Session.self)
    gym.run(StartSession(id: sessionId, routineId: routine.current.id))
    let now = try gym.runner.moment().now
    let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: sessionId, exerciseId: exercise.id, weightKg: 60, reps: 8, completedAt: now)
    gym.run(AppendSet(set)); harness.advance(ms: 1_000); gym.run(FinishSession(id: sessionId))
    let history = gym.sessions, sets = gym.sets, routines = gym.routines
    let before = try #require(gym.log).progress.movement(exercise.id)
    #expect(gym.renameMovement(exercise, to: "Renamed press"))
    #expect(gym.catalogue.find(exercise.id)?.name == "Renamed press")
    #expect(gym.sessions == history && gym.sets == sets && gym.routines == routines)
    #expect(try #require(gym.log).progress.movement(exercise.id) == before)
    #expect(gym.sessions.first?.plan?.entries.first?.exerciseId == exercise.id)
  }

  @Test func failedRenameKeepsTheSameMovementAndCanRetryWithoutAnotherIdentity() throws {
    let (harness, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "Original", pattern: "isolation", equipment: "machine", stepKg: 5)
    gym.run(CreateExercise(exercise))
    harness.failNextCommit()
    #expect(!gym.renameMovement(exercise, to: "Renamed"))
    #expect(gym.error == "Gym could not save this change. Try again." && gym.catalogue.find(exercise.id) == exercise)
    #expect(gym.renameMovement(exercise, to: "Renamed"))
    #expect(gym.catalogue.exercises.filter { $0.id == exercise.id }.map(\.name) == ["Renamed"])
  }

  @Test func noChangeAndInvalidNameNeverWriteAndAccountTransitionRefuses() throws {
    let (_, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "Original", pattern: "isolation", equipment: "machine", stepKg: 5)
    gym.run(CreateExercise(exercise))
    #expect(!gym.renameMovement(exercise, to: " Original \n"))
    #expect(gym.catalogue.find(exercise.id) == exercise)
    #expect(!gym.renameMovement(exercise, to: " \n") && gym.error == "Name it to save it.")
    #expect(!gym.renameMovement(exercise, to: String(repeating: "x", count: 61)) && gym.error == "Use 60 characters or fewer.")
    gym.accountTransition = true
    #expect(!gym.renameMovement(exercise, to: "Renamed") && gym.error == "Wait for the account change to finish.")
    #expect(gym.catalogue.find(exercise.id) == exercise)
  }

  @Test func alreadyGoneMovementKeepsTheRenameRefusal() {
    let (_, gym) = fixture()
    let missing = Exercise(id: ID("missing-movement"), name: "Gone", pattern: "isolation", equipment: "machine", stepKg: 5)
    #expect(!gym.renameMovement(missing, to: "Renamed"))
    #expect(gym.refusal != nil && gym.error == "This is no longer available.")
  }

  @Test func staleRenamePreservesTheLatestNameAndAlias() throws {
    let (_, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "Original", pattern: "isolation", equipment: "machine", stepKg: 5)
    gym.run(CreateExercise(exercise))
    #expect(gym.renameMovement(exercise, to: "First rename"))
    #expect(!gym.renameMovement(exercise, to: "Stale rename"))
    #expect(gym.error == "That movement changed. Review its name.")
    #expect(gym.catalogue.find(exercise.id)?.name == "First rename")
    #expect(gym.catalogue.find(exercise.id)?.aliases == ["Original"])
  }

  @Test func accountRenameMakesFormerNameSearchableBeforeAndAfterSync() async throws {
    let transport = JournalModelTransport(), store = try Store.inMemory(registry: SyncSchema.registry)
    let tokens = InMemoryTokenStore()
    let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios), store: store,
                                transport: transport, tokens: tokens, forkGuard: InMemoryForkGuardStore(),
                                clock: .system, random: SeededRandomSource(seed: 17), connectivity: SwitchedConnectivity())
    let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    let runtime = AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]), store: store, engine: engine,
                             auth: NativeAuth(baseURL: URL(string: "https://gym.invalid")), runner: runner,
                             tokens: tokens, revocations: InMemoryTokenStore())
    defer { try? engine.leave() }
    let identity = transport.identity(email: "movement-owner@example.com")
    _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    let seed = try #require(gym.catalogue.find(ID("back-squat")))
    #expect(gym.renameMovement(seed, to: "My squat"))
    #expect(gym.catalogue.find(seed.id)?.aliases == ["Back Squat"])
    let immediate = MovementPickerOptions.matching(query: "back squat", catalogue: gym.catalogue.exercises, selected: [], log: gym.log)
    #expect(immediate.matches.map(\.id) == [seed.id] && immediate.matches.first?.alias == "Back Squat")
    await engine.start(); await engine.flushOnLeave(); engine.foreground()
    let scope = ScopeKey(.product(account: identity.account, name: "gym")), key = RecordKey(ExerciseName.type, seed.id.record)
    #expect(transport.state.withLock { $0.server.state.rows[scope]?[key]?.lattice.fields["aliases"]?.value } == .array([.string("Back Squat")]))
    for _ in 0..<100 where gym.catalogue.find(seed.id)?.aliases.contains("Back Squat") != true {
      try await Task.sleep(for: .milliseconds(5)); gym.refresh()
    }
    let renamed = try #require(gym.catalogue.find(seed.id))
    #expect(renamed.name == "My squat" && renamed.id == seed.id && renamed.aliases.contains("Back Squat"))
    let search = MovementPickerOptions.matching(query: "back squat", catalogue: gym.catalogue.exercises, selected: [], log: gym.log)
    #expect(search.matches.map(\.id) == [seed.id] && search.matches.first?.alias == "Back Squat")
  }
}
