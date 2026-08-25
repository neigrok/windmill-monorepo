import XCTest
@testable import WindmillGym

final class RestTests: XCTestCase {
    func testTheRoutinesOwnRestBeatsTheDial() {
        let entry = PlanEntry(exerciseId: "face-pull", sets: 3, reps: 15, restSeconds: 180)
        let dialled = GymPreferences.defaults.resting(90)
        XCTAssertEqual(Rest.target(planEntry: entry, preferences: dialled), 180)
        XCTAssertEqual(Rest.target(planEntry: nil, preferences: dialled), 90)
    }

    func testNobodyWhoHasNotAskedForARestTimerGetsOne() {
        XCTAssertNil(GymPreferences.defaults.restSeconds)
        XCTAssertNil(Rest.target(planEntry: nil, preferences: .defaults))
        XCTAssertNil(Rest.target(planEntry: PlanEntry(exerciseId: "back-squat", sets: 5),
                                 preferences: .defaults))
    }

    func testTheDialOffersOffAndThreeRests() {
        XCTAssertEqual(Rest.choices, [nil, 90, 120, 180])
        XCTAssertEqual(Rest.choices.map(SettingsScreen.spell), ["off", "1:30", "2:00", "3:00"])
    }

    func testTheChimesKeyMovesWhenTheDialDoesAndNotOtherwise() {
        XCTAssertNotEqual(Rest.Clock(startedAtMs: 1_000, targetSeconds: 120),
                          Rest.Clock(startedAtMs: 1_000, targetSeconds: 180))
        XCTAssertEqual(Rest.Clock(startedAtMs: 1_000, targetSeconds: 120),
                       Rest.Clock(startedAtMs: 1_000, targetSeconds: 120))
    }

    func testTheRuleFillsTowardTheTarget() {
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 0), 0)
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 90_000), 0.5)
        XCTAssertEqual(Rest.filled(targetSeconds: 120, startedAtMs: 60_000, now: 150_000), 0.75)
    }

    func testPastTheTargetTheRuleIsFullAndNoMore() {
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 187_000), 1)
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 1_800_000), 1)
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 90_000, now: 0), 0)
    }

    func testAPocketedPhoneComesBackToTheRealElapsedTime() {
        XCTAssertEqual(Rest.filled(targetSeconds: 120, startedAtMs: 1_000_000,
                                   now: 1_000_000 + 600_000), 1)
        XCTAssertEqual(Rest.filled(targetSeconds: 1_200, startedAtMs: 1_000_000,
                                   now: 1_000_000 + 600_000), 0.5)
    }

    // One clock, read one way on every surface: time since the last set, and it never flips at the target.
    func testTheNumeralCountsUpThroughoutAndTellsOneOverrunFromAnother() {
        XCTAssertEqual(Rest.reading(startedAtMs: 0, now: 0), "0:00")
        XCTAssertEqual(Rest.reading(startedAtMs: 0, now: 49_000), "0:49")
        XCTAssertEqual(Rest.reading(startedAtMs: 0, now: 180_000), "3:00")
        XCTAssertEqual(Rest.reading(startedAtMs: 0, now: 187_000), "3:07")
        XCTAssertEqual(Rest.reading(startedAtMs: 0, now: 1_380_000), "23:00")
        XCTAssertFalse(Rest.reading(startedAtMs: 0, now: 187_000).contains("+"))
        XCTAssertEqual(Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 187_000),
                       Rest.filled(targetSeconds: 180, startedAtMs: 0, now: 1_380_000),
                       "the rule cannot tell those two apart, which is the whole argument")
    }

    func testAClockReadBeforeItsOwnStartReadsZeroRatherThanNegative() {
        XCTAssertEqual(Rest.reading(startedAtMs: 90_000, now: 0), "0:00")
    }

    func testThePocketedPhoneComesBackToTheRealNumeral() {
        XCTAssertEqual(Rest.reading(startedAtMs: 1_000_000, now: 1_000_000 + 600_000), "10:00")
    }
}
