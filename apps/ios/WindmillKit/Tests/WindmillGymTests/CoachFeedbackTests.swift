import XCTest
import SwiftUI
import WindmillPlatform
@testable import WindmillGym

@MainActor
final class CoachFeedbackTests: XCTestCase {
    func testRequestSurvivesRelaunchAndCannotCrossAccounts() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let store = CoachRequests(url: url)
        let request = CoachRequest(thread: "thr_original", question: "Make a routine.\nKeep it short.", requestId: "request_original")
        try store.save(request, user: "first")
        try store.select("thr_second", user: "second", draft: "Other account’s draft")

        let restored = CoachRequests(url: url)
        XCTAssertEqual(restored.seat("first").requests, ["thr_original": request])
        XCTAssertEqual(restored.seat("first").thread, "thr_original")
        XCTAssertEqual(restored.seat("second").requests, [:])
        XCTAssertEqual(restored.seat("second").drafts, ["thr_second": "Other account’s draft"])
        try restored.resolve(CoachRequest(thread: request.thread, question: request.question, requestId: "stale_request"), user: "first")
        XCTAssertEqual(restored.seat("first").requests, ["thr_original": request])
        try restored.resolve(request, user: "first")
        XCTAssertEqual(CoachRequests(url: url).seat("first").requests, [:])
    }

    func testFailedCreationAndCompletedReplayKeepOneExchangeAndItsReceipt() throws {
        let failed = try JSONDecoder().decode(CoachGeneration.self, from: Data("""
        {"id":"gen_1","requestId":"request_1","question":"Create a routine","status":"failed",
        "answer":"","at":1000,"steps":[],"receipt":{"read":{"sets":2,"sessions":1,"weeks":1},"steps":[],"proposals":[]},
        "results":[{"kind":"routine-created","operationId":"operation_1","routineId":"routine_1","routineName":"Push A"}]}
        """.utf8))
        var conversation = AskConversation(threadId: "thread_1")
        conversation.accept(failed)
        XCTAssertEqual(conversation.exchanges.count, 1)
        XCTAssertEqual(conversation.unresolved?.id, "request_1")
        XCTAssertEqual(conversation.exchanges[0].snapshot?.results.map(\.routineName), ["Push A"])
        XCTAssertEqual(conversation.exchanges[0].snapshot?.read, ReadTally(sets: 2, sessions: 1, weeks: 1))
        conversation.settle("request_1", .refused(AskRefusal(line: "Allowance reached", mayRetry: true, ceiling: .account)))
        XCTAssertEqual(conversation.exchanges[0].snapshot?.results, failed.results)
        XCTAssertEqual(conversation.unresolved?.id, "request_1")
        XCTAssertEqual(conversation.open("Create a routine", replacing: "request_1"), "request_1")
        let complete = CoachGeneration(id: failed.id, requestId: failed.requestId, question: failed.question,
            status: "completed", answer: "Push A is ready.", at: failed.at, steps: [], receipt: failed.receipt, results: failed.results)
        conversation.accept(complete)
        conversation.accept(complete)
        XCTAssertEqual(conversation.exchanges.count, 1)
        XCTAssertEqual(conversation.exchanges[0].outcome, .answered(complete.snapshot))
        XCTAssertNil(conversation.unresolved)
    }

    func testPagedHistoryMergesByPositionThenAllowsFifthQuestionInSameConversation() {
        let turns = (1...10).map { position in
            AskTurn(from: position.isMultiple(of: 2) ? .ask : .lifter, text: "Message \(position)",
                    atMs: Int64(position), position: position,
                    requestId: "request_\((position + 1) / 2)")
        }
        var conversation = AskConversation(threadId: "thread_1")
        conversation.merge(AskThread(id: "thread_1", title: "Question", createdAtMs: 1, askedAtMs: 10,
            outcome: ThreadOutcome(kind: .readOnly), turns: Array(turns.suffix(4)), nextCursor: "older"))
        conversation.merge(AskThread(id: "thread_1", title: "Question", createdAtMs: 1, askedAtMs: 10,
            outcome: ThreadOutcome(kind: .readOnly), turns: Array(turns.prefix(8))), older: true)
        XCTAssertEqual(conversation.exchanges.map(\.question), ["Message 1", "Message 3", "Message 5", "Message 7", "Message 9"])
        XCTAssertEqual(conversation.exchanges.map(\.position), [1, 3, 5, 7, 9])
        XCTAssertNil(conversation.nextCursor)
        XCTAssertNil(conversation.unresolved)
        let request = conversation.open("Keep going", replacing: nil)
        XCTAssertEqual(conversation.threadId, "thread_1")
        XCTAssertEqual(conversation.exchanges.last?.id, request)
        XCTAssertEqual(conversation.exchanges.count, 6)
    }

    func testClocksFollowEveryRetainedSetAndFreezeAtFinish() {
        let session = Session(id: "session", startedAtMs: 1_000)
        let first = TrainingSet(id: "one", exerciseId: "squat", weightKg: 20, reps: 5, kind: .warmup, completedAtMs: 10_000)
        let last = TrainingSet(id: "two", exerciseId: "bench", weightKg: 30, reps: 4, kind: .drop, completedAtMs: 20_000)
        let noSets = WorkoutClocks(session: session, sets: [], nowMs: 31_000)
        XCTAssertEqual(noSets.workoutMs, 30_000)
        XCTAssertEqual(noSets.sinceSetMs, 30_000)
        XCTAssertFalse(noSets.hasSet)
        XCTAssertEqual(WorkoutClocks(session: session, sets: [last, first], nowMs: 31_000).sinceSetMs, 11_000)
        XCTAssertEqual(WorkoutClocks(session: session, sets: [first], nowMs: 31_000).sinceSetMs, 21_000)
        let finished = Session(id: "session", startedAtMs: 1_000, finishedAtMs: 30_000)
        let frozen = WorkoutClocks(session: finished, sets: [first, last], nowMs: 60_000)
        XCTAssertEqual(frozen.workoutMs, 29_000)
        XCTAssertEqual(frozen.sinceSetMs, 10_000)
        XCTAssertEqual(WorkoutClocks(session: session, sets: [last], nowMs: 0).sinceSetMs, 0)
        XCTAssertEqual(WorkoutClocks.text(3_661_000), "1:01:01")
        XCTAssertEqual(WorkoutClocks.text(59_000), "00:59")
        XCTAssertEqual(WorkoutClocks.spoken(3_661_000), "1 hour, 1 minute, 1 second")
    }

    func testClockPairFitsNarrowPhoneAtAccessibilitySizeWithLongHours() async {
        let clocks = WorkoutClocks(session: Session(id: "one", startedAtMs: 0), sets: [], nowMs: 360_061_000)
        let view = WorkoutClockPair(clocks: clocks).environment(\.dynamicTypeSize, .accessibility5)
        let host = UIHostingController(rootView: view)
        let size = host.sizeThatFits(in: CGSize(width: 280, height: 400))
        XCTAssertLessThanOrEqual(size.width, 280)
        XCTAssertGreaterThan(size.height, 60)
        XCTAssertLessThan(size.height, 200)
    }
}
