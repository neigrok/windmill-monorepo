import Testing
import DomainKit
import GymDomain
import SyncAPI
import SyncSchema
@testable import Windmill

@Suite(.serialized) @MainActor struct GymTransientTests {
  @Test func refusalReplacesPendingUndoThenUndoReturnsCounted() {
    let (_, gym) = GymModelTests().fixture()
    gym.undoOffers = [
      UndoOffer(id: "older", scope: Gym.scope, releaseAt: Int64.max - 1),
      UndoOffer(id: "newer", scope: Gym.scope, releaseAt: Int64.max),
    ]
    let validating = GymTransient(gym: gym, message: "Check the weight.")
    #expect(validating.shown == .local("Check the weight."))
    #expect(validating.action(.local("Check the weight.")) == nil)
    gym.error = "An unrelated save failed."
    let band = GymTransient(gym: gym)
    #expect(band.shown == .error("An unrelated save failed."))
    band.dismissMessage(.error("An unrelated save failed."))
    #expect(band.shown == .undo("newer", count: 2))
    #expect(band.shown?.text == "2 changes deleted")
    #expect(band.actionTitle(.undo("newer", count: 2)) == "Undo")
    gym.undoOffers.removeLast()
    #expect(band.shown == .undo("older", count: 1))
    #expect(band.shown?.text == "Change deleted")
  }

  @Test func durableNoticeOutranksUndoAndReturnsAfterANewerFailure() {
    let (_, gym) = GymModelTests().fixture()
    let notice = DomainNotice<GymRefusal>(Notice(id: "notice:refused/0", product: "gym", scope: Gym.scope,
      code: .cap, detail: .object(["type": .string(Routine.type), "cap": 10]),
      content: NoticeContent(), at: 0), registry: SyncSchema.registry)
    gym.notices = [notice]
    gym.error = gym.message(notice.refusal)
    gym.undoOffers = [UndoOffer(id: "delete", scope: Gym.scope, releaseAt: Int64.max)]
    let transient = GymTransient(gym: gym)
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    gym.error = "The latest write failed."
    #expect(transient.shown == .error("The latest write failed."))
    transient.dismissMessage(.error("The latest write failed."))
    #expect(transient.shown == .notice(notice.id, gym.message(notice.refusal)))
    transient.dismissMessage(.notice(notice.id, gym.message(notice.refusal)))
    #expect(transient.shown == .undo("delete", count: 1))
  }

  @Test func screenRetryAndHeldUndoKeepTheirOrder() {
    let (_, gym) = GymModelTests().fixture()
    gym.undoOffers = [UndoOffer(id: "delete", scope: Gym.scope, releaseAt: Int64.max)]
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
    #expect(fallback.actionTitle(.error("Gym could not be read from this phone. Try again.")) == "Try again")
    gym.undoOffers = [UndoOffer(id: "delete", scope: Gym.scope, releaseAt: Int64.max)]
    #expect(fallback.shown == .error("Gym could not be read from this phone. Try again."))
  }
}
