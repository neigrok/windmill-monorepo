import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

final class LocalDayTests: XCTestCase {
    func testOnlyAWellFormedDayIsADay() {
        XCTAssertNotNil(LocalDay(iso: "2026-07-20"))
        for bad in ["2026-7-20", "26-07-20", "2026-13-01", "2026-07-32", "yesterday", ""] {
            XCTAssertNil(LocalDay(iso: bad), "\(bad) is not a day")
        }
    }

    func testTextOrderIsDateOrder() {
        let days = ["2026-07-09", "2025-12-31", "2026-01-01", "2026-07-10"].compactMap { LocalDay(iso: $0) }
        XCTAssertEqual(days.sorted().map(\.iso),
                       ["2025-12-31", "2026-01-01", "2026-07-09", "2026-07-10"])
    }

    func testWalkingBackwardsCrossesMonthAndYearBoundaries() {
        XCTAssertEqual(LocalDay(iso: "2026-03-01")!.advanced(by: -1).iso, "2026-02-28")
        XCTAssertEqual(LocalDay(iso: "2026-01-01")!.advanced(by: -1).iso, "2025-12-31")
        XCTAssertEqual(LocalDay(iso: "2024-03-01")!.advanced(by: -1).iso, "2024-02-29", "2024 is a leap year")
    }

    func testTheSixtyDayWindowIsSixtyDays() {
        XCTAssertEqual(LocalDay(iso: "2026-01-15")!.advanced(by: -60).iso, "2025-11-16")
        XCTAssertEqual(LocalDay(iso: "2026-03-01")!.advanced(by: -60).iso, "2025-12-31")
    }

    func testTheDayIsTheCalendarDayNotAnInstant() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let lateEvening = calendar.date(from: DateComponents(year: 2026, month: 7, day: 20, hour: 23, minute: 4))!
        let justAfterMidnight = calendar.date(from: DateComponents(year: 2026, month: 7, day: 21, hour: 0, minute: 10))!

        XCTAssertEqual(LocalDay(lateEvening, calendar: calendar).iso, "2026-07-20")
        XCTAssertEqual(LocalDay(justAfterMidnight, calendar: calendar).iso, "2026-07-21")
    }
}

final class PageConvergenceTests: XCTestCase {
    private func page(_ day: String, _ body: String, stamp: String) -> Page {
        Page(day: LocalDay(iso: day)!, body: body, stamp: Hlc(stamp))
    }

    func testTheGreaterStampWins() {
        let mine = page("2026-07-20", "what I wrote on my phone", stamp: "200:0:d-phone")
        let theirs = page("2026-07-20", "what I wrote on the web", stamp: "300:0:d-web")
        XCTAssertEqual(Page.winner(of: theirs, and: mine).body, "what I wrote on the web")
        XCTAssertEqual(Page.winner(of: mine, and: theirs).body, "what I wrote on the web")
    }

    func testNothingHeldMeansTheIncomingPageWins() {
        let incoming = page("2026-07-20", "first", stamp: "1:0:d-a")
        XCTAssertEqual(Page.winner(of: incoming, and: nil), incoming)
    }

    func testAnIdenticalStampKeepsTheIncumbent() {
        let held = page("2026-07-20", "held", stamp: "100:0:d-a")
        let echo = page("2026-07-20", "echo", stamp: "100:0:d-a")
        XCTAssertEqual(Page.winner(of: echo, and: held).body, "held")
    }

    func testAWrittenDayIsAnyDaySomeoneShowedUpFor() {
        XCTAssertFalse(Page(day: LocalDay(iso: "2026-07-20")!).isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, body: "a line").isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, mood: 3).isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, energy: 1).isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, mood: 0).isWritten,
                      "zero is an answer, and an answered day is a written day")
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, energy: 0).isWritten)
    }

    func testOutOfRangeScalesNarrowToUnsetAndZeroSurvives() {
        XCTAssertEqual(Scale.narrow(11), nil)
        XCTAssertEqual(Scale.narrow(-1), nil)
        XCTAssertEqual(Scale.narrow(nil), nil)
        XCTAssertEqual(Scale.narrow(0), 0, "zero is a value, never the unset state")
        XCTAssertEqual(Scale.narrow(10), 10)
        XCTAssertEqual(Page(day: LocalDay(iso: "2026-07-20")!, mood: 42).mood, nil)
        XCTAssertEqual(Page(day: LocalDay(iso: "2026-07-20")!, mood: 0).mood, 0)
    }

    func testEveryReadOnlyGlyphReadsFiveBandsAndThreeBars() {
        XCTAssertEqual((0...10).map(Scale.moodBand), [1, 1, 3, 3, 5, 5, 5, 7, 7, 9, 9])
        XCTAssertEqual((0...10).map(Scale.energyBars), [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3])
    }

    func testAPageRoundTripsThroughTheWireShapeTheBackendSends() throws {
        let wire = Data("""
        {"day":"2026-07-20","body":"a line","mood":3,"energy":2,"source":"spoken",
         "stamp":"1753400000000:4:d-ab12","updatedAt":1753400000123}
        """.utf8)
        let page = try JSONDecoder().decode(Page.self, from: wire)

        XCTAssertEqual(page.day.iso, "2026-07-20")
        XCTAssertEqual(page.body, "a line")
        XCTAssertEqual(page.mood, 3)
        XCTAssertEqual(page.energy, 2)
        XCTAssertEqual(page.source, .spoken)
        XCTAssertEqual(page.stamp.description, "1753400000000:4:d-ab12")
        XCTAssertEqual(page.updatedAtMs, 1_753_400_000_123)

        let again = try JSONDecoder().decode(Page.self, from: JSONEncoder().encode(page))
        XCTAssertEqual(again, page)
    }

    func testAnAnsweredZeroIsNotAnAbsentScale() throws {
        let zeros = try JSONDecoder().decode(Page.self, from: Data(#"{"day":"2026-07-20","mood":0,"energy":0}"#.utf8))
        XCTAssertEqual(zeros.mood, 0)
        XCTAssertEqual(zeros.energy, 0)

        let nulls = try JSONDecoder().decode(Page.self, from: Data(#"{"day":"2026-07-20","mood":null,"energy":null}"#.utf8))
        XCTAssertEqual(nulls.mood, nil)
        XCTAssertEqual(nulls.energy, nil)

        let outOfRange = try JSONDecoder().decode(Page.self, from: Data(#"{"day":"2026-07-20","mood":11,"energy":-2}"#.utf8))
        XCTAssertEqual(outOfRange.mood, nil, "out of range narrows to unset rather than being rejected")
        XCTAssertEqual(outOfRange.energy, nil)

        let again = try JSONDecoder().decode(Page.self, from: JSONEncoder().encode(zeros))
        XCTAssertEqual(again, zeros)
    }

    // The pinned rule is narrow, never reject, and it has to hold at the container: a decimal, a string
    // or a bool throws inside `decodeIfPresent` before `Scale.narrow` is ever reached, and one throw here
    // costs the reader the whole document rather than the one scale.
    func testEveryShapeThatIsNotAWholeScaleNarrowsToUnansweredRatherThanThrowing() throws {
        for shape in ["3.5", "-0.5", "10.5", "true", "false", "\"5\"", "\"\"", "[]", "{}", "1e400"] {
            let wire = Data(#"{"day":"2026-07-20","body":"kept","mood":\#(shape),"energy":\#(shape)}"#.utf8)
            let page = try JSONDecoder().decode(Page.self, from: wire)
            XCTAssertEqual(page.mood, nil, "mood \(shape) narrows to unanswered")
            XCTAssertEqual(page.energy, nil, "energy \(shape) narrows to unanswered")
            XCTAssertEqual(page.body, "kept", "and the rest of the page is still delivered")
        }
    }

    func testOneBadScaleInAListCostsThatScaleAndNothingElse() throws {
        let wire = Data("""
        {"pages":[{"day":"2026-07-18","body":"first","mood":4},
                  {"day":"2026-07-19","body":"second","mood":3.5},
                  {"day":"2026-07-20","body":"third","mood":7}]}
        """.utf8)
        struct Pages: Decodable { let pages: [Page] }

        let pages = try JSONDecoder().decode(Pages.self, from: wire).pages

        XCTAssertEqual(pages.map(\.body), ["first", "second", "third"],
                       "a bad scale must not empty the canvas")
        XCTAssertEqual(pages.map(\.mood), [4, nil, 7])
    }

    func testASparsePageDecodesToItsDefaults() throws {
        let page = try JSONDecoder().decode(Page.self, from: Data(#"{"day":"2026-07-20"}"#.utf8))
        XCTAssertEqual(page.body, "")
        XCTAssertEqual(page.mood, nil)
        XCTAssertEqual(page.source, .typed)
        XCTAssertEqual(page.stamp, .zero)
        XCTAssertFalse(page.isWritten)
    }

    func testWordCountIgnoresRunsOfWhitespaceAndNewlines() {
        let page = Page(day: LocalDay(iso: "2026-07-20")!, body: "  two\n\n  words   ")
        XCTAssertEqual(page.wordCount, 2)
        XCTAssertEqual(Page(day: LocalDay(iso: "2026-07-20")!, body: "   ").wordCount, 0)
    }
}
