import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym

// C18 · the window the six are ranked from is cut ONCE and then held for as long as the picker is up.
// The log behind it does not hold still — a claim replays a device's sessions into the account, the
// mirror's poll lands a session that finished elsewhere — and a picker that re-ranked on every one of
// those would reshuffle the six under a thumb already reaching for the third row.
//
// C20 · and the cut is made on the first read that HELD something, not on the first render. An empty
// window is the absence of a cut rather than a cut, so a picker opened in the moment before the log
// answers takes the answer that lands under it — and freezes on that one.
//
// `PickerSixRankingTests` pins WHAT the ranking is; this pins WHEN it is read, which is a property of
// the view rather than of the function, so it is proved by hosting the real picker and moving the log
// underneath it. The twin of web's `useState(() => sessions.slice(0, TRAINED_WINDOW))`.
@MainActor
final class PickerFrozenWindowTests: XCTestCase {

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

    private func session(_ named: [String], at day: Int64) -> SessionSummary {
        SessionSummary(session: Session(id: "s_\(day)", startedAtMs: day * 86_400_000,
                                        finishedAtMs: day * 86_400_000 + 3_600_000),
                       setCount: named.count, exercises: named)
    }

    // A log with two leg-press sessions in it and nothing else: the leg press is the only movement the
    // ranking finds, so it takes the first row and the openers fill the other five. The face pull is
    // then the LAST row of the catalogue below the gap — which is what makes "did the six reshuffle?"
    // answerable by asking whether the face pull sits above the back squat.
    private var settledLog: [SessionSummary] {
        [session(["Leg Press"], at: 2), session(["Leg Press"], at: 1)]
    }

    private func facePullSessions(_ count: Int = 10) -> [SessionSummary] {
        (0..<count).map { session(["Face Pull"], at: Int64(500 - $0)) }
    }

    private func legPressSessions(_ count: Int) -> [SessionSummary] {
        (0..<count).map { session(["Leg Press"], at: Int64(900 - $0)) }
    }

    // The log a screen hands the picker, which keeps changing while the picker stands over it.
    final class MovingLog: ObservableObject {
        @Published var sessions: [SessionSummary]
        init(_ sessions: [SessionSummary]) { self.sessions = sessions }
    }

    struct Harness: View {
        @ObservedObject var log: MovingLog
        let catalog: [Exercise]

        var body: some View {
            MovementPicker(catalog: catalog, taken: [], lastSets: nil, sessions: log.sessions,
                           onPick: { _ in }, onCreate: { _ in }, onClose: {})
                .environment(\.gymSkin, GymSkin.instrument)
                .environment(\.colorScheme, .dark)
        }
    }

    // ── the cut itself ──────────────────────────────────────────────────────────────────────────

    func testTheWindowIsTheNewestFiftySessionsAndNothingBelowThem() {
        let log = (0..<70).map { session(["Face Pull"], at: Int64(100 - $0)) }
        XCTAssertEqual(PickerOptions.window(of: log).map(\.session.id),
                       log.prefix(PickerOptions.trainedWindow).map(\.session.id))
        XCTAssertEqual(PickerOptions.window(of: log).count, PickerOptions.trainedWindow)
        XCTAssertEqual(PickerOptions.window(of: []).count, 0,
                       "a log-less account carries an empty window, and the openers fill the six")
    }

    // ── the freeze ──────────────────────────────────────────────────────────────────────────────

    // Three renders settle it. The picker opens on a log the leg press tops; ten face-pull sessions
    // then land underneath it; and a SECOND picker is opened on that same moved log. If the six were
    // re-read the first picture would have become the third — so the claim is that picture one equals
    // picture two and differs from picture three, and the third render is what proves the comparison
    // can see a reshuffle at all rather than comparing two screens that drew nothing.
    func testTheSixDoNotReshuffleWhenTheLogMovesUnderAnOpenPicker() async {
        let log = MovingLog(settledLog)
        let screen = await host(Harness(log: log, catalog: catalog))
        let opened = rendered(screen)

        log.sessions = facePullSessions() + log.sessions
        await settle(screen)
        let afterTheLogMoved = rendered(screen)

        let reopened = rendered(await host(Harness(log: MovingLog(log.sessions), catalog: catalog)))

        XCTAssertNotEqual(opened, reopened,
                          "the moved log ranks the six no differently, so this fixture proves nothing")
        XCTAssertEqual(opened, afterTheLogMoved,
                       "the log moved under an open picker and the six reshuffled under the thumb")
    }

    // ── C20 · the cut is made on the first read that HELD something ─────────────────────────────

    // An empty window is not a cut, it is the absence of one: a picker opened in the moment before the
    // log answers has frozen nothing yet, and a picker that treated that empty window as its answer
    // would show a lifter of a hundred sessions the six generic openers for as long as it stood.
    func testTheWindowReSeedsWhileItIsEmptyAndFreezesOnTheFirstReadThatHeldSomething() {
        let log = facePullSessions(70)
        let cut = PickerOptions.window(of: log, held: [])
        XCTAssertEqual(cut.map(\.session.id), log.prefix(PickerOptions.trainedWindow).map(\.session.id),
                       "an unfrozen picker did not take the newest fifty of the answer that landed")
        XCTAssertEqual(PickerOptions.window(of: log, held: []).count, PickerOptions.trainedWindow)
        XCTAssertEqual(PickerOptions.window(of: [], held: []).count, 0,
                       "no answer has landed yet, so nothing is frozen and the openers fill the six")

        let held = PickerOptions.window(of: settledLog, held: [])
        XCTAssertEqual(PickerOptions.window(of: log, held: held).map(\.session.id),
                       held.map(\.session.id),
                       "the window moved after it had already been cut")
        XCTAssertEqual(PickerOptions.window(of: [], held: held).map(\.session.id),
                       held.map(\.session.id),
                       "a log that emptied underneath an open picker un-froze it")
    }

    // And what that re-seed is worth, said in movements rather than in sessions: the window a picker
    // opens with before the log answers ranks nothing, so the six are the generic openers — and the
    // window taken from the answer ranks the answer.
    func testAWindowTakenAfterTheLogAnsweredRanksTheLogRatherThanTheOpeners() {
        let unanswered = PickerOptions.window(of: [], held: [])
        XCTAssertEqual(PickerOptions.mostTrained(available: catalog, sessions: unanswered).map(\.id),
                       PickerOptions.openers,
                       "nothing has been read yet, so the six are the openers in their own order")

        let answered = PickerOptions.window(of: facePullSessions(60), held: unanswered)
        XCTAssertEqual(answered.count, PickerOptions.trainedWindow)
        XCTAssertEqual(PickerOptions.mostTrained(available: catalog, sessions: answered).map(\.id),
                       ["face-pull"] + PickerOptions.openers.dropLast(),
                       "sixty sessions landed and the six still open on the generic list")
    }

    // The same rule where it is actually felt: three renders of ONE picker. It opens on a log that has
    // not answered, sixty sessions land under it, ten more land after that — and the claim is that
    // picture one differs from picture two, which is the answer being taken, while picture three equals
    // picture two, which is the freeze. A fourth picker, opened on the moved log, is what proves the
    // third comparison could have seen a reshuffle at all.
    //
    // Every EQUALITY here is asked of one window across time, never of two windows: two windows drawing
    // the same state render the same size and not the same bytes, so `==` across them answers nothing.
    // What each picture ranks is `testAWindowTakenAfterTheLogAnsweredRanksTheLogRatherThanTheOpeners`.
    func testAPickerOpenedBeforeTheLogAnsweredTakesThatAnswerAndThenFreezes() async {
        let log = MovingLog([])
        let screen = await host(Harness(log: log, catalog: catalog))
        let beforeTheLogAnswered = rendered(screen)

        log.sessions = facePullSessions(60)
        await settle(screen)
        let afterTheLogAnswered = rendered(screen)

        log.sessions = legPressSessions(10) + log.sessions
        await settle(screen)
        let afterTheLogMovedOn = rendered(screen)

        let openedOnTheMovedLog = rendered(await host(Harness(log: MovingLog(log.sessions),
                                                             catalog: catalog)))

        XCTAssertNotEqual(beforeTheLogAnswered, afterTheLogAnswered,
                          "the log answered underneath the picker and it kept the generic openers")
        XCTAssertNotEqual(afterTheLogAnswered, openedOnTheMovedLog,
                          "the ten that landed after rank the six no differently, so this proves nothing")
        XCTAssertEqual(afterTheLogAnswered, afterTheLogMovedOn,
                       "the window re-seeded a second time, so it never froze at all")
    }

    // Frozen for the life of THIS picker and no longer: the next one opens on the log as it stands.
    func testAPickerOpenedAfterwardsRanksFromTheLogAsItStandsThen() async {
        let settled = rendered(await host(Harness(log: MovingLog(settledLog), catalog: catalog)))
        let moved = rendered(await host(Harness(log: MovingLog(facePullSessions() + settledLog),
                                                catalog: catalog)))

        XCTAssertNotEqual(settled, moved,
                          "a picker opening now ranked from a window it should never have kept")
    }

    // MARK: - hosting

    private func host(_ screen: some View) async -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 900))
        window.rootViewController = UIHostingController(rootView: screen)
        window.makeKeyAndVisible()
        await settle(window)
        return window
    }

    private func settle(_ window: UIWindow) async {
        window.rootViewController?.view.layoutIfNeeded()
        for _ in 0..<30 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
        window.rootViewController?.view.layoutIfNeeded()
    }

    // What reached the glass, as bytes. A hosted SwiftUI view vends no accessibility tree to its own
    // process — nothing has asked for one — so the readout is the render itself, and the ordering
    // question is answered by whether two renders are the same picture.
    private func rendered(_ window: UIWindow) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        guard let bytes = image.cgImage?.dataProvider?.data as Data? else {
            XCTFail("the window rendered nothing at all")
            return Data()
        }
        return bytes
    }
}
