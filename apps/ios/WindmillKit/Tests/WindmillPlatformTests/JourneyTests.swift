import XCTest
@testable import WindmillPlatform

// The journey is a handful of once-ever decisions, and every one of them is wrong in a way someone
// would notice: a question that asks twice, a launch that forgets where you were, a house sheet that
// re-pitches rooms you already know about.

final class JourneyTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        suite = "journey-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testAFreshDeviceHasNotBeenAskedAnything() {
        let journey = Journey(defaults: defaults)
        XCTAssertFalse(journey.asked)
        XCTAssertNil(journey.lastRoom)
        XCTAssertFalse(journey.houseShown)
    }

    // The one question runs once, ever. Asking again is the "second onboarding screen" the flow
    // forbids, and a relaunch is exactly when a naive implementation would ask again.
    func testTheOneQuestionIsNeverAskedTwice() {
        var journey = Journey(defaults: defaults)
        journey.answeredFirstQuestion()
        XCTAssertTrue(Journey(defaults: defaults).asked, "a relaunch must not re-ask")
    }

    func testTheLastRoomSurvivesARelaunch() {
        var journey = Journey(defaults: defaults)
        journey.stood(in: "journal")
        XCTAssertEqual(Journey(defaults: defaults).lastRoom, "journal")
    }

    // Going home is a choice, not an absence: the hub is where they chose to be, so the next launch
    // opens the hub rather than dragging them back into the room they deliberately left.
    func testGoingHomeClearsTheLastRoom() {
        var journey = Journey(defaults: defaults)
        journey.stood(in: "journal")
        journey.stood(in: nil)
        XCTAssertNil(Journey(defaults: defaults).lastRoom)
    }

    // The house waits for something real. Firing on an empty room is the "hub of three empty rooms"
    // the entry question exists to avoid, moved one screen later.
    func testTheHouseWaitsForSomethingReal() {
        let journey = Journey(defaults: defaults)
        XCTAssertFalse(journey.shouldIntroduceHouse(madeSomething: false, otherRooms: 2))
        XCTAssertTrue(journey.shouldIntroduceHouse(madeSomething: true, otherRooms: 2))
    }

    func testTheHouseIsShownOnceAndNeverAgain() {
        var journey = Journey(defaults: defaults)
        XCTAssertTrue(journey.shouldIntroduceHouse(madeSomething: true, otherRooms: 2))
        journey.houseWasShown()
        XCTAssertFalse(journey.shouldIntroduceHouse(madeSomething: true, otherRooms: 2))
        XCTAssertFalse(Journey(defaults: defaults).shouldIntroduceHouse(madeSomething: true, otherRooms: 2),
                       "and not after a relaunch either")
    }

    // A superapp with one room has no house to introduce. This is not hypothetical — it is what a
    // build with the other two products unmounted looks like.
    func testThereIsNoHouseWhenThereIsOnlyOneRoom() {
        let journey = Journey(defaults: defaults)
        XCTAssertFalse(journey.shouldIntroduceHouse(madeSomething: true, otherRooms: 0))
    }
}

final class HoldingsTests: XCTestCase {
    // The count is shown to someone deciding whether to sign in, so the wrong plural reads as
    // carelessness at exactly the wrong moment.
    func testOneOfSomethingIsNotPluralised() {
        XCTAssertEqual(Holdings(count: 1, noun: "page").phrase, "1 page")
        XCTAssertEqual(Holdings(count: 3, noun: "page").phrase, "3 pages")
        XCTAssertEqual(Holdings(count: 1, noun: "tree").phrase, "1 tree")
        XCTAssertEqual(Holdings(count: 0, noun: "session").phrase, "0 sessions")
    }

    func testNothingHeldIsEmpty() {
        XCTAssertTrue(Holdings.none.isEmpty)
        XCTAssertTrue(Holdings(count: 0, noun: "page").isEmpty)
        XCTAssertFalse(Holdings(count: 1, noun: "page").isEmpty)
    }
}
