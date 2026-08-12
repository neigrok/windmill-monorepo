import XCTest
@testable import WindmillGym

// THE LOG'S ONE PIECE OF ARITHMETIC — the week a session belongs to, and what a week is allowed to
// say about itself. Everything pinned here is a place the screen could quietly lie: a Monday that
// moves, a total that is short because the page ended, and a zero standing in for a week nobody has
// anything true to say about.

final class LogWeeksTests: XCTestCase {
    // Built through the calendar rather than from epoch arithmetic, so the fold is asked the same
    // question in every zone this app runs in — which is the whole point of a LOCAL Monday.
    private func at(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Int64 {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = hour
        let moment = Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
        return Int64(moment.timeIntervalSince1970 * 1000)
    }

    private func session(_ id: String, at startedAtMs: Int64, routine: String? = nil,
                         working: Int? = nil, tonnageKg: Double? = nil,
                         topE1rm: Double? = nil, record: Bool = false) -> SessionSummary {
        let plan = routine.map { PlanSnapshot(routine: $0, entries: []) }
        return SessionSummary(session: Session(id: id, startedAtMs: startedAtMs,
                                               finishedAtMs: startedAtMs + 3_480_000, plan: plan),
                              setCount: 14,
                              workingSetCount: working, tonnageKg: tonnageKg, topE1rm: topE1rm,
                              record: record)
    }

    // Newest first, Monday to Monday, and the divider names the Monday the week opened on — not the
    // day of the first session in it. Sunday belongs to the week that began six days earlier.
    func testSessionsFoldIntoWeeksThatStartOnMonday() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 10)),      // Monday
            session("b", at: at(2026, 8, 9)),       // Sunday — the week before
            session("c", at: at(2026, 8, 3)),       // Monday
            session("d", at: at(2026, 7, 28)),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 10))

        XCTAssertEqual(weeks.map(\.label), ["week of 10 Aug", "week of 3 Aug", "week of 27 Jul"])
        XCTAssertEqual(weeks.map { $0.rows.map(\.id) }, [["a"], ["b", "c"], ["d"]])
    }

    // The order the fold answers in is the order the log is read in, whatever order it was handed.
    func testTheFoldSortsNewestFirstRatherThanTrustingTheOrderItWasGiven() {
        let weeks = LogWeeks.fold([
            session("old", at: at(2026, 8, 3)),
            session("new", at: at(2026, 8, 7)),
            session("mid", at: at(2026, 8, 5)),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks.count, 1)
        XCTAssertEqual(weeks[0].rows.map(\.id), ["new", "mid", "old"])
    }

    // The divider's caption is the week's own tonnage, summed from the sessions in it.
    func testAWeeksTonnageIsTheSumOfItsSessions() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 7), tonnageKg: 6_100),
            session("b", at: at(2026, 8, 5), tonnageKg: 9_800),
            session("c", at: at(2026, 8, 3), tonnageKg: 1_200),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks.map(\.tonnage), ["17.1 t"])
    }

    // PAGING IS NEWEST-FIRST, so every SERVED week is whole except the one the page ended inside —
    // and a part of a week captioned as the week is a number that silently changes when you tap
    // Load older.
    func testTheWeekTheServedPageEndsInsideWithholdsItsTonnageUntilTheBottomIsReached() {
        let page = [session("a", at: at(2026, 8, 7), tonnageKg: 6_100),
                    session("b", at: at(2026, 8, 1), tonnageKg: 5_000)]

        let more = LogWeeks.fold(page, deviceOnly: [], reach: .served(oldest: at(2026, 8, 1)),
                                 now: at(2026, 8, 7))
        XCTAssertEqual(more.map(\.tonnage), ["6.1 t", nil])

        let bottom = LogWeeks.fold(page, deviceOnly: [], reach: .whole, now: at(2026, 8, 7))
        XCTAssertEqual(bottom.map(\.tonnage), ["6.1 t", "5.0 t"])
    }

    // THE FLOOR IS THE SERVED PAGE'S AND NOT THE SCREEN'S. This device's unclaimed sessions are
    // merged in at any age, so one old one sits BELOW the served page and pushes the half-loaded
    // week up out of last place — where captioning "every week but the last" would state a total
    // that grows on the next tap. The week the server stopped inside stays silent wherever it sits.
    func testADeviceOnlySessionBelowTheServedPageDoesNotUnsilenceTheWeekAboveIt() {
        let rows = [session("served-new", at: at(2026, 8, 7), tonnageKg: 5_000),
                    session("served-old", at: at(2026, 8, 5), tonnageKg: 1_000),
                    session("local", at: at(2026, 7, 20), tonnageKg: 6_000)]

        let weeks = LogWeeks.fold(rows, deviceOnly: ["local"],
                                  reach: .served(oldest: at(2026, 8, 5)), now: at(2026, 8, 10))

        XCTAssertEqual(weeks.map(\.label), ["week of 3 Aug", "week of 20 Jul"])
        XCTAssertEqual(weeks.map(\.tonnage), [nil, nil],
                       "the served page ended inside week of 3 Aug — it may not caption itself, and "
                       + "nothing older than it may either")
        XCTAssertEqual(LogWeeks.fold(rows, deviceOnly: ["local"], reach: .whole,
                                     now: at(2026, 8, 10)).map(\.tonnage), ["6.0 t", "6.0 t"])
    }

    // Nothing served yet — the first read still in flight, or one that failed — is a floor of
    // nowhere: every week on screen may still gain a session, so none of them states a total.
    func testAScreenHoldingOnlyDeviceSessionsCaptionsNoWeekUntilTheLogHasAnswered() {
        let weeks = LogWeeks.fold([session("local", at: at(2026, 8, 7), tonnageKg: 6_100)],
                                  deviceOnly: ["local"], reach: .served(oldest: nil),
                                  now: at(2026, 8, 7))

        XCTAssertEqual(weeks.map(\.tonnage), [nil])
    }

    // The head counts what is ON SCREEN, and says nothing at all until something is: a log still
    // being read has not answered "0 sessions", and every other number here omits rather than zeroes.
    func testTheHeadStatesNoCountBeforeTheFirstReadHasAnswered() {
        XCTAssertEqual(LogWeeks.loaded(sessions: 0, weeks: 0), nil)
        XCTAssertEqual(LogWeeks.loaded(sessions: 1, weeks: 1), "1 session · 1 week loaded")
        XCTAssertEqual(LogWeeks.loaded(sessions: 41, weeks: 12), "41 sessions · 12 weeks loaded")
    }

    // One session the wire said nothing about takes the whole week's caption with it: a sum missing
    // a session is not that week's tonnage, and printing it anyway would under-count in silence.
    func testAWeekHoldingASessionWithNoTonnageSaysNothingAboutItsOwn() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 7), tonnageKg: 6_100),
            session("b", at: at(2026, 8, 5)),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks.map(\.tonnage), [nil])
    }

    // A chin-up-and-dips week did not move zero kilograms — we simply have nothing true to say about
    // it, and `0.0 t` would be a claim. Absence over a false zero, on the row and on the divider.
    func testAWeekThatMovedNoExternalLoadDrawsNothingRatherThanAZero() {
        let weeks = LogWeeks.fold([session("a", at: at(2026, 8, 7), working: 12, tonnageKg: 0)],
                                  deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks[0].tonnage, nil)
        XCTAssertEqual(weeks[0].rows[0].tonnage, nil)
        XCTAssertEqual(weeks[0].rows[0].working, "12 working")
    }

    // The four facts of a row, and the one that is not there. A session this device is the only home
    // for has a working count and a tonnage — both are arithmetic — and no estimate at all, because
    // Epley is the domain's and there is one copy per language.
    func testARowStatesWhatItHasAndDrawsNothingWhereTheWireSaidNothing() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 7), routine: "Pull A",
                    working: 14, tonnageKg: 6_100, topE1rm: 141),
            session("b", at: at(2026, 8, 5), working: 16, tonnageKg: 9_800),
        ], deviceOnly: ["b"], reach: .whole, now: at(2026, 8, 10))

        let served = weeks[0].rows[0]
        XCTAssertEqual(served.title, "Pull A")
        XCTAssertEqual(served.when, "Fri 7 Aug")
        XCTAssertEqual(served.working, "14 working")
        XCTAssertEqual(served.tonnage, "6.1 t")
        XCTAssertEqual(served.e1rm, "e1RM 141")
        XCTAssertFalse(served.deviceOnly)

        let unclaimed = weeks[0].rows[1]
        XCTAssertEqual(unclaimed.title, "Session · no routine")
        XCTAssertEqual(unclaimed.e1rm, nil, "no Epley is computed on this device")
        XCTAssertTrue(unclaimed.deviceOnly, "the hollow ring is real on this surface — draw it")
    }

    // The clock is what tells two sessions on the same day apart, and it is noise a week later.
    func testARowCarriesTheClockOnlyWhileItIsStillToday() {
        XCTAssertEqual(LogWeeks.Row.when(at(2026, 8, 10, hour: 18), now: at(2026, 8, 10, hour: 21)),
                       "today · 18:00")
        XCTAssertEqual(LogWeeks.Row.when(at(2026, 8, 7, hour: 18), now: at(2026, 8, 10, hour: 1)),
                       "Fri 7 Aug")
        // Midnight is a CALENDAR claim, not an elapsed-hours one: a session logged at 23:00 is
        // already yesterday by 01:00, and the row may not still be calling it today.
        XCTAssertEqual(LogWeeks.Row.when(at(2026, 8, 9, hour: 23), now: at(2026, 8, 10, hour: 1)),
                       "Sun 9 Aug")
    }

    // THE GOLD DOT IS THE LOG'S JUDGEMENT AND NEVER THIS CLIENT'S: a row wears one when the log says
    // a record happened in there, judged against the log as it is now. A row this device is the only
    // home for never wears one — the three record rules are claims against a history the device does
    // not hold, and no dot there is an omission rather than the assertion a wrong dot would be.
    func testARowWearsTheGoldDotOnlyWhenTheLogSaysARecordHappenedInIt() {
        let weeks = LogWeeks.fold([
            session("pr", at: at(2026, 8, 10, hour: 18), record: true),
            session("ordinary", at: at(2026, 8, 10, hour: 8)),
            session("mine", at: at(2026, 8, 10, hour: 6)),
        ], deviceOnly: ["mine"], reach: .whole, now: at(2026, 8, 10, hour: 21))

        XCTAssertEqual(weeks[0].rows.map(\.record), [true, false, false])
        XCTAssertEqual(weeks[0].rows.map(\.deviceOnly), [false, false, true])
    }

    func testAnEmptyLogFoldsIntoNoWeeksAtAll() {
        XCTAssertEqual(LogWeeks.fold([], deviceOnly: [], reach: .whole, now: at(2026, 8, 10)), [])
    }
}
