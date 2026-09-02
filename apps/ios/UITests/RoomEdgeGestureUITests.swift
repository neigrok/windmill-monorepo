import XCTest

// The leading 20pt is claimed twice: by the shell's hand-rolled swipe home, and by the system's
// interactive pop inside a room that has pushed a screen. Depth arbitrates — home at the room's root,
// back below it — and nothing but a real touch on a real simulator can say whether the two coexist.
//
// The app is launched through the argument domain rather than a test-only door: `-key value` lands in
// `NSArgumentDomain`, which `UserDefaults.standard` reads first, so `Journey` comes up already asked
// and already standing in the room the test wants.
final class RoomEdgeGestureUITests: XCTestCase {
    private var app: XCUIApplication!

    private let coachTab = "Coach"
    private let settingsDoor = "Gym settings"
    // The settings screen is named by its bar and by nothing else, so "it is up" is read off the
    // Units footer, which every account draws (an lb account draws a longer one that starts the same).
    private let settingsMark = "Display only — nothing stored changes."
    private var settingsUp: XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", settingsMark)).firstMatch
    }
    private let capsule = "Switch app"

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        app?.terminate()
        app = nil
    }

    private func launch(into room: String) {
        app = XCUIApplication()
        app.launchArguments = ["-windmill.journey.asked", "YES", "-windmill.journey.lastRoom", room]
        app.launch()
    }

    // From x = 2 — inside the shell's 20pt band and inside the system's screen-edge band — to well past
    // both thresholds (the shell wants 90pt; the navigation controller wants half the width).
    //
    // The velocity is PINNED rather than left at `.default`, and the hold is long enough to settle,
    // because both recognisers decide on distance AND velocity: `.default` is 1000pt/s and a 0.1s
    // hold does not always decay UIKit's smoothed reading below its completion threshold, so the same
    // 140pt stroke sometimes finished a pop it should have abandoned. A test that does not pin the
    // velocity goes red on green code.
    private func swipeFromTheLeadingEdge(to end: CGFloat = 330,
                                         speed: XCUIGestureVelocity = XCUIGestureVelocity(600),
                                         settlingFor hold: TimeInterval = 0.2) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let from = origin.withOffset(CGVector(dx: 2, dy: 420))
        let to = origin.withOffset(CGVector(dx: end, dy: 420))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: speed, thenHoldForDuration: hold)
    }

    private func pushGymSettings() {
        let door = app.buttons[settingsDoor]
        XCTAssertTrue(door.waitForExistence(timeout: 20), "the routines home never drew its settings door")
        if !door.isHittable { app.swipeUp() }
        door.tap()
        XCTAssertTrue(settingsUp.waitForExistence(timeout: 10),
                      "the settings screen never pushed")
    }

    // Depth 1: the edge is the room's back. The pushed screen pops and the room stays open.
    func testTheLeadingEdgePopsThePushedScreenAndDoesNotLeaveTheRoom() {
        launch(into: "gym")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 20), "the gym room never opened")

        pushGymSettings()
        swipeFromTheLeadingEdge()

        XCTAssertTrue(settingsUp.waitForNonExistence(timeout: 10),
                      "the pushed screen did not pop — the shell's swipe took the edge")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 10),
                      "the room went home instead of popping one screen")
        XCTAssertTrue(app.buttons[settingsDoor].waitForExistence(timeout: 10),
                      "the pop did not land back on the routines home")
    }

    // The half-swipe is where the two claims actually collide. 140pt clears the shell's 90pt but not the
    // navigation controller's half-width, so the pop cancels and the screen slides back — and an
    // attached shell gesture would read the same 140pt as "go home" and throw the lifter out of the room
    // on a back gesture they abandoned. Nothing may move.
    func testAnAbandonedBackGestureLeavesBothTheScreenAndTheRoomWhereTheyWere() {
        launch(into: "gym")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 20), "the gym room never opened")

        pushGymSettings()
        // Slow, and held at the end: 140pt is under the navigation controller's half-width, so with
        // the velocity pinned down there is nothing left to finish the pop with.
        swipeFromTheLeadingEdge(to: 140, speed: XCUIGestureVelocity(150), settlingFor: 0.6)

        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 10),
                      "an abandoned back gesture left the room")
        XCTAssertTrue(settingsUp.exists,
                      "an abandoned back gesture popped the screen anyway")
    }

    // The band beside the tab bar is where the shell's gesture was alone and unopposed under the
    // hand-rolled rail, which is why it has to be UNATTACHED at depth rather than merely outvoted. A
    // real tab bar changes only who ELSE is there: the navigation controller's view runs behind it, so
    // the stroke reads as back rather than as nothing. Either way the invariant is the room's — a
    // screen is pushed, and no stroke from the leading edge may leave the room.
    func testTheLeadingEdgeBesideTheTabBarDoesNotLeaveTheRoom() {
        launch(into: "gym")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 20), "the gym room never opened")

        pushGymSettings()

        let beside = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.92))
        beside.withOffset(CGVector(dx: 2, dy: 0))
            .press(forDuration: 0.05, thenDragTo: beside.withOffset(CGVector(dx: 330, dy: 0)),
                   withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: 0.2)

        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 10),
                      "a swipe beside the tab bar left the room while a screen was pushed")
        XCTAssertTrue(app.buttons[settingsDoor].waitForExistence(timeout: 10),
                      "the room is not standing on the routines home the pop should have landed on")
    }

    // Depth 0: the same touch, and now it is the way home. The room unmounts and the hub takes the tap.
    func testTheLeadingEdgeAtTheRoomsRootGoesHome() {
        launch(into: "gym")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 20), "the gym room never opened")

        swipeFromTheLeadingEdge()

        XCTAssertTrue(app.buttons[coachTab].waitForNonExistence(timeout: 10),
                      "the leading edge at the root did not go home")

        let gymDoor = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Gym")).firstMatch
        XCTAssertTrue(gymDoor.waitForExistence(timeout: 10), "the hub is not what the room left behind")
        gymDoor.tap()
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 10), "the hub's gym door did not open")
    }

    // Both meanings in one run, in order, on one launch: pop, then home.
    func testTheEdgePopsFirstAndOnlyThenGoesHome() {
        launch(into: "gym")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 20), "the gym room never opened")

        pushGymSettings()
        swipeFromTheLeadingEdge()
        XCTAssertTrue(settingsUp.waitForNonExistence(timeout: 10), "the push did not pop")
        XCTAssertTrue(app.buttons[coachTab].exists, "popping one screen also left the room")

        swipeFromTheLeadingEdge()
        XCTAssertTrue(app.buttons[coachTab].waitForNonExistence(timeout: 10),
                      "the second swipe, now at the root, did not go home")
    }

    // `hostsTopChrome`: gym seats the capsule in its own bar, so the shell lays none over it — one
    // capsule on screen, and it is in the room's navigation bar.
    func testTheGymRoomSeatsTheCapsuleInItsOwnBar() {
        launch(into: "gym")
        XCTAssertTrue(app.buttons[coachTab].waitForExistence(timeout: 20), "the gym room never opened")

        XCTAssertTrue(app.navigationBars.buttons[capsule].waitForExistence(timeout: 10),
                      "the room's own bar has no capsule")
        XCTAssertEqual(app.buttons.matching(identifier: capsule).count, 1,
                       "the shell laid a second capsule over a room that hosts its own top chrome")
        XCTAssertTrue(app.navigationBars.buttons["You"].exists, "the You seat is not in the room's bar")
    }

    // A room that does not host its own top chrome is unchanged: the shell's inset still carries the
    // capsule, and it is not in any navigation bar.
    func testARoomWithoutItsOwnTopChromeStillTakesTheShellCapsule() {
        launch(into: "journal")
        let shellCapsule = app.buttons[capsule]
        XCTAssertTrue(shellCapsule.waitForExistence(timeout: 20), "the shell drew no capsule over the room")
        XCTAssertFalse(app.navigationBars.buttons[capsule].exists,
                       "the capsule is in a navigation bar, so the room is hosting its own top chrome")
    }
}
