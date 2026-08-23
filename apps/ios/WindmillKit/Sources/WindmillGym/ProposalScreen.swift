import SwiftUI
import WindmillPlatform

struct ProposalScreen: View {
    let proposalId: String
    @ObservedObject var store: TrainingStore
    let onClosed: (String) -> Void
    let say: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var proposal: Proposal?
    @State private var failure: TrainingStore.WriteFailure?
    // One decision at a time: a second tap on Apply lands on a proposal the first already settled.
    @State private var deciding = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                    if let proposal {
                        head(proposal)
                        if !proposal.head.summary.isEmpty {
                            Text(proposal.head.summary)
                                .font(WindmillFont.body(15))
                                .foregroundStyle(skin.ink)
                                .lineSpacing(4)
                        }
                        rows(proposal)
                        if let note = proposal.settledNote(now: nowMs) { settled(note) }
                    } else if let failure {
                        Text(failure.line("this proposal isn’t drawn"))
                            .font(GymType.numeral(13))
                            .foregroundStyle(skin.alarmInk)
                            .lineSpacing(3)
                    } else {
                        Text("reading the proposal…")
                            .font(GymType.numeral(13))
                            .foregroundStyle(skin.inkFaint)
                    }
                }
                .padding(.horizontal, WindmillSpace.x5)
                .padding(.top, WindmillSpace.x10)
                .padding(.bottom, WindmillSpace.x8)
            }
            if let proposal, proposal.state == .pending { actions(proposal) }
        }
        .task { await read() }
    }

    // Named as it was when the diff was written (`baseName`), not as the routine stands now.
    private func head(_ proposal: Proposal) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                Text("Proposal · \(proposal.baseName)")
                    .font(WindmillFont.display(22))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                chip(proposal.state)
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

    private func rows(_ proposal: Proposal) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            ForEach(Array(proposal.rows.enumerated()), id: \.offset) { _, row in
                switch row {
                case .renamed(let before, let after):
                    card(title: "The routine’s name", ink: skin.ink, ground: skin.surface, edge: skin.line) {
                        move(ProposalChange.Move(field: "", before: before, after: after))
                    }
                case .entry(let change, let follows):
                    entry(change, follows: follows)
                }
            }
        }
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
            EmptyView()
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

    private func actions(_ proposal: Proposal) -> some View {
        VStack(spacing: WindmillSpace.x2) {
            HStack(spacing: WindmillSpace.x2) {
                Button { Task { await decide(proposal, apply: false) } } label: {
                    Text("Dismiss")
                        .font(WindmillFont.body(15, .semibold))
                        .foregroundStyle(skin.inkDim)
                        .padding(.horizontal, WindmillSpace.x5)
                        .frame(minHeight: GymTap.primary - 8)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                Button { Task { await decide(proposal, apply: true) } } label: {
                    Text(proposal.applyLabel)
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.onAccent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.primary - 8)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
                }
            }
            Text(proposal.footnote)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
        }
        .disabled(deciding)
        .opacity(deciding ? 0.6 : 1)
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x3)
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

    // Whatever comes back is the row the log holds, and that is what the screen redraws. Never retried.
    private func decide(_ proposal: Proposal, apply: Bool) async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        switch apply ? await store.apply(proposal) : await store.dismiss(proposal.id) {
        case .settled(let settled):
            self.proposal = settled
        case .removed:
            onClosed("\(proposal.baseName) is gone. Everything you logged against it stays.")
        case .gone:
            onClosed("that proposal is no longer on the log")
        case .failed(let why):
            say(why.line(apply ? "nothing was applied" : "nothing was dismissed"))
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

struct ProposalCard: View {
    let head: ProposalHead
    let routineName: String
    let onReview: () -> Void
    // Sets the card aside for this visit only: the proposal is untouched and is back on home next time.
    let onLater: () -> Void
    // nil wherever an Ask door is not offered, so the chip is absent rather than dead.
    let onAsk: (() -> Void)?

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.accent)
                    .frame(width: 6, height: 6)
                Text("Proposal · \(head.source.agentName)")
                    .font(GymType.numeral(10.5, .bold))
                    .textCase(.uppercase)
                    .kerning(0.9)
                    .foregroundStyle(skin.accent)
                Spacer(minLength: WindmillSpace.x2)
                Text("\(Readout.when(head.createdAtMs, now: nowMs)) · \(Readout.time(head.createdAtMs))")
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            Text(head.line(about: routineName))
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: WindmillSpace.x2) {
                Button(action: onReview) {
                    Text(head.reviewLabel)
                        .font(WindmillFont.body(14, .bold))
                        .foregroundStyle(skin.onAccent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accent))
                }
                Button(action: onLater) {
                    Text("Later")
                        .font(WindmillFont.body(14, .semibold))
                        .foregroundStyle(skin.inkDim)
                        .padding(.horizontal, WindmillSpace.x4)
                        .frame(minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                if let onAsk {
                    Button(action: onAsk) {
                        Text(Ask.title)
                            .font(WindmillFont.body(14, .semibold))
                            .foregroundStyle(skin.inkDim)
                            .padding(.horizontal, WindmillSpace.x3)
                            .frame(minHeight: GymTap.minimum)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                                .strokeBorder(skin.lineStrong, lineWidth: 1))
                    }
                }
            }
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accentSoft))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.accent, lineWidth: 1))
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
