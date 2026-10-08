import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncSchema
import SyncCore
import SyncModelServer
@testable import Windmill

@Suite(.serialized) @MainActor struct MovementPickerTests {
  let now = Instant(ms: 1_790_424_000_000)

  func log(sessions: [Session] = [], sets: [TrainingSet] = [], complete: Bool = true) -> TrainingLog {
    TrainingLog(sessions: sessions, sets: sets, moment: Moment(now: now, zone: FixedZone(offsetSeconds: 0)), firstPullComplete: complete)
  }

  func exercise(_ id: String, name: String, aliases: [String] = []) -> Exercise {
    Exercise(id: ID(RecordID(id)), name: name, pattern: "isolation", equipment: "barbell", stepKg: 2.5, aliases: aliases)
  }

  func session(_ id: String, daysAgo: Int = 0, open: Bool = false) -> Session {
    Session(id: ID(RecordID(id)), startedAt: Instant(ms: now.ms - Int64(daysAgo) * 86_400_000 - 60_000),
            finishedAt: open ? nil : Instant(ms: now.ms - Int64(daysAgo) * 86_400_000))
  }

  func set(_ id: String, session: Session, exercise: ID<Exercise>, weight: Double = 60, reps: Int = 8, kind: String = "working", offset: Int64 = 0) -> TrainingSet {
    TrainingSet(id: ID(RecordID(id)), sessionId: session.id, exerciseId: exercise, weightKg: weight, reps: reps,
                kind: kind, completedAt: Instant(ms: session.startedAt.ms + offset))
  }

  func fixture() -> (Harness, GymModel) {
    let harness = Harness(registry: SyncSchema.registry, start: now, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }

  @Test func blankQueryShowsTheSixThenEveryOtherMovement() {
    let catalogue = Catalogue(custom: [], names: []).exercises
    let options = MovementPickerOptions.matching(query: " \n", catalogue: catalogue, selected: [], log: log())
    #expect(options.six.map(\.id) == MovementPickerOptions.openers)
    #expect(options.matches.map(\.id) == catalogue.filter { !MovementPickerOptions.openers.contains($0.id) }.map(\.id))
    #expect(options.six.count + options.matches.count == catalogue.count)
    #expect(options.unread == nil && options.empty == nil)
  }

  @Test func searchMatchesNamesAndFormerNamesAndCapsTheShortlist() {
    let catalogue = (0..<9).map { exercise("movement-\($0)", name: "Custom movement \($0)", aliases: ["Earlier \($0)"]) }
    let named = MovementPickerOptions.matching(query: "  CUSTOM ", catalogue: catalogue, selected: [], log: nil)
    #expect(named.six.isEmpty && named.matches.map(\.id) == catalogue.prefix(7).map(\.id))
    #expect(named.matches.allSatisfy { $0.alias == nil && $0.meta == nil })
    let renamed = MovementPickerOptions.matching(query: "earlier 8", catalogue: catalogue, selected: [], log: nil)
    #expect(renamed.matches == [MovementPickerOptions.Row(exercise: catalogue[8], meta: nil, alias: "Earlier 8", selected: false)])
    #expect(renamed.unread == nil && renamed.empty == nil)
  }

  @Test func nameMatchTakesPrecedenceOverAliasAndSelectedMovementStaysVisible() {
    let movement = exercise("movement1", name: "Row", aliases: ["Old Row"])
    let result = MovementPickerOptions.matching(query: "row", catalogue: [movement], selected: [movement.id], log: nil)
    #expect(result.matches == [MovementPickerOptions.Row(exercise: movement, meta: nil, alias: nil, selected: true)])
  }

  @Test func lastEffortUsesLastNonWarmupSetAndSessionDate() {
    let movement = exercise("movement1", name: "Custom")
    let yesterday = session("session1", daysAgo: 1)
    let history = log(sessions: [yesterday], sets: [
      set("set-one1", session: yesterday, exercise: movement.id, weight: 40, reps: 10),
      set("set-two2", session: yesterday, exercise: movement.id, weight: -5, reps: 6, offset: 10),
      set("set-three3", session: yesterday, exercise: movement.id, weight: 20, reps: 12, kind: "warmup", offset: 20)
    ])
    let result = MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: history)
    #expect(result.matches.first?.meta == "last −5 × 6 · yesterday")
  }

  @Test func neverLoggedRequiresACompleteSuccessfulRead() {
    let movement = exercise("movement1", name: "Custom")
    #expect(MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: nil).matches.first?.meta == nil)
    #expect(MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: log(complete: false)).matches.first?.meta == nil)
    #expect(MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: log(), readFailed: true).matches.first?.meta == nil)
    #expect(MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: log()).matches.first?.meta == "never logged")
  }

  @Test func rankingCountsEachFinishedSessionOnceOverFiftyAndTopsUpCanonically() {
    let catalogue = Catalogue(custom: [], names: []).exercises
    let sessions = (0..<51).map { session("session-\($0)", daysAgo: $0) }
    let newest = sessions[0], oldest = sessions[50]
    let active = session("active-session", open: true)
    let history = log(sessions: [active] + Array(sessions.reversed()), sets: [
      set("set-11111", session: newest, exercise: ID("front-squat")),
      set("set-22222", session: newest, exercise: ID("front-squat")),
      set("set-33333", session: sessions[1], exercise: ID("leg-press")),
      set("set-44444", session: sessions[2], exercise: ID("leg-press")),
      set("set-55555", session: oldest, exercise: ID("plank")),
      set("set-66666", session: active, exercise: ID("plank"))
    ])
    #expect(MovementPickerOptions.mostTrained(catalogue: catalogue, log: history) == [
      ID("leg-press"), ID("front-squat"), ID("back-squat"), ID("bench-press"), ID("deadlift"), ID("overhead-press")
    ])
  }

  @Test func rankingTiesKeepCatalogueOrderAndTheFirstNonemptyReadFreezesIt() {
    let catalogue = Catalogue(custom: [], names: []).exercises
    let trained = session("session1")
    let first = log(sessions: [trained], sets: [set("set-one1", session: trained, exercise: ID("front-squat")),
                                             set("set-two2", session: trained, exercise: ID("back-squat"))])
    var ranking = MovementPickerRanking()
    ranking.capture(catalogue: catalogue, log: nil)
    ranking.capture(catalogue: catalogue, log: log())
    #expect(ranking.ids == nil)
    ranking.capture(catalogue: catalogue, log: first)
    let frozen = ranking.ids
    #expect(frozen == [ID("back-squat"), ID("front-squat"), ID("bench-press"), ID("deadlift"), ID("overhead-press"), ID("barbell-row")])
    ranking.capture(catalogue: catalogue, log: log(sessions: [trained], sets: [set("set-next1", session: trained, exercise: ID("plank"))]))
    #expect(ranking.ids == frozen)
  }

  @Test func rankingWaitsForSessionSetsToFinishReadingThenFreezesTheCompleteRanking() {
    let catalogue = Catalogue(custom: [], names: []).exercises
    let trained = session("session1")
    var ranking = MovementPickerRanking()
    ranking.capture(catalogue: catalogue, log: log(sessions: [trained], complete: false))
    #expect(ranking.ids == nil)
    let sets = [set("set-one1", session: trained, exercise: ID("front-squat"))]
    let partial = log(sessions: [trained], sets: sets, complete: false)
    ranking.capture(catalogue: catalogue, log: partial)
    #expect(ranking.ids == nil)
    #expect(MovementPickerOptions.mostTrained(catalogue: catalogue, log: partial) == MovementPickerOptions.openers)
    ranking.capture(catalogue: catalogue, log: log(sessions: [trained], sets: sets))
    let frozen = ranking.ids
    #expect(frozen == [ID("front-squat"), ID("back-squat"), ID("bench-press"), ID("deadlift"), ID("overhead-press"), ID("barbell-row")])
    ranking.capture(catalogue: catalogue, log: log(sessions: [trained], sets: [set("set-next1", session: trained, exercise: ID("plank"))]))
    #expect(ranking.ids == frozen)
  }

  @Test func firstSessionRequiresBothSuccessfulCompleteReadsAndIgnoresCurrentWorkout() {
    #expect(!MovementPickerOptions.firstSession(log: nil, routines: [], readFailed: false))
    #expect(!MovementPickerOptions.firstSession(log: log(complete: false), routines: [], readFailed: false))
    #expect(!MovementPickerOptions.firstSession(log: log(), routines: [], readFailed: true))
    #expect(!MovementPickerOptions.firstSession(log: log(), routines: [Routine(id: ID("routine1"))], readFailed: false))
    #expect(!MovementPickerOptions.firstSession(log: log(sessions: [session("finished")]), routines: [], readFailed: false))
    #expect(MovementPickerOptions.firstSession(log: log(sessions: [session("current", open: true)]), routines: [], readFailed: false))
  }

  @Test func firstWorkoutKeepsItsWelcomeAndFourSetsAcrossRelaunch() throws {
    let (harness, gym) = fixture()
    let picker = MovementPicker(gym: gym, selected: [], includesTargets: false) { _ in }
    #expect(picker.firstSession)
    let id = try #require(gym.startWorkout())
    #expect(picker.firstSession && gym.workout.selected == nil)
    gym.workout.add(ID("back-squat"))
    for weight in [100.0, 100.0, 102.5] {
      gym.workout.weightKg = weight; gym.workout.reps = 5
      #expect(gym.workout.logSet())
      harness.advance(ms: 1_000)
    }
    gym.workout.add(ID("bench-press")); gym.workout.weightKg = 80; gym.workout.reps = 8
    #expect(gym.workout.logSet() && picker.firstSession)

    let reopened = GymModel(runner: harness.runner), workout = reopened.workout
    let restoredPicker = MovementPicker(gym: reopened, selected: [], includesTargets: false) { _ in }
    #expect(restoredPicker.firstSession && workout.sessionId == id)
    #expect(workout.sets.map(\.weightKg) == [100, 100, 102.5, 80])
    #expect(workout.sets.map(\.reps) == [5, 5, 5, 8])
    #expect(workout.walk.order == [ID<Exercise>("back-squat"), ID<Exercise>("bench-press")])
    #expect(workout.selected == ID<Exercise>("bench-press"))
    #expect(reopened.run(FinishSession(id: id))?.receipt != nil)
    #expect(!restoredPicker.firstSession)
  }

  @Test func absentCatalogueAndFailedReadAreDistinctFromNoMatch() {
    let catalogue = Catalogue(custom: [], names: []).exercises
    let noMatch = MovementPickerOptions.matching(query: "unfindable", catalogue: catalogue, selected: [], log: nil)
    #expect(noMatch == MovementPickerOptions.Result(six: [], matches: [], unread: nil, empty: "No movement by that name."))
    let absent = MovementPickerOptions.matching(query: "", catalogue: [], selected: [], log: nil)
    #expect(absent == MovementPickerOptions.Result(six: [], matches: [], unread: MovementPickerOptions.catalogueUnread, empty: nil))
    let failed = MovementPickerOptions.matching(query: "unfindable", catalogue: catalogue, selected: [], log: log(), readFailed: true)
    #expect(failed == MovementPickerOptions.Result(six: [], matches: [], unread: MovementPickerOptions.catalogueUnread, empty: nil))
  }

  @Test func creationOffersOnlyTheFourAndroidEquipmentChoicesAndRequiresTargetsInBuilder() {
    #expect(MovementCreationDraft.equipmentChoices == ["barbell", "dumbbell", "machine", "bodyweight"])
    var draft = MovementCreationDraft(id: ID("movement1"), name: " \n")
    #expect(draft.problem(includesTargets: true) == "Name it to save it.")
    draft.name = "Custom"
    #expect(draft.problem(includesTargets: true) == "Choose at least one set.")
    #expect(draft.problem(includesTargets: false) == nil)
    draft.sets = []
    #expect(draft.problem(includesTargets: true) == "Choose at least one set.")
    draft.sets = [SetTarget()]
    #expect(draft.problem(includesTargets: true) == nil)
    draft.equipment = "cable"
    #expect(draft.problem(includesTargets: true) == "check the movement name and equipment")
  }

  @Test func creationRetainsDraftAndIdentityOnCommitFailureThenRetryAddsTheTargets() {
    let (harness, gym) = fixture()
    let targets = [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 6, weightKg: 65)]
    var draft = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "  Custom press  ", equipment: "machine", sets: targets)
    let identity = draft.id
    harness.failNextCommit()
    #expect(gym.createMovement(&draft, includesTargets: true) == nil)
    #expect(draft.name == "  Custom press  " && draft.equipment == "machine" && draft.sets == targets && draft.id == identity)
    #expect(draft.refusal == "Gym could not save this change. Try again." && gym.catalogue.find(identity) == nil)
    #expect(gym.createMovement(&draft, includesTargets: true) == RoutineEntry(exerciseId: identity, sets: targets))
    #expect(draft.refusal == nil && gym.catalogue.find(identity) == draft.exercise)
    harness.sync(); gym.refresh()
    #expect(gym.catalogue.exercises.filter { $0.id == identity }.count == 1)
    #expect(harness.server.rows(Gym.scope, of: nil).isEmpty)
  }

  @Test func creationWithOpenTargetsAndDuringAccountChangeWritesNothing() {
    let (_, gym) = fixture()
    var draft = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "Custom")
    #expect(gym.createMovement(&draft, includesTargets: true) == nil && draft.refusal == "Choose at least one set.")
    gym.accountChanging = true
    #expect(gym.createMovement(&draft, includesTargets: false) == nil)
    #expect(draft.name == "Custom" && draft.refusal == "Wait for the account change to finish." && gym.catalogue.find(draft.id) == nil)
    gym.accountChanging = false
    #expect(gym.createMovement(&draft, includesTargets: false) == RoutineEntry(exerciseId: draft.id))
  }
}
