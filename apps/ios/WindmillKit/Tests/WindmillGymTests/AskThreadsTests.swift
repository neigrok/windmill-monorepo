import XCTest
@testable import WindmillGym

private func thread(_ kind: ThreadOutcome.Kind, changes: Int = 0,
                    routine: String? = nil, askedAtMs: Int64 = 1_000) -> AskThread {
    AskThread(id: "thr_1", title: "q", createdAtMs: askedAtMs, askedAtMs: askedAtMs,
              outcome: ThreadOutcome(kind: kind, changes: changes,
                                     routineId: routine == nil ? nil : "rt_1", routine: routine))
}

private func at(year: Int, month: Int, day: Int) -> Int64 {
    let parts = DateComponents(year: year, month: month, day: day, hour: 9)
    let moment = Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
    return Int64(moment.timeIntervalSince1970 * 1000)
}

final class AskThreadWireTests: XCTestCase {
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
        XCTAssertNil(listed.turns)
    }

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

    func testATurnInAVoiceThisBuildDoesNotKnowIsNotDrawnAndTheRestOfTheThreadStillIs() throws {
        let wire = """
        {"id":"thr_1","title":"q","createdAt":1,"askedAt":1,
         "outcome":{"kind":"read-only","changes":0},
         "turns":[{"from":"lifter","text":"q","at":1},
                  {"from":"assistant","text":"hello","at":2},
                  {"text":"no voice at all","at":3},
                  {"from":3,"text":"not even a word","at":4},
                  {"from":null,"text":"null","at":5}]}
        """
        let read = try JSONDecoder().decode(AskThread.self, from: Data(wire.utf8))

        XCTAssertEqual(read.turns?.map(\.from), [.lifter, .unknown, .unknown, .unknown, .unknown])
        XCTAssertEqual(read.turns?.filter(\.isDrawn), [AskTurn(from: .lifter, text: "q", atMs: 1)])
    }

    func testTheTitleIsTheLiftersOwnWordsUntouched() throws {
        let typed = "  why is my e1RM going DOWN 😤 when the weight goes up?? "
        let wire = """
        {"id":"thr_1","title":\(quoted(typed)),"createdAt":1,"askedAt":1,
         "outcome":{"kind":"read-only","changes":0}}
        """
        let listed = try JSONDecoder().decode(AskThread.self, from: Data(wire.utf8))

        XCTAssertEqual(listed.title, typed)
    }

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
    func testEveryOutcomeSaysWhatTheLedgerHolds() {
        XCTAssertEqual(thread(.applied, changes: 4, routine: "Push A").outcome.line,
                       "4 changes → Push A")
        XCTAssertEqual(thread(.readOnly).outcome.line, "no changes proposed")
        XCTAssertEqual(thread(.proposed, changes: 2).outcome.line, "2 changes waiting")
        XCTAssertEqual(thread(.dismissed, changes: 4).outcome.line, "4 changes turned down")
        XCTAssertEqual(thread(.superseded, changes: 6).outcome.line, "6 changes set aside")
    }

    func testChangesAcrossMoreThanOneRoutineNameNoneOfThem() {
        XCTAssertEqual(ThreadOutcome(kind: .applied, changes: 7).line, "7 changes")
        XCTAssertNil(ThreadOutcome(kind: .applied, changes: 7).routineId)
    }

    func testOneChangeIsSpelledInTheSingular() {
        XCTAssertEqual(ThreadOutcome(kind: .applied, changes: 1, routineId: "rt_1",
                                     routine: "Legs").line, "1 change → Legs")
        XCTAssertEqual(ThreadOutcome(kind: .dismissed, changes: 1).line, "1 change turned down")
        XCTAssertEqual(Readout.changeCount(1), "1 change")
        XCTAssertEqual(Readout.changeCount(0), "0 changes")
    }

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

    func testTheChipAndTheLineAgreeAndOnlyAnAppliedRowIsLit() {
        XCTAssertEqual(ThreadOutcome(kind: .applied, changes: 4).word, "applied")
        XCTAssertEqual(ThreadOutcome(kind: .readOnly).word, "read only")
        XCTAssertEqual(ThreadOutcome(kind: .dismissed, changes: 4).word, "turned down")
        XCTAssertEqual(ThreadOutcome(kind: .proposed, changes: 4).word, "waiting")
        XCTAssertEqual(ThreadOutcome(kind: .superseded, changes: 4).word, "set aside")

        XCTAssertTrue(ThreadOutcome(kind: .applied, changes: 4).changedTheProgram)
        for quiet in [ThreadOutcome.Kind.readOnly, .dismissed, .proposed, .superseded, .unknown] {
            XCTAssertFalse(ThreadOutcome(kind: quiet, changes: 4).changedTheProgram, quiet.rawValue)
        }
    }

    func testAMintedProposalReadsItsCountItsRoutineAndTheLogsWordForIt() {
        let minted = ThreadProposal(id: "prop_1", state: .superseded, changeCount: 3,
                                    routineId: "rt_1", routine: "Push A", createdAtMs: 1_000)

        XCTAssertEqual(minted.line, "3 changes to Push A · Set aside")
    }

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

    // One word for one act: the wire says `dismissed`, the lifter reads turned down everywhere.
    func testTheWholeSurfaceSpellsATurnedDownProposalOneWay() {
        let outcome = ThreadOutcome(kind: .dismissed, changes: 3, routineId: "rt_1", routine: "Push A")
        let minted = ThreadProposal(id: "prop_1", state: .dismissed, changeCount: 3,
                                    routineId: "rt_1", routine: "Push A", createdAtMs: 1_000)
        let head = ProposalHead(id: "prop_1", routineId: "rt_1", state: .dismissed, changeCount: 3,
                                createdAtMs: 0, settledAtMs: 0, source: ProposalSource(door: "ask"))

        XCTAssertEqual(outcome.line, "3 changes turned down")
        XCTAssertEqual(outcome.word, "turned down")
        XCTAssertEqual(minted.line, "3 changes to Push A · Turned down")
        XCTAssertEqual(ProposalState.dismissed.word, "Turned down")
        XCTAssertEqual(head.historyLine(now: 0), "today · turned down 3 changes from Coach")
        for said in [outcome.line, outcome.word ?? "", minted.line, head.historyLine(now: 0)] {
            XCTAssertFalse(said.lowercased().contains("dismiss"), said)
        }
    }
}

final class ThreadListTests: XCTestCase {
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

    func testAMonthOutsideThisYearCarriesIt() {
        let now = at(year: 2026, month: 8, day: 13)

        XCTAssertEqual(Readout.month(at(year: 2026, month: 1, day: 2), now: now), "January")
        XCTAssertEqual(Readout.month(at(year: 2024, month: 12, day: 31), now: now), "December 2024")
    }

    func testAnEmptyListIsNoMonthsAtAll() {
        XCTAssertEqual(AskThreads.months(of: [], now: 1_000), [])
    }

    func testTheHeadCountsConversationsAndSaysTheyAreYoursToDelete() {
        XCTAssertEqual(AskThreads.meta(9), "9 conversations · yours to delete")
        XCTAssertEqual(AskThreads.meta(1), "1 conversation · yours to delete")
        XCTAssertEqual(AskThreads.meta(0), "0 conversations · yours to delete")
    }

    func testAFullPageSaysAtLeastRatherThanAssertingATotalTheServerNeverSent() {
        XCTAssertEqual(AskThreads.meta(199), "199 conversations · yours to delete")
        XCTAssertEqual(AskThreads.meta(AskThreads.served), "200+ conversations · yours to delete")
    }

    func testNothingOnThisSurfaceSpeaksLikeAnInbox() {
        let never = ["unread", "badge", "notification", "notify", "new message", "inbox",
                     "search", "filter", "folder", "pin", "archive", "waiting for you"]
        let spoken = [AskThreads.title, AskThreads.door, AskThreads.askSomethingNew,
                      AskThreads.meta(9), AskThreads.emptyHead, AskThreads.empty,
                      WithheldWords.thread, WithheldWords.threadDetail,
                      AskThreads.reading, AskThreads.fromTheConversation]

        for sentence in spoken {
            for word in never {
                XCTAssertFalse(sentence.lowercased().contains(word), "\(sentence) says \(word)")
            }
        }
    }

    func testTheEmptyStateDescribesTheSurfaceRatherThanOpeningTheConversation() {
        // The head is the state, never the screen's own name: a pushed screen says its title once,
        // in the navigation bar.
        XCTAssertEqual(AskThreads.emptyHead, "Nothing here yet.")
        XCTAssertNotEqual(AskThreads.emptyHead, AskThreads.title)
        XCTAssertTrue(AskThreads.empty.contains("in your own words"))
        XCTAssertTrue(AskThreads.empty.contains("with what came of it"))
        XCTAssertFalse(AskThreads.empty.contains("?"))
    }

    // The delete block inside the conversation came off with the swipe that replaced it; what it was
    // honest about rides on the transient instead, at the moment of the act.
    func testTheDeleteSaysWhatItTakesAndWhatItLeaves() {
        XCTAssertEqual(WithheldWords.thread, "Conversation deleted.")
        XCTAssertEqual(WithheldWords.threadDetail,
                       "a change you applied stays in the routine’s history")
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

    func testAProposalFromAskCarriesTheConversationItCameFrom() throws {
        let minted = try head(#"{"door":"ask","thread":"thr_0a1b2c3d"}"#)

        XCTAssertEqual(minted.source.door, "ask")
        XCTAssertEqual(minted.source.thread, "thr_0a1b2c3d")
        XCTAssertEqual(minted.source.agentName, "Coach")
    }

    func testDeletingTheConversationLeavesTheChangeAndTakesOnlyTheDoorOntoIt() throws {
        let orphaned = try head(#"{"door":"ask"}"#)

        XCTAssertNil(orphaned.source.thread)
        XCTAssertEqual(orphaned.source.door, "ask")
        XCTAssertEqual(orphaned.state, .applied)
        XCTAssertEqual(orphaned.changeCount, 4)
        XCTAssertEqual(orphaned.historyLine(now: 1_754_600_000_000),
                       "today · applied 4 changes from Coach")
    }

    func testAChangeThroughTheMcpDoorCarriesNoConversation() throws {
        let minted = try head(#"{"door":"mcp","connection":"cx_1"}"#)

        XCTAssertNil(minted.source.thread)
        XCTAssertEqual(minted.source.agentName, "cx_1", "a connection's name counts as the agent's name")
    }
}
