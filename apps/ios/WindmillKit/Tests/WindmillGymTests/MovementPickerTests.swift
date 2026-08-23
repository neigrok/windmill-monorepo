import XCTest
@testable import WindmillGym

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

    func testAMovementAlreadyInTheSessionIsNotOffered() {
        let options = PickerOptions.matching(query: "squat", catalog: catalog, taken: ["back-squat"])
        XCTAssertEqual(options.matches.map(\.id), ["zercher-squat"])
    }

    func testOnlyAnEmptyCatalogBlamesTheNetworkAndItOffersNoDoor() {
        let options = PickerOptions.matching(query: "bench", catalog: [], taken: [])
        XCTAssertEqual(options.empty, "The catalog didn’t load. It comes back when you have signal.")
        XCTAssertNil(options.create)
    }

    func testACatalogEntirelyInTheSessionSaysThatAndOffersNoDoor() {
        let taken = catalog.map(\.id)
        let options = PickerOptions.matching(query: "", catalog: catalog, taken: taken)
        XCTAssertEqual(options.empty, "Every movement in the catalog is already in this session.")
        XCTAssertNil(options.create)
    }

    func testAQueryThatMatchesNothingSaysOnlyThatAndOffersToMintIt() {
        let options = PickerOptions.matching(query: " zottman ", catalog: catalog, taken: [])
        XCTAssertEqual(options.empty, "No movement by that name.")
        XCTAssertEqual(options.create, "Create “zottman”")
    }

    func testTheSentenceDoesNotRepeatWhatTheButtonAlreadySays() {
        let options = PickerOptions.matching(query: "zottman", catalog: catalog, taken: [])
        XCTAssertFalse(options.empty?.contains("zottman") ?? true)
    }

    func testTheListIsCutToWhatAThumbCanRead() {
        let long = (0..<20).map { Exercise(id: "ex_\($0)", name: "Press \($0)") }
        XCTAssertEqual(PickerOptions.matching(query: "press", catalog: long, taken: []).matches.count,
                       PickerOptions.shown)
    }

    func testTheSixLeadAnUnfilteredListAndAreNotRepeatedInIt() {
        let options = PickerOptions.matching(query: "", catalog: DeviceCatalog.seeded, taken: [])
        XCTAssertEqual(options.six.map(\.id), PickerOptions.six)
        XCTAssertEqual(options.six.map(\.name),
                       ["Back Squat", "Bench Press", "Deadlift", "Overhead Press", "Barbell Row",
                        "Chin Up"],
                       "named off the catalog, because a name is what this account calls a movement")
        XCTAssertTrue(options.matches.allSatisfy { !PickerOptions.six.contains($0.id) })
        XCTAssertNil(options.empty)
    }

    func testASixAlreadyInTheSessionIsNotOfferedAgain() {
        let options = PickerOptions.matching(query: "", catalog: DeviceCatalog.seeded,
                                             taken: ["bench-press", "deadlift"])
        XCTAssertEqual(options.six.map(\.id),
                       ["back-squat", "overhead-press", "barbell-row", "chin-up"])
    }

    func testTypingPutsTheSixAwayAndFiltersEverything() {
        let options = PickerOptions.matching(query: "squat", catalog: DeviceCatalog.seeded, taken: [])
        XCTAssertTrue(options.six.isEmpty)
        XCTAssertEqual(options.matches.first?.id, "back-squat")
    }

    func testTheMetaSaysNothingUntilTheLogHasAnswered() {
        let quiet = PickerOptions.matching(query: "bench", catalog: catalog, taken: [])
        XCTAssertEqual(quiet.matches.map(\.meta), [nil, nil])

        let day: Int64 = 86_400_000
        let answered = PickerOptions.matching(
            query: "bench", catalog: catalog, taken: [],
            lastSets: ["bench-press": LastSet(exerciseId: "bench-press", weightKg: 82.5, reps: 5,
                                              atMs: 10 * day)],
            now: 13 * day)
        XCTAssertEqual(answered.matches.map(\.meta), ["last 82.5 × 5 · 3 days ago", "never logged"])
    }

    func testAMintedMovementIsTaggedYours() {
        let options = PickerOptions.matching(query: "squat", catalog: catalog, taken: [])
        XCTAssertEqual(options.matches.map(\.yours), [false, true])
    }
}
