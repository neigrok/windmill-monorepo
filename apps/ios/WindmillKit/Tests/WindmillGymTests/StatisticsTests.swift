import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// What the statistics screen is allowed to draw, and what it must refuse to invent. Two halves: the
// wire shape exactly as `adapters/json/TrainingJson` writes it — every optional OMITTED and never
// null — and the one rule that turns it into marks on a phone with no scrub and no hover.
//
// A DATE IN AN EXPECTED STRING IS SPELLED BY `Readout` ITSELF wherever the product spells it in the
// reader's own zone, so these assertions pin the SENTENCE and not the simulator's calendar. The one
// exception is the weeks span: those instants are UTC Monday buckets and are rendered in UTC on
// purpose, so their days are the same everywhere and are written out.

final class StatisticsTests: XCTestCase {
    private func decoded(_ json: String) throws -> TrainingStatistics {
        try JSONDecoder().decode(TrainingStatistics.self, from: Data(json.utf8))
    }

    private let catalog = [Exercise(id: "bench-press", name: "Bench press"),
                           Exercise(id: "chin-up", name: "Chin-up")]

    // The reply as the server writes it, with the absences that mean something: a point with no
    // `e1rm` is a load Epley is undefined at, and a movement with no `bestE1rm` has never had one.
    func testTheWireShapeDecodesWithEveryAbsenceIntact() throws {
        let statistics = try decoded("""
        {"weeks":[{"startedAt":1754006400000,"sessions":3,"workingSets":34}],
         "movements":[
           {"exerciseId":"bench-press","lastTrainedAt":1754400000000,
            "points":[{"at":1754006400000,"weightKg":82.5,"reps":5,"e1rm":96.3}],
            "bestE1rm":{"weightKg":82.5,"reps":5,"at":1754006400000,"e1rm":96.3},
            "heaviest":{"weightKg":90,"reps":3,"at":1754400000000,"e1rm":99}},
           {"exerciseId":"chin-up","lastTrainedAt":1754400000000,
            "points":[{"at":1754400000000,"weightKg":0,"reps":12}]}]}
        """)

        XCTAssertEqual(statistics.weeks,
                       [TrainingWeek(startedAtMs: 1_754_006_400_000, sessions: 3, workingSets: 34)])
        XCTAssertEqual(statistics.movements.count, 2)
        XCTAssertEqual(statistics.movements[0],
                       MovementProgress(exerciseId: "bench-press",
                                        lastTrainedAtMs: 1_754_400_000_000,
                                        points: [MovementPoint(atMs: 1_754_006_400_000,
                                                               weightKg: 82.5, reps: 5, e1rm: 96.3)],
                                        bestE1rm: MovementBest(weightKg: 82.5, reps: 5,
                                                               atMs: 1_754_006_400_000, e1rm: 96.3),
                                        heaviest: MovementBest(weightKg: 90, reps: 3,
                                                               atMs: 1_754_400_000_000, e1rm: 99)))
        XCTAssertEqual(statistics.movements[1],
                       MovementProgress(exerciseId: "chin-up",
                                        lastTrainedAtMs: 1_754_400_000_000,
                                        points: [MovementPoint(atMs: 1_754_400_000_000,
                                                               weightKg: 0, reps: 12)]))
    }

    // An account with nothing finished answers with the two empty lists, and that is a fact rather
    // than a fault — the board says so instead of drawing an axis over nothing.
    func testAnEmptyLogIsAnEmptyBoardAndNotAFailure() throws {
        let statistics = try decoded(#"{"weeks":[],"movements":[]}"#)
        let board = Stats.board(statistics, catalog: catalog, now: 1_754_400_000_000)

        XCTAssertNil(board.weeks)
        XCTAssertEqual(board.lines, [])
        XCTAssertTrue(board.isEmpty)
    }

    // Each row is measured against ITS OWN peak. Sessions and working sets count different things,
    // and one axis across both is the chart that made Lift's progress tab unreadable — three
    // sessions beside thirty-four sets would flatten the smaller row into the baseline.
    func testEachWeeklySeriesIsNormalisedToItsOwnPeak() {
        let weeks = Stats.weeks([TrainingWeek(startedAtMs: 1_753_660_800_000, sessions: 1, workingSets: 10),
                                 TrainingWeek(startedAtMs: 1_754_265_600_000, sessions: 4, workingSets: 40),
                                 TrainingWeek(startedAtMs: 1_754_870_400_000, sessions: 2, workingSets: 20)],
                                showing: 12)

        XCTAssertEqual(weeks?.sets.label, "Working sets")
        XCTAssertEqual(weeks?.sets.peak, "peak 40")
        XCTAssertEqual(weeks?.sets.heights, [0.25, 1, 0.5])
        XCTAssertEqual(weeks?.sessions.label, "Sessions")
        XCTAssertEqual(weeks?.sessions.peak, "peak 4")
        XCTAssertEqual(weeks?.sessions.heights, [0.25, 1, 0.5])
    }

    // The window is taken off the END — the recent weeks are the ones a lifter is asking about — and
    // the span prints the two dates it landed on rather than claiming a period. Weeks are UTC Monday
    // buckets, so the label is rendered in UTC: in a negative-offset zone the local rendering would
    // name Sunday, which is a week label that is simply wrong.
    func testTheWindowTakesTheMostRecentWeeksAndTheSpanNamesItsOwnEnds() {
        // Twenty weeks from Mon 6 Jan 2025 UTC. The window keeps the last twelve, which start at
        // week 8 (Mon 3 Mar) and end at week 19 (Mon 19 May).
        let series = (0..<20).map {
            TrainingWeek(startedAtMs: 1_736_121_600_000 + Int64($0) * 604_800_000,
                         sessions: 1, workingSets: 10)
        }
        let weeks = Stats.weeks(series, showing: 12)

        XCTAssertEqual(weeks?.sets.heights.count, 12)
        XCTAssertEqual(weeks?.span, "12 weeks · Mon 3 Mar → Mon 19 May")
    }

    func testOneWeekSaysOneWeekAndNamesOnlyTheDayItHas() {
        let weeks = Stats.weeks([TrainingWeek(startedAtMs: 1_754_265_600_000, sessions: 2, workingSets: 0)],
                                showing: 12)

        XCTAssertEqual(weeks?.span, "1 week · Mon 4 Aug")
        XCTAssertEqual(weeks?.sets.peak, "peak 0", "a week of warmups is a real zero, not a missing bar")
        XCTAssertEqual(weeks?.sets.heights, [0], "nothing divides by a peak of nothing")
    }

    // A movement every one of whose sets carries an estimate draws the estimate. The line is
    // normalised to its OWN min and max, because a progression from 82.5 to 96.3 against a zero
    // baseline is a flat line and the shape is the whole content of a sparkline.
    func testALoadedMovementDrawsItsE1rmLineNormalisedToItsOwnRange() {
        let line = Stats.line(
            MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: 80, reps: 5, e1rm: 90),
                                      MovementPoint(atMs: 2, weightKg: 82.5, reps: 5, e1rm: 95),
                                      MovementPoint(atMs: 3, weightKg: 85, reps: 5, e1rm: 100)]),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.movement, "Bench press")
        XCTAssertEqual(line?.unit, "e1RM")
        XCTAssertEqual(line?.value, "100", "the newest point is the number a lifter is looking for")
        XCTAssertEqual(line?.heights, [0, 0.5, 1])
        XCTAssertEqual(line?.span, "3 sessions · 90 → 100")
        XCTAssertEqual(line?.lastTrained, "trained today")
    }

    // One set Epley cannot speak for — a chin-up at zero, a band-assisted pull-up below it — and the
    // whole line switches to LOADS. That is not a fallback, it is the true story for the lifter who
    // went from assisted to bodyweight to weighted, and an estimate line with a hole in it is not.
    func testAMovementWithAnyUnestimatedSetDrawsItsLoadLineInstead() {
        let line = Stats.line(
            MovementProgress(exerciseId: "chin-up", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: -20, reps: 8),
                                      MovementPoint(atMs: 2, weightKg: 0, reps: 8),
                                      MovementPoint(atMs: 3, weightKg: 5, reps: 8, e1rm: 6.3)]),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.unit, "load")
        XCTAssertEqual(line?.value, "5")
        XCTAssertEqual(line?.heights, [0, 0.8, 1])
        XCTAssertEqual(line?.span, "3 sessions · \u{2212}20 → 5",
                       "a negative load is a point on the number line and prints as one")
    }

    // THE THIRD AXIS, and it is the one a chin-up needs. Epley has no answer at zero so the estimate
    // is gone, and the load never moves so the load is not the story either — the reps are. The phone
    // had two branches where stats.js `axisOf` has three, so a lifter who went 8 → 12 read "0 → 0"
    // here off the same stored bytes the desk read 8 → 12 off.
    func testABodyweightMovementDrawsItsRepsWhenTheLoadNeverMoves() {
        let line = Stats.line(
            MovementProgress(exerciseId: "chin-up", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: 0, reps: 8),
                                      MovementPoint(atMs: 2, weightKg: 0, reps: 10),
                                      MovementPoint(atMs: 3, weightKg: 0, reps: 12)]),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.unit, "reps")
        XCTAssertEqual(line?.value, "12")
        XCTAssertEqual(line?.heights, [0, 0.5, 1])
        XCTAssertEqual(line?.span, "3 sessions · 8 → 12")
    }

    // The ORDER of the three tests is the rule: an estimate on every point wins over a load that
    // moves, and a load that moves wins over the reps. A lifter coming off the band is drawn on the
    // LOAD even though the reps moved too, because that crossing is the story.
    func testTheAxisIsChosenInTheOrderTheWebChoosesIt() {
        XCTAssertEqual(Stats.Axis(of: [MovementPoint(atMs: 1, weightKg: 100, reps: 5, e1rm: 116.7),
                                       MovementPoint(atMs: 2, weightKg: 105, reps: 5, e1rm: 122.5)]),
                       .e1rm)
        XCTAssertEqual(Stats.Axis(of: [MovementPoint(atMs: 1, weightKg: -20, reps: 8),
                                       MovementPoint(atMs: 2, weightKg: 0, reps: 6)]),
                       .load)
        XCTAssertEqual(Stats.Axis(of: [MovementPoint(atMs: 1, weightKg: 0, reps: 8),
                                       MovementPoint(atMs: 2, weightKg: 0, reps: 11)]),
                       .reps)
    }

    // A movement that has never moved is honestly flat, drawn down the middle — pinning it to an
    // edge would be a divide by nothing dressed up as a trend.
    func testAMovementThatNeverMovedIsFlatDownTheMiddle() {
        let line = Stats.line(
            MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 1_754_313_600_000,
                             points: [MovementPoint(atMs: 1, weightKg: 60, reps: 5, e1rm: 70),
                                      MovementPoint(atMs: 2, weightKg: 60, reps: 5, e1rm: 70)]),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.heights, [0.5, 0.5])
        XCTAssertEqual(line?.span, "2 sessions · 70 → 70")
        XCTAssertEqual(line?.lastTrained, "trained yesterday")
    }

    func testOneSessionIsOneDotAndSaysSoRatherThanDrawingADirection() {
        let line = Stats.line(
            MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: 60, reps: 5, e1rm: 70)]),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.heights, [0.5])
        XCTAssertEqual(line?.span, "1 session · 70")
    }

    // The server builds a movement out of its points, so one with none cannot arrive — and if one
    // ever did, a name over an empty frame is not what this screen would draw.
    func testAMovementWithNoPointsIsLeftOutEntirely() {
        XCTAssertNil(Stats.line(MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 0),
                                catalog: catalog, now: 1_754_400_000_000))
    }

    // A lifter adding 2.5 kg a week tops their estimate and their load on the SAME set every time,
    // so the common case is one line and not two printing one day twice.
    func testOneSetHoldingBothMarksIsOneLine() {
        let line = Stats.line(
            MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: 90, reps: 3, e1rm: 99)],
                             bestE1rm: MovementBest(weightKg: 90, reps: 3, atMs: 1_754_400_000_000, e1rm: 99),
                             heaviest: MovementBest(weightKg: 90, reps: 3, atMs: 1_754_400_000_000, e1rm: 99)),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.bests, ["best 90 × 3 · e1RM 99 kg · \(Readout.day(1_754_400_000_000))"])
    }

    func testTwoDifferentSetsHoldingTheTwoMarksAreTwoLines() {
        let line = Stats.line(
            MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: 82.5, reps: 6, e1rm: 99)],
                             bestE1rm: MovementBest(weightKg: 82.5, reps: 6, atMs: 1_754_400_000_000, e1rm: 99),
                             heaviest: MovementBest(weightKg: 90, reps: 1, atMs: 1_754_313_600_000, e1rm: 93)),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.bests, ["best e1RM 99 kg · 82.5 × 6 · \(Readout.day(1_754_400_000_000))",
                                     "heaviest 90 × 1 · \(Readout.day(1_754_313_600_000))"])
    }

    // Zero is not a load, it is the absence of one — the finish screen's own rule, applied to a
    // standing best. "heaviest 0 × 12" is a sentence about a weight nobody lifted.
    func testABodyweightBestIsSpelledAsRepsAndNeverAsAZeroLoad() {
        let line = Stats.line(
            MovementProgress(exerciseId: "chin-up", lastTrainedAtMs: 1_754_400_000_000,
                             points: [MovementPoint(atMs: 1, weightKg: 0, reps: 12)],
                             heaviest: MovementBest(weightKg: 0, reps: 12, atMs: 1_754_400_000_000)),
            catalog: catalog, now: 1_754_400_000_000)

        XCTAssertEqual(line?.bests, ["heaviest 12 reps · \(Readout.day(1_754_400_000_000))"])
    }

    // The board is the whole screen, decided once and outside a view body: the weeks window and one
    // line per movement, in the order the server sorted them (most recently trained first).
    func testTheBoardIsTheWholeScreenDecidedInOnePass() {
        let statistics = TrainingStatistics(
            weeks: [TrainingWeek(startedAtMs: 1_754_006_400_000, sessions: 2, workingSets: 20)],
            movements: [MovementProgress(exerciseId: "chin-up", lastTrainedAtMs: 1_754_400_000_000,
                                         points: [MovementPoint(atMs: 1, weightKg: 0, reps: 12)]),
                        MovementProgress(exerciseId: "bench-press", lastTrainedAtMs: 1_754_313_600_000,
                                         points: [MovementPoint(atMs: 1, weightKg: 80, reps: 5, e1rm: 93.3)])])
        let board = Stats.board(statistics, catalog: catalog, now: 1_754_400_000_000)

        XCTAssertFalse(board.isEmpty)
        XCTAssertEqual(board.weeks?.sets.heights, [1])
        XCTAssertEqual(board.lines.map(\.movement), ["Chin-up", "Bench press"])
        XCTAssertEqual(board.lines.map(\.unit), ["reps", "e1RM"],
                       "a chin-up at one fixed load is drawn on its reps, never on a constant zero")
    }
}

// The two retrospective reads, at the store. What is pinned here is the distinction this whole
// module is built on: A LOG THAT ANSWERED WITH A REASON IS NOT A LOG THAT WENT QUIET. The lifter can
// act on the first and can only wait out the second, and a screen that printed "the log didn't
// answer" over a 500 would point them at their signal when the answer was on the server.
@MainActor
final class RetrospectiveReadTests: XCTestCase {
    private var queueURL: URL!

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-reads-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
    }

    private func connected(_ server: FakeTraining) async -> TrainingStore {
        var ms: Int64 = 1_000
        let store = TrainingStore(queue: SetQueue(url: queueURL),
                                  deviceCatalog: DeviceCatalog(url: queueURL.appendingPathExtension("cat")),
                                  now: { ms += 1; return ms },
                                  undoWindowMs: 0,
                                  sync: { _ in server })
        await store.connect(to: Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: User(id: "u1", email: "sam@example.com", name: "Sam")))
        return store
    }

    func testAStatisticsRefusalCarriesTheLogsSentenceAndSilenceCarriesTheRoomsOwn() async {
        let server = FakeTraining()
        server.stats = TrainingStatistics(
            weeks: [TrainingWeek(startedAtMs: 1_754_265_600_000, sessions: 2, workingSets: 20)])
        let store = await connected(server)

        guard case .success(let read) = await store.statistics() else {
            return XCTFail("the log answered")
        }
        XCTAssertEqual(read.weeks.count, 1)

        server.refuseStats = .refused(500, Refusal(Data(#"{"error":"internal error"}"#.utf8)))
        guard case .failure(let refused) = await store.statistics() else {
            return XCTFail("a 500 is not a statistics read")
        }
        XCTAssertEqual(refused.line("these lines aren’t drawn"), "internal error")

        server.refuseStats = nil
        server.online = false
        guard case .failure(let quiet) = await store.statistics() else {
            return XCTFail("an unreachable log is not a statistics read")
        }
        XCTAssertEqual(quiet.line("these lines aren’t drawn"),
                       "the log didn’t answer — these lines aren’t drawn")
    }

    // Absent and another account's are one 404, folded into the type by GymApi — so there is no
    // sentence from the log to repeat and the store says the plain fact instead. A session discarded
    // from the web after Today listed it is exactly this case, and it is not a phone with no signal.
    func testASessionThatIsNoLongerOnTheLogSaysSoRatherThanBlamingTheConnection() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 2_000))
        let store = await connected(server)

        guard case .success(let detail) = await store.sessionDetail("ses_1") else {
            return XCTFail("the log holds this one")
        }
        XCTAssertEqual(detail.session.id, "ses_1")

        guard case .failure(let gone) = await store.sessionDetail("ses_missing") else {
            return XCTFail("a session that is not there is not a session")
        }
        XCTAssertEqual(gone, .refused("that session is no longer on the log"))

        server.online = false
        guard case .failure(let quiet) = await store.sessionDetail("ses_1") else {
            return XCTFail("an unreachable log is not a session")
        }
        XCTAssertEqual(quiet.line("the sets are on your account"),
                       "the log didn’t answer — the sets are on your account")
    }
}
