import SwiftUI
import WindmillPlatform

// THIS SESSION, as a list — the only thing in the logger that moves the lifter between movements.
// Nothing advances on its own: not when a plan's set count is reached, not when a rest lands. The
// sheet says where everything stands and the choice stays theirs.
//
// IT IS THE ASSEMBLY SURFACE (§A screen 2). The first routine is a by-product of the first session:
// nobody assembles a six-exercise program standing in a gym, but everybody performs one — so this
// list, appended to on the bench mid-rest, IS the routine offered at the end. That is why the two
// gestures are here and not in an editor: drag to reorder, swipe to drop.
//
// WHAT A GESTURE MAY NOT DO is the whole of its safety. A drag moves ids and never sets — the sets
// are keyed by session and movement and this list does not hold them — and a swipe only reaches a
// movement nothing is holding on to: no sets logged, and no line in the frozen plan
// (`LiveOrder.droppable`). A lift cannot be swiped away, and the list cannot lose one by being
// rearranged.

struct JumpSheet: View {
    let rows: [LiveLines.JumpRow]
    let assembling: Bool        // false once the session is walking a routine — see `teaching`
    let onJump: (String) -> Void
    let onMove: (IndexSet, Int) -> Void
    let onDrop: (String) -> Void
    let onAdd: () -> Void
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            HStack {
                Text("This session")
                    .font(WindmillFont.display(20))
                    .foregroundStyle(skin.ink)
                Spacer()
                Button("Close", action: onClose)
                    .font(WindmillFont.body(16))
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
            }

            // A List rather than the ScrollView this used to be, and only for the two gestures: it is
            // what carries `onMove` and the trailing swipe. Every piece of its own chrome is turned
            // off — the room draws its own rows, and a system separator in here would be the one
            // hairline in gym that came from somewhere else.
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

            // §A screen 2's primary, and it exists exactly when there is something to aim it at: the
            // movement just added, which is the one thing on this list with no sets in it yet. It is
            // the row's own tap, given the thumb zone — a lifter who added a movement mid-rest is
            // going back to the bar, not reading a list.
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

    // The gestures are invisible until they are used, so they are named once, here.
    //
    // TWO SCREENS OF THE BOARD DISAGREE AND THIS SENTENCE IS WHERE IT SHOWS. Screen 2 says "this list
    // is the routine you will be offered at the end"; screen 3 offers one composed "in the order you
    // did them" (`RoutineWrite(named:from:)`, which reads the sets and never this order). They only
    // differ once a drag has moved a movement out of the order it was performed in — so what is
    // promised here is what is true of both: the movements you LIFT become the routine, in the order
    // you lifted them. A drag moves today's walk, which is what a lifter mid-session is asking of it.
    //
    // The second half is withheld from a session that already has a routine written down for it,
    // because that one is never offered another at the end — and promising it would be the room
    // describing a screen the lifter will not be shown. That is ONE of the three things
    // `FinishedSession.offersRoutine` asks, and the only one that can be known while this sheet is
    // open: whether the session ends up too slight to say anything about, and whether any working
    // set is ever logged into it, are facts about a workout still being performed. Both can only
    // narrow the offer, and both are narrowed by the lifter doing less — so a sentence about what
    // "what you lift" becomes stays true of every session that lifts anything.
    private var teaching: String {
        guard assembling else { return "Drag to reorder, swipe to drop." }
        return "Drag to reorder, swipe to drop. What you lift here becomes the routine you’re offered "
            + "at the end, in the order you did it."
    }

    private func movement(_ row: LiveLines.JumpRow) -> some View {
        HStack(alignment: .top, spacing: WindmillSpace.x3) {
            // The grab rail §A screen 2 puts on every row. It is a sign rather than a handle — the
            // whole row drags — so it is drawn and never tapped.
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
