import XCTest
@testable import WindmillPlatform
@testable import WindmillRoadmap

// Roadmap is the one product mounted here without a room, and the whole of its honesty is one
// sentence. What these pin is not the wording — it is that the sentence reaches the FIRST screen.
// It used to live only inside `ElsewhereRoom`, which meant a fresh phone offered "Plan something
// big" as an equal door and answered the tap with a link out to Safari.

@MainActor
final class RoadmapModuleTests: XCTestCase {
    private let module = RoadmapModule()

    func testRoadmapSaysItsRoomIsSomewhereElse() {
        guard case .elsewhere(let url, let line) = module.presence else {
            return XCTFail("roadmap has no room on this phone and must say so")
        }
        XCTAssertEqual(url, URL(string: "https://windmill.works/#/")!)
        XCTAssertEqual(line, "Your trees are on the web. The tree canvas isn't built for the phone yet.")
    }

    // The fix, stated as the rule it enforces: the first-run card carries the elsewhere line, so
    // where the product lives is known BEFORE the door is chosen rather than after.
    func testTheFirstRunCardCarriesThatSameSentence() {
        XCTAssertEqual(module.caveat,
                       "Your trees are on the web. The tree canvas isn't built for the phone yet.")
    }

    // And it is written once. A module that also filled in `entry.caveat` would be two sentences
    // about one room, free to drift apart the first time either is edited.
    func testTheSentenceIsNotWrittenTwice() {
        XCTAssertNil(module.entry.caveat)
    }

    // The door still reads as a door — the caveat is what the card adds, never what it replaces.
    func testTheDoorStillOffersTheProductInPlainVerbs() {
        XCTAssertEqual(module.id, "roadmap")
        XCTAssertEqual(module.entry.verb, "Plan something big")
        XCTAssertEqual(module.entry.line, "a goal, broken into steps you can see")
    }
}
