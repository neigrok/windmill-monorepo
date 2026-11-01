import Testing
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
@testable import Windmill

@Suite(.serialized) @MainActor struct GymTransientTests {
  // Each row: what the screen and the room hold, then the band they resolve to, its control and whether it can be sent away.
  @Test func theBandSaysOneThingWithOneControlFromWhatTheScreenAndTheRoomHold() {
    let cap = (id: "notice:refused/0", text: "There is room for 10. Remove one before adding another.")
    func read(_ name: String, readFailed: Bool = false, error: String? = nil, notices: [(id: String, text: String)] = [], local: String? = nil,
              retries: Bool = false, dismisses: Bool = false, noticeText: String? = nil) -> String {
      let band = GymTransient.Band(readFailed: readFailed, error: error, notices: notices, local: local, retries: retries,
                                   dismisses: dismisses, noticeText: noticeText)
      guard let band else { return "\(name): nothing" }
      let control = band.control.map { [$0.title, $0.symbol].compactMap { $0 }.joined(separator: " ") } ?? "no control"
      return "\(name): \(band) · \(control) · \(band.dismissible ? "dismissible" : "stays")"
    }
    let table = [
      read("read failure, screen message", readFailed: true, error: "The log did not answer.", local: "History could not be read.", dismisses: true),
      read("read failure, room error", readFailed: true, error: "The log did not answer.", notices: [cap]),
      read("read failure alone", readFailed: true),
      read("local with retry", error: "A save failed.", notices: [cap], local: "History could not be read.", retries: true),
      read("local with retry and dismissal", local: "History could not be read.", retries: true, dismisses: true),
      read("local with dismissal", local: "Check the weight.", dismisses: true),
      read("local alone", local: "Check the weight."),
      read("error", error: "A save failed."),
      read("newer error over a notice", error: "A save failed.", notices: [cap]),
      read("error a notice says", error: cap.text, notices: [cap]),
      read("error the screen's notice words say", error: "This workout is full.", notices: [cap], noticeText: "This workout is full."),
      read("notice", notices: [(id: "notice:refused/a", text: "Check the values and try again."), cap]),
      read("notice in the screen's words", notices: [cap], noticeText: "This workout is full."),
      read("nothing held"),
    ].joined(separator: "\n")
    #expect(table == """
      read failure, screen message: readFailure("History could not be read.") · Try again · stays
      read failure, room error: readFailure("The log did not answer.") · Try again · stays
      read failure alone: readFailure("Gym could not be read from this phone. Try again.") · Try again · stays
      local with retry: local("History could not be read.", retries: true, dismisses: false) · Try again · stays
      local with retry and dismissal: local("History could not be read.", retries: true, dismisses: true) · Try again · dismissible
      local with dismissal: local("Check the weight.", retries: false, dismisses: true) · Dismiss message xmark · dismissible
      local alone: local("Check the weight.", retries: false, dismisses: false) · no control · stays
      error: error("A save failed.") · Dismiss message xmark · dismissible
      newer error over a notice: error("A save failed.") · Dismiss message xmark · dismissible
      error a notice says: notice("notice:refused/0", "There is room for 10. Remove one before adding another.") · Dismiss message xmark · dismissible
      error the screen's notice words say: notice("notice:refused/0", "This workout is full.") · Dismiss message xmark · dismissible
      notice: notice("notice:refused/0", "There is room for 10. Remove one before adding another.") · Dismiss message xmark · dismissible
      notice in the screen's words: notice("notice:refused/0", "This workout is full.") · Dismiss message xmark · dismissible
      nothing held: nothing
      """)
  }

  @Test func localValidationAndDismissibleErrorsHaveDistinctActions() throws {
    let (_, gym) = GymModelTests().fixture()
    let validating = GymTransient(gym: gym, message: "Check the weight.")
    let local = GymTransient.Band.local("Check the weight.", retries: false, dismisses: false)
    #expect(validating.shown == local)
    #expect(validating.action(local) == nil && validating.dismissal(local) == nil)
    gym.error = "An unrelated save failed."
    let band = GymTransient(gym: gym)
    #expect(band.shown == .error("An unrelated save failed."))
    band.dismissal(.error("An unrelated save failed."))?()
    #expect(band.shown == nil && gym.error == nil)
  }

  // Sending a screen's message away clears the room's error only while it is the same words; a newer error stays.
  @Test func dismissingALocalMessageClearsOnlyTheErrorItMirrors() throws {
    let (_, gym) = GymModelTests().fixture()
    var dismissed = 0
    gym.error = "Gym could not save this change. Try again."
    let mirrored = GymTransient(gym: gym, message: gym.error, dismiss: { dismissed += 1 })
    mirrored.dismissal(try #require(mirrored.shown))?()
    #expect(dismissed == 1 && gym.error == nil)
    gym.error = "A newer failure."
    let stale = GymTransient(gym: gym, message: "Gym could not save this change. Try again.", dismiss: { dismissed += 1 })
    stale.action(try #require(stale.shown))?()
    #expect(dismissed == 2 && gym.error == "A newer failure.")
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
    let shown = GymTransient.Band.local("History could not be read.", retries: true, dismisses: false)
    #expect(failing.shown == shown && shown.control == .retry)
    failing.action(shown)?()
    #expect(retried && failing.dismissal(shown) == nil)
  }

  @Test func failedReadKeepsRetryAvailableAndCannotBeDismissed() throws {
    let (_, gym) = GymModelTests().fixture()
    gym.readFailed = true
    gym.error = "The log did not answer."
    var retried = false
    let local = GymTransient(gym: gym, message: gym.error, retry: { retried = true })
    #expect(local.shown == .readFailure("The log did not answer."))
    local.action(.readFailure("The log did not answer."))?()
    #expect(retried && local.dismissal(.readFailure("The log did not answer.")) == nil)
    gym.error = nil
    let fallback = GymTransient(gym: gym)
    #expect(fallback.shown == .readFailure("Gym could not be read from this phone. Try again."))
    #expect(fallback.shown?.control == .retry && fallback.dismissal(.readFailure("Gym could not be read from this phone. Try again.")) == nil)
  }
}
