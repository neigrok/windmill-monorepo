import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

private func refusal(_ status: Int, code: String = "", message: String) -> WindmillApiError {
    let body = code.isEmpty
        ? #"{"error":"\#(message)"}"#
        : #"{"error":"\#(message)","code":"\#(code)"}"#
    return .refused(status, Refusal(Data(body.utf8)))
}

final class ProposalReadingTests: XCTestCase {
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

    func testAnUnnamedAgentIsCalledWhatItHonestlyIs() {
        XCTAssertEqual(ProposalSource(door: "mcp").agentName, "your connected agent")
        XCTAssertEqual(ProposalSource(door: "ask").agentName, "Coach")
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

    func testAnOpenSideOfADiffReadsAsOpenAndIsStillBothSides() {
        let moves = change(.retargeted, "barbell-row",
                           before: ProposalChange.Targets(),
                           after: ProposalChange.Targets(sets: 4, reps: 8, weightKg: 70)).moves

        XCTAssertEqual(moves.map(\.field), ["sets", "weight"])
        XCTAssertEqual(moves[0].before, "open")
        XCTAssertEqual(moves[0].after, "4 × 8")
        XCTAssertEqual(moves[1].before, "—")
        XCTAssertEqual(moves[1].after, "70")
    }

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

    func testAnAddedRowNamesWhatItComesAfter() {
        let added = change(.added, "incline-db-press", position: 3,
                           after: ProposalChange.Targets(sets: 3, reps: 10, weightKg: 24))

        XCTAssertEqual(added.addedLine(after: "Bench Press"), "added · 3 × 10 · 24 · after Bench Press")
        XCTAssertEqual(added.addedLine(after: nil), "added · 3 × 10 · 24 · first in the routine")
    }

    func testARemovedRowCountsTheLoggedSetsItKeeps() {
        XCTAssertEqual(change(.removed, "cable-fly", loggedSets: 41).removedLine,
                       "removed from the routine · 41 logged sets kept")
        XCTAssertEqual(change(.removed, "cable-fly", loggedSets: 1).removedLine,
                       "removed from the routine · 1 logged set kept")
        XCTAssertEqual(change(.removed, "cable-fly", loggedSets: 0).removedLine,
                       "removed from the routine · never logged")
    }

    // The rows are the document as well as the diff: a kept line keeps its place among the changes.
    func testTheRowsAreTheWholeDocumentWithTheKeptLinesInTheirPlace() {
        let drawn = proposal([
            change(.retargeted, "bench-press", position: 1,
                   before: ProposalChange.Targets(sets: 5, reps: 5),
                   after: ProposalChange.Targets(sets: 5, reps: 3)),
            change(.kept, "overhead-press", position: 2,
                   before: ProposalChange.Targets(sets: 3, reps: 8),
                   after: ProposalChange.Targets(sets: 3, reps: 8)),
            change(.added, "incline-db-press", position: 3,
                   after: ProposalChange.Targets(sets: 3, reps: 10)),
        ], name: "Push A — heavy")

        guard case .renamed(let from, let to) = drawn.rows.first else {
            return XCTFail("a renamed routine is a row of the diff")
        }
        XCTAssertEqual([from, to], ["Push A", "Push A — heavy"])
        XCTAssertEqual(drawn.rows.count, 4)
        guard case .entry(let retargeted, _) = drawn.rows[1], case .kept(let kept) = drawn.rows[2],
              case .entry(let added, let follows) = drawn.rows[3] else {
            return XCTFail("every entry is drawn, in its position")
        }
        XCTAssertEqual(retargeted.exerciseId, "bench-press")
        XCTAssertEqual(kept.exerciseId, "overhead-press")
        XCTAssertEqual(added.exerciseId, "incline-db-press")
        XCTAssertEqual(follows, "overhead-press")
        XCTAssertEqual(drawn.rows.filter { !$0.isKept }.count, 3, "a change is a row that is not kept")
    }

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

    func testOneChangeIsAppliedWithoutACountAndTwoWithOne() {
        XCTAssertEqual(proposal([], changeCount: 1).applyLabel, "Apply")
        XCTAssertEqual(proposal([], changeCount: 2).applyLabel, "Apply all 2")
    }

    func testTheFootnoteSaysWhatTheTapDoesAtEveryCount() {
        XCTAssertEqual(proposal([], changeCount: 1).footnote, "Nothing is applied until you tap.")
        XCTAssertEqual(proposal([], changeCount: 4).footnote,
                       "All four or none. Nothing is applied until you tap.")
        XCTAssertEqual(proposal([], changeCount: 13).footnote,
                       "All 13 or none. Nothing is applied until you tap.")
    }

    func testARemovalNamesTheRoutineItWouldTakeAndWhatSurvivesIt() {
        let removal = proposal([change(.removed, "cable-fly", loggedSets: 41)], intent: .remove)

        XCTAssertEqual(removal.applyLabel, "Remove Push A")
        XCTAssertEqual(removal.footnote,
                       "Removes the routine from your program · every logged set stays.")
    }

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
                       "Turned down today at \(Readout.time(day)). Nothing changed, and it stays in the routine’s history as a record.")
        XCTAssertEqual(asideNote,
                       "Push A changed after this was written, so it was set aside today at \(Readout.time(day)). None of it was applied, and it stays in the routine’s history.")
    }

    // The wire has no path back from a turned-down proposal, so nothing here may suggest one.
    func testTurningDownIsSaidAsARecordAndNeverAsSomethingToTakeBack() {
        let day = Int64(1_700_000_000_000)
        let dismissed = proposal([], changeCount: 3, state: .dismissed, settledAtMs: day)
            .settledNote(now: day) ?? ""
        for promise in ["want it back", "take it back", "reopen", "undo", "restore"] {
            XCTAssertFalse(dismissed.lowercased().contains(promise), dismissed)
        }
        XCTAssertEqual(Proposal.turnDown, "Turn this down")
        XCTAssertEqual(Proposal.turnDownTitle, "Turn this down?")
        XCTAssertEqual(Proposal.turnDownBody,
                       "Nothing changes, and it stays in the routine’s history as a record.")
        XCTAssertEqual(Proposal.turnDownConfirm, "Turn down")
        XCTAssertEqual(Proposal.turnDownKeep, "Keep it")
    }

    func testAHistoryRowNamesTheDayTheDecisionWasTakenAndWhoWroteIt() {
        let now = Int64(1_700_000_000_000)
        let head = { (state: ProposalState, count: Int) in
            ProposalHead(id: "prop_1", routineId: "rt_1", state: state, changeCount: count,
                         createdAtMs: now - 172_800_000, settledAtMs: now,
                         source: ProposalSource(door: "mcp", agent: "Claude"))
        }

        XCTAssertEqual(head(.applied, 3).historyLine(now: now), "today · applied 3 changes from Claude")
        XCTAssertEqual(head(.dismissed, 1).historyLine(now: now), "today · turned down 1 change from Claude")
        XCTAssertEqual(head(.superseded, 3).historyLine(now: now), "today · set aside 3 changes from Claude")
    }

    func testTheCardNeverPutsWordsInTheAgentsMouth() {
        let quiet = ProposalHead(id: "prop_1", routineId: "rt_1", changeCount: 4, createdAtMs: 1)
        let spoken = ProposalHead(id: "prop_2", routineId: "rt_1", summary: "Heavier triples.",
                                  changeCount: 4, createdAtMs: 1)

        XCTAssertEqual(quiet.line(about: "Push A"), "4 changes to Push A.")
        XCTAssertEqual(spoken.line(about: "Push A"), "Heavier triples.")
    }

    func testTheRoutinesMarkerCountsWhatIsWaitingRatherThanAssumingOne() {
        XCTAssertEqual(ProposalHead.waitingLine(1), "1 proposal")
        XCTAssertEqual(ProposalHead.waitingLine(2), "2 proposals")
    }
}

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

    // The decided half of the ledger for one routine. The routine's own screen draws its history from
    // the wire's `Routine.history`, so this is what a decision leaves behind in the room's own state.
    private func decided(_ store: TrainingStore, of routineId: String = "rt_1") -> [ProposalHead] {
        store.proposals.filter { $0.routineId == routineId && !$0.isPending }
    }

    private func store(_ server: FakeTraining) -> TrainingStore {
        var ms: Int64 = 1_000
        return TrainingStore(queue: SetQueue(url: queueURL, deviceHolds: nil),
                             deviceCatalog: DeviceCatalog(url: queueURL.appendingPathExtension("cat")),
                             accountCopy: AccountCopy(url: queueURL.appendingPathExtension("account")),
                             localLog: LocalLog(url: queueURL.appendingPathExtension("local"), deviceHolds: nil),
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

    func testSignedOutTheRoomNeitherDrawsAProposalNorAsksForOne() async {
        let server = seeded()
        let store = store(server)

        await store.connect(to: account(signedIn: false))

        XCTAssertEqual(store.proposals, [])
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(server.calls, [])

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.calls.filter { $0 == "applyProposal" || $0 == "dismissProposal" }, [])
        XCTAssertEqual(store.proposals.map(\.id), ["prop_1"])
        XCTAssertEqual(server.ledger.map(\.state), [.pending])
    }

    func testOneReadAnswersBothTheWaitingCardAndTheRoutinesHistory() async {
        let server = seeded()
        server.ledger.append(heavier("prop_0", state: .dismissed, settledAtMs: 4_000))
        let store = store(server)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.proposals.map(\.id), ["prop_1", "prop_0"])
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])
        XCTAssertEqual(decided(store).map(\.id), ["prop_0"])
    }

    func testApplyingLandsTheRoutineTheLogAnswersWithAndKeepsTheRecord() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))

        let outcome = await store.apply(server.ledger[0])

        guard case .settled(let settled, _) = outcome else { return XCTFail("apply landed: \(outcome)") }
        XCTAssertEqual(settled.state, .applied)
        XCTAssertEqual(store.routines.first?.entries.first?.targetWeightKg, 87.5)
        XCTAssertEqual(store.routines.first?.entries.first?.targetReps, 3)
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(decided(store).map(\.state), [.applied])
    }

    func testApplyingOverARoutineThatMovedIsRefusedAndTheProgramIsUntouched() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let stale = server.ledger[0]
        _ = try? await server.replaceRoutine("rt_1", with: RoutineWrite(pushA(90)))

        let outcome = await store.apply(stale)

        guard case .settled(let settled, _) = outcome else { return XCTFail("set aside: \(outcome)") }
        XCTAssertEqual(settled.state, .superseded)
        XCTAssertEqual(server.written["rt_1"]?.entries.first?.targetWeightKg, 90)
        XCTAssertEqual(store.routines.first?.entries.first?.targetWeightKg, 90)
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(decided(store).map(\.state), [.superseded])
    }

    func testTheLiftersOwnSaveTakesTheWaitingCardWithIt() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])

        let failed = await store.save(95, toRoutine: "rt_1", at: 1, for: "bench-press")

        XCTAssertNil(failed)
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(decided(store).map(\.state), [.superseded])
    }

    func testDismissingChangesNothingAndIsStillWrittenDown() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))

        let outcome = await store.dismiss("prop_1")

        guard case .settled(let settled, _) = outcome else { return XCTFail("dismissed: \(outcome)") }
        XCTAssertEqual(settled.state, .dismissed)
        XCTAssertEqual(store.routines.first, pushA())
        XCTAssertEqual(decided(store).map(\.state), [.dismissed])
    }

    func testADecisionAlreadyTakenComesBackTheWayItWasTaken() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let waiting = server.ledger[0]
        _ = try? await server.dismissProposal("prop_1")

        let outcome = await store.apply(waiting)

        guard case .settled(let settled, _) = outcome else { return XCTFail("already settled: \(outcome)") }
        XCTAssertEqual(settled.state, .dismissed)
        XCTAssertEqual(store.routines.first, pushA())
    }

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

    // The replay reads `removed` off a routine that is really gone. A delete still inside its window
    // is not gone — nothing has been sent — so the question is what the ACCOUNT holds and not what the
    // list is drawing; read off the drawn list, one swipe and one stale card would report the routine
    // and its ledger destroyed while an Undo still reaches both.
    func testAReplayedRemovalAsksWhatTheAccountHoldsAndNotWhatTheListDraws() async {
        let server = seeded()
        server.ledger = []
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        store.withhold(routine: pushA())
        XCTAssertEqual(store.routines, [], "the row is out of the drawn list")
        XCTAssertEqual(store.allRoutines, [pushA()], "and the account still holds the routine")

        let outcome = await store.apply(heavier(intent: .remove))

        XCTAssertEqual(outcome, .gone, "the proposal is gone; the routine is not")
        XCTAssertEqual(server.written["rt_1"], pushA(), "and nothing was sent to remove it")

        store.restore(routine: pushA())
        XCTAssertEqual(store.routines, [pushA()], "the Undo still reaches it")
    }

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

    // B13: the server's 409 sentence reaches the lifter as sent. Each of the three B10 sentences rides with the
    // fresh row; a decision that landed carries no sentence at all.
    func testTheServersOwnSentenceRidesWithASetAsideProposal() async {
        let sentences = [
            "that routine changed after this proposal was written, so it was not applied",
            "a newer proposal replaced this one, so it was not applied",
            "this proposal was superseded before it was applied",
        ]
        for sentence in sentences {
            let server = seeded()
            server.ledger = [heavier(state: .superseded, settledAtMs: 9_000)]
            let store = store(server)
            await store.connect(to: account(signedIn: true))
            server.refuseApply = refusal(409, code: "proposal-superseded", message: sentence)

            let outcome = await store.apply(server.ledger[0])

            guard case .settled(let fresh, let said) = outcome else { return XCTFail("set aside: \(outcome)") }
            XCTAssertEqual(fresh.state, .superseded)
            XCTAssertEqual(said, sentence, "the server's bytes, not local words")
        }

        let server = seeded()
        server.ledger = [heavier(state: .superseded, settledAtMs: 9_000)]
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let turnedDown = await store.dismiss("prop_1")
        guard case .settled(_, let said) = turnedDown else { return XCTFail("set aside: \(turnedDown)") }
        XCTAssertEqual(said, "that proposal was already settled", "the dismiss variant rides the same way")

        let landed = seeded()
        let applying = self.store(landed)
        await applying.connect(to: account(signedIn: true))
        guard case .settled(_, let quiet) = await applying.apply(landed.ledger[0]) else { return XCTFail("landed") }
        XCTAssertNil(quiet, "a decision that landed has nothing to say beyond the receipt")
    }

    func testApplyingSetsEveryOtherCardOnThatRoutineAsideHereToo() async {
        let server = seeded()
        server.ledger.insert(heavier("prop_2", createdAtMs: 6_000, door: "ask", agent: "Ask"), at: 0)
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_2", "prop_1"])

        let outcome = await store.apply(server.ledger[0])

        guard case .settled(let settled, _) = outcome else { return XCTFail("apply landed: \(outcome)") }
        XCTAssertEqual(settled.id, "prop_2")
        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: decided(store).map { ($0.id, $0.state) }),
                       ["prop_2": .applied, "prop_1": .superseded])
        XCTAssertEqual(server.ledger.map(\.state), [.applied, .superseded])
    }

    func testTwoDoorsPutTwoProposalsOnOneRoutineAndTheNewestIsTheDoor() async {
        let server = seeded()
        server.ledger.insert(heavier("prop_2", createdAtMs: 6_000, door: "ask", agent: "Ask"), at: 0)
        let store = store(server)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_2", "prop_1"])
        XCTAssertEqual(ProposalHead.waitingLine(store.pending(of: "rt_1").count), "2 proposals")
        XCTAssertEqual(store.pending(of: "rt_1").first?.source.agentName, "Ask")
        XCTAssertEqual(store.proposals.first(where: \.isPending)?.id, "prop_2",
                       "and it is the standing card at the head of the home")
        XCTAssertEqual(store.waitingOnTheRow(of: "rt_1")?.id, "prop_2",
                       "the row stands with it: `2 proposals` is a fact the card names nowhere")
    }

    // One proposal, one rendering: the newest waiting one on the account is the standing card at the
    // head of the home, so the routine it belongs to draws no waiting row of its own beneath it.
    func testTheRoutineHoldingTheStandingCardDrawsNoWaitingRowOfItsOwn() async {
        let server = seeded()
        server.written["rt_2"] = Routine(id: "rt_2", name: "Legs", position: 1,
                                         entries: [RoutineEntry(position: 1, exerciseId: "back-squat")])
        server.revisions["rt_2"] = 1
        server.ledger.append(Proposal(head: ProposalHead(id: "prop_legs", routineId: "rt_2",
                                                         summary: "Lighter squats.", changeCount: 1,
                                                         createdAtMs: 4_000,
                                                         source: ProposalSource(door: "mcp", agent: "Claude")),
                                      baseRevision: 1, baseName: "Legs", name: "Legs", changes: []))
        let store = store(server)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.proposals.first(where: \.isPending)?.id, "prop_1",
                       "the newest waiting proposal on the account, which is the one the card is for")
        XCTAssertNil(store.waitingOnTheRow(of: "rt_1"), "the card above is already that proposal")
        XCTAssertEqual(store.waitingOnTheRow(of: "rt_2")?.id, "prop_legs",
                       "a routine that does not own the card keeps its own row")
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"],
                       "and the accent border still reads the routine's own waiting list")
    }

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

    func testAReadThatFindsNothingTakesTheCardWithItToo() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        server.ledger = []

        let read = await store.proposal("prop_1")

        XCTAssertEqual(read, .failure(.refused("that proposal is no longer on the log")))
        XCTAssertEqual(store.proposals, [])
    }

    func testARemovalWhoseRoutineStillStandsIsNotReadAsAReceipt() async {
        let server = seeded()
        server.ledger = [heavier(intent: .remove)]
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        let removal = server.ledger[0]
        server.ledger = []

        let outcome = await store.apply(removal)

        XCTAssertEqual(outcome, .gone)
        XCTAssertEqual(store.routines, [pushA()])
        XCTAssertEqual(store.proposals, [])
        XCTAssertNotNil(server.written["rt_1"])
    }

    func testAProposalsReadThatMissedDrawsNothingRatherThanAStaleCard() async {
        let server = seeded()
        let store = store(server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.pending(of: "rt_1").map(\.id), ["prop_1"])
        server.refuseProposals = refusal(503, message: "unavailable")

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.pending(of: "rt_1"), [])
        XCTAssertEqual(decided(store), [], "and nothing stale is left standing in the decided half")
    }
}
