import SwiftUI
import WindmillPlatform

// Fixing a set moves the log only: the frozen plan snapshot and the program keep their own numbers, and nothing here is
// recoverable once saved.
struct FixSheet: View {
    let set: TrainingSet
    let movement: String
    let number: String
    // nil when the session ran against no program.
    let routine: String?
    let onSave: (SetFix) -> Void
    let onDelete: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var weightKg: Double
    @State private var reps: Int
    @State private var kind: SetKind

    init(set: TrainingSet, movement: String, number: String, routine: String?,
         onSave: @escaping (SetFix) -> Void, onDelete: @escaping () -> Void) {
        self.set = set
        self.movement = movement
        self.number = number
        self.routine = routine
        self.onSave = onSave
        self.onDelete = onDelete
        _weightKg = State(initialValue: set.weightKg)
        _reps = State(initialValue: set.reps)
        _kind = State(initialValue: set.kind)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            head
            weight
            ladder
            repsRow
            kinds
            save
            deleteRow
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(skin.surface)
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
            Text("Fix this set")
                .font(WindmillFont.display(22))
                .foregroundStyle(skin.ink)
            Spacer(minLength: 0)
            Text("\(movement) · set \(number)")
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
                .lineLimit(1)
        }
    }

    private var weight: some View {
        HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
            Text(Readout.weight(weightKg))
                .font(GymType.correction)
                .foregroundStyle(skin.weightInk)
                .lineLimit(1)
                .minimumScaleFactor(0.55)
            Text("kg")
                .font(WindmillFont.body(18, .bold))
                .foregroundStyle(skin.inkFaint)
        }
        .frame(maxWidth: .infinity)
    }

    private var ladder: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(Array(Ladder.labels(for: weightKg).enumerated()), id: \.offset) { index, label in
                Button { weightKg = Ladder.bump(weight: weightKg, direction: index < 2 ? -1 : 1,
                                                big: index == 0 || index == 3) } label: {
                    Text(label)
                        .font(GymType.numeral(15.5, .semibold))
                        .foregroundStyle(skin.ink)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
                }
            }
        }
    }

    private var repsRow: some View {
        HStack(spacing: WindmillSpace.x3) {
            Text("Reps")
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
            Spacer(minLength: 0)
            Button { reps = Ladder.bumpReps(reps, direction: -1) } label: { step("−") }
                .accessibilityLabel("One rep fewer")
            Text(String(reps))
                .font(GymType.numeral(22, .bold))
                .foregroundStyle(skin.ink)
                .frame(minWidth: 42)
                .multilineTextAlignment(.center)
            Button { reps = Ladder.bumpReps(reps, direction: 1) } label: { step("+") }
                .accessibilityLabel("One rep more")
        }
    }

    private func step(_ glyph: String) -> some View {
        Text(glyph)
            .font(WindmillFont.display(19, .semibold))
            .foregroundStyle(skin.ink)
            .frame(width: GymTap.minimum, height: GymTap.minimum)
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.lineStrong, lineWidth: 1))
    }

    // Every record rule and the prefill read `working` only.
    private var kinds: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(SetKind.allCases, id: \.self) { choice in
                Button { kind = choice } label: {
                    Text(choice.rawValue)
                        .font(WindmillFont.body(12.5, choice == kind ? .bold : .semibold))
                        .foregroundStyle(ink(of: choice))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .fill(choice == kind ? skin.accentSoft : .clear))
                        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .strokeBorder(choice == kind ? skin.lineStrong : skin.line, lineWidth: 1))
                }
                .accessibilityAddTraits(choice == kind ? [.isSelected] : [])
            }
        }
    }

    private func ink(of choice: SetKind) -> Color {
        if choice == .warmup { return skin.warmupInk }
        if choice != kind { return skin.inkDim }
        return choice == .working ? skin.setDone : skin.ink
    }

    private var save: some View {
        Button { onSave(SetFix(weightKg: weightKg, reps: reps, kind: kind)) } label: {
            Text("Save the fix")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
    }

    private var deleteRow: some View {
        HStack(spacing: WindmillSpace.x3) {
            Button("Delete set", action: onDelete)
                .font(WindmillFont.body(14, .bold))
                .foregroundStyle(skin.alarmInk)
                .frame(minHeight: GymTap.minimum)
            Spacer(minLength: 0)
            if let routine {
                Text("\(routine) keeps its own numbers")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
            }
        }
    }
}
