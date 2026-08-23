import XCTest
@testable import WindmillJournal

// The strip's one geometric law: a transient centred on one scale's head never reaches the other
// scale's row. A device found the flare breaking it; arithmetic keeps it broken-proof.
final class ScaleStripTests: XCTestCase {
    func testATransientNeverReachesTheOtherRow() {
        XCTAssertEqual(ScaleMetrics.pitch, 48)
        XCTAssertEqual(ScaleMetrics.transientRadius, 23)
    }

    func testTheFlareRingsLandOnTheClamp() {
        XCTAssertEqual(ScaleMetrics.flareReach, 28)
        let outerRadius = (ScaleKind.mood.headSize.width + ScaleMetrics.flareReach) / 2
        XCTAssertEqual(outerRadius, ScaleMetrics.transientRadius)
        XCTAssertLessThanOrEqual(outerRadius, ScaleMetrics.transientRadius)
    }

    // The held ring is 6px clear of the head's edge, so it clears the focus band and reads as a
    // second mark rather than a thickening of the head's own 1.5px ring.
    func testTheHeldRingSitsSixPixelsClearOfTheHead() {
        let head = ScaleKind.mood.headSize.width
        let path = (head + ScaleMetrics.heldRingClearance) / 2
        XCTAssertEqual(path - head / 2, 6)
    }
}
