import Testing
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
@testable import Windmill

@Suite(.serialized) @MainActor struct GymTransientTests {
  @Test func localValidationAndDismissibleErrorsHaveDistinctActions() throws {
    let (_, gym) = GymModelTests().fixture()
    let validating = GymTransient(gym: gym, message: "Check the weight.")
    #expect(validating.shown == .local("Check the weight."))
    #expect(validating.action(.local("Check the weight.")) == nil && validating.dismissal(.local("Check the weight.")) == nil)
    gym.error = "An unrelated save failed."
    let band = GymTransient(gym: gym)
    #expect(band.shown == .error("An unrelated save failed."))
    band.dismissal(.error("An unrelated save failed."))?()
    #expect(band.shown == nil)
  }

  @Test func everyRemovalPersistsAcrossRelaunchWithoutTransientControls() throws {
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
    #expect(GymTransient(gym: gym).shown == nil)
    let relaunched = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(relaunched.notes.isEmpty && relaunched.routines.isEmpty && relaunched.sessions.isEmpty)
    #expect(relaunched.log?.sets(session: session) == [] && relaunched.log?.readout(session: session) == nil)
    #expect(relaunched.bodyweight?.entries.isEmpty == true)
    #expect(try runtime.store.read { try $0.device().activeReplica.outbox.allSatisfy { $0.state != .held } })
  }

  @Test func durableNoticeReturnsAfterANewerFailure() throws {
    let (_, gym) = GymModelTests().fixture()
    let notice = DomainNotice<GymRefusal>(Notice(id: "notice:refused/0", product: "gym", scope: Gym.scope,
      code: .cap, detail: .object(["type": .string(Routine.type), "cap": 10]),
      content: NoticeContent(), at: 0), registry: SyncSchema.registry)
    gym.notices = [notice]
    gym.error = gym.message(notice.refusal)
    let transient = GymTransient(gym: gym)
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    gym.error = "The latest write failed."
    #expect(transient.shown == .error("The latest write failed."))
    transient.dismissal(.error("The latest write failed."))?()
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    transient.dismissal(.notice(notice.id, gym.message(notice.refusal)))?()
    #expect(transient.shown == nil)
  }

  @Test func screenFailureOffersItsOwnRetry() throws {
    let (_, gym) = GymModelTests().fixture()
    var retried = false
    let failing = GymTransient(gym: gym, message: "History could not be read.", retryMessage: { retried = true })
    #expect(failing.shown == .local("History could not be read."))
    #expect(failing.actionTitle(.local("History could not be read.")) == "Try again")
    failing.action(.local("History could not be read."))?()
    #expect(retried)
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
    #expect(fallback.shown == .error("Gym could not be read from this phone. Try again."))
  }
}
