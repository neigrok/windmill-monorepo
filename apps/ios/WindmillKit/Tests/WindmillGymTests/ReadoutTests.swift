import XCTest
@testable import WindmillGym

final class ReadoutTests: XCTestCase {
    func testAWeightPrintsWithoutTrailingZerosAndWithARealMinus() {
        XCTAssertEqual(Readout.weight(102.5), "102.5")
        XCTAssertEqual(Readout.weight(100), "100")
        XCTAssertEqual(Readout.weight(0), "0")
        XCTAssertEqual(Readout.weight(-20), "\u{2212}20")
        XCTAssertEqual(Readout.weight(-2.5), "\u{2212}2.5")
    }

    func testAWeightIsRoundedOnTheLaddersGrid() {
        XCTAssertEqual(Readout.weight(102.505), "102.51")
        XCTAssertEqual(Readout.weight(-102.505), "\u{2212}102.51")
        XCTAssertEqual(Readout.weight(0.1 + 0.2), "0.3")
    }

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

    func testADurationNamesHoursOnlyWhenThereAreSome() {
        XCTAssertEqual(Readout.duration(47 * 60_000), "47m")
        XCTAssertEqual(Readout.duration(62 * 60_000), "1h 02m")
        XCTAssertEqual(Readout.duration(3_720_000), "1h 02m")
        XCTAssertEqual(Readout.duration(900), "1m")
    }

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

    func testATargetIsSpelledOneWayForTheWholeProduct() {
        XCTAssertEqual(Readout.target(sets: 5, reps: 5, weightKg: 82.5), "5 × 5 · 82.5")
        XCTAssertEqual(Readout.target(sets: 3, reps: nil, weightKg: nil), "3 × max")
        XCTAssertEqual(Readout.target(sets: 3, reps: 8, weightKg: 0), "3 × 8")
        XCTAssertEqual(Readout.target(sets: 3, reps: 8, weightKg: -20), "3 × 8 · \u{2212}20")
    }

    func testATargetTheRoutineNeverNamedIsOneWordAndNeverAZero() {
        XCTAssertEqual(Readout.target(sets: nil, reps: nil, weightKg: nil), "open")
        XCTAssertEqual(Readout.target(sets: nil, reps: nil, weightKg: nil), Readout.openTarget)
    }

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
