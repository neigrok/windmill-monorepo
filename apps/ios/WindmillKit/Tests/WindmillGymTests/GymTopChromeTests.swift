import XCTest
@testable import WindmillGym

// The gym room draws its own bar, so the shell must lay none over it. If this ever goes false the
// capsule is drawn twice and the room loses the toolbar it seats the You seat in.
@MainActor
final class GymTopChromeTests: XCTestCase {
    func testTheGymRoomHostsItsOwnTopChrome() {
        XCTAssertTrue(GymModule().hostsTopChrome)
    }
}
