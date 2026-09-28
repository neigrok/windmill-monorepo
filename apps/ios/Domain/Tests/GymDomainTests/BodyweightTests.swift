import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import SyncTesting
import Testing

@Suite struct BodyweightTests {
  @Test func aWeighInIsSavedForItsDayStampedWithTheSaveAndTheOtherPhoneDrawsIt() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))

    let saved = try #require(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.456))))
    a.sync()

    let expected = WeighIn(day: today, kg: 82.46, recordedAt: Instant(ms: 1_800_000_000_000))
    #expect(saved == expected)
    #expect(try a.drawn(WeighIn.self) == [expected])
    #expect(try b.drawn(WeighIn.self) == [expected])
  }

  @Test func weighingADayAgainCorrectsItsOneWeighIn() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
    a.advance(ms: 60_000)

    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 81.9))) != nil)
    a.sync()

    let corrected = WeighIn(day: today, kg: 81.9, recordedAt: Instant(ms: 1_800_000_060_000))
    #expect(try a.drawn(WeighIn.self) == [corrected])
    #expect(try b.drawn(WeighIn.self) == [corrected])
  }

  @Test func theNewestSaveWinsWholeWhenItsWeightIsTheOneItsPhoneAlreadyHeld() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 80.0))) != nil)
    a.sync()
    a.advance(ms: 60_000)
    #expect(committed(try b.runner.run(SaveWeighIn(day: today, kg: 82.0))) != nil)
    a.sync()
    a.advance(ms: 60_000)

    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 80.0))) != nil)
    a.sync()

    let newest = WeighIn(day: today, kg: 80.0, recordedAt: Instant(ms: 1_800_000_120_000))
    #expect(try a.drawn(WeighIn.self) == [newest])
    #expect(try b.drawn(WeighIn.self) == [newest])
  }

  @Test func theLaterOfTwoPhonesSavesWinsWholeOnBoth() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 80.0))) != nil)
    a.sync()
    a.advance(ms: 60_000)
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.0))) != nil)
    a.advance(ms: 60_000)
    #expect(committed(try b.runner.run(SaveWeighIn(day: today, kg: 80.0))) != nil)
    a.sync()

    let later = WeighIn(day: today, kg: 80.0, recordedAt: Instant(ms: 1_800_000_120_000))
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    let (onA, onB) = (try a.drawn(WeighIn.self), try b.drawn(WeighIn.self))
    withKnownIssue("engine: a commit drops a named field equal to what its phone draws; the older weight joins the newer stamp") {
      #expect(onA == [later])
      #expect(onB == [later])
    }
  }

  @Test func aDayAfterTheDevicesTodayIsRefusedAndNothingIsWritten() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let tomorrow = try #require(LocalDay("2027-01-16"))

    let outcome = try a.runner.run(SaveWeighIn(day: tomorrow, kg: 82.4))

    #expect(outcome.refusal == .invalid(Violation(rule: "weighin.day", path: "id", reason: .custom("future"))))
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
    #expect(committed(try east.runner.run(SaveWeighIn(day: utcTomorrow, kg: 82.4))) != nil)
    #expect(try west.runner.run(SaveWeighIn(day: utcToday, kg: 82.4)).refusal
      == .invalid(Violation(rule: "weighin.day", path: "id", reason: .custom("future"))))
  }

  @Test func theFieldRefusesAMissingNumberThenTheBounds() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))

    #expect(try a.runner.run(SaveWeighIn(day: today, kg: nil)).refusal
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .notANumber)))
    #expect(try a.runner.run(SaveWeighIn(day: today, kg: .nan)).refusal
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .notANumber)))
    #expect(try a.runner.run(SaveWeighIn(day: today, kg: 19.99)).refusal
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .below(min: 20))))
    #expect(try a.runner.run(SaveWeighIn(day: today, kg: 400.01)).refusal
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .above(max: 400))))
    #expect(try a.stored(WeighIn.self) == [])
  }

  @Test func thePickerReopensThePickedDayAndTheTypedNumberGoesToIt() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))
    let threeDaysAgo = try #require(LocalDay("2027-01-12"))
    let twoDaysAgo = try #require(LocalDay("2027-01-13"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: threeDaysAgo, kg: 81.0))) != nil)

    let sheet = try a.runner.read(WeighIn.scope, Bodyweight.init)
    #expect(WeighInRules.latestDay(at: try a.runner.moment()) == today)
    #expect(sheet.entry(on: today) == nil)
    #expect(sheet.entry(on: threeDaysAgo) == Bodyweight.Entry(day: threeDaysAgo, kg: 81.0))
    #expect(sheet.entry(on: twoDaysAgo) == nil)
    #expect(committed(try a.runner.run(SaveWeighIn(day: twoDaysAgo, kg: 82.2))) != nil)

    #expect(try a.drawn(WeighIn.self) == [
      WeighIn(day: threeDaysAgo, kg: 81.0, recordedAt: Instant(ms: 1_800_000_000_000)),
      WeighIn(day: twoDaysAgo, kg: 82.2, recordedAt: Instant(ms: 1_800_000_000_000)),
    ])
  }

  @Test func aDeleteIsHeldForItsWindowKeepingTheSeriesAndUndoBringsTheWeighInBack() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    let weighIn = try #require(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))))
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
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
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
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
    a.sync()
    let delete = try #require(try a.runner.run(DeleteWeighIn(ID(today))).receipt)

    let again = try #require(try a.runner.run(SaveWeighIn(day: today, kg: 82.1)).receipt)
    #expect(again.retired == [delete.gestureId])
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
    let weighIn = try #require(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))))
    let delete = try #require(try a.runner.run(DeleteWeighIn(ID(today))).receipt)

    #expect(try a.runner.run(SaveWeighIn(day: today, kg: 8.24)).refusal
      == .invalid(Violation(rule: "weighin.kg", path: "kg", reason: .below(min: 20))))
    #expect(a.undoOffers().map(\.id) == [delete.gestureId])

    #expect(try a.runner.undo(delete.gestureId))
    #expect(try a.drawn(WeighIn.self) == [weighIn])
  }

  @Test func aDayDeletedOnAnotherPhoneCanBeWeighedAgain() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
    a.sync()
    #expect(try b.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: Constants.holdMs)
    a.sync()

    let again = try #require(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.0))))
    a.sync()

    #expect(try a.drawn(WeighIn.self) == [again])
    #expect(try b.drawn(WeighIn.self) == [again])
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  @Test func aSaveFromAPhoneThatHadNotPulledAnotherPhonesDeleteKeepsTheDay() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
    a.sync()
    #expect(try a.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: Constants.holdMs + 1_000)
    let newest = try #require(committed(try b.runner.run(SaveWeighIn(day: today, kg: 82.0))))
    a.sync()

    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    let (onA, onB) = (try a.drawn(WeighIn.self), try b.drawn(WeighIn.self))
    withKnownIssue("engine: a delete wins over a later save of its day from a phone that had not pulled it, with no notice") {
      #expect(onA == [newest])
      #expect(onB == [newest])
    }
  }

  @Test func aHeldDeleteDoesNotLandOverANewerWeighInItsPhoneAlreadyHolds() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    let today = try #require(LocalDay("2027-01-15"))
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
    a.sync()
    #expect(try a.runner.run(DeleteWeighIn(ID(today))).receipt != nil)
    a.advance(ms: 1_000)
    let newer = try #require(committed(try b.runner.run(SaveWeighIn(day: today, kg: 81.0))))
    a.sync()
    #expect(try a.stored(WeighIn.self) == [newer])

    a.advance(ms: Constants.holdMs)
    a.sync()

    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    let (onA, onB) = (try a.drawn(WeighIn.self), try b.drawn(WeighIn.self))
    withKnownIssue("engine: a held delete releases over a newer write of its record that its phone already pulled") {
      #expect(onA == [newer])
      #expect(onB == [newer])
    }
  }

  @Test func aDayPastTheServersTomorrowReturnsAsAFutureNoticeHoldingItsWeight() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let today = try #require(LocalDay("2027-01-15"))
    a.server.refuse(next: 1, code: WeighInRules.badInstant, detail: nil)
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
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
    #expect(committed(try a.runner.run(SaveWeighIn(day: today, kg: 82.4))) != nil)
    var odd = Draft(new: AnotherClientsWeighIn(id: "2027-02-30", kg: 81.0))
    odd.current.kg = 81.5
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

  @Test(arguments: try Contract.vectors("gym/domain/bodyweight-actions.json"))
  func action(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let day = try #require(LocalDay(try input.member("day").asString()))
    switch try vector.input.member("action").asString() {
    case "SaveWeighIn":
      let kg = try input.member("kg")
      let save = SaveWeighIn(day: day, kg: kg.isNull ? nil : try kg.asDouble())
      let decision = try corpus.decision(of: save, vector, result: { ["id": $0.id.json, "fields": .object(fields: $0.fields)] },
                                         refusal: \.form)
      #expect(decision == vector.expect)
    case "DeleteWeighIn":
      #expect(try corpus.decision(of: DeleteWeighIn(ID(day)), vector, result: { _ in .null }, refusal: \.form) == vector.expect)
    case let name:
      throw ContractError("no bodyweight action \(name)")
    }
  }
}

// Another client of the registry's weighin type, writing any id its pattern admits.
struct AnotherClientsWeighIn: Draftable {
  static let type = Gym.Types.weighin
  static let scope = Gym.scope
  static let savesGuarded = false
  static let checks: [Check<AnotherClientsWeighIn>] = []

  let id: ID<AnotherClientsWeighIn>
  var kg: Double?

  init(id: String, kg: Double?) {
    self.id = ID(RecordID(id))
    self.kg = kg
  }

  init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    kg = try r.optionalDouble("kg")
  }

  var fields: [String: JSON] { ["kg": .of(kg)] }
}
