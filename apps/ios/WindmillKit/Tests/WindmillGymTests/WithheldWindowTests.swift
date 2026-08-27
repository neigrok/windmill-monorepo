import XCTest
@testable import WindmillGym

// The window over every verb that can still be taken back. The load-bearing facts are that it holds
// MORE than one, that nothing is ever settled by a second act, and that a server-only delete is not
// on the wire until the window closes — an undo that arrives after the send is not an undo.
@MainActor
final class WithheldWindowTests: XCTestCase {
    // A stand-in for the wire: `settle` is the only thing that reaches it.
    private final class Log {
        var sent: [String] = []
        var putBack: [String] = []
        // Whether the send landed. A refused settle leaves the row to be drawn again.
        var answers = true
    }

    private func window(_ ms: Int64) -> WithheldWindow {
        WithheldWindow(windowMs: ms, now: { Int64(Date().timeIntervalSince1970 * 1000) })
    }

    private func delete(_ kind: Withheld.Kind, _ subject: String, line: String,
                        into log: Log) -> Withheld {
        Withheld(kind, subject: subject, line: line,
                 settle: {
                     log.sent.append(subject)
                     return log.answers
                 },
                 restore: { log.putBack.append(subject) })
    }

    private func waitForWindowsToClose(_ open: WithheldWindow, timeout: TimeInterval = 4) async {
        let deadline = Date().addingTimeInterval(timeout)
        while open.isOpen, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testAServerOnlyDeleteIsNotOnTheWireUntilTheWindowCloses() async {
        let log = Log()
        let open = window(150)

        await open.hold(delete(.thread, "th_1", line: WithheldWords.thread, into: log))

        XCTAssertTrue(log.sent.isEmpty, "a send cannot be taken back, so nothing was sent")
        XCTAssertTrue(open.isOpen)

        await waitForWindowsToClose(open)

        XCTAssertEqual(log.sent, ["th_1"], "and only the window's own clock sent it")
        XCTAssertTrue(log.putBack.isEmpty)
    }

    func testTwoDeletesInOneSecondBothRestoreAndNeitherSettlesTheOther() async {
        let log = Log()
        let open = window(4_000)

        await open.hold(delete(.set, "set_1", line: WithheldWords.deleted("82.5 × 5"), into: log))
        await open.hold(delete(.set, "set_2", line: WithheldWords.deleted("100 × 3"), into: log))

        XCTAssertEqual(open.held.count, 2, "the window is a list, never a slot")
        XCTAssertTrue(log.sent.isEmpty, "the second delete settled nothing")

        await open.undo()
        XCTAssertEqual(log.putBack, ["set_2"], "the newest first")
        XCTAssertEqual(open.line, WithheldWords.deleted("82.5 × 5"), "and the transient re-reads")

        await open.undo()
        XCTAssertEqual(log.putBack, ["set_2", "set_1"])
        XCTAssertTrue(log.sent.isEmpty, "neither delete ever reached the wire")
        XCTAssertFalse(open.isOpen, "and the transient retires with the last clock")
    }

    func testEachDeleteCarriesItsOwnClockAndTheOlderCloseFirst() async {
        let log = Log()
        let open = window(200)

        await open.hold(delete(.set, "set_1", line: "one", into: log))
        try? await Task.sleep(for: .milliseconds(120))
        await open.hold(delete(.set, "set_2", line: "two", into: log))

        try? await Task.sleep(for: .milliseconds(140))
        XCTAssertEqual(log.sent, ["set_1"], "the older window closed on its own clock")
        XCTAssertEqual(open.held.map(\.subject), ["set_2"], "and the newer is still open")

        await waitForWindowsToClose(open)
        XCTAssertEqual(log.sent, ["set_1", "set_2"])
    }

    func testUndoingTheNewestLeavesTheOlderOnItsOwnClock() async {
        let log = Log()
        let open = window(250)

        await open.hold(delete(.routine, "rt_1", line: WithheldWords.routine("Push A"), into: log))
        await open.hold(delete(.thread, "th_1", line: WithheldWords.thread, into: log))

        await open.undo()
        XCTAssertEqual(log.putBack, ["th_1"])

        await waitForWindowsToClose(open)
        XCTAssertEqual(log.sent, ["rt_1"], "the routine's own window ran to its end")
        XCTAssertEqual(log.putBack, ["th_1"], "and the one that was taken back was never sent")
    }

    // Swipe, switch apps, come back. Settling here would destroy the row with the undo already gone
    // — an unrecoverable delete reached by two ordinary actions, which is the whole thing the
    // withheld pattern exists to prevent. So the room lets go instead.
    func testLeavingTheForegroundAbandonsWhatIsHeldAndSendsNothing() async {
        let log = Log()
        let open = window(60_000)

        await open.hold(delete(.routine, "rt_1", line: WithheldWords.routine("Push A"), into: log))
        await open.hold(delete(.thread, "th_1", line: WithheldWords.thread, into: log))
        await open.abandon()

        XCTAssertTrue(log.sent.isEmpty, "nothing reached the wire")
        XCTAssertEqual(log.putBack.sorted(), ["rt_1", "th_1"], "and both rows came back")
        XCTAssertFalse(open.isOpen)
        XCTAssertFalse(open.hides(.routine, "rt_1"))
        XCTAssertFalse(open.hides(.thread, "th_1"))
    }

    func testAbandoningAnEmptyWindowDoesNothingAtAll() async {
        let log = Log()
        let open = window(60_000)
        await open.abandon()
        XCTAssertTrue(log.sent.isEmpty)
        XCTAssertTrue(log.putBack.isEmpty)
    }

    // A set's hold is written into the QUEUE, on disk, with its own clock — so the room letting go
    // may not reach in and change what the lifter did. It is the one kind that is not put back.
    func testASetIsLetGoOfRatherThanPutBack() async {
        let log = Log()
        let open = window(60_000)

        await open.hold(delete(.loggedSet, "set_1", line: WithheldWords.logged("100 × 5"), into: log))
        await open.hold(delete(.set, "set_2", line: WithheldWords.deleted("100 × 5"), into: log))
        await open.hold(delete(.session, "ses_1", line: WithheldWords.session, into: log))
        await open.abandon()

        XCTAssertTrue(log.sent.isEmpty, "the room never sends on its way out")
        XCTAssertEqual(log.putBack, ["ses_1"], "only the verb whose only home was the register")
    }

    // A list read back from the server would draw a row the server has already dropped, so what has
    // GONE is hidden as firmly as what is still held — and a settle the log refused is not gone.
    func testARowStaysHiddenOnceItsDeleteHasActuallyLandedAndComesBackWhenItDidNot() async {
        let log = Log()
        let open = window(120)

        await open.hold(delete(.thread, "th_1", line: WithheldWords.thread, into: log))
        await waitForWindowsToClose(open)

        XCTAssertEqual(log.sent, ["th_1"])
        XCTAssertFalse(open.holds(.thread, "th_1"), "its window is over")
        XCTAssertTrue(open.hides(.thread, "th_1"), "and the list may not draw it again")

        log.answers = false
        await open.hold(delete(.thread, "th_2", line: WithheldWords.thread, into: log))
        await waitForWindowsToClose(open)

        XCTAssertEqual(log.sent, ["th_1", "th_2"])
        XCTAssertFalse(open.hides(.thread, "th_2"), "the log refused it, so the row is still there")
    }

    func testARestoredRowStopsBeingWithheldAtOnce() async {
        let log = Log()
        let open = window(4_000)

        await open.hold(delete(.thread, "th_1", line: WithheldWords.thread, into: log))
        XCTAssertTrue(open.holds(.thread, "th_1"), "the list stops drawing it")
        XCTAssertEqual(open.subjects(of: .thread), ["th_1"])

        await open.undo()
        XCTAssertFalse(open.holds(.thread, "th_1"), "and draws it again the moment the undo lands")
        XCTAssertTrue(open.subjects(of: .thread).isEmpty)
    }

    // The transient says the newest act's own words, and only counts once there is more than one.
    func testTheTransientSaysTheNewestAndCountsOnlyWhatIsActuallyADelete() async {
        let log = Log()
        let open = window(4_000)

        await open.hold(delete(.routine, "rt_1", line: WithheldWords.routine("Push A"), into: log))
        XCTAssertEqual(open.line, "Push A deleted.")
        XCTAssertEqual(open.detail, nil)

        await open.hold(Withheld(.routine, subject: "rt_2", line: WithheldWords.routine("Pull B"),
                                 detail: WithheldWords.routineDetail))
        XCTAssertEqual(open.line, "2 deleted.")
        XCTAssertNil(open.detail, "a count has no one detail to carry")

        await open.hold(delete(.loggedSet, "set_9", line: WithheldWords.logged("100 × 3"), into: log))
        XCTAssertEqual(open.line, "3 to take back.",
                       "a set just LOGGED is not a delete, and the count may not say it is")
    }

    func testTheDetailIsDrawnWhenTheRoutineIsTheWholeOfWhatIsHeld() async {
        let open = window(4_000)
        await open.hold(Withheld(.routine, subject: "rt_1", line: WithheldWords.routine("Push A"),
                                 detail: WithheldWords.routineDetail))
        XCTAssertEqual(open.detail, "its proposals go with it")
    }

    func testTheWordsAreOneSpellingEach() {
        XCTAssertEqual(WithheldWords.undo, "Undo")
        XCTAssertEqual(WithheldWords.thread, "Conversation deleted.")
        XCTAssertEqual(WithheldWords.session, "Session deleted.")
        XCTAssertEqual(WithheldWords.routine("Push A"), "Push A deleted.")
        XCTAssertEqual(WithheldWords.routineDetail, "its proposals go with it")
        XCTAssertEqual(WithheldWords.deleted("82.5 × 5"), "82.5 × 5 is out of the log.")
        XCTAssertEqual(WithheldWords.logged("82.5 × 5"), "82.5 × 5 logged.")
        XCTAssertEqual(WithheldWords.many([.set, .routine]), "2 deleted.")
        XCTAssertEqual(WithheldWords.many([.set, .loggedSet]), "2 to take back.")
        XCTAssertEqual(WithheldWords.windowClosed, "The window closed — that delete already went.")
    }

    // What is LEFT of a window is measured on the clock that closes it, and on no other. The
    // transient's drain is the only reader, and it asks here rather than reading a clock for itself:
    // a bar draining on the wall clock under a seat built on an injected one empties at a different
    // moment than the way back disappears. The instants below are nowhere near wall-clock time on
    // purpose — an ambient read answers 0 for every one of them.
    func testWhatIsLeftIsMeasuredOnTheWindowsOwnClock() async {
        var clockMs: Int64 = 10_000
        let open = WithheldWindow(windowMs: 9_000, now: { clockMs })

        XCTAssertEqual(open.leftMs, 0, "nothing is held, so there is nothing to draw")

        await open.hold(Withheld(.routine, subject: "rt_1", line: WithheldWords.routine("Push A")))
        XCTAssertEqual(open.leftMs, 9_000, "the whole window, on the clock that will close it")

        clockMs += 3_000
        XCTAssertEqual(open.leftMs, 6_000, "and it shrinks by exactly what that clock spent")

        clockMs += 60_000
        XCTAssertEqual(open.leftMs, 0, "never past the end, and never negative")
    }

    // A logged set carries the instant the QUEUE stamped on disk. The subtraction still happens
    // here, against that instant, so the drain runs out with the queue's own hold rather than with a
    // second window started when the walk back to the room finished.
    func testAnActThatCarriesItsOwnInstantIsMeasuredFromThatInstant() async {
        var clockMs: Int64 = 500_000
        let open = WithheldWindow(windowMs: 9_000, now: { clockMs })

        await open.hold(Withheld(.loggedSet, subject: "set_1",
                                 line: WithheldWords.logged("100 × 5"),
                                 closesAtMs: clockMs + 4_000))

        XCTAssertEqual(open.closesAtMs, 504_000)
        XCTAssertEqual(open.leftMs, 4_000, "what the queue has left, not nine fresh seconds")

        clockMs += 1_500
        XCTAssertEqual(open.leftMs, 2_500)
    }

    // The rule the two tests above cannot reach: the transient's own arithmetic is private to a
    // SwiftUI view, so nothing executable here can catch it reading the wall clock again. It is
    // pinned on the source instead — the register owns the clock, and the view that draws it owns
    // none.
    func testTheTransientKeepsNoClockOfItsOwn() throws {
        let file = try XCTUnwrap(GymApostropheTests.gymSources
            .first { $0.lastPathComponent == "Withheld.swift" })
        let source = try String(contentsOf: file, encoding: .utf8)
        let view = try XCTUnwrap(source.range(of: "struct WithheldTransient"),
                                 "the transient is not in Withheld.swift any more")
        let drawn = String(source[view.lowerBound...])

        for ambient in ["Date(", "Date.now", "CACurrentMediaTime", "DispatchTime.now",
                        "ProcessInfo", "TimelineView", "Timer"] {
            XCTAssertFalse(drawn.contains(ambient),
                           "\(ambient) in the transient: the window owns the clock, the view asks it")
        }
    }

    // Every window on every surface is the same nine seconds (P4, ledger `2m`).
    func testTheWindowIsTheQueuesOwnNineSeconds() {
        XCTAssertEqual(SetQueue.undoWindowMs, 9_000)
    }
}
