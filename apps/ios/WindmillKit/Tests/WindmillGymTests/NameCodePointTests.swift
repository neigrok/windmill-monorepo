import XCTest
@testable import WindmillGym

// One fixture, three surfaces. The same sixty-character name is pinned here, in
// `web/test/products/gym/nameCodePoints.test.js` and in `NameCodePointTests.kt` (Android): thirty
// emoji and thirty accented letters. It reads as sixty characters on all three because a character
// is a CODE POINT — the unit Postgres `char_length` counts — and it weighs 180 bytes, under the
// store's 240. The three units this one name tells apart: 60 code points · 90 UTF-16 units · 180
// UTF-8 bytes.
final class NameCodePointTests: XCTestCase {
    private let sixty = String(repeating: "😀", count: 30) + String(repeating: "ü", count: 30)
    private var sixtyOne: String { sixty + "ü" }

    // The other half of the fixture, and the shape that tells a code point from what the eye counts:
    // one lifter is ONE thing on screen and five code points underneath. Sixty of these would weigh
    // 960 bytes, four times the store's ceiling; twelve of them are the sixty characters this cap
    // allows.
    private let lifter = "🏋️‍♀️"

    func testTheSharedFixtureIsSixtyCodePointsNinetyUtf16UnitsAndOneHundredEightyBytes() {
        XCTAssertEqual(sixty.unicodeScalars.count, 60)
        XCTAssertEqual(sixty.utf16.count, 90, "UTF-16 units are the unit this fixture exists to rule out")
        XCTAssertEqual(sixty.utf8.count, 180)
        XCTAssertEqual(sixtyOne.unicodeScalars.count, 61)
    }

    func testANameOfSixtyCodePointsIsAcceptedWholeAndCountsSixty() {
        XCTAssertEqual(RoutineDraft.capped(sixty), sixty)
        XCTAssertEqual(RoutineDraft.counter(sixty), "60/60")
        XCTAssertLessThanOrEqual(RoutineDraft.capped(sixty).utf8.count, 240,
                                 "sixty code points always fit the store's 240 bytes")

        let draft = RoutineDraft(name: sixty, entries: [.init(exerciseId: "deadlift")], position: 0)
        XCTAssertTrue(draft.isSavable)
        XCTAssertNil(draft.saveRefusal)
        XCTAssertEqual(draft.write.name, sixty, "the whole name reaches the log")
    }

    func testTheSixtyFirstCodePointIsTheOnlyOneRefused() {
        XCTAssertEqual(RoutineDraft.capped(sixtyOne), sixty)
        XCTAssertEqual(RoutineDraft.counter(sixtyOne), "61/60")

        let emoji = String(repeating: "😀", count: 61)
        XCTAssertEqual(RoutineDraft.capped(emoji), String(repeating: "😀", count: 60))
        XCTAssertEqual(RoutineDraft.capped(emoji).utf8.count, 240, "the heaviest sixty characters there are")
    }

    func testOneThingOnScreenCanBeFiveCharactersAndTheCapCountsAllFive() {
        XCTAssertEqual(lifter.count, 1, "one grapheme cluster")
        XCTAssertEqual(lifter.unicodeScalars.count, 5)
        XCTAssertEqual(lifter.utf16.count, 6)
        XCTAssertEqual(lifter.utf8.count, 16)

        let twelve = String(repeating: lifter, count: 12)
        XCTAssertEqual(RoutineDraft.counter(twelve), "60/60")
        XCTAssertEqual(RoutineDraft.capped(twelve), twelve)
        XCTAssertEqual(twelve.utf8.count, 192, "under the store's 240")

        let thirteen = String(repeating: lifter, count: 13)
        XCTAssertEqual(RoutineDraft.capped(thirteen), twelve)
        XCTAssertEqual(RoutineDraft.counter(thirteen), "65/60")
        XCTAssertEqual(Notes.titleCharacters(twelve), 60)
        XCTAssertEqual(Notes.refusal(title: thirteen, body: "squats first"), Notes.titleTooLong)
    }

    func testANotesTitleCountsTheSameFixtureTheSameWay() {
        XCTAssertEqual(Notes.titleCharacters(sixty), 60)
        XCTAssertEqual(Notes.counter(characters: Notes.titleCharacters(sixty)), "60 of 60 characters")
        XCTAssertNil(Notes.refusal(title: sixty, body: "squats first"))

        XCTAssertEqual(Notes.titleCharacters(sixtyOne), 61)
        XCTAssertEqual(Notes.refusal(title: sixtyOne, body: "squats first"), Notes.titleTooLong)
        XCTAssertEqual(Notes.maxTitleCharacters, RoutineDraft.maxNameLength, "one cap for a name and a title")
    }
}
