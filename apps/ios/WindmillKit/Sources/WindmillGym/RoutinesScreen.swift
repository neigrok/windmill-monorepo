import SwiftUI
import WindmillPlatform

// ROUTINES — the written-down days of the program, and the third of the room's three tabs (§F). It
// is a list and three ways in: `New routine` at the head, a routine's own page behind its name, and
// every movement it names a door onto that movement's record (§H).
//
// IT DRAWS AN EDITOR SINCE §M (2026-08-13), and the comment that stood here said the opposite: this
// surface deliberately had none, on canon §11's split — the phone owns the open session, the web
// owns the desk work. §M overturns exactly that for the one case it is about. Nobody assembles a
// program standing in a gym, which is an argument FOR this screen rather than against it: the
// lifter with a program in a notebook is at a kitchen table on Sunday, and the phone is what is
// beside them. The two older doors are untouched and neither is replaced — "Keep this as a routine"
// at the finish, and an agent's proposal.
//
// The order is the log's own — trained most recently first — so the footer line is a statement about
// this list and not a wish: `Routine.byLastTrained` puts the device's unclaimed routines in the same
// order the server sends the rest.
//
// THE ROW OPENS THE ROUTINE AND NO LONGER STARTS IT. The Start moved to §M screen 30, where it sits
// under everything the day asks for — which is the order a lifter reads it in, and the only place
// `untested`, the open rows and the history have room to be said. What the row keeps is the pending
// marker: a proposal is about the routine and the tap onto it belongs beside its name.

struct RoutinesScreen: View {
    @ObservedObject var store: TrainingStore
    let onOpen: (String) -> Void
    let onNew: () -> Void
    let onMovement: (String) -> Void
    let onProposal: (String) -> Void
    // THE INVITATION (§D12), and nil is the whole of its rule: the room hands this over only while
    // nothing is known to reach the log, so a lifter whose Claude already writes these proposals is
    // never sold the thing they are already using. It is an invitation and not a gate — no lock, no
    // chip, no price, and nothing on this screen is withheld while it goes unanswered.
    let onConnect: (() -> Void)?

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                if store.routines.isEmpty {
                    nothingYet
                } else {
                    // Sorted by last trained rather than by when they were made, and the list says so
                    // by carrying each routine's own last-trained line — a caption under the list
                    // naming the sort order is the room explaining itself.
                    ForEach(store.routines) { routine in row(routine) }
                }
                // AT THE FOOT, UNDER THE PROGRAM AND NEVER IN FRONT OF IT — including when there is
                // no program yet, which is the one moment an agent reading a written plan is worth
                // the most.
                if let onConnect {
                    ConnectInvite(open: onConnect)
                        .padding(.top, WindmillSpace.x2)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Routines")
                .font(WindmillFont.display(32))
                .foregroundStyle(skin.ink)
            Spacer(minLength: WindmillSpace.x3)
            Button(action: onNew) {
                Text("New")
                    .font(WindmillFont.body(13.5, .bold))
                    .foregroundStyle(skin.accent)
                    .padding(.horizontal, WindmillSpace.x3)
                    .frame(minHeight: GymTap.minimum)
                    .background(Capsule().strokeBorder(skin.accent, lineWidth: 1))
            }
        }
        .padding(.bottom, WindmillSpace.x1)
    }

    // BOTH DOORS, because both are true and a lifter arrives through one or the other: the program
    // that falls out of the session you are about to do, and the one already written on paper beside
    // you. The sentence used to name only the first, on a surface where the second did not exist.
    private var nothingYet: some View {
        Text("Nothing written down yet. Log a session and name it at the end — or type one out now, if you already have a program.")
            .font(WindmillFont.body(16))
            .foregroundStyle(skin.inkDim)
            .lineSpacing(5)
            .padding(.top, WindmillSpace.x2)
    }

    // THE DOOR IS THE HEADER AND NOT THE WHOLE CARD, since the movement names below it are doors
    // onto their own records (§H): a button inside a button is not a second tap target on iOS, it is
    // one that swallows the other. The header is where §B screen 5 draws the row anyway — the name,
    // its meta and the chevron — and the entries under it are this surface's own preview of what the
    // day asks for.
    private func row(_ routine: Routine) -> some View {
        // Asked once and read twice — the marker and the card's own edge are one fact, and a card
        // lit at the border with no row to tap would be the loudest thing on this screen saying
        // nothing.
        let pending = store.pending(of: routine.id)
        return VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Button { onOpen(routine.id) } label: {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(routine.name)
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.ink)
                    // The word §M puts on a routine that has never been run, said where the list can
                    // say it too: it is the same absence, read the same way, and a lifter scanning
                    // for what to do tonight has earned knowing which of these is untried.
                    if routine.isUntested {
                        Text("untested")
                            .font(GymType.numeral(10))
                            .tracking(0.5)
                            .textCase(.uppercase)
                            .foregroundStyle(skin.inkFaint)
                    }
                    Spacer(minLength: 0)
                    Text(meta(routine))
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .frame(minHeight: GymTap.minimum)
            }
            if let newest = pending.first { waiting(newest, of: pending.count) }
            // Keyed on POSITION and never on the movement: a routine may name one twice — bench
            // heavy then bench back-off is the case the domain's `Routine` calls out by name —
            // and two rows sharing an id is undefined behaviour in a ForEach.
            ForEach(routine.entries.sorted { $0.position < $1.position }, id: \.position) { entry in
                HStack(spacing: WindmillSpace.x3) {
                    MovementDoor(exerciseId: entry.exerciseId,
                                 name: Readout.movement(entry.exerciseId, in: store.catalog),
                                 font: WindmillFont.body(14), ink: skin.inkDim, open: onMovement)
                    Spacer(minLength: WindmillSpace.x2)
                    Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                        weightKg: entry.targetWeightKg))
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(entry.isOpen ? skin.inkFaint : skin.targetInk)
                }
            }
            history(of: routine)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(pending.isEmpty ? skin.line : skin.accent, lineWidth: 1))
    }

    // `● 1 proposal` (§B screen 5), and on this surface it is the DOOR as well as the mark: the
    // row's own tap opens the routine, so a diff reached only through it would be two taps from a
    // list whose whole job is to say something is waiting.
    //
    // IT COUNTS WHAT IS WAITING AND OPENS THE NEWEST. The ledger keeps one pending proposal per
    // door, so two doors put two on one routine — a mark that said "1" over both would be wrong
    // about the one number it is here to give. The older ones are not lost behind the tap: applying
    // the newest sets them aside, dismissing it leaves the next one marked in its place.
    private func waiting(_ newest: ProposalHead, of count: Int) -> some View {
        Button { onProposal(newest.id) } label: {
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.accent)
                    .frame(width: 6, height: 6)
                Text(ProposalHead.waitingLine(count))
                    .font(WindmillFont.body(13, .bold))
                    .foregroundStyle(skin.accent)
                Text(count == 1 ? "from \(newest.source.agentName)"
                                : "newest from \(newest.source.agentName)")
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.accent)
            }
            .frame(minHeight: GymTap.minimum)
        }
    }

    // HISTORY (§B screen 6) — `2 Aug · applied 3 changes from Claude`, most recently DECIDED first
    // (the store orders it by the day each row prints), every row a door back onto the diff it
    // settled. The three most recent are drawn and the rest are COUNTED:
    // a section that grew without bound would push the movements it belongs to off the card, and a
    // number is the room's own way of saying there is more (Today's `+ 3 more` says it the same way).
    @ViewBuilder
    private func history(of routine: Routine) -> some View {
        let settled = store.history(of: routine.id)
        if !settled.isEmpty {
            Text("History")
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(skin.inkFaint)
                .padding(.top, WindmillSpace.x2)
            ForEach(settled.prefix(3)) { head in
                Button { onProposal(head.id) } label: {
                    HStack(spacing: WindmillSpace.x2) {
                        Text(head.historyLine(now: Int64(Date().timeIntervalSince1970 * 1000)))
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkDim)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(skin.inkFaint)
                    }
                    .frame(minHeight: GymTap.minimum)
                    .padding(.horizontal, WindmillSpace.x3)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
                    .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                        .strokeBorder(skin.line, lineWidth: 1))
                }
            }
            if settled.count > 3 {
                Text("+ \(settled.count - 3) older")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // `6 exercises · trained 5 days ago`. A routine that has never been run says only its count
    // here: the `untested` word beside the name is the same fact, and a row that carried both would
    // be saying one thing twice in one line.
    private func meta(_ routine: Routine) -> String {
        let count = routine.entries.count
        let movements = count == 1 ? "1 exercise" : "\(count) exercises"
        guard let trained = routine.lastTrainedAtMs else { return movements }
        return "\(movements) · trained \(Readout.ago(trained, now: Int64(Date().timeIntervalSince1970 * 1000)))"
    }
}
