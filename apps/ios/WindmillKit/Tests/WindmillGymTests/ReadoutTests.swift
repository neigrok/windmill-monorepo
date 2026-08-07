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
}
