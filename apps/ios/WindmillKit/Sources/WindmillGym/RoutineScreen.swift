import SwiftUI
import WindmillPlatform

// ROUTINE DETAIL — one screen since the 13 Aug update (R2): screen 30's content under screen 5's
// chrome. The plan's rows, one primary that starts it — "Start workout", literal, never
// name-substituted (R1) — and History below. Edit is the header's one action; Duplicate and Delete
// moved into the editor (R3), and the standalone Rename sheet retired with them — renaming is
// editing the inline name.
//
// `untested` IS AN ABSENCE AND NOT A FLAG (`Routine.isUntested`). A routine built at home has no
// history behind it, and the word stays until its first session — which is what allows that first
// session to disagree with it. Nothing counts down and nothing congratulates its removal.
//
// IT READS THE ROUTINE AGAIN ON THE WAY IN, because history rides ONLY on the single-routine route:
// the list read carries none, so the copy in `store.routines` has an empty one and a page that drew
// from it would show a routine with no past. The entries on screen come from the same fresh read,
// which is also what makes an edit made on the web visible here without leaving the room.
//
// SIGNED OUT — or over a routine this device is still the only home for — there is no read to make
// and no history to draw. The rows, the name and the Start are all real from the shelf, and the
// section is simply absent: the log has nothing to date it by, and a section drawn empty would be
// this page asking a question it already knows nobody answered.

struct RoutineScreen: View {
    let routineId: String
    @ObservedObject var store: TrainingStore
    let onStart: () -> Void
    let onEdit: (Routine) -> Void
    let onMovement: (String) -> Void
    let onProposal: (String) -> Void
    let onThread: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var routine: Routine?
    @State private var failure: TrainingStore.WriteFailure?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                if let routine {
                    head(routine)
                    rows(routine)
                    if let open = RoutineReadout.openRows(routine, in: store.catalog) { fact(open) }
                    start
                    history(routine)
                } else if let failure {
                    silence(failure.line("this routine isn’t drawn"))
                } else {
                    Text("reading your program…")
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkFaint)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        .task { await read() }
    }

    // The name, `Edit` beside it (R2's header), then the word and the meta under both. Edit rides
    // with the thing it acts on rather than in a corner of the room's chrome — the top-left is the
    // shell's capsule lane and the top-right belongs to nobody, which is the same place §H puts it.
    // Renaming is inside the editor now: the name is a field there, not a sheet here.
    private func head(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                Text(routine.name)
                    .font(WindmillFont.display(30))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                Button { onEdit(routine) } label: {
                    Text("Edit")
                        .font(WindmillFont.body(13.5, .bold))
                        .foregroundStyle(skin.accent)
                        .frame(minHeight: GymTap.minimum)
                }
            }
            HStack(spacing: WindmillSpace.x2) {
                if routine.isUntested {
                    Text("untested")
                        .font(GymType.numeral(10.5))
                        .tracking(0.5)
                        .textCase(.uppercase)
                        .foregroundStyle(skin.inkDim)
                        .padding(.horizontal, WindmillSpace.x2)
                        .frame(minHeight: 22)
                        .background(Capsule().fill(skin.raised))
                        .overlay(Capsule().strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                Text(RoutineReadout.meta(routine, now: nowMs))
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // Every movement is a door onto its own record (§H), and the target beside it is what the day
    // asks for — or `open`, in the ink that says the routine named nothing rather than that it named
    // a number. A movement this lifter minted carries `· yours` (R5 — the picker's word, everywhere),
    // so they can recognise their own.
    //
    // Keyed on POSITION and never on the movement: a routine may name one twice — bench heavy then
    // bench back-off — and two rows sharing an id in a ForEach is undefined behaviour.
    private func rows(_ routine: Routine) -> some View {
        VStack(spacing: WindmillSpace.x2) {
            ForEach(routine.entries.sorted { $0.position < $1.position }, id: \.position) { entry in
                HStack(spacing: WindmillSpace.x3) {
                    MovementDoor(exerciseId: entry.exerciseId, name: name(of: entry.exerciseId),
                                 font: WindmillFont.body(15, .bold), ink: skin.ink, open: onMovement)
                    Spacer(minLength: WindmillSpace.x2)
                    Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                        weightKg: entry.targetWeightKg))
                        .font(GymType.numeral(13))
                        .foregroundStyle(entry.isOpen ? skin.inkFaint : skin.targetInk)
                }
                .padding(.horizontal, WindmillSpace.x3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(skin.line, lineWidth: 1))
            }
        }
    }

    private func name(of exerciseId: String) -> String {
        let named = Readout.movement(exerciseId, in: store.catalog)
        guard store.catalog.first(where: { $0.id == exerciseId })?.custom == true else { return named }
        return "\(named) · yours"
    }

    private func fact(_ said: String) -> some View {
        Text(said)
            .font(WindmillFont.body(12.5))
            .foregroundStyle(skin.inkDim)
            .lineSpacing(3)
            .padding(WindmillSpace.x3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
    }

    // WHERE THIS DAY CAME FROM, newest first, with the creation row always last. A proposal row is a
    // door back onto the diff it settled; the creation row opens nothing, because there is nothing
    // further to read about it.
    //
    // AND THE TRAIL RUNS BOTH WAYS (§O). A change that came out of a conversation carries a second
    // door onto it, offered ONLY where the wire sent a thread id: absent means there is nothing to
    // open — the MCP door had no conversation, or the lifter deleted the one this came from — and
    // the row still says the change came from Ask either way. That is the whole of "delete deletes
    // the conversation, not the consequence", drawn.
    //
    // A row this build cannot classify is DROPPED rather than guessed at — see `RoutineEvent.Kind`.
    @ViewBuilder
    private func history(_ routine: Routine) -> some View {
        let events = routine.history.filter { $0.kind != .unknown }
        if !events.isEmpty {
            Text("History")
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(skin.inkFaint)
                .padding(.top, WindmillSpace.x2)
            // Its PLACE in the list is the identity a ForEach follows: two events can share an
            // instant, and an id shared in a ForEach is undefined behaviour.
            ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                if let head = event.proposal {
                    Button { onProposal(head.id) } label: {
                        eventRow(head.historyLine(now: nowMs), chevron: true)
                    }
                    if let thread = head.source.thread {
                        Button { onThread(thread) } label: {
                            conversationDoor
                        }
                    }
                } else {
                    eventRow(RoutineReadout.created(event), chevron: false)
                }
            }
        }
    }

    // The second door, drawn under the row it belongs to rather than inside it: two taps in one
    // control is how a lifter reaching for the diff lands in a chat instead.
    private var conversationDoor: some View {
        HStack(spacing: WindmillSpace.x1) {
            Text(AskThreads.fromTheConversation)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.accent)
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(skin.accent)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, WindmillSpace.x3)
        .frame(minHeight: GymTap.minimum)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func eventRow(_ said: String, chevron: Bool) -> some View {
        HStack(spacing: WindmillSpace.x2) {
            Text(said)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkDim)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .frame(minHeight: GymTap.minimum)
        .padding(.horizontal, WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
            .strokeBorder(skin.line, lineWidth: 1))
    }

    // THE ONE BUTTON THAT STARTS IT, and it reads "Start workout" — literal, never name-substituted
    // (R1): the routine's name is the screen's title, so the verb is locked and the button never
    // shrinks a long name into it.
    private var start: some View {
        Button(action: onStart) {
            Text("Start workout")
                .font(WindmillFont.body(16.5, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
        .padding(.top, WindmillSpace.x2)
    }

    private func silence(_ line: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(line)
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
            Button { Task { await read() } } label: {
                Text("Try again")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
        }
    }

    private func read() async {
        failure = nil
        switch await store.routine(routineId) {
        case .success(let found): routine = found
        case .failure(let why): failure = why
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
