import XCTest
@testable import WindmillPlatform
@testable import WindmillRoadmap

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

    func testTheFirstRunCardCarriesThatSameSentence() {
        XCTAssertEqual(module.caveat,
                       "Your trees are on the web. The tree canvas isn't built for the phone yet.")
    }

    func testTheSentenceIsNotWrittenTwice() {
        XCTAssertNil(module.entry.caveat)
    }

    func testTheDoorStillOffersTheProductInPlainVerbs() {
        XCTAssertEqual(module.id, "roadmap")
        XCTAssertEqual(module.entry.verb, "Plan something big")
        XCTAssertEqual(module.entry.line, "a goal, broken into steps you can see")
    }
}
