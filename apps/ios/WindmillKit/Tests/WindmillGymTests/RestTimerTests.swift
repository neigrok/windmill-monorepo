import XCTest
@testable import WindmillGym

// The rest timer answers from an instant, never from a counter — so a pocketed phone comes back to
// the truth. And being over the target is a fact, not a fault: the rule fills, arrives, and stays
// full, and nothing here is allowed to read as an error.
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

    // The hairline is a proportion of the target, filled from the left.
    func testTheRuleFillsTowardTheTarget() {
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 0), 0)
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 90_000), 0.5)
        XCTAssertEqual(Rest.filled(targetSeconds: 120, startedAtMs: 60_000, now: 150_000), 0.75)
    }

    // Past the target the rule is FULL and never longer. It does not stop being drawn, it does not
    // alarm, and it does not tell the lifter to go — being over is not an error, and there is
    // nothing after the target this screen wants to report on.
    func testPastTheTargetTheRuleIsFullAndNoMore() {
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 187_000), 1)
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 1_800_000), 1)
        // A clock that walked backwards — a device time correction mid-rest — draws an empty rule
        // rather than a negative one nobody can render.
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 90_000, now: 0), 0)
    }

    // The value is computed from the instant the set landed, so a phone asleep for ten minutes comes
    // back to a full rule rather than to however long the app was awake for.
    func testAPocketedPhoneComesBackToTheRealElapsedTime() {
        XCTAssertEqual(Rest.filled(targetSeconds: 120, startedAtMs: 1_000_000,
                                   now: 1_000_000 + 600_000), 1)
        XCTAssertEqual(Rest.filled(targetSeconds: 1_200, startedAtMs: 1_000_000,
                                   now: 1_000_000 + 600_000), 0.5)
    }

    // THE NUMERAL IS WHAT THE RULE CANNOT SAY, and this is the case that says why it stayed: past
    // the target every overrun fills the rule identically, so without the number seven seconds over
    // and twenty minutes over are the same pixel. It counts down to the target, then up with a plus,
    // and never names the target itself — that is a setting, chosen on another screen.
    func testTheNumeralTellsOneOverrunFromAnother() {
        XCTAssertEqual(Rest.reading(targetSeconds: 180, startedAtMs: 0, now: 49_000), "2:11")
        XCTAssertEqual(Rest.reading(targetSeconds: 180, startedAtMs: 0, now: 180_000), "0:00")
        XCTAssertEqual(Rest.reading(targetSeconds: 180, startedAtMs: 0, now: 187_000), "+0:07")
        XCTAssertEqual(Rest.reading(targetSeconds: 180, startedAtMs: 0, now: 1_380_000), "+20:00")
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 187_000),
                       Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 1_380_000),
                       "the rule cannot tell those two apart, which is the whole argument")
    }

    // A pocketed phone comes back to the real number here too, for the same reason: it is computed
    // from the instant the set landed and never counted down while the app was awake.
    func testThePocketedPhoneComesBackToTheRealNumeral() {
        XCTAssertEqual(Rest.reading(targetSeconds: 120, startedAtMs: 1_000_000,
                                    now: 1_000_000 + 600_000), "+8:00")
    }
}
