import XCTest
@testable import WindmillGym

// The rest timer answers from an instant, never from a counter — so a pocketed phone comes back to
// the truth. And being over the target is a fact, not a fault: the overrun counts up, and nothing
// here is allowed to read as an error.
//
// The target is one somebody ASKED for — the routine's line, or §I's dial — and there is no third
// answer any more. The tests below are what stops one growing back.

final class RestTests: XCTestCase {
    // The routine's own line wins for the movement it names; the dial answers everything else.
    func testTheRoutinesOwnRestBeatsTheDial() {
        let entry = PlanEntry(exerciseId: "face-pull", sets: 3, reps: 15, restSeconds: 180)
        let dialled = GymPreferences.defaults.resting(90)
        XCTAssertEqual(Rest.target(planEntry: entry, preferences: dialled), 180)
        XCTAssertEqual(Rest.target(planEntry: nil, preferences: dialled), 90)
    }

    // THE ONE THAT MATTERS: a lifter who has never opened the settings screen is not beeped at. The
    // per-movement table that used to answer here was exactly that — a timer nobody asked for — and
    // it went with the dial that replaced it.
    func testNobodyWhoHasNotAskedForARestTimerGetsOne() {
        XCTAssertNil(GymPreferences.defaults.restSeconds)
        XCTAssertNil(Rest.target(planEntry: nil, preferences: .defaults))
        XCTAssertNil(Rest.target(planEntry: PlanEntry(exerciseId: "back-squat", sets: 5),
                                 preferences: .defaults))
    }

    // The dial's four, and `off` is one of them rather than the absence of one.
    func testTheDialOffersOffAndThreeRests() {
        XCTAssertEqual(Rest.choices, [nil, 90, 120, 180])
        XCTAssertEqual(Rest.choices.map(SettingsScreen.spell), ["off", "1:30", "2:00", "3:00"])
    }

    // The chime is keyed on the whole clock, target included, because the logger schedules it as a
    // sleep against that key: a dial turned off mid-rest has to REPLACE that task, and a key made of
    // the instant alone would leave the old one to land and chime for a timer nobody is running.
    func testTheChimesKeyMovesWhenTheDialDoesAndNotOtherwise() {
        XCTAssertNotEqual(Rest.Clock(startedAtMs: 1_000, targetSeconds: 120),
                          Rest.Clock(startedAtMs: 1_000, targetSeconds: 180))
        XCTAssertEqual(Rest.Clock(startedAtMs: 1_000, targetSeconds: 120),
                       Rest.Clock(startedAtMs: 1_000, targetSeconds: 120))
    }

    func testRestingCountsDownToTheTargetAndNamesIt() {
        let line = Rest.Line(targetSeconds: 180, startedAtMs: 0, now: 49_000)
        XCTAssertEqual(line.label, "resting · target 3:00")
        XCTAssertEqual(line.time, "2:11")
        XCTAssertFalse(line.overrun)
    }

    // Past the target the clock turns around and counts UP with a plus. It does not stop, it does
    // not alarm, and it does not tell the lifter to go — being over is not an error.
    func testPastTheTargetTheClockCountsUpAndSaysTheRestIsDone() {
        let line = Rest.Line(targetSeconds: 180, startedAtMs: 0, now: 187_000)
        XCTAssertEqual(line.label, "rest done · target 3:00")
        XCTAssertEqual(line.time, "+0:07")
        XCTAssertTrue(line.overrun)
    }

    // The value is computed from the instant the set landed, so a phone asleep for ten minutes comes
    // back showing ten minutes rather than however long the app was awake for.
    func testAPocketedPhoneComesBackToTheRealElapsedTime() {
        let line = Rest.Line(targetSeconds: 120, startedAtMs: 1_000_000, now: 1_000_000 + 600_000)
        XCTAssertEqual(line.time, "+8:00")
        XCTAssertTrue(line.overrun)
    }
}
