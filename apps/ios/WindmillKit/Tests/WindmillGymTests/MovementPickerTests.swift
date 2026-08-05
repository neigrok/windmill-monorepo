import XCTest
@testable import WindmillGym

// Three different silences, and they must not share a sentence. A lifter who typed a letter the
// catalog does not hold was once told their signal was out — the app reporting a failure that had
// not happened, and pointing them at the wrong thing to fix.

final class PickerOptionsTests: XCTestCase {
    private let catalog = [
        Exercise(id: "bench-press", name: "Bench Press"),
        Exercise(id: "close-grip-bench-press", name: "Close-Grip Bench Press"),
        Exercise(id: "back-squat", name: "Back Squat"),
        Exercise(id: "zercher-squat", name: "Zercher Squat", custom: true),
    ]

    func testTypingFiltersOnTheNameAndIsBlindToCase() {
        let options = PickerOptions.matching(query: "  bench ", catalog: catalog, taken: [])
        XCTAssertEqual(options.matches.map(\.id), ["bench-press", "close-grip-bench-press"])
        XCTAssertNil(options.empty)
        XCTAssertNil(options.create, "there is something to pick, so there is nothing to mint")
    }

    // A movement already in the session is not offered again: the picker adds movements, and the
    // jump sheet is where a lifter goes back to one.
    func testAMovementAlreadyInTheSessionIsNotOffered() {
        let options = PickerOptions.matching(query: "squat", catalog: catalog, taken: ["back-squat"])
        XCTAssertEqual(options.matches.map(\.id), ["zercher-squat"])
    }

    // Only an EMPTY catalog may mention signal — and it offers no door, because what is missing is
    // the read and not the movement. Matched to web/src/products/gym/logger/movements.js line for
    // line: two surfaces disagreeing about which silence has a way out is the drift this file exists
    // to catch.
    func testOnlyAnEmptyCatalogBlamesTheNetworkAndItOffersNoDoor() {
        let options = PickerOptions.matching(query: "bench", catalog: [], taken: [])
        XCTAssertEqual(options.empty, "The catalog didn’t load. It comes back when you have signal.")
        XCTAssertNil(options.create)
    }

    // A catalog already entirely in the session is answered by the jump sheet, not by minting a
    // second copy of a movement that is already being logged.
    func testACatalogEntirelyInTheSessionSaysThatAndOffersNoDoor() {
        let taken = catalog.map(\.id)
        let options = PickerOptions.matching(query: "", catalog: catalog, taken: taken)
        XCTAssertEqual(options.empty, "Every movement in the catalog is already in this session.")
        XCTAssertNil(options.create)
    }

    // The one silence a NAME can answer, and the only one with a door.
    func testAQueryThatMatchesNothingSaysOnlyThatAndOffersToMintIt() {
        let options = PickerOptions.matching(query: " zottman ", catalog: catalog, taken: [])
        XCTAssertEqual(options.empty, "No movement by that name.")
        XCTAssertEqual(options.create, "Create “zottman”")
    }

    // The sentence never echoes the query back: the button holds it, and holding it twice would be
    // the same words in the same breath.
    func testTheSentenceDoesNotRepeatWhatTheButtonAlreadySays() {
        let options = PickerOptions.matching(query: "zottman", catalog: catalog, taken: [])
        XCTAssertFalse(options.empty?.contains("zottman") ?? true)
    }

    // The list is cut so the sheet never becomes a catalog browser — typing is the filter.
    func testTheListIsCutToWhatAThumbCanRead() {
        let long = (0..<20).map { Exercise(id: "ex_\($0)", name: "Press \($0)") }
        XCTAssertEqual(PickerOptions.matching(query: "press", catalog: long, taken: []).matches.count,
                       PickerOptions.shown)
    }
}
