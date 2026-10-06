import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
@testable import Windmill

@MainActor struct RoutinePlanningTests {
  func fixture() -> (Harness, GymModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }
  func draft(_ gym: GymModel, name: String = "Push A") -> Draft<Routine> {
    Draft(new: Routine(id: gym.runner.mint(Routine.self), name: name, entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 60)])]))
  }

  @Test func namesAndMovementLimitsUseOrderedRefusals() {
    let routine = Routine(id: ID("r"))
    #expect(RoutinePlanning.problem(routine) == "Name it to save it.")
    var value = routine; value.name = " \n\t "
    #expect(RoutinePlanning.problem(value) == "Name it to save it.")
    value.name = String(repeating: "界", count: 61)
    #expect(RoutinePlanning.problem(value) == "Use 60 characters or fewer.")
    value.name = String(repeating: "界", count: 60)
    #expect(RoutinePlanning.problem(value) == "A routine is at least one movement.")
    value.entries = Array(repeating: RoutineEntry(exerciseId: ID("bench-press")), count: 50)
    #expect(RoutinePlanning.problem(value) == nil)
    value.entries.append(RoutineEntry(exerciseId: ID("back-squat")))
    #expect(RoutinePlanning.problem(value) == "Use 50 movements or fewer.")
  }

  @Test func createEditCancelAndReopenKeepPlanOrder() throws {
    let (_, gym) = fixture()
    var draft = draft(gym)
    #expect(gym.saveRoutine(&draft))
    var cancelled = try #require(try gym.runner.open(draft.id))
    cancelled.current.name = "Not kept"
    #expect(gym.routines.first?.name == "Push A")
    var edit = try #require(try gym.runner.open(draft.id))
    edit.current.name = "Push B"
    edit.current.entries.append(RoutineEntry(exerciseId: ID("chin-up")))
    edit.current.entries.swapAt(0, 1)
    #expect(gym.saveRoutine(&edit))
    let reopened = try #require(try gym.runner.open(edit.id))
    #expect(reopened.current.name == "Push B")
    #expect(reopened.current.entries == [RoutineEntry(exerciseId: ID("chin-up")), RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 60)])])
  }

  @Test func editorCancelKeepsCommittedTargetsAndChangedOwnerCannotSaveDraft() throws {
    let (harness, gym) = fixture()
    var stored = draft(gym)
    #expect(gym.saveRoutine(&stored))
    let editing = RoutineEditingSession(gym: gym, routine: stored.current)
    let exercise = try #require(gym.catalogue.find(ID("bench-press")))
    editing.openTargets(exercise: exercise, sets: stored.current.entries[0].sets)
    editing.targetDraft.type("12", field: .reps)
    editing.cancelTargets()
    #expect(editing.path.isEmpty && editing.draft.current == stored.current)
    #expect(gym.routines == [stored.current])
    editing.pickMovement(); editing.query = "Custom press"
    editing.createMovement(gym)
    let createdID = try #require(editing.creation?.id)
    editing.creation?.name = "Custom press kept"
    editing.path.removeLast()
    editing.createMovement(gym)
    #expect(editing.query == "Custom press" && editing.creation?.id == createdID && editing.creation?.name == "Custom press kept")
    editing.path = []
    editing.draft.current.name = "Revised"
    let pending = editing.draft.current
    gym.account = "another-owner"; gym.isAnonymous = false
    #expect(!editing.save(gym))
    #expect(editing.failure == "The account changed while editing. Open the routine again.")
    #expect(editing.draft.current == pending && gym.routines == [stored.current])
    gym.account = nil; gym.isAnonymous = true
    harness.failNextCommit()
    #expect(!editing.save(gym))
    #expect(editing.draft.current == pending && editing.id == stored.id && gym.routines == [stored.current])
    #expect(editing.save(gym))
    #expect(gym.routines == [pending])
  }

  @Test func saveFailureRetainsExactDraftAndRetryUsesSameID() {
    let (harness, gym) = fixture()
    var draft = draft(gym)
    let before = draft.current
    harness.failNextCommit()
    #expect(!gym.saveRoutine(&draft))
    #expect(draft.current == before && draft.isNew && gym.routines.isEmpty)
    #expect(gym.error == "Gym could not save this change. Try again.")
    #expect(gym.saveRoutine(&draft))
    #expect(gym.routines == [before])
  }

  @Test func deletionCanBeUndoneAndLeavesSessionHistory() throws {
    let (_, gym) = fixture()
    var draft = draft(gym)
    #expect(gym.saveRoutine(&draft))
    #expect(gym.startWorkout(routineId: draft.id) != nil)
    let session = try #require(gym.openSession)
    #expect(gym.run(FinishSession(id: session.id))?.refusal == nil)
    let receipt = try #require(gym.run(DeleteRoutine(draft.id))?.receipt)
    #expect(gym.routines.isEmpty)
    #expect(gym.routineHistory(draft.id).map(\.id) == [session.id])
    #expect(gym.undo(receipt.gestureId))
    #expect(gym.routines.map(\.id) == [draft.id])
  }

  @Test func multipleRoutineDeletesKeepIndependentNineSecondUndoOffers() throws {
    let (harness, gym) = fixture()
    var first = draft(gym, name: "First"), second = draft(gym, name: "Second")
    #expect(gym.saveRoutine(&first) && gym.saveRoutine(&second))
    let firstDelete = try #require(gym.run(DeleteRoutine(first.id))?.receipt)
    harness.advance(ms: 1_000)
    let secondDelete = try #require(gym.run(DeleteRoutine(second.id))?.receipt)
    #expect(gym.undoOffers.reversed().map(\.id) == [secondDelete.gestureId, firstDelete.gestureId])
    #expect(firstDelete.releaseAt == 1_790_424_009_000 && secondDelete.releaseAt == 1_790_424_010_000)
    #expect(gym.undo(secondDelete.gestureId) && gym.routines.map(\.id) == [second.id])
    harness.advance(ms: 8_001); gym.refresh()
    #expect(gym.undoOffers.isEmpty && !gym.undo(firstDelete.gestureId))
    #expect(gym.error == "That change has already been kept." && gym.routines.map(\.id) == [second.id])
  }

  @Test func routineStartFreezesPlanAndFreeStartKeepsNoRoutine() throws {
    let (_, gym) = fixture()
    var draft = draft(gym)
    #expect(gym.saveRoutine(&draft))
    #expect(gym.startWorkout(routineId: draft.id) != nil)
    let session = try #require(gym.openSession), frozen = SessionPlan(draft.current)
    draft.current.name = "Tomorrow"
    draft.current.entries[0].sets = [SetTarget(reps: 5, weightKg: 80)]
    #expect(gym.saveRoutine(&draft))
    #expect(gym.openSession?.plan == frozen)
    #expect(gym.startWorkout(routineId: draft.id) == session.id)
    #expect(gym.openSession?.id == session.id && gym.sessions.count == 1 && gym.refusal != nil)
    #expect(gym.error == "Finish the open workout first.")
    gym.run(FinishSession(id: session.id))
    #expect(gym.startWorkout() != nil)
    #expect(gym.openSession?.routineId == nil && gym.openSession?.plan == nil)
  }

  @Test func missingRoutineReadFailureAndAccountTransitionCannotStartOrSave() {
    let (_, gym) = fixture()
    var draft = draft(gym)
    #expect(gym.startWorkout(routineId: draft.id) == nil)
    #expect(gym.error == "That routine is no longer in your program. Everything you logged against it is still in the log.")
    gym.readFailed = true
    #expect(gym.startWorkout() == nil)
    #expect(gym.openSession == nil)
    gym.readFailed = false; gym.accountTransition = true
    #expect(!gym.saveRoutine(&draft))
    #expect(gym.startWorkout() == nil)
    #expect(gym.routines.isEmpty && gym.openSession == nil)
  }

  @Test func latestTrainedOrderingUsesRetainedFinishedHistory() {
    let (_, gym) = fixture()
    let a = Routine(id: ID("a"), name: "A", position: 0), b = Routine(id: ID("b"), name: "B", position: 1)
    gym.routines = [a, b]
    let moment = gym.log!.moment
    gym.log = TrainingLog(sessions: [Session(id: ID("s"), startedAt: Instant(ms: 1), finishedAt: Instant(ms: 2), historyRoutineId: b.id)], sets: [], moment: moment)
    #expect(gym.routinesByLastTraining.map(\.id) == [b.id, a.id])
    #expect(gym.routineHistory(b.id).map(\.id) == [ID("s")])
  }

  @Test func onlyWaitingProposalsAppear() {
    let (_, gym) = fixture()
    let waiting = Proposal(id: ID("pending"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [])
    let settled = Proposal(id: ID("settled"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Done", changes: [], state: "applied")
    let replaced = Proposal(id: ID("old"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Old", changes: [], supersededBy: waiting.id)
    gym.proposals = [waiting, settled, replaced]
    #expect(gym.waitingRoutineProposals.map(\.id) == [waiting.id])
  }

  @Test func newestProposalUsesCreationStampInsteadOfRecordID() {
    let (harness, gym) = fixture()
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let older: ID<Proposal> = ID("zz-older"), newer: ID<Proposal> = ID("aa-newer")
    gym.run(ProposeRoutine(id: older, routineId: routine.id, name: "Push B", entries: routine.current.entries, summary: "First"))
    harness.advance(ms: 100)
    gym.run(ProposeRoutine(id: newer, routineId: routine.id, name: "Push C", entries: routine.current.entries, summary: "Second"))
    #expect(gym.waitingRoutineProposals.first?.id == newer)
  }
}
