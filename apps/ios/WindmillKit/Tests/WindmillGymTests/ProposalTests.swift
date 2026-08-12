import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// WHAT HAS TO BE TRUE FOR AN AGENT NEVER TO CHANGE A PROGRAM ON ITS OWN. The safety of this whole
// wave is one sentence — it reads, it proposes, it never writes to your program — and these are the
// places this surface could quietly stop making it true: a button that promises to apply fewer
// changes than the tap applies, a card that survives the human's own hand on the routine, a diff
// that draws four of five rows, a proposal drawn for a lifter who has no account, and an apply that
// lands over a base that has moved.
//
// The rows and the sentences are pinned here as well as the writes, because on this surface a
// sentence IS the safety: `Apply all 4` is the whole of what the lifter is agreeing to.

private func refusal(_ status: Int, code: String = "", message: String) -> WindmillApiError {
    let body = code.isEmpty
        ? #"{"error":"\#(message)"}"#
        : #"{"error":"\#(message)","code":"\#(code)"}"#
    return .refused(status, Refusal(Data(body.utf8)))
}

final class ProposalReadingTests: XCTestCase {
    // The wire's exact shape, decoded whole: the head's fields sit on the SAME flat object as the
    // diff, an absent `settledAt` is a proposal still waiting, and `kept` rows arrive and are not
    // changes. Written out as bytes rather than built with initialisers, because a CodingKey that
    // drifted from the server's name is the one failure a round trip through our own encoder could
    // never catch.
    func testTheWholeProposalDecodesFromTheWiresOwnShape() throws {
        let wire = """
        {"id":"prop_1","routineId":"rt_1","intent":"revise","state":"pending",
         "summary":"Four weeks of heavier bench triples.","changeCount":4,
         "createdAt":1700000000000,"source":{"door":"mcp","agent":"Claude"},
         "baseRevision":1,"baseName":"Push A","name":"Push A",
         "changes":[
           {"position":1,"kind":"retargeted","exerciseId":"bench-press",
            "before":{"sets":5,"reps":5,"weightKg":82.5,"restSeconds":180},
            "after":{"sets":5,"reps":3,"weightKg":87.5,"restSeconds":180}},
           {"position":2,"kind":"kept","exerciseId":"overhead-press",
            "before":{"sets":3,"reps":8,"weightKg":45},"after":{"sets":3,"reps":8,"weightKg":45}},
           {"position":3,"kind":"added","exerciseId":"incline-db-press",
            "after":{"sets":3,"reps":10,"weightKg":24}},
           {"position":4,"kind":"removed","exerciseId":"cable-fly",
            "before":{"sets":3,"reps":12,"weightKg":22.5},"loggedSets":41}]}
        """
        let proposal = try JSONDecoder().decode(Proposal.self, from: Data(wire.utf8))

        XCTAssertEqual(proposal.id, "prop_1")
        XCTAssertEqual(proposal.routineId, "rt_1")
        XCTAssertEqual(proposal.intent, .revise)
        XCTAssertEqual(proposal.state, .pending)
        XCTAssertEqual(proposal.head.summary, "Four weeks of heavier bench triples.")
        XCTAssertEqual(proposal.head.changeCount, 4)
        XCTAssertEqual(proposal.head.createdAtMs, 1_700_000_000_000)
        XCTAssertNil(proposal.head.settledAtMs)
        XCTAssertEqual(proposal.head.source.agent, "Claude")
        XCTAssertEqual(proposal.head.source.agentName, "Claude")
        XCTAssertEqual(proposal.baseRevision, 1)
        XCTAssertEqual(proposal.baseName, "Push A")
        XCTAssertEqual(proposal.name, "Push A")
        XCTAssertEqual(proposal.changes.map(\.kind), [.retargeted, .kept, .added, .removed])
        XCTAssertEqual(proposal.changes[0].before,
                       ProposalChange.Targets(sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180))
        XCTAssertNil(proposal.changes[2].before)
        XCTAssertNil(proposal.changes[3].after)
        XCTAssertEqual(proposal.changes[3].loggedSets, 41)
    }

    // A WORD THIS BUILD HAS NEVER HEARD OF FAILS THE READ. It is the one place in gym where a
    // lenient default is not honest: a row folded to `kept` would be a change missing from a diff
    // the lifter taps Apply on once, for all of it — so the room draws nothing rather than a
    // partial truth with a button under it.
    func testAKindThisBuildDoesNotKnowRefusesTheWholeRead() {
        let wire = """
        {"id":"prop_1","routineId":"rt_1","intent":"revise","state":"pending","changeCount":1,
         "createdAt":1,"source":{"door":"mcp"},"baseRevision":1,"baseName":"Push A","name":"Push A",
         "changes":[{"position":1,"kind":"reordered","exerciseId":"bench-press"}]}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(Proposal.self, from: Data(wire.utf8)))
    }

    func testAStateThisBuildDoesNotKnowRefusesTheWholeRead() {
        let wire = """
        {"id":"prop_1","routineId":"rt_1","intent":"revise","state":"expired","changeCount":0,
         "createdAt":1,"source":{"door":"mcp"}}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(ProposalHead.self, from: Data(wire.utf8)))
    }

    // The wire omits `agent` today — the transport carries no identity for the server to store — so
    // every surface renders a fallback or renders a blank where the author should be.
    func testAnUnnamedAgentIsCalledWhatItHonestlyIs() {
        XCTAssertEqual(ProposalSource(door: "mcp").agentName, "your connected agent")
        XCTAssertEqual(ProposalSource(door: "ask").agentName, "Ask")
        XCTAssertEqual(ProposalSource(door: "").agentName, "your connected agent")
        XCTAssertEqual(ProposalSource(door: "mcp", agent: "Claude").agentName, "Claude")
    }
}

final class ProposalDiffTests: XCTestCase {
    private func change(_ kind: ProposalChange.Kind, _ exerciseId: String, position: Int = 1,
                        before: ProposalChange.Targets? = nil, after: ProposalChange.Targets? = nil,
                        loggedSets: Int? = nil) -> ProposalChange {
        ProposalChange(position: position, kind: kind, exerciseId: exerciseId,
                       before: before, after: after, loggedSets: loggedSets)
    }

    private func proposal(_ changes: [ProposalChange], changeCount: Int? = nil,
                          intent: ProposalIntent = .revise, state: ProposalState = .pending,
                          settledAtMs: Int64? = nil, baseName: String = "Push A",
                          name: String? = nil) -> Proposal {
        Proposal(head: ProposalHead(id: "prop_1", routineId: "rt_1", intent: intent, state: state,
                                    changeCount: changeCount ?? changes.filter { $0.kind != .kept }.count,
                                    createdAtMs: 1_000, settledAtMs: settledAtMs,
                                    source: ProposalSource(door: "mcp", agent: "Claude")),
                 baseRevision: 1, baseName: baseName, name: name ?? baseName, changes: changes)
    }

    // `sets 5 × 5 → 5 × 3` and `weight 82.5 → 87.5` — sets and reps are ONE move and not two,
    // because `5 × 5` is how this product says what a movement is asked for on every other screen.
    // Rest that did not move draws nothing at all: a diff lists what changed.
    func testARetargetedRowSpellsOnlyTheFieldsThatMoved() {
        let moves = change(.retargeted, "bench-press",
                           before: ProposalChange.Targets(sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180),
                           after: ProposalChange.Targets(sets: 5, reps: 3, weightKg: 87.5, restSeconds: 180)).moves

        XCTAssertEqual(moves.map(\.field), ["sets", "weight"])
        XCTAssertEqual(moves[0].before, "5 × 5")
        XCTAssertEqual(moves[0].after, "5 × 3")
        XCTAssertEqual(moves[1].before, "82.5")
        XCTAssertEqual(moves[1].after, "87.5")
    }

    // A target the proposal declines to name is the product's own mark for a fact it does not have,
    // and never a zero: `3 × max` is a movement taken to whatever it gives that day, and an absent
    // weight is whatever you did last time. Printing 0 would put a number nobody chose on screen.
    func testATargetTheProposalDeclinesToNameIsADashAndNeverAZero() {
        let moves = change(.retargeted, "chin-up",
                           before: ProposalChange.Targets(sets: 3, reps: 8, weightKg: 20, restSeconds: 180),
                           after: ProposalChange.Targets(sets: 3, reps: nil, weightKg: nil, restSeconds: nil)).moves

        XCTAssertEqual(moves.map(\.field), ["sets", "weight", "rest"])
        XCTAssertEqual(moves[0].after, "3 × max")
        XCTAssertEqual(moves[1].after, "—")
        XCTAssertEqual(moves[2].before, "3:00")
        XCTAssertEqual(moves[2].after, "—")
    }

    // The PLACE is part of the change: a movement arriving third is a different program from the
    // same movement arriving first.
    func testAnAddedRowNamesWhatItComesAfter() {
        let added = change(.added, "incline-db-press", position: 3,
                           after: ProposalChange.Targets(sets: 3, reps: 10, weightKg: 24))

        XCTAssertEqual(added.addedLine(after: "Bench Press"), "added · 3 × 10 · 24 · after Bench Press")
        XCTAssertEqual(added.addedLine(after: nil), "added · 3 × 10 · 24 · first in the routine")
    }

    // What a removal does NOT touch, and zero is a real answer rather than a missing one — a
    // movement removed before it was ever trained says so instead of pretending the reassurance
    // applies to it.
    func testARemovedRowCountsTheLoggedSetsItKeeps() {
        XCTAssertEqual(change(.removed, "cable-fly", loggedSets: 41).removedLine,
                       "removed from the routine · 41 logged sets kept")
        XCTAssertEqual(change(.removed, "cable-fly", loggedSets: 1).removedLine,
                       "removed from the routine · 1 logged set kept")
        XCTAssertEqual(change(.removed, "cable-fly", loggedSets: 0).removedLine,
                       "removed from the routine · never logged")
    }

    // A `kept` row is what the routine already says. Drawing it as a change would put rows of
    // nothing between the lifter and the two that matter — and a renamed routine IS a change,
    // because the count under the button includes it.
    func testTheRowsAreTheChangesAndTheKeptLinesAreNotAmongThem() {
        let drawn = proposal([
            change(.retargeted, "bench-press", position: 1,
                   before: ProposalChange.Targets(sets: 5, reps: 5),
                   after: ProposalChange.Targets(sets: 5, reps: 3)),
            change(.kept, "overhead-press", position: 2,
                   before: ProposalChange.Targets(sets: 3, reps: 8),
                   after: ProposalChange.Targets(sets: 3, reps: 8)),
            change(.added, "incline-db-press", position: 3,
                   after: ProposalChange.Targets(sets: 3, reps: 10)),
        ], name: "Push A — heavy").rows

        guard case .renamed(let from, let to) = drawn.first else {
            return XCTFail("a renamed routine is a row of the diff")
        }
        XCTAssertEqual([from, to], ["Push A", "Push A — heavy"])
        XCTAssertEqual(drawn.count, 3)
        guard case .entry(let retargeted, _) = drawn[1], case .entry(let added, let follows) = drawn[2] else {
            return XCTFail("the two moved entries are drawn, the kept one is not")
        }
        XCTAssertEqual(retargeted.exerciseId, "bench-press")
        XCTAssertEqual(added.exerciseId, "incline-db-press")
        // Position 2 is the kept line — the run is the document, so an added row at 3 comes after it.
        XCTAssertEqual(follows, "overhead-press")
    }

    // THE ONE SENTENCE THAT MAY NEVER BE WRONG. Apply is atomic against the whole document, so the
    // count under the thumb is the SERVER's and never the rows this build managed to draw: a build
    // that rendered two of five must still not promise to apply two.
    func testTheButtonPromisesTheServersCountAndNotTheRowsItDrew() {
        let short = proposal([
            change(.retargeted, "bench-press", position: 1,
                   before: ProposalChange.Targets(sets: 5, reps: 5),
                   after: ProposalChange.Targets(sets: 5, reps: 3)),
        ], changeCount: 5)

        XCTAssertEqual(short.rows.count, 1)
        XCTAssertEqual(short.applyLabel, "Apply all 5")
        XCTAssertEqual(short.footnote, "All five or none. Nothing is applied until you tap.")
    }

    // The count is a WORD in the sentence and a NUMERAL on the button, and one change is not "all
    // one or none" — there is nothing for it to be all of.
    func testTheFootnoteSaysWhatTheTapDoesAtEveryCount() {
        XCTAssertEqual(proposal([], changeCount: 1).footnote, "Nothing is applied until you tap.")
        XCTAssertEqual(proposal([], changeCount: 4).footnote,
                       "All four or none. Nothing is applied until you tap.")
        XCTAssertEqual(proposal([], changeCount: 13).footnote,
                       "All 13 or none. Nothing is applied until you tap.")
    }

    // A removal is not counted at the thumb, because "Apply all 3" says nothing about what the tap
    // takes away. It names the routine and it names what survives.
    func testARemovalNamesTheRoutineItWouldTakeAndWhatSurvivesIt() {
        let removal = proposal([change(.removed, "cable-fly", loggedSets: 41)], intent: .remove)

        XCTAssertEqual(removal.applyLabel, "Remove Push A")
        XCTAssertEqual(removal.footnote,
                       "The routine goes and your logged sets stay. Nothing is removed until you tap.")
    }

    // Settled states say so WITH A TIMESTAMP AND STAY — the program's history, not a toast that
    // disappears. The one outcome the lifter did not choose explains itself.
    func testASettledProposalKeepsItsTimestampAndItsWords() {
        let day = Int64(1_700_000_000_000)
        let applied = proposal([], changeCount: 3, state: .applied, settledAtMs: day)
        let dismissed = proposal([], changeCount: 3, state: .dismissed, settledAtMs: day)
        let asideNote = proposal([], changeCount: 3, state: .superseded, settledAtMs: day)
            .settledNote(now: day)

        XCTAssertNil(proposal([], changeCount: 3).settledNote(now: day))
        XCTAssertEqual(applied.settledNote(now: day),
                       "Applied to Push A today at \(Readout.time(day)). Kept on the routine as a dated record — the program’s history, not a toast that disappears.")
        XCTAssertEqual(dismissed.settledNote(now: day),
                       "Dismissed today at \(Readout.time(day)). No reason asked for, nothing changed, and it stays in the routine’s history in case you want it back.")
        XCTAssertEqual(asideNote,
                       "Push A changed after this was written, so it was set aside today at \(Readout.time(day)). None of it was applied, and it stays in the routine’s history.")
    }

    // The routine's History row (§B screen 6), and it reads off the day the record is ABOUT — a
    // proposal written on Sunday and applied on Tuesday belongs to Tuesday in the program's history.
    func testAHistoryRowNamesTheDayTheDecisionWasTakenAndWhoWroteIt() {
        let now = Int64(1_700_000_000_000)
        let head = { (state: ProposalState, count: Int) in
            ProposalHead(id: "prop_1", routineId: "rt_1", state: state, changeCount: count,
                         createdAtMs: now - 172_800_000, settledAtMs: now,
                         source: ProposalSource(door: "mcp", agent: "Claude"))
        }

        XCTAssertEqual(head(.applied, 3).historyLine(now: now), "today · applied 3 changes from Claude")
        XCTAssertEqual(head(.dismissed, 1).historyLine(now: now), "today · dismissed 1 change from Claude")
        XCTAssertEqual(head(.superseded, 3).historyLine(now: now), "today · set aside 3 changes from Claude")
    }

    // The card carries the AGENT's own words, and when there are none it states a count rather than
    // inventing a sentence: the words a lifter is about to judge are the words the agent wrote.
    func testTheCardNeverPutsWordsInTheAgentsMouth() {
        let quiet = ProposalHead(id: "prop_1", routineId: "rt_1", changeCount: 4, createdAtMs: 1)
        let spoken = ProposalHead(id: "prop_2", routineId: "rt_1", summary: "Heavier triples.",
                                  changeCount: 4, createdAtMs: 1)

        XCTAssertEqual(quiet.line(about: "Push A"), "4 changes to Push A.")
        XCTAssertEqual(spoken.line(about: "Push A"), "Heavier triples.")
        XCTAssertEqual(quiet.reviewLabel, "Review 4 changes")
    }

    // The routines list's marker COUNTS what is waiting. The board draws `1 proposal` because it
    // drew one; the ledger keeps one per door, so two doors put two on a routine and the mark has
    // to say two — the one number that marker exists to give.
    func testTheRoutinesMarkerCountsWhatIsWaitingRatherThanAssumingOne() {
        XCTAssertEqual(ProposalHead.waitingLine(1), "1 proposal")
        XCTAssertEqual(ProposalHead.waitingLine(2), "2 proposals")
    }
}

// The store's half: what a tap actually does, proved against a log that enforces the two rules the
// safety rests on — a base that has moved refuses, and a decision already taken is not taken twice.
@MainActor
final class ProposalStoreTests: XCTestCase {
    private var queueURL: URL!

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-prop-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: queueURL.appendingPathExtension("cat"))
        try? FileManager.default.removeItem(at: queueURL.appendingPathExtension("local"))
    }

    // `sync` answers the way the real one does — a client for an account and nothing at all for
    // nobody — because half of what these tests pin is what the signed-out room does NOT ask for.
    private func store(_ server: FakeTraining) -> TrainingStore {
        var ms: Int64 = 1_000
        return TrainingStore(queue: SetQueue(url: queueURL),
                             deviceCatalog: DeviceCatalog(url: queueURL.appendingPathExtension("cat")),
                             localLog: LocalLog(url: queueURL.appendingPathExtension("local")),
                             now: { ms += 1; return ms },
                             undoWindowMs: 0,
                             sync: { $0.isSignedIn ? server : nil })
    }

    private func account(signedIn: Bool) -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: signedIn ? User(id: "u1", email: "sam@example.com", name: "Sam") : nil)
    }

    private func pushA(_ weightKg: Double = 82.5) -> Routine {
        Routine(id: "rt_1", name: "Push A", position: 0,
                entries: [RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5,
                                       targetReps: 5, targetWeightKg: weightKg)])
    }

    private func heavier(_ id: String = "prop_1", state: ProposalState = .pending,
                         intent: ProposalIntent = .revise, baseRevision: Int = 1,
                         createdAtMs: Int64 = 5_000, settledAtMs: Int64? = nil,
                         door: String = "mcp", agent: String = "Claude") -> Proposal {
        Proposal(head: ProposalHead(id: id, routineId: "rt_1", intent: intent, state: state,
                                    summary: "Heavier triples.", changeCount: 1,
                                    createdAtMs: createdAtMs, settledAtMs: settledAtMs,
                                    source: ProposalSource(door: door, agent: agent)),
                 baseRevision: baseRevision, baseName: "Push A", name: "Push A",
                 changes: [ProposalChange(position: 1, kind: .retargeted, exerciseId: "bench-press",
                                          before: ProposalChange.Targets(sets: 5, reps: 5, weightKg: 82.5),
                                          after: ProposalChange.Targets(sets: 5, reps: 3, weightKg: 87.5))])
    }

    private func seeded() -> FakeTraining {
        let server = FakeTraining()
        server.written["rt_1"] = pushA()
        server.revisions["rt_1"] = 1
        server.ledger = [heavier()]
        return server
    }

    // NO ACCOUNT, NO PROPOSAL, and the signed-out room does not merely hide the card — it never
    // asks. A proposal belongs to an account, so there is no anonymous half of this object, nothing
    // on the device's shelf, and nothing for the claim to replay when an account finally arrives.
    func testSignedOutTheRoomNeitherDrawsAProposalNorAsksForOne() async {
        let server = seeded()
        let store = store(server)

        await store.connect(to: account(signedIn: false))

        XCTAssertEqual(store.proposals, [])
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(store.history(of: "rt_1"), [])
        XCTAssertEqual(server.calls, [])

        // And the claim, which replays everything this device was holding, replays no decision:
        // the ledger it signs in to is exactly the one the log already had.
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.calls.filter { $0 == "applyProposal" || $0 == "dismissProposal" }, [])
        XCTAssertEqual(store.proposals.map(\.id), ["prop_1"])
        XCTAssertEqual(server.ledger.map(\.state), [.pending])
    }

    // One read answers every card and every history row. The pending one waits on its routine; the
    // settled ones are that routine's history, whichever way they went.
    func testOneReadAnswersBothTheWaitingCardAndTheRoutinesHistory() async {
        let server = seeded()
        server.ledger.append(heavier("prop_0", state: .dismissed, settledAtMs: 4_000))
        let store = store(server)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.proposals.map(\.id), ["prop_1", "prop_0"])
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])
        XCTAssertEqual(store.history(of: "rt_1").map(\.id), ["prop_0"])
    }

    // THE TAP. The routine that comes back is the one that now stands — nothing here composes what
    // the change did — and the card is settled rather than removed, because an agent's suggestion
    // is part of the program's history.
    func testApplyingLandsTheRoutineTheLogAnswersWithAndKeepsTheRecord() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))

        let outcome = await store.apply(server.ledger[0])

        guard case .settled(let settled) = outcome else { return XCTFail("apply landed: \(outcome)") }
        XCTAssertEqual(settled.state, .applied)
        XCTAssertEqual(store.routines.first?.entries.first?.targetWeightKg, 87.5)
        XCTAssertEqual(store.routines.first?.entries.first?.targetReps, 3)
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(store.history(of: "rt_1").map(\.state), [.applied])
    }

    // A PROPOSAL WHOSE ROUTINE MOVED UNDERNEATH IT IS SET ASIDE, NEVER MERGED OVER THE TOP. This is
    // the whole of what the base revision buys: the diff was written against 82.5 × 5, the lifter
    // has since put 90 on the routine themselves, and the tap must not quietly take that back.
    func testApplyingOverARoutineThatMovedIsRefusedAndTheProgramIsUntouched() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let stale = server.ledger[0]
        // The human's own hand, from anywhere: a mid-session save, another phone, the web.
        _ = try? await server.replaceRoutine("rt_1", with: RoutineWrite(pushA(90)))

        let outcome = await store.apply(stale)

        guard case .settled(let settled) = outcome else { return XCTFail("set aside: \(outcome)") }
        XCTAssertEqual(settled.state, .superseded)
        XCTAssertEqual(server.written["rt_1"]?.entries.first?.targetWeightKg, 90)
        XCTAssertEqual(store.routines.first?.entries.first?.targetWeightKg, 90)
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(store.history(of: "rt_1").map(\.state), [.superseded])
    }

    // The mid-session "save 87.5 to Push A" is the same hand, taken through this device — so the
    // card it sets aside on the server has to leave this screen in the same breath. A card left
    // behind would be offering a diff against a base that no longer stands.
    func testTheLiftersOwnSaveTakesTheWaitingCardWithIt() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])

        let failed = await store.save(95, toRoutine: "rt_1", for: "bench-press")

        XCTAssertNil(failed)
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(store.history(of: "rt_1").map(\.state), [.superseded])
    }

    // Dismissing asks for no reason, changes nothing, and is still a DECISION — it goes to the log
    // and comes back as the dated record the routine keeps.
    func testDismissingChangesNothingAndIsStillWrittenDown() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))

        let outcome = await store.dismiss("prop_1")

        guard case .settled(let settled) = outcome else { return XCTFail("dismissed: \(outcome)") }
        XCTAssertEqual(settled.state, .dismissed)
        XCTAssertEqual(store.routines.first, pushA())
        XCTAssertEqual(store.history(of: "rt_1").map(\.state), [.dismissed])
    }

    // The OTHER decision, already taken — from the web, or the other phone. Terminal, and drawn as
    // what the log holds rather than as what this device hoped: nothing is applied over it.
    func testADecisionAlreadyTakenComesBackTheWayItWasTaken() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let waiting = server.ledger[0]
        _ = try? await server.dismissProposal("prop_1")

        let outcome = await store.apply(waiting)

        guard case .settled(let settled) = outcome else { return XCTFail("already settled: \(outcome)") }
        XCTAssertEqual(settled.state, .dismissed)
        XCTAssertEqual(store.routines.first, pushA())
    }

    // An applied removal takes the routine AND its whole ledger — the server cascades the rows, so
    // asking again answers 404, and on this one intent that 404 is the receipt rather than a
    // refusal. A screen that read it as an error would leave a routine on screen that is gone.
    func testAppliedRemovalTakesTheRoutineAndReplaysAsGoneRatherThanAsAnError() async {
        let server = seeded()
        server.ledger = [heavier(intent: .remove)]
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let removal = server.ledger[0]

        let outcome = await store.apply(removal)
        let again = await store.apply(removal)

        XCTAssertEqual(outcome, .removed)
        XCTAssertEqual(again, .removed)
        XCTAssertEqual(store.routines, [])
        XCTAssertEqual(store.proposals, [])
        XCTAssertNil(server.written["rt_1"])
    }

    // A LOG THAT WENT QUIET IS NOT A DECISION. The card stays exactly where it was, the routine is
    // untouched, and the lifter is told — a tap that silently did nothing is the same screen as a
    // tap that worked.
    func testATapTheLogNeverAnsweredLeavesTheCardWhereItWas() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let waiting = server.ledger[0]
        server.online = false

        let outcome = await store.apply(waiting)

        XCTAssertEqual(outcome, .failed(.noAnswer))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])
        XCTAssertEqual(server.ledger.map(\.state), [.pending])
    }

    // A refusal that is neither of the two terminal 409s is repeated in the LOG'S OWN WORDS rather
    // than folded into a settlement it may not be — the code is the contract, never the sentence.
    func testARefusalThisBuildDoesNotKnowIsSaidRatherThanSettled() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let waiting = server.ledger[0]
        server.refuseApply = refusal(409, code: "routine-locked", message: "hold on")

        let outcome = await store.apply(waiting)

        XCTAssertEqual(outcome, .failed(.refused("hold on")))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])
        XCTAssertEqual(server.ledger.map(\.state), [.pending])
    }

    // APPLYING ONE CARD SETS EVERY OTHER CARD ON THAT ROUTINE ASIDE, and this device has to stop
    // drawing them in the same breath. The server does it inside the apply transaction, exactly as
    // the lifter's own PUT does — so a room that only settled the row it tapped would leave a
    // second Apply button over a base that is gone, and the tap under it would 409 forever.
    func testApplyingSetsEveryOtherCardOnThatRoutineAsideHereToo() async {
        let server = seeded()
        // Two doors, each with one waiting — the ledger's rule is one per (routine, door), not one
        // per routine. Newest first, as the log answers.
        server.ledger.insert(heavier("prop_2", createdAtMs: 6_000, door: "ask", agent: "Ask"), at: 0)
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_2", "prop_1"])

        let outcome = await store.apply(server.ledger[0])

        guard case .settled(let settled) = outcome else { return XCTFail("apply landed: \(outcome)") }
        XCTAssertEqual(settled.id, "prop_2")
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: store.history(of: "rt_1").map { ($0.id, $0.state) }),
                       ["prop_2": .applied, "prop_1": .superseded])
        XCTAssertEqual(server.ledger.map(\.state), [.applied, .superseded])
    }

    // The count on the routines list is a COUNT: two doors put two cards on one routine, the marker
    // says so, and the tap opens the newest of them.
    func testTwoDoorsPutTwoProposalsOnOneRoutineAndTheNewestIsTheDoor() async {
        let server = seeded()
        server.ledger.insert(heavier("prop_2", createdAtMs: 6_000, door: "ask", agent: "Ask"), at: 0)
        let store = store(server)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_2", "prop_1"])
        XCTAssertEqual(ProposalHead.waitingLine(store.pending(of: "rt_1").count), "2 proposals")
        XCTAssertEqual(store.pending(of: "rt_1").first?.source.agentName, "Ask")
    }

    // A DECISION ON A ROW THE LOG NO LONGER HOLDS TAKES THE CARD WITH IT. There is no state to draw
    // and no dated record to keep, so the row is dropped rather than settled — one left behind would
    // wait on Today and on its routine, offering a decision with nowhere to land, and the screen
    // behind the tap would only ever redraw the same sentence.
    func testATapOnARowTheLogNoLongerHoldsTakesTheCardWithIt() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let waiting = server.ledger[0]
        server.ledger = []

        let outcome = await store.dismiss(waiting.id)

        XCTAssertEqual(outcome, .gone)
        XCTAssertEqual(store.proposals, [])
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(store.routines, [pushA()])
    }

    // The same fact through the other door: the READ on the way into the diff screen. It is the same
    // answer about the same list, so it drops the same card.
    func testAReadThatFindsNothingTakesTheCardWithItToo() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        server.ledger = []

        let read = await store.proposal("prop_1")

        XCTAssertEqual(read, .failure(.refused("that proposal is no longer on the log")))
        XCTAssertEqual(store.proposals, [])
    }

    // A REMOVAL'S 404 IS ONLY A RECEIPT WHERE THE ROUTINE REALLY WENT. The cascade is the server's
    // invariant and this device asks rather than borrows it: told a routine is gone when it is not,
    // the room would take a live day off the screen and say the lifter's logged sets are all that
    // survived it.
    func testARemovalWhoseRoutineStillStandsIsNotReadAsAReceipt() async {
        let server = seeded()
        server.ledger = [heavier(intent: .remove)]
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let removal = server.ledger[0]
        // The proposal is gone; the routine is not — which is the shape a cascade can never make.
        server.ledger = []

        let outcome = await store.apply(removal)

        XCTAssertEqual(outcome, .gone)
        XCTAssertEqual(store.routines, [pushA()])
        XCTAssertEqual(store.proposals, [])
        XCTAssertNotNil(server.written["rt_1"])
    }

    // THE HISTORY SECTION RUNS IN THE ORDER ITS OWN DATES READ. The log answers newest-MINTED and
    // every row prints the day it was DECIDED — so a proposal written last week and dismissed this
    // morning belongs at the top, and a section sorted the other way puts its dates on screen
    // running backwards.
    func testTheRoutinesHistoryIsOrderedByTheDayEachRowPrints() async {
        let server = seeded()
        server.ledger = [heavier("prop_new", state: .dismissed, createdAtMs: 7_000, settledAtMs: 8_000),
                         heavier("prop_old", state: .applied, createdAtMs: 5_000, settledAtMs: 20_000)]
        let store = store(server)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.proposals.map(\.id), ["prop_new", "prop_old"])
        XCTAssertEqual(store.history(of: "rt_1").map(\.id), ["prop_old", "prop_new"])
        XCTAssertEqual(store.history(of: "rt_1").map(\.recordedAtMs), [20_000, 8_000])
    }

    // A read that missed draws NOTHING, and that is the honest silence: no surface in gym ever says
    // "nothing is waiting for you", so an absent card asserts nothing at all — where a card carried
    // over from a read that never answered would assert that one is waiting, under a seat that may
    // not even be the same account.
    func testAProposalsReadThatMissedDrawsNothingRatherThanAStaleCard() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])
        server.refuseProposals = refusal(503, message: "unavailable")

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(store.history(of: "rt_1"), [])
    }
}
