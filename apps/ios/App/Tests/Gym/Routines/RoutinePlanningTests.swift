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
    editing.follow([.targets(ID("bench-press"))])
    #expect(editing.targetDraft == RoutineTargetDraft(sets: [SetTarget(reps: 8, weightKg: 60)]))
    editing.targetDraft.type("12", field: .reps)
    editing.cancelTargets()
    #expect(editing.path.isEmpty && editing.draft.current == stored.current)
    #expect(gym.routines == [stored.current])
    editing.follow([.targets(ID("bench-press"))])
    #expect(editing.targetDraft == RoutineTargetDraft(sets: [SetTarget(reps: 8, weightKg: 60)]))
    editing.cancelTargets()
    editing.pickMovement(); editing.query = "Custom press"
    editing.createMovement(gym)
    let createdID = try #require(editing.creation?.id)
    editing.creation?.name = "Custom press kept"
    editing.follow([.movements])
    editing.createMovement(gym)
    #expect(editing.query == "Custom press" && editing.creation?.id == createdID && editing.creation?.name == "Custom press kept")
    editing.follow([])
    editing.draft.current.name = "Revised"
    let pending = editing.draft.current
    gym.account = "another-owner"; gym.isAnonymous = false
    #expect(!editing.save(gym))
    #expect(editing.refusal == "The account changed while editing. Open the routine again.")
    #expect(editing.draft.current == pending && gym.routines == [stored.current])
    gym.account = nil; gym.isAnonymous = true
    harness.failNextCommit()
    #expect(!editing.save(gym))
    #expect(editing.draft.current == pending && editing.id == stored.id && gym.routines == [stored.current])
    #expect(editing.save(gym))
    #expect(gym.routines == [pending])
  }

  @Test func editorMovesRemovesAndRestoresMovementsInPlace() {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    let (bench, deadlift, chinUp) = (RoutineEntry(exerciseId: ID("bench-press")), RoutineEntry(exerciseId: ID("deadlift")), RoutineEntry(exerciseId: ID("chin-up")))
    [bench, deadlift, chinUp].forEach(editing.select)
    editing.move(2, by: -1)
    #expect(editing.draft.current.entries == [bench, chinUp, deadlift])
    editing.move(0, by: -1); editing.move(2, by: 1)
    #expect(editing.draft.current.entries == [bench, chinUp, deadlift])
    editing.remove(1)
    #expect(editing.draft.current.entries == [bench, deadlift] && editing.removed?.index == 1 && editing.removed?.entry == chinUp)
    editing.undoRemoval()
    #expect(editing.draft.current.entries == [bench, chinUp, deadlift] && editing.removed == nil)
    editing.remove(0); editing.select(bench)
    #expect(editing.draft.current.entries == [chinUp, deadlift, bench] && editing.removed == nil)
  }

  @Test func targetsOpenOnTheSchemeTheirMovementHoldsAndCommitIntoIt() throws {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    editing.select(RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 5, weightKg: 100)]))
    editing.pickMovement(); editing.query = "Sled push"
    editing.createMovement(gym)
    let created = try #require(editing.creation?.id)
    editing.follow([.movements, .creation, .targets(created)])
    #expect(editing.targetDraft == RoutineTargetDraft(sets: nil) && editing.targetDraft.reading == .open)
    editing.targetDraft.type("2", field: .sets)
    editing.setTargets([SetTarget(), SetTarget()])
    #expect(editing.path == [.movements, .creation] && editing.creation?.sets == [SetTarget(), SetTarget()])
    editing.follow([.movements, .creation, .targets(created)])
    #expect(editing.targetDraft == RoutineTargetDraft(sets: [SetTarget(), SetTarget()]))
    editing.follow([.targets(ID("bench-press"))])
    #expect(editing.targetDraft == RoutineTargetDraft(sets: [SetTarget(reps: 5, weightKg: 100)]))
    editing.setTargets(nil)
    #expect(editing.path.isEmpty && editing.draft.current.entries == [RoutineEntry(exerciseId: ID("bench-press"))])
    editing.setTargets([SetTarget(reps: 1)])
    #expect(editing.draft.current.entries == [RoutineEntry(exerciseId: ID("bench-press"))])
  }

  @Test func aRefusalAnswersASaveOrLeavingAChangedNameAndTheNextEditClearsIt() {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    editing.leaveName()
    #expect(editing.refusal == nil)
    editing.draft.current.name = "Push A"
    #expect(editing.refusal == nil)
    #expect(!editing.save(gym) && editing.refusal == "A routine is at least one movement." && gym.error == nil)
    editing.select(RoutineEntry(exerciseId: ID("bench-press")))
    #expect(editing.refusal == nil)
    editing.remove(0)
    #expect(editing.refusal == nil && editing.removals == 1)
    editing.refusal = "This routine could not be saved. Try again."
    #expect(editing.refusal == "This routine could not be saved. Try again.")
    editing.undoRemoval()
    #expect(editing.refusal == nil && editing.draft.current.entries == [RoutineEntry(exerciseId: ID("bench-press"))])
    editing.draft.current.name = " "
    #expect(editing.refusal == nil)
    editing.leaveName()
    #expect(editing.refusal == "Name it to save it.")
  }

  @Test func rowsCountWithRealPluralsAndClaimNeverTrainedOnlyFromAKnownHistory() {
    let moment = Moment(now: Instant(ms: 1_790_424_000_000), zone: FixedZone(offsetSeconds: 0))
    let one = Routine(id: ID("one"), name: "One", entries: [RoutineEntry(exerciseId: ID("bench-press"))])
    let four = Routine(id: ID("four"), name: "Four", entries: ["bench-press", "deadlift", "chin-up", "back-squat"].map { RoutineEntry(exerciseId: ID(RecordID($0))) })
    #expect(RoutineLines.routine(one, lastTrained: nil, historyKnown: true, moment: moment) == "1 movement · never trained")
    #expect(RoutineLines.routine(four, lastTrained: nil, historyKnown: false, moment: moment) == "4 movements")
    #expect(RoutineLines.routine(four, lastTrained: Instant(ms: moment.now.ms - 3 * 86_400_000), historyKnown: true, moment: moment) == "4 movements · trained 3 days ago")
    #expect(RoutineLines.routine(one, lastTrained: Instant(ms: moment.now.ms - 86_400_000), historyKnown: false, moment: moment) == "1 movement · trained yesterday")
    #expect(RoutineLines.routine(one, lastTrained: moment.now, historyKnown: true, moment: nil) == "1 movement · never trained")
    let session = Session(id: ID("s"), startedAt: Instant(ms: 1), finishedAt: Instant(ms: 2))
    let set = TrainingSet(id: ID("set-one1"), sessionId: session.id, exerciseId: ID("bench-press"), weightKg: 100, reps: 5, completedAt: Instant(ms: 1))
    let warmup = TrainingSet(id: ID("set-two2"), sessionId: session.id, exerciseId: ID("deadlift"), weightKg: 60, reps: 5, kind: "warmup", completedAt: Instant(ms: 1))
    #expect(RoutineLines.session(SessionReadout(session: session, sets: [set])) == "1 working set · 1 movement")
    #expect(RoutineLines.session(SessionReadout(session: session, sets: [set, warmup])) == "1 working set · 2 movements")
    #expect(RoutineLines.session(SessionReadout(session: session, sets: [warmup])) == "0 working sets · 1 movement")
  }

  @Test func aProposalSaysWhoProposedItAndOnlyAServerStampedTime() {
    let moment = Moment(now: Instant(ms: 1_790_424_000_000), zone: FixedZone(offsetSeconds: 0))
    let dates = GymDate(moment, locale: Locale(identifier: "en_US"))
    let coach = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [])
    let agent = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp", connection: "My laptop", agent: "Claude")
    let unnamed = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp", connection: "My laptop")
    let anonymous = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp")
    let other = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "import")
    #expect(RoutineLines.proposal(coach, createdAt: nil, dates: dates) == "From Coach")
    #expect([agent, unnamed, anonymous, other].map { RoutineLines.proposal($0, createdAt: nil, dates: dates) }
            == ["From Claude", "From My laptop", "From a connected tool", "From a connected tool"])
    #expect([Int64(2), 1, 0].map { RoutineLines.proposal(coach, createdAt: Instant(ms: moment.now.ms - $0 * 86_400_000), dates: dates) }
            == ["From Coach · Sep 24", "From Coach · Yesterday", "From Coach · 12:00\u{202F}PM"])
    #expect(RoutineLines.proposal(coach, createdAt: moment.now, dates: nil) == "From Coach")
  }

  // The row's time is the log's stamp on the proposal, so a proposal still on the phone says only who proposed it.
  @Test func aWaitingProposalsRowSaysWhenTheLogTookIt() throws {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: "routines-owner",
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: AppRuntime.commandResultWrites)
    let gym = GymModel(runner: harness.runner, locale: Locale(identifier: "en_US")); gym.account = "routines-owner"
    gym.run(CreateExercise(Exercise(id: ID("timed-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("timed-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("timed-bench"))]))
    #expect(gym.saveRoutine(&routine))
    harness.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("timed-proposal"), routineId: routine.id, name: "Push A", entries: [RoutineEntry(exerciseId: ID("timed-bench"), sets: [SetTarget(reps: 8, weightKg: 62.5)])], summary: "Heavier"))?.refusal == nil)
    let unsent = try #require(gym.waitingRoutineProposals.first)
    let lines = [gym.proposalLine(unsent)]
    harness.sync(); gym.refresh()
    let taken = try #require(gym.waitingRoutineProposals.first)
    #expect(lines + [gym.proposalLine(taken)] == ["From Coach", "From Coach · 12:00\u{202F}PM"])
  }

  @Test func aProposalIsNamedByItsRoutineAndWhatItChanges() throws {
    let (_, gym) = fixture()
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let heavier = [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 62.5)]), RoutineEntry(exerciseId: ID("deadlift"))]
    #expect(gym.run(ProposeRoutine(id: ID("change"), routineId: routine.id, name: "Push A", entries: heavier, summary: "Heavier"))?.refusal == nil)
    #expect(gym.run(ProposeRoutine(id: ID("removal"), routineId: routine.id, name: "Push A", entries: [], summary: "Gone", removing: true))?.refusal == nil)
    let titles = Dictionary(uniqueKeysWithValues: gym.waitingRoutineProposals.map { ($0.id, gym.proposalTitle($0)) })
    #expect(titles == [ID("change"): "Push A · 2 changes", ID("removal"): "Push A · a removal"])
  }

  // Delete routine in the editor asks nothing: the routine goes at once behind the room's Undo, which names it.
  @Test func theEditorDeletesItsRoutineBehindAnUndoAndRefusesAnotherAccount() throws {
    let (_, gym) = fixture()
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let stranger = RoutineEditingSession(gym: gym, routine: gym.routines.first)
    gym.account = "another-account"
    #expect(!stranger.delete(gym) && stranger.refusal == "The account changed while editing. Open the routine again.")
    gym.account = nil
    let editing = RoutineEditingSession(gym: gym, routine: gym.routines.first)
    #expect(editing.delete(gym) && gym.routines.isEmpty)
    let offer = try #require(gym.undoOffers.last)
    #expect(offer.line == "Routine deleted" && gym.undo(offer.id) && gym.routines.map(\.id) == [routine.id])
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
    gym.readFailed = false; gym.accountChanging = true
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
    gym.proposals = [waiting, settled, replaced]; gym.outOfDateProposals = [replaced.id]
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
