import XCTest
@testable import WindmillGym

// One product, one spelling. Every number gym prints goes through this file, so what is pinned here
// is that the prefill card, the set row, the finish tile and the log row cannot drift apart — and
// that the two spellings a training log gets wrong stay right: a negative load, and a duration.

final class ReadoutTests: XCTestCase {
    // A weight is not a decimal field. Trailing zeros go, and the minus is the TYPOGRAPHIC one —
    // band-assisted work sits below zero, and an ASCII hyphen there is a different glyph from the
    // one the golden and the web both print.
    func testAWeightPrintsWithoutTrailingZerosAndWithARealMinus() {
        XCTAssertEqual(Readout.weight(102.5), "102.5")
        XCTAssertEqual(Readout.weight(100), "100")
        XCTAssertEqual(Readout.weight(0), "0")
        XCTAssertEqual(Readout.weight(-20), "\u{2212}20")
        XCTAssertEqual(Readout.weight(-2.5), "\u{2212}2.5")
    }

    // The grid is the ladder's own, not a second opinion — a rounding rule of its own here is how
    // two surfaces of one product end up disagreeing about a half-cent.
    func testAWeightIsRoundedOnTheLaddersGrid() {
        XCTAssertEqual(Readout.weight(102.505), "102.51")
        XCTAssertEqual(Readout.weight(-102.505), "\u{2212}102.51")
        XCTAssertEqual(Readout.weight(0.1 + 0.2), "0.3")
    }

    // A LOAD IS AN UNVALIDATED DOUBLE — the wire's and the shelf's, both — and a JSON number runs to
    // 1e308 while converting one to an Int traps above 9.2e18. The spelling has to be total: an
    // absurd number in one field spoils the row it belongs to and never the screen around it. Every
    // load a barbell has ever held is many orders of magnitude inside this.
    func testAWeightNoRealBarbellCouldHoldIsSpelledRatherThanCrashing() {
        XCTAssertEqual(Readout.weight(1e19), "—")
        XCTAssertEqual(Readout.weight(1e308), "—")
        XCTAssertEqual(Readout.weight(.infinity), "—")
        XCTAssertEqual(Readout.weight(.nan), "—")
        XCTAssertEqual(Readout.weight(999_999), "999999", "the bound is nowhere near a real load")
    }

    func testASetReadsAsItsLoadAndItsReps() {
        XCTAssertEqual(Readout.effort(weightKg: 82.5, reps: 5), "82.5 × 5")
        XCTAssertEqual(Readout.effort(weightKg: 0, reps: 9), "0 × 9")
    }

    // Under an hour there is no hour, over it there are two digits of minutes — and a session that
    // lasted seconds still says a minute rather than "0m", because zero is not a workout.
    func testADurationNamesHoursOnlyWhenThereAreSome() {
        XCTAssertEqual(Readout.duration(47 * 60_000), "47m")
        XCTAssertEqual(Readout.duration(62 * 60_000), "1h 02m")
        XCTAssertEqual(Readout.duration(3_720_000), "1h 02m")
        XCTAssertEqual(Readout.duration(900), "1m")
    }

    // The clock drops the leading hour and never the leading minute: a rest at 47 seconds reads
    // 0:47, and a session at two hours reads 2:00:14.
    func testTheClockKeepsMinutesAndAddsHoursOnlyWhenItHasThem() {
        XCTAssertEqual(Readout.clock(47_000), "0:47")
        XCTAssertEqual(Readout.clock(1_924_000), "32:04")
        XCTAssertEqual(Readout.clock(7_214_000), "2:00:14")
        XCTAssertEqual(Readout.clock(-5_000), "0:00", "a span that has not started yet is not negative time")
    }

    func testHowLongAgoIsWholeDaysAndNamesTheNearOnes() {
        let day: Int64 = 86_400_000
        let now: Int64 = 20 * day
        XCTAssertEqual(Readout.ago(now, now: now), "today")
        XCTAssertEqual(Readout.ago(now - day, now: now), "yesterday")
        XCTAssertEqual(Readout.ago(now - 5 * day, now: now), "5 days ago")
    }

    // "YESTERDAY" IS A CLAIM ABOUT THE CALENDAR AND NOT ABOUT ELAPSED HOURS, which is the whole of
    // log.js `agoLabel`: a session finished at 07:00 is still today at 21:00, and one finished at
    // 23:00 is already yesterday by 01:00. Dividing the gap by 86_400_000 got both of those backwards
    // — the morning's workout read "yesterday" on the phone before lunch — and it also miscounts
    // across the 23- and 25-hour days. The instants are built in the reader's own zone, because that
    // is the only zone this sentence is ever read in.
    func testHowLongAgoCountsCalendarDaysAndNotElapsedHours() {
        let calendar = Calendar.current
        let midnight = calendar.startOfDay(for: Date(timeIntervalSince1970: 1_754_308_320))
        let at = { (days: Int, hour: Int) -> Int64 in
            let day = calendar.date(byAdding: .day, value: days, to: midnight)!
            return Int64(calendar.date(byAdding: .hour, value: hour, to: day)!.timeIntervalSince1970 * 1000)
        }

        XCTAssertEqual(Readout.ago(at(0, 7), now: at(0, 21)), "today",
                       "fourteen hours is not yesterday when it never crossed a midnight")
        XCTAssertEqual(Readout.ago(at(0, 23), now: at(1, 1)), "yesterday",
                       "two hours is yesterday once it has")
        XCTAssertEqual(Readout.ago(at(0, 23), now: at(5, 1)), "5 days ago")
    }

    // A PAST DAY THE RECORD PAGE NAMES rather than counts (§H prints `today` on one row and `27 Jul`
    // on the next). Past the two days that have their own word it is a date — "16 days ago" is the
    // wrong answer for a mark somebody wants to find in their log — and the YEAR arrives the moment
    // the date is no longer this one, because a record ladder is lifetime and "13 Jul" names a
    // square on nobody's calendar two years later.
    func testADayIsNamedRatherThanCountedOnceItIsPastYesterday() {
        var parts = DateComponents()
        parts.year = 2026
        parts.month = 8
        parts.day = 10
        parts.hour = 9
        let now = Int64(Calendar.current.date(from: parts)!.timeIntervalSince1970 * 1000)
        let day: Int64 = 86_400_000

        XCTAssertEqual(Readout.when(now, now: now), "today")
        XCTAssertEqual(Readout.when(now - day, now: now), "yesterday")
        XCTAssertEqual(Readout.when(now - 14 * day, now: now), "27 Jul")
        XCTAssertEqual(Readout.when(now - 400 * day, now: now), "6 Jul 2025")
    }

    func testACountOfSetsIsSingularAtOne() {
        XCTAssertEqual(Readout.setCount(1), "1 set")
        XCTAssertEqual(Readout.setCount(16), "16 sets")
        XCTAssertEqual(Readout.setCount(0), "0 sets")
    }

    // A movement is a stable id everywhere except on screen. A catalog that has not answered yet
    // leaves the slug, which a lifter can still recognise — a blank where the movement should be
    // is the one thing that is not readable.
    func testAMovementWithoutACatalogRowKeepsItsId() {
        let catalog = [Exercise(id: "bench-press", name: "Bench Press")]
        XCTAssertEqual(Readout.movement("bench-press", in: catalog), "Bench Press")
        XCTAssertEqual(Readout.movement("zercher-squat", in: catalog), "zercher-squat")
        XCTAssertEqual(Readout.movement("bench-press", in: []), "bench-press")
    }

    func testWorkingSetsAreCountedUnderTheirOwnWord() {
        XCTAssertEqual(Readout.workingCount(11), "11 working")
        XCTAssertEqual(Readout.workingCount(0), "0 working")
    }

    // TONNAGE IS A CAPTION, NEVER A METRIC — and the rule that keeps it honest is that it answers
    // with NOTHING where there is nothing true to say. A chin-up-and-dips session did not move zero
    // kilograms; `0.0 t` would be a claim that it moved none of any kind, so nothing is drawn. The
    // floor is that same rule one decimal further down.
    func testTonnageIsAbsentRatherThanAFalseZero() {
        XCTAssertEqual(Readout.tonnage(14_200), "14.2 t")
        XCTAssertEqual(Readout.tonnage(5_400), "5.4 t")
        XCTAssertEqual(Readout.tonnage(5_000), "5.0 t")
        XCTAssertEqual(Readout.tonnage(0), nil)
        XCTAssertEqual(Readout.tonnage(40), nil, "under 50 kg the one decimal this prints IS zero")
        XCTAssertEqual(Readout.tonnage(-120), nil, "a sum cannot go below zero — every set clamps at it")
        XCTAssertEqual(Readout.tonnage(.infinity), nil,
                       "a SUM is the one way a number here goes non-finite — `inf t` is not a caption")
    }

    // A target reads the same on the routine card, on the log's plan line and in the comparison,
    // because all three ask this. An absent weight prints nothing, and so does a zero: zero is not a
    // load but the absence of one, while a band-assisted −20 is a real point on this number line.
    func testATargetIsSpelledOneWayForTheWholeProduct() {
        XCTAssertEqual(Readout.target(sets: 5, reps: 5, weightKg: 82.5), "5 × 5 · 82.5")
        XCTAssertEqual(Readout.target(sets: 3, reps: nil, weightKg: nil), "3 × max")
        XCTAssertEqual(Readout.target(sets: 3, reps: 8, weightKg: 0), "3 × 8")
        XCTAssertEqual(Readout.target(sets: 3, reps: 8, weightKg: -20), "3 × 8 · \u{2212}20")
    }

    // A row the routine named NOTHING for is one word (§M). It short-circuits the whole line and
    // loses nothing by it: the server refuses to store reps or a weight on a line with no set count,
    // so there is never a second number here to print instead — and a `0 × 5` would be a target of
    // nothing, drawn over a decision the lifter deliberately left for the rack.
    func testATargetTheRoutineNeverNamedIsOneWordAndNeverAZero() {
        XCTAssertEqual(Readout.target(sets: nil, reps: nil, weightKg: nil), "open")
        XCTAssertEqual(Readout.target(sets: nil, reps: nil, weightKg: nil), Readout.openTarget)
    }

    // A date, with no weekday in front — the Monday a week of the log opens on, and the bottom of
    // that log, which carries its year because that is the one fact worth arriving at.
    func testADateDropsTheWeekdayAndKeepsTheYearOnlyAtTheBottom() {
        var parts = DateComponents()
        parts.year = 2026
        parts.month = 5
        parts.day = 6
        parts.hour = 9
        let ms = Int64((Calendar.current.date(from: parts) ?? Date()).timeIntervalSince1970 * 1000)

        XCTAssertEqual(Readout.date(ms), "6 May")
        XCTAssertEqual(Readout.dateWithYear(ms), "6 May 2026")
    }

    // ONE WORD FOR A SESSION NOBODY PLANNED, and an empty routine name on a snapshot is the same
    // fact as no snapshot at all — the wire defaults that field to a blank string.
    func testASessionWithNoRoutineIsNamedOneWay() {
        let bare = Session(id: "ses_1", startedAtMs: 1_000)
        let blank = Session(id: "ses_2", startedAtMs: 1_000,
                            plan: PlanSnapshot(routine: "", entries: []))
        let named = Session(id: "ses_3", startedAtMs: 1_000,
                            plan: PlanSnapshot(routine: "Push A", entries: []))

        XCTAssertEqual(Readout.routine(of: bare), "Session · no routine")
        XCTAssertEqual(Readout.routine(of: blank), "Session · no routine")
        XCTAssertEqual(Readout.routine(of: named), "Push A")
    }
}
