import XCTest
@testable import WindmillGym

// C2 · what "the six most-used" means on this surface. They are ranked from the log THIS DEVICE
// holds, over its newest fifty sessions, and topped up in order from the shared opener list — so a
// fresh account still opens on six, and an account with a log opens on its own six. The twin of
// Android's `PickerOptions.mostTrained` and of web's `trainedCounts`.
final class PickerSixRankingTests: XCTestCase {

    // The catalog order is the tie-break, so the fixture states it once here.
    private let catalog = [
        Exercise(id: "back-squat", name: "Back Squat"),
        Exercise(id: "bench-press", name: "Bench Press"),
        Exercise(id: "deadlift", name: "Deadlift"),
        Exercise(id: "overhead-press", name: "Overhead Press"),
        Exercise(id: "barbell-row", name: "Barbell Row"),
        Exercise(id: "chin-up", name: "Chin Up"),
        Exercise(id: "leg-press", name: "Leg Press"),
        Exercise(id: "lat-pulldown", name: "Lat Pulldown"),
        Exercise(id: "face-pull", name: "Face Pull"),
    ]

    private func session(_ named: [String], at day: Int64 = 0) -> SessionSummary {
        SessionSummary(session: Session(id: "s_\(day)_\(named.joined(separator: "-"))",
                                        startedAtMs: day * 86_400_000,
                                        finishedAtMs: day * 86_400_000 + 3_600_000),
                       setCount: named.count, exercises: named)
    }

    private func six(_ sessions: [SessionSummary], taken: [String] = []) -> [String] {
        PickerOptions.matching(query: "", catalog: catalog, taken: taken, sessions: sessions)
            .six.map(\.id)
    }

    func testALogLessAccountOpensOnTheOpenersInTheirOwnOrder() {
        XCTAssertEqual(PickerOptions.openers,
                       ["back-squat", "bench-press", "deadlift", "overhead-press", "barbell-row",
                        "chin-up"])
        XCTAssertEqual(six([]), PickerOptions.openers,
                       "a fresh account has nothing to rank and must still see six")
    }

    // The count is SESSIONS THAT NAMED IT, never working sets: nothing on the wire ranks a movement
    // by use, and this invents no read.
    func testTheSixAreTheMovementsTheMostSessionsNamed() {
        let log = [
            session(["Face Pull", "Lat Pulldown"], at: 3),
            session(["Face Pull", "Leg Press"], at: 2),
            session(["Face Pull", "Lat Pulldown"], at: 1),
        ]
        XCTAssertEqual(six(log),
                       ["face-pull", "lat-pulldown", "leg-press", "back-squat", "bench-press",
                        "deadlift"],
                       "three sessions named the face pull, two the pulldown, one the leg press")
    }

    // A session the LOG served names its movements by name; one this device wrote names them by id
    // (`LocalLog.summaries()`). One movement, either spelling, one count.
    func testAMovementIsCountedUnderEitherSpellingOfItself() {
        let mixed = [session(["face-pull"], at: 2), session(["Face Pull"], at: 1)]
        XCTAssertEqual(six(mixed).first, "face-pull")
        XCTAssertEqual(Array(six([session(["Leg Press"], at: 3),
                                  session(["Leg Press"], at: 2),
                                  session(["face-pull"], at: 1)]).prefix(2)),
                       ["leg-press", "face-pull"],
                       "one movement under two spellings outranked a movement named twice")
    }

    // Naming the same movement twice in one session is one session, not two.
    func testASessionCountsOnceHoweverManyTimesItNamesAMovement() {
        let twice = [session(["Face Pull", "Face Pull", "Face Pull"], at: 2),
                     session(["Leg Press"], at: 1),
                     session(["Leg Press"], at: 0)]
        XCTAssertEqual(Array(six(twice).prefix(2)), ["leg-press", "face-pull"])
    }

    func testMovementsTrainedEquallyOftenKeepCatalogOrder() {
        let level = [session(["Face Pull", "Lat Pulldown", "Leg Press"], at: 1)]
        XCTAssertEqual(six(level),
                       ["leg-press", "lat-pulldown", "face-pull", "back-squat", "bench-press",
                        "deadlift"],
                       "the tie is broken by the catalog and not by the order the log named them")
    }

    // A fixed depth, so a phone that has paged further back does not rank differently from one that
    // has not.
    func testOnlyTheNewestFiftySessionsAreCounted() {
        XCTAssertEqual(PickerOptions.trainedWindow, 50)
        let newest = (0..<50).map { session(["Lat Pulldown"], at: Int64(100 - $0)) }
        let older = (0..<20).map { session(["Face Pull"], at: Int64(50 - $0)) }
        XCTAssertEqual(six(newest + older),
                       ["lat-pulldown", "back-squat", "bench-press", "deadlift", "overhead-press",
                        "barbell-row"],
                       "a session below the window ranked a movement anyway")
    }

    // The top-up never repeats a movement the ranking already found, and it never lengthens the six.
    func testAShortRankingIsToppedUpFromTheOpenersWithoutRepeatingOne() {
        let ranked = six([session(["Deadlift", "Face Pull"], at: 1)])
        XCTAssertEqual(ranked,
                       ["deadlift", "face-pull", "back-squat", "bench-press", "overhead-press",
                        "barbell-row"])
        XCTAssertEqual(Set(ranked).count, 6, "the top-up drew a movement the ranking already had")
    }

    // Everything already in this session is gone from the catalog before the ranking runs.
    func testAMovementAlreadyInTheSessionIsNeverOneOfTheSix() {
        let taken = ["face-pull", "back-squat"]
        let ranked = six([session(["Face Pull", "Back Squat", "Leg Press"], at: 1)], taken: taken)
        XCTAssertEqual(ranked,
                       ["leg-press", "bench-press", "deadlift", "overhead-press", "barbell-row",
                        "chin-up"])
    }

    // A typed query features nothing at all: the six are the empty query's answer.
    func testATypedQueryStillFeaturesNothing() {
        let typed = PickerOptions.matching(query: "pull", catalog: catalog, taken: [],
                                           sessions: [session(["Face Pull"], at: 1)])
        XCTAssertTrue(typed.six.isEmpty)
        XCTAssertEqual(typed.matches.map(\.id), ["lat-pulldown", "face-pull"])
    }

    // A catalog that never landed has nothing to rank, and says so in the bytes all three surfaces say.
    func testAnUnreadCatalogRanksNothingAndKeepsItsOwnSentence() {
        let silent = PickerOptions.matching(query: "", catalog: [], taken: [],
                                            sessions: [session(["Face Pull"], at: 1)])
        XCTAssertTrue(silent.six.isEmpty)
        XCTAssertEqual(silent.empty, "The catalog didn’t load. It comes back when you have signal.")
    }
}
