import SwiftUI
import WindmillPlatform

// Trained most recently first; the row opens the routine and never starts it.
// The screen's title is the navigation bar's, and `New routine` is a toolbar action the room draws:
// planning work goes to the top chrome, and the reach band holds what a lifter does with a bar in
// their hands (`12-native-idiom.md`).

struct RoutinesScreen: View {
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool
    // Proposals whose review was closed without a decision this visit: the card reads `still waiting`.
    let undecided: Set<String>
    let onOpen: (String) -> Void
    // Withheld for nine seconds and taken back on the room's transient: nothing is on the wire yet.
    let onDelete: (Routine) -> Void
    let onNew: () -> Void
    let onStartLogging: () -> Void
    let onMovement: (String) -> Void
    let onProposal: (String) -> Void
    let onSettings: () -> Void
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    // Every section carries it, empty state included: the room's margin is one number, and a section
    // that leaves it out draws its content 3pt off the cards above it.
    private let rowInsets = EdgeInsets(top: 4, leading: WindmillSpace.x5,
                                       bottom: 4, trailing: WindmillSpace.x5)

    var body: some View {
        List {
            standing
            if store.routines.isEmpty {
                Section { empty }
                    .listRowBackground(Color.clear)
                    .listRowInsets(rowInsets)
            } else {
                Section {
                    ForEach(store.routines) { routine in
                        row(routine)
                            // One action, trailing, no full swipe: Duplicate stays in the editor's
                            // overflow, because two revealed actions hide the routine's own name
                            // while the lifter decides which one they are deciding about.
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    GymConfirm.revealed()
                                    onDelete(routine)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                } header: {
                    Text("\(Readout.routineCount(store.routines.count)) · nothing running")
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(rowInsets)
            }
            doors
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, GymTap.minimum)
        .safeAreaInset(edge: .bottom) { reachBand }
    }

    // The one thing a lifter does with a bar in their hands, at every scroll position — and only where
    // the empty state is not already offering it as one of its two.
    @ViewBuilder
    private var reachBand: some View {
        if !store.routines.isEmpty {
            Button(action: onStartLogging) {
                Text("Just start logging")
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.bottom, WindmillSpace.x2)
        }
    }

    @ViewBuilder
    private var standing: some View {
        Section {
            RefusalRows(refusals: store.refusals, catalog: store.catalog,
                        onDismiss: { store.clearRefusals() })
            waiting
            if !isSignedIn { claimOffer }
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(rowInsets)
    }

    private var empty: some View {
        VStack(spacing: WindmillSpace.x4) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(skin.inkFaint)
                .frame(width: 62, height: 62)
            Text("No routines yet")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.ink)
            Text("A routine is one training day written down — the movements, in order, with your targets.")
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .multilineTextAlignment(.center)
            // Two actions of deliberately different weight, which is why this state is drawn by hand
            // rather than handed to `ContentUnavailableView` — it renders one.
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
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .padding(.vertical, WindmillSpace.x6)
        .listRowSeparator(.hidden)
    }

    // The newest pending proposal, and only while its routine is on screen to be named.
    @ViewBuilder
    private var waiting: some View {
        if let head = store.proposals.first(where: \.isPending),
           let routine = store.routines.first(where: { $0.id == head.routineId }) {
            ProposalCard(head: head, routineName: routine.name, undecided: undecided.contains(head.id),
                         onReview: { onProposal(head.id) })
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
        .buttonStyle(.plain)
    }

    // The connect pitch has two homes and this list is neither: the settings row below and the page
    // it opens (`15-the-routine.md`, I33). A room-level interruption in the middle of doing something
    // else is exactly what the other two homes were cut for.
    @ViewBuilder
    private var doors: some View {
        Section {
            Button(action: onSettings) {
                HStack {
                    Label("Gym settings", systemImage: "gearshape")
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.inkFaint)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .frame(minHeight: GymTap.minimum)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Gym settings")
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(rowInsets)
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
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let newest = pending.first { waiting(newest, of: pending.count) }
            // A LIST of routines names movements and no targets (C16): the numbers are read on the
            // routine's own screen, which is where the `open` in a target column is explained. This
            // card is a door, and a door does not restate what is behind it.
            // Keyed on position, never on the movement: a routine may name one twice, and duplicate ids are undefined.
            ForEach(routine.entries.sorted { $0.position < $1.position }, id: \.position) { entry in
                MovementDoor(exerciseId: entry.exerciseId,
                             name: Readout.movement(entry.exerciseId, in: store.catalog),
                             font: WindmillFont.body(14), ink: skin.inkDim, open: onMovement)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            history(of: routine)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(pending.isEmpty ? skin.line : skin.accent, lineWidth: 1))
        .listRowInsets(rowInsets)
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
                .buttonStyle(.plain)
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
