import XCTest
@testable import WindmillGym

// WHAT A MOVEMENT'S RECORD IS ALLOWED TO DRAW, and what it must refuse to invent. Two halves: the
// wire shape exactly as the server writes it — every optional OMITTED and never null, every empty
// list left out entirely — and the rules that turn it into §H's page on a phone with no scrub and no
// hover.
//
// The line under all of it: where Epley is undefined there is no e1RM anything. Not a zero, not a
// dash in a chart frame, not an empty axis — no tile and no chart at all.
//
// A DATE IN AN EXPECTED STRING IS SPELLED BY `Readout` ITSELF and the instants are built through the
// calendar, so these assertions pin the SENTENCE and the rule rather than the simulator's zone.

final class RecordTests: XCTestCase {
    private func at(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Int64 {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = hour
        let moment = Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
        return Int64(moment.timeIntervalSince1970 * 1000)
    }

    private let squat = Exercise(id: "back-squat", name: "Back Squat", pattern: "squat",
                                 equipment: "barbell", stepKg: 2.5)

    private func decoded(_ json: String) throws -> MovementRecord {
        try JSONDecoder().decode(MovementRecord.self, from: Data(json.utf8))
    }

    // The reply as the server writes it, with the absences that mean something and the id that
    // never moves. `at` is the SESSION's start on every mark, which is why the chart's bars and the
    // record rows line up on the same instant.
    func testTheWireShapeDecodesWithEveryAbsenceIntact() throws {
        let record = try decoded("""
        {"exercise":{"id":"back-squat","name":"Back Squat","pattern":"squat",
                     "equipment":"barbell","stepKg":2.5,"custom":false},
         "routineCount":2,"sessionCount":34,
         "bestE1rm":{"weightKg":105,"reps":5,"at":1754870400000,"e1rm":122.5},
         "heaviest":{"weightKg":105,"reps":5,"at":1754870400000,"e1rm":122.5},
         "e1rmSeries":[{"at":1753660800000,"weightKg":102.5,"reps":5,"e1rm":119.6},
                       {"at":1754870400000,"weightKg":105,"reps":5,"e1rm":122.5}],
         "records":[{"at":1754870400000,"weightKg":105,"reps":5,"e1rm":122.5}],
         "recentDays":[{"sessionId":"ses_1","startedAt":1754870400000,
                        "sets":[{"id":"set_1","exerciseId":"back-squat","setNumber":1,"weightKg":105,
                                 "reps":5,"kind":"working","note":"","completedAt":1754870700000}]}]}
        """)

        XCTAssertEqual(record.exercise, squat)
        XCTAssertEqual(record.routineCount, 2)
        XCTAssertEqual(record.sessionCount, 34)
        XCTAssertEqual(record.bestE1rm,
                       MovementMark(weightKg: 105, reps: 5, atMs: 1_754_870_400_000, e1rm: 122.5))
        XCTAssertEqual(record.heaviest,
                       MovementMark(weightKg: 105, reps: 5, atMs: 1_754_870_400_000, e1rm: 122.5))
        XCTAssertEqual(record.e1rmSeries.map(\.e1rm), [119.6, 122.5])
        XCTAssertEqual(record.records.map(\.atMs), [1_754_870_400_000])
        XCTAssertEqual(record.recentDays.map(\.sessionId), ["ses_1"])
        XCTAssertEqual(record.recentDays.first?.sets.map(\.reps), [5])
    }

    // A movement in the catalog nobody has ever lifted: two zeros and nothing else. It is a real and
    // common case rather than a failed read, so the page says so plainly — no tiles, no chart, no
    // empty frame with a name over it.
    func testAMovementNobodyHasLiftedIsTwoZerosAndAPlainSentence() throws {
        let record = try decoded("""
        {"exercise":{"id":"back-squat","name":"Back Squat","pattern":"squat",
                     "equipment":"barbell","stepKg":2.5,"custom":false},
         "routineCount":0,"sessionCount":0}
        """)

        XCTAssertEqual(record.bestE1rm, nil)
        XCTAssertEqual(record.heaviest, nil)
        XCTAssertEqual(record.e1rmSeries, [])
        XCTAssertEqual(record.records, [])
        XCTAssertEqual(record.recentDays, [])

        let page = Record.page(record, now: at(2026, 8, 10))
        XCTAssertTrue(page.neverLogged)
        XCTAssertEqual(page.subhead, "barbell · in no routine · never logged")
        XCTAssertNil(page.best)
        XCTAssertNil(page.heaviest)
        XCTAssertNil(page.chart)
    }

    // §H's own head, to the character.
    func testTheSubheadNamesTheEquipmentTheRoutinesAndTheSessions() {
        let page = Record.page(MovementRecord(exercise: squat, routineCount: 2, sessionCount: 34),
                               now: at(2026, 8, 10))
        XCTAssertEqual(page.name, "Back Squat")
        XCTAssertEqual(page.subhead, "barbell · in 2 routines · 34 sessions")

        let one = Record.page(MovementRecord(exercise: squat, routineCount: 1, sessionCount: 1),
                              now: at(2026, 8, 10))
        XCTAssertEqual(one.subhead, "barbell · in 1 routine · 1 session")

        let unclassified = Record.page(
            MovementRecord(exercise: Exercise(id: "x", name: "Farmer carry"), sessionCount: 3),
            now: at(2026, 8, 10))
        XCTAssertEqual(unclassified.subhead, "in no routine · 3 sessions",
                       "an equipment the catalog does not carry is omitted, never blanked")
    }

    // The two tiles, and the second one is §H's own copy: the load, then `kg · for 5`.
    func testTheTilesCarryTheValueAndTheSetThatMadeIt() {
        let today = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: squat, routineCount: 2, sessionCount: 34,
                           bestE1rm: MovementMark(weightKg: 105, reps: 5, atMs: today, e1rm: 122.5),
                           heaviest: MovementMark(weightKg: 105, reps: 5, atMs: today, e1rm: 122.5)),
            now: today)

        XCTAssertEqual(page.best, Record.Tile(caption: "best e1RM", value: "122.5",
                                              under: "today · 105 × 5"))
        XCTAssertEqual(page.heaviest, Record.Tile(caption: "heaviest", value: "105",
                                                  under: "kg · for 5"))
    }

    // EPLEY IS UNDEFINED AT OR BELOW ZERO LOAD. A chin-up at 0 kg and a band-assisted pull-up at −20
    // have no honest one-rep estimate, so the server omits all three e1RM halves — and the page
    // draws the heaviest tile and the sets and NOTHING where the estimate would go.
    func testABodyweightMovementHasNoBestTileAndNoChart() {
        let today = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: Exercise(id: "chin-up", name: "Chin-up", equipment: "bodyweight"),
                           sessionCount: 6,
                           heaviest: MovementMark(weightKg: 0, reps: 12, atMs: today),
                           recentDays: [TrainingDay(sessionId: "ses_1", startedAtMs: today,
                                                    sets: [set(0, 12, at: today)])]),
            now: today)

        XCTAssertNil(page.best, "no estimate is no tile — never a zero and never a dash")
        XCTAssertNil(page.chart, "and no chart frame over a series that does not exist")
        XCTAssertEqual(page.heaviest, Record.Tile(caption: "heaviest", value: "0",
                                                  under: "kg · for 12"))
        XCTAssertEqual(page.days.map(\.sets), ["12 reps"],
                       "one spelling of a set on one page: a zero load is the absence of a load")
        XCTAssertEqual(page.noChart, .unloaded, "and the sentence blames the bar, which is the truth")
        XCTAssertFalse(page.neverLogged, "it has been lifted; it just has no estimate")
    }

    // A MOVEMENT WORKED ONLY IN DROP SETS is in the days and in no count — the two lists count
    // different things on purpose (domain/Record.h), because every number in this product is over
    // working sets and a list of what you did that dropped a drop set would not be one.
    //
    // So the page may not say `never logged` over the sets it is printing, may not draw a tile lane
    // with nothing in it, and may not blame the BAR for an estimate it does not have: a 40 kg drop
    // set has a load above zero, and "this movement has none" two lines above `40 × 12` is the page
    // contradicting itself.
    func testAMovementWorkedOnlyInDropSetsIsNeverCalledNeverLogged() {
        let today = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: Exercise(id: "good-morning", name: "Good Morning",
                                              equipment: "barbell"),
                           routineCount: 2, sessionCount: 0,
                           recentDays: [TrainingDay(sessionId: "ses_1", startedAtMs: today,
                                                    sets: [set(40, 12, at: today, kind: .drop)])]),
            now: today)

        XCTAssertFalse(page.neverLogged, "there are sets on this page — it is not an empty movement")
        XCTAssertEqual(page.subhead, "barbell · in 2 routines · no working sets")
        XCTAssertNil(page.best)
        XCTAssertNil(page.heaviest, "no working set is no standing best, and no empty tile either")
        XCTAssertEqual(page.noChart, .neverWorked)
        XCTAssertEqual(page.days.map(\.sets), ["40 × 12 drop"],
                       "and the kind rides with the set, so a back-off never reads as work")
    }

    // A STANDING BEST WITH NOTHING INSIDE THE WINDOW is a fact about twelve weeks and not about the
    // lift: the bests are lifetime and only the chart is windowed (the server cuts the series with
    // `kRecordWindowMs`), so a movement nobody has trained since spring keeps its tile and loses its
    // chart. Saying "no e1RM" under a tile printing one would be the page contradicting itself.
    func testAStandingBestWithNothingRecentBlamesTheWindowAndNotTheLift() {
        let spring = at(2026, 3, 2)
        let page = Record.page(
            MovementRecord(exercise: squat, sessionCount: 12,
                           bestE1rm: MovementMark(weightKg: 105, reps: 5, atMs: spring, e1rm: 122.5),
                           heaviest: MovementMark(weightKg: 105, reps: 5, atMs: spring, e1rm: 122.5)),
            now: at(2026, 8, 10))

        XCTAssertNil(page.chart, "nothing in the window is no chart, never an empty frame")
        XCTAssertEqual(page.noChart, .outsideWindow)
        XCTAssertEqual(page.best, Record.Tile(caption: "best e1RM", value: "122.5",
                                              under: "2 Mar · 105 × 5"))
    }

    // ONE BAR PER SESSION, oldest first, and each end of the axis carries its DATE AND ITS VALUE —
    // this surface has no hover, and the chart's baseline is not zero, so a bar whose scale is
    // nowhere on screen would mean nothing at all.
    func testTheChartIsOneBarPerSessionWithBothEndsNamed() {
        let opened = at(2026, 5, 19)
        let closed = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: squat, sessionCount: 2,
                           bestE1rm: MovementMark(weightKg: 105, reps: 5, atMs: closed, e1rm: 122.5),
                           e1rmSeries: [MovementMark(weightKg: 90, reps: 5, atMs: opened, e1rm: 105),
                                        MovementMark(weightKg: 105, reps: 5, atMs: closed, e1rm: 122.5)]),
            now: closed)

        guard let chart = page.chart else { return XCTFail("two points are a chart") }
        XCTAssertEqual(chart.bars.map(\.atMs), [opened, closed])
        XCTAssertEqual(chart.window, "12 weeks")
        XCTAssertEqual(chart.opened, "19 May · 105")
        XCTAssertEqual(chart.closed, "10 Aug · 122.5")
    }

    // The floor is a third of the window's own span below its lowest session: the quietest week
    // still draws a quarter of a bar, and the peak fills the frame. Measuring an e1RM series from
    // ZERO is what makes a whole training block one flat wall.
    func testBarsAreMeasuredFromAFloorBelowTheLowestSessionRatherThanFromZero() {
        let chart = charted([(at(2026, 6, 1), 100), (at(2026, 7, 1), 105), (at(2026, 8, 1), 110)])
        XCTAssertEqual(chart.bars.count, 3)
        for (drawn, expected) in zip(chart.bars.map(\.height), [0.25, 0.625, 1.0]) {
            XCTAssertEqual(drawn, expected, accuracy: 1e-9)
        }
    }

    // A movement that has never moved is drawn down the middle rather than pinned to an edge by a
    // divide-by-nothing — and one session is one bar, because a chart of a single point is honest.
    func testAFlatSeriesAndASinglePointAreBothDrawnHonestly() {
        let flat = charted([(at(2026, 7, 1), 100), (at(2026, 8, 1), 100)])
        XCTAssertEqual(flat.bars.map(\.height), [0.5, 0.5])

        let alone = charted([(at(2026, 8, 1), 100)])
        XCTAssertEqual(alone.bars.map(\.height), [0.5])
        XCTAssertEqual(alone.opened, alone.closed, "one session opens and closes the window")
    }

    // THREE TINTS AND EACH ONE IS A FACT: the session holding the standing best is gold, a session
    // that passed every session before it is lit, and the rest are the room's own stone. The marks
    // come off the RECORD LADDER the server sent — nothing here re-derives what a record was.
    func testABarIsMarkedByWhetherItPassedEverySessionBeforeIt() {
        let may = at(2026, 5, 19)
        let july = at(2026, 7, 13)
        let august = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: squat, sessionCount: 3,
                           bestE1rm: MovementMark(weightKg: 105, reps: 5, atMs: august, e1rm: 122.5),
                           e1rmSeries: [MovementMark(weightKg: 95, reps: 5, atMs: may, e1rm: 110.8),
                                        MovementMark(weightKg: 100, reps: 5, atMs: july, e1rm: 116.7),
                                        MovementMark(weightKg: 105, reps: 5, atMs: august, e1rm: 122.5)],
                           records: [MovementMark(weightKg: 105, reps: 5, atMs: august, e1rm: 122.5),
                                     MovementMark(weightKg: 100, reps: 5, atMs: july, e1rm: 116.7)]),
            now: august)

        XCTAssertEqual(page.chart?.bars.map(\.mark), [.ordinary, .passed, .best])
    }

    // TWO SESSIONS CAN SHARE A START INSTANT and the page has to survive it: `start_session` takes a
    // client-supplied instant, so an agent filing two workouts on one moment is an ordinary use of
    // this product's own thesis. A bar and a record row are therefore identified by their PLACE, not
    // by the instant — two rows sharing an id in a `ForEach` is undefined behaviour.
    func testBarsAndRecordRowsAreIdentifiedByPlaceSoASharedInstantCannotCollide() {
        let same = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: squat, sessionCount: 2,
                           bestE1rm: MovementMark(weightKg: 105, reps: 5, atMs: same, e1rm: 122.5),
                           e1rmSeries: [MovementMark(weightKg: 100, reps: 5, atMs: same, e1rm: 116.7),
                                        MovementMark(weightKg: 105, reps: 5, atMs: same, e1rm: 122.5)],
                           records: [MovementMark(weightKg: 105, reps: 5, atMs: same, e1rm: 122.5),
                                     MovementMark(weightKg: 100, reps: 5, atMs: same, e1rm: 116.7)]),
            now: same)

        XCTAssertEqual(page.chart?.bars.map(\.id), [0, 1])
        XCTAssertEqual(page.chart?.bars.map(\.atMs), [same, same], "and each keeps its own instant")
        XCTAssertEqual(page.records.map(\.id), [0, 1])
    }

    // Newest first, lifetime, and the first row IS the standing best. A mark with no estimate prints
    // its effort and its day and no e1RM clause — the absence is never filled in.
    func testThePersonalRecordsReadNewestFirstWithTheirEstimates() {
        let today = at(2026, 8, 10)
        let july = at(2026, 7, 27)
        let page = Record.page(
            MovementRecord(exercise: squat, sessionCount: 9,
                           records: [MovementMark(weightKg: 105, reps: 5, atMs: today, e1rm: 122.5),
                                     MovementMark(weightKg: 102.5, reps: 5, atMs: july, e1rm: 119.6)]),
            now: today)

        XCTAssertEqual(page.records.map(\.effort), ["105 × 5", "102.5 × 5"])
        XCTAssertEqual(page.records.map(\.estimate), ["e1RM 122.5", "e1RM 119.6"])
        XCTAssertEqual(page.records.map(\.when), ["today", "27 Jul"])
    }

    // Grouped by the day they were lived in, newest first, and a day with nothing in it is dropped
    // rather than drawn as an empty row under a date.
    func testTheRecentDaysReadAsTheirSetsInPerformedOrder() {
        let today = at(2026, 8, 10)
        let before = at(2026, 8, 3)
        let page = Record.page(
            MovementRecord(exercise: squat, sessionCount: 2,
                           recentDays: [
                               TrainingDay(sessionId: "ses_2", startedAtMs: today,
                                           sets: [set(105, 5, at: today), set(105, 5, at: today + 1),
                                                  set(105, 4, at: today + 2)]),
                               TrainingDay(sessionId: "ses_1", startedAtMs: before,
                                           sets: [set(102.5, 5, at: before)]),
                               TrainingDay(sessionId: "ses_0", startedAtMs: before - 1, sets: []),
                           ]),
            now: today)

        XCTAssertEqual(page.days.map(\.id), ["ses_2", "ses_1"])
        XCTAssertEqual(page.days.map(\.when), ["today", "3 Aug"])
        XCTAssertEqual(page.days.map(\.sets), ["105 × 5 · 105 × 5 · 105 × 4", "102.5 × 5"])
    }

    // A zero load is not a load but the ABSENCE of one, so a chin-up's mark reads as its reps —
    // `Readout.target`'s own rule about a target of zero, and one spelling of a set on one page.
    func testAMarkAtNoLoadReadsAsItsReps() {
        let today = at(2026, 8, 10)
        let page = Record.page(
            MovementRecord(exercise: Exercise(id: "chin-up", name: "Chin-up"), sessionCount: 4,
                           records: [MovementMark(weightKg: 0, reps: 12, atMs: today)]),
            now: today)

        XCTAssertEqual(page.records.map(\.effort), ["12 reps"])
        XCTAssertEqual(page.records.map(\.estimate), [nil])
    }

    private func charted(_ points: [(Int64, Double)]) -> Record.Chart {
        let series = points.map { MovementMark(weightKg: 100, reps: 5, atMs: $0.0, e1rm: $0.1) }
        let page = Record.page(MovementRecord(exercise: squat, sessionCount: series.count,
                                              e1rmSeries: series),
                               now: points[points.count - 1].0)
        return page.chart ?? Record.Chart(bars: [], window: "", opened: "", closed: "")
    }

    private func set(_ weightKg: Double, _ reps: Int, at completedAtMs: Int64,
                     kind: SetKind = .working) -> TrainingSet {
        TrainingSet(id: "set_\(completedAtMs)", exerciseId: "back-squat", weightKg: weightKg,
                    reps: reps, kind: kind, completedAtMs: completedAtMs)
    }
}
