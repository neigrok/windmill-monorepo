import SwiftUI
import WindmillPlatform

// §M's building surface — ONE editor since the 13 Aug update (R2/R3): the same screen creates a
// routine and edits one, differing only in what is already in the list. What it DECIDES lives in
// RoutineBuilder.swift; this draws it.
//
// THE NAME IS INLINE AT THE TOP, never a step before — add movements first and name it last, or
// the reverse — with the suggestion chips beside the field while it is empty. The two-step wizard
// (a name screen, then a build screen) retired with the Today tab; renaming a routine is editing
// this same field, so the standalone rename sheet went with it.
//
// SAVE IS IN THE HEADER AND ONLY THERE — §M's own sentence ("Save in the header") wins over the
// drawn footer. It enables when the draft is savable: named and holding a movement on a build, and
// additionally CHANGED on an edit — a Save that re-sent an unchanged document would move the
// revision and set pending proposals aside for nothing. Rows with no targets are `open` and ask at
// the rack — a program copied in over two sittings is a routine, not a half-finished form.
//
// THE SHEET SITS OVER THE LIST AND NOT INSTEAD OF IT (screen 29). That is the whole reason targets
// are set here rather than on a page of their own: the shape of the day stays visible while numbers
// are typed into it, so a lifter copying a program in can see what they have already put down.
struct RoutineEditorScreen: View {
    let catalog: [Exercise]
    // Whether this is a routine the room already holds — the title's word, Save's changed-rule, and
    // the two foot rows only edit mode carries. Create-vs-replace on the wire stays the draft id's
    // own question, decided by the room at the save.
    let editing: Bool
    let untested: Bool
    let saving: Bool
    let failure: String?
    let onSave: (RoutineDraft) -> Void
    // Edit mode's foot rows (R3). Duplicate hands back the day AS EDITED — a copy of what is on
    // screen, not of what was last saved — and the room opens a fresh create-mode editor on it.
    let onDuplicate: ((RoutineDraft) -> Void)?
    let onDelete: (() -> Void)?
    let onCreateMovement: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>

    @Environment(\.gymSkin) private var skin
    // SEEDED ONCE AND OWNED HERE. The room hands a draft in and gets one back at the tap; everything
    // between is this screen's, so a movement added and a target typed do not need a round trip
    // through the room to appear.
    @State private var draft: RoutineDraft
    // The draft as it arrived, kept for edit mode's changed-rule — one comparison over the WRITE,
    // because the write is what a Save would send and line ids are this screen's own scaffolding.
    private let opening: RoutineDraft
    @State private var sheet: Sheet?
    @State private var minting = false
    @State private var mintFailure: String?
    @FocusState private var namingIt: Bool

    // The two sheets this screen opens, and the row a target is being typed for. One value rather
    // than a Bool beside an index, because "which row" and "is a sheet up" are the same fact and two
    // spellings of it eventually disagree.
    private enum Sheet: Identifiable {
        case picking
        case creating(String)
        // The LINE and never its place in the list: a drag moves places, and a sheet keyed on one
        // would be typing numbers into whichever row slid into that slot.
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

    // Savable on a build; savable AND changed on an edit (R3).
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
                // The list is what fills this screen, so with no rows the space has to come from
                // somewhere — the buttons belong at the foot, in the thumb zone, and not stacked
                // under a sentence at the top of an empty page.
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
        // A fresh build opens with the keyboard already up on the name (screen 28 draws the field
        // focused) — the one question only this lifter can answer. An edit, and a duplicate that
        // arrives named, open on the list instead: the name is already there to be typed over.
        .task {
            guard !editing, draft.trimmedName.isEmpty else { return }
            namingIt = true
        }
        .sheet(item: $sheet) { open in
            switch open {
            case .picking:
                // The same picker the logger opens, so one product has one way to name a movement.
                // `lastSets` is nil on purpose and is not an omission: that read is a picker-open
                // call about what the lifter has TRAINED, and a routine being written at a kitchen
                // table is not asking what they lifted last Tuesday.
                MovementPicker(catalog: catalog, taken: draft.entries.map(\.exerciseId),
                               lastSets: nil,
                               onPick: { pick($0) },
                               // A movement the catalog has never heard of goes through §N screen
                               // 31 — two questions — and lands straight in the day being built.
                               onCreate: { sheet = .creating($0) },
                               onClose: { sheet = nil })
                    .presentationBackground(skin.canvas)
            case .creating(let name):
                CreateMovementSheet(opening: name, creating: minting, failure: mintFailure,
                                    onCreate: { said, equipment in mint(said, loadedAs: equipment) },
                                    onCancel: { sheet = nil })
                    .presentationBackground(skin.canvas)
            case .targeting(let lineId):
                // A line dropped while its sheet was up has nothing to type into, so the sheet
                // draws nothing rather than reaching into a list that no longer holds it.
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

    // A List for the two gestures the assembly sheet already teaches — drag to reorder, swipe to
    // drop — so one product has one way to rearrange a list of movements. Its own chrome is off:
    // the room draws its rows, and a system separator in here would be the one hairline in gym that
    // came from somewhere else.
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
            // The open row is drawn in the room's faintest ink and a named target in the accent,
            // because one of them is a number the lifter chose and the other is the absence of one.
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

    // SAVE IS THE HEADER'S AND ONLY THE HEADER'S (R3). It says what it is doing while the write is
    // out, and it is dim rather than absent while the draft is not savable — a control that
    // vanished would leave the way out of this screen moving around.
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

    // The name, IN the editor (§M): capped where it is typed — sixty characters, and the eighty
    // bytes the column holds, which in a two-byte script runs out first. Any language, any
    // spelling, any punctuation: a length is the only bound in this product, because we do not
    // correct anyone's spelling of their own gym.
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

    // SUGGESTIONS, NEVER RULES — screen 28's chips, drawn only while the field is empty. A tap
    // fills the field and typing over it is the expected case; nothing here validates a name
    // against this list, and nothing counts how often it is ignored.
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

    // Edit mode's two remaining verbs (R3), moved here from the routine's own page: quiet text
    // rows at the foot, the destructive one in the room's alarm ink and nothing else in it.
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

    // Adding a movement is asking what it is for, so the target sheet opens on it — the row's own
    // tap, given without the tap. It can still be left open from there, which is the whole of §M's
    // savable-while-incomplete rule under a thumb.
    private func pick(_ exerciseId: String) {
        sheet = .targeting(draft.add(exerciseId).id)
    }

    // A movement minted from screen 31 lands in the day being built, and the sheet stays up until
    // the log answers: a create that did not happen may not close as though it had, and a picker
    // that closed on a movement that was never minted is a lifter left holding nothing.
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

// THE TARGET SHEET (§M screen 29) — the numbers for one movement, over the day they belong to.
//
// IT REACHES FOR NO HISTORY, and that is the rule this sheet exists to keep. A routine built at home
// has never been run, so there is no last time for it to prefill from; the line above the steppers
// says so plainly, and inventing a number to sit under it would be the exact lie that line prevents.
// The dial opens on WHAT THE ROW ALREADY SAYS — including the two things it may say by saying
// nothing, `max` and `last time`, each of which keeps its own word here and its own way back.
//
// THE LADDER IS THE ONE THAT ALREADY EXISTS. The four buttons are `Ladder.labels` and the step is
// `Ladder.bump` — the same rule as the rack, pinned across three languages by a golden. A second
// stepper written here would step a Sunday target differently from the same weight on Thursday.
private struct TargetSheet: View {
    let entry: RoutineWrite.Entry
    let movement: String
    let place: String
    let untested: Bool
    // Reps and weight are handed back OPTIONAL, because either may be the absence the row arrived
    // with or was just given: `3 × max` and "whatever you did last time" are targets a lifter and an
    // agent both write, and a commit that could only spell numbers would overwrite them with two.
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

            // Drawn only over a routine that has never been trained, because that is the only
            // routine it is true of. Editing a day you have already run says nothing here: the
            // targets on screen came from that history and need no disclaimer.
            if untested { neverLogged }

            HStack(spacing: WindmillSpace.x3) {
                stepper("Sets", value: String(target.sets)) { target.bumpSets($0) }
                // `max` is a rep target and not a missing one, so the stepper reads it as a word
                // rather than as a blank where a number should be.
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

            // The other answer, and it is an answer rather than a cancel: leaving the row open is a
            // decision about the training — you will pick the weight when you are standing there.
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

    // A ROW MAY NAME NO WEIGHT, and that is a target rather than a blank: "whatever you did last
    // time", answered at the rack off this lifter's own log. It is drawn in the room's faintest ink
    // in the numeral's own place — the absence where the number would be.
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
                // THE NUMERAL'S OWN FONT, so the absence stands exactly where the number would and
                // the ladder under it does not jump the moment a load is named. Faint, because it is
                // the one thing on this sheet that is not a number the lifter chose.
                Text("last time")
                    .font(WindmillFont.display(56, .heavy))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
        }
    }

    // THE TWO WAYS TO SAY LESS, in one row that is always here whether or not it has a word in it.
    // Each takes one field back to the absence it arrived with — no rep target is `max`, no weight is
    // "last time" — and each is offered only while there is a number to remove.
    //
    // THE ROW KEEPS ITS HEIGHT EMPTY, which is the point of it being a row at all: a word appearing
    // under a thumb would push the ladder half an inch down on the tap that named the first weight,
    // and the four keys above are tapped three and four times in a row. Nothing on this sheet moves
    // while a target is being dialled.
    private var waysBack: some View {
        HStack(spacing: WindmillSpace.x4) {
            if target.reps != nil { clear("take it to max") { target.reps = nil } }
            if target.weightKg != nil { clear("use last time") { target.weightKg = nil } }
            Spacer(minLength: 0)
        }
        .frame(height: GymTap.minimum)
    }

    // A word rather than a key, because it removes a target instead of moving one and it is the
    // rarer answer of the two. Full tap height like every other control in this room.
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

    // The fine step is the program step and the plate step is a plate change, and they are SIZED
    // apart rather than captioned — §K's own rule, so the labels are the caption.
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
