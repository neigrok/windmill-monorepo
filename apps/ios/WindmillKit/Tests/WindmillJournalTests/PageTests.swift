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
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, mood: .m3).isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, energy: .e1).isWritten)
    }

    func testOutOfRangeScalesClampToUnset() {
        XCTAssertEqual(Mood(clamping: 9), .none)
        XCTAssertEqual(Mood(clamping: -1), .none)
        XCTAssertEqual(Mood(clamping: 5), .m5)
        XCTAssertEqual(Energy(clamping: 4), .none)
        XCTAssertEqual(Energy(clamping: 3), .e3)
    }

    func testAPageRoundTripsThroughTheWireShapeTheBackendSends() throws {
        let wire = Data("""
        {"day":"2026-07-20","body":"a line","mood":3,"energy":2,"source":"spoken",
         "stamp":"1753400000000:4:d-ab12","updatedAt":1753400000123}
        """.utf8)
        let page = try JSONDecoder().decode(Page.self, from: wire)

        XCTAssertEqual(page.day.iso, "2026-07-20")
        XCTAssertEqual(page.body, "a line")
        XCTAssertEqual(page.mood, .m3)
        XCTAssertEqual(page.energy, .e2)
        XCTAssertEqual(page.source, .spoken)
        XCTAssertEqual(page.stamp.description, "1753400000000:4:d-ab12")
        XCTAssertEqual(page.updatedAtMs, 1_753_400_000_123)

        let again = try JSONDecoder().decode(Page.self, from: JSONEncoder().encode(page))
        XCTAssertEqual(again, page)
    }

    func testASparsePageDecodesToItsDefaults() throws {
        let page = try JSONDecoder().decode(Page.self, from: Data(#"{"day":"2026-07-20"}"#.utf8))
        XCTAssertEqual(page.body, "")
        XCTAssertEqual(page.mood, .none)
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
