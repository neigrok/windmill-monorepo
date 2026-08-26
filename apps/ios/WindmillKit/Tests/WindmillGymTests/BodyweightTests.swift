import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

final class BodyweightReadingTests: XCTestCase {
    private func entry(_ day: String, _ kg: Double, at recordedAt: Int64 = 1) -> BodyweightEntry {
        BodyweightEntry(dateLocal: day, weightKg: kg, recordedAt: recordedAt)
    }

    func testTheReadingIsTheLastWeighInAndItsAgeAndNothingBeforeTheFirst() {
        XCTAssertNil(Bodyweight.reading([], today: "2026-08-25"), "never a dash, never a zero")
        XCTAssertEqual(Bodyweight.reading([entry("2026-08-25", 82.4)], today: "2026-08-25"), "82.4 kg · today")
        XCTAssertEqual(Bodyweight.reading([entry("2026-08-24", 82.4)], today: "2026-08-25"), "82.4 kg · yesterday")
        XCTAssertEqual(Bodyweight.reading([entry("2026-08-22", 82.4)], today: "2026-08-25"), "82.4 kg · 3 days ago")
        XCTAssertEqual(Bodyweight.reading([entry("2026-08-25", 82.4), entry("2026-08-22", 83.0)], today: "2026-08-25"),
                       "82.4 kg · today", "the newest by day, whatever order the series came in")
    }

    // B2: a weigh-in is never in the future. A served row dated after this device's today (a clock behind the
    // log's, a row another surface let through) is never the reading, and the field refuses the day outright.
    func testARowAfterTodayIsNeverTheReadingAndAFutureDayIsRefusedAsAForecast() {
        XCTAssertEqual(Bodyweight.reading([entry("2026-08-22", 83.0), entry("2026-08-27", 82.4)], today: "2026-08-25"),
                       "83 kg · 3 days ago")
        XCTAssertNil(Bodyweight.reading([entry("2026-08-27", 82.4)], today: "2026-08-25"))
        XCTAssertEqual(Bodyweight.notAForecast, "A weigh-in is not a forecast — today or earlier.")
        XCTAssertEqual(Bodyweight.dateRefusal("2026-08-26", today: "2026-08-25"), Bodyweight.notAForecast)
        XCTAssertNil(Bodyweight.dateRefusal("2026-08-25", today: "2026-08-25"))
        XCTAssertNil(Bodyweight.dateRefusal("2026-08-24", today: "2026-08-25"))
        XCTAssertEqual(Bodyweight.dateRefusal("2026-02-30", today: "2026-08-25"), "could not read that date")
    }

    func testTwoDecimalsAtMostAndNoTrailingZeros() {
        XCTAssertEqual(Bodyweight.format(82.4), "82.4")
        XCTAssertEqual(Bodyweight.format(82.45), "82.45")
        XCTAssertEqual(Bodyweight.format(82), "82")
        XCTAssertEqual(Bodyweight.format(82.456), "82.46")
        XCTAssertEqual(Bodyweight.format(100.10), "100.1")
    }

    func testTheFieldTakesCommaOrPointAndRefusesOneThingAtATime() {
        XCTAssertEqual(Bodyweight.read("82,4"), Bodyweight.Reading(value: 82.4, refusal: nil))
        XCTAssertEqual(Bodyweight.read(" 82.4 "), Bodyweight.Reading(value: 82.4, refusal: nil))
        XCTAssertEqual(Bodyweight.read("82"), Bodyweight.Reading(value: 82, refusal: nil))
        XCTAssertEqual(Bodyweight.read("82.456"), Bodyweight.Reading(value: 82.46, refusal: nil))
        XCTAssertEqual(Bodyweight.read(""), Bodyweight.Reading(value: nil, refusal: "That is not a number yet."))
        XCTAssertEqual(Bodyweight.read("eighty"), Bodyweight.Reading(value: nil, refusal: "That is not a number yet."))
        XCTAssertEqual(Bodyweight.read("-82"),
                       Bodyweight.Reading(value: nil, refusal: "Between 20 and 400 kg — check the number."),
                       "a negative number is a number, and it is out of bounds")
        XCTAssertEqual(Bodyweight.read("-0.5"),
                       Bodyweight.Reading(value: nil, refusal: "Between 20 and 400 kg — check the number."))
        XCTAssertEqual(Bodyweight.read("+82"), Bodyweight.Reading(value: 82, refusal: nil))
        XCTAssertEqual(Bodyweight.read("-"), Bodyweight.Reading(value: nil, refusal: "That is not a number yet."))
        XCTAssertEqual(Bodyweight.read("--82"), Bodyweight.Reading(value: nil, refusal: "That is not a number yet."))
        XCTAssertEqual(Bodyweight.read("82.4.1"), Bodyweight.Reading(value: nil, refusal: "One decimal point only."))
        XCTAssertEqual(Bodyweight.read("82,4,1"), Bodyweight.Reading(value: nil, refusal: "One decimal point only."))
        XCTAssertEqual(Bodyweight.read("19.99"),
                       Bodyweight.Reading(value: nil, refusal: "Between 20 and 400 kg — check the number."))
        XCTAssertEqual(Bodyweight.read("400.01"),
                       Bodyweight.Reading(value: nil, refusal: "Between 20 and 400 kg — check the number."))
        XCTAssertEqual(Bodyweight.read("20"), Bodyweight.Reading(value: 20, refusal: nil))
        XCTAssertEqual(Bodyweight.read("400"), Bodyweight.Reading(value: 400, refusal: nil))
        XCTAssertEqual(Bodyweight.hint, "comma or point, both read as a decimal")
    }

    func testTheWordsArePinned() {
        XCTAssertEqual(Bodyweight.title, "Bodyweight")
        XCTAssertEqual(Bodyweight.chip, "Weigh in")
        XCTAssertEqual(Bodyweight.gapRule, "no line is drawn across a gap longer than seven days")
        XCTAssertEqual(Bodyweight.Window.allCases.map(\.rawValue), ["90 days", "All"])
        XCTAssertEqual(Bodyweight.deleteRow, "Delete weigh-in")
        XCTAssertEqual(Bodyweight.deleteTitle, "Delete this weigh-in?")
        XCTAssertEqual(Bodyweight.deleteConfirm, "Delete")
        XCTAssertEqual(Bodyweight.deleteKeep, "Keep it")
        XCTAssertEqual(Bodyweight.drawsKg, "Not on this phone yet — this room still draws kg.")
    }

    func testTheLocalDayIsARealCalendarDateOrNothing() {
        XCTAssertTrue(Bodyweight.isDateLocal("2026-08-25"))
        XCTAssertTrue(Bodyweight.isDateLocal("2024-02-29"))
        XCTAssertFalse(Bodyweight.isDateLocal("2026-02-30"))
        XCTAssertFalse(Bodyweight.isDateLocal("2026-13-01"))
        XCTAssertFalse(Bodyweight.isDateLocal("26-08-25"))
        XCTAssertFalse(Bodyweight.isDateLocal("2026-8-5"))
        XCTAssertFalse(Bodyweight.isDateLocal("tomorrow"))
        XCTAssertEqual(Bodyweight.daysBetween("2026-07-06", "2026-08-05"), 30)
        XCTAssertEqual(Bodyweight.dayMonth("2026-07-07"), "7 Jul")
        XCTAssertEqual(Bodyweight.dayMonthYear("2026-08-25"), "25 Aug 2026")
        let noon = Bodyweight.date(of: "2026-08-25")!
        XCTAssertEqual(Bodyweight.dateLocal(noon), "2026-08-25")
    }

    func testTheWireDecodesTheServersRowAndEncodesTheWrite() throws {
        let wire = #"{"dateLocal":"2026-08-25","weightKg":82.4,"recordedAt":1756100000000}"#
        let row = try JSONDecoder().decode(BodyweightEntry.self, from: Data(wire.utf8))
        XCTAssertEqual(row, BodyweightEntry(dateLocal: "2026-08-25", weightKg: 82.4, recordedAt: 1_756_100_000_000))
        let write = try JSONEncoder().encode(BodyweightWrite(weightKg: 82.4, recordedAt: 7))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: write) as? [String: Any])
        XCTAssertEqual(json["weightKg"] as? Double, 82.4)
        XCTAssertEqual(json["recordedAt"] as? Int64, 7)
    }
}

final class BodyweightChartTests: XCTestCase {
    private func entry(_ day: String, _ kg: Double) -> BodyweightEntry {
        BodyweightEntry(dateLocal: day, weightKg: kg, recordedAt: 1)
    }

    func testADotPerMeasurementJoinedOnlyAcrossSevenDaysOrFewer() {
        let chart = Bodyweight.chart([
            entry("2026-07-01", 83.0),
            entry("2026-07-04", 82.6),
            entry("2026-07-11", 82.9),   // exactly seven days: joined
            entry("2026-07-19", 82.1),   // eight days: not joined
            entry("2026-08-25", 81.8),
        ], window: .all, today: "2026-08-25")

        XCTAssertEqual(chart.points.count, 5)
        XCTAssertEqual(chart.runs.map { $0.map(\.dateLocal) },
                       [["2026-07-01", "2026-07-04", "2026-07-11"], ["2026-07-19"], ["2026-08-25"]])
        XCTAssertEqual(chart.gaps.map(\.label),
                       ["no weigh-in · 11 Jul – 19 Jul", "no weigh-in · 19 Jul – 25 Aug"],
                       "the last dot before the gap and the first after it — the two days web and Android name")
    }

    // B2's client half: a served row dated after this device's today is neither the reading nor a dot, and it
    // is not counted on the chart's label either.
    func testAFutureRowIsNotADotInEitherWindow() {
        let series = [entry("2026-08-20", 83.0), entry("2026-08-25", 82.4), entry("2026-09-30", 82.0)]
        let ninety = Bodyweight.chart(series, window: .ninetyDays, today: "2026-08-25")
        XCTAssertEqual(ninety.points.map(\.dateLocal), ["2026-08-20", "2026-08-25"])
        XCTAssertEqual(ninety.label, "last 90 days · 2 weigh-ins")
        XCTAssertEqual(Bodyweight.chart(series, window: .all, today: "2026-08-25").points.map(\.dateLocal),
                       ["2026-08-20", "2026-08-25"])
        XCTAssertEqual(Bodyweight.latest(series, today: "2026-08-25")?.dateLocal, "2026-08-25")
        XCTAssertEqual(Bodyweight.reading(series, today: "2026-08-25"), "82.4 kg · today")
    }

    // The weigh-in sheet scrolls and opens at a partial detent with the handle shown, from both of its doors, so
    // Save and the delete row are never below the fold at the largest text size.
    func testTheWeighInSheetScrollsAndOpensAtAPartialDetentFromBothDoors() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym")
        let chart = try String(contentsOf: sources.appendingPathComponent("BodyweightScreen.swift"), encoding: .utf8)
        let sheet = try XCTUnwrap(chart.range(of: "struct WeighInSheet: View"))
        let body = try XCTUnwrap(chart.range(of: "var body: some View", range: sheet.upperBound..<chart.endIndex))
        let head = try XCTUnwrap(chart.range(of: "private var head:", range: body.upperBound..<chart.endIndex))
        XCTAssertTrue(chart[body.upperBound..<head.lowerBound].contains("return ScrollView {"), "the form scrolls")
        for file in ["BodyweightScreen.swift", "LogScreen.swift"] {
            let screen = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
            let door = try XCTUnwrap(screen.range(of: "WeighInSheet(existing:"))
            let detents = try XCTUnwrap(screen.range(of: ".presentationDetents(", range: door.upperBound..<screen.endIndex))
            XCTAssertTrue(screen[detents.upperBound...].hasPrefix("[.medium, .large])"), "\(file): medium and large")
            XCTAssertNotNil(screen.range(of: ".presentationDragIndicator(.visible)", range: detents.upperBound..<screen.endIndex),
                            "\(file): the handle is shown")
        }
    }

    func testTheAxisIsTheSeriesOwnRangePlusPaddingAndNeverZero() {
        let chart = Bodyweight.chart([entry("2026-08-20", 82.0), entry("2026-08-25", 84.5)],
                                     window: .all, today: "2026-08-25")
        XCTAssertEqual(chart.low, 82.0 - 0.5, accuracy: 0.001)
        XCTAssertEqual(chart.high, 84.5 + 0.5, accuracy: 0.001)

        let flat = Bodyweight.chart([entry("2026-08-25", 82.0)], window: .all, today: "2026-08-25")
        XCTAssertEqual(flat.low, 81.5, accuracy: 0.001)
        XCTAssertEqual(flat.high, 82.5, accuracy: 0.001)
        XCTAssertEqual(flat.runs, [[entry("2026-08-25", 82.0)]])
        XCTAssertEqual(flat.gaps, [])
    }

    func testTheWindowIsStatedAndNinetyDaysIsTheDefaultReading() {
        let series = [entry("2026-05-01", 84.0), entry("2026-05-27", 83.5), entry("2026-05-28", 83.4),
                      entry("2026-08-25", 82.0)]
        let ninety = Bodyweight.chart(series, window: .ninetyDays, today: "2026-08-25")
        XCTAssertEqual(ninety.points.map(\.dateLocal), ["2026-05-28", "2026-08-25"],
                       "the 90-day window runs from 28 May to today inclusive")
        XCTAssertEqual(ninety.label, "last 90 days · 2 weigh-ins", "B11: the window and what it holds")
        let whole = Bodyweight.chart(series, window: .all, today: "2026-08-25")
        XCTAssertEqual(whole.points.count, 4)
        XCTAssertEqual(whole.label, "the whole series · 4 weigh-ins")
        XCTAssertEqual(Bodyweight.chart([entry("2026-08-25", 82.0)], window: .ninetyDays, today: "2026-08-25").label,
                       "last 90 days · 1 weigh-in")
        XCTAssertEqual(Bodyweight.chart(series.sorted { $0.dateLocal > $1.dateLocal }, window: .all,
                                        today: "2026-08-25").points.map(\.dateLocal),
                       series.map(\.dateLocal), "sorted ascending whatever order it was given")
    }

    func testAnEmptyWindowSaysSoRatherThanDrawingNothing() {
        let old = [entry("2026-01-01", 84.0)]
        XCTAssertEqual(Bodyweight.emptyWindow(Bodyweight.chart(old, window: .ninetyDays, today: "2026-08-25")),
                       "no weigh-in in the last 90 days")
        XCTAssertNil(Bodyweight.emptyWindow(Bodyweight.chart(old, window: .all, today: "2026-08-25")))
        XCTAssertEqual(Bodyweight.emptyWindow(Bodyweight.chart([], window: .all, today: "2026-08-25")),
                       "no weigh-in yet")
    }
}

final class BodyweightStoreTests: XCTestCase {
    private var url: URL!

    override func setUp() async throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-bodyweight-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: url)
    }

    private func entry(_ day: String, _ kg: Double, at recordedAt: Int64) -> BodyweightEntry {
        BodyweightEntry(dateLocal: day, weightKg: kg, recordedAt: recordedAt)
    }

    func testEachSeatHasItsOwnShelfAndTheFileSurvivesARelaunch() {
        let store = BodyweightStore(url: url)
        store.open(under: nil)
        store.keep(entry("2026-08-25", 82.4, at: 1), owed: true)
        store.open(under: "u1")
        store.keep(entry("2026-08-25", 90.0, at: 2), owed: false)
        store.flush()

        let relaunched = BodyweightStore(url: url)
        relaunched.open(under: nil)
        XCTAssertEqual(relaunched.entries, [entry("2026-08-25", 82.4, at: 1)])
        XCTAssertEqual(relaunched.owed.map(\.entry.weightKg), [82.4])
        relaunched.open(under: "u1")
        XCTAssertEqual(relaunched.entries, [entry("2026-08-25", 90.0, at: 2)])
        XCTAssertEqual(relaunched.owed, [])
        relaunched.open(under: "u2")
        XCTAssertEqual(relaunched.entries, [], "a store opened for one seat cannot read another's")
    }

    func testTheAnonymousShelfFollowsWhoeverSignsInAndTheNewerWriteStandsForADay() {
        let store = BodyweightStore(url: url)
        store.open(under: nil)
        store.keep(entry("2026-08-24", 82.0, at: 5), owed: true)
        store.keep(entry("2026-08-25", 82.4, at: 9), owed: true)
        store.open(under: "u1")
        store.keep(entry("2026-08-25", 83.0, at: 3), owed: false)

        store.adoptTheAnonymousShelf()

        XCTAssertEqual(store.entries, [entry("2026-08-24", 82.0, at: 5), entry("2026-08-25", 82.4, at: 9)])
        XCTAssertEqual(store.owed.map(\.entry.dateLocal), ["2026-08-24", "2026-08-25"])
        store.open(under: nil)
        XCTAssertEqual(store.entries, [], "moved, never copied")
    }

    func testAServedSeriesLandsOverTheShelfWithoutDroppingWhatIsStillOwed() {
        let store = BodyweightStore(url: url)
        store.open(under: "u1")
        store.keep(entry("2026-08-20", 83.0, at: 1), owed: false)   // settled, gone from the server since
        store.keep(entry("2026-08-23", 82.7, at: 9), owed: true)    // owed and newer than the server's
        store.keep(entry("2026-08-24", 82.5, at: 2), owed: true)    // owed and older than the server's
        store.keep(entry("2026-08-25", 82.4, at: 4), owed: true)    // owed and unknown to the server
        store.markDeleted(on: "2026-08-20", at: 10)

        store.served([entry("2026-08-21", 83.1, at: 1), entry("2026-08-23", 82.9, at: 3),
                      entry("2026-08-24", 82.6, at: 7)])

        XCTAssertEqual(store.entries, [entry("2026-08-21", 83.1, at: 1), entry("2026-08-23", 82.7, at: 9),
                                       entry("2026-08-24", 82.6, at: 7), entry("2026-08-25", 82.4, at: 4)])
        XCTAssertEqual(store.owed.map(\.entry.dateLocal), ["2026-08-23", "2026-08-25"],
                       "the server's newer row settled the 24th; a deletion the server no longer holds is done")
    }

    func testAnOwedDeletionHidesTheRowAndOutlivesAServedRead() {
        let store = BodyweightStore(url: url)
        store.open(under: "u1")
        store.keep(entry("2026-08-25", 82.4, at: 4), owed: false)
        let tombstone = store.markDeleted(on: "2026-08-25", at: 10)
        XCTAssertEqual(tombstone, entry("2026-08-25", 82.4, at: 10), "the tombstone carries the deletion's instant")
        XCTAssertEqual(store.entries, [])
        XCTAssertEqual(store.owed.map(\.deleted), [true])

        store.served([entry("2026-08-25", 82.4, at: 4)])
        XCTAssertEqual(store.entries, [], "the deletion still owed is not undone by the read")
        XCTAssertEqual(store.owed.map(\.deleted), [true])

        store.letGo(on: "2026-08-25")
        XCTAssertEqual(store.owed, [])
        XCTAssertTrue(store.isEmpty)
        XCTAssertNil(store.markDeleted(on: "2026-08-25", at: 11), "nothing to delete, nothing owed")
    }

    // A correction the log took after the deletion was made outranks it: on a read and on the replay alike.
    func testACorrectionNewerThanTheDeletionWinsOverIt() {
        let store = BodyweightStore(url: url)
        store.open(under: "u1")
        store.keep(entry("2026-08-25", 82.4, at: 4), owed: false)
        let tombstone = store.markDeleted(on: "2026-08-25", at: 10)!

        store.served([entry("2026-08-25", 83.1, at: 12)])
        XCTAssertEqual(store.entries, [entry("2026-08-25", 83.1, at: 12)], "the read draws the newer correction")
        XCTAssertEqual(store.owed, [], "and nothing is owed for the day")

        store.keep(entry("2026-08-24", 82.0, at: 4), owed: false)
        let older = store.markDeleted(on: "2026-08-24", at: 20)!
        XCTAssertFalse(store.withdrawDeletion(older, for: entry("2026-08-24", 82.0, at: 4)),
                       "a row no newer than the deletion does not withdraw it")
        XCTAssertEqual(store.entries.map(\.weightKg), [83.1])
        XCTAssertTrue(store.withdrawDeletion(older, for: entry("2026-08-24", 82.9, at: 30)))
        XCTAssertEqual(store.entries.map(\.weightKg), [82.9, 83.1])
        XCTAssertFalse(store.withdrawDeletion(tombstone, for: entry("2026-08-25", 90, at: 40)),
                       "the day no longer holds that tombstone")
        XCTAssertEqual(store.entries.map(\.weightKg), [82.9, 83.1])
    }
}

@MainActor
final class BodyweightSyncTests: XCTestCase {
    private var stem: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("gym-bw-\(UUID().uuidString)")
        clockMs = 1_000
    }

    override func tearDown() async throws {
        for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
            try? FileManager.default.removeItem(at: stem.appendingPathExtension(ext))
        }
    }

    private func makeStore(sync: FakeTraining?, retryAfter: Duration = .seconds(4)) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                      now: { self.clockMs += 1; return self.clockMs },
                      undoWindowMs: 0,
                      retryAfter: retryAfter,
                      sync: { $0.isSignedIn ? sync : nil })
    }

    private func account(signedIn: Bool) -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: signedIn ? User(id: "u1", email: "u1@example.com", name: "u1") : nil)
    }

    private func shelf(of seat: String?) -> BodyweightStore {
        let held = BodyweightStore(url: stem.appendingPathExtension("bodyweight.json"))
        held.open(under: seat)
        return held
    }

    func testSignedOutAWeighInLandsOnThisDeviceAndTheReadingComesFromIt() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        let refused = await store.weighIn(82.4, on: "2026-08-25")

        XCTAssertNil(refused)
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.4])
        XCTAssertEqual(shelf(of: nil).owed.map(\.entry.dateLocal), ["2026-08-25"])
        XCTAssertEqual(Bodyweight.reading(store.bodyweight, today: "2026-08-25"), "82.4 kg · today")

        _ = await store.weighIn(82.9, on: "2026-08-25")
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.9], "a second save for a day is a correction")

        _ = await store.deleteWeighIn(on: "2026-08-25")
        XCTAssertEqual(store.bodyweight, [])
        XCTAssertTrue(shelf(of: nil).isEmpty, "signed out, a deletion has nobody to tell")
    }

    func testAMalformedDayIsRefusedBeforeItTouchesTheShelf() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        let refused = await store.weighIn(82.4, on: "2026-02-30")

        XCTAssertEqual(refused, .refused("could not read that date"))
        XCTAssertEqual(store.bodyweight, [])
    }

    func testSignedInAWeighInIsToldToTheLogAtOnceAndTheReplyIsWhatIsDrawn() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        let refused = await store.weighIn(82.456, on: "2026-08-25")

        XCTAssertNil(refused)
        XCTAssertEqual(server.bodyweightWrites, ["2026-08-25"])
        XCTAssertEqual(store.bodyweight, [BodyweightEntry(dateLocal: "2026-08-25", weightKg: 82.46,
                                                          recordedAt: store.bodyweight[0].recordedAt)])
        XCTAssertEqual(shelf(of: "u1").owed, [], "answered for, so nothing is owed")

        let deleted = await store.deleteWeighIn(on: "2026-08-25")
        XCTAssertNil(deleted)
        XCTAssertEqual(server.weighIns, [:])
        XCTAssertEqual(store.bodyweight, [])
    }

    func testARefusedWeighInIsSaidAndLetGoRatherThanReplayedForever() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        let refused = await store.weighIn(500, on: "2026-08-25")

        XCTAssertEqual(refused, .refused("Between 20 and 400 kg — check the number."))
        XCTAssertEqual(store.bodyweight, [])
        XCTAssertTrue(shelf(of: "u1").isEmpty)
    }

    func testOfflineTheWeighInStaysOwedAndTheClaimReplaysItLastAfterEverySession() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success = await anonymous.start() else { return XCTFail("no session") }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed = await anonymous.finish() else { return XCTFail("no close") }
        _ = await anonymous.weighIn(82.4, on: "2026-08-24")
        _ = await anonymous.weighIn(82.1, on: "2026-08-25")

        let server = FakeTraining()
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        let walk = server.calls.filter { ["savePreferences", "start", "finish", "putBodyweight", "bodyweight"].contains($0) }
        XCTAssertEqual(walk, ["start", "finish", "putBodyweight", "putBodyweight", "bodyweight"],
                       "bodyweight is the last slot of the claim, after every session landed, before the read")
        XCTAssertEqual(server.bodyweightWrites, ["2026-08-24", "2026-08-25"], "ascending by day")
        XCTAssertEqual(server.weighIns.keys.sorted(), ["2026-08-24", "2026-08-25"])
        XCTAssertEqual(claimed.bodyweight.map(\.weightKg), [82.4, 82.1])
        XCTAssertEqual(shelf(of: "u1").owed, [])
        XCTAssertTrue(shelf(of: nil).isEmpty, "the anonymous shelf followed the person who signed in")
    }

    func testTheClaimReplaysSettingsFirstAndAStaleReplayNeverOverwritesANewerCorrection() async {
        let server = FakeTraining()
        server.weighIns["2026-08-25"] = BodyweightEntry(dateLocal: "2026-08-25", weightKg: 83.3, recordedAt: 9_999)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        server.online = false
        _ = await store.save(GymPreferences.defaults.with(units: .lb))
        let refused = await store.weighIn(82.4, on: "2026-08-25")
        XCTAssertEqual(refused, .noAnswer)
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.4], "this device draws its own write while it is owed")
        server.online = true

        await store.connect(to: account(signedIn: true))

        let walk = server.calls.filter { ["savePreferences", "putBodyweight"].contains($0) }
        XCTAssertEqual(walk.suffix(2), ["savePreferences", "putBodyweight"], "settings first, bodyweight last")
        XCTAssertEqual(store.bodyweight, [BodyweightEntry(dateLocal: "2026-08-25", weightKg: 83.3, recordedAt: 9_999)],
                       "the log's newer correction stands and this device redraws it")
        XCTAssertEqual(shelf(of: "u1").owed, [])
    }

    func testAnOwedDeletionIsReplayedByTheClaimAndTheReadDoesNotResurrectIt() async {
        let server = FakeTraining()
        server.weighIns["2026-08-25"] = BodyweightEntry(dateLocal: "2026-08-25", weightKg: 83.3, recordedAt: 1)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [83.3])
        server.online = false

        let deleted = await store.deleteWeighIn(on: "2026-08-25")
        XCTAssertEqual(deleted, .noAnswer)
        XCTAssertEqual(store.bodyweight, [], "hidden here until the log hears it")
        XCTAssertEqual(shelf(of: "u1").owed.map(\.deleted), [true])
        server.online = true
        let before = server.calls.count

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.weighIns, [:])
        XCTAssertEqual(store.bodyweight, [])
        XCTAssertTrue(shelf(of: "u1").isEmpty)
        XCTAssertEqual(server.calls.dropFirst(before).filter { $0 == "bodyweightOn" || $0 == "deleteBodyweight" },
                       ["bodyweightOn", "deleteBodyweight"], "the day is read before it is deleted")
    }

    // A deletion made offline carries the instant it was made; a correction another surface landed after that
    // instant is newer, so the replay drops the deletion and draws the log's row instead of removing it.
    func testAReplayedDeletionYieldsToACorrectionMadeAfterIt() async {
        let server = FakeTraining()
        server.weighIns["2026-08-25"] = BodyweightEntry(dateLocal: "2026-08-25", weightKg: 83.3, recordedAt: 1)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        server.online = false
        _ = await store.deleteWeighIn(on: "2026-08-25")
        XCTAssertEqual(store.bodyweight, [])
        let deletedAt = shelf(of: "u1").owed[0].entry.recordedAt
        XCTAssertGreaterThan(deletedAt, 1, "the tombstone is stamped with the deletion's instant, not the row's")
        server.weighIns["2026-08-25"] = BodyweightEntry(dateLocal: "2026-08-25", weightKg: 82.9,
                                                        recordedAt: deletedAt + 5_000)
        server.online = true
        let before = server.calls.count

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.weighIns["2026-08-25"]?.weightKg, 82.9, "the log's correction stands")
        XCTAssertEqual(server.calls.dropFirst(before).filter { $0 == "bodyweightOn" || $0 == "deleteBodyweight" },
                       ["bodyweightOn"], "the day was read, and the deletion was never sent")
        XCTAssertEqual(store.bodyweight, [BodyweightEntry(dateLocal: "2026-08-25", weightKg: 82.9,
                                                          recordedAt: deletedAt + 5_000)])
        XCTAssertEqual(shelf(of: "u1").owed, [])
    }

    func testTheServedSeriesIsDrawnSignedInAndTheDeviceCopyIsKeptWhenTheReadFails() async {
        let server = FakeTraining()
        server.weighIns["2026-08-20"] = BodyweightEntry(dateLocal: "2026-08-20", weightKg: 83.0, recordedAt: 1)
        server.weighIns["2026-08-25"] = BodyweightEntry(dateLocal: "2026-08-25", weightKg: 82.4, recordedAt: 2)
        let store = makeStore(sync: server)

        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.bodyweight.map(\.dateLocal), ["2026-08-20", "2026-08-25"])

        server.refuseBodyweight = .refused(503, Refusal(Data()))
        let again = makeStore(sync: server)
        await again.connect(to: account(signedIn: true))
        XCTAssertEqual(again.bodyweight.map(\.dateLocal), ["2026-08-20", "2026-08-25"],
                       "the per-seat file answers when the log does not")
    }
}
