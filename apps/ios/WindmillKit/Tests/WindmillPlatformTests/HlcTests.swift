import XCTest
@testable import WindmillPlatform

final class HlcTests: XCTestCase {
    func testAStampRoundTripsThroughItsWireForm() {
        let stamp = Hlc(milliseconds: 1_753_400_000_000, counter: 7, actor: "d-ab12cd34")
        XCTAssertEqual(stamp.description, "1753400000000:7:d-ab12cd34")
        XCTAssertEqual(Hlc("1753400000000:7:d-ab12cd34"), stamp)
    }

    func testAnActorMayContainColons() {
        let parsed = Hlc("1000:2:d-ab:cd")
        XCTAssertEqual(parsed.milliseconds, 1000)
        XCTAssertEqual(parsed.counter, 2)
        XCTAssertEqual(parsed.actor, "d-ab:cd")
    }

    func testAnUnreadableStampIsZeroAndLosesToEverything() {
        for text in ["", "nonsense", "12:notanumber:d-1", "12:3"] {
            XCTAssertEqual(Hlc(text), .zero, "\(text) should read as the zero stamp")
            XCTAssertLessThan(Hlc(text), Hlc(milliseconds: 1, counter: 0, actor: ""))
        }
    }

    func testOrderingIsMillisecondsThenCounterThenActor() {
        XCTAssertLessThan(Hlc("100:9:z"), Hlc("101:0:a"))
        XCTAssertLessThan(Hlc("100:0:z"), Hlc("100:1:a"))
        XCTAssertLessThan(Hlc("100:0:a"), Hlc("100:0:b"))
    }

    func testTwoStampsInOneMillisecondDifferByTheCounter() {
        let clock = HlcClock(actor: "d-test", now: { 5_000 })
        let first = clock.mint()
        let second = clock.mint()
        XCTAssertEqual(first.milliseconds, second.milliseconds)
        XCTAssertEqual(first.counter, 0)
        XCTAssertEqual(second.counter, 1)
        XCTAssertLessThan(first, second)
    }

    func testAClockThatJumpsBackwardsStillMintsIncreasingStamps() {
        var now: Int64 = 10_000
        let clock = HlcClock(actor: "d-test", now: { now })
        let before = clock.mint()
        now = 3_000
        let after = clock.mint()

        XCTAssertGreaterThan(after, before)
        XCTAssertEqual(after.milliseconds, 10_000, "the last minted millisecond is the floor")
        XCTAssertEqual(after.counter, 1)
    }

    func testEveryStampFromOneClockStrictlyIncreases() {
        var now: Int64 = 0
        let clock = HlcClock(actor: "d-test", now: { now })
        var stamps: [Hlc] = []
        for step in 0..<200 {
            now = Int64(step % 7) * 1_000
            stamps.append(clock.mint())
        }
        for (earlier, later) in zip(stamps, stamps.dropFirst()) {
            XCTAssertLessThan(earlier, later)
        }
    }
}
