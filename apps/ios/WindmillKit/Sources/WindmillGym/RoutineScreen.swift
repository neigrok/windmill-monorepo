import SwiftUI
import WindmillPlatform

// `untested` is an absence and not a flag: the word stays until the routine's first session.
// The routine is read again on the way in: history rides only on the single-routine route.

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
    // The routine came off the device's copy, which carries no history: the block says so rather than
    // drawing an unread history as an empty one.
    @State private var historyOutOfReach = false
    @State private var failure: TrainingStore.WriteFailure?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                if let routine {
                    head(routine)
                    rows(routine)
                    history(routine)
                } else if let failure {
                    silence(failure.line("this routine isn’t drawn"))
                } else {
                    ProgressView("reading your program…")
                        .font(GymType.numeral(13))
                        .tint(skin.inkFaint)
                        .foregroundStyle(skin.inkFaint)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        .safeAreaInset(edge: .bottom) { reachBand }
        .task { await read() }
        .toolbar {
            if let routine {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { onEdit(routine) }
                }
            }
        }
    }

    // The routine's name is the navigation bar's title; this head carries only what the bar cannot.
    private func head(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
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

    // Keyed on position, never on the movement: a routine may name one twice, and duplicate `ForEach` ids are undefined.
    private func rows(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            ForEach(routine.entries.sorted { $0.position < $1.position }, id: \.position) { entry in
                HStack(spacing: WindmillSpace.x3) {
                    MovementDoor(exerciseId: entry.exerciseId, name: name(of: entry.exerciseId),
                                 font: WindmillFont.body(15, .bold), ink: skin.ink,
                                 open: onMovement)
                    Spacer(minLength: WindmillSpace.x2)
                    Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                        weightKg: entry.targetWeightKg))
                        .font(GymType.numeral(13))
                        .foregroundStyle(entry.isOpen ? skin.inkFaint : skin.targetInk)
                }
                .padding(.horizontal, WindmillSpace.x3)
                .frame(minHeight: GymTap.minimum)
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

    // Newest first, creation row last, and the newest twenty proposals rather than every one the routine
    // ever had (`ProgramRepository.h`, `kRoutineHistoryProposals`). A row this build cannot classify is
    // dropped rather than guessed at, and a history that could not be read is not an empty one.
    @ViewBuilder
    private func history(_ routine: Routine) -> some View {
        let events = routine.history.filter { $0.kind != .unknown }
        if !events.isEmpty || historyOutOfReach {
            Text("History")
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(skin.inkFaint)
                .padding(.top, WindmillSpace.x2)
            if historyOutOfReach {
                Text(RoutineReadout.historyOutOfReach)
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
            // The place in the list is the `ForEach` identity: two events can share an instant.
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

    // Pinned, so the one thing a lifter does with a bar in their hands is reachable at every scroll
    // position (`thumb-reach.md` §3.1, §3.6). It is also this screen's ONLY primary, which is why the
    // unread-history line inside the History block is a line and not a second full-width control.
    @ViewBuilder
    private var reachBand: some View {
        if routine != nil {
            Button(action: onStart) {
                Text("Start workout")
                    .font(WindmillFont.body(16.5, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.bottom, WindmillSpace.x2)
        }
    }

    // The whole-screen failure says so and draws the way back to asking again: `.task` fires once per
    // appearance, so signal returning is not a redraw.
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
        case .read(let found):
            routine = found
            historyOutOfReach = false
        case .remembered(let held):
            routine = held
            historyOutOfReach = true
        case .failed(let why):
            failure = why
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
