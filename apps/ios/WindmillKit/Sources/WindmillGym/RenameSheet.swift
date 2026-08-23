import SwiftUI
import WindmillPlatform

struct RenameSheet: View {
    let title: String
    let prompt: String
    let proof: [Record.Proof]
    let save: (String) async -> TrainingStore.WriteFailure?
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var name: String
    @State private var failure: TrainingStore.WriteFailure?
    @State private var saving = false
    @FocusState private var typing: Bool

    init(current: String, title: String, prompt: String, proof: [Record.Proof] = [],
         save: @escaping (String) async -> TrainingStore.WriteFailure?,
         onClose: @escaping () -> Void) {
        self.title = title
        self.prompt = prompt
        self.proof = proof
        self.save = save
        self.onClose = onClose
        _name = State(initialValue: current)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            Text(title)
                .font(WindmillFont.display(22))
                .foregroundStyle(skin.ink)

            field

            if !proof.isEmpty { proven }

            if let failure {
                Text(failure.line("the name didn’t change"))
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.alarmInk)
                    .lineSpacing(3)
            }

            // Trim whitespace and newlines: `.whitespaces` excludes `\n`.
            Button {
                Task {
                    saving = true
                    failure = await save(name.trimmingCharacters(in: .whitespacesAndNewlines))
                    saving = false
                }
            } label: {
                Text(saving ? "Saving…" : "Rename")
                    .font(WindmillFont.body(16, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("Cancel", action: onClose)
                .font(WindmillFont.body(13.5, .bold))
                .foregroundStyle(skin.inkFaint)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.surface)
        .task { typing = true }
    }

    private var field: some View {
        HStack(spacing: WindmillSpace.x3) {
            TextField("", text: $name, prompt: Text(prompt).foregroundStyle(skin.inkFaint))
                .font(WindmillFont.body(18, .bold))
                .foregroundStyle(skin.ink)
                .textFieldStyle(.plain)
                .focused($typing)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                // Sixty characters or eighty bytes, whichever runs out first; only fresh typing is bounded.
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
        .frame(height: GymTap.primary - 6)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.canvas))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(skin.accent, lineWidth: 1.5))
    }

    private var proven: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(spacing: WindmillSpace.x2) {
                Text("✓")
                    .font(WindmillFont.body(14))
                    .foregroundStyle(skin.setDone)
                Text("Everything follows the name")
                    .font(WindmillFont.body(13, .bold))
                    .foregroundStyle(skin.setDone)
            }
            VStack(alignment: .leading, spacing: 5) {
                ForEach(proof) { line in
                    HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                        Text(line.label)
                            .foregroundStyle(skin.inkFaint)
                            .frame(width: 82, alignment: .leading)
                        Text(line.said)
                            .foregroundStyle(skin.inkDim)
                        Spacer(minLength: 0)
                    }
                }
            }
            .font(GymType.numeral(12.5))
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.canvas))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(skin.setDone, lineWidth: 1))
    }
}
