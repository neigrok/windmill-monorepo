import SwiftUI
import UIKit
import WindmillPlatform

// A set carries two records the numbers do not: how hard it was, and whatever the lifter wanted to
// remember about it. Both round-trip on the wire and both are the lifter's own — Coach reads the log,
// and a note is not an instruction to it.
public enum SetRecord {
    // The server's own bound, refused HERE: its 400 is the generic `could not read that fix`, so this
    // sentence is the only one a lifter will ever read about it.
    public static let maxNoteBytes = 4000
    // A counter is chrome a short note never carries: it appears in the last fifth of the bound.
    public static let counterFromBytes = 3200

    // 6 is where a rating starts telling you anything; below it every set is "easy".
    public static let ratings: [Double] = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]

    public static let rpeLabel = "RPE"
    public static let rpeUnrated = "Not rated"
    public static let noteField = "Set note"
    public static let noteCaption = "A record for you — not an instruction to Coach."
    public static let noteTooLong = "A set note runs to 4000 bytes."

    public static func noteBytes(_ note: String) -> Int {
        note.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count
    }

    public static func counter(bytes: Int) -> String? {
        guard bytes >= counterFromBytes else { return nil }
        return "\(bytes) of \(maxNoteBytes) bytes"
    }

    // What the field's foot draws, and whether it draws in the alarm ink. A byte counter over its
    // bound goes alarm wherever it is drawn — the note editor keeps that rule one screen away, and
    // a fix sheet keeping a second rule for the same shape is the same room disagreeing with itself.
    public struct Foot: Equatable {
        public let counter: String?
        public let refusal: String?
        public let caption: String?

        public var alarms: Bool { refusal != nil }
    }

    public static func foot(note: String) -> Foot {
        let counted = counter(bytes: noteBytes(note))
        if let refused = refusal(note: note) {
            return Foot(counter: counted, refusal: refused, caption: nil)
        }
        if counted != nil { return Foot(counter: counted, refusal: nil, caption: nil) }
        return Foot(counter: nil, refusal: nil, caption: noteCaption)
    }

    // nil while the note is within bounds; otherwise the sentence the server cannot say for itself.
    public static func refusal(note: String) -> String? {
        guard noteBytes(note) > maxNoteBytes else { return nil }
        return noteTooLong
    }
}

// Fixing a set moves the log only: the frozen plan snapshot and the program keep their own numbers.
// Only what the lifter actually moved is sent — the log has no concurrency guard, so a sheet that
// posted its whole state would silently overwrite whatever another device wrote since.
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
    @State private var rpe: Double?
    @State private var note: String
    // A correction at the rack is one-handed too, so the numeral and the rep count are typeable here
    // exactly as they are in the logger: the same `KeypadSheet`, the same live band (C10).
    @State private var typing: KeypadEntry.Mode?
    // A sheet at a detent does not resize for the keyboard, so the platform's own avoidance never
    // reaches this scroll view: it keeps the FOCUSED field visible and leaves everything under the
    // keyboard where it is, with a content shorter than the viewport and so nothing to scroll. Both
    // of the sheet's commits live at the foot, and without this they cannot be reached at all while
    // the note is being written. This is Android's `imePadding()`, spelled out.
    @State private var keyboardInset: CGFloat = 0

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
        _rpe = State(initialValue: set.rpe)
        _note = State(initialValue: set.note)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                weight
                ladder
                repsRow
                kinds
                rating
                noteRow
                save
                deleteRow
            }
            .padding(WindmillSpace.x5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaPadding(.bottom, keyboardInset)
        .background(skin.surface)
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillChangeFrameNotification)) { raised in
                let keyboard = raised.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue
                keyboardInset = keyboard?.cgRectValue.height ?? 0
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIResponder.keyboardWillHideNotification)) { _ in keyboardInset = 0 }
        .sheet(item: $typing) { mode in
            KeypadSheet(mode: mode,
                        current: mode == .weight ? weightKg : Double(reps),
                        onCommit: { typed in
                            if mode == .weight { weightKg = typed } else { reps = Int(typed) }
                            typing = nil
                        },
                        onCancel: { typing = nil })
                .presentationBackground(skin.surface)
                .presentationDetents([.height(520)])
        }
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
            Button { typing = .weight } label: {
                Text(Readout.weight(weightKg))
                    .font(GymType.correction)
                    .foregroundStyle(skin.weightInk)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                    .overlay(alignment: .bottom) { TypeableRule() }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Weight \(Readout.weight(weightKg)) kilograms")
            .accessibilityHint("Type a weight")
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
            Button { reps = Ladder.bumpReps(reps, direction: -1) } label: { step("minus") }
                .accessibilityLabel("One rep fewer")
            Button { typing = .reps } label: {
                Text(String(reps))
                    .font(GymType.numeral(22, .bold))
                    .foregroundStyle(skin.ink)
                    .overlay(alignment: .bottom) { TypeableRule() }
                    .frame(minWidth: 42, minHeight: GymTap.minimum)
                    .multilineTextAlignment(.center)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(reps) reps")
            .accessibilityHint("Type a rep count")
            Button { reps = Ladder.bumpReps(reps, direction: 1) } label: { step("plus") }
                .accessibilityLabel("One rep more")
        }
    }

    private func step(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .semibold))
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

    // The platform's own segmented control, because it is one: nine values, one armed, and the tap
    // floor, Dynamic Type and the rotor are all the platform's to keep. Clearing is its own control,
    // because a segment that clears itself when tapped twice is invisible.
    private var rating: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack {
                Text(SetRecord.rpeLabel)
                    .font(WindmillFont.body(14))
                    .foregroundStyle(skin.inkDim)
                Spacer(minLength: 0)
                if rpe != nil {
                    Button(SetRecord.rpeUnrated) { rpe = nil }
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                        .frame(minHeight: GymTap.minimum - 12)
                }
            }
            Picker(SetRecord.rpeLabel, selection: Binding(get: { rpe ?? 0 },
                                                          set: { rpe = $0 == 0 ? nil : $0 })) {
                ForEach(SetRecord.ratings, id: \.self) { rated in
                    // Named rather than left as a bare numeral: a row of nine digits says nothing to
                    // a screen reader, and this sheet already draws a rep count and a weight.
                    Text(Readout.rpe(rated))
                        .accessibilityLabel("\(SetRecord.rpeLabel) \(Readout.rpe(rated))")
                        .tag(rated)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var noteRow: some View {
        let foot = SetRecord.foot(note: note)
        return VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(SetRecord.noteField)
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
            TextField("", text: $note, axis: .vertical)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.ink)
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .padding(WindmillSpace.x3)
                .frame(minHeight: GymTap.minimum, alignment: .topLeading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(foot.alarms ? skin.alarmInk : skin.lineStrong, lineWidth: 1))
            if let counter = foot.counter {
                Text(counter)
                    .font(GymType.numeral(12))
                    .foregroundStyle(foot.alarms ? skin.alarmInk : skin.inkFaint)
            }
            if let refusal = foot.refusal {
                Text(refusal)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.alarmInk)
            }
            if let caption = foot.caption {
                Text(caption)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var save: some View {
        Button { onSave(correction) } label: {
            Text("Save the fix")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(SetRecord.refusal(note: note) == nil ? skin.accent : skin.raised))
        }
        .disabled(SetRecord.refusal(note: note) != nil)
    }

    private var correction: SetFix {
        SetFix(of: set, weightKg: weightKg, reps: reps, kind: kind, rpe: rpe,
               note: note.trimmingCharacters(in: .whitespacesAndNewlines))
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
