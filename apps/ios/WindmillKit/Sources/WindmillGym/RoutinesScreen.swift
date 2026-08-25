import SwiftUI
import WindmillPlatform

// Trained most recently first; the row opens the routine and never starts it.

struct RoutinesScreen: View {
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool
    let setAside: Set<String>
    let onOpen: (String) -> Void
    let onNew: () -> Void
    let onStartLogging: () -> Void
    let onMovement: (String) -> Void
    let onProposal: (String) -> Void
    let onLater: (String) -> Void
    // nil wherever a Coach door is not offered, so the chip is absent rather than dead.
    let onAsk: (() -> Void)?
    let onSettings: () -> Void
    let onSignIn: () -> Void
    // nil once something already reaches this log.
    let onConnect: (() -> Void)?

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                RefusalRows(refusals: store.refusals, catalog: store.catalog,
                            onDismiss: { store.clearRefusals() })
                waiting
                if !isSignedIn { claimOffer }
                if store.routines.isEmpty {
                    empty
                } else {
                    ForEach(store.routines) { routine in row(routine) }
                    newRoutine
                    justStartLogging
                }
                if let onConnect {
                    ConnectInvite(open: onConnect)
                        .padding(.top, WindmillSpace.x2)
                }
                settingsDoor
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text("Routines")
                .font(WindmillFont.display(32))
                .foregroundStyle(skin.ink)
            if !store.routines.isEmpty {
                Text("\(Readout.routineCount(store.routines.count)) · nothing running")
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .padding(.bottom, WindmillSpace.x1)
    }

    private var empty: some View {
        VStack(spacing: WindmillSpace.x4) {
            Text("+")
                .font(WindmillFont.display(28))
                .foregroundStyle(skin.inkFaint)
                .frame(width: 62, height: 62)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    .foregroundStyle(skin.lineStrong))
            Text("No routines yet")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.ink)
            Text("A routine is one training day written down — the movements, in order, with your targets.")
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .multilineTextAlignment(.center)
            Button(action: onNew) {
                Text("Build a routine")
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            Button(action: onStartLogging) {
                Text("Just start logging")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.inkDim)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary - 10)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, WindmillSpace.x6)
    }

    private var newRoutine: some View {
        Button(action: onNew) {
            Text("New routine")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
        .padding(.top, WindmillSpace.x2)
    }

    private var justStartLogging: some View {
        Button(action: onStartLogging) {
            Text("Just start logging")
                .font(WindmillFont.body(15, .semibold))
                .foregroundStyle(skin.accent)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
        }
    }

    // The newest pending proposal, and only while its routine is on screen to be named.
    @ViewBuilder
    private var waiting: some View {
        if let head = store.proposals.first(where: { $0.isPending && !setAside.contains($0.id) }),
           let routine = store.routines.first(where: { $0.id == head.routineId }) {
            ProposalCard(head: head, routineName: routine.name,
                         onReview: { onProposal(head.id) },
                         onLater: { onLater(head.id) },
                         onAsk: onAsk)
        }
    }

    private var claimOffer: some View {
        Button(action: onSignIn) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Your log is saved on this device.")
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.ink)
                Text("Sign in to claim it to your account — and open it on the web.")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
                    .multilineTextAlignment(.leading)
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.raised))
        }
    }

    private var settingsDoor: some View {
        Button(action: onSettings) {
            HStack {
                Text("Gym settings")
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .frame(minHeight: GymTap.minimum)
        }
    }

    // The header is the door, not the whole card: a button inside a button on iOS swallows the other.
    private func row(_ routine: Routine) -> some View {
        let pending = store.pending(of: routine.id)
        return VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Button { onOpen(routine.id) } label: {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(routine.name)
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.ink)
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
            // Keyed on position, never on the movement: a routine may name one twice, and duplicate ids are undefined.
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

    // Counts what is waiting and opens the newest: the ledger keeps one pending proposal per door.
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

    // Most recently decided first: three rows are drawn and the rest are counted.
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
        let movements = count == 1 ? "1 movement" : "\(count) movements"
        guard let trained = routine.lastTrainedAtMs else { return movements }
        return "\(movements) · trained \(Readout.ago(trained, now: Int64(Date().timeIntervalSince1970 * 1000)))"
    }
}
