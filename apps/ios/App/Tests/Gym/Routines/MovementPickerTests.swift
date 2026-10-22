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
    TrainingLog(sessions: sessions, sets: sets, moment: Moment(now: now, zone: FixedZone(offsetSeconds: 0)), firstPullComplete: complete, catalogue: Catalogue(custom: [], names: []))
  }

  func exercise(_ id: String, name: String, aliases: [String] = []) -> Exercise {
    Exercise(id: ID(RecordID(id)), name: name, pattern: "isolation", equipment: "barbell", stepKg: 2.5, aliases: aliases)
  }

  func session(_ id: String, daysAgo: Int = 0, open: Bool = false) -> Session {
    Session(id: ID(RecordID(id)), startedAt: Instant(ms: now.ms - Int64(daysAgo) * 86_400_000 - 60_000),
            finishedAt: open ? nil : Instant(ms: now.ms - Int64(daysAgo) * 86_400_000))
  }

  func set(_ id: String, session: Session, exercise: ID<Exercise>, weight: Double = 60, reps: Int = 8, offset: Int64 = 0) -> TrainingSet {
    TrainingSet(id: ID(RecordID(id)), sessionId: session.id, exerciseId: exercise, weightKg: weight, reps: reps,
                completedAt: Instant(ms: session.startedAt.ms + offset))
  }

  func fixture() -> (Harness, GymModel) {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: now, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }

  @Test func blankQueryShowsTheSixThenEveryOtherMovement() {
    let catalogue = Catalogue(custom: [], names: []).exercises
    let options = MovementPickerOptions.matching(query: " \n", catalogue: catalogue, selected: [], log: log())
    #expect(options.six.map(\.id) == MovementPickerOptions.openers)
    #expect(options.matches.map(\.id) == catalogue.filter { !MovementPickerOptions.openers.contains($0.id) }.map(\.id))
    #expect(options.six.count + options.matches.count == catalogue.count)
    #expect(options.unread == nil && options.create == nil)
  }

  @Test func searchMatchesNamesAndFormerNamesAndCapsTheShortlist() {
    let catalogue = (0..<9).map { exercise("movement-\($0)", name: "Custom movement \($0)", aliases: ["Earlier \($0)"]) }
    let named = MovementPickerOptions.matching(query: "  CUSTOM ", catalogue: catalogue, selected: [], log: nil)
    #expect(named.six.isEmpty && named.matches.map(\.id) == catalogue.prefix(7).map(\.id))
    #expect(named.matches.allSatisfy { $0.alias == nil && $0.meta == nil })
    let renamed = MovementPickerOptions.matching(query: "earlier 8", catalogue: catalogue, selected: [], log: nil)
    #expect(renamed.matches == [MovementPickerOptions.Row(exercise: catalogue[8], meta: nil, alias: "Earlier 8", selected: false)])
    #expect(renamed.matches.map(\.line) == ["Barbell · was “Earlier 8”"])
    #expect(renamed.unread == nil && renamed.create == nil)
  }

  @Test func nameMatchTakesPrecedenceOverAliasAndSelectedMovementStaysVisible() {
    let movement = exercise("movement1", name: "Row", aliases: ["Old Row"])
    let result = MovementPickerOptions.matching(query: "row", catalogue: [movement], selected: [movement.id], log: nil)
    #expect(result.matches == [MovementPickerOptions.Row(exercise: movement, meta: nil, alias: nil, selected: true)])
  }

  @Test func lastEffortUsesLastSetAndSessionDate() {
    let movement = exercise("movement1", name: "Custom")
    let yesterday = session("session1", daysAgo: 1)
    let history = log(sessions: [yesterday], sets: [
      set("set-one1", session: yesterday, exercise: movement.id, weight: 40, reps: 10),
      set("set-two2", session: yesterday, exercise: movement.id, weight: -5, reps: 6, offset: 10)
    ])
    let result = MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: history)
    #expect(result.matches.first?.meta == "−5 × 6 · yesterday")
    #expect(result.matches.map(\.line) == ["Barbell · −5 × 6 · yesterday"])
  }

  @Test func aRowNamesItsEquipmentAsCreationDoesAndBodyweightAloneByItsReps() {
    let chin = Exercise(id: ID("chin"), name: "Chin-up", pattern: "pull", equipment: "bodyweight", stepKg: 2.5)
    let dumbbells = Exercise(id: ID("db-bench"), name: "Dumbbell Bench Press", pattern: "push", equipment: "dumbbell", stepKg: 2, loadCount: 2)
    let curl = Exercise(id: ID("db-curl"), name: "Dumbbell Curl", pattern: "isolation", equipment: "dumbbell", stepKg: 1, loadCount: 1)
    let earlier = session("session1", daysAgo: 9), today = session("session2")
    let history = log(sessions: [earlier, today], sets: [
      set("set-one1", session: earlier, exercise: chin.id, weight: 0, reps: 8),
      set("set-two2", session: today, exercise: dumbbells.id, weight: 16, reps: 8),
    ])
    let result = MovementPickerOptions.matching(query: "", catalogue: [chin, dumbbells, curl], selected: [], log: history, featured: [])
    #expect(result.matches.map(\.line) == ["Bodyweight · 8 reps · 9 days ago", "Dumbbells · 16 × 8 · today", "One dumbbell"])
  }

  @Test func aMovementNeverLoggedReadsItsEquipmentAlone() {
    let movement = exercise("movement1", name: "Custom")
    for history in [nil, log(complete: false), log()] {
      let result = MovementPickerOptions.matching(query: "custom", catalogue: [movement], selected: [], log: history)
      #expect(result.matches.map(\.meta) == [nil] && result.matches.map(\.line) == ["Barbell"])
    }
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
    let picker = MovementPicker(gym: gym, purpose: .workout)
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
    let restoredPicker = MovementPicker(gym: reopened, purpose: .workout)
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
    let noMatch = MovementPickerOptions.matching(query: " Zercher squat ", catalogue: catalogue, selected: [], log: nil)
    #expect(noMatch == MovementPickerOptions.Result(six: [], matches: [], unread: nil, create: "Zercher squat"))
    let absent = MovementPickerOptions.matching(query: "", catalogue: [], selected: [], log: nil)
    #expect(absent == MovementPickerOptions.Result(six: [], matches: [], unread: MovementPickerOptions.catalogueUnread, create: nil))
    let failed = MovementPickerOptions.matching(query: "unfindable", catalogue: catalogue, selected: [], log: log(), readFailed: true)
    #expect(failed == MovementPickerOptions.Result(six: [], matches: [], unread: MovementPickerOptions.catalogueUnread, create: nil))
  }

  @Test func aQueryWithoutAnExactNameOrFormerNameOffersToCreateIt() {
    let catalogue = [exercise("bench", name: "Bench Press", aliases: ["Flat bench"]), exercise("row", name: "Barbell Row")]
    let partial = MovementPickerOptions.matching(query: "bench", catalogue: catalogue, selected: [], log: nil)
    #expect(partial.matches.map(\.id) == [ID("bench")] && partial.create == "bench")
    #expect(MovementPickerOptions.matching(query: "  bench PRESS ", catalogue: catalogue, selected: [], log: nil).create == nil)
    #expect(MovementPickerOptions.matching(query: "flat bench", catalogue: catalogue, selected: [], log: nil).create == nil)
    let long = String(repeating: "a", count: 70)
    #expect(MovementPickerOptions.matching(query: long, catalogue: catalogue, selected: [], log: nil).create == String(repeating: "a", count: 60))
  }

  @Test func aReopenedDraftKeepsItsNameAndANamelessOneTakesTheSearch() {
    var draft = MovementCreationDraft(id: ID("movement1"), name: "")
    draft.takeQuery("  Cable curl ")
    #expect(draft.name == "Cable curl")
    draft.name = "Cable curl kept"
    draft.takeQuery("Cable")
    #expect(draft.name == "Cable curl kept")
  }

  @Test func creationPreservesAllEquipmentChoicesAndAcceptsOpenTargets() {
    #expect(MovementEquipment.choices == ["barbell", "dumbbell", "machine", "cable", "kettlebell", "bodyweight"])
    var draft = MovementCreationDraft(id: ID("movement1"), name: " \n")
    #expect(draft.problem == "Name it to save it.")
    draft.name = "Custom"
    #expect(draft.problem == nil)
    draft.sets = [SetTarget()]
    #expect(draft.problem == nil)
    for equipment in MovementEquipment.choices {
      draft.equipment = equipment
      #expect(draft.problem == nil)
    }
    draft.equipment = "unknown"
    #expect(draft.problem == "check the movement name and equipment")
  }

  @Test func creationRetainsDraftAndIdentityOnCommitFailureThenRetryAddsTheTargets() {
    let (harness, gym) = fixture()
    let targets = [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 6, weightKg: 65)]
    var draft = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "  Custom press  ", equipment: "machine", sets: targets)
    let identity = draft.id
    harness.failNextCommit()
    #expect(gym.createMovement(&draft) == nil)
    #expect(draft.name == "  Custom press  " && draft.equipment == "machine" && draft.sets == targets && draft.id == identity)
    #expect(draft.refusal == "Gym could not save this change. Try again." && gym.catalogue.find(identity) == nil)
    #expect(gym.createMovement(&draft) == RoutineEntry(exerciseId: identity, sets: targets))
    #expect(draft.refusal == nil && gym.catalogue.find(identity) == draft.exercise)
    harness.sync(); gym.refresh()
    #expect(gym.catalogue.exercises.filter { $0.id == identity }.count == 1)
    #expect(harness.server.rows(Gym.scope, of: nil).isEmpty)
  }

  @Test func creationDuringAccountChangeWritesNothingAndOpenTargetsCreateAnOpenEntry() {
    let (_, gym) = fixture()
    var draft = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: " ")
    #expect(gym.createMovement(&draft) == nil && draft.refusal == "Name it to save it.")
    draft.name = "Custom"
    gym.accountChanging = true
    #expect(gym.createMovement(&draft) == nil)
    #expect(draft.name == "Custom" && draft.refusal == "Wait for the account change to finish." && gym.catalogue.find(draft.id) == nil)
    gym.accountChanging = false
    #expect(gym.createMovement(&draft) == RoutineEntry(exerciseId: draft.id) && draft.refusal == nil)
  }
}
