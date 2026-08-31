import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The gate is layout, so it is proved by hosting the real sheet in a window and reading the Apply button's ground off
// a rendered snapshot: enabled draws `skin.accent`, disabled draws `skin.raised`. A pure test of `ReviewGate` cannot
// go red when the plumbing that feeds it is dead.
@MainActor
final class ReviewSheetHostingTests: XCTestCase {
    private var stem: URL!

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("review-host-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
            try? FileManager.default.removeItem(at: stem.appendingPathExtension(ext))
        }
    }

    private func makeStore(sync: any TrainingSyncing) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                      undoWindowMs: 0,
                      sync: { _ in sync })
    }

    private func proposal(rows: Int) -> Proposal {
        let changes = (1...rows).map { position in
            ProposalChange(position: position, kind: .retargeted, exerciseId: "movement-\(position)",
                           before: ProposalChange.Targets(sets: 5, reps: 5, weightKg: 80),
                           after: ProposalChange.Targets(sets: 5, reps: 3, weightKg: 90))
        }
        return Proposal(head: ProposalHead(id: "prop_1", routineId: "rt_1", summary: "Heavier triples.",
                                           changeCount: rows, createdAtMs: 1, source: ProposalSource(door: "ask")),
                        baseRevision: 1, baseName: "Push A", name: "Push A", changes: changes)
    }

    private struct Counts: CustomStringConvertible {
        var accent = 0
        var raised = 0
        var description: String { "accent \(accent) · raised \(raised)" }
    }

    // Pixels in the bottom `strip` points of the window, by colour class.
    private func bandColours(of window: UIWindow, strip: CGFloat) -> Counts {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else {
            return Counts()
        }
        let width = cg.width, height = cg.height, perRow = cg.bytesPerRow, perPixel = cg.bitsPerPixel / 8
        let alphaFirst = cg.alphaInfo == .premultipliedFirst || cg.alphaInfo == .first || cg.alphaInfo == .noneSkipFirst
        let bgr = cg.bitmapInfo.contains(.byteOrder32Little)
        var counts = Counts()
        func near(_ r: Int, _ g: Int, _ b: Int, _ hex: Int) -> Bool {
            abs(r - (hex >> 16 & 0xFF)) < 4 && abs(g - (hex >> 8 & 0xFF)) < 4 && abs(b - (hex & 0xFF)) < 4
        }
        for y in max(0, height - Int(strip))..<height {
            for x in 0..<width {
                let at = y * perRow + x * perPixel
                let r: Int, g: Int, b: Int
                if bgr { (r, g, b) = (Int(bytes[at + 2]), Int(bytes[at + 1]), Int(bytes[at])) }
                else if alphaFirst { (r, g, b) = (Int(bytes[at + 1]), Int(bytes[at + 2]), Int(bytes[at + 3])) }
                else { (r, g, b) = (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2])) }
                if near(r, g, b, 0x9A90BE) { counts.accent += 1 }
                if near(r, g, b, 0x2E2B32) { counts.raised += 1 }
            }
        }
        return counts
    }

    // Suspending on the main actor lets the main run loop lay out and draw between turns.
    private func pump(_ turns: Int) async {
        for _ in 0..<turns {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func host(rows: Int, height: CGFloat, slow: Bool = false) async -> UIWindow {
        let server = FakeTraining()
        server.written["rt_1"] = Routine(id: "rt_1", name: "Push A", position: 0, entries: [])
        server.ledger = [proposal(rows: rows)]
        let store = makeStore(sync: slow ? SlowProposalTraining(server) : server)
        await store.connect(to: Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                                        user: User(id: "u1", email: "u1@example.com", name: "u1")))
        let sheet = ReviewSheet(proposalId: "prop_1", store: store, onSettled: { _ in }, onClosed: { _ in }, say: { _ in })
            .environment(\.gymSkin, GymSkin.instrument)
            .environment(\.colorScheme, .dark)
        let controller = UIHostingController(rootView: sheet)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: height))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        await pump(30)
        return window
    }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let found = view as? UIScrollView { return found }
        for child in view.subviews {
            if let found = scrollView(in: child) { return found }
        }
        return nil
    }

    func testAShortDiffOpensApplyAtOnce() async {
        let window = await host(rows: 1, height: 800)
        let counts = bandColours(of: window, strip: 150)
        XCTAssertGreaterThan(counts.accent, 4_000, "a diff that fits without scrolling has been seen: \(counts)")
        window.isHidden = true
    }

    // The window is sized to the diff it has to hold: the forty rows are measured in a short window first, then
    // hosted in one taller than they run to, so the premise is checked, not assumed, whatever the row height.
    func testAFortyRowDiffInAWindowThatHoldsItOpensApply() async throws {
        let measuring = await host(rows: 40, height: 500)
        let diff = try XCTUnwrap(scrollView(in: measuring)).contentSize.height
        measuring.isHidden = true
        XCTAssertGreaterThan(diff, 500, "forty rows overrun a short window")

        let window = await host(rows: 40, height: diff + 400)
        let scroll = try XCTUnwrap(scrollView(in: window))
        XCTAssertLessThanOrEqual(scroll.contentSize.height, scroll.bounds.height, "the whole diff fits without scrolling")
        let counts = bandColours(of: window, strip: 150)
        XCTAssertGreaterThan(counts.accent, 4_000, "the whole diff fits, so it has been seen: \(counts)")
        window.isHidden = true
    }

    func testALongDiffKeepsApplyClosedUntilScrolledToItsEnd() async throws {
        let window = await host(rows: 40, height: 500)
        let before = bandColours(of: window, strip: 150)
        XCTAssertLessThan(before.accent, 500, "40 rows in a 500pt window: Apply is closed until the end is seen: \(before)")
        XCTAssertGreaterThan(before.raised, 4_000, "a closed Apply draws skin.raised: \(before)")

        let scroll = try XCTUnwrap(scrollView(in: window))
        scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentSize.height - scroll.bounds.height), animated: false)
        await pump(20)
        let after = bandColours(of: window, strip: 150)
        XCTAssertGreaterThan(after.accent, 4_000, "scrolled to the end, Apply opens: \(after)")
        window.isHidden = true
    }

    // The real server answers after a network hop, so the sheet's first layout is the loading line; a diff that
    // lands afterwards must not inherit a gate that the placeholder opened.
    func testALongDiffBehindANetworkHopKeepsApplyClosed() async {
        let window = await host(rows: 40, height: 500, slow: true)
        let counts = bandColours(of: window, strip: 150)
        XCTAssertLessThan(counts.accent, 500, "the proposal arrived after the first layout: Apply must still be closed: \(counts)")
        XCTAssertGreaterThan(counts.raised, 4_000, "a closed Apply draws skin.raised: \(counts)")
        window.isHidden = true
    }

    func testAShortDiffBehindANetworkHopOpensApply() async {
        let window = await host(rows: 1, height: 800, slow: true)
        let counts = bandColours(of: window, strip: 150)
        XCTAssertGreaterThan(counts.accent, 4_000, "a diff that fits opens Apply however late it lands: \(counts)")
        window.isHidden = true
    }

    // The card the routines home stands on, measured as it is laid out. The summary is written, so the only
    // thing on the card either name can reach is the eyebrow.
    private func fitted(routine: String, agent: String, width: CGFloat) -> CGSize {
        let head = ProposalHead(id: "prop_1", routineId: "rt_1", summary: "Heavier triples.", changeCount: 2,
                                createdAtMs: 1_754_312_040_000, source: ProposalSource(door: "mcp", agent: agent))
        let card = ProposalCard(head: head, routineName: routine, undecided: true, onReview: {})
            .environment(\.gymSkin, GymSkin.instrument)
        return UIHostingController(rootView: card).sizeThatFits(in: CGSize(width: width, height: CGFloat.infinity))
    }

    func testTheStandingCardNamesTheRoutineInItsEyebrowAndHoldsItToOneLine() {
        let sixty = String(repeating: "N", count: 60)
        let plain = fitted(routine: "Push A", agent: "Claude", width: .infinity)

        XCTAssertGreaterThan(fitted(routine: sixty, agent: "Claude", width: .infinity).width, plain.width + 100,
                             "the eyebrow names the routine, so a longer name asks for more room")
        XCTAssertEqual(fitted(routine: "Push A", agent: sixty, width: .infinity).width, plain.width,
                       "and it names the agent nowhere: the review sheet's header is that fact's home")
        XCTAssertEqual(fitted(routine: sixty, agent: "Claude", width: 393).height,
                       fitted(routine: "Push A", agent: "Claude", width: 393).height,
                       "a name typed to its cap truncates rather than growing the card by a line")
    }
}

// The proposal read answers 300 ms later, as it does over a network.
final class SlowProposalTraining: TrainingSyncing, @unchecked Sendable {
    let inner: FakeTraining
    init(_ inner: FakeTraining) { self.inner = inner }
    func exercises() async throws -> [Exercise] { try await inner.exercises() }
    func createExercise(_ write: ExerciseWrite) async throws -> Exercise { try await inner.createExercise(write) }
    func renameExercise(_ exerciseId: String, to name: String) async throws -> Exercise? { try await inner.renameExercise(exerciseId, to: name) }
    func record(of exerciseId: String) async throws -> MovementRecord? { try await inner.record(of: exerciseId) }
    func startSession(_ start: SessionStart) async throws -> Session { try await inner.startSession(start) }
    func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet { try await inner.appendSet(to: sessionId, write) }
    func fixSet(_ setId: String, in sessionId: String, _ fix: SetFix) async throws -> TrainingSet { try await inner.fixSet(setId, in: sessionId, fix) }
    func deleteSet(_ setId: String, in sessionId: String) async throws { try await inner.deleteSet(setId, in: sessionId) }
    func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session { try await inner.finishSession(sessionId, at: finishedAtMs) }
    func discardSession(_ sessionId: String) async throws { try await inner.discardSession(sessionId) }
    func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary] { try await inner.sessions(before: before, beforeId: beforeId, limit: limit) }
    func session(_ id: String) async throws -> SessionDetail? { try await inner.session(id) }
    func review(of sessionId: String) async throws -> Review { try await inner.review(of: sessionId) }
    func lastTime(_ exerciseId: String) async throws -> LastTime { try await inner.lastTime(exerciseId) }
    func lastSets() async throws -> [LastSet] { try await inner.lastSets() }
    func routines() async throws -> [Routine] { try await inner.routines() }
    func routine(_ id: String) async throws -> Routine? { try await inner.routine(id) }
    func createRoutine(_ write: RoutineWrite) async throws -> Routine { try await inner.createRoutine(write) }
    func replaceRoutine(_ id: String, with write: RoutineWrite) async throws -> Routine { try await inner.replaceRoutine(id, with: write) }
    func deleteRoutine(_ id: String) async throws { try await inner.deleteRoutine(id) }
    func proposals() async throws -> [ProposalHead] { try await inner.proposals() }
    func proposal(_ id: String) async throws -> Proposal? {
        try await Task.sleep(for: .milliseconds(300))
        return try await inner.proposal(id)
    }
    func applyProposal(_ id: String) async throws -> AppliedProposal { try await inner.applyProposal(id) }
    func dismissProposal(_ id: String) async throws -> Proposal { try await inner.dismissProposal(id) }
    func share(_ sessionId: String) async throws -> SessionShare { try await inner.share(sessionId) }
    func revokeShare(_ sessionId: String) async throws { try await inner.revokeShare(sessionId) }
    func preferences() async throws -> GymPreferences { try await inner.preferences() }
    func savePreferences(_ preferences: GymPreferences) async throws -> GymPreferences { try await inner.savePreferences(preferences) }
    func bodyweight() async throws -> [BodyweightEntry] { try await inner.bodyweight() }
    func bodyweight(on dateLocal: String) async throws -> BodyweightEntry? { try await inner.bodyweight(on: dateLocal) }
    func putBodyweight(on dateLocal: String, _ write: BodyweightWrite) async throws -> BodyweightEntry { try await inner.putBodyweight(on: dateLocal, write) }
    func deleteBodyweight(on dateLocal: String) async throws { try await inner.deleteBodyweight(on: dateLocal) }
}
