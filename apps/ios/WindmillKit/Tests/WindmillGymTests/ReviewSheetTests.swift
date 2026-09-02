import XCTest
@testable import WindmillGym

final class ReviewSheetTests: XCTestCase {
    private func change(_ kind: ProposalChange.Kind, _ exerciseId: String, position: Int) -> ProposalChange {
        let targets = ProposalChange.Targets(sets: 3, reps: 8, weightKg: 40)
        return ProposalChange(position: position, kind: kind, exerciseId: exerciseId,
                              before: kind == .added ? nil : targets, after: kind == .removed ? nil : targets)
    }

    private func proposal(_ changes: [ProposalChange], summary: String = "", door: String = "ask",
                          connection: String? = nil, agent: String? = nil, changeCount: Int? = nil,
                          baseName: String = "Push A", name: String? = nil) -> Proposal {
        Proposal(head: ProposalHead(id: "prop_1", routineId: "rt_1", summary: summary,
                                    changeCount: changeCount ?? changes.filter { $0.kind != .kept }.count,
                                    createdAtMs: 1,
                                    source: ProposalSource(door: door, connection: connection, agent: agent)),
                 baseRevision: 1, baseName: baseName, name: name ?? baseName, changes: changes)
    }

    private func source(_ file: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/\(file)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    // Kept rows fold to a count IN PLACE: the document keeps its order, so expanding never reorders it.
    func testARunOfKeptLinesFoldsToOneCountWhereItStands() {
        let blocks = proposal([
            change(.retargeted, "bench-press", position: 1),
            change(.kept, "overhead-press", position: 2),
            change(.kept, "dip", position: 3),
            change(.kept, "lateral-raise", position: 4),
            change(.added, "incline-db-press", position: 5),
            change(.kept, "cable-fly", position: 6),
            change(.removed, "push-up", position: 7),
        ]).blocks

        XCTAssertEqual(blocks.count, 5)
        guard case .row(0, .entry(let first, _)) = blocks[0],
              case .unchanged(1, let run) = blocks[1],
              case .row(4, .entry(let added, _)) = blocks[2],
              case .unchanged(5, let single) = blocks[3],
              case .row(6, .entry(let removed, _)) = blocks[4] else {
            return XCTFail("changed rows at full weight, kept runs folded between them: \(blocks)")
        }
        XCTAssertEqual(first.exerciseId, "bench-press")
        XCTAssertEqual(run.map(\.exerciseId), ["overhead-press", "dip", "lateral-raise"])
        XCTAssertEqual(added.exerciseId, "incline-db-press")
        XCTAssertEqual(single.map(\.exerciseId), ["cable-fly"])
        XCTAssertEqual(removed.exerciseId, "push-up")
        XCTAssertEqual(blocks.map(\.id), [0, 1, 4, 5, 6], "stable ids, so expanding one run redraws that run only")
    }

    func testTheUnchangedCountIsWordedAsLinesAndCountsOne() {
        XCTAssertEqual(Proposal.unchangedLabel(7), "and 7 lines unchanged")
        XCTAssertEqual(Proposal.unchangedLabel(1), "and 1 line unchanged")
    }

    // B5 + B10: Coach for the Coach door; over MCP the agent's name, else the connection's, else `Your agent`.
    func testTheModelsProseIsAttributedToWhoeverWroteIt() {
        XCTAssertEqual(proposal([], summary: "Heavier triples.").head.kicker, "Coach wrote:")
        XCTAssertEqual(proposal([], door: "mcp", agent: "Claude").head.kicker, "Claude wrote:")
        XCTAssertEqual(proposal([], door: "mcp", connection: "Claude Desktop").head.kicker, "Claude Desktop wrote:")
        XCTAssertEqual(proposal([], door: "mcp", connection: "Claude Desktop", agent: "Claude").head.kicker,
                       "Claude wrote:", "the agent's own name first")
        XCTAssertEqual(proposal([], door: "mcp", connection: "").head.kicker, "Your agent wrote:")
        XCTAssertEqual(proposal([], door: "mcp").head.kicker, "Your agent wrote:")
    }

    // B9: the kicker is an attribution, not an eyebrow — drawn as written, never uppercased.
    func testTheKickerIsDrawnAsWritten() throws {
        let screen = try source("ReviewSheet.swift")
        let wrote = try XCTUnwrap(screen.range(of: "private func wrote("))
        let rows = try XCTUnwrap(screen.range(of: "private func rows(", range: wrote.upperBound..<screen.endIndex))
        let block = screen[wrote.upperBound..<rows.lowerBound]
        XCTAssertTrue(block.contains("proposal.head.kicker"))
        XCTAssertFalse(block.contains(".textCase(.uppercase)"), "sentence case, as written")
        XCTAssertFalse(block.contains(".kerning("), "no eyebrow tracking on an attribution")
    }

    // The receipt is the server's reply — the routine as it now stands (`name`, which a rename moved) and
    // changeCount off the settled row — never the prose. A removal names what went.
    func testTheReceiptIsDerivedFromTheApplyReplyAndSaysNothingItCannotStandBehind() {
        let applied = proposal([], summary: "I made your bench huge.", changeCount: 4)
        XCTAssertEqual(Proposal.receipt(applied: applied), "Applied · Push A · 4 changes")
        XCTAssertEqual(Proposal.receipt(applied: proposal([], changeCount: 1)), "Applied · Push A · 1 change")
        XCTAssertEqual(Proposal.receipt(applied: proposal([], changeCount: 3, baseName: "Push A", name: "Push A · heavy")),
                       "Applied · Push A · heavy · 3 changes", "a rename lands under its new name")
        XCTAssertEqual(Proposal.receipt(applied: proposal([], changeCount: 2, name: "")),
                       "Applied · Push A · 2 changes", "an empty name falls back to the base name")
        XCTAssertEqual(Proposal.removalReceipt(of: "Push A"), "Applied · Push A · routine removed")
        XCTAssertEqual(Proposal.turnedDownReceipt, "Turned down · nothing changed.")
        XCTAssertFalse(Proposal.receipt(applied: applied).contains("huge"))
    }

    func testClosingWithoutDecidingReadsStillWaiting() {
        XCTAssertEqual(Proposal.waiting, "waiting")
        XCTAssertEqual(Proposal.stillWaiting, "still waiting")
        XCTAssertEqual(Proposal.review, "Review")
        let minted = ThreadProposal(id: "prop_1", state: .pending, changeCount: 4, routineId: "rt_1",
                                    routine: "Push A", createdAtMs: 1)
        XCTAssertEqual(minted.line(undecided: false), "4 changes to Push A · Pending")
        XCTAssertEqual(minted.line(undecided: true), "4 changes to Push A · still waiting")
        let applied = ThreadProposal(id: "prop_1", state: .applied, changeCount: 4, routineId: "rt_1",
                                     routine: "Push A", createdAtMs: 1)
        XCTAssertEqual(applied.line(undecided: true), "4 changes to Push A · Applied", "settled is settled")
    }

    private func gate(endInViewport: CGFloat, extent: CGFloat, viewport: CGFloat) -> ReviewGate {
        var gate = ReviewGate()
        gate.viewportChanged(to: viewport)
        gate.endMoved(to: ReviewGate.End(inViewport: endInViewport, inDocument: extent))
        return gate
    }

    // Apply is never reachable while the diff is clipped: the gate opens only once the end marker sits inside the
    // viewport, which a diff that fits without scrolling does at first layout.
    func testApplyOpensOnlyOnceTheDiffHasBeenSeenToItsEnd() {
        XCTAssertFalse(ReviewGate().isOpen, "no diff drawn yet")
        XCTAssertFalse(gate(endInViewport: 1_400, extent: 1_400, viewport: 600).isOpen, "clipped")
        XCTAssertFalse(gate(endInViewport: .infinity, extent: .infinity, viewport: 600).isOpen, "not laid out yet")
        XCTAssertFalse(gate(endInViewport: 300, extent: 300, viewport: 0).isOpen, "no viewport yet")
        XCTAssertTrue(gate(endInViewport: 300, extent: 300, viewport: 600).isOpen, "fits without scrolling")
        XCTAssertTrue(gate(endInViewport: 600, extent: 1_400, viewport: 600).isOpen, "scrolled to the end")
        XCTAssertTrue(gate(endInViewport: 600.5, extent: 1_400, viewport: 600).isOpen, "a sub-point of slack is the end")
    }

    // "Seen" is seen to the end of THIS document, as on the web and Android: a run of kept rows unfolding past the end
    // that was seen takes Apply away again until the new end is seen. Scrolling never moves the end in the document.
    func testUnfoldingAKeptRunTakesApplyAwayUntilTheNewEndIsSeen() {
        var long = ReviewGate()
        long.viewportChanged(to: 600)
        long.endMoved(to: ReviewGate.End(inViewport: 600, inDocument: 1_400))
        XCTAssertTrue(long.isOpen, "scrolled to the end")
        long.endMoved(to: ReviewGate.End(inViewport: 880, inDocument: 1_680))
        XCTAssertFalse(long.isOpen, "seven lines unfolded below the fold")
        long.endMoved(to: ReviewGate.End(inViewport: 700, inDocument: 1_680))
        XCTAssertFalse(long.isOpen, "scrolled part of the way to them")
        long.endMoved(to: ReviewGate.End(inViewport: 600, inDocument: 1_680))
        XCTAssertTrue(long.isOpen, "scrolled to the new end")
        long.endMoved(to: ReviewGate.End(inViewport: 1_500, inDocument: 1_680))
        XCTAssertTrue(long.isOpen, "scrolling back up keeps it: this end has been seen")

        var short = gate(endInViewport: 300, extent: 300, viewport: 600)
        short.endMoved(to: ReviewGate.End(inViewport: 420, inDocument: 420))
        XCTAssertTrue(short.isOpen, "a run that unfolds and still fits in the viewport is seen at once")
    }

    // The sheet keeps the large detent only and the band keeps one button.
    func testTheSheetIsLargeOnlyAndTheBandHoldsOneButtonWithTurnDownAsARowBeneath() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/GymRoom.swift")
        let room = try String(contentsOf: file, encoding: .utf8)
        let sheet = try XCTUnwrap(room.range(of: "ReviewSheet(proposalId:"))
        let detents = try XCTUnwrap(room.range(of: ".presentationDetents(", range: sheet.upperBound..<room.endIndex))
        XCTAssertTrue(room[detents.upperBound...].hasPrefix("[.large])"), "no fixed partial detent on the review")
        XCTAssertTrue(room.contains("if open { reviewing = nil }"), "a session starting takes the sheet down")

        let screen = try String(contentsOf: file.deletingLastPathComponent().appendingPathComponent("ReviewSheet.swift"),
                                encoding: .utf8)
        let band = try XCTUnwrap(screen.range(of: "private func band("))
        let bandBody = screen[band.upperBound...]
        let apply = try XCTUnwrap(bandBody.range(of: "proposal.applyLabel"))
        let turnDown = try XCTUnwrap(bandBody.range(of: "Proposal.turnDown)"))
        XCTAssertLessThan(apply.lowerBound, turnDown.lowerBound, "Apply first, the turn-down row beneath it")
        XCTAssertFalse(bandBody[..<turnDown.lowerBound].contains("HStack"), "one button, never a side-by-side pair")
        XCTAssertTrue(screen.contains(".disabled(!canApply)"))
    }

    // The gate is enforced, so it is said — on the screen and on the VoiceOver channel, in one sentence
    // of six words that names the way out. Pinned here because nothing else names these bytes: a phone
    // could otherwise reword the refusal, drift from the other two surfaces, and stay green (ledger 2p).
    func testTheBandSaysWhyApplyIsShutInBytesTheOtherSurfacesShare() throws {
        XCTAssertEqual(Proposal.applyHint, "Scroll to the end to apply.")
        XCTAssertLessThanOrEqual(Proposal.applyHint.split(separator: " ").count, 12,
                                 "a refusal runs to twelve words and names the way out")

        let screen = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/ReviewSheet.swift"), encoding: .utf8)
        let band = try XCTUnwrap(screen.range(of: "private func band("))
        let bandBody = screen[band.upperBound...]

        let apply = try XCTUnwrap(bandBody.range(of: "proposal.applyLabel"))
        let drawn = try XCTUnwrap(bandBody.range(of: "Text(Proposal.applyHint)"))
        let promise = try XCTUnwrap(bandBody.range(of: "Text(proposal.footnote)"))
        XCTAssertLessThan(apply.lowerBound, drawn.lowerBound, "the refusal sits under the control it explains")
        XCTAssertLessThan(drawn.lowerBound, promise.lowerBound,
                          "and above the atomic promise, which is drawn in both states")

        XCTAssertTrue(bandBody.contains(".accessibilityHint(gate.isOpen ? \"\" : Proposal.applyHint)"),
                      "the same bytes on the VoiceOver channel, off the gate alone")
        XCTAssertTrue(bandBody.contains(".accessibilityHidden(true)"),
                      "and said there ONCE: the drawn row is the pixels, the hint is the spoken channel")
        XCTAssertTrue(bandBody.contains(".opacity(gate.isOpen ? 0 : 1)"),
                      "the slot is held open in BOTH states, so Apply never moves")
        XCTAssertFalse(bandBody[..<promise.lowerBound].contains("if !gate.isOpen"),
                       "a line that comes and goes moves the button under the thumb")
        XCTAssertFalse(bandBody[..<promise.lowerBound].contains("canApply ? \"\" : Proposal.applyHint"),
                       "never off the disabled predicate: it would lie while the apply is in flight")
    }
}
