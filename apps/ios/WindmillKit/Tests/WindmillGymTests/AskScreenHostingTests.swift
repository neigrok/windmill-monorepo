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

    private func makeStore() -> TrainingStore {
        TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                      undoWindowMs: 0,
                      sync: { _ in FakeTraining() })
    }

    private let doors = AskDoors(send: { _, _ in .failure(AskRefusal(line: "no")) },
                                 openThreads: {}, openNotes: {}, connect: {}, openProposal: { _ in }, absent: {})

    private func conversation(refused: AskRefusal) -> AskConversation {
        AskConversation(threadId: "thr_abcdefgh",
                        exchanges: [AskExchange(question: "why did bench stall", outcome: .refused(refused))])
    }

    private func host(_ conversation: AskConversation, size: DynamicTypeSize) async -> UIWindow {
        let store = makeStore()
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

        XCTAssertGreaterThan(underCeiling, 400,
                             "the thread keeps most of the phone under the ceiling: \(underCeiling) of 844")
        XCTAssertGreaterThan(plain, 400,
                             "and at the default text size too: \(plain) of 844")
        XCTAssertLessThan(underDaily - underCeiling, 60,
                          "the longer sentence costs the thread \(underDaily - underCeiling) points, not the thread")
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
