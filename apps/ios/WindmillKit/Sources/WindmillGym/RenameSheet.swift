import SwiftUI
import WindmillPlatform

// RENAME (§N screen 32) — the sheet a MOVEMENT renames from, over its record. A routine used to
// share it from its own header; since the 13 Aug update (R2/R3) a routine renames by editing the
// inline name in the one editor, so the movement's record is this sheet's only door now.
//
// A NAME IS A LABEL ON A STABLE ID, so renaming is not destructive and never forks a record. That is
// the claim, and this screen is the one place in the product whose whole job is to PROVE it — which
// is why every number in the block below comes off a read the page behind this sheet already made.
// A constant there would be the product asserting something it did not check, on the one screen that
// cannot afford to.
//
// The sheet stays up until the log answers. A rename that did not happen may not close as though it
// had, and the refusal is repeated in the log's own words where it sent any.
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

            // WHITESPACE AND NEWLINES BOTH, and the two must be the same trim. `.whitespaces` is
            // spaces and tabs and NOT `\n`, so a pasted newline passed this guard as a name — and on
            // a movement still on this device's shelf there is no server behind it to state the
            // emptiness rule, which left the room drawing a blank at 28pt. What a name may be is
            // still the log's to say; that it is not blank is a thing this sheet already claimed to
            // check, and it now checks it.
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
                // The client's cap, applied where the name is TYPED: sixty characters (§N) and the
                // eighty BYTES the column counts, whichever runs out first. It refuses nothing
                // already stored — a name that arrived longer is drawn and counted as it stands, and
                // only fresh typing is bounded.
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

    // The proof, in the ink the room keeps for something that is settled rather than celebrated. It
    // replaced a paragraph explaining that a rename is safe: the paragraph was an argument about how
    // we built this, and these are four facts about the lifter's own log.
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
