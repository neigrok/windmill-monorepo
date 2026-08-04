import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

// The journal's domain: the writer's calendar, and the one rule that decides which of two devices
// wrote the page you end up reading.

final class LocalDayTests: XCTestCase {
    func testOnlyAWellFormedDayIsADay() {
        XCTAssertNotNil(LocalDay(iso: "2026-07-20"))
        for bad in ["2026-7-20", "26-07-20", "2026-13-01", "2026-07-32", "yesterday", ""] {
            XCTAssertNil(LocalDay(iso: bad), "\(bad) is not a day")
        }
    }

    // The ISO shape sorts lexicographically into true date order — the property the canvas relies
    // on to draw oldest-first without parsing anything.
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

    // The window the canvas loads is "today back sixty days", and it must be sixty days whichever
    // side of a month end — and a year end — today falls on.
    func testTheSixtyDayWindowIsSixtyDays() {
        XCTAssertEqual(LocalDay(iso: "2026-01-15")!.advanced(by: -60).iso, "2025-11-16")
        XCTAssertEqual(LocalDay(iso: "2026-03-01")!.advanced(by: -60).iso, "2025-12-31")
    }

    // A day is the device's calendar day, and a page opened at 23:04 or 00:10 is not the same page.
    // Nothing here may drift with the hour.
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

    // The same write arriving twice — by a PUT reply and by a window read — must not look like a
    // change, or the canvas would flicker on every reconnect.
    func testAnIdenticalStampKeepsTheIncumbent() {
        let held = page("2026-07-20", "held", stamp: "100:0:d-a")
        let echo = page("2026-07-20", "echo", stamp: "100:0:d-a")
        XCTAssertEqual(Page.winner(of: echo, and: held).body, "held")
    }

    func testAWrittenDayIsAnyDaySomeoneShowedUpFor() {
        XCTAssertFalse(Page(day: LocalDay(iso: "2026-07-20")!).isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, body: "a line").isWritten)
        // A mood with no words is still a day that was lived, and is still drawn.
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, mood: .m3).isWritten)
        XCTAssertTrue(Page(day: LocalDay(iso: "2026-07-20")!, energy: .e1).isWritten)
    }

    // Out-of-range values clamp to unset: a bad number can only narrow what it says, never invent
    // a mood someone did not choose.
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

    // The backend answers a never-written day with 404, and a sparse page omits fields. Neither is
    // an error the canvas should ever see.
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
