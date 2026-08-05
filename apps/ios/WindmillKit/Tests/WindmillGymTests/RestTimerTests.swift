import XCTest
@testable import WindmillGym

// The rest timer answers from an instant, never from a counter — so a pocketed phone comes back to
// the truth. And being over the target is a fact, not a fault: the overrun counts up, and nothing
// here is allowed to read as an error.

final class RestTests: XCTestCase {
    // The routine's own line wins: a lifter who wrote three minutes against an accessory meant it.
    func testTheRoutinesOwnRestBeatsTheTableAndTheTableBeatsTheDefault() {
        let entry = PlanEntry(exerciseId: "face-pull", sets: 3, reps: 15, restSeconds: 180)
        XCTAssertEqual(Rest.target("face-pull", planEntry: entry), 180)
        XCTAssertEqual(Rest.target("face-pull", planEntry: nil), 60)
        XCTAssertEqual(Rest.target("back-squat", planEntry: nil), 180)
    }

    // A movement the table has never heard of — including one the lifter minted this morning —
    // rests for two minutes rather than for nothing.
    func testAMovementNobodyHasWeighedRestsForTheDefault() {
        XCTAssertEqual(Rest.target("ex_31ab", planEntry: nil), Rest.defaultSeconds)
        XCTAssertEqual(Rest.defaultSeconds, 120)
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
