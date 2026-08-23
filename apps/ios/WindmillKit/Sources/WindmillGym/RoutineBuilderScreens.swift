import SwiftUI
import WindmillPlatform

// Save enables when the draft is savable: named and holding a movement on a build, and changed as well on an edit — re-sending
// an unchanged document would move the revision and set pending proposals aside for nothing.
struct RoutineEditorScreen: View {
    let catalog: [Exercise]
    let editing: Bool
    let untested: Bool
    let saving: Bool
    let failure: String?
    let onSave: (RoutineDraft) -> Void
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
    @FocusState private var namingIt: Bool

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
    }

    init(draft: RoutineDraft, catalog: [Exercise], editing: Bool,
         untested: Bool, saving: Bool, failure: String?,
         onSave: @escaping (RoutineDraft) -> Void,
         onDuplicate: ((RoutineDraft) -> Void)? = nil,
         onDelete: (() -> Void)? = nil,
         onCreateMovement: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>) {
        self.catalog = catalog
        self.editing = editing
        self.untested = untested
        self.saving = saving
        self.failure = failure
        self.onSave = onSave
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

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            head
            nameField
            if draft.trimmedName.isEmpty { suggestions }

            if draft.lines.isEmpty {
                nothingYet
                Spacer(minLength: 0)
            } else {
                rows
            }

            add

            if let failure {
                Text(failure)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.alarmInk)
                    .lineSpacing(3)
                    .padding(.horizontal, WindmillSpace.x5)
            }

            if editing { editRows }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task {
            guard !editing, draft.trimmedName.isEmpty else { return }
            namingIt = true
        }
        .sheet(item: $sheet) { open in
            switch open {
            case .picking:
                // `lastSets` is nil here: this screen asks the log for no history.
                MovementPicker(catalog: catalog, taken: draft.entries.map(\.exerciseId),
                               lastSets: nil,
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
                                })
                        .presentationBackground(skin.surface)
                        .presentationDetents([.large])
                }
            }
        }
    }

    private var nothingYet: some View {
        Text("Add the movements, in the order you do them.")
            .font(WindmillFont.body(15))
            .foregroundStyle(skin.inkDim)
            .padding(.horizontal, WindmillSpace.x5)
    }

    private var rows: some View {
        List {
            ForEach(draft.lines) { line in
                Button { sheet = .targeting(line.id) } label: { row(line.entry) }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 3.5, leading: WindmillSpace.x5,
                                              bottom: 3.5, trailing: WindmillSpace.x5))
                    .swipeActions(edge: .trailing) {
                        Button("Remove", role: .destructive) { draft.remove(line.id) }
                    }
            }
            .onMove { draft.move(from: $0, to: $1) }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, GymTap.minimum)
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
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
            .strokeBorder(entry.isOpen ? skin.lineStrong : skin.line, lineWidth: 1))
    }

    private var add: some View {
        Button { sheet = .picking } label: {
            Text("+ Add movement")
                .font(WindmillFont.body(16, .semibold))
                .foregroundStyle(skin.accent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary - 8)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(skin.lineStrong, lineWidth: 1))
        }
        .padding(.horizontal, WindmillSpace.x5)
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
            Text(editing ? "Edit routine" : "New routine")
                .font(WindmillFont.display(24))
                .foregroundStyle(skin.ink)
            Spacer(minLength: 0)
            Button { onSave(draft) } label: {
                Text(saving ? "Saving…" : "Save")
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(savable ? skin.accent : skin.inkFaint)
                    .padding(.horizontal, WindmillSpace.x2)
                    .frame(minHeight: GymTap.minimum)
            }
            .disabled(saving || !savable)
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.top, WindmillSpace.x8)
    }

    // Capped where it is typed: sixty characters, or the eighty bytes the column holds.
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
            Text(RoutineDraft.counter(draft.name))
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(.horizontal, WindmillSpace.x4)
        .frame(height: GymTap.primary - 10)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.canvas))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(namingIt ? skin.accent : skin.lineStrong, lineWidth: namingIt ? 1.5 : 1))
        .padding(.horizontal, WindmillSpace.x5)
    }

    // Drawn only while the field is empty; nothing validates a name against this list.
    private var suggestions: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(RoutineDraft.suggestions, id: \.self) { offered in
                Button { draft.name = offered } label: {
                    Text(offered)
                        .font(WindmillFont.body(12.5, .bold))
                        .foregroundStyle(skin.inkDim)
                        .padding(.horizontal, WindmillSpace.x3)
                        .frame(minHeight: 34)
                        .background(Capsule().strokeBorder(skin.lineStrong, lineWidth: 1))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, WindmillSpace.x5)
    }

    private var editRows: some View {
        HStack(spacing: WindmillSpace.x6) {
            Button("Duplicate") { onDuplicate?(draft) }
                .font(WindmillFont.body(14, .semibold))
                .foregroundStyle(skin.inkDim)
                .frame(minHeight: GymTap.minimum)
            Button("Delete routine") { onDelete?() }
                .font(WindmillFont.body(14, .semibold))
                .foregroundStyle(skin.alarmInk)
                .frame(minHeight: GymTap.minimum)
            Spacer(minLength: 0)
        }
        .disabled(saving)
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x2)
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

// Reaches for no history: the dial opens on what the row already says, including `max` and `last time`.
private struct TargetSheet: View {
    let entry: RoutineWrite.Entry
    let movement: String
    let place: String
    let untested: Bool
    // Reps and weight are optional: either may be the absence the row arrived with, and both absences are targets.
    let onSet: (Int, Int?, Double?) -> Void
    let onOpen: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var target: RoutineTarget

    init(entry: RoutineWrite.Entry, movement: String, place: String, untested: Bool,
         onSet: @escaping (Int, Int?, Double?) -> Void,
         onOpen: @escaping () -> Void) {
        self.entry = entry
        self.movement = movement
        self.place = place
        self.untested = untested
        self.onSet = onSet
        self.onOpen = onOpen
        _target = State(initialValue: RoutineTarget(entry))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            HStack(alignment: .firstTextBaseline) {
                Text(movement)
                    .font(WindmillFont.display(22))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: WindmillSpace.x3)
                Text(place)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
            }

            if untested { neverLogged }

            HStack(spacing: WindmillSpace.x3) {
                stepper("Sets", value: String(target.sets)) { target.bumpSets($0) }
                stepper("Reps", value: Readout.repTarget(target.reps)) { target.bumpReps($0) }
            }

            weight
            ladder
            waysBack

            Button { onSet(target.sets, target.reps, target.weightKg) } label: {
                Text(target.commitLine)
                    .font(WindmillFont.body(16, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }

            Button(action: onOpen) {
                HStack {
                    Text("Leave it open")
                        .font(WindmillFont.body(13.5, .bold))
                        .foregroundStyle(skin.inkDim)
                    Spacer(minLength: WindmillSpace.x3)
                    Text("decide at the rack")
                        .font(WindmillFont.body(12))
                        .foregroundStyle(skin.inkFaint)
                }
                .frame(minHeight: GymTap.minimum)
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.surface)
    }

    private var neverLogged: some View {
        HStack(spacing: WindmillSpace.x2) {
            Circle()
                .fill(skin.inkFaint)
                .frame(width: 6, height: 6)
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

    private func stepper(_ caption: String, value: String,
                         bump: @escaping (Int) -> Void) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(caption.uppercased())
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            HStack(spacing: WindmillSpace.x2) {
                key("−") { bump(-1) }
                Text(value)
                    .font(GymType.numeral(24, .bold))
                    .foregroundStyle(skin.ink)
                    .frame(maxWidth: .infinity)
                key("+") { bump(1) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func key(_ glyph: String, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(glyph)
                .font(WindmillFont.body(19))
                .foregroundStyle(skin.ink)
                .frame(width: GymTap.minimum, height: GymTap.minimum)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(skin.lineStrong, lineWidth: 1))
        }
    }

    // No weight is a target rather than a blank: whatever you did last time.
    private var weight: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("TARGET WEIGHT")
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            if let kg = target.weightKg {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x2) {
                    Text(Readout.weight(kg))
                        .font(WindmillFont.display(56, .heavy).monospacedDigit())
                        .foregroundStyle(skin.weightInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    Text("kg")
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.inkFaint)
                    Spacer(minLength: WindmillSpace.x2)
                }
            } else {
                Text("last time")
                    .font(WindmillFont.display(56, .heavy))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
        }
    }

    // Each takes one field back to its absence — no rep target is `max`, no weight is last time's — and the row keeps its
    // height when empty so the ladder under it does not move.
    private var waysBack: some View {
        HStack(spacing: WindmillSpace.x4) {
            if target.reps != nil { clear("take it to max") { target.reps = nil } }
            if target.weightKg != nil { clear("use last time") { target.weightKg = nil } }
            Spacer(minLength: 0)
        }
        .frame(height: GymTap.minimum)
    }

    private func clear(_ word: String, tap: @escaping () -> Void) -> some View {
        Button(word, action: tap)
            .font(WindmillFont.body(12.5, .semibold))
            .foregroundStyle(skin.inkDim)
            .frame(minHeight: GymTap.minimum)
    }

    private var ladder: some View {
        let labels = Ladder.labels(for: target.ladderWeight)
        return HStack(spacing: WindmillSpace.x2) {
            step(labels[0], big: true) { target.bump(direction: -1, big: true) }
            step(labels[1], big: false) { target.bump(direction: -1, big: false) }
            step(labels[2], big: false) { target.bump(direction: 1, big: false) }
            step(labels[3], big: true) { target.bump(direction: 1, big: true) }
        }
    }

    private func step(_ label: String, big: Bool, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(label)
                .font(GymType.numeral(big ? 14.5 : 15.5, big ? .semibold : .bold))
                .foregroundStyle(big ? skin.inkDim : skin.ink)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(big ? skin.line : skin.lineStrong, lineWidth: 1))
        }
    }
}
