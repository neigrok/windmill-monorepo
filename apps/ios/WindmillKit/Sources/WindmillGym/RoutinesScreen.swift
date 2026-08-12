import SwiftUI
import WindmillPlatform

// ROUTINES — the written-down days of the program, and the third of the room's three tabs (§F). It
// is a list and two ways in: a routine, what it asks for, a Start on the one you are looking at, and
// every movement it names a door onto that movement's record (§H).
//
// IT DRAWS NO EDITOR, NO `New` AND NO DUPLICATE, and that is a fact about this surface rather than a
// gap in this screen. §B screen 5 gives all three a row action, and every one of them writes a
// routine — which is the web's half of the split (canon §11: the phone owns the open session, the
// web owns the desk work). A control that opened nothing would be the defect this room refuses
// everywhere else. The two ways a routine is written from a phone both already exist and are both
// at the moment they make sense: "Keep this as a routine" at the finish, and the change offer
// mid-session.
//
// The order is the log's own — trained most recently first — so the footer line is a statement about
// this list and not a wish: `Routine.byLastTrained` puts the device's unclaimed routines in the same
// order the server sends the rest.
//
// IT IS ALSO WHERE §B SCREEN 6's HISTORY SECTION LANDS. The board hangs History off the routine
// EDITOR, and this surface has none — so it hangs off the card that opens the routine out instead,
// which on this phone is the same object read the same way, minus the writing. Every proposal an
// agent ever made against a routine stays under it, applied and dismissed and set aside alike:
// an agent's suggestion is part of the program's history whichever way it went.

struct RoutinesScreen: View {
    @ObservedObject var store: TrainingStore
    let onStart: (String) -> Void
    let onMovement: (String) -> Void
    let onProposal: (String) -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                if store.routines.isEmpty {
                    nothingYet
                } else {
                    ForEach(store.routines) { routine in row(routine) }
                    Text("Sorted by last trained, not by when you made them.")
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                        .lineSpacing(3)
                        .padding(.top, WindmillSpace.x2)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        Text("Routines")
            .font(WindmillFont.display(32))
            .foregroundStyle(skin.ink)
            .padding(.bottom, WindmillSpace.x1)
    }

    // The same sentence Today's empty state makes, because it is the same fact: this lifter already
    // has a program and the app's job is to catch it, not to make them type it in first.
    private var nothingYet: some View {
        Text("Nothing written down yet. Log a session and name it at the end — that is how a routine gets made here.")
            .font(WindmillFont.body(16))
            .foregroundStyle(skin.inkDim)
            .lineSpacing(5)
            .padding(.top, WindmillSpace.x2)
    }

    // THE START IS THE HEADER AND NOT THE WHOLE CARD, since the movement names below it became doors
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
            Button { onStart(routine.id) } label: {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(routine.name)
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.ink)
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
                        .foregroundStyle(skin.targetInk)
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
    // board reaches the diff through the editor's chevron and this room's rows start a session
    // instead, so the marker carries the tap.
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

    private func meta(_ routine: Routine) -> String {
        let count = routine.entries.count
        let movements = count == 1 ? "1 exercise" : "\(count) exercises"
        guard let trained = routine.lastTrainedAtMs else { return "\(movements) · never trained" }
        return "\(movements) · trained \(Readout.ago(trained, now: Int64(Date().timeIntervalSince1970 * 1000)))"
    }
}
