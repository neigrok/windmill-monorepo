import SwiftUI
import XCTest
@testable import WindmillPlatform

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

    func testGoingHomeClearsTheLastRoom() {
        var journey = Journey(defaults: defaults)
        journey.stood(in: "journal")
        journey.stood(in: nil)
        XCTAssertNil(Journey(defaults: defaults).lastRoom)
    }

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

    func testThereIsNoHouseWhenThereIsOnlyOneRoom() {
        let journey = Journey(defaults: defaults)
        XCTAssertFalse(journey.shouldIntroduceHouse(madeSomething: true, otherRooms: 0))
    }
}

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

    func testARoomThatOpensOntoWorkSaysNothingExtra() {
        XCTAssertNil(Fake(id: "journal").caveat)
    }

    func testARoomOnAnotherSurfaceCarriesItsOwnElsewhereLine() {
        let elsewhere = Fake(id: "roadmap",
                             presence: .elsewhere(url: URL(string: "https://windmill.works/")!,
                                                  line: "Your trees are on the web."))
        XCTAssertEqual(elsewhere.caveat, "Your trees are on the web.")
    }

    func testARoomThatNeedsAnAccountSaysSoOnTheDoor() {
        let gated = Fake(id: "someday",
                         entry: EntryDoor(verb: "Open the vault", line: "a locked thing",
                                          made: "Opened.", back: "Back",
                                          caveat: "The vault needs an account."))
        XCTAssertEqual(gated.caveat, "The vault needs an account.")
    }

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

final class AppearanceTests: XCTestCase {
    func testSystemHandsTheChoiceBackToTheOS() {
        XCTAssertNil(Appearance.system.scheme)
        XCTAssertEqual(Appearance.light.scheme, .light)
        XCTAssertEqual(Appearance.dark.scheme, .dark)
    }

    func testEveryChoiceIsOfferedAndLabelled() {
        XCTAssertEqual(Appearance.allCases.map(\.label), ["Light", "Dark", "System"])
    }

    func testAnUnknownStoredValueIsNotAnAppearance() {
        XCTAssertNil(Appearance(rawValue: "sepia"))
        XCTAssertEqual(Appearance(rawValue: "dark"), .dark)
    }
}
