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
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
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
    #expect(BodyweightLogInput.parse(typed) == .refused("Between 20 and 400 kg"))
  }

  @Test func acceptsCommaBoundsAndRoundsHalfUp() {
    #expect(BodyweightLogInput.parse(" 82,405 ") == .weight(82.41))
    #expect(BodyweightLogInput.parse("20") == .weight(20))
    #expect(BodyweightLogInput.parse("400.") == .weight(400))
    #expect(BodyweightLogInput.kilograms(82.4) == "82.4")
    #expect(BodyweightLogInput.kilograms(82) == "82")
    #expect(BodyweightLogInput.kilograms(82.405) == "82.41")
  }

  @Test func theSheetsCheckmarkWaitsForAWeightItCouldSave() {
    let saved = Bodyweight.Entry(day: LocalDay("2026-09-26")!, kg: 82.4)
    let cases: [(String, String?, Bodyweight.Entry?)] = [
      ("", nil, nil), ("  ", nil, nil), ("19", nil, nil), ("19", "Between 20 and 400 kg", nil), ("82.4", nil, nil),
      ("82.4", nil, saved), ("82.40", nil, saved), ("82.5", nil, saved), (".", nil, saved),
    ]
    #expect(cases.map { BodyweightLogInput.canSave($0.0, refusal: $0.1, entry: $0.2) } == [false, false, false, false, true, false, false, true, false])
  }

  @Test func newAndReplacementKeepOneEntryPerDayAndStampSave() throws {
    let (harness, gym) = fixture(), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    #expect(draft.isNew)
    draft.current.kg = 82.4
    #expect(gym.logSaveWeighIn(&draft) == nil && !draft.isNew)
    let firstStamp = try #require(draft.current.recordedAt)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 82.4, recordedAt: firstStamp)])
    harness.advance(ms: 1_000)
    var correction = try gym.logWeighInDraft(day: day)
    #expect(!correction.isNew && correction.current.kg == 82.4)
    correction.current.kg = 81.95
    #expect(gym.logSaveWeighIn(&correction) == nil)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 81.95, recordedAt: correction.current.recordedAt)])
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
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 80, recordedAt: draft.base.recordedAt)])
    #expect(gym.logSaveWeighIn(&draft) == nil)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 81, recordedAt: draft.current.recordedAt)])
  }

  @Test func weighInWritesReportBoundedOutcomesAndStorageFailures() throws {
    let (harness, _) = fixture(), telemetry = TelemetryRecorder()
    let gym = GymModel(runner: harness.runner, telemetry: telemetry), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    draft.current.kg = 82.46
    #expect(gym.logSaveWeighIn(&draft) == nil)
    draft.current.kg = 82.5
    harness.failNextCommit()
    #expect(gym.logSaveWeighIn(&draft) == "That weigh-in could not be saved. Try again.")
    #expect(gym.logSaveWeighIn(&draft) == nil)
    draft.current.kg = 401
    #expect(gym.logSaveWeighIn(&draft) == "Between 20 and 400 kg")
    #expect(gym.logDeleteWeighIn(day: day))
    let events = telemetry.entries.withLock { $0.filter { $0.properties["screen"] == "weigh_in" }.map(\.properties) }
    #expect(events == [
      ["screen": "weigh_in", "action": "create", "outcome": "saved"],
      ["screen": "weigh_in", "action": "update", "outcome": "failed"],
      ["screen": "weigh_in", "action": "update", "outcome": "saved"],
      ["screen": "weigh_in", "action": "update", "outcome": "refused"],
      ["screen": "weigh_in", "action": "discard", "outcome": "saved"],
    ])
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } ==
            [["operation": "gym_action", "failure_kind": "storage"]])
  }

  @Test func futureAndInvalidWeightNeverWrite() throws {
    let (_, gym) = fixture(), day = try gym.runner.moment().today
    var future = try gym.logWeighInDraft(day: day.adding(days: 1))
    future.current.kg = 80
    #expect(gym.logSaveWeighIn(&future) == "A weigh-in is not a forecast — today or earlier.")
    var invalid = try gym.logWeighInDraft(day: day)
    #expect(gym.logSaveWeighIn(&invalid) == "That is not a number yet.")
    invalid.current.kg = 401
    #expect(gym.logSaveWeighIn(&invalid) == "Between 20 and 400 kg")
    #expect(gym.bodyweight?.entries.isEmpty == true)
  }

  @Test func failedDeleteKeepsEntryThenSuccessfulDeletePersists() throws {
    let (harness, gym) = fixture(), day = try gym.runner.moment().today
    var draft = try gym.logWeighInDraft(day: day)
    draft.current.kg = 80
    #expect(gym.logSaveWeighIn(&draft) == nil)
    harness.failNextCommit()
    #expect(!gym.logDeleteWeighIn(day: day))
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 80, recordedAt: draft.current.recordedAt)])
    #expect(gym.logDeleteWeighIn(day: day))
    #expect(gym.bodyweight?.entries.isEmpty == true && gym.bodyweight?.stance == .empty)
    #expect(try harness.stored(WeighIn.self).isEmpty)
    #expect(GymModel(runner: harness.runner).bodyweight?.entries.isEmpty == true)
  }

  @Test func failedReweighPreservesDeletionAndRetrySavesNewWeight() throws {
    let fault = GymStoreFault(), runtime = try GymModelTests().runtime(failing: fault)
    let gym = GymModel(runner: runtime.runner, runtime: runtime), day = try gym.runner.moment().today
    var first = try gym.logWeighInDraft(day: day)
    first.current.kg = 80
    #expect(gym.logSaveWeighIn(&first) == nil && gym.logDeleteWeighIn(day: day))
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    var reweigh = try gym.logWeighInDraft(day: day)
    reweigh.current.kg = 82.45
    #expect(gym.logSaveWeighIn(&reweigh) == "That weigh-in could not be saved. Try again.")
    fault.point.withLock { $0 = nil }; gym.refresh()
    #expect(gym.bodyweight?.entries.isEmpty == true)
    #expect(gym.logSaveWeighIn(&reweigh) == nil)
    let recordedAt = try #require(reweigh.current.recordedAt)
    #expect(gym.bodyweight?.entries == [Bodyweight.Entry(day: day, kg: 82.45, recordedAt: recordedAt)])
  }

  // A weigh-in row reads its weight first and its day after: today and yesterday by name, any other day by its date.
  @Test func aWeighInRowReadsItsWeightThenItsDay() {
    let moment = Moment(now: Instant(ms: 1_790_424_000_000), zone: FixedZone(offsetSeconds: 0))
    let dates = GymDate(moment, locale: Locale(identifier: "en_US"))
    let rows = [(0, 82.4), (-1, 82), (-3, 82.5)].map { days, kg in BodyweightScreen.spoken(Bodyweight.Entry(day: moment.today.adding(days: days), kg: kg), dates: dates) }
    #expect(rows == ["82.4 kilograms, Today", "82 kilograms, Yesterday", "82.5 kilograms, Sep 23"])
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
    gym.accountChanging = true
    #expect(gym.logSaveWeighIn(&draft) == "Wait for the account change to finish.")
    #expect(!gym.logDeleteWeighIn(day: day))
    #expect(draft.isNew && gym.bodyweight?.entries.isEmpty == true)
  }
}
