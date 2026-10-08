import Testing
import DomainKit
import GymDomain
import SyncAPI
import SyncSchema
@testable import Windmill

@Suite(.serialized) @MainActor struct GymTransientTests {
  @Test func pendingUndoStaysAvailableAlongsideLocalValidation() {
    let (_, gym) = GymModelTests().fixture()
    gym.error = "An unrelated save failed."
    gym.undoOffers = [
      UndoOffer(id: "older", scope: Gym.scope, releaseAt: Int64.max - 1),
      UndoOffer(id: "newer", scope: Gym.scope, releaseAt: Int64.max),
    ]
    let transient = GymTransient(gym: gym, message: "Check the weight.")
    #expect(transient.shown == .undo("newer"))
    gym.undoOffers.removeLast()
    #expect(transient.shown == .undo("older"))
    gym.undoOffers.removeAll()
    #expect(transient.shown == .local("Check the weight."))
    #expect(transient.action(.local("Check the weight.")) == nil)
    #expect(gym.error == "An unrelated save failed.")
  }

  @Test func durableNoticeReappearsAfterUndoWindowAndLocalFailure() {
    let (_, gym) = GymModelTests().fixture()
    let notice = DomainNotice<GymRefusal>(Notice(id: "notice:refused/0", product: "gym", scope: Gym.scope,
      code: .cap, detail: .object(["type": .string(Routine.type), "cap": 10]),
      content: NoticeContent(), at: 0), registry: SyncSchema.registry)
    gym.notices = [notice]
    gym.error = gym.message(notice.refusal)
    gym.undoOffers = [UndoOffer(id: "delete", scope: Gym.scope, releaseAt: Int64.max)]
    let transient = GymTransient(gym: gym)
    #expect(transient.shown == .undo("delete"))
    gym.undoOffers.removeAll()
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    gym.error = "The latest write failed."
    #expect(transient.shown == .error("The latest write failed."))
    transient.dismissMessage(.error("The latest write failed."))
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    #expect(gym.notices.map(\.id) == [notice.id])
  }

  @Test func failedReadKeepsRetryAvailableAfterMessageDismissal() {
    let (_, gym) = GymModelTests().fixture()
    gym.readFailed = true
    gym.error = "The log did not answer."
    var retried = false
    let local = GymTransient(gym: gym, message: gym.error, retry: { retried = true })
    #expect(local.shown == .error("The log did not answer."))
    local.action(.error("The log did not answer."))?()
    #expect(retried)
    local.dismissMessage(.error("The log did not answer."))
    let fallback = GymTransient(gym: gym)
    #expect(fallback.shown == .error("Gym could not be read from this phone. Try again."))
    #expect(fallback.action(.error("Gym could not be read from this phone. Try again.")) != nil)
  }
}
