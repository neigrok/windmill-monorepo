import SwiftUI
import WindmillPlatform

public enum Equipment {
    // The four the board draws; the schema's cable and kettlebell stay valid on read. Wire value, then room label.
    public static let offered = [("barbell", "Barbell"), ("dumbbell", "Dumbbell"),
                                 ("machine", "Machine"), ("bodyweight", "Bodyweight")]
}

struct CreateMovementSheet: View {
    let opening: String
    let creating: Bool
    let failure: String?
    let onCreate: (String, String) -> Void
    let onCancel: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var name: String
    // nil is unanswered.
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
