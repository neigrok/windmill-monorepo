import SwiftUI
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

// THE FIRST SCREEN MUST NOT OFFER A DOOR IT CANNOT OPEN. It draws one card per mounted product,
// before anything about the app has been seen, and two of the three rooms do not open straight onto
// work — so what the card says about that is the whole of whether that screen is honest.

@MainActor
final class EntryCaveatTests: XCTestCase {
    private struct Fake: ProductModule {
        let id: String
        let label = "Fake"
        let symbol = "circle"
        var presence: Presence = .here
        var entry = EntryDoor(verb: "Do it", line: "a thing", made: "Made.", back: "Back")

        func room(_ account: Account) -> AnyView { AnyView(EmptyView()) }
        func hubLine(_ account: Account) -> HubLine { HubLine(eyebrow: "Now", headline: "Nothing.") }
    }

    // The good case, and the reason nil is the default: a room that opens onto work has nothing to
    // warn about, and a card that manufactured a caveat would be noise on the one screen that can't
    // afford any.
    func testARoomThatOpensOntoWorkSaysNothingExtra() {
        XCTAssertNil(Fake(id: "journal").caveat)
    }

    // A room that is really on another surface says WHERE, and says it with the words it already
    // uses inside — the sentence is not written twice, so the card and the room cannot drift.
    func testARoomOnAnotherSurfaceCarriesItsOwnElsewhereLine() {
        let elsewhere = Fake(id: "roadmap",
                             presence: .elsewhere(url: URL(string: "https://windmill.works/")!,
                                                  line: "Your trees are on the web."))
        XCTAssertEqual(elsewhere.caveat, "Your trees are on the web.")
    }

    // A room that is here but has a wall in it says what the wall is, in its own entry.
    func testARoomThatNeedsAnAccountSaysSoOnTheDoor() {
        let gated = Fake(id: "gym",
                         entry: EntryDoor(verb: "Log a workout", line: "sets and weights",
                                          made: "Logged.", back: "Back",
                                          caveat: "Sessions are kept on your account."))
        XCTAssertEqual(gated.caveat, "Sessions are kept on your account.")
    }

    // Presence outranks the entry's own words. A module that filled in both would be two sentences
    // about one room, and the structural fact is the one the shell can verify.
    func testWhereTheRoomIsOutranksWhatItAsksFor() {
        let both = Fake(id: "roadmap",
                        presence: .elsewhere(url: URL(string: "https://windmill.works/")!,
                                             line: "On the web."),
                        entry: EntryDoor(verb: "Plan", line: "steps", made: "Planted.",
                                         back: "Back", caveat: "Needs an account."))
        XCTAssertEqual(both.caveat, "On the web.")
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

// Appearance sets the SHELL. The mapping matters because "System" is not a third palette — it is
// the absence of an override, and getting that wrong pins the app to one skin forever.
final class AppearanceTests: XCTestCase {
    func testSystemHandsTheChoiceBackToTheOS() {
        XCTAssertNil(Appearance.system.scheme)
        XCTAssertEqual(Appearance.light.scheme, .light)
        XCTAssertEqual(Appearance.dark.scheme, .dark)
    }

    func testEveryChoiceIsOfferedAndLabelled() {
        XCTAssertEqual(Appearance.allCases.map(\.label), ["Light", "Dark", "System"])
    }

    // Stored as a raw string, so an unreadable value must fall back rather than crash a launch.
    func testAnUnknownStoredValueIsNotAnAppearance() {
        XCTAssertNil(Appearance(rawValue: "sepia"))
        XCTAssertEqual(Appearance(rawValue: "dark"), .dark)
    }
}
