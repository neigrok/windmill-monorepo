import SwiftUI
import WindmillPlatform

// THE DIFF, AND THE TAP (§D screen 14) — the one screen in gym where an agent's work becomes the
// lifter's program, and the only place it can. Everything above the two buttons is a statement of
// what would change; nothing has changed until one of them is pressed.
//
// It is an AWAY screen, reached from the card on Today and from the routine the proposal touches,
// so it carries the room's plain bar and no rail — a decision is not a place to stand.
//
// THE COUNT UNDER THE THUMB IS THE SERVER'S, never the rows this build managed to draw
// (`Proposal.applyLabel`). Apply is atomic against the whole document, so a screen that promised to
// apply what it could render would be promising an effect it does not have — the one defect this
// wave may not ship.
//
// A SETTLED PROPOSAL STAYS, with its timestamp and its state, and the actions are simply not there.
// It is the program's history rather than a toast that disappears — which is also why the room can
// reach it again from the routine's History section long after it was decided.

struct ProposalScreen: View {
    let proposalId: String
    @ObservedObject var store: TrainingStore
    // What is left when this screen has nothing to draw — an applied removal, or a proposal the log
    // no longer holds. The room takes the lifter back and says the sentence; a screen that popped
    // itself would be a second copy of the room's own navigation.
    let onClosed: (String) -> Void
    let say: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var proposal: Proposal?
    @State private var failure: TrainingStore.WriteFailure?
    // One decision at a time. Two taps on Apply would be two applies, and the second one lands on a
    // proposal the first has already settled — a 409 the lifter never asked for.
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
                        // In the log's own words when it sent any. A 500 that said "internal error"
                        // is not a phone with no signal, and this screen may not report it as one.
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

    // `Proposal · Push A`, then who wrote it and when, then the state. The routine is named as it
    // was when the diff was written (`baseName`) and not as it stands now: everything on this screen
    // describes one document, and a header that quietly followed a rename would be describing two.
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

    // Pending is lit, applied is the room's settled green, and the two outcomes that changed nothing
    // are quiet — a dismissal and a set-aside are not failures and are not drawn in the alarm ink.
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

    // Every row the document moves, and no row it keeps. A `kept` entry is what the routine already
    // says — drawing it as a change would put four rows of nothing between the lifter and the two
    // that matter.
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

    // `sets 5 × 5 → 5 × 3` — the old value struck through, the new one in the ink the plan is
    // written in everywhere else in this room. Struck AND labelled: a strikethrough alone is a
    // colour difference, and the target ink is the one thing on this screen a lifter is being asked
    // to agree to.
    private func move(_ moved: ProposalChange.Move) -> some View {
        HStack(spacing: WindmillSpace.x2) {
            // The routine's own name has no field label — the card above it already said which
            // fact this is, and "name name Push A" is what a second one would read as.
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

    // The two decisions, and the sentence that says what the tap does. Dismiss is the narrow one and
    // Apply the wide one, because one of them changes a program and the other does not.
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

    // THE ONE PLACE A TAP BECOMES A WRITE. Whatever comes back is the row the LOG holds, and that is
    // what the screen redraws — including the two answers the lifter did not choose: a routine that
    // moved under the diff comes back set aside, and a decision another device already took comes
    // back the way that device took it. Neither is retried and neither is applied over the top.
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

// THE CARD IS THE NOTIFICATION (§B). This product has no push, no badge and no unread count, and
// that is exactly why the card waits where the lifter will be looking anyway — on Today, and on the
// routine it touches — until it is applied or dismissed. It never speaks first and it never
// interrupts a session.
//
// It carries the agent's OWN summary and no editorial: the words a lifter is about to judge are the
// words the agent wrote. When there are none, `line(about:)` states the count and the routine rather
// than inventing a sentence for it.
struct ProposalCard: View {
    let head: ProposalHead
    let routineName: String
    let onReview: () -> Void
    // "Not now." It sets the card aside on THIS screen for as long as the room is open — the
    // proposal is untouched, it still waits on its own routine, and it is back on Today the next
    // time the room is. Dismissing is a decision with a record; this is not one, so it takes none.
    let onLater: () -> Void
    // ASK'S SECOND ENTRANCE (§L): the two places a chat is reached from are Today's bottom band and
    // this card. It is nil wherever Ask is not open — mid-session, signed out, or on a deployment
    // that carries no Ask — so the row is absent rather than dead.
    //
    // IT SEEDS NOTHING. A question written for the lifter would be the same fault `line(about:)`
    // refuses two properties down: the words somebody is about to judge an agent by are their own.
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
