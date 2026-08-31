import SwiftUI
import WindmillPlatform

// The review opens OVER the conversation as a sheet at the large detent only — a fixed partial detent does not grow
// with the system text size, and Apply is never reachable while the diff is clipped. Closing it decides nothing.
struct ReviewSheet: View {
    let proposalId: String
    @ObservedObject var store: TrainingStore
    // The receipt line the thread draws, derived from the server's reply, after the sheet has closed onto it.
    let onSettled: (String) -> Void
    // The proposal is no longer on the log: the sheet closes with a sentence for the room.
    let onClosed: (String) -> Void
    let say: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @Environment(\.dismiss) private var dismiss
    @State private var proposal: Proposal?
    @State private var failure: TrainingStore.WriteFailure?
    // One decision at a time: a second tap on Apply lands on a proposal the first already settled.
    @State private var deciding = false
    @State private var confirmingTurnDown = false
    @State private var expanded: Set<Int> = []
    @State private var gate = ReviewGate()

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                        if let proposal {
                            head(proposal)
                            if !proposal.head.summary.isEmpty { wrote(proposal) }
                            rows(proposal)
                            if let note = proposal.settledNote(now: nowMs) { settled(note) }
                        } else if let failure {
                            Text(failure.line("this proposal isn’t drawn"))
                                .font(GymType.numeral(13))
                                .foregroundStyle(skin.alarmInk)
                                .lineSpacing(3)
                        } else {
                            ProgressView("reading the proposal…")
                                .font(GymType.numeral(13))
                                .tint(skin.inkFaint)
                                .foregroundStyle(skin.inkFaint)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.horizontal, WindmillSpace.x5)
                    .padding(.top, WindmillSpace.x6)
                    .padding(.bottom, WindmillSpace.x4)
                    // The end is the diff's, never the loading line's: the marker exists only once a proposal is
                    // drawn, so a diff landing after the first layout cannot inherit a gate the placeholder opened.
                    // It is read twice — where it sits in the viewport, and where it sits in the document, which a
                    // scroll never moves and a kept run unfolding does.
                    if proposal != nil {
                        Color.clear
                            .frame(height: 1)
                            .onGeometryChange(for: ReviewGate.End.self) {
                                ReviewGate.End(inViewport: $0.frame(in: .named("review")).maxY,
                                               inDocument: $0.frame(in: .named("document")).maxY)
                            } action: { gate.endMoved(to: $0) }
                    }
                }
                .coordinateSpace(name: "document")
            }
            .coordinateSpace(name: "review")
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { gate.viewportChanged(to: $0) }
            if let proposal, proposal.state == .pending { band(proposal) }
        }
        .task { await read() }
        .confirmationDialog(Proposal.turnDownTitle, isPresented: $confirmingTurnDown, titleVisibility: .visible) {
            Button(Proposal.turnDownConfirm, role: .destructive) {
                guard let proposal else { return }
                Task { await decide(proposal, apply: false) }
            }
            Button(Proposal.turnDownKeep, role: .cancel) {}
        } message: {
            Text(Proposal.turnDownBody)
        }
    }

    // Named as it was when the diff was written (`baseName`), not as the routine stands now.
    private func head(_ proposal: Proposal) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                Text("Proposal · \(proposal.baseName)")
                    .font(WindmillFont.display(22))
                    .foregroundStyle(skin.ink)
                    .lineLimit(2)
                Spacer(minLength: 0)
                chip(proposal.state)
                Button { dismiss() } label: {
                    Text(Proposal.close)
                        .font(WindmillFont.body(13.5, .bold))
                        .foregroundStyle(skin.accent)
                        .frame(minHeight: GymTap.minimum - 18)
                }
            }
            Text("from \(proposal.head.source.agentName) · \(Readout.when(proposal.head.createdAtMs, now: nowMs)) · \(Readout.time(proposal.head.createdAtMs))")
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
        }
    }

    private func chip(_ state: ProposalState) -> some View {
        let ink = state == .pending ? skin.accent : (state == .applied ? skin.setDone : skin.inkFaint)
        let ground = state == .pending ? skin.accentSoft : (state == .applied ? skin.setDoneSoft : skin.raised)
        return Text(state.word)
            .font(GymType.numeral(10.5, .bold))
            .textCase(.uppercase)
            .kerning(0.7)
            .foregroundStyle(ink)
            .padding(.horizontal, WindmillSpace.x2)
            .padding(.vertical, 5)
            .background(Capsule().fill(ground))
    }

    // The model's prose in a quoted block under its kicker, apart from the counted rows. The kicker is an
    // attribution, not an eyebrow: drawn as written, never uppercased.
    private func wrote(_ proposal: Proposal) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text(proposal.head.kicker)
                .font(GymType.numeral(11.5, .bold))
                .foregroundStyle(skin.inkFaint)
            Text(proposal.head.summary)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, WindmillSpace.x3)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5).fill(skin.lineStrong).frame(width: 3)
        }
    }

    private func rows(_ proposal: Proposal) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            ForEach(proposal.blocks) { block in
                switch block {
                case .row(_, .renamed(let before, let after)):
                    card(title: "The routine’s name", ink: skin.ink, ground: skin.surface, edge: skin.line) {
                        move(ProposalChange.Move(field: "", before: before, after: after))
                    }
                case .row(_, .entry(let change, let follows)):
                    entry(change, follows: follows)
                case .row(_, .kept(let change)):
                    kept(change)
                case .unchanged(let start, let run):
                    unchanged(start, run)
                }
            }
        }
    }

    // Tappable to expand in place; the rows keep their position because they are the document.
    @ViewBuilder
    private func unchanged(_ start: Int, _ run: [ProposalChange]) -> some View {
        if expanded.contains(start) {
            ForEach(Array(run.enumerated()), id: \.offset) { _, change in kept(change) }
        } else {
            Button { expanded.insert(start) } label: {
                HStack(spacing: WindmillSpace.x2) {
                    Text(Proposal.unchangedLabel(run.count))
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.inkDim)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, WindmillSpace.x3)
                .frame(minHeight: GymTap.minimum - 6)
                .contentShape(Rectangle())
            }
            .accessibilityHint("Shows the unchanged lines")
        }
    }

    private func kept(_ change: ProposalChange) -> some View {
        HStack(spacing: WindmillSpace.x3) {
            Text(Readout.movement(change.exerciseId, in: store.catalog))
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
            Spacer(minLength: WindmillSpace.x2)
            if let after = change.after {
                Text(Readout.target(sets: after.sets, reps: after.reps, weightKg: after.weightKg))
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .padding(.horizontal, WindmillSpace.x3)
        .frame(minHeight: 34)
    }

    @ViewBuilder
    private func entry(_ change: ProposalChange, follows: String?) -> some View {
        let name = Readout.movement(change.exerciseId, in: store.catalog)
        switch change.kind {
        case .added:
            card(title: "+  \(name)", ink: skin.ink, ground: skin.setDoneSoft, edge: skin.setDone) {
                Text(change.addedLine(after: follows.map { Readout.movement($0, in: store.catalog) }))
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkDim)
            }
        case .removed:
            card(title: "−  \(name)", ink: skin.ink, ground: skin.alarmSoft, edge: skin.alarmInk) {
                Text(change.removedLine)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkDim)
            }
        case .retargeted:
            card(title: name, ink: skin.ink, ground: skin.surface, edge: skin.line) {
                ForEach(Array(change.moves.enumerated()), id: \.offset) { _, moved in move(moved) }
            }
        case .kept:
            kept(change)
        }
    }

    private func move(_ moved: ProposalChange.Move) -> some View {
        HStack(spacing: WindmillSpace.x2) {
            if !moved.field.isEmpty {
                Text(moved.field)
                    .foregroundStyle(skin.inkFaint)
            }
            Text(moved.before)
                .foregroundStyle(skin.inkDim)
                .strikethrough(true, color: skin.inkFaint)
            Text("→")
                .foregroundStyle(skin.inkFaint)
            Text(moved.after)
                .font(GymType.numeral(12.5, .bold))
                .foregroundStyle(skin.targetInk)
            Spacer(minLength: 0)
        }
        .font(GymType.numeral(12.5))
    }

    private func card<Body: View>(title: String, ink: Color, ground: Color, edge: Color,
                                  @ViewBuilder body: () -> Body) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(title)
                .font(WindmillFont.body(14.5, .bold))
                .foregroundStyle(ink)
            body()
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(ground))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(edge, lineWidth: 1))
    }

    private func settled(_ note: String) -> some View {
        Text(note)
            .font(WindmillFont.body(13.5))
            .foregroundStyle(skin.inkDim)
            .lineSpacing(4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(WindmillSpace.x3)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
    }

    // One button, Apply, gated on the diff having been seen to its end; turning down is a plain text row beneath.
    private func band(_ proposal: Proposal) -> some View {
        let canApply = gate.isOpen && !deciding
        return VStack(spacing: WindmillSpace.x1) {
            Button { Task { await decide(proposal, apply: true) } } label: {
                Text(proposal.applyLabel)
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(canApply ? skin.onAccent : skin.inkFaint)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary - 8)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .fill(canApply ? skin.accent : skin.raised))
            }
            .disabled(!canApply)
            .accessibilityHint(gate.isOpen ? "" : Proposal.applyHint)
            // Why Apply is shut, said on the screen as well as on the VoiceOver channel — and kept in
            // its slot whether or not it is drawn, so Apply never moves under the thumb. Off the gate
            // ALONE, never off `canApply`: a sentence bound to the disabled state would tell a lifter
            // to read further while the apply request is already in flight.
            //
            // One fact, one channel each: these are the pixels, and the button's own hint is what
            // VoiceOver reads. Exposed here as well, the eight words are announced twice in a row —
            // once as the control's hint and once as the row beneath it. Android says it on the
            // control too, as `stateDescription`.
            Text(Proposal.applyHint)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .opacity(gate.isOpen ? 0 : 1)
                .accessibilityHidden(true)
            Text(proposal.footnote)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
            Button { confirmingTurnDown = true } label: {
                Text(Proposal.turnDown)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.inkDim)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
            }
            .disabled(deciding)
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.top, WindmillSpace.x2)
        .padding(.bottom, WindmillSpace.x3)
        .background(skin.surface)
        .overlay(alignment: .top) { Rectangle().fill(skin.line).frame(height: 1) }
    }

    private func read() async {
        switch await store.proposal(proposalId) {
        case .success(let found):
            proposal = found
            failure = nil
        case .failure(let why):
            failure = why
        }
    }

    // Whatever comes back is the row the log holds. Applied or turned down, the sheet closes onto the thread and
    // the receipt lands there; set aside, it stays open, the server's own sentence is said once, and the settled
    // note stays as the state. Never retried.
    private func decide(_ proposal: Proposal, apply: Bool) async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        switch apply ? await store.apply(proposal) : await store.dismiss(proposal.id) {
        case .settled(let settled, let said):
            self.proposal = settled
            switch settled.state {
            case .applied:
                onSettled(Proposal.receipt(applied: settled))
                dismiss()
            case .dismissed:
                onSettled(Proposal.turnedDownReceipt)
                dismiss()
            case .pending, .superseded:
                if let said { say(said) }
            }
        case .removed:
            onSettled(Proposal.removalReceipt(of: proposal.baseName))
            onClosed("\(proposal.baseName) is gone. Everything you logged against it stays.")
        case .gone:
            onClosed("that proposal is no longer on the log")
        case .failed(let why):
            say(why.line(apply ? "nothing was applied" : "nothing was turned down"))
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

// Apply opens only once the diff's last row has been inside the viewport — or the whole diff fits without a scroll
// — of the document as it stands NOW. The end is remembered by where it sat in the document when it was seen, so a
// run of kept rows unfolding moves the end past that and takes Apply away until the new end is seen.
public struct ReviewGate: Equatable {
    // The diff's last row by its bottom edge: in the scroll's viewport, and in the document itself.
    public struct End: Equatable {
        public let inViewport: CGFloat
        public let inDocument: CGFloat

        public init(inViewport: CGFloat, inDocument: CGFloat) {
            self.inViewport = inViewport
            self.inDocument = inDocument
        }
    }

    // Nil until a proposal is drawn: the loading line has no end to see.
    private var end: End?
    private var viewport: CGFloat = 0
    private var seenAt: CGFloat?

    public init() {}

    public var isOpen: Bool {
        guard let end else { return false }
        return seenAt == end.inDocument
    }

    public mutating func endMoved(to end: End) {
        self.end = end
        settle()
    }

    public mutating func viewportChanged(to viewport: CGFloat) {
        self.viewport = viewport
        settle()
    }

    // A sub-point of slack is the end.
    private mutating func settle() {
        guard let end, viewport > 0, end.inViewport.isFinite, end.inViewport <= viewport + 1 else { return }
        seenAt = end.inDocument
    }
}

// The standing card on the routines home: the summary, the counted changes, and one affordance.
struct ProposalCard: View {
    let head: ProposalHead
    let routineName: String
    // Closed without a decision this visit: the card says so.
    let undecided: Bool
    let onReview: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.accent)
                    .frame(width: 6, height: 6)
                // A routine's name is as long as a lifter types it: the eyebrow truncates and the stamp,
                // which is the same handful of characters however old the proposal, is measured first.
                Text("Proposal · \(routineName)")
                    .font(GymType.numeral(10.5, .bold))
                    .textCase(.uppercase)
                    .kerning(0.9)
                    .foregroundStyle(skin.accent)
                    .lineLimit(1)
                Spacer(minLength: WindmillSpace.x2)
                Text("\(Readout.when(head.createdAtMs, now: nowMs)) · \(Readout.time(head.createdAtMs))")
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            Text(head.line(about: routineName))
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(head.changes) · \(undecided ? Proposal.stillWaiting : Proposal.waiting)")
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
            Button(action: onReview) {
                Text(Proposal.review)
                    .font(WindmillFont.body(14, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accent))
            }
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accentSoft))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.accent, lineWidth: 1))
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
