import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// A card is a door, and what is behind it is the routine's own screen. That is a claim about LAYOUT —
// the only way to tell a card that redraws its routine from one that does not is to lay both out and
// measure them. Text cannot be read back out of a hosted SwiftUI view (no accessibility client runs
// under `xcodebuild test`, and `accessibilityElementCount()` answers 0), so these are heights and
// pixels: a card whose height is the same for one movement and for five draws neither of them.
@MainActor
final class RoutineScreensHostingTests: XCTestCase {
    private var stem: URL!
    // A second shelf, because the device's own copy is written to disk: two stores over one stem are
    // one device, and the second would open on the first's program.
    private var spare: URL!

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("routine-host-\(UUID().uuidString)")
        spare = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("routine-host-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for shelf in [stem, spare] {
            for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
                try? FileManager.default.removeItem(at: shelf!.appendingPathExtension(ext))
            }
        }
    }

    private func makeStore(sync: any TrainingSyncing, on shelf: URL? = nil) -> TrainingStore {
        let stem = shelf ?? self.stem!
        return TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                             deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                             accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                             localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                             bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                             undoWindowMs: 0,
                             sync: { _ in sync })
    }

    private let seat = Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                               user: User(id: "u1", email: "u1@example.com", name: "Sam"))

    // Open lines throughout: an open row's target column is `inkFaint`, so no accent ink but the
    // primary's own ground is drawn on either screen.
    private func routine(movements: Int) -> Routine {
        Routine(id: "rt_1", name: "Push A", position: 0, lastTrainedAtMs: 1_754_312_040_000,
                entries: (1...movements).map { RoutineEntry(position: $0, exerciseId: "movement-\($0)") })
    }

    private func settledProposal(_ id: String) -> Proposal {
        Proposal(head: ProposalHead(id: id, routineId: "rt_1", state: .applied, summary: "Heavier triples.",
                                    changeCount: 1, createdAtMs: 5_000, settledAtMs: 6_000,
                                    source: ProposalSource(door: "mcp", agent: "Claude")),
                 baseRevision: 1, baseName: "Push A", name: "Push A", changes: [])
    }

    private func served(movements: Int, settled: Int) async -> (TrainingStore, FakeTraining) {
        let server = FakeTraining()
        server.written["rt_1"] = routine(movements: movements)
        server.revisions["rt_1"] = 1
        server.ledger = (0..<settled).map { settledProposal("prop_\($0)") }
        let store = makeStore(sync: server)
        await store.connect(to: seat)
        return (store, server)
    }

    private func pump(_ turns: Int) async {
        for _ in 0..<turns {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func hosted(_ view: some View, height: CGFloat) async -> UIWindow {
        let controller = UIHostingController(rootView: view.environment(\.gymSkin, GymSkin.instrument)
                                                          .environment(\.colorScheme, .dark))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: height))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        await pump(30)
        return window
    }

    private func home(_ store: TrainingStore) -> some View {
        RoutinesScreen(store: store, isSignedIn: true, undecided: [], onOpen: { _ in },
                       onDelete: { _ in }, onNew: {}, onStartLogging: {}, onProposal: { _ in },
                       onSettings: {}, onSignIn: {})
    }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let found = view as? UIScrollView { return found }
        for child in view.subviews {
            if let found = scrollView(in: child) { return found }
        }
        return nil
    }

    private func contentHeight(of window: UIWindow) throws -> CGFloat {
        try XCTUnwrap(scrollView(in: window)).contentSize.height
    }

    // ── the card is a door ─────────────────────────────────────────────────────────────────────

    func testTheRoutinesHomeIsTheSameHeightForOneMovementAndForFive() async throws {
        let (one, _) = await served(movements: 1, settled: 0)
        let short = await hosted(home(one), height: 900)
        let shortHeight = try contentHeight(of: short)
        short.isHidden = true

        let (five, _) = await served(movements: 5, settled: 0)
        let long = await hosted(home(five), height: 900)
        let longHeight = try contentHeight(of: long)
        long.isHidden = true

        XCTAssertGreaterThan(shortHeight, 0, "the home laid nothing out")
        XCTAssertEqual(longHeight, shortHeight,
                       "the card draws one row per movement, so it redraws the screen it is a door to")
    }

    func testTheRoutinesHomeIsTheSameHeightWithFourSettledProposalsAsWithNone() async throws {
        let (quiet, _) = await served(movements: 3, settled: 0)
        let bare = await hosted(home(quiet), height: 900)
        let bareHeight = try contentHeight(of: bare)
        bare.isHidden = true

        let (decided, _) = await served(movements: 3, settled: 4)
        XCTAssertEqual(decided.proposals.filter { !$0.isPending }.count, 4, "the ledger holds no settled proposals")
        let withHistory = await hosted(home(decided), height: 900)
        let historyHeight = try contentHeight(of: withHistory)
        withHistory.isHidden = true

        XCTAssertEqual(historyHeight, bareHeight,
                       "the card draws a History block, heading, rows and `+ N older` included")
    }

    // The other half of the same ruling: the movements a card stopped naming are named one tap deeper.
    func testTheRoutineScreenGrowsWithTheMovementsItNames() async throws {
        let (one, _) = await served(movements: 1, settled: 0)
        let short = await hosted(RoutineScreen(routineId: "rt_1", store: one, onStart: {}, onEdit: { _ in },
                                               onMovement: { _ in }, onProposal: { _ in }, onThread: { _ in }),
                                 height: 900)
        let shortHeight = try contentHeight(of: short)
        short.isHidden = true

        let (five, _) = await served(movements: 5, settled: 0)
        let long = await hosted(RoutineScreen(routineId: "rt_1", store: five, onStart: {}, onEdit: { _ in },
                                              onMovement: { _ in }, onProposal: { _ in }, onThread: { _ in }),
                                height: 900)
        let longHeight = try contentHeight(of: long)
        long.isHidden = true

        XCTAssertGreaterThan(longHeight, shortHeight + 3 * GymTap.minimum,
                             "the routine's own screen does not name every movement it holds")
    }

    // ── the unread history block draws a line and no second primary ────────────────────────────

    // Pixels of `skin.accent` above the reach band. `Start workout` is the screen's one primary and
    // sits in the bottom inset; a `Try again` inside the History block would paint accent-coloured
    // text in the scroll body, and an open row's target column paints `inkFaint`, not accent.
    private func accentPixels(of window: UIWindow, above band: CGFloat) -> Int {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else {
            return 0
        }
        let width = cg.width, perRow = cg.bytesPerRow, perPixel = cg.bitsPerPixel / 8
        let alphaFirst = cg.alphaInfo == .premultipliedFirst || cg.alphaInfo == .first || cg.alphaInfo == .noneSkipFirst
        let bgr = cg.bitmapInfo.contains(.byteOrder32Little)
        var found = 0
        for y in 0..<max(0, cg.height - Int(band)) {
            for x in 0..<width {
                let at = y * perRow + x * perPixel
                let r: Int, g: Int, b: Int
                if bgr { (r, g, b) = (Int(bytes[at + 2]), Int(bytes[at + 1]), Int(bytes[at])) }
                else if alphaFirst { (r, g, b) = (Int(bytes[at + 1]), Int(bytes[at + 2]), Int(bytes[at + 3])) }
                else { (r, g, b) = (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2])) }
                if abs(r - 0x9A) < 4 && abs(g - 0x90) < 4 && abs(b - 0xBE) < 4 { found += 1 }
            }
        }
        return found
    }

    private func outOfReach() async -> TrainingStore {
        let (store, server) = await served(movements: 1, settled: 0)
        // The account copy is held; the log then goes quiet, so the read is `.remembered` and the
        // history block says so.
        server.online = false
        return store
    }

    func testTheUnreadHistoryBlockDrawsItsLineAndNoSecondPrimary() async throws {
        let store = await outOfReach()
        guard case .remembered = await store.routine("rt_1") else {
            return XCTFail("the read did not come off the device's copy")
        }
        let window = await hosted(RoutineScreen(routineId: "rt_1", store: store, onStart: {}, onEdit: { _ in },
                                                onMovement: { _ in }, onProposal: { _ in }, onThread: { _ in }),
                                  height: 900)
        let painted = accentPixels(of: window, above: 120)
        window.isHidden = true

        XCTAssertEqual(painted, 0,
                       "the History block draws accent ink of its own — a `Try again` beside `Start workout`")
    }

    // ── the empty stance is a claim about the program, not about the rows ─────────────────────

    // The sharpest instance of the law on this surface, and the only one that offers an ACT:
    // `Build a routine` is an accent-filled primary the empty stance draws INSIDE the scroll body,
    // and a delete still inside its window may not put it over a program that holds a routine. The
    // reach band's own primary is accent too and sits in the bottom inset, so it is measured out; the
    // two windows are read in one run rather than a pixel count off one machine (ledger `4t`).
    func testAWithheldRoutineDoesNotDrawTheEmptyProgramsPrimary() async throws {
        let (held, _) = await served(movements: 1, settled: 0)
        held.withhold(routine: try XCTUnwrap(held.routines.first, "the program was never served"))
        XCTAssertEqual(held.allRoutines.count, 1, "the account still holds the routine")
        let window = await hosted(home(held), height: 900)
        let paintedWhileHeld = accentPixels(of: window, above: 120)
        window.isHidden = true

        let none = makeStore(sync: FakeTraining(), on: spare)
        await none.connect(to: seat)
        XCTAssertTrue(none.allRoutines.isEmpty, "the empty program is not empty")
        let bare = await hosted(home(none), height: 900)
        let paintedWhenEmpty = accentPixels(of: bare, above: 120)
        bare.isHidden = true

        XCTAssertGreaterThan(paintedWhenEmpty, 0, "an empty program draws no `Build a routine`")
        XCTAssertEqual(paintedWhileHeld, 0,
                       "a routine one Undo away is offered `Build a routine` over a program that holds it")
    }

    // ── the primary is pinned, not scrolled ───────────────────────────────────────────────────

    // `Start workout` left the scroll for a bottom `safeAreaInset`, which is the whole point of the
    // move: it is reachable at every scroll offset, top included (`thumb-reach.md` §3.6). A routine
    // long enough to overrun the window is what makes that testable — inside the scroll the button is
    // below the fold at offset zero.
    func testStartWorkoutIsDrawnAtTheFootOfAScreenTooLongToHoldIt() async throws {
        let (store, _) = await served(movements: 20, settled: 0)
        let window = await hosted(RoutineScreen(routineId: "rt_1", store: store, onStart: {}, onEdit: { _ in },
                                                onMovement: { _ in }, onProposal: { _ in }, onThread: { _ in }),
                                  height: 500)
        let scroll = try XCTUnwrap(scrollView(in: window))
        XCTAssertGreaterThan(scroll.contentSize.height, scroll.bounds.height,
                             "twenty movements fit the window, so nothing here is being scrolled past")
        let atTheTop = try XCTUnwrap(band(of: 0x9A90BE, in: window), "`Start workout` is not drawn at the top")
        XCTAssertGreaterThan(atTheTop.last - atTheTop.first, 40, "only a sliver of the primary is drawn")
        XCTAssertGreaterThan(atTheTop.last, 460, "the primary is not at the foot of the 500pt window")

        scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentSize.height - scroll.bounds.height), animated: false)
        await pump(20)
        let atTheEnd = try XCTUnwrap(band(of: 0x9A90BE, in: window), "`Start workout` scrolled away")
        window.isHidden = true

        XCTAssertEqual(atTheEnd.first, atTheTop.first, "the primary moved when the body scrolled")
        XCTAssertEqual(atTheEnd.last, atTheTop.last)
    }

    // ── which ink a refusal takes ─────────────────────────────────────────────────────────────

    // The alarm ink is for a write that failed and for nothing else (`GymSkin`). A draft that is not
    // finished is not one — nothing was sent and nothing was refused — so `Name it to save it.` takes
    // the faint ink, and the editor paints no alarm at all until the log actually turns a save down.
    // Three windows, because zero alarm pixels alone would also be true of a footer nobody draws: the
    // named draft is the height the unnamed one has to beat for the sentence to be on the glass.
    func testAnUnfinishedDraftPaintsNoAlarmInkAndASaveTheLogRefusedStillDoes() async throws {
        let unnamed = await hosted(editor(name: "", failure: nil), height: 900)
        let quiet = alarmPixels(of: unnamed)
        let refusing = try contentHeight(of: unnamed)
        unnamed.isHidden = true

        let named = await hosted(editor(name: "Push A", failure: nil), height: 900)
        let silent = try contentHeight(of: named)
        named.isHidden = true

        let failed = await hosted(editor(name: "", failure: "the log didn\u{2019}t answer — the routine wasn\u{2019}t saved"),
                                  height: 900)
        let alarmed = alarmPixels(of: failed)
        failed.isHidden = true

        XCTAssertGreaterThan(refusing, silent + 10,
                             "the unnamed draft draws no refusal at all (\(refusing) vs \(silent))")
        XCTAssertEqual(quiet, 0, "a draft that is not finished is not a write that failed")
        XCTAssertGreaterThan(alarmed, 100, "and a save the log refused is still drawn in the alarm ink")
    }

    private func editor(name: String, failure: String?) -> some View {
        RoutineEditorScreen(draft: RoutineDraft(name: name,
                                                entries: [RoutineWrite.Entry(exerciseId: "movement-1")],
                                                position: 0),
                            catalog: [Exercise(id: "movement-1", name: "Back Squat")],
                            sessions: [], editing: false, untested: false, saving: false,
                            failure: failure,
                            onSave: { _ in }, onCancel: {}, onDuplicate: nil,
                            onCreateMovement: { _, _ in .failure(.noAnswer) })
    }

    // The first and last rows of the window holding a pixel of the colour, or nil.
    private func band(of hex: Int, in window: UIWindow) -> (first: Int, last: Int)? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else {
            return nil
        }
        let width = cg.width, perRow = cg.bytesPerRow, perPixel = cg.bitsPerPixel / 8
        let alphaFirst = cg.alphaInfo == .premultipliedFirst || cg.alphaInfo == .first || cg.alphaInfo == .noneSkipFirst
        let bgr = cg.bitmapInfo.contains(.byteOrder32Little)
        var first: Int?
        var last: Int?
        for y in 0..<cg.height {
            for x in 0..<width {
                let at = y * perRow + x * perPixel
                let r: Int, g: Int, b: Int
                if bgr { (r, g, b) = (Int(bytes[at + 2]), Int(bytes[at + 1]), Int(bytes[at])) }
                else if alphaFirst { (r, g, b) = (Int(bytes[at + 1]), Int(bytes[at + 2]), Int(bytes[at + 3])) }
                else { (r, g, b) = (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2])) }
                if abs(r - (hex >> 16 & 0xFF)) < 4 && abs(g - (hex >> 8 & 0xFF)) < 4 && abs(b - (hex & 0xFF)) < 4 {
                    if first == nil { first = y }
                    last = y
                    break
                }
            }
        }
        guard let first, let last else { return nil }
        return (first, last)
    }
}
