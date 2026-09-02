import SwiftUI
import WindmillPlatform

// A drag moves ids and never sets; a swipe only reaches a movement with no sets and no line in the frozen plan.
struct JumpSheet: View {
    let rows: [LiveLines.JumpRow]
    let assembling: Bool  // false once the session is walking a routine
    let onJump: (String) -> Void
    let onMove: (IndexSet, Int) -> Void
    let onDrop: (String) -> Void
    let onAdd: () -> Void
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("This session")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", action: onClose)
                    }
                }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            List {
                ForEach(rows) { row in
                    Button { onJump(row.id) } label: { movement(row) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        .swipeActions(edge: .trailing) {
                            if row.canDrop {
                                Button("Drop", role: .destructive) { onDrop(row.id) }
                            }
                        }
                }
                .onMove(perform: onMove)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, GymTap.minimum)

            Text(teaching)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(WindmillSpace.x3)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accentSoft))

            Button(action: onAdd) {
                Text("+ Add next movement")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary - 8)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }

            if let next = rows.first(where: \.isJustAdded) {
                Button { onJump(next.id) } label: {
                    Text("Log a set of \(next.name)")
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.onAccent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
                }
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.canvas)
    }

    private var teaching: String {
        guard assembling else { return "Drag to reorder, swipe to drop." }
        return "Drag to reorder, swipe to drop. What you lift here becomes the routine you’re offered "
            + "at the end, in the order you did it."
    }

    private func movement(_ row: LiveLines.JumpRow) -> some View {
        HStack(alignment: .top, spacing: WindmillSpace.x3) {
            VStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { _ in
                    Capsule().fill(row.isCurrent ? skin.accent : skin.inkFaint).frame(height: 2)
                }
            }
            .frame(width: 16)
            .padding(.top, 7)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(row.name)
                        .font(WindmillFont.body(17, row.isCurrent ? .bold : .semibold))
                        .foregroundStyle(row.isCurrent ? skin.accent : skin.ink)
                    Spacer(minLength: 0)
                    Text(row.meta)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(row.isJustAdded ? skin.accent : skin.inkFaint)
                }
                if let note = row.note {
                    Text(note)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                }
                ForEach(row.sets) { set in
                    HStack(spacing: WindmillSpace.x3) {
                        Text(set.index)
                            .font(GymType.numeral(12))
                            .foregroundStyle(set.countsTowardNothing ? skin.warmupInk : skin.setDone)
                            .frame(width: 12, alignment: .leading)
                        Text(set.value)
                            .font(GymType.numeral(13))
                            .foregroundStyle(set.countsTowardNothing ? skin.warmupInk : skin.inkDim)
                        Text(set.note)
                            .font(GymType.numeral(11))
                            .foregroundStyle(set.isOnThisDevice ? skin.unsyncedInk : skin.inkFaint)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
            .fill(row.isCurrent ? skin.raised : skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
            .strokeBorder(row.isCurrent ? skin.accent : skin.line, lineWidth: 1))
    }
}
