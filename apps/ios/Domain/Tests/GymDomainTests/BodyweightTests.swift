import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import SyncTesting
import Testing

@Suite struct BodyweightTests {
  // The sheet: the picked day's weigh-in opened, or a new one, the typed weight set, and its one save.
  static func weigh(_ h: Harness, _ kg: Double?, on day: LocalDay) throws -> (result: SaveResult<GymRefusal>, sheet: Draft<WeighIn>) {
    var sheet = try h.runner.open(ID(day), orNew: WeighIn(day: day))
    sheet.current.kg = kg
    return (h.runner.save(&sheet, SaveWeighIn.self), sheet)
  }

  // The weigh-in a save stored, as its draft holds it after the save.
  static func weighed(_ h: Harness, _ kg: Double?, on day: LocalDay) throws -> WeighIn {
    let (result, sheet) = try weigh(h, kg, on: day)
    try #require(saved(result))
    return sheet.current
  }

  @Test func aWeighInIsSavedForItsDayStampedWithTheSaveAndTheOtherPhoneDrawsIt() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))

    let (result, sheet) = try BodyweightTests.weigh(a, 82.456, on: today)
    a.sync()

    let expected = WeighIn(day: today, kg: 82.46, recordedAt: Instant(ms: 1_800_000_000_000))
    #expect(saved(result) && sheet.current == expected && !sheet.isNew && !sheet.isDirty)
    #expect(try a.drawn(WeighIn.self) == [expected])
    #expect(try b.drawn(WeighIn.self) == [expected])
  }

  @Test func weighingADayAgainCorrectsItsOneWeighIn() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.advance(ms: 60_000)

    _ = try BodyweightTests.weighed(a, 81.9, on: today)
    a.sync()

    let corrected = WeighIn(day: today, kg: 81.9, recordedAt: Instant(ms: 1_800_000_060_000))
    #expect(try a.drawn(WeighIn.self) == [corrected])
    #expect(try b.drawn(WeighIn.self) == [corrected])
  }

  @Test func theNewestSaveWinsWholeWhenItsWeightIsTheOneItsPhoneAlreadyHeld() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 80.0, on: today)
    a.sync()
    a.advance(ms: 60_000)
    _ = try BodyweightTests.weighed(b, 82.0, on: today)
    a.sync()
    a.advance(ms: 60_000)

    _ = try BodyweightTests.weighed(a, 80.0, on: today)
    a.sync()

    let newest = WeighIn(day: today, kg: 80.0, recordedAt: Instant(ms: 1_800_000_120_000))
    #expect(try a.drawn(WeighIn.self) == [newest])
    #expect(try b.drawn(WeighIn.self) == [newest])
  }

  @Test func theLaterOfTwoPhonesSavesWinsWholeOnBoth() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 80.0, on: today)
    a.sync()
    a.advance(ms: 60_000)
    _ = try BodyweightTests.weighed(a, 82.0, on: today)
    a.advance(ms: 60_000)
    _ = try BodyweightTests.weighed(b, 80.0, on: today)
    a.sync()

    let later = WeighIn(day: today, kg: 80.0, recordedAt: Instant(ms: 1_800_000_120_000))
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    let (onA, onB) = (try a.drawn(WeighIn.self), try b.drawn(WeighIn.self))
    #expect(onA == [later])
    #expect(onB == [later])
  }

  // A sheet left open across a pull, saved with the weight it still shows: the save is the newest fact, so it wins whole
  // although nothing on the sheet was touched.
  @Test func aSheetOpenAcrossAPullSavesTheWeightItShows() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 80.0, on: today)
    a.sync()
    var sheetOnB = try b.runner.open(ID(today), orNew: WeighIn(day: today))
    a.advance(ms: 60_000)
    _ = try BodyweightTests.weighed(a, 82.0, on: today)
    a.sync()
    a.advance(ms: 60_000)

    #expect(!sheetOnB.isDirty)
    #expect(saved(b.runner.save(&sheetOnB, SaveWeighIn.self)))
    a.sync()

    let shown = WeighIn(day: today, kg: 80.0, recordedAt: Instant(ms: 1_800_000_120_000))
    #expect(sheetOnB.current == shown)
    #expect(try a.drawn(WeighIn.self) == [shown])
    #expect(try b.drawn(WeighIn.self) == [shown])
  }

  @Test func aDayAfterTheDevicesTodayIsRefusedAndNothingIsWritten() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let tomorrow = try #require(LocalDay("2027-01-16"))

    let (result, sheet) = try BodyweightTests.weigh(a, 82.4, on: tomorrow)

    #expect(refused(result) == .invalid(Violation(rule: "weighin.day", path: "id", reason: .custom("future"))))
    #expect(sheet.isNew && sheet.current == WeighIn(day: tomorrow, kg: 82.4))
    #expect(try a.stored(WeighIn.self) == [])
  }

  @Test func theDevicesZoneDecidesWhichDayIsToday() throws {
    let east = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_055_800_000),
                       zone: FixedZone(offsetSeconds: 3_600))
    let west = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_799_978_400_000),
                       zone: FixedZone(offsetSeconds: -18_000))
    let utcToday = try #require(LocalDay("2027-01-15"))
    let utcTomorrow = try #require(LocalDay("2027-01-16"))

    #expect(WeighInRules.latestDay(at: try east.runner.moment()) == utcTomorrow)
    #expect(WeighInRules.latestDay(at: try west.runner.moment()) == LocalDay("2027-01-14"))
    #expect(saved(try BodyweightTests.weigh(east, 82.4, on: utcTomorrow).result))
    #expect(refused(try BodyweightTests.weigh(west, 82.4, on: utcToday).result)
      == .invalid(Violation(rule: "weighin.day", path: "id", reason: .custom("future"))))
  }

  @Test func theFieldRefusesAMissingNumberThenTheBounds() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))

    #expect(refused(try BodyweightTests.weigh(a, nil, on: today).result)
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .notANumber)))
    #expect(refused(try BodyweightTests.weigh(a, .nan, on: today).result)
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .notANumber)))
    #expect(refused(try BodyweightTests.weigh(a, 19.99, on: today).result)
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .below(min: 20))))
    #expect(refused(try BodyweightTests.weigh(a, 400.01, on: today).result)
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .above(max: 400))))
    #expect(try a.stored(WeighIn.self) == [])
  }

  @Test func thePickerReopensThePickedDayAndTheTypedNumberGoesToIt() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))
    let threeDaysAgo = try #require(LocalDay("2027-01-12"))
    let twoDaysAgo = try #require(LocalDay("2027-01-13"))
    _ = try BodyweightTests.weighed(a, 81.0, on: threeDaysAgo)

    let sheet = try a.runner.read(WeighIn.scope, Bodyweight.init)
    #expect(WeighInRules.latestDay(at: try a.runner.moment()) == today)
    #expect(sheet.entry(on: today) == nil)
    #expect(sheet.entry(on: threeDaysAgo) == Bodyweight.Entry(day: threeDaysAgo, kg: 81.0))
    #expect(sheet.entry(on: twoDaysAgo) == nil)
    #expect(try a.runner.open(ID(threeDaysAgo), orNew: WeighIn(day: threeDaysAgo)).current.kg == 81.0)
    _ = try BodyweightTests.weighed(a, 82.2, on: twoDaysAgo)

    #expect(try a.drawn(WeighIn.self) == [
      WeighIn(day: threeDaysAgo, kg: 81.0, recordedAt: Instant(ms: 1_800_000_000_000)),
      WeighIn(day: twoDaysAgo, kg: 82.2, recordedAt: Instant(ms: 1_800_000_000_000)),
    ])
  }

  @Test func aDeleteIsHeldForItsWindowKeepingTheSeriesAndUndoBringsTheWeighInBack() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    let weighIn = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()

    let receipt = try #require(try a.runner.run(DeleteWeighIn(ID(today))).receipt)
    a.sync()
    let held = try a.runner.read(WeighIn.scope, Bodyweight.init)
    #expect(held.stance == .holding && held.reading == nil && held.chart(.recent).dots == [])
    #expect(try a.drawn(WeighIn.self) == [])
    #expect(try a.stored(WeighIn.self) == [weighIn])
    #expect(try b.drawn(WeighIn.self) == [weighIn])
    #expect(a.undoOffers().map(\.id) == [receipt.gestureId])

    #expect(try a.runner.undo(receipt.gestureId))
    a.advance(ms: Constants.holdMs)
    a.sync()
    #expect(try a.drawn(WeighIn.self) == [weighIn])
    #expect(try b.drawn(WeighIn.self) == [weighIn])
    #expect(a.undoOffers().isEmpty)
  }

  @Test func aDeleteLandsWhenItsWindowClosesAndTheRoomInvitesAgain() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()

    let receipt = try #require(try a.runner.run(DeleteWeighIn(ID(today))).receipt)
    a.advance(ms: Constants.holdMs)
    #expect(try !a.runner.undo(receipt.gestureId))
    a.sync()

    #expect(try a.stored(WeighIn.self) == [])
    #expect(try b.stored(WeighIn.self) == [])
    #expect(try a.runner.read(WeighIn.scope, Bodyweight.init).stance == .empty)
    #expect(try unchanged(a.runner.run(DeleteWeighIn(ID(today)))) != nil)
  }

  @Test func weighingTheDayAgainInsideItsDeleteWindowRetiresTheDelete() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()
    let delete = try #require(try a.runner.run(DeleteWeighIn(ID(today))).receipt)

    let (again, sheet) = try BodyweightTests.weigh(a, 82.1, on: today)
    guard case .saved(let rewrite?) = again else { throw ContractError("the weigh-in was not written: \(again)") }
    #expect(sheet.isNew == false && rewrite.retired == [delete.gestureId])
    #expect(a.undoOffers().isEmpty)
    #expect(try !a.runner.undo(delete.gestureId))
    a.advance(ms: Constants.holdMs)
    a.sync()

    let corrected = WeighIn(day: today, kg: 82.1, recordedAt: Instant(ms: 1_800_000_000_000))
    #expect(try a.drawn(WeighIn.self) == [corrected])
    #expect(try b.drawn(WeighIn.self) == [corrected])
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  @Test func aRefusedWeighInsideTheDeleteWindowLeavesTheWindowOpen() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))
    let weighIn = try BodyweightTests.weighed(a, 82.4, on: today)
    let delete = try #require(try a.runner.run(DeleteWeighIn(ID(today))).receipt)

    #expect(refused(try BodyweightTests.weigh(a, 8.24, on: today).result)
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .below(min: 20))))
    #expect(a.undoOffers().map(\.id) == [delete.gestureId])

    #expect(try a.runner.undo(delete.gestureId))
    #expect(try a.drawn(WeighIn.self) == [weighIn])
  }

  @Test func aDayDeletedOnAnotherPhoneCanBeWeighedAgain() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()
    #expect(try b.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: Constants.holdMs)
    a.sync()

    let again = try BodyweightTests.weighed(a, 82.0, on: today)
    a.sync()

    #expect(try a.drawn(WeighIn.self) == [again])
    #expect(try b.drawn(WeighIn.self) == [again])
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  // The sheet was open on the weigh-in when another phone's delete landed: its save is newer than the delete, so it
  // writes the day again rather than being refused gone.
  @Test func aSheetOpenAcrossAnotherPhonesDeleteSavesTheDayAgain() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()
    var sheetOnA = try #require(try a.runner.open(ID<WeighIn>(today)))
    #expect(try b.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: Constants.holdMs)
    a.sync()
    #expect(try a.drawn(WeighIn.self) == [])

    sheetOnA.current.kg = 82.0
    #expect(saved(a.runner.save(&sheetOnA, SaveWeighIn.self)))
    a.sync()

    let kept = WeighIn(day: today, kg: 82.0, recordedAt: Instant(ms: 1_800_000_000_000 + Constants.holdMs))
    #expect(try a.drawn(WeighIn.self) == [kept])
    #expect(try b.drawn(WeighIn.self) == [kept])
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
  }

  @Test func aSaveFromAPhoneThatHadNotPulledAnotherPhonesDeleteKeepsTheDay() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()
    #expect(try a.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: Constants.holdMs + 1_000)
    let newest = try BodyweightTests.weighed(b, 82.0, on: today)
    a.sync()

    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    let (onA, onB) = (try a.drawn(WeighIn.self), try b.drawn(WeighIn.self))
    #expect(onA == [newest])
    #expect(onB == [newest])
  }

  @Test func aHeldDeleteDoesNotLandOverANewerWeighInItsPhoneAlreadyHolds() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()
    #expect(try a.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: 1_000)
    let newer = try BodyweightTests.weighed(b, 81.0, on: today)
    a.sync()
    #expect(try a.stored(WeighIn.self) == [newer])

    a.advance(ms: Constants.holdMs)
    a.sync()

    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    let (onA, onB) = (try a.drawn(WeighIn.self), try b.drawn(WeighIn.self))
    #expect(onA == [newer])
    #expect(onB == [newer])
  }

  @Test func aDayPastTheServersTomorrowReturnsAsAFutureNoticeHoldingItsWeight() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))
    a.server.refuse(next: 1, code: Gym.Codes.badInstant, detail: nil)
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    a.sync()

    let notices = try a.notices(GymRefusal.self)
    #expect(notices.map(\.refusal) == [.future(ID<WeighIn>(today).ref, .notice)])
    #expect(notices.first?.values(of: ID<WeighIn>(today).ref)
      == ["kg": JSON.of(82.4), "recordedAt": JSON(Int64(1_800_000_000_000))])
    #expect(try a.drawn(WeighIn.self) == [])
  }

  @Test func aDayNoCalendarHoldsIsNeverDrawnAndCanBeDeleted() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let otherClient = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    _ = try BodyweightTests.weighed(a, 82.4, on: today)
    var odd = Draft(new: AnotherClientsWeighIn(id: "2027-02-30", kg: 81.0, recordedAt: nil))
    odd.current.kg = 81.5
    odd.current.recordedAt = Instant(ms: 1_800_000_000_000)
    #expect(saved(otherClient.runner.save(&odd, SaveDraft<AnotherClientsWeighIn, GymRefusal>.self)))
    a.sync()
    #expect(a.server.rows(WeighIn.scope, of: "acct-1").map(\.key.id.description).sorted() == ["2027-01-15", "2027-02-30"])

    let read = try a.runner.read(WeighIn.scope, Bodyweight.init)
    #expect(read.stance == .holding)
    #expect(read.entries == [Bodyweight.Entry(day: today, kg: 82.4)])
    #expect(read.reading == Bodyweight.Reading(entry: Bodyweight.Entry(day: today, kg: 82.4), daysAgo: 0))
    #expect(try a.runner.run(DeleteWeighIn(ID(RecordID("2027-02-30")))).receipt != nil)
  }

  @Test func theRoomMakesNoClaimOfAbsenceBeforeTheFirstPull() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    #expect(try a.runner.read(WeighIn.scope, Bodyweight.init).stance == .unknown)
    a.sync()
    #expect(try a.runner.read(WeighIn.scope, Bodyweight.init).stance == .empty)
  }

  // Any action writing a weigh-in, as a Coach `log_bodyweight` would, records the commit's now, whatever its input held:
  // the stamp is `Valid`'s, not the sheet's.
  @Test func aWeighInAnyActionWritesRecordsTheCommitsNow() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    let yesterday = try #require(LocalDay("2027-01-14"))

    #expect(try a.runner.run(LogWeighIn(day: today, kg: 80.0, recordedAt: nil)).receipt != nil)
    #expect(try a.runner.run(LogWeighIn(day: yesterday, kg: 81.0, recordedAt: Instant(ms: 5))).receipt != nil)
    a.sync()

    let logged = [WeighIn(day: yesterday, kg: 81.0, recordedAt: Instant(ms: 1_800_000_000_000)),
                  WeighIn(day: today, kg: 80.0, recordedAt: Instant(ms: 1_800_000_000_000))]
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(try a.drawn(WeighIn.self) == logged)
    #expect(try b.drawn(WeighIn.self) == logged)
  }

  struct LogWeighIn: Action {
    let day: LocalDay
    let kg: Double
    let recordedAt: Instant?

    var scope: ScopeRef { WeighIn.scope }

    func load(_ read: Reader) throws -> Moment { read.moment }

    func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
      var plan = Plan()
      plan.create(try Valid(WeighIn(day: day, kg: kg, recordedAt: recordedAt), at: moment))
      return .write(plan)
    }
  }

  // MARK: - Another client's whole save through the kit

  // A client that stamps nothing and checks nothing still saves a weigh-in whole: every field, whatever it touched.
  @Test func anotherClientsDraftThatEditsOneFieldSavesEveryField() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    var first = Draft(new: AnotherClientsWeighIn(id: "2027-01-15", kg: nil, recordedAt: nil))
    first.current.kg = 80.0
    first.current.recordedAt = Instant(ms: 1_800_000_000_000)
    #expect(saved(a.runner.save(&first, SaveDraft<AnotherClientsWeighIn, GymRefusal>.self)))
    a.sync()
    a.advance(ms: 60_000)
    var onB = try #require(try b.runner.open(ID<AnotherClientsWeighIn>(RecordID("2027-01-15"))))
    onB.current.kg = 82.0
    onB.current.recordedAt = Instant(ms: 1_800_000_060_000)
    #expect(saved(b.runner.save(&onB, SaveDraft<AnotherClientsWeighIn, GymRefusal>.self)))
    a.advance(ms: 60_000)

    var again = try #require(try a.runner.open(ID<AnotherClientsWeighIn>(RecordID("2027-01-15"))))
    again.current.kg = 81.0
    #expect(again.touched == ["kg"])
    #expect(saved(a.runner.save(&again, SaveDraft<AnotherClientsWeighIn, GymRefusal>.self)))
    a.sync()

    let newest = AnotherClientsWeighIn(id: "2027-01-15", kg: 81.0, recordedAt: Instant(ms: 1_800_000_000_000))
    #expect(try a.drawn(AnotherClientsWeighIn.self).map(\.fields) == [newest.fields])
    #expect(try b.drawn(AnotherClientsWeighIn.self).map(\.fields) == [newest.fields])
  }

  @Test func anotherClientsNewDraftThatTouchesOneFieldSavesEveryField() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    var draft = Draft(new: AnotherClientsWeighIn(id: "2027-01-15", kg: nil, recordedAt: nil))
    draft.current.kg = 81.0

    #expect(saved(a.runner.save(&draft, SaveDraft<AnotherClientsWeighIn, GymRefusal>.self)))

    #expect(draft.base.fields == ["kg": JSON.of(81.0), "recordedAt": .null] && !draft.isNew)
    #expect(try a.drawn(AnotherClientsWeighIn.self).map(\.fields) == [draft.current.fields])
  }

  // MARK: - The room's read

  @Test func theReadingIsTheNewestWeighInUpToTodayAndItsAgeInCalendarDays() throws {
    let moment = Moment(now: Instant(ms: 1_800_055_800_000), zone: FixedZone(offsetSeconds: 3_600))
    let older = WeighIn(day: try #require(LocalDay("2027-01-10")), kg: 83.0, recordedAt: moment.now)
    let newest = WeighIn(day: try #require(LocalDay("2027-01-13")), kg: 82.4, recordedAt: moment.now)
    let tomorrow = WeighIn(day: try #require(LocalDay("2027-01-17")), kg: 90.0, recordedAt: moment.now)

    let read = Bodyweight(stored: [older, newest, tomorrow], drawn: [tomorrow, newest, older], firstPullComplete: true,
                          at: moment)
    let none = Bodyweight(stored: [], drawn: [], firstPullComplete: true, at: moment)

    #expect(read.today == LocalDay("2027-01-16"))
    #expect(read.reading == Bodyweight.Reading(entry: Bodyweight.Entry(day: newest.id.day!, kg: 82.4), daysAgo: 3))
    #expect(read.entries == [Bodyweight.Entry(day: older.id.day!, kg: 83.0), Bodyweight.Entry(day: newest.id.day!, kg: 82.4)])
    #expect(read.entry(on: LocalDay("2027-01-17")!) == nil)
    #expect(none.reading == nil && none.stance == .empty)
  }

  @Test func theChartShowsTheLastNinetyDaysOrAllAndNamesEveryGapLongerThanAWeek() throws {
    let moment = Moment(now: Instant(ms: 1_800_000_000_000), zone: FixedZone(offsetSeconds: 0))
    let days = ["2026-10-17", "2026-10-18", "2026-11-01", "2026-11-08", "2026-11-15", "2027-01-15"]
    let weighIns = days.map { WeighIn(day: LocalDay($0)!, kg: 80, recordedAt: moment.now) }
    let read = Bodyweight(stored: weighIns, drawn: weighIns, firstPullComplete: true, at: moment)
    let entry = { (text: String) in Bodyweight.Entry(day: LocalDay(text)!, kg: 80) }
    let gap = { (after: String, before: String) in Bodyweight.Gap(after: LocalDay(after)!, before: LocalDay(before)!) }

    #expect(read.chart(.recent) == Bodyweight.Chart(
      window: .recent,
      dots: ["2026-10-18", "2026-11-01", "2026-11-08", "2026-11-15", "2027-01-15"].map(entry),
      gaps: [gap("2026-10-18", "2026-11-01"), gap("2026-11-15", "2027-01-15")]))
    #expect(read.chart(.all) == Bodyweight.Chart(
      window: .all,
      dots: days.map(entry),
      gaps: [gap("2026-10-18", "2026-11-01"), gap("2026-11-15", "2027-01-15")]))
    #expect(read.entries(from: LocalDay("2026-11-01"), to: LocalDay("2026-11-15"))
      == ["2026-11-01", "2026-11-08", "2026-11-15"].map(entry))
    #expect(read.entries(from: nil, to: LocalDay("2026-10-17")) == [entry("2026-10-17")])
  }

  // MARK: - Checks and vectors

  @Test func theWeighInAgreesWithTheRegistry() throws {
    let sample = WeighIn(day: try #require(LocalDay("2027-01-15")), kg: 82.4, recordedAt: Instant(ms: 1_800_000_000_000))
    try RegistryCheck.entity(WeighIn.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
  }

  // A save is the sheet's: the day's draft opened over the records, the typed weight set, then its one save.
  @Test(arguments: try Contract.vectors("gym/domain/bodyweight-actions.json"))
  func action(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let day = try #require(LocalDay(try input.member("day").asString()))
    let result = switch try vector.input.member("action").asString() {
    case "SaveWeighIn":
      try corpus.save(SaveWeighIn.self, vector, opening: WeighIn(day: day), edit: { $0.kg = try? input.member("kg").asDouble() },
                      result: { ["id": ID<WeighIn>(day).json, "fields": .object(fields: $0.values)] }, refusal: \.form)
    case "DeleteWeighIn":
      try corpus.decision(of: DeleteWeighIn(ID(day)), vector, result: { _ in .null }, refusal: \.form)
    case let name:
      throw ContractError("no bodyweight action \(name)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  @Test(arguments: try Contract.vectors("gym/rules/bodyweight.json"))
  func read(_ vector: Vector) throws {
    let day = { (key: String) in try vector.input["input"]?[key].map { try #require(LocalDay(try $0.asString())) } }
    let (from, to) = (try day("from"), try day("to"))
    let result = switch try vector.input.member("read").asString() {
    case "Bodyweight": try ProductCorpus(GymRules.book).read(vector, in: WeighIn.scope) { try Bodyweight($0).form(from: from, to: to) }
    case let name: throw ContractError("no bodyweight read \(name)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}

extension Bodyweight {
  // The form packages/api-contract/gym/domain/README.md states for the room's read.
  func form(from: LocalDay?, to: LocalDay?) -> JSON {
    let entry = { (entry: Entry) -> JSON in ["day": .string(entry.day.text), "kg": .of(entry.kg)] }
    let plot = { (chart: Chart) -> JSON in
      ["dots": .array(chart.dots.map(entry)),
       "gaps": .array(chart.gaps.map { ["after": .string($0.after.text), "before": .string($0.before.text)] })]
    }
    let claim: JSON = switch stance {
    case .unknown: "unknown"
    case .empty: "empty"
    case .holding: "holding"
    }
    return ["stance": claim, "today": .string(today.text),
            "reading": reading.map { ["entry": entry($0.entry), "daysAgo": JSON($0.daysAgo)] } ?? .null,
            "recent": plot(chart(.recent)), "all": plot(chart(.all)), "list": .array(entries(from: from, to: to).map(entry))]
  }
}

// Another client of the registry's weighin type, writing any id its pattern admits, and every field, as a save of a record
// saved whole must.
struct AnotherClientsWeighIn: Draftable {
  static let type = Gym.Types.weighin
  static let scope = Gym.scope
  static let savesGuarded = false
  static let checks: [Check<AnotherClientsWeighIn>] = []

  let id: ID<AnotherClientsWeighIn>
  var kg: Double?
  var recordedAt: Instant?

  init(id: String, kg: Double?, recordedAt: Instant?) {
    self.id = ID(RecordID(id))
    self.kg = kg
    self.recordedAt = recordedAt
  }

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    kg = try r.optionalDouble("kg")
    recordedAt = try r.optionalInstant("recordedAt")
  }

  var fields: [String: JSON] { ["kg": .of(kg), "recordedAt": .of(recordedAt)] }
}
