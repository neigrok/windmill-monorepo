import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncStore
@testable import Windmill

@Suite(.serialized) @MainActor struct BodyweightLogTests {
  func fixture() -> (Harness, GymModel) {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    return (harness, GymModel(runner: harness.runner))
  }

  @Test(arguments: ["", " ", ".", "kg", "-80", "80 kg", "8e1", "８０", "80\n1"])
  func refusesNonNumbers(typed: String) {
    #expect(BodyweightLogInput.parse(typed) == .refused("That is not a number yet."))
  }

  @Test(arguments: ["80..1", "80,1.2", "80,,1"])
  func refusesDuplicateDecimals(typed: String) {
    #expect(BodyweightLogInput.parse(typed) == .refused("One decimal point only."))
  }

  @Test(arguments: ["19.999", "400.001", "0", "999999999999999999999999999999"])
  func checksBoundsBeforeRounding(typed: String) {
    #expect(BodyweightLogInput.parse(typed) == .refused("Between 20 and 400 kg — check the number."))
  }

  @Test func acceptsCommaBoundsAndRoundsHalfUp() {
    #expect(BodyweightLogInput.parse(" 82,405 ") == .weight(82.41))
    #expect(BodyweightLogInput.parse("20") == .weight(20))
    #expect(BodyweightLogInput.parse("400.") == .weight(400))
    #expect(BodyweightLogInput.kilograms(82.4) == "82.4")
    #expect(BodyweightLogInput.kilograms(82) == "82")
    #expect(BodyweightLogInput.kilograms(82.405) == "82.41")
  }

  @Test func newAndReplacementKeepOneEntryPerDayAndStampSave() throws {
    let (harness, gym) = fixture(), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    #expect(draft.isNew)
    draft.current.kg = 82.4
    #expect(gym.logSaveWeighIn(&draft) == nil && !draft.isNew)
    let firstStamp = try #require(draft.current.recordedAt)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 82.4)])
    harness.advance(ms: 1_000)
    var correction = try gym.logWeighInDraft(day: day)
    #expect(!correction.isNew && correction.current.kg == 82.4)
    correction.current.kg = 81.95
    #expect(gym.logSaveWeighIn(&correction) == nil)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 81.95)])
    #expect(correction.current.recordedAt?.ms == firstStamp.ms + 1_000)
    #expect(try harness.stored(WeighIn.self).count == 1)
    harness.sync()
    #expect(harness.server.rows(Gym.scope, of: nil).isEmpty)
  }

  @Test func failedSaveKeepsDraftAndStoredWeightForRetry() throws {
    let (harness, gym) = fixture(), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    draft.current.kg = 80
    #expect(gym.logSaveWeighIn(&draft) == nil)
    draft.current.kg = 81
    harness.failNextCommit()
    #expect(gym.logSaveWeighIn(&draft) == "That weigh-in could not be saved. Try again.")
    #expect(draft.current.kg == 81 && draft.base.kg == 80)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 80)])
    #expect(gym.logSaveWeighIn(&draft) == nil)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 81)])
  }

  @Test func futureAndInvalidWeightNeverWrite() throws {
    let (_, gym) = fixture(), day = try gym.runner.moment().today
    var future = try gym.logWeighInDraft(day: day.adding(days: 1))
    future.current.kg = 80
    #expect(gym.logSaveWeighIn(&future) == "A weigh-in is not a forecast — today or earlier.")
    var invalid = try gym.logWeighInDraft(day: day)
    #expect(gym.logSaveWeighIn(&invalid) == "That is not a number yet.")
    invalid.current.kg = 401
    #expect(gym.logSaveWeighIn(&invalid) == "Between 20 and 400 kg — check the number.")
    #expect(gym.bodyweight?.entries.isEmpty == true)
  }

  @Test func failedDeleteKeepsEntryThenHeldDeleteCanUndo() throws {
    let (harness, gym) = fixture(), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    draft.current.kg = 80
    #expect(gym.logSaveWeighIn(&draft) == nil)
    harness.failNextCommit()
    #expect(!gym.logDeleteWeighIn(day: day))
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 80)])
    #expect(gym.logDeleteWeighIn(day: day))
    #expect(gym.bodyweight?.entries.isEmpty == true && gym.bodyweight?.stance == .holding)
    #expect(try harness.stored(WeighIn.self).map(\.kg) == [80])
    let offer = try #require(gym.undoOffers.first)
    #expect(gym.undo(offer.id))
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 80)])
    #expect(gym.logDeleteWeighIn(day: day))
    harness.advance(ms: Constants.holdMs + 1); gym.refresh()
    #expect(gym.bodyweight?.entries.isEmpty == true && gym.undoOffers.isEmpty)
  }

  @Test func unknownEmptyRecentAllAndGapsFollowLocalCalendar() throws {
    let (_, gym) = fixture(), moment = try gym.runner.moment(), today = moment.today
    let empty = Bodyweight(stored: [], drawn: [], firstPullComplete: true, at: moment)
    let unknown = Bodyweight(stored: [], drawn: [], firstPullComplete: false, at: moment)
    #expect(empty.stance == .empty && unknown.stance == .unknown)
    let entries = [
      WeighIn(day: today.adding(days: -90), kg: 70),
      WeighIn(day: today.adding(days: -89), kg: 71),
      WeighIn(day: today.adding(days: -82), kg: 72),
      WeighIn(day: today.adding(days: -74), kg: 73),
      WeighIn(day: today.adding(days: 1), kg: 74),
    ]
    let weight = Bodyweight(stored: entries, drawn: entries, firstPullComplete: true, at: moment)
    #expect(weight.entries.map(\.kg) == [70, 71, 72, 73])
    #expect(weight.chart(.recent).dots.map(\.kg) == [71, 72, 73])
    #expect(weight.chart(.all).dots.map(\.kg) == [70, 71, 72, 73])
    #expect(weight.chart(.recent).gaps == [Bodyweight.Gap(after: today.adding(days: -82), before: today.adding(days: -74))])
    #expect(weight.reading == Bodyweight.Reading(entry: Bodyweight.Entry(day: today.adding(days: -74), kg: 73), daysAgo: 74))
    #expect(weight.entry(on: today.adding(days: -89)) == Bodyweight.Entry(day: today.adding(days: -89), kg: 71))
    let old = [WeighIn(day: today.adding(days: -90), kg: 70)]
    let oldWeight = Bodyweight(stored: old, drawn: old, firstPullComplete: true, at: moment)
    #expect(oldWeight.stance == .holding && oldWeight.chart(.recent).dots.isEmpty && oldWeight.chart(.all).dots.count == 1)
  }

  @Test func readFailureRetainsWeighInsAndRetryRestoresRead() throws {
    let fault = GymStoreFault(), runtime = try GymModelTests().runtime(failing: fault)
    let gym = GymModel(runner: runtime.runner, runtime: runtime), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    draft.current.kg = 80
    #expect(gym.logSaveWeighIn(&draft) == nil)
    let saved = gym.bodyweight
    fault.point.withLock { $0 = .read }; gym.refresh()
    #expect(gym.readFailed && gym.bodyweight == saved)
    fault.point.withLock { $0 = nil }; gym.refresh()
    #expect(!gym.readFailed && gym.bodyweight == saved)
  }

  @Test func accountChangeBlocksWeightSaveAndDelete() throws {
    let (_, gym) = fixture(), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    draft.current.kg = 80
    gym.accountTransition = true
    #expect(gym.logSaveWeighIn(&draft) == "Wait for the account change to finish.")
    #expect(!gym.logDeleteWeighIn(day: day))
    #expect(draft.isNew && gym.bodyweight?.entries.isEmpty == true)
  }
}
