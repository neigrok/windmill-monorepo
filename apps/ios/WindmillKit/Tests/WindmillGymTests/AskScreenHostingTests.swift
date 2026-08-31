import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The cap-reached block is the one part of the Coach room that is NOT inside the thread's scroller: the
// composer is a sibling of the ScrollView. Swapping a nine-word sentence for the account ceiling's
// twenty-one, above two tap targets, is a claim about layout — so it is measured, at the largest text
// size, by hosting the real screen and reading the scroller back. (The daily variant carries the
// allowance line above all of it; the ceiling does not, so the ceiling's own block is the shorter one.)
// The harness phone, and the floor the thread keeps on it. The floor is a PRODUCT BOUND, not a
// measurement: the cap-reached block may take up to two thirds of the phone and no more. It is
// written as a fraction of the window for a reason — the block's own height moves a long way
// between toolchains (585 pt of thread on Xcode 26.3, 329 on 26.6, same device, same harness), so
// any point value read off one machine pins that machine. Only a bound survives.
private let HARNESS_HEIGHT: CGFloat = 844
private let THREAD_KEEPS_AT_LEAST = HARNESS_HEIGHT / 3

@MainActor
final class AskScreenHostingTests: XCTestCase {
    private var stem: URL!

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ask-host-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
            try? FileManager.default.removeItem(at: stem.appendingPathExtension(ext))
        }
    }

    private func makeStore(sync: FakeTraining = FakeTraining()) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                      undoWindowMs: 0,
                      sync: { _ in sync })
    }

    private let doors = AskDoors(send: { _, _ in .failure(AskRefusal(line: "no")) },
                                 openThreads: {}, openNotes: {}, connect: {}, openProposal: { _ in }, absent: {})

    private func conversation(refused: AskRefusal) -> AskConversation {
        AskConversation(threadId: "thr_abcdefgh",
                        exchanges: [AskExchange(question: "why did bench stall", outcome: .refused(refused))])
    }

    private func host(_ conversation: AskConversation, size: DynamicTypeSize,
                      sync: FakeTraining = FakeTraining()) async -> UIWindow {
        let store = makeStore(sync: sync)
        await store.connect(to: Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!,
                                                         credential: { nil }),
                                        user: User(id: "u1", email: "u1@example.com", name: "Sam")))
        let screen = AskScreenHarness(store: store, conversation: conversation, doors: doors)
            .environment(\.dynamicTypeSize, size)
            .environment(\.gymSkin, GymSkin.instrument)
            .environment(\.colorScheme, .dark)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: screen)
        window.makeKeyAndVisible()
        window.rootViewController?.view.layoutIfNeeded()
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(20))
        }
        return window
    }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let found = view as? UIScrollView { return found }
        for child in view.subviews {
            if let found = scrollView(in: child) { return found }
        }
        return nil
    }

    private func threadHeight(_ conversation: AskConversation, size: DynamicTypeSize) async throws -> CGFloat {
        let window = await host(conversation, size: size)
        defer { window.isHidden = true }
        return try XCTUnwrap(scrollView(in: window)).bounds.height
    }

    // The 21-word ceiling sentence is the longest thing this block can be asked to draw, and it draws
    // outside the scroller. Measured on a 390 × 844 phone the thread keeps most of the screen under it,
    // at the largest text size and at the default one alike — so the claim held here is that the THREAD
    // STANDS at either, never that the two agree. They agree today only because this room's type is
    // `Font.system(size:)` throughout and does not scale, which is a gap rather than a reason: a room
    // that learned to scale would have to keep the scroller, not this equality.
    func testTheAccountCeilingLeavesTheThreadScrollerStandingUnderTheLongestSentence() async throws {
        let ceiling = AskRefusal(line: Ask.ceilingReached, ceiling: .account)
        let daily = AskRefusal(line: Ask.capReached, ceiling: .daily)

        let underCeiling = try await threadHeight(conversation(refused: ceiling), size: .accessibility5)
        let underDaily = try await threadHeight(conversation(refused: daily), size: .accessibility5)
        let plain = try await threadHeight(conversation(refused: ceiling), size: .large)

        XCTAssertGreaterThan(underCeiling, THREAD_KEEPS_AT_LEAST,
                             "the ceiling leaves the thread \(underCeiling) of \(HARNESS_HEIGHT)")
        XCTAssertGreaterThan(plain, THREAD_KEEPS_AT_LEAST,
                             "and at the default text size \(plain) of \(HARNESS_HEIGHT)")
        XCTAssertLessThan(underDaily - underCeiling, 60,
                          "the longer sentence costs the thread \(underDaily - underCeiling) points, not the thread")
    }

    // A promise about what Apply will do is spent the moment Apply is taken or turned down, so the
    // card draws it while the proposal waits and drops it once it is decided — the web's shape. Both
    // cards are otherwise the same card, one line of eyebrow apart, so what the pending one is taller
    // BY is the promise itself.
    func testTheProposalPromiseIsDrawnWhileItWaitsAndGoesWithTheDecision() async throws {
        let waiting = try await proposalCardHeight([minted(.pending)])
        let decided = try await proposalCardHeight([minted(.applied)])

        XCTAssertGreaterThan(decided, waiting / 2,
                             "the decided card is still drawn — the door and the count stay, so the "
                             + "decision took a line off the card and not the card (\(decided) of \(waiting))")
        XCTAssertGreaterThan(waiting, decided + 20,
                             "the pending card carries the promise and the decided one does not "
                             + "(\(waiting) vs \(decided))")
    }

    // The DECISION is what spends it, and an unread proposal is not one: with the read failed — a row
    // gone from the log, or a phone with no signal — the card is still drawn and still offers Review,
    // so the promise it makes about Apply still stands. What the failed read costs the card is the
    // summary, so the control is the decided card with no summary of its own: between those two
    // stands the promise and nothing else.
    func testAProposalTheRoomCouldNotReadKeepsThePromise() async throws {
        let unread = try await proposalCardHeight([])
        let decided = try await proposalCardHeight([minted(.applied, summary: "")])

        XCTAssertGreaterThan(unread, decided + 40,
                             "the unread card keeps the promise the decided one has spent "
                             + "(\(unread) vs \(decided))")
    }

    private func minted(_ state: ProposalState, summary: String = "Heavier triples.") -> Proposal {
        Proposal(head: ProposalHead(id: "prop_1", routineId: "rt_1", state: state,
                                    summary: summary, changeCount: 1,
                                    createdAtMs: 5_000, settledAtMs: state == .pending ? nil : 6_000,
                                    source: ProposalSource(door: "ask", agent: "Claude")),
                 baseRevision: 1, baseName: "Push A", name: "Push A", changes: [])
    }

    private func proposalCardHeight(_ ledger: [Proposal]) async throws -> CGFloat {
        let server = FakeTraining()
        server.ledger = ledger
        let answered = AskConversation(
            threadId: "thr_abcdefgh",
            exchanges: [AskExchange(question: "why did bench stall",
                                    outcome: .answered(AskAnswer(answer: "Your triples stalled at 100.",
                                                                 read: ReadTally(sets: 4, sessions: 2, weeks: 3),
                                                                 proposals: ["prop_1"])))])
        let window = await host(answered, size: .large, sync: server)
        defer { window.isHidden = true }
        return try XCTUnwrap(scrollView(in: window)).contentSize.height
    }
}

// The room owns the conversation; the harness stands in for that one binding and nothing else.
private struct AskScreenHarness: View {
    let store: TrainingStore
    @State var conversation: AskConversation
    let doors: AskDoors

    var body: some View {
        AskScreen(store: store, conversation: $conversation, doors: doors, receipts: [:], undecided: [])
    }
}
