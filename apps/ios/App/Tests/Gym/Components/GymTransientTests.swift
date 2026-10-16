import Testing
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
@testable import Windmill

@Suite(.serialized) @MainActor struct GymTransientTests {
  @Test func refusalReplacesPendingUndoThenTheNewestUndoReturns() throws {
    let (_, gym) = GymModelTests().fixture()
    let older = try #require(GymUndoOffer(id: "older", releaseAt: Int64.max - 1, holding: [RecordKey(Note.type, "note")]))
    let newer = try #require(GymUndoOffer(id: "newer", releaseAt: Int64.max, holding: ["a", "b", "c"].map { RecordKey(TrainingSet.type, RecordID($0)) }))
    gym.undoOffers = [older, newer]
    let validating = GymTransient(gym: gym, message: "Check the weight.")
    #expect(validating.shown == .local("Check the weight."))
    #expect(validating.action(.local("Check the weight.")) == nil && validating.dismissal(.local("Check the weight.")) == nil)
    gym.error = "An unrelated save failed."
    let band = GymTransient(gym: gym)
    #expect(band.shown == .error("An unrelated save failed."))
    band.dismissal(.error("An unrelated save failed."))?()
    #expect(band.shown == .undo(newer) && band.shown?.text == "3 sets deleted")
    #expect(band.actionTitle(.undo(newer)) == "Undo")
    gym.undoOffers.removeLast()
    #expect(band.shown == .undo(older) && band.shown?.text == "Note deleted")
  }

  // Each kind a gesture holds is named once, the parent first: a discarded workout takes its sets with it.
  @Test func anOfferIsNamedByTheRecordsItsGestureHolds() {
    let line = { (records: [RecordKey]) in GymUndoOffer(id: "gesture", releaseAt: 0, holding: records)?.line }
    #expect(line([RecordKey(Session.type, "push"), RecordKey(TrainingSet.type, "a"), RecordKey(TrainingSet.type, "b")]) == "Workout discarded")
    #expect(line([RecordKey(TrainingSet.type, "a")]) == "Set deleted")
    #expect(line([RecordKey(TrainingSet.type, "a"), RecordKey(TrainingSet.type, "b"), RecordKey(TrainingSet.type, "a")]) == "2 sets deleted")
    #expect(line([RecordKey(WeighIn.type, "2026-09-26")]) == "Weigh-in deleted")
    #expect(line([RecordKey(Routine.type, "push")]) == "Routine deleted")
    #expect(line([RecordKey(Note.type, "note")]) == "Note deleted")
    #expect(line([RecordKey(Exercise.type, "custom")]) == nil)
  }

  @Test func everyUndoBandNamesWhatWentAndARelaunchReadsTheSameLines() throws {
    let runtime = try GymModelTests().runtime(), gym = GymModel(runner: runtime.runner, runtime: runtime)
    let today = try gym.runner.moment().today, start = try gym.runner.moment().now.ms - 3_600_000
    let note = gym.runner.mint(Note.self), session = gym.runner.mint(Session.self)
    var routine = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Push A",
                                     entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 5, weightKg: 60)])]))
    var weighIn = try gym.logWeighInDraft(day: today)
    weighIn.current.kg = 80
    let sets = [1, 2].map { minute in
      ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: ID("bench-press"), weightKg: 60, reps: 5,
                  completedAt: Instant(ms: start + Int64(minute) * 60_000))
    }
    #expect(gym.run(SaveNoteCall(Note(id: note, title: "Kept")))?.refusal == nil && gym.saveRoutine(&routine))
    #expect(gym.logSaveWeighIn(&weighIn) == nil)
    #expect(gym.run(ImportSession(id: session, startedAt: Instant(ms: start), finishedAt: Instant(ms: start + 600_000), sets: sets))?.refusal == nil)
    #expect(gym.run(DeleteNote(note))?.receipt != nil && gym.run(DeleteRoutine(routine.id))?.receipt != nil)
    #expect(gym.logDeleteWeighIn(day: today))
    #expect(gym.run(DeleteSet(sets[0].id))?.receipt != nil && gym.run(DiscardSession(session))?.receipt != nil)
    #expect(GymTransient(gym: gym).shown?.text == "Workout discarded")
    let relaunched = GymModel(runner: runtime.runner, runtime: runtime)
    var lines: [String?] = []
    for _ in 0..<5 {
      guard let offer = relaunched.undoOffers.last else { break }
      lines.append(GymTransient(gym: relaunched).shown?.text)
      guard relaunched.undo(offer.id) else { break }
    }
    #expect(lines == ["Workout discarded", "Set deleted", "Weigh-in deleted", "Routine deleted", "Note deleted"])
    #expect(relaunched.notes.map(\.id) == [note] && relaunched.routines.map(\.id) == [routine.id] && relaunched.sets.count == 2)
  }

  @Test func aRunWithoutTheEnginesStoreNamesItsOwnOffer() throws {
    let (_, gym) = GymModelTests().fixture(), note = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: note, title: "Kept")))
    let receipt = try #require(gym.run(DeleteNote(note))?.receipt)
    #expect(gym.undoOffers.map(\.id) == [receipt.gestureId] && gym.undoOffers.map(\.line) == ["Note deleted"])
  }

  // A swipe down sends an Undo band away and the act stays: the hold runs out, and leaving the app keeps it for good.
  @Test func dismissingAnUndoBandKeepsTheAct() throws {
    let telemetry = TelemetryRecorder(), runtime = try GymModelTests().runtime(telemetry: telemetry)
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry), note = gym.runner.mint(Note.self)
    gym.run(SaveNoteCall(Note(id: note, title: "Gone")))
    gym.run(DeleteNote(note))
    let band = GymTransient(gym: gym), shown = try #require(band.shown)
    let swipe = try #require(band.dismissal(shown))
    swipe()
    gym.refresh()
    #expect(band.shown == nil && gym.undoOffers.isEmpty && gym.notes.isEmpty)
    #expect(telemetry.entries.withLock { $0.last.map { [$0.name] + $0.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" } } }
            == ["gym_undo", "action=dismiss", "screen=gym"])
    gym.background()
    #expect(GymModel(runner: runtime.runner, runtime: runtime).notes.isEmpty)
    var undone = false, kept = false
    let held = GymTransient(gym: gym, held: .init(text: "Workout discarded", undo: { undone = true }, keep: { kept = true }))
    held.dismissal(.held("Workout discarded"))?()
    #expect(kept && !undone)
    #expect(GymTransient(gym: gym, held: .init(text: "Workout discarded") {}).dismissal(.held("Workout discarded")) == nil)
  }

  @Test func durableNoticeOutranksUndoAndReturnsAfterANewerFailure() throws {
    let (_, gym) = GymModelTests().fixture()
    let notice = DomainNotice<GymRefusal>(Notice(id: "notice:refused/0", product: "gym", scope: Gym.scope,
      code: .cap, detail: .object(["type": .string(Routine.type), "cap": 10]),
      content: NoticeContent(), at: 0), registry: SyncSchema.registry)
    let offer = try #require(GymUndoOffer(id: "delete", releaseAt: Int64.max, holding: [RecordKey(Routine.type, "push")]))
    gym.notices = [notice]
    gym.error = gym.message(notice.refusal)
    gym.undoOffers = [offer]
    let transient = GymTransient(gym: gym)
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    gym.error = "The latest write failed."
    #expect(transient.shown == .error("The latest write failed."))
    transient.dismissal(.error("The latest write failed."))?()
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    transient.dismissal(.notice(notice.id, gym.message(notice.refusal)))?()
    #expect(transient.shown == .undo(offer))
  }

  @Test func screenRetryAndHeldUndoKeepTheirOrder() throws {
    let (_, gym) = GymModelTests().fixture()
    gym.undoOffers = [try #require(GymUndoOffer(id: "delete", releaseAt: Int64.max, holding: [RecordKey(Note.type, "note")]))]
    var retried = false, restored = false
    let failing = GymTransient(gym: gym, message: "History could not be read.", retryMessage: { retried = true },
                               held: .init(text: "Conversation removed") { restored = true })
    #expect(failing.shown == .local("History could not be read."))
    #expect(failing.actionTitle(.local("History could not be read.")) == "Try again")
    failing.action(.local("History could not be read."))?()
    #expect(retried)
    let holding = GymTransient(gym: gym, held: .init(text: "Conversation removed") { restored = true })
    #expect(holding.shown == .held("Conversation removed"))
    holding.action(.held("Conversation removed"))?()
    #expect(restored)
  }

  @Test func failedReadKeepsRetryAvailableAndCannotBeDismissed() throws {
    let (_, gym) = GymModelTests().fixture()
    gym.readFailed = true
    gym.error = "The log did not answer."
    var retried = false
    let local = GymTransient(gym: gym, message: gym.error, retry: { retried = true })
    #expect(local.shown == .error("The log did not answer."))
    local.action(.error("The log did not answer."))?()
    #expect(retried && local.dismissal(.error("The log did not answer.")) == nil)
    gym.error = nil
    let fallback = GymTransient(gym: gym)
    #expect(fallback.shown == .error("Gym could not be read from this phone. Try again."))
    #expect(fallback.actionTitle(.error("Gym could not be read from this phone. Try again.")) == "Try again")
    gym.undoOffers = [try #require(GymUndoOffer(id: "delete", releaseAt: Int64.max, holding: [RecordKey(Note.type, "note")]))]
    #expect(fallback.shown == .error("Gym could not be read from this phone. Try again."))
  }
}
