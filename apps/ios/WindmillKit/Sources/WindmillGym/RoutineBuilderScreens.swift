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
    // Hands back the day as edited, not as last saved.
    let onDuplicate: ((RoutineDraft) -> Void)?
    let onDelete: (() -> Void)?
    let onCreateMovement: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>

    @Environment(\.gymSkin) private var skin
    @State private var draft: RoutineDraft
    // Kept for edit mode's changed-rule: the comparison is over the write, since line ids are this screen's own.
    private let opening: RoutineDraft
    @State private var sheet: Sheet?
    @State private var minting = false
    @State private var mintFailure: String?
    @State private var abandoning = false
    @FocusState private var namingIt: Bool

    // The Cancel confirmation, asked only when there is something to lose.
    enum Abandon {
        static let title = "Discard these edits?"
        static let body = "Nothing is saved. The routine stays as it was."
        static let confirm = "Discard"
        static let keep = "Keep editing"
    }

    private enum Sheet: Identifiable {
        case picking
        case creating(String)
        // The line and never its place: a drag moves places.
        case targeting(String)

        var id: String {
            switch self {
            case .picking: return "picking"
            case .creating(let name): return "creating:\(name)"
            case .targeting(let lineId): return "targeting:\(lineId)"
            }
        }

        // A target sheet standing over the list OWNS the open line's sentence, and the list's copy
        // beneath the movements steps aside while it does (C19): one state, one sentence, never a
        // blessing behind the scrim beside a refusal in front of it. The other two sheets say
        // nothing about an open line, so neither takes it.
        var ownsTheOpenLine: Bool {
            guard case .targeting = self else { return false }
            return true
        }
    }

    init(draft: RoutineDraft, catalog: [Exercise], sessions: [SessionSummary], editing: Bool,
         untested: Bool, saving: Bool, failure: String?,
         onSave: @escaping (RoutineDraft) -> Void,
         onCancel: @escaping () -> Void,
         onDuplicate: ((RoutineDraft) -> Void)? = nil,
         onDelete: (() -> Void)? = nil,
         onCreateMovement: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>) {
        self.catalog = catalog
        self.sessions = sessions
        self.editing = editing
        self.untested = untested
        self.saving = saving
        self.failure = failure
        self.onSave = onSave
        self.onCancel = onCancel
        self.onDuplicate = onDuplicate
        self.onDelete = onDelete
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
                if let why = draft.saveRefusal {
                    Text(why)
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.alarmInk)
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
                // Once beneath the list and never per row: the word `open` in a row's target column
                // says WHICH rows, and this says what that word means (C1).
                if draft.lines.isEmpty {
                    Text("Add the movements, in the order you do them.")
                        .foregroundStyle(skin.inkDim)
                } else if sheet?.ownsTheOpenLine != true,
                          let said = TargetEntry.openLineUnder(draft.entries) {
                    Text(said)
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

            if editing, let onDelete {
                Section {
                    Button(role: .destructive, action: onDelete) {
                        Label("Delete routine", systemImage: "trash")
                            .font(WindmillFont.body(15, .semibold))
                            .foregroundStyle(skin.alarmInk)
                            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(saving)
                    .listRowBackground(skin.surface)
                }
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
            // A routine that does not exist yet has nothing to duplicate.
            if editing, let onDuplicate {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                            Button { onDuplicate(draft) } label: {
                            Label("Duplicate", systemImage: "doc.on.doc")
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                    .disabled(saving)
                }
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
                               onCreate: { sheet = .creating($0) },
                               onClose: { sheet = nil })
                    .presentationBackground(skin.canvas)
            case .creating(let name):
                CreateMovementSheet(opening: name, creating: minting, failure: mintFailure,
                                    onCreate: { said, equipment in mint(said, loadedAs: equipment) },
                                    onCancel: { sheet = nil })
                    .presentationBackground(skin.canvas)
            case .targeting(let lineId):
                if let line = draft.line(lineId) {
                    TargetSheet(entry: line.entry,
                                movement: Readout.movement(line.entry.exerciseId, in: catalog),
                                place: draft.place(of: lineId),
                                untested: untested,
                                onSet: { sets, reps, weightKg in
                                    draft.set(lineId, sets: sets, reps: reps, weightKg: weightKg)
                                    sheet = nil
                                },
                                onOpen: {
                                    draft.leaveOpen(lineId)
                                    sheet = nil
                                },
                                onCancel: { sheet = nil })
                        .presentationBackground(skin.surface)
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
            Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                weightKg: entry.targetWeightKg))
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

    // The sheet stays up until the log answers.
    private func mint(_ name: String, loadedAs equipment: String) {
        minting = true
        mintFailure = nil
        Task {
            switch await onCreateMovement(name, equipment) {
            case .success(let made):
                minting = false
                pick(made.id)
            case .failure(let why):
                minting = false
                mintFailure = why.line("“\(name)” wasn’t created")
            }
        }
    }
}

// Three typed fields and nothing else: emptying one is how you clear it, and the placeholder says what
// empty means — `open`, `max`, `last time`. The ± ladder is a rack control and is drawn at the rack,
// never here (`16-the-workout.md`). The bands are the routine target's, `TargetEntry`.
private struct TargetSheet: View {
    let entry: RoutineWrite.Entry
    let movement: String
    let place: String
    let untested: Bool
    // Reps and weight are optional: either may be the absence the row arrived with, and both absences are targets.
    let onSet: (Int, Int?, Double?) -> Void
    let onOpen: () -> Void
    let onCancel: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var sets: String
    @State private var reps: String
    @State private var weight: String
    // The one input a refusal cannot be re-derived from the fields for, because the keystroke it is
    // about never landed. Cleared by the next keystroke anywhere.
    @State private var clearRefused = false
    // The restore below writes the field back, which fires `onChange` a second time; that pass is not
    // a keystroke and must not wipe the refusal it just raised.
    @State private var restoring = false
    @FocusState private var typing: TargetEntry.Field?

    init(entry: RoutineWrite.Entry, movement: String, place: String, untested: Bool,
         onSet: @escaping (Int, Int?, Double?) -> Void,
         onOpen: @escaping () -> Void,
         onCancel: @escaping () -> Void) {
        self.entry = entry
        self.movement = movement
        self.place = place
        self.untested = untested
        self.onSet = onSet
        self.onOpen = onOpen
        self.onCancel = onCancel
        _sets = State(initialValue: entry.targetSets.map(String.init) ?? "")
        _reps = State(initialValue: entry.targetReps.map(String.init) ?? "")
        _weight = State(initialValue: entry.targetWeightKg.map(Readout.weight) ?? "")
    }

    private var setsReading: TargetEntry.Reading<Int> { TargetEntry.readSets(sets) }
    private var repsReading: TargetEntry.Reading<Int> { TargetEntry.readReps(reps) }
    private var weightReading: TargetEntry.Reading<Double> { TargetEntry.readWeight(weight) }

    // ONE refusal for the sheet, computed for the sheet and handed only to the field it belongs to
    // (C5) — never one per field, which is three ways of saying the lifter got it wrong at once.
    private var refusal: TargetEntry.Refusal? {
        TargetEntry.refusal(sets: sets, reps: reps, weight: weight, clearRefused: clearRefused)
    }

    private func refusal(under field: TargetEntry.Field) -> String? {
        guard let refusal, refusal.field == field else { return nil }
        return refusal.said
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                    Text(place)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)

                    if untested { neverLogged }

                    // The sheet's half of C1, said once while the line on this sheet is open — and
                    // said ABOVE the fields, beside the other statement about the whole line (C15).
                    // Everything drawn UNDER a field is that field's own note.
                    if TargetEntry.blank(sets), refusal == nil {
                        Text(TargetEntry.openLine)
                            .font(WindmillFont.body(13.5))
                            .foregroundStyle(skin.inkDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(alignment: .top, spacing: WindmillSpace.x3) {
                        field("Sets", text: $sets, placeholder: TargetEntry.setsPlaceholder,
                              refusal: refusal(under: .sets), focus: .sets)
                        field("Reps", text: $reps, placeholder: TargetEntry.repsPlaceholder,
                              refusal: refusal(under: .reps), focus: .reps)
                    }

                    field("Weight · kg", text: $weight, placeholder: TargetEntry.weightPlaceholder,
                          refusal: refusal(under: .weight), focus: .weight, signed: true)

                    Text(TargetEntry.decimalHint)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)

                    commit
                }
                .padding(WindmillSpace.x5)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(skin.surface)
            .navigationTitle(movement)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", action: onCancel)
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

    // One refusal at a time, inline, under the field it belongs to. `signed` puts the sign control
    // inside the field, and only the load has one.
    private func field(_ caption: String, text: Binding<String>, placeholder: String,
                       refusal: String?, focus: TargetEntry.Field,
                       signed: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(caption.uppercased())
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            HStack(spacing: 0) {
                TextField("", text: text,
                          prompt: Text(placeholder).foregroundStyle(skin.inkFaint))
                    .font(GymType.numeral(24, .bold))
                    .foregroundStyle(refusal == nil ? skin.weightInk : skin.alarmInk)
                    .keyboardType(.decimalPad)
                    .focused($typing, equals: focus)
                    .padding(.leading, WindmillSpace.x3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel(caption)
                    .onChange(of: text.wrappedValue) { was, typed in
                        if restoring {
                            restoring = false
                            return
                        }
                        guard focus == .sets else {
                            clearRefused = false
                            return
                        }
                        // Clearing sets is what opens a line, and an open line names neither of the
                        // other two. The clear is refused and the field keeps what it held (`2l`).
                        guard TargetEntry.blank(typed), !was.isEmpty,
                              TargetEntry.clearingSets(reps: reps, weight: weight) != nil else {
                            clearRefused = false
                            return
                        }
                        restoring = true
                        clearRefused = true
                        text.wrappedValue = was
                        selectTheKeptValue()
                    }
                if signed { sign(text) }
            }
            .frame(minHeight: GymTap.primary - 8)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(refusal == nil ? skin.lineStrong : skin.alarmInk, lineWidth: 1))
            if let refusal {
                Text(refusal)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.alarmInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // A refused clear keeps the value AND selects it, so the next digit REPLACES the number the lifter
    // has already tried to be rid of instead of appending to it (C6). SwiftUI's `TextField` exposes no
    // selection at this deployment target; `selectAll` is the responder-chain verb the field under it
    // already implements, and the field that was just typed into is the first responder. Deferred one
    // turn because the restore above is still being applied when this runs.
    private func selectTheKeptValue() {
        DispatchQueue.main.async {
            UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)),
                                            to: nil, from: nil, for: nil)
        }
    }

    // The decimal keyboard has no sign key, so without this the planning sheet cannot name a load the
    // rack can log and the domain stores: band-assisted work is negative kilograms. `±` and never a
    // bare `−`, which reads as *decrement* everywhere else in this product (`15-the-routine.md`).
    // One accessible name on all three surfaces, pinned beside the glyph (C17), and the same bytes the
    // rack keypad's ± carries — the two are one control met on two screens.
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
        .accessibilityHint("Band-assisted work is a negative load")
    }

    // Naming no sets is what an open line is, so the one button commits either shape.
    private var commit: some View {
        let refused = refusal != nil
        return Button {
            guard !refused else { return }
            guard let named = setsReading.value else { return onOpen() }
            onSet(named, repsReading.value, weightReading.value)
        } label: {
            Text("Set · \(Readout.target(sets: setsReading.value, reps: repsReading.value, weightKg: weightReading.value))")
                .font(WindmillFont.body(16, .bold))
                .foregroundStyle(refused ? skin.inkFaint : skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(refused ? skin.raised : skin.accent))
        }
        .disabled(refused)
    }
}
