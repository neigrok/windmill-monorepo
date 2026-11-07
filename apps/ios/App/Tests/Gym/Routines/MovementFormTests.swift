import Testing
import DomainKit
import GymDomain
@testable import Windmill

@MainActor struct MovementFormTests {
  let straight = Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3)

  @Test func opensExistingSchemesAsTheyAreAndADifferingSchemeOpensVaried() {
    let draft = TargetsDraft(sets: straight)
    #expect(draft.sets == straight && draft.count == 3 && !draft.varied)
    #expect(draft.shared == SetTarget(reps: 8, weightKg: 60))
    let open = TargetsDraft(sets: nil)
    #expect(open.isOpen && open.sets == nil && open.shared == SetTarget())
    let ladder = TargetsDraft(sets: [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90)])
    #expect(ladder.varied && ladder.sets == [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90)])
  }

  @Test func aCountSteppedDownKeepsItsHiddenSetsAndSteppedUpCopiesTheLast() {
    let original = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100)]
    var draft = TargetsDraft(sets: original)
    draft.setCount(2)
    #expect(draft.sets == Array(original.prefix(2)) && draft.rows == original)
    draft.setCount(0)
    #expect(draft.isOpen && draft.sets == nil && draft.rows == original)
    draft.setCount(3)
    #expect(draft.sets == original)
    draft.setCount(5)
    #expect(draft.sets == original + [original[2], original[2]])
    draft.setCount(99)
    #expect(draft.count == RoutineRules.targets.max && draft.rows.count == RoutineRules.targets.max)
    draft.setCount(-1)
    #expect(draft.isOpen)
    var fresh = TargetsDraft(sets: nil)
    fresh.setCount(2)
    #expect(fresh.sets == [SetTarget(), SetTarget()])
  }

  @Test func sharedValuesLandOnEverySetAndMaxAndNoLoadAreTargets() {
    var draft = TargetsDraft(sets: straight)
    draft.retargetAll { $0.reps = 12 }
    draft.retargetAll { $0.weightKg = nil }
    #expect(draft.sets == Array(repeating: SetTarget(reps: 12), count: 3))
    draft.retargetAll { $0.reps = nil }
    #expect(draft.sets == Array(repeating: SetTarget(), count: 3) && !draft.varied)
    draft.setCount(2)
    draft.retargetAll { $0.weightKg = 40 }
    draft.setCount(3)
    #expect(draft.sets == [SetTarget(weightKg: 40), SetTarget(weightKg: 40), SetTarget()])
  }

  // Varied, each set takes its own target; turned straight again, every visible set takes the first's, and a set hidden
  // past a smaller count keeps its own.
  @Test func aVariedSchemeTurnedStraightTakesTheFirstSetsTargetAndKeepsTheHiddenTail() {
    var draft = TargetsDraft(sets: straight)
    draft.varied = true
    draft.retarget(1) { $0.weightKg = 65 }
    draft.retarget(2) { $0.reps = 6 }
    draft.retarget(7) { $0.reps = 1 }
    #expect(draft.sets == [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 8, weightKg: 65), SetTarget(reps: 6, weightKg: 60)])
    draft.varied = false
    #expect(draft.sets == straight)
    let original = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100)]
    var ladder = TargetsDraft(sets: original)
    ladder.setCount(2); ladder.varied = false
    #expect(ladder.sets == [original[0], original[0]])
    ladder.setCount(3)
    #expect(ladder.sets == [original[0], original[0], original[2]])
  }

  @Test func aFormDraftPlansItsEntryAndReadsDirtyOnlyWhenSomethingChanged() {
    let bench = Exercise(id: ID("bench-press"), name: "Bench Press", pattern: "press", equipment: "barbell", stepKg: 2.5)
    let entry = RoutineEntry(exerciseId: bench.id, sets: straight, restSeconds: 120)
    var draft = MovementFormDraft(exercise: bench, base: bench, entry: entry)
    #expect(!draft.isDirty && !draft.adding && draft.planned == entry && draft.openingPlan == entry && draft.problem == nil)
    draft.restSeconds = 75
    #expect(draft.isDirty)
    draft.restSeconds = nil
    draft.targets.setCount(0)
    #expect(draft.planned == RoutineEntry(exerciseId: bench.id))
    let emptySets = MovementFormDraft(exercise: bench, base: bench, entry: RoutineEntry(exerciseId: bench.id, sets: [], restSeconds: 60))
    #expect(!emptySets.isDirty && emptySets.targets.isOpen && emptySets.planned == RoutineEntry(exerciseId: bench.id, restSeconds: 60))
    var added = MovementFormDraft(exercise: bench, base: bench, entry: nil)
    #expect(added.adding && !added.isDirty && added.planned == RoutineEntry(exerciseId: bench.id))
    added.equipment = "dumbbell"; added.loadCount = 1
    #expect(added.isDirty && added.exercise.loadCount == 1 && added.basis.unit == "kg")
    added.name = " "
    #expect(added.problem == "Name it to save it.")
    let other = Exercise(id: ID("assist"), name: "Assistance", pattern: "pull", equipment: "other", stepKg: 2.5)
    #expect(MovementFormDraft(exercise: other, base: nil, entry: nil).problem == "Choose equipment.")
    #expect(MovementFormDraft(exercise: other, base: other, entry: nil).problem == nil)
  }
}
