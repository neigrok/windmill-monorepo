import XCTest
@testable import WindmillGym

// WHAT HAS TO BE TRUE FOR ASK TO BE ALLOWED A PAST (§O screen 33). The reversal of W7 is a product
// decision — a conversation about your bench plateau is worth more in six weeks than it was that
// evening — and every way a kept conversation could quietly become something else is pinned here:
//
//   · a row's TITLE is the lifter's first message byte for byte, never a summary a model wrote,
//   · a row's DETAIL is only ever something the server observed — a count, a routine, a state — and
//     NEVER a motive, which is the one line of the board this refuses to draw,
//   · the list is not an inbox: nothing counts, badges, notifies, searches, pins or resurfaces,
//   · and deleting a conversation leaves the change it applied standing in the routine's history.

private func thread(_ kind: ThreadOutcome.Kind, changes: Int = 0,
                    routine: String? = nil, askedAtMs: Int64 = 1_000) -> AskThread {
    AskThread(id: "thr_1", title: "q", createdAtMs: askedAtMs, askedAtMs: askedAtMs,
              outcome: ThreadOutcome(kind: kind, changes: changes,
                                     routineId: routine == nil ? nil : "rt_1", routine: routine))
}

// 1 Aug 2026, 09:00 local — the month headings and the `when` on a row are read in the zone the
// lifter is standing in, so both sides of every comparison below are built the same way.
private func at(year: Int, month: Int, day: Int) -> Int64 {
    let parts = DateComponents(year: year, month: month, day: day, hour: 9)
    let moment = Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
    return Int64(moment.timeIntervalSince1970 * 1000)
}

final class AskThreadWireTests: XCTestCase {
    // The list row as the contract spells it, decoded whole. Written out as bytes rather than built
    // with initialisers, because a CodingKey that drifted from the server's name is the one failure
    // a round trip through our own encoder could never catch.
    func testAListedThreadDecodesFromTheWiresOwnShape() throws {
        let wire = """
        {"id":"thr_0a1b2c3d",
         "title":"Bench has been stuck at 82.5 for three weeks. What do you see?",
         "createdAt":1754000000000,"askedAt":1754600000000,
         "outcome":{"kind":"applied","changes":4,"routineId":"rt_push","routine":"Push A"},
         "proposals":[{"id":"prop_1","state":"applied","changeCount":4,
                       "routineId":"rt_push","routine":"Push A","createdAt":1754600000000}]}
        """
        let listed = try JSONDecoder().decode(AskThread.self, from: Data(wire.utf8))

        XCTAssertEqual(listed.id, "thr_0a1b2c3d")
        XCTAssertEqual(listed.title,
                       "Bench has been stuck at 82.5 for three weeks. What do you see?")
        XCTAssertEqual(listed.createdAtMs, 1_754_000_000_000)
        XCTAssertEqual(listed.askedAtMs, 1_754_600_000_000)
        XCTAssertEqual(listed.outcome, ThreadOutcome(kind: .applied, changes: 4,
                                                     routineId: "rt_push", routine: "Push A"))
        XCTAssertEqual(listed.proposals, [ThreadProposal(id: "prop_1", state: .applied,
                                                         changeCount: 4, routineId: "rt_push",
                                                         routine: "Push A",
                                                         createdAtMs: 1_754_600_000_000)])
        // The list carries no prose at all. An absent `turns` is "this came off the list" and never
        // "this conversation was empty" — which is why it is an optional rather than a default [].
        XCTAssertNil(listed.turns)
    }

    // The detail read, turns and all, in the product's own vocabulary: `lifter` and `ask`, never
    // `user`/`assistant`. They travel one way now — inward — because the server assembles the
    // prompt from what it stored.
    func testTheDetailReadCarriesTheTurnsInTheProductsOwnVocabulary() throws {
        let wire = """
        {"id":"thr_1","title":"Deload week — what should I cut?",
         "createdAt":1750000000000,"askedAt":1750000600000,
         "outcome":{"kind":"read-only","changes":0},
         "turns":[{"from":"lifter","text":"Deload week — what should I cut?","at":1750000000000},
                  {"from":"ask","text":"Halve the volume, keep the top set.","at":1750000600000}]}
        """
        let read = try JSONDecoder().decode(AskThread.self, from: Data(wire.utf8))

        XCTAssertEqual(read.turns, [
            AskTurn(from: .lifter, text: "Deload week — what should I cut?", atMs: 1_750_000_000_000),
            AskTurn(from: .ask, text: "Halve the volume, keep the top set.", atMs: 1_750_000_600_000),
        ])
        XCTAssertEqual(read.proposals, [])
    }

    // A VOICE THIS BUILD HAS NEVER HEARD OF FAILS THE READ. Two voices is the whole vocabulary, and
    // putting the wrong name on somebody's sentence is worse than drawing nothing.
    func testATurnInAVoiceThisBuildDoesNotKnowIsNotDrawn() {
        let wire = """
        {"id":"thr_1","title":"q","createdAt":1,"askedAt":1,
         "outcome":{"kind":"read-only","changes":0},
         "turns":[{"from":"assistant","text":"hello","at":1}]}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(AskThread.self, from: Data(wire.utf8)))
    }

    // THE TITLE IS THE FIRST MESSAGE, BYTE FOR BYTE — punctuation, emoji, casing, the lot. It is the
    // whole point of the row, and anything this surface did to tidy it would be the room telling a
    // lifter what they said.
    func testTheTitleIsTheLiftersOwnWordsUntouched() throws {
        let typed = "  why is my e1RM going DOWN 😤 when the weight goes up?? "
        let wire = """
        {"id":"thr_1","title":\(quoted(typed)),"createdAt":1,"askedAt":1,
         "outcome":{"kind":"read-only","changes":0}}
        """
        let listed = try JSONDecoder().decode(AskThread.self, from: Data(wire.utf8))

        XCTAssertEqual(listed.title, typed)
    }

    // A KIND FROM A SERVER THIS BUILD IS OLDER THAN. The count is still a fact and still prints; the
    // verb is not ours to guess, so there is no chip and no sentence around it — the row says less
    // rather than something wrong.
    func testAnOutcomeThisBuildDoesNotKnowSaysTheCountAndNothingElse() throws {
        let wire = #"{"kind":"withdrawn","changes":3}"#
        let outcome = try JSONDecoder().decode(ThreadOutcome.self, from: Data(wire.utf8))

        XCTAssertEqual(outcome.kind, .unknown)
        XCTAssertEqual(outcome.line, "3 changes")
        XCTAssertNil(outcome.word)
        XCTAssertFalse(outcome.changedTheProgram)

        let silent = try JSONDecoder().decode(ThreadOutcome.self,
                                              from: Data(#"{"kind":"withdrawn","changes":0}"#.utf8))
        XCTAssertEqual(silent.line, "")
    }

    private func quoted(_ text: String) -> String {
        String(decoding: (try? JSONEncoder().encode(text)) ?? Data(), as: UTF8.self)
    }
}

final class ThreadOutcomeTests: XCTestCase {
    // THE ROW'S SECOND LINE, outcome by outcome, and every word of it is a ledger fact: the count,
    // and the routine when the changes all landed in one.
    func testEveryOutcomeSaysWhatTheLedgerHolds() {
        XCTAssertEqual(thread(.applied, changes: 4, routine: "Push A").outcome.line,
                       "4 changes → Push A")
        XCTAssertEqual(thread(.readOnly).outcome.line, "no changes proposed")
        XCTAssertEqual(thread(.proposed, changes: 2).outcome.line, "2 changes waiting")
        XCTAssertEqual(thread(.dismissed, changes: 4).outcome.line, "4 changes dismissed")
        XCTAssertEqual(thread(.superseded, changes: 6).outcome.line, "6 changes set aside")
    }

    // Changes that spanned more than one routine come with neither the name nor the id, and the line
    // says the count alone rather than naming whichever routine happened to come first.
    func testChangesAcrossMoreThanOneRoutineNameNoneOfThem() {
        XCTAssertEqual(ThreadOutcome(kind: .applied, changes: 7).line, "7 changes")
        XCTAssertNil(ThreadOutcome(kind: .applied, changes: 7).routineId)
    }

    // One change is `1 change`. A `1 changes` under somebody's own question would be the room
    // miscounting the only thing the line exists to state.
    func testOneChangeIsSpelledInTheSingular() {
        XCTAssertEqual(ThreadOutcome(kind: .applied, changes: 1, routineId: "rt_1",
                                     routine: "Legs").line, "1 change → Legs")
        XCTAssertEqual(ThreadOutcome(kind: .dismissed, changes: 1).line, "1 change dismissed")
        XCTAssertEqual(Readout.changeCount(1), "1 change")
        XCTAssertEqual(Readout.changeCount(0), "0 changes")
    }

    // THE ONE LINE OF THE BOARD THAT IS NOT BUILT. Screen 33 draws a dismissed row reading
    // `built it myself instead`. Nothing observes WHY a lifter dismissed a proposal and this product
    // does not ask, so that sentence is a motive narrated onto somebody's evening — one line under
    // the rule that a thread is titled by your own words and never by a story told about you. A
    // dismissed row carries what was dismissed and nothing else, and the wire has no field a reason
    // could even arrive in.
    func testNoRowEverStatesAMotiveTheSystemDidNotObserve() {
        let motives = ["instead", "myself", "because", "didn’t like", "didn't like", "changed my",
                       "decided", "preferred", "wanted", "ignored"]
        let spoken = ThreadOutcome.Kind.allCases.flatMap { kind in
            [ThreadOutcome(kind: kind, changes: 4, routineId: "rt_1", routine: "Push A").line,
             ThreadOutcome(kind: kind, changes: 0).line,
             ThreadOutcome(kind: kind, changes: 4).word ?? ""]
        }

        for sentence in spoken {
            for motive in motives {
                XCTAssertFalse(sentence.lowercased().contains(motive), "\(sentence) says \(motive)")
            }
        }
    }

    // The chip and the line use the SAME word, so a row never labels itself one way and describes
    // itself another. Only the applied one is lit: it is the single outcome that changed the
    // lifter's program.
    func testTheChipAndTheLineAgreeAndOnlyAnAppliedRowIsLit() {
        XCTAssertEqual(ThreadOutcome(kind: .applied, changes: 4).word, "applied")
        XCTAssertEqual(ThreadOutcome(kind: .readOnly).word, "read only")
        XCTAssertEqual(ThreadOutcome(kind: .dismissed, changes: 4).word, "dismissed")
        XCTAssertEqual(ThreadOutcome(kind: .proposed, changes: 4).word, "waiting")
        XCTAssertEqual(ThreadOutcome(kind: .superseded, changes: 4).word, "set aside")

        XCTAssertTrue(ThreadOutcome(kind: .applied, changes: 4).changedTheProgram)
        for quiet in [ThreadOutcome.Kind.readOnly, .dismissed, .proposed, .superseded, .unknown] {
            XCTAssertFalse(ThreadOutcome(kind: quiet, changes: 4).changedTheProgram, quiet.rawValue)
        }
    }

    // A proposal on the detail says what it asks for, where, and what the LOG says became of it —
    // never this screen's memory of what was tapped.
    func testAMintedProposalReadsItsCountItsRoutineAndTheLogsWordForIt() {
        let minted = ThreadProposal(id: "prop_1", state: .superseded, changeCount: 3,
                                    routineId: "rt_1", routine: "Push A", createdAtMs: 1_000)

        XCTAssertEqual(minted.line, "3 changes to Push A · Set aside")
    }

    // ONE SCREEN, ONE WORD. The thread detail draws the head's outcome line and chip inches above the
    // rows of the proposals that thread minted, and the routine's history says it a third time. All
    // of them are SET ASIDE — the room's word (`ProposalState.word`) and never the wire's
    // `superseded`, which no lifter did.
    func testTheWholeSurfaceSpellsTheFourthStateOneWay() {
        let outcome = ThreadOutcome(kind: .superseded, changes: 3, routineId: "rt_1",
                                    routine: "Push A")
        let minted = ThreadProposal(id: "prop_1", state: .superseded, changeCount: 3,
                                    routineId: "rt_1", routine: "Push A", createdAtMs: 1_000)

        XCTAssertEqual(outcome.line, "3 changes set aside")
        XCTAssertEqual(outcome.word, "set aside")
        XCTAssertEqual(minted.line, "3 changes to Push A · Set aside")
        XCTAssertEqual(ProposalState.superseded.word, "Set aside")
    }
}

final class ThreadListTests: XCTestCase {
    // Rows are grouped by the month they were last asked in, in the order the server sent them —
    // newest first — and nothing on this device reorders a training history.
    func testRowsAreGatheredByMonthInTheOrderTheyArrived() {
        let now = at(year: 2026, month: 8, day: 13)
        let listed = [thread(.applied, changes: 4, routine: "Push A",
                             askedAtMs: at(year: 2026, month: 8, day: 13)),
                      thread(.readOnly, askedAtMs: at(year: 2026, month: 8, day: 7)),
                      thread(.dismissed, changes: 4, askedAtMs: at(year: 2026, month: 7, day: 21)),
                      thread(.readOnly, askedAtMs: at(year: 2025, month: 7, day: 14))]

        let months = AskThreads.months(of: listed, now: now)

        XCTAssertEqual(months.map(\.label), ["August", "July", "July 2025"])
        XCTAssertEqual(months.map { $0.threads.count }, [2, 1, 1])
    }

    // THE YEAR ARRIVES THE MOMENT THE MONTH IS NO LONGER IN THIS ONE. `July` is a heading on
    // nobody's calendar once a log holds two of them, and threads are the first thing in this
    // product built to be read years later.
    func testAMonthOutsideThisYearCarriesIt() {
        let now = at(year: 2026, month: 8, day: 13)

        XCTAssertEqual(Readout.month(at(year: 2026, month: 1, day: 2), now: now), "January")
        XCTAssertEqual(Readout.month(at(year: 2024, month: 12, day: 31), now: now), "December 2024")
    }

    func testAnEmptyListIsNoMonthsAtAll() {
        XCTAssertEqual(AskThreads.months(of: [], now: 1_000), [])
    }

    // `9 conversations · yours to delete`, and one of them counted in the singular.
    func testTheHeadCountsConversationsAndSaysTheyAreYoursToDelete() {
        XCTAssertEqual(AskThreads.meta(9), "9 conversations · yours to delete")
        XCTAssertEqual(AskThreads.meta(1), "1 conversation · yours to delete")
        XCTAssertEqual(AskThreads.meta(0), "0 conversations · yours to delete")
    }

    // A FULL PAGE SAYS `200+`. The list read is capped at `kThreadList` and the reply carries no
    // total, so a head printing `200 conversations` would be this screen stating a number the server
    // never sent — and stating it wrongly for anybody with 201.
    func testAFullPageSaysAtLeastRatherThanAssertingATotalTheServerNeverSent() {
        XCTAssertEqual(AskThreads.meta(199), "199 conversations · yours to delete")
        XCTAssertEqual(AskThreads.meta(AskThreads.served), "200+ conversations · yours to delete")
    }

    // NOT AN INBOX, and the list is long because every item is a thing this screen could accidentally
    // grow. A threads screen is the most natural place in the whole product for a badge, and §O
    // forbids one — so the copy is walked for the vocabulary that would come with each of them.
    func testNothingOnThisSurfaceSpeaksLikeAnInbox() {
        let never = ["unread", "badge", "notification", "notify", "new message", "inbox",
                     "search", "filter", "folder", "pin", "archive", "waiting for you"]
        let spoken = [AskThreads.title, AskThreads.door, AskThreads.askSomethingNew,
                      AskThreads.meta(9), AskThreads.empty, AskThreads.delete,
                      AskThreads.deleteNote, AskThreads.reading, AskThreads.fromTheConversation]

        for sentence in spoken {
            for word in never {
                XCTAssertFalse(sentence.lowercased().contains(word), "\(sentence) says \(word)")
            }
        }
    }

    // The empty state DESCRIBES THE SURFACE and does not speak first — the one place a chat is most
    // tempted to write an opening line, in the one product whose chat is defined by not having one.
    func testTheEmptyStateDescribesTheSurfaceRatherThanOpeningTheConversation() {
        XCTAssertTrue(AskThreads.empty.contains("in your own words"))
        XCTAssertTrue(AskThreads.empty.contains("with what came of it"))
        XCTAssertFalse(AskThreads.empty.lowercased().contains("coach"))
        XCTAssertFalse(AskThreads.empty.contains("?"))
    }

    // DELETE DELETES THE CONVERSATION, NOT THE CONSEQUENCE, and the sentence under the button says
    // both halves before the tap rather than a dialog after it.
    func testTheDeleteSaysWhatItTakesAndWhatItLeaves() {
        XCTAssertEqual(AskThreads.deleteNote,
                       "The conversation goes for good. A change you applied stays in the routine’s "
                       + "history — that is a fact about your program, not a message.")
    }
}

final class ThreadTrailTests: XCTestCase {
    private func head(_ source: String) throws -> ProposalHead {
        let wire = """
        {"id":"prop_1","routineId":"rt_1","intent":"revise","state":"applied","changeCount":4,
         "createdAt":1754000000000,"settledAt":1754600000000,"source":\(source)}
        """
        return try JSONDecoder().decode(ProposalHead.self, from: Data(wire.utf8))
    }

    // THE TRAIL RUNS BOTH WAYS. A change that came out of a conversation carries its thread id, so
    // the routine's history row can open the conversation it came from.
    func testAProposalFromAskCarriesTheConversationItCameFrom() throws {
        let minted = try head(#"{"door":"ask","thread":"thr_0a1b2c3d"}"#)

        XCTAssertEqual(minted.source.door, "ask")
        XCTAssertEqual(minted.source.thread, "thr_0a1b2c3d")
        XCTAssertEqual(minted.source.agentName, "Ask")
    }

    // AND THE CONSEQUENCE OUTLIVES THE CONVERSATION. A thread the lifter deleted leaves its applied
    // change standing in the routine's history — that is a fact about a program rather than a
    // message — and the row still says the change came from Ask. What is absent is the thread id,
    // and the door onto it is offered only where that key is present: never inferred from the door.
    func testDeletingTheConversationLeavesTheChangeAndTakesOnlyTheDoorOntoIt() throws {
        let orphaned = try head(#"{"door":"ask"}"#)

        XCTAssertNil(orphaned.source.thread)
        XCTAssertEqual(orphaned.source.door, "ask")
        XCTAssertEqual(orphaned.state, .applied)
        XCTAssertEqual(orphaned.changeCount, 4)
        XCTAssertEqual(orphaned.historyLine(now: 1_754_600_000_000),
                       "today · applied 4 changes from Ask")
    }

    // The MCP door had no conversation to begin with, so its rows carry no thread either — and the
    // absence reads identically to a deleted one, which is the whole reason the door is drawn off
    // the key rather than off `door == "ask"`.
    func testAChangeThroughTheMcpDoorCarriesNoConversation() throws {
        let minted = try head(#"{"door":"mcp","connection":"cx_1"}"#)

        XCTAssertNil(minted.source.thread)
        XCTAssertEqual(minted.source.agentName, "your connected agent")
    }
}
