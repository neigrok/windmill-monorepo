import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct RoutinePlanTests {
  @Test func creationAndIdentityTargetsCommitTogetherAndServerRefusalRollsEverythingBack() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let seed = try #require(SeedExercises.all.first { $0.id == ID("bench-press") })
    var renamed = seed; renamed.name = "My press"
    let custom = Exercise(id: phone.runner.mint(Exercise.self), name: "Single press", pattern: "press", equipment: "dumbbell", stepKg: 2, loadCount: 1)
    let base = Routine(id: phone.runner.mint(Routine.self))
    var current = base
    current.name = "Push"
    current.entries = [RoutineEntry(exerciseId: seed.id, sets: [SetTarget(reps: 8, weightKg: 60)]), RoutineEntry(exerciseId: custom.id)]
    let action = SaveRoutinePlan(base: base, current: current, isNew: true,
                                 movements: [RoutineMovementChange(base: seed, current: renamed), RoutineMovementChange(base: nil, current: custom)])
    #expect(try phone.runner.run(action).receipt != nil)
    #expect(try phone.drawn(Routine.self) == [current])
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(custom.id) } == custom)
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(seed.id)?.name } == "My press")
    phone.server.refuse(code: .invalid)
    phone.sync()
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.drawn(Exercise.self).isEmpty)
    #expect(try phone.drawn(ExerciseName.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(seed.id) } == seed)
    #expect(try phone.notices(GymRefusal.self).count == 1)
  }

  @Test func failedCommitPreservesTheEntirePlanForRetry() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let custom = Exercise(id: phone.runner.mint(Exercise.self), name: "Press", pattern: "press", equipment: "barbell", stepKg: 2.5)
    let base = Routine(id: phone.runner.mint(Routine.self))
    var current = base; current.name = "Push"; current.entries = [RoutineEntry(exerciseId: custom.id)]
    let action = SaveRoutinePlan(base: base, current: current, isNew: true, movements: [RoutineMovementChange(base: nil, current: custom)])
    phone.failNextCommit()
    #expect(throws: (any Error).self) { try phone.runner.run(action) }
    #expect(try phone.drawn(Routine.self).isEmpty && phone.drawn(Exercise.self).isEmpty)
    #expect(try phone.runner.run(action).receipt != nil)
    #expect(try phone.drawn(Routine.self) == [current])
    #expect(try phone.drawn(Exercise.self) == [custom])
  }

  @Test func staleRoutineRefusesMetadataWithoutAPartialWrite() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let seed = try #require(SeedExercises.all.first { $0.id == ID("bench-press") })
    var draft = Draft(new: Routine(id: phone.runner.mint(Routine.self), name: "Push", entries: [RoutineEntry(exerciseId: seed.id)]))
    #expect(saved(phone.runner.save(&draft, SaveRoutine.self)))
    let base = draft.current
    var current = base; current.entries[0].sets = [SetTarget(reps: 8, weightKg: 60)]
    var renamed = seed; renamed.name = "My press"
    draft.current.entries[0].sets = [SetTarget(reps: 5, weightKg: 80)]
    #expect(saved(phone.runner.save(&draft, SaveRoutine.self)))
    let outcome = try phone.runner.run(SaveRoutinePlan(base: base, current: current, isNew: false,
                                                      movements: [RoutineMovementChange(base: seed, current: renamed)]))
    #expect(outcome.refusal == .stale(base.id.ref, .predicted))
    #expect(try phone.drawn(Routine.self) == [draft.current])
    #expect(try phone.drawn(ExerciseName.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(Catalogue.formerNamesKey) } == nil)
  }

  @Test func staleMovementRefusesRoutineTargetsAndOtherMovementEdits() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let seed = try #require(SeedExercises.all.first { $0.id == ID("bench-press") })
    let base = Routine(id: phone.runner.mint(Routine.self))
    var current = base; current.name = "Push"; current.entries = [RoutineEntry(exerciseId: seed.id, sets: [SetTarget(reps: 8, weightKg: 60)])]
    var renamed = seed; renamed.name = "My press"
    #expect(try phone.runner.run(UpdateExercise(seed.id, name: "Other press")).receipt != nil)
    let outcome = try phone.runner.run(SaveRoutinePlan(base: base, current: current, isNew: true,
                                                      movements: [RoutineMovementChange(base: seed, current: renamed)]))
    #expect(outcome.refusal == .stale(seed.id.ref, .predicted))
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(seed.id)?.name } == "Other press")
  }

  @Test func targetsCannotSaveAgainstEquipmentChangedSinceTheEditorOpened() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let seed = try #require(SeedExercises.all.first { $0.id == ID("bench-press") })
    let base = Routine(id: phone.runner.mint(Routine.self))
    var current = base; current.name = "Push"; current.entries = [RoutineEntry(exerciseId: seed.id, sets: [SetTarget(reps: 8, weightKg: 60)])]
    #expect(try phone.runner.run(UpdateExercise(seed.id, equipment: "dumbbell", loadCount: 1)).receipt != nil)
    let outcome = try phone.runner.run(SaveRoutinePlan(base: base, current: current, isNew: true,
                                                      movements: [RoutineMovementChange(base: seed, current: seed)]))
    #expect(outcome.refusal == .stale(seed.id.ref, .predicted))
    #expect(try phone.drawn(Routine.self).isEmpty)
    #expect(try phone.drawn(ExerciseName.self).map(\.fields) == [["equipment": "dumbbell", "loadCount": 1]])
  }

  @Test func untouchedRoutineFieldsMergeAndRemovedCustomDraftsNeverPersist() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    var draft = Draft(new: Routine(id: phone.runner.mint(Routine.self), name: "Push", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(phone.runner.save(&draft, SaveRoutine.self)))
    let base = draft.current
    var current = base; current.entries[0].sets = [SetTarget(reps: 8, weightKg: 60)]
    draft.current.name = "Push revised"
    #expect(saved(phone.runner.save(&draft, SaveRoutine.self)))
    let removed = Exercise(id: phone.runner.mint(Exercise.self), name: "Removed", pattern: "press", equipment: "barbell", stepKg: 2.5)
    #expect(try phone.runner.run(SaveRoutinePlan(base: base, current: current, isNew: false,
                                               movements: [RoutineMovementChange(base: nil, current: removed)])).receipt != nil)
    var expected = current; expected.name = "Push revised"
    #expect(try phone.drawn(Routine.self) == [expected])
    #expect(try phone.drawn(Exercise.self).isEmpty)
  }

  @Test func returningToDumbbellsReplacesTheRetainedCountOverride() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let custom = Exercise(id: phone.runner.mint(Exercise.self), name: "Press", pattern: "press", equipment: "dumbbell", stepKg: 2, loadCount: 1)
    #expect(try phone.runner.run(CreateExercise(custom)).receipt != nil)
    var routine = Draft(new: Routine(id: phone.runner.mint(Routine.self), name: "Push", entries: [RoutineEntry(exerciseId: custom.id, sets: [SetTarget(reps: 10, weightKg: 16)])]))
    #expect(saved(phone.runner.save(&routine, SaveRoutine.self)))
    let barbell = Exercise(id: custom.id, name: custom.name, pattern: custom.pattern, equipment: "barbell", stepKg: custom.stepKg)
    #expect(try phone.runner.run(SaveRoutinePlan(base: routine.current, current: routine.current, isNew: false,
                                               movements: [RoutineMovementChange(base: custom, current: barbell)])).receipt != nil)
    #expect(try phone.drawn(ExerciseName.self).map(\.fields) == [["equipment": "barbell", "loadCount": 1]])
    let pair = Exercise(id: custom.id, name: custom.name, pattern: custom.pattern, equipment: "dumbbell", stepKg: custom.stepKg, loadCount: 2)
    #expect(try phone.runner.run(SaveRoutinePlan(base: routine.current, current: routine.current, isNew: false,
                                               movements: [RoutineMovementChange(base: barbell, current: pair)])).receipt != nil)
    #expect(try phone.drawn(ExerciseName.self).map(\.fields) == [["equipment": "dumbbell", "loadCount": 2]])
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(custom.id) } == pair)
    #expect(try phone.drawn(Routine.self) == [routine.current])
  }

  @Test func aConcurrentEquipmentChangeRefusesTheWholePlanAsOneNotice() throws {
    let first = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    var routine = Draft(new: Routine(id: first.runner.mint(Routine.self), name: "Push", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(first.runner.save(&routine, SaveRoutine.self)))
    first.sync()
    let second = first.device(); second.sync()
    let base = try #require(try second.drawn(Routine.self).first)
    let seed = try #require(try second.runner.read(Gym.scope) { try Catalogue($0).find(ID("bench-press")) })
    var current = base; current.entries[0].sets = [SetTarget(reps: 8, weightKg: 60)]
    var renamed = seed; renamed.name = "My press"
    #expect(try first.runner.run(UpdateExercise(seed.id, equipment: "dumbbell", loadCount: 1)).receipt != nil)
    #expect(try second.runner.run(SaveRoutinePlan(base: base, current: current, isNew: false,
                                                movements: [RoutineMovementChange(base: seed, current: renamed)])).receipt != nil)
    first.sync()
    #expect(try second.drawn(Routine.self) == [base])
    let catalogue = try second.runner.read(Gym.scope) { try Catalogue($0) }
    #expect(catalogue.find(seed.id)?.name == seed.name)
    #expect(catalogue.find(seed.id)?.equipment == "dumbbell" && catalogue.find(seed.id)?.loadCount == 1)
    #expect(try second.notices(GymRefusal.self).count == 1)
  }

  @Test func multipleRenamesKeepAllAliasesAndDumbbellCountAndDoNotRewriteLoggedWeights() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let custom = Exercise(id: phone.runner.mint(Exercise.self), name: "Custom", pattern: "press", equipment: "barbell", stepKg: 2.5)
    #expect(try phone.runner.run(CreateExercise(custom)).receipt != nil)
    let seed = try #require(SeedExercises.all.first { $0.id == ID("bench-press") })
    let session = phone.runner.mint(Session.self)
    #expect(try phone.runner.run(StartSession(id: session)).receipt != nil)
    let set = TrainingSet(id: phone.runner.mint(TrainingSet.self), sessionId: session, exerciseId: custom.id, weightKg: 16, reps: 10, completedAt: Instant(ms: 1_800_000_000_001))
    #expect(try phone.runner.run(AppendSet(set)).receipt != nil)
    var renamedSeed = seed; renamedSeed.name = "Seed press"
    let renamedCustom = Exercise(id: custom.id, name: "Custom press", pattern: custom.pattern, equipment: "dumbbell", stepKg: custom.stepKg, loadCount: 1)
    let base = Routine(id: phone.runner.mint(Routine.self))
    var current = base; current.name = "Push"; current.entries = [RoutineEntry(exerciseId: seed.id), RoutineEntry(exerciseId: custom.id)]
    #expect(try phone.runner.run(SaveRoutinePlan(base: base, current: current, isNew: true,
                                               movements: [RoutineMovementChange(base: seed, current: renamedSeed), RoutineMovementChange(base: custom, current: renamedCustom)])).receipt != nil)
    let log = try phone.runner.read(Gym.scope) { try TrainingLog($0) }
    #expect(log.catalogue.find(custom.id)?.aliases == ["Custom"])
    #expect(log.catalogue.find(seed.id)?.aliases == [seed.name])
    #expect(log.catalogue.find(custom.id)?.loadCount == 1)
    #expect(log.volumeKg(session: session) == 160)
    #expect(log.sets == [set])
  }
}
