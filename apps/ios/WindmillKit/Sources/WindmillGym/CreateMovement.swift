import SwiftUI
import WindmillPlatform

// §N SCREEN 31 — a movement that is not in our sixty-four, in exactly two questions: what you call
// it, and how it is loaded. Every gym has a machine with no real name and a lifter who calls the
// incline bench "the slanty one", so naming is not an admin chore in this product.
//
// WHAT IS NOT ASKED is the design. No approval, no moderation, no "is this the same as Bench Press?"
// at creation time, no muscle group, no category, no icon, and no character rule beyond a length —
// we do not correct anyone's spelling of their own gym. Any language, any spelling, any punctuation.
//
// It replaced a create that asked NOTHING: the picker's `Create "{query}"` minted the movement on
// the spot with `equipment: "barbell"` written in by the client, which is a fact about somebody's
// gym invented by a phone. Two taps is the price of not making that up.

public enum Equipment {
    // THE FOUR THE BOARD DRAWS, and the schema's other two — cable and kettlebell — stay valid on
    // every read, because seeded movements use them. A creation screen is not a taxonomy: these are
    // the four a lifter minting their own movement is choosing between, and a longer list would be
    // asking them to classify rather than to answer.
    //
    // The value is the wire's and the label is the room's, in one row, so a spelling cannot drift
    // between what is drawn and what is sent.
    public static let offered = [("barbell", "Barbell"), ("dumbbell", "Dumbbell"),
                                 ("machine", "Machine"), ("bodyweight", "Bodyweight")]
}

// It is a SHEET and not a screen on the room's stack, because it is opened from inside the picker —
// which is itself a sheet over a live session, where a workout outranks every away screen. Reached
// from the routine editor it behaves identically; the movement lands in whatever asked for it.
struct CreateMovementSheet: View {
    let opening: String
    let creating: Bool
    let failure: String?
    let onCreate: (String, String) -> Void
    let onCancel: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var name: String
    // No default, because a default is this screen answering its own second question. The primary
    // stays inactive until both are answered — the four options are directly above it and one tap
    // lights it, which is the room's own shape for a control that is not ready yet.
    @State private var equipment: String?
    @FocusState private var typing: Bool

    init(opening: String, creating: Bool = false, failure: String? = nil,
         onCreate: @escaping (String, String) -> Void, onCancel: @escaping () -> Void) {
        self.opening = opening
        self.creating = creating
        self.failure = failure
        self.onCreate = onCreate
        self.onCancel = onCancel
        _name = State(initialValue: opening)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            HStack {
                Button("Cancel", action: onCancel)
                    .font(WindmillFont.body(14, .bold))
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
                Spacer(minLength: WindmillSpace.x3)
                Text("not in the library")
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
            }

            Text("Your movement")
                .font(WindmillFont.display(28))
                .foregroundStyle(skin.ink)

            field
            loaded

            if let failure {
                Text(failure)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.alarmInk)
                    .lineSpacing(3)
            }

            Spacer(minLength: 0)
            create
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.canvas)
        // Arrived at by typing a name the catalog does not hold, so the field is the thing in hand:
        // the keyboard stays up on a name that may want one more word.
        .task { typing = true }
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("NAME")
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            HStack(spacing: WindmillSpace.x3) {
                TextField("", text: $name,
                          prompt: Text("Hammer row").foregroundStyle(skin.inkFaint))
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.ink)
                    .textFieldStyle(.plain)
                    .focused($typing)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.words)
                    // Both bounds, where the name is typed: sixty characters and the eighty bytes
                    // the column holds. A movement called "жим лёжа узким хватом" is a name this
                    // product promises to take, and a client that counted only characters would let
                    // it grow past what the log can store and then refuse it at the tap.
                    .onChange(of: name) { _, typed in
                        let kept = RoutineDraft.capped(typed)
                        guard kept != typed else { return }
                        name = kept
                    }
                Text(RoutineDraft.counter(name))
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            .padding(.horizontal, WindmillSpace.x4)
            .frame(height: GymTap.primary - 8)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.accent, lineWidth: 1.5))
        }
    }

    private var loaded: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("HOW IS IT LOADED?")
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            LazyVGrid(columns: Array(repeating: GridItem(spacing: WindmillSpace.x2), count: 2),
                      spacing: WindmillSpace.x2) {
                ForEach(Equipment.offered, id: \.0) { value, label in
                    let picked = equipment == value
                    Button { equipment = value } label: {
                        Text(label)
                            .font(WindmillFont.body(14, picked ? .bold : .semibold))
                            .foregroundStyle(picked ? skin.accent : skin.inkDim)
                            .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                                .fill(picked ? skin.accentSoft : skin.surface))
                            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                                .strokeBorder(picked ? skin.accent : skin.line,
                                              lineWidth: picked ? 1.5 : 1))
                    }
                    .accessibilityAddTraits(picked ? [.isSelected] : [])
                }
            }
        }
    }

    private var create: some View {
        let said = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let ready = !said.isEmpty && equipment != nil
        return Button { if let equipment { onCreate(said, equipment) } } label: {
            Text(creating ? "Creating…" : "Create and add")
                .font(WindmillFont.body(16.5, .bold))
                .foregroundStyle(ready ? skin.onAccent : skin.inkFaint)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(ready ? skin.accent : skin.raised))
        }
        .disabled(creating || !ready)
    }
}
