import SwiftUI
import XCTest
@testable import WindmillGym

final class WakeLockTests: XCTestCase {
    func testTheScreenStaysAwakeOnlyWhileTheRoomHoldsAnOpenSessionInTheForeground() {
        XCTAssertTrue(WakeLock.wanted(sessionIsOpen: true, phase: .active))
        XCTAssertFalse(WakeLock.wanted(sessionIsOpen: false, phase: .active))
        XCTAssertFalse(WakeLock.wanted(sessionIsOpen: true, phase: .inactive))
        XCTAssertFalse(WakeLock.wanted(sessionIsOpen: true, phase: .background))
        XCTAssertFalse(WakeLock.wanted(sessionIsOpen: false, phase: .background))
    }
}
