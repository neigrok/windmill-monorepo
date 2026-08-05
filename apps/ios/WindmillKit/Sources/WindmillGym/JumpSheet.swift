import SwiftUI
import WindmillPlatform

// THIS SESSION, as a list — the only thing in the logger that moves the lifter between movements.
// Nothing advances on its own: not when a plan's set count is reached, not when a rest lands. The
// sheet says where everything stands and the choice stays theirs.
//
// The last row is the assembly surface the design is built on (screen 2): a movement appended here,
// on the bench, mid-rest, is how a routine gets written in this product — not in an editor, before
// the first set, standing up.

struct JumpSheet: View {
    let rows: [LiveLines.JumpRow]
    let onJump: (String) -> Void
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

            ScrollView {
                VStack(spacing: 0) {
                    ForEach(rows) { row in
                        Button { onJump(row.id) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(row.name)
                                    .font(WindmillFont.body(17, row.isCurrent ? .semibold : .regular))
                                    .foregroundStyle(row.isCurrent ? skin.steel : skin.ink)
                                Text(row.meta)
                                    .font(GymType.numeral(12))
                                    .foregroundStyle(skin.inkFaint)
                            }
                            .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 10, alignment: .leading)
                        }
                        Rectangle().fill(skin.line).frame(height: 1)
                    }
                }
            }

            Button(action: onAdd) {
                Text("+ Add next movement")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.steel)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary - 8)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.surface)
    }
}
