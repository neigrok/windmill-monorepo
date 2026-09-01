import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

final class LogWeeksTests: XCTestCase {
    private func at(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Int64 {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = hour
        let moment = Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
        return Int64(moment.timeIntervalSince1970 * 1000)
    }

    private func session(_ id: String, at startedAtMs: Int64, routine: String? = nil,
                         working: Int? = nil, tonnageKg: Double? = nil,
                         topE1rm: Double? = nil, record: Bool = false) -> SessionSummary {
        let plan = routine.map { PlanSnapshot(routine: $0, entries: []) }
        return SessionSummary(session: Session(id: id, startedAtMs: startedAtMs,
                                               finishedAtMs: startedAtMs + 3_480_000, plan: plan),
                              setCount: 14,
                              workingSetCount: working, tonnageKg: tonnageKg, topE1rm: topE1rm,
                              record: record)
    }

    func testSessionsFoldIntoWeeksThatStartOnMonday() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 10)),      // Monday
            session("b", at: at(2026, 8, 9)),       // Sunday — the week before
            session("c", at: at(2026, 8, 3)),       // Monday
            session("d", at: at(2026, 7, 28)),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 10))

        XCTAssertEqual(weeks.map(\.label), ["week of 10 Aug", "week of 3 Aug", "week of 27 Jul"])
        XCTAssertEqual(weeks.map { $0.rows.map(\.id) }, [["a"], ["b", "c"], ["d"]])
    }

    func testTheFoldSortsNewestFirstRatherThanTrustingTheOrderItWasGiven() {
        let weeks = LogWeeks.fold([
            session("old", at: at(2026, 8, 3)),
            session("new", at: at(2026, 8, 7)),
            session("mid", at: at(2026, 8, 5)),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks.count, 1)
        XCTAssertEqual(weeks[0].rows.map(\.id), ["new", "mid", "old"])
    }

    func testAWeeksTonnageIsTheSumOfItsSessions() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 7), tonnageKg: 6_100),
            session("b", at: at(2026, 8, 5), tonnageKg: 9_800),
            session("c", at: at(2026, 8, 3), tonnageKg: 1_200),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks.map(\.tonnage), ["17.1 t"])
    }

    func testTheWeekTheServedPageEndsInsideWithholdsItsTonnageUntilTheBottomIsReached() {
        let page = [session("a", at: at(2026, 8, 7), tonnageKg: 6_100),
                    session("b", at: at(2026, 8, 1), tonnageKg: 5_000)]

        let more = LogWeeks.fold(page, deviceOnly: [], reach: .served(oldest: at(2026, 8, 1)),
                                 now: at(2026, 8, 7))
        XCTAssertEqual(more.map(\.tonnage), ["6.1 t", nil])

        let bottom = LogWeeks.fold(page, deviceOnly: [], reach: .whole, now: at(2026, 8, 7))
        XCTAssertEqual(bottom.map(\.tonnage), ["6.1 t", "5.0 t"])
    }

    func testADeviceOnlySessionBelowTheServedPageDoesNotUnsilenceTheWeekAboveIt() {
        let rows = [session("served-new", at: at(2026, 8, 7), tonnageKg: 5_000),
                    session("served-old", at: at(2026, 8, 5), tonnageKg: 1_000),
                    session("local", at: at(2026, 7, 20), tonnageKg: 6_000)]

        let weeks = LogWeeks.fold(rows, deviceOnly: ["local"],
                                  reach: .served(oldest: at(2026, 8, 5)), now: at(2026, 8, 10))

        XCTAssertEqual(weeks.map(\.label), ["week of 3 Aug", "week of 20 Jul"])
        XCTAssertEqual(weeks.map(\.tonnage), [nil, nil],
                       "the served page ended inside week of 3 Aug — it may not caption itself, and "
                       + "nothing older than it may either")
        XCTAssertEqual(LogWeeks.fold(rows, deviceOnly: ["local"], reach: .whole,
                                     now: at(2026, 8, 10)).map(\.tonnage), ["6.0 t", "6.0 t"])
    }

    func testAScreenHoldingOnlyDeviceSessionsCaptionsNoWeekUntilTheLogHasAnswered() {
        let weeks = LogWeeks.fold([session("local", at: at(2026, 8, 7), tonnageKg: 6_100)],
                                  deviceOnly: ["local"], reach: .served(oldest: nil),
                                  now: at(2026, 8, 7))

        XCTAssertEqual(weeks.map(\.tonnage), [nil])
    }

    func testTheHeadStatesNoCountBeforeTheFirstReadHasAnswered() {
        XCTAssertEqual(LogWeeks.loaded(sessions: 0, weeks: 0), nil)
        XCTAssertEqual(LogWeeks.loaded(sessions: 1, weeks: 1), "1 session · 1 week loaded")
        XCTAssertEqual(LogWeeks.loaded(sessions: 41, weeks: 12), "41 sessions · 12 weeks loaded")
    }

    func testAWeekHoldingASessionWithNoTonnageSaysNothingAboutItsOwn() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 7), tonnageKg: 6_100),
            session("b", at: at(2026, 8, 5)),
        ], deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks.map(\.tonnage), [nil])
    }

    func testAWeekThatMovedNoExternalLoadDrawsNothingRatherThanAZero() {
        let weeks = LogWeeks.fold([session("a", at: at(2026, 8, 7), working: 12, tonnageKg: 0)],
                                  deviceOnly: [], reach: .whole, now: at(2026, 8, 7))

        XCTAssertEqual(weeks[0].tonnage, nil)
        XCTAssertEqual(weeks[0].rows[0].tonnage, nil)
        XCTAssertEqual(weeks[0].rows[0].working, "12 working")
    }

    func testARowStatesWhatItHasAndDrawsNothingWhereTheWireSaidNothing() {
        let weeks = LogWeeks.fold([
            session("a", at: at(2026, 8, 7), routine: "Pull A",
                    working: 14, tonnageKg: 6_100, topE1rm: 141),
            session("b", at: at(2026, 8, 5), working: 16, tonnageKg: 9_800),
        ], deviceOnly: ["b"], reach: .whole, now: at(2026, 8, 10))

        let served = weeks[0].rows[0]
        XCTAssertEqual(served.title, "Pull A")
        XCTAssertEqual(served.when, "Fri 7 Aug")
        XCTAssertEqual(served.working, "14 working")
        XCTAssertEqual(served.tonnage, "6.1 t")
        XCTAssertEqual(served.e1rm, "e1RM 141")
        XCTAssertFalse(served.deviceOnly)

        let unclaimed = weeks[0].rows[1]
        XCTAssertEqual(unclaimed.title, "Session · no routine")
        XCTAssertEqual(unclaimed.e1rm, nil, "no Epley is computed on this device")
        XCTAssertTrue(unclaimed.deviceOnly, "the hollow ring is real on this surface — draw it")
    }

    func testARowCarriesTheClockOnlyWhileItIsStillToday() {
        XCTAssertEqual(LogWeeks.Row.when(at(2026, 8, 10, hour: 18), now: at(2026, 8, 10, hour: 21)),
                       "today · 18:00")
        XCTAssertEqual(LogWeeks.Row.when(at(2026, 8, 7, hour: 18), now: at(2026, 8, 10, hour: 1)),
                       "Fri 7 Aug")
        XCTAssertEqual(LogWeeks.Row.when(at(2026, 8, 9, hour: 23), now: at(2026, 8, 10, hour: 1)),
                       "Sun 9 Aug")
    }

    func testARowWearsTheGoldDotOnlyWhenTheLogSaysARecordHappenedInIt() {
        let weeks = LogWeeks.fold([
            session("pr", at: at(2026, 8, 10, hour: 18), record: true),
            session("ordinary", at: at(2026, 8, 10, hour: 8)),
            session("mine", at: at(2026, 8, 10, hour: 6)),
        ], deviceOnly: ["mine"], reach: .whole, now: at(2026, 8, 10, hour: 21))

        XCTAssertEqual(weeks[0].rows.map(\.record), [true, false, false])
        XCTAssertEqual(weeks[0].rows.map(\.deviceOnly), [false, false, true])
    }

    func testAnEmptyLogFoldsIntoNoWeeksAtAll() {
        XCTAssertEqual(LogWeeks.fold([], deviceOnly: [], reach: .whole, now: at(2026, 8, 10)), [])
    }
}

// The empty stance is a claim about the log the ACCOUNT holds, and only a screen that has been laid
// out can be asked whether it drew one. Text cannot be read back out of a hosted SwiftUI view (no
// accessibility client runs under `xcodebuild test`), so this is the instrument
// `RoutineScreensHostingTests` uses: `No sessions yet.` is a block with a height, and a log that
// draws it is taller than the same log without it.
@MainActor
final class LogScreenHostingTests: XCTestCase {
    private var stem: URL!
    // A second shelf: the device's own log is written to disk, so two stores over one stem are one
    // device and the empty one would open on the other's session.
    private var spare: URL!

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("log-host-\(UUID().uuidString)")
        spare = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("log-host-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for shelf in [stem, spare] {
            for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
                try? FileManager.default.removeItem(at: shelf!.appendingPathExtension(ext))
            }
        }
    }

    // Signed out on purpose: it is the seat gym opens on, and the one where a discard never asks the
    // log, so the settle has only the store's own line to leave the read by.
    private func makeStore(on shelf: URL) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: shelf.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: shelf.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: shelf.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: shelf.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: shelf.appendingPathExtension("bodyweight.json")),
                      undoWindowMs: 0,
                      sync: { _ in nil })
    }

    private let seat = Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!,
                                                credential: { nil }), user: nil)

    private func logged(on shelf: URL) async throws -> (TrainingStore, String) {
        let store = makeStore(on: shelf)
        await store.connect(to: seat)
        guard case .success(let opened) = await store.start() else {
            throw XCTSkip("the session never opened on this device")
        }
        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        guard case .closed = await store.finish() else {
            throw XCTSkip("the session never closed")
        }
        return (store, opened.id)
    }

    private func screen(_ store: TrainingStore) -> some View {
        LogScreen(store: store, onOpen: { _ in }, onBodyweight: {},
                  share: { _ in CoachDoors(base: URL(string: "https://windmill.works")!,
                                           mint: { .failure(.noAnswer) }, revoke: { nil }) },
                  discard: { _ in }, say: { _ in })
    }

    private func height(of store: TrainingStore) async throws -> CGFloat {
        let controller = UIHostingController(rootView: screen(store).environment(\.gymSkin, GymSkin.instrument)
                                                                    .environment(\.colorScheme, .dark))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 900))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        for _ in 0..<30 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
        defer { window.isHidden = true }
        return try XCTUnwrap(scrollView(in: window)).contentSize.height
    }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let found = view as? UIScrollView { return found }
        for child in view.subviews {
            if let found = scrollView(in: child) { return found }
        }
        return nil
    }

    // Both directions of the one law, measured rather than read: the window takes the row and leaves
    // the stance alone, and the settle brings the stance on. A log drawing neither its rows nor its
    // words is the failure this pins — `No sessions yet.` over a session one Undo away is the other.
    func testTheEmptyStanceFollowsTheLogTheAccountHoldsAndNotTheDrawnRows() async throws {
        let (held, sessionId) = try await logged(on: stem)
        held.withhold(session: sessionId)
        XCTAssertTrue(held.recent.isEmpty, "the row is out of the drawn log")
        XCTAssertEqual(held.allSessions.count, 1, "and the account still holds the session")
        let whileHeld = try await height(of: held)

        let none = makeStore(on: spare)
        await none.connect(to: seat)
        XCTAssertTrue(none.allSessions.isEmpty, "the empty log is not empty")
        let whenEmpty = try await height(of: none)

        XCTAssertGreaterThan(whileHeld, 0, "the log laid nothing out")
        XCTAssertGreaterThan(whenEmpty, whileHeld + 60,
                             "`No sessions yet.` is drawn over a log the account still holds one for")

        let went = await held.settleDelete(session: sessionId)
        XCTAssertTrue(went)
        let whenSettled = try await height(of: held)

        XCTAssertEqual(whenSettled, whenEmpty,
                       "the delete landed, so the words arrive — a log with no rows and no stance is a blank page")
    }
}
