import SwiftUI
import UIKit
import WindmillPlatform

// Save enables when the draft is savable: named and holding a movement on a build, and changed as well on an edit — re-sending
// an unchanged document would move the revision and set pending proposals aside for nothing.
struct RoutineEditorScreen: View {
    let catalog: [Exercise]
    // The log this device holds, newest first: the picker's six are ranked from it (C2).
    let sessions: [SessionSummary]
    let editing: Bool
    let untested: Bool
    let saving: Bool
    let failure: String?
    let onSave: (RoutineDraft) -> Void
    // The way out that is not Save. It asks first whenever the draft has moved off what was loaded.
    let onCancel: () -> Void
    // Deleting is not here: the editor sits three screens deep, and the routine row's own trailing
    // swipe is where Delete lives (`13-gestures.md`).
    let onCreateMovement: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>

    @Environment(\.gymSkin) private var skin
    @State private var draft: RoutineDraft
    // Kept for edit mode's changed-rule: the comparison is over the write, since line ids are this screen's own.
    private let opening: RoutineDraft
    @State private var sheet: Sheet?
    @State private var abandoning = false
    @FocusState private var namingIt: Bool

    // The Cancel confirmation, asked only when there is something to lose.
    enum Abandon {
        static let title = "Discard these edits?"
        static let body = "Nothing is saved. The routine stays as it was."
        static let confirm = "Discard"
        static let keep = "Keep editing"
    }

    // Creating a movement is not here: it is drawn over the picker that opened it, by the picker
    // (`15-the-routine.md`), so the search a lifter typed is still there when they cancel.
    private enum Sheet: Identifiable {
        case picking
        // The line and never its place: a drag moves places.
        case targeting(String)

        var id: String {
            switch self {
            case .picking: return "picking"
            case .targeting(let lineId): return "targeting:\(lineId)"
            }
        }
    }

    init(draft: RoutineDraft, catalog: [Exercise], sessions: [SessionSummary], editing: Bool,
         untested: Bool, saving: Bool, failure: String?,
         onSave: @escaping (RoutineDraft) -> Void,
         onCancel: @escaping () -> Void,
         onCreateMovement: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>) {
        self.catalog = catalog
        self.sessions = sessions
        self.editing = editing
        self.untested = untested
        self.saving = saving
        self.failure = failure
        self.onSave = onSave
        self.onCancel = onCancel
        self.onCreateMovement = onCreateMovement
        self.opening = draft
        _draft = State(initialValue: draft)
    }

    private var savable: Bool {
        guard editing else { return draft.isSavable }
        return draft.isSavable && draft.write != opening.write
    }

    // What Cancel would throw away. An untouched draft leaves without a question.
    private var moved: Bool { draft.write != opening.write }

    var body: some View {
        List {
            // The refusal sits under the field it is about, which is also the first of the two things
            // it can be about — and it says why Save is grey rather than leaving the lifter to guess.
            Section {
                nameField
            } footer: {
                // The faint ink, never the alarm: the alarm is for a write that failed (`GymSkin`),
                // and a draft that is not finished has sent nothing and been refused nothing. The
                // failure section at the foot of this screen is the one that did.
                if let why = draft.saveRefusal {
                    Text(why)
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.inkFaint)
                        .lineSpacing(3)
                }
            }

            Section {
                ForEach(draft.lines) { line in
                    Button { sheet = .targeting(line.id) } label: { row(line.entry) }
                        .buttonStyle(.plain)
                        .listRowBackground(skin.surface)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { draft.remove(line.id) } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                }
                .onMove { draft.move(from: $0, to: $1) }
                add
            } header: {
                Text("Movements")
                    .foregroundStyle(skin.inkFaint)
            } footer: {
                // A row's target column reads `open` for itself; the sheet says what that means the
                // moment a line is opened, and the list says nothing more.
                if draft.lines.isEmpty {
                    Text("Add the movements, in the order you do them.")
                        .foregroundStyle(skin.inkDim)
                }
            }

            if let failure {
                Section {
                    Text(failure)
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.alarmInk)
                        .lineSpacing(3)
                }
                .listRowBackground(Color.clear)
            }

        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, GymTap.minimum)
        // Cancel replaces the chevron: a silent back is a silent discard of every edit, and the system
        // back button cannot be asked a question before it runs.
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") {
                    guard moved else { return onCancel() }
                    abandoning = true
                }
                .disabled(saving)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(saving ? "Saving…" : "Save") { onSave(draft) }
                    .font(WindmillFont.body(15, .bold))
                    .disabled(saving || !savable)
            }
        }
        // An alert rather than a confirmation dialog, and the reason is what the simulator drew: a
        // dialog raised from a toolbar item comes up as a popover, and a popover DROPS its cancel row
        // — tapping outside is the only way to keep editing, and nothing says so. An alert always
        // draws both answers.
        .alert(Abandon.title, isPresented: $abandoning) {
            Button(Abandon.confirm, role: .destructive, action: onCancel)
            Button(Abandon.keep, role: .cancel) {}
        } message: {
            Text(Abandon.body)
        }
        .task {
            guard !editing, draft.trimmedName.isEmpty else { return }
            namingIt = true
        }
        .sheet(item: $sheet) { open in
            switch open {
            case .picking:
                // `lastSets` is nil here: this screen asks the log for no history.
                MovementPicker(catalog: catalog, taken: draft.entries.map(\.exerciseId),
                               lastSets: nil, sessions: sessions,
                               onPick: { pick($0) },
                               onCreate: onCreateMovement,
                               onClose: { sheet = nil })
                    .presentationBackground(skin.canvas)
            case .targeting(let lineId):
                if let line = draft.line(lineId) {
                    TargetSheet(entry: line.entry,
                                movement: Readout.movement(line.entry.exerciseId, in: catalog),
                                place: draft.place(of: lineId),
                                untested: untested,
                                signed: catalog.first { $0.id == line.entry.exerciseId }?.equipment == "bodyweight",
                                onSet: { sets in
                                    draft.set(lineId, sets: sets)
                                    sheet = nil
                                },
                                onCancel: { sheet = nil })
                        .presentationBackground(skin.canvas)
                        .presentationDetents([.large])
                }
            }
        }
    }

    private func row(_ entry: RoutineWrite.Entry) -> some View {
        HStack(spacing: WindmillSpace.x3) {
            Text(Readout.movement(entry.exerciseId, in: catalog))
                .font(WindmillFont.body(15, .bold))
                .foregroundStyle(skin.ink)
            Spacer(minLength: WindmillSpace.x2)
            Text(Readout.target(entry.sets))
                .font(GymType.numeral(13))
                .foregroundStyle(entry.isOpen ? skin.inkFaint : skin.targetInk)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(skin.inkFaint)
        }
        .frame(minHeight: GymTap.minimum)
        .contentShape(Rectangle())
    }

    // The last row of the list rather than a floating button.
    private var add: some View {
        Button { sheet = .picking } label: {
            Label("Add movement", systemImage: "plus")
                .font(WindmillFont.body(16, .semibold))
                .foregroundStyle(skin.accent)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(skin.surface)
    }

    // Capped where it is typed, at sixty characters — the only bound a name has.
    private var nameField: some View {
        HStack(spacing: WindmillSpace.x3) {
            TextField("", text: $draft.name,
                      prompt: Text("Heavy Thursday").foregroundStyle(skin.inkFaint))
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.ink)
                .textFieldStyle(.plain)
                .focused($namingIt)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .onChange(of: draft.name) { _, typed in
                    let kept = RoutineDraft.capped(typed)
                    guard kept != typed else { return }
                    draft.name = kept
                }
            if let counted = RoutineDraft.counter(draft.name) {
                Text(counted)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .frame(minHeight: GymTap.minimum)
        .listRowBackground(skin.surface)
    }

    private func pick(_ exerciseId: String) {
        sheet = .targeting(draft.add(exerciseId).id)
    }
}

// The target sheet of brief 17: a head that speaks about every set, a ladder that speaks about
// each, one Fill menu and one commit. `TargetEntry.Draft` is its whole state — every field reads
// the draft and hands its keystroke back, so no text lives twice.
struct TargetSheet: View {
    let movement: String
    let place: String
    let untested: Bool
    // A bodyweight movement's load may be band-assisted, so its load fields carry `±` (R7).
    let signed: Bool
    // An empty scheme is the open line.
    let onSet: ([SetTarget]) -> Void
    let onCancel: () -> Void

    // The words the sheet's chrome is made of, pinned so the view and the count cannot part.
    enum Chrome {
        static let everySet = "Every set"
        static let sets = "Sets"
        static let reps = "Reps"
        static let weight = "Weight"
        static let weightLabel = "Weight · kg"
        static let setBySet = "Set by set"
        static let fill = "Fill"
        static let rampUp = "Ramp up"
        static let matchSetOne = "Match set 1"
        static let addSet = "Add set"
        static let delete = "Delete"
        static let next = "Next"
        static let done = "Done"

        static func rowReps(_ ordinal: Int) -> String { "Set \(ordinal) reps" }
        static func rowWeight(_ ordinal: Int) -> String { "Set \(ordinal) weight" }
        // The row's handle for a driven swipe: a swipe on a focused field is the field's own.
        static func row(_ ordinal: Int) -> String { "set-row-\(ordinal)" }
    }

    // What stands on the sheet at first paint besides the commit: with `Set · 5 sets`, the fourteen
    // words of brief 17. The head — title, Cancel, the place line, the never-logged card — is outside it.
    static let chrome = [Chrome.everySet, Chrome.sets, Chrome.reps, Chrome.weight, Chrome.setBySet,
                         Chrome.fill, Chrome.addSet]

    @Environment(\.gymSkin) private var skin
    @State private var draft: TargetEntry.Draft
    @FocusState private var typing: TargetEntry.Field?

    init(entry: RoutineWrite.Entry, movement: String, place: String, untested: Bool, signed: Bool,
         onSet: @escaping ([SetTarget]) -> Void, onCancel: @escaping () -> Void) {
        self.movement = movement
        self.place = place
        self.untested = untested
        self.signed = signed
        self.onSet = onSet
        self.onCancel = onCancel
        _draft = State(initialValue: TargetEntry.Draft(entry.sets))
    }

    private func refusal(under field: TargetEntry.Field) -> String? {
        guard let refusal = draft.refusal, refusal.field == field else { return nil }
        return refusal.said
    }

    // The head reads the draft and writes every row; a ladder field writes its own.
    private var setsText: Binding<String> {
        Binding(get: { draft.sets }, set: { draft.typeSets($0) })
    }

    private var repsText: Binding<String> {
        Binding(get: { draft.headReps }, set: { draft.typeReps($0) })
    }

    private var weightText: Binding<String> {
        Binding(get: { draft.headWeight }, set: { draft.typeWeight($0) })
    }

    // A row being removed is still asked for its text on its way out.
    private func rowReps(_ index: Int) -> Binding<String> {
        Binding(get: { draft.ladder.indices.contains(index) ? draft.ladder[index].reps : "" },
                set: { draft.typeReps($0, row: index) })
    }

    private func rowWeight(_ index: Int) -> Binding<String> {
        Binding(get: { draft.ladder.indices.contains(index) ? draft.ladder[index].weight : "" },
                set: { draft.typeWeight($0, row: index) })
    }

    // The keyboard's Next walks the head then the ladder, reps before load, and leaves after the last.
    private func next(after field: TargetEntry.Field) -> TargetEntry.Field? {
        let last = draft.ladder.count - 1
        switch field {
        case .sets: return draft.isOpen ? nil : .reps
        case .reps: return .weight
        case .weight: return last < 0 ? nil : .rowReps(0)
        case .rowReps(let index): return .rowWeight(index)
        case .rowWeight(let index): return index < last ? .rowReps(index + 1) : nil
        case .addSet: return nil
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: GymLayout.blockGap) {
                    Text(place)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                    if untested { neverLogged }
                    // Said once while the line is open, above the fields beside the other statement
                    // about the whole line; everything under a field is that field's own note.
                    if draft.isOpen, draft.refusal == nil {
                        Text(TargetEntry.openLine)
                            .font(WindmillFont.body(13.5))
                            .foregroundStyle(skin.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, GymLayout.gutter)
                .padding(.top, GymLayout.contentTop)
                .frame(maxWidth: .infinity, alignment: .leading)

                List {
                    Section {
                        head
                    } header: {
                        Text(Chrome.everySet).foregroundStyle(skin.inkFaint)
                    }

                    if !draft.isOpen {
                        Section {
                            ForEach(Array(draft.ladder.enumerated()), id: \.element.id) { index, _ in
                                ladderRow(index)
                            }
                            addSet
                        } header: {
                            HStack {
                                Text(Chrome.setBySet).foregroundStyle(skin.inkFaint)
                                Spacer()
                                Menu {
                                    fillItems
                                } label: {
                                    Text(Chrome.fill)
                                        .font(WindmillFont.body(13, .semibold))
                                        .foregroundStyle(skin.accent)
                                        .textCase(nil)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, GymTap.row)
                // The commit stands under the list while nothing is being typed; over a keyboard it
                // would ride up onto the ladder's first rows, and the keyboard's bar has the way on.
                .safeAreaInset(edge: .bottom) {
                    if typing == nil {
                        commit
                            .padding(.horizontal, GymLayout.gutter)
                            .padding(.vertical, GymLayout.blockGap)
                            .background(skin.canvas)
                    }
                }
            }
            .background(skin.canvas)
            .navigationTitle(movement)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", action: onCancel)
                }
                // The decimal pad has no return key, so Next rides the keyboard's own bar — and Done
                // where there is no next field, so the keyboard can be put down to reach the commit.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if let typing, let following = next(after: typing) {
                        Button(Chrome.next) { self.typing = following }
                    } else {
                        Button(Chrome.done) { typing = nil }
                    }
                }
            }
        }
    }

    private var neverLogged: some View {
        HStack(spacing: WindmillSpace.x2) {
            Image(systemName: "questionmark.circle")
                .font(.system(size: 13))
                .foregroundStyle(skin.inkFaint)
            Text("Never logged — these are your numbers.")
                .font(WindmillFont.body(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            .foregroundStyle(skin.lineStrong))
    }

    // Sets · Reps · Weight, each speaking about every set. Reps and Weight sleep while the line is open.
    private var head: some View {
        HStack(alignment: .top, spacing: WindmillSpace.x3) {
            headField(Chrome.sets, label: Chrome.sets, text: setsText,
                      placeholder: TargetEntry.setsPlaceholder, focus: .sets, signed: false)
            headField(Chrome.reps, label: Chrome.reps, text: repsText,
                      placeholder: draft.repsPlaceholder, focus: .reps, signed: false)
                .disabled(draft.isOpen)
            headField(Chrome.weight, label: Chrome.weightLabel, text: weightText,
                      placeholder: draft.weightPlaceholder, focus: .weight, signed: signed)
                .disabled(draft.isOpen)
        }
        .padding(.vertical, WindmillSpace.x2)
        .listRowBackground(skin.surface)
    }

    private func headField(_ caption: String, label: String, text: Binding<String>, placeholder: String,
                           focus: TargetEntry.Field, signed: Bool) -> some View {
        let refusal = refusal(under: focus)
        let asleep = draft.isOpen && focus != .sets
        return VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(caption)
                .font(GymType.numeral(10.5))
                .textCase(.uppercase)
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            HStack(spacing: 0) {
                numeralField(label: label, text: text, placeholder: placeholder, focus: focus,
                             ink: refusal == nil ? (asleep ? skin.inkDim : skin.weightInk) : skin.alarmInk)
                if signed { sign(text) }
            }
            if let refusal { said(refusal) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // The ordinal, then reps and load for this set alone.
    private func ladderRow(_ index: Int) -> some View {
        let ordinal = index + 1
        let reps = refusal(under: .rowReps(index))
        let weight = refusal(under: .rowWeight(index))
        return VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            HStack(spacing: WindmillSpace.x3) {
                Text(String(ordinal))
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
                    .frame(width: WindmillSpace.x6, alignment: .leading)
                    .accessibilityIdentifier(Chrome.row(ordinal))
                numeralField(label: Chrome.rowReps(ordinal), text: rowReps(index),
                             placeholder: TargetEntry.repsPlaceholder, focus: .rowReps(index),
                             ink: reps == nil ? skin.weightInk : skin.alarmInk)
                HStack(spacing: 0) {
                    numeralField(label: Chrome.rowWeight(ordinal), text: rowWeight(index),
                                 placeholder: TargetEntry.weightPlaceholder, focus: .rowWeight(index),
                                 ink: weight == nil ? skin.weightInk : skin.alarmInk)
                    if signed { sign(rowWeight(index)) }
                }
            }
            if let fault = reps ?? weight { said(fault) }
        }
        .listRowBackground(skin.surface)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { draft.delete(row: index) } label: {
                Label(Chrome.delete, systemImage: "trash")
            }
        }
        .contextMenu { fillItems }
    }

    private var addSet: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Button { draft.addSet() } label: {
                Label(Chrome.addSet, systemImage: "plus.circle")
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let refusal = refusal(under: .addSet) { said(refusal) }
        }
        .listRowBackground(skin.surface)
    }

    private var fillItems: some View {
        Group {
            Button { draft.rampUp() } label: { Label(Chrome.rampUp, systemImage: "arrow.up.right") }
                .disabled(!draft.canRamp)
            Button { draft.matchSetOne() } label: { Label(Chrome.matchSetOne, systemImage: "equal") }
        }
    }

    private func numeralField(label: String, text: Binding<String>, placeholder: String,
                              focus: TargetEntry.Field, ink: Color) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(skin.inkFaint))
            .font(GymType.numeral(24, .bold))
            .foregroundStyle(ink)
            .keyboardType(.decimalPad)
            .submitLabel(.next)
            .focused($typing, equals: focus)
            .onSubmit { typing = next(after: focus) }
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .accessibilityLabel(label)
    }

    private func said(_ refusal: String) -> some View {
        Text(refusal)
            .font(GymType.numeral(12))
            .foregroundStyle(skin.alarmInk)
            .fixedSize(horizontal: false, vertical: true)
    }

    // `±` and never a bare `−`, which reads as *decrement* elsewhere in this product; the same bytes
    // the rack keypad's ± carries — one control met on two screens.
    private func sign(_ text: Binding<String>) -> some View {
        Button { text.wrappedValue = TargetEntry.flipped(text.wrappedValue) } label: {
            Text("±")
                .font(GymType.numeral(20, .semibold))
                .foregroundStyle(skin.accent)
                .frame(width: GymTap.minimum, height: GymTap.minimum)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(KeypadEntry.flipTheSign)
    }

    // One button commits either shape: an empty scheme is the open line.
    private var commit: some View {
        let refused = draft.refusal != nil
        return Button {
            guard let scheme = draft.scheme else { return }
            onSet(scheme)
        } label: {
            Text(draft.commitLabel)
                .font(WindmillFont.body(16, .bold))
                .foregroundStyle(refused ? skin.inkFaint : skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(refused ? skin.raised : skin.accent))
        }
        .disabled(refused)
    }
}
