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
import SwiftUI
import UIKit
@testable import Windmill

@MainActor struct RoutinePlanningTests {
  func fixture() -> (Harness, GymModel) {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }
  func draft(_ gym: GymModel, name: String = "Push A") -> Draft<Routine> {
    Draft(new: Routine(id: gym.runner.mint(Routine.self), name: name, entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 60)])]))
  }

  @Test func receivedOtherTargetsKeepSignedLoadsAndStayOnTheirMovement() throws {
    let (_, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "Assistance", pattern: "pull", equipment: "other", stepKg: 2.5)
    gym.run(CreateExercise(exercise))
    var routine = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Assistance day",
      entries: [RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 8, weightKg: -5)])]))
    #expect(gym.saveRoutine(&routine))
    let edit = RoutineEditingSession(gym: gym, routine: routine.current)
    edit.editMovement(exercise.id, gym: gym)
    #expect(edit.form?.problem == nil && edit.form?.basis.signed == true)
    #expect(edit.form?.targets.sets == [SetTarget(reps: 8, weightKg: -5)])
    edit.form?.targets.retargetAll { $0.weightKg = -1 }
    #expect(edit.stageMovement(gym))
    #expect(edit.save(gym))
    #expect(gym.routines == [Routine(id: routine.id, name: "Assistance day",
      entries: [RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 8, weightKg: -1)])])])
    #expect(gym.catalogue.find(exercise.id) == exercise)
    #expect(!MovementEquipment.choices.contains("other"))
    let unknown = Exercise(id: exercise.id, name: exercise.name, pattern: "pull", equipment: "unknown", stepKg: 2.5)
    #expect(MovementFormDraft(exercise: unknown, base: unknown, entry: routine.current.entries.first).problem == "Choose equipment.")
  }

  @Test func anAssistedTargetOnAMovementTurnedBarbellRefusesTheSave() throws {
    let (_, gym) = fixture()
    let exercise = Exercise(id: gym.runner.mint(Exercise.self), name: "Assisted dip", pattern: "press", equipment: "bodyweight", stepKg: 2.5)
    gym.run(CreateExercise(exercise))
    var routine = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Dip day",
      entries: [RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 8, weightKg: -10)])]))
    #expect(gym.saveRoutine(&routine))
    let edit = RoutineEditingSession(gym: gym, routine: routine.current)
    edit.editMovement(exercise.id, gym: gym)
    edit.form?.equipment = "barbell"
    #expect(edit.stageMovement(gym))
    #expect(!edit.save(gym))
    #expect(edit.refusal == RoutinePlanning.belowFloor)
    #expect(gym.routines == [Routine(id: routine.id, name: "Dip day",
      entries: [RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 8, weightKg: -10)])])])
    #expect(gym.catalogue.find(exercise.id) == exercise)
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

  @Test func editorCancelRestoresIdentityAndTargetsAndOuterSaveIsTheOnlyWrite() throws {
    let (harness, gym) = fixture()
    var stored = draft(gym)
    #expect(gym.saveRoutine(&stored))
    let editing = RoutineEditingSession(gym: gym, routine: stored.current)
    editing.editMovement(ID("bench-press"), gym: gym)
    #expect(editing.form?.targets.sets == [SetTarget(reps: 8, weightKg: 60)])
    editing.form?.name = "Cancelled press"
    editing.form?.targets.retargetAll { $0.reps = 12 }
    editing.cancelMovement()
    #expect(editing.form == nil && editing.draft.current == stored.current)
    #expect(gym.routines == [stored.current])
    editing.editMovement(ID("bench-press"), gym: gym)
    #expect(editing.form?.name == "Bench Press")
    #expect(editing.form?.targets.sets == [SetTarget(reps: 8, weightKg: 60)])
    editing.form?.name = "My press"
    editing.form?.targets.retargetAll { $0.reps = 12 }
    #expect(editing.stageMovement(gym))
    #expect(gym.catalogue.find(ID("bench-press"))?.name == "Bench Press")
    #expect(gym.routines == [stored.current])
    let pending = editing.draft.current
    gym.account = "another-owner"; gym.isAnonymous = false
    #expect(!editing.save(gym))
    #expect(editing.refusal == "The account changed while editing. Open the routine again.")
    #expect(editing.draft.current == pending && gym.routines == [stored.current])
    gym.account = nil; gym.isAnonymous = true
    harness.failNextCommit()
    #expect(!editing.save(gym))
    #expect(editing.draft.current == pending && editing.id == stored.id && gym.routines == [stored.current])
    #expect(gym.catalogue.find(ID("bench-press"))?.name == "Bench Press")
    #expect(editing.save(gym))
    #expect(gym.routines == [pending])
    #expect(gym.catalogue.find(ID("bench-press"))?.name == "My press")
  }

  @Test func editorMovesRemovesAndReselectsMovements() {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    let (bench, deadlift, chinUp) = (RoutineEntry(exerciseId: ID("bench-press")), RoutineEntry(exerciseId: ID("deadlift")), RoutineEntry(exerciseId: ID("chin-up")))
    for entry in [bench, deadlift, chinUp] {
      editing.editMovement(entry.exerciseId, gym: gym)
      #expect(editing.stageMovement(gym))
    }
    editing.move(from: IndexSet(integer: 2), to: 1)
    #expect(editing.draft.current.entries == [bench, chinUp, deadlift])
    editing.remove(IndexSet(integer: 1))
    #expect(editing.draft.current.entries == [bench, deadlift])
    editing.editMovement(chinUp.exerciseId, gym: gym); #expect(editing.stageMovement(gym))
    #expect(editing.draft.current.entries == [bench, deadlift, chinUp])
    editing.remove(IndexSet(integer: 0)); editing.editMovement(bench.exerciseId, gym: gym); #expect(editing.stageMovement(gym))
    #expect(editing.draft.current.entries == [deadlift, chinUp, bench])
    editing.remove(IndexSet(integer: 9))
    #expect(editing.draft.current.entries == [deadlift, chinUp, bench])
  }

  @Test func customMovementAndInlineTargetsStayLocalUntilOuterSaveAndSurviveReopen() throws {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    editing.draft.current.name = "Push"
    editing.pickMovement()
    #expect(editing.picking)
    editing.createMovement(named: " Single press ", gym: gym)
    let created = try #require(editing.form?.id)
    #expect(editing.form?.name == "Single press")
    editing.form?.equipment = "dumbbell"; editing.form?.loadCount = 1
    editing.form?.targets.setCount(2)
    editing.form?.targets.retargetAll { $0.reps = 10; $0.weightKg = 16 }
    editing.form?.restSeconds = 90
    #expect(editing.stageMovement(gym))
    #expect(!editing.picking && editing.form == nil)
    #expect(gym.catalogue.find(created) == nil && gym.routines.isEmpty)
    editing.editMovement(created, gym: gym)
    #expect(editing.form?.base == nil)
    #expect(editing.form?.targets.sets == [SetTarget(reps: 10, weightKg: 16), SetTarget(reps: 10, weightKg: 16)] && editing.form?.restSeconds == 90)
    editing.form?.name = "Discarded change"
    editing.form?.targets.setCount(0)
    editing.cancelMovement()
    #expect(editing.exercise(created, in: gym)?.name == "Single press")
    #expect(editing.draft.current.entries == [RoutineEntry(exerciseId: created, sets: [SetTarget(reps: 10, weightKg: 16), SetTarget(reps: 10, weightKg: 16)], restSeconds: 90)])
    #expect(editing.save(gym))
    #expect(gym.catalogue.find(created)?.name == "Single press")
    #expect(gym.catalogue.find(created)?.loadCount == 1)
    #expect(gym.routines.first?.entries == editing.draft.current.entries)
  }

  @Test func discardedOuterSessionAndRemovedNewMovementNeverWriteCatalogue() throws {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    editing.draft.current.name = "Push"
    editing.pickMovement(); editing.createMovement(named: "Never saved", gym: gym)
    let created = try #require(editing.form?.id)
    #expect(editing.stageMovement(gym))
    editing.editMovement(ID("bench-press"), gym: gym)
    editing.form?.name = "Also not saved"
    #expect(editing.stageMovement(gym))
    #expect(gym.routines.isEmpty && gym.catalogue.find(created) == nil)
    let reopened = RoutineEditingSession(gym: gym, routine: nil)
    #expect(reopened.draft.current.entries.isEmpty && reopened.movements.isEmpty)
    editing.remove(IndexSet(integer: 0))
    #expect(editing.movements[created] == nil)
    #expect(editing.save(gym))
    #expect(gym.catalogue.find(created) == nil)
    #expect(gym.catalogue.find(ID("bench-press"))?.name == "Also not saved")
  }

  @Test func accountTransitionAndAFullRoutinePreventAStageAndKeepTheForm() throws {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    editing.editMovement(ID("bench-press"), gym: gym)
    editing.form?.targets.setCount(2)
    editing.form?.targets.retargetAll { $0.weightKg = -12.5 }
    gym.account = "changed"
    #expect(!editing.stageMovement(gym))
    #expect(editing.form?.targets.shared.weightKg == -12.5 && editing.draft.current.entries.isEmpty)
    #expect(editing.refusal == "The account changed while editing. Open the routine again.")
    gym.account = nil
    editing.form?.name = ""
    #expect(!editing.stageMovement(gym) && editing.form != nil)
    editing.form?.name = "Bench Press"
    #expect(editing.stageMovement(gym) && editing.form == nil)
    editing.draft.current.entries += (1...49).map { RoutineEntry(exerciseId: ID(RecordID("movement-\($0)"))) }
    #expect(editing.full)
    editing.editMovement(ID("deadlift"), gym: gym)
    #expect(!editing.stageMovement(gym) && editing.form != nil && editing.draft.current.entries.count == 50)
  }

  @Test func aRefusalAnswersASaveOrLeavingAChangedNameAndTheNextEditClearsIt() {
    let (_, gym) = fixture()
    let editing = RoutineEditingSession(gym: gym, routine: nil)
    editing.leaveName()
    #expect(editing.refusal == nil)
    editing.draft.current.name = "Push A"
    #expect(editing.refusal == nil)
    #expect(!editing.save(gym) && editing.refusal == "A routine is at least one movement." && gym.error == nil)
    editing.editMovement(ID("bench-press"), gym: gym); #expect(editing.stageMovement(gym))
    #expect(editing.refusal == nil)
    editing.remove(IndexSet(integer: 0))
    #expect(editing.refusal == nil && editing.draft.current.entries.isEmpty)
    editing.refusal = "This routine could not be saved. Try again."
    #expect(editing.refusal == "This routine could not be saved. Try again.")
    editing.editMovement(ID("bench-press"), gym: gym); #expect(editing.stageMovement(gym))
    #expect(editing.refusal == nil && editing.draft.current.entries == [RoutineEntry(exerciseId: ID("bench-press"))])
    editing.draft.current.name = " "
    #expect(editing.refusal == nil && editing.nameRefusal == nil)
    editing.leaveName()
    #expect(editing.nameRefusal == "Name it to save it." && editing.refusal == nil)
    #expect(!editing.save(gym) && editing.nameRefusal == "Name it to save it." && editing.refusal == nil)
    editing.draft.current.name = "Push A"
    #expect(editing.nameRefusal == nil)
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
    let other = TrainingSet(id: ID("set-two2"), sessionId: session.id, exerciseId: ID("deadlift"), weightKg: 60, reps: 5, completedAt: Instant(ms: 1))
    #expect(RoutineLines.session(SessionReadout(session: session, sets: [set], catalogue: Catalogue(custom: [], names: []))) == "1 set · 1 movement")
    #expect(RoutineLines.session(SessionReadout(session: session, sets: [set, other], catalogue: Catalogue(custom: [], names: []))) == "2 sets · 2 movements")
  }

  @Test func aProposalSaysWhoProposedItAndOnlyAServerStampedTime() {
    let moment = Moment(now: Instant(ms: 1_790_424_000_000), zone: FixedZone(offsetSeconds: 0))
    let dates = GymDate(moment, locale: Locale(identifier: "en_US"))
    let coach = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [])
    // A connection is the credential's opaque id, an OAuth client's 43 characters here, and is never shown as a name.
    let agent = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp",
                         connection: "eO4duDroOGDrZom5uTyYSeAm1_Z2pk5dMrq02EDf7uU", agent: "Claude")
    let lowercase = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp",
                             connection: "eO4duDroOGDrZom5uTyYSeAm1_Z2pk5dMrq02EDf7uU", agent: "claude.ai")
    let unnamed = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp",
                           connection: "eO4duDroOGDrZom5uTyYSeAm1_Z2pk5dMrq02EDf7uU")
    let anonymous = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "mcp")
    let other = Proposal(id: ID("p"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [], door: "import")
    #expect(RoutineLines.proposal(coach, createdAt: nil, dates: dates) == "From Coach")
    #expect([agent, lowercase, unnamed, anonymous, other].map { RoutineLines.proposal($0, createdAt: nil, dates: dates) }
            == ["From Claude", "From claude.ai", "From a connected tool", "From a connected tool", "From a connected tool"])
    #expect([coach, agent, unnamed, anonymous, other].map(\.sourceSymbol) == ["bubble.left.and.bubble.right", "link", "link", "link", "link"])
    #expect([Int64(2), 1, 0].map { RoutineLines.proposal(coach, createdAt: Instant(ms: moment.now.ms - $0 * 86_400_000), dates: dates) }
            == ["From Coach · Sep 24", "From Coach · Yesterday", "From Coach · 12:00\u{202F}PM"])
    #expect(RoutineLines.proposal(coach, createdAt: moment.now, dates: nil) == "From Coach")
  }

  // The row's time is the log's stamp on the proposal, so a proposal still on the phone says only who proposed it.
  @Test func aWaitingProposalsRowSaysWhenTheLogTookIt() throws {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: "routines-owner",
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: AppRuntime.commandResultWrites)
    let gym = GymModel(runner: harness.runner, locale: Locale(identifier: "en_US")); gym.account = "routines-owner"
    gym.run(CreateExercise(Exercise(id: ID("timed-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("timed-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("timed-bench"))]))
    #expect(gym.saveRoutine(&routine))
    harness.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("timed-proposal"), routineId: routine.id, name: "Push A", entries: [RoutineEntry(exerciseId: ID("timed-bench"), sets: [SetTarget(reps: 8, weightKg: 62.5)])], summary: "Heavier"))?.refusal == nil)
    let unsent = try #require(gym.routineProposals.first)
    let lines = [gym.proposalLine(unsent)]
    harness.sync(); gym.refresh()
    let taken = try #require(gym.routineProposals.first)
    #expect(lines + [gym.proposalLine(taken)] == ["From Coach", "From Coach · 12:00\u{202F}PM"])
  }

  // A removal's receipt row and a waiting proposal's row read the word their card stands on: Removed once the log took the
  // removal, Not applied once it refused an Apply — never Out of date for a refusal that says nothing of the routine. A
  // refused removal still waits, and is its receipt's row alone.
  @Test func aProposalsRowReadsTheWordItsCardStandsOn() throws {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: "routines-owner",
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: AppRuntime.commandResultWrites)
    let gym = GymModel(runner: harness.runner, locale: Locale(identifier: "en_US")); gym.account = "routines-owner"
    gym.run(CreateExercise(Exercise(id: ID("word-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routines = ["push", "pull", "legs"].map { Draft(new: Routine(id: ID(RecordID("word-" + $0)), name: $0.capitalized, entries: [RoutineEntry(exerciseId: ID("word-bench"))])) }
    for index in routines.indices { #expect(gym.saveRoutine(&routines[index])) }
    harness.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("word-removed"), routineId: routines[0].id, name: "", entries: [], summary: "Remove", removing: true))?.refusal == nil)
    #expect(gym.run(ProposeRoutine(id: ID("word-refused-removal"), routineId: routines[1].id, name: "", entries: [], summary: "Remove", removing: true))?.refusal == nil)
    #expect(gym.run(ProposeRoutine(id: ID("word-refused-change"), routineId: routines[2].id, name: "Legs B", entries: routines[2].current.entries, summary: "Rename"))?.refusal == nil)
    harness.sync(); gym.refresh()
    func decide(_ id: String, _ refused: Bool) throws {
      #expect(gym.coachDecideProposal(try #require(gym.proposals.first { $0.id == ID(RecordID(id)) }), apply: true))
      if refused { harness.server.refuse(code: .invalid) }
      harness.sync(); gym.refresh()
    }
    try decide("word-removed", false); try decide("word-refused-removal", true); try decide("word-refused-change", true)
    #expect(gym.routineRemovalReceipts.map { [$0.proposal.id.description, gym.coachProposalWord($0.proposal) ?? "-"] } == [
      ["word-refused-removal", "Not applied"], ["word-removed", "Removed"]])
    #expect(gym.proposals.first { $0.id == ID("word-refused-removal") }?.state == "pending")
    #expect(gym.routineProposals.map { [$0.id.description, gym.proposalLine($0)] } == [["word-refused-change", "Not applied"]])
    let cards = ["word-removed", "word-refused-removal", "word-refused-change"].map { ProposalCard(gym: gym, id: $0) }
    #expect(cards.map { [$0.stance == .applied ? "applied" : "open", $0.failure ?? "-", $0.decision(stalled: false).retries ? $0.decision(stalled: false).title : "-"] } == [
      ["applied", "-", "-"], ["open", "Not applied.", "Try again"], ["open", "Not applied.", "Try again"]])
  }

  @Test func aProposalIsNamedByItsRoutineAndWhatItChanges() throws {
    let (_, gym) = fixture()
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let heavier = [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 62.5)]), RoutineEntry(exerciseId: ID("deadlift"))]
    #expect(gym.run(ProposeRoutine(id: ID("change"), routineId: routine.id, name: "Push A", entries: heavier, summary: "Heavier"))?.refusal == nil)
    #expect(gym.run(ProposeRoutine(id: ID("removal"), routineId: routine.id, name: "Push A", entries: [], summary: "Gone", removing: true))?.refusal == nil)
    let titles = Dictionary(uniqueKeysWithValues: gym.routineProposals.map { ($0.id, gym.proposalTitle($0)) })
    #expect(titles == [ID("change"): "Push A · 2 changes", ID("removal"): "Push A · a removal"])
  }

  @Test func theEditorDeletesItsRoutineImmediatelyAndRefusesAnotherAccount() throws {
    let (_, gym) = fixture()
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let stranger = RoutineEditingSession(gym: gym, routine: gym.routines.first)
    gym.account = "another-account"
    #expect(!stranger.delete(gym) && stranger.refusal == "The account changed while editing. Open the routine again.")
    gym.account = nil
    let editing = RoutineEditingSession(gym: gym, routine: gym.routines.first)
    #expect(editing.delete(gym) && gym.routines.isEmpty)
    #expect(GymModel(runner: gym.runner).routines.isEmpty)
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

  @Test func deletionPersistsAndLeavesSessionHistory() throws {
    let (_, gym) = fixture()
    var draft = draft(gym)
    #expect(gym.saveRoutine(&draft))
    #expect(gym.startWorkout(routineId: draft.id) != nil)
    let session = try #require(gym.openSession)
    #expect(gym.run(FinishSession(id: session.id))?.refusal == nil)
    let receipt = try #require(gym.run(DeleteRoutine(draft.id))?.receipt)
    #expect(gym.routines.isEmpty)
    #expect(gym.routineHistory(draft.id).map(\.id) == [session.id])
    #expect(receipt.releaseAt == nil && GymModel(runner: gym.runner).routines.isEmpty)
  }

  @Test func multipleRoutineDeletesPersistImmediately() throws {
    let (harness, gym) = fixture()
    var first = draft(gym, name: "First"), second = draft(gym, name: "Second")
    #expect(gym.saveRoutine(&first) && gym.saveRoutine(&second))
    let firstDelete = try #require(gym.run(DeleteRoutine(first.id))?.receipt)
    let secondDelete = try #require(gym.run(DeleteRoutine(second.id))?.receipt)
    #expect(firstDelete.releaseAt == nil && secondDelete.releaseAt == nil)
    #expect(try harness.stored(Routine.self).isEmpty)
    #expect(GymModel(runner: harness.runner).routines.isEmpty)
  }

  @Test func routineStartFreezesPlanAndTheNextStartTakesTheEditedRoutine() throws {
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
    #expect(gym.startWorkout(routineId: draft.id) != nil)
    #expect(gym.openSession?.routineId == draft.id && gym.openSession?.plan == SessionPlan(draft.current))
  }

  @Test func missingRoutineReadFailureAndAccountTransitionCannotStartOrSave() {
    let (_, gym) = fixture()
    var draft = draft(gym)
    #expect(gym.startWorkout(routineId: draft.id) == nil)
    #expect(gym.error == "That routine can’t be found. No workout was started.")
    gym.readFailed = true
    #expect(gym.startWorkout(routineId: draft.id) == nil)
    #expect(gym.openSession == nil)
    gym.readFailed = false; gym.accountChanging = true
    #expect(!gym.saveRoutine(&draft))
    #expect(gym.startWorkout(routineId: draft.id) == nil)
    #expect(gym.routines.isEmpty && gym.openSession == nil)
  }

  @Test func latestTrainedOrderingUsesRetainedFinishedHistory() {
    let (_, gym) = fixture()
    let a = Routine(id: ID("a"), name: "A", position: 0), b = Routine(id: ID("b"), name: "B", position: 1)
    gym.routines = [a, b]
    let moment = gym.log!.moment
    gym.log = TrainingLog(sessions: [Session(id: ID("s"), startedAt: Instant(ms: 1), finishedAt: Instant(ms: 2), historyRoutineId: b.id)], sets: [], moment: moment, catalogue: Catalogue(custom: [], names: []))
    #expect(gym.routinesByLastTraining.map(\.id) == [b.id, a.id])
    #expect(gym.routineHistory(b.id).map(\.id) == [ID("s")])
  }

  @Test func aCoachProposalAppearsOnlyWhileItWaits() {
    let (_, gym) = fixture()
    let waiting = Proposal(id: ID("pending"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Change", changes: [])
    let settled = Proposal(id: ID("settled"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Done", changes: [], state: "applied")
    let replaced = Proposal(id: ID("old"), routineId: ID("r"), intent: "update", proposedName: "A", summary: "Old", changes: [], supersededBy: waiting.id)
    gym.proposals = [waiting, settled, replaced]; gym.outOfDateProposals = [replaced.id: .replaced]
    #expect(gym.routineProposals.map(\.id) == [waiting.id])
  }

  // A connected tool's proposal gone out of date keeps its row, Out of date, the door to its card without Apply or Reject; a
  // Coach proposal leaves for its card in the conversation, and a newer proposal or a routine out of sight takes the row away.
  @Test func aConnectedToolsOutOfDateProposalKeepsItsRowAsTheDoorToItsReview() {
    let (_, gym) = fixture()
    gym.isAnonymous = false; gym.account = "routines-owner"
    gym.routines = ["push", "legs", "pull", "arms", "core"].map { Routine(id: ID(RecordID($0)), name: $0.capitalized, entries: [RoutineEntry(exerciseId: ID("bench-press"))]) }
    let proposal = { (id: String, routine: String, door: String, state: String) in
      Proposal(id: ID(RecordID(id)), routineId: ID(RecordID(routine)), intent: "revise", proposedName: routine.capitalized, summary: "Heavier",
               changes: [], door: door, agent: door == "mcp" ? "Claude" : "", state: state, changeCount: 1)
    }
    gym.proposals = [proposal("a-tool-edited", "push", "mcp", "pending"), proposal("b-tool-set-aside", "legs", "mcp", "superseded"),
                     proposal("c-coach-set-aside", "pull", "ask", "superseded"), proposal("d-coach-newer", "arms", "ask", "pending"),
                     proposal("e-tool-older", "arms", "mcp", "superseded"), proposal("f-tool-gone", "gone", "mcp", "pending"),
                     proposal("g-tool-waiting", "core", "mcp", "pending"), proposal("h-tool-applied", "core", "mcp", "applied")]
    gym.outOfDateProposals = [ID("a-tool-edited"): .routineChanged, ID("b-tool-set-aside"): .replaced, ID("c-coach-set-aside"): .replaced,
                              ID("e-tool-older"): .replaced, ID("f-tool-gone"): .routineChanged]
    #expect(gym.routineProposals.map { [$0.id.description, gym.proposalTitle($0), gym.proposalLine($0)] } == [
      ["a-tool-edited", "Push · 1 change", "Out of date"], ["b-tool-set-aside", "Legs · 1 change", "Out of date"],
      ["d-coach-newer", "Arms · 1 change", "From Coach"], ["g-tool-waiting", "Core · 1 change", "From Claude"]])
    let cards = ["a-tool-edited", "b-tool-set-aside", "g-tool-waiting"].map { ProposalCard(gym: gym, id: $0) }
    #expect(cards.map { [$0.outOfDate ?? "-", "\($0.decidable)", "\($0.pending)"] } == [
      ["Push changed after this suggestion. Nothing was applied.", "false", "false"],
      ["A newer suggestion replaced this one. Nothing was applied.", "false", "false"], ["-", "true", "false"]])
  }

  // One visit to the editor is one screen event, however often the picker pushes over it and the form opens; each records its own.
  @Test func anEditorVisitRecordsOneScreenEventAndEachStepItsOwn() async throws {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let telemetry = TelemetryRecorder(), gym = GymModel(runner: harness.runner, telemetry: telemetry)
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let editing = RoutineEditingSession(gym: gym, routine: routine.current)
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    // Without animations a push or pop lands within a run-loop turn, so a short settle shows any second event it records.
    UIView.setAnimationsEnabled(false)
    window.rootViewController = UIHostingController(rootView: RoutineEditor(gym: gym, editing: editing) { _ in })
    window.makeKeyAndVisible()
    defer { window.isHidden = true; window.rootViewController = nil; previousKeyWindow?.makeKeyAndVisible(); UIView.setAnimationsEnabled(true) }
    let screens = { telemetry.entries.withLock { $0.filter { $0.name == "gym_screen_viewed" }.compactMap { $0.properties["screen"] } } }
    func settle(_ count: Int) async throws {
      for _ in 0..<100 where screens().count < count { try await Task.sleep(for: .milliseconds(20)) }
      try await Task.sleep(for: .milliseconds(100))
    }
    try await settle(1)
    for visit in 1...2 {
      editing.editMovement(ID("bench-press"), gym: gym); try await settle(1 + visit)
      editing.cancelMovement(); try await settle(1 + visit)
    }
    editing.pickMovement(); try await settle(4)
    editing.createMovement(named: "Made here", gym: gym); try await settle(5)
    editing.cancelMovement(); editing.picking = false; try await settle(5)
    #expect(screens() == ["routine_editor", "routine_movement_editor", "routine_movement_editor", "routine_movement", "routine_movement_editor"])
  }

  @Test func newestProposalUsesCreationStampInsteadOfRecordID() {
    let (harness, gym) = fixture()
    var routine = draft(gym)
    #expect(gym.saveRoutine(&routine))
    let older: ID<Proposal> = ID("zz-older"), newer: ID<Proposal> = ID("aa-newer")
    gym.run(ProposeRoutine(id: older, routineId: routine.id, name: "Push B", entries: routine.current.entries, summary: "First"))
    harness.advance(ms: 100)
    gym.run(ProposeRoutine(id: newer, routineId: routine.id, name: "Push C", entries: routine.current.entries, summary: "Second"))
    #expect(gym.routineProposals.first?.id == newer)
  }
}
