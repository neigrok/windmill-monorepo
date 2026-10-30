import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
@testable import Windmill

@Suite(.serialized) @MainActor struct EditSetsTests {
  // A set taken from the middle, two retargeted, one added and the rest changed: each act is its own operation, and the plan
  // they make is the entry the sheet drew.
  @Test func eachActTheLifterTookBecomesItsOperationAndTheSaveLandsTheEntryAsDrawn() throws {
    let recorder = TelemetryRecorder(), tests = WorkoutStateTests(), (_, gym) = try tests.fixture(telemetry: recorder)
    let scheme = [SetTarget(reps: 8, weightKg: 10), SetTarget(reps: 8, weightKg: 10), SetTarget(reps: 6, weightKg: 12.5)]
    let workout = try tests.begin(gym, routine: try tests.routine(gym, scheme: scheme))
    let draft = EditSetsDraft(try #require(workout.session?.plan?.entries.first), opening: 1)
    #expect(draft.open == 1)
    draft.delete(IndexSet(integer: 1))
    #expect(draft.open == nil)
    draft.retarget(0) { $0.weightKg = 12.5 }
    draft.addSet()
    draft.retarget(3) { $0.reps = 4 }
    draft.restSeconds = 90
    #expect(draft.rows.map(\.target) == [SetTarget(reps: 8, weightKg: 12.5), SetTarget(reps: 6, weightKg: 12.5), SetTarget(reps: 4, weightKg: 12.5)])
    #expect(draft.open == 3)
    #expect(draft.operations(at: 0) == [
      .removeSet(index: 0, set: 1),
      .retarget(index: 0, set: 0, target: SetTarget(reps: 8, weightKg: 12.5)),
      .addSet(index: 0),
      .retarget(index: 0, set: 2, target: SetTarget(reps: 4, weightKg: 12.5)),
      .setRest(index: 0, restSeconds: 90),
    ])
    #expect(workout.revise(draft.operations(at: 0), against: workout.session?.plan))
    #expect(workout.session?.plan?.entries.first == draft.entry)
    #expect(recorder.entries.withLock { $0.filter { $0.name == "gym_workout_plan_changed" }.map(\.properties) } ==
            ["remove_set", "retarget", "add_set", "rest"].map { ["action": $0, "outcome": "ok", "door": "workout"] })
  }

  @Test func everySetTakenOutOpensTheLineAndAnAddedSetStartsFromNoTarget() throws {
    let entry = RoutineEntry(exerciseId: ID("pull-up"), sets: [SetTarget(reps: 8, weightKg: 10)], restSeconds: 120)
    let emptied = EditSetsDraft(entry, opening: nil)
    emptied.delete(IndexSet(integer: 0))
    #expect(emptied.entry == RoutineEntry(exerciseId: ID("pull-up"), restSeconds: 120))
    #expect(emptied.operations(at: 2) == [.removeSet(index: 2, set: 0)])
    let open = EditSetsDraft(RoutineEntry(exerciseId: ID("face-pull")), opening: 0)
    #expect(open.open == nil && open.operations(at: 4).isEmpty)
    open.addSet(); open.retarget(0) { $0 = SetTarget(reps: 15, weightKg: 15) }; open.addSet()
    #expect(open.operations(at: 4) == [.addSet(index: 4), .retarget(index: 4, set: 0, target: SetTarget(reps: 15, weightKg: 15)), .addSet(index: 4)])
  }

  @Test func aTargetThatIsOrRoundsToZeroIsRefusedUnderItsField() {
    let draft = EditSetsDraft(RoutineEntry(exerciseId: ID("pull-up"), sets: [SetTarget(reps: 8, weightKg: 10), SetTarget(reps: 8, weightKg: 10)]), opening: nil)
    #expect(draft.problem == nil)
    draft.retarget(1) { $0.weightKg = 0.001 }
    #expect(draft.problem?.row == 1 && draft.problem?.message == "A zero target is no target.")
    draft.retarget(1) { $0.weightKg = 0 }
    #expect(draft.problem == nil)
  }

  @Test func addSetStopsAtTwentyPlannedSets() {
    let draft = EditSetsDraft(RoutineEntry(exerciseId: ID("pull-up"), sets: Array(repeating: SetTarget(reps: 8), count: 19)), opening: nil)
    draft.addSet(); draft.addSet()
    #expect(draft.rows.count == 20)
  }
}
