import SwiftUI
import WindmillPlatform

// §M's two building screens — name it (28), then movements and their targets (29). What each one
// DECIDES lives in RoutineBuilder.swift; these draw it.
//
// THE SHEET SITS OVER THE LIST AND NOT INSTEAD OF IT (screen 29). That is the whole reason targets
// are set here rather than on a page of their own: the shape of the day stays visible while numbers
// are typed into it, so a lifter copying a program in can see what they have already put down.

// SCREEN 28 — the name, asked once, with the keyboard already up. Nothing else is on this screen:
// the question is short, the answer is short, and the movements come next.
struct NameRoutineScreen: View {
    let opening: String
    let onNext: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var name: String
    // The keyboard is UP ON ARRIVAL. A screen whose only job is one word may not ask for a tap
    // before it can be answered — and `@FocusState` set in `.task` is the only way to raise it,
    // because a field cannot be focused before it is on screen.
    @FocusState private var typing: Bool

    init(opening: String = "", onNext: @escaping (String) -> Void) {
        self.opening = opening
        self.onNext = onNext
        _name = State(initialValue: opening)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                Text("What do you call this one?")
                    .font(WindmillFont.display(28))
                    .foregroundStyle(skin.ink)
                Text("Whatever you already call it.")
                    .font(WindmillFont.body(15))
                    .foregroundStyle(skin.inkDim)
            }
            Spacer(minLength: 0)

            field
            suggestions
            next
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.top, WindmillSpace.x8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .task { typing = true }
    }

    private var field: some View {
        HStack(spacing: WindmillSpace.x3) {
            TextField("", text: $name,
                      prompt: Text("Heavy Thursday").foregroundStyle(skin.inkFaint))
                .font(WindmillFont.body(19, .bold))
                .foregroundStyle(skin.ink)
                .textFieldStyle(.plain)
                .focused($typing)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .onSubmit { commit() }
                // Capped where the name is TYPED and not only counted, so the tap can never send a
                // name the log refuses — sixty characters, and the eighty bytes the column holds,
                // which in a two-byte script runs out first. Any language, any spelling, any
                // punctuation: a length is the only bound in this product, because we do not correct
                // anyone's spelling of their own gym.
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

    // SUGGESTIONS, NEVER RULES. A tap fills the field and leaves the keyboard up, because typing
    // over one is the expected case rather than a correction — nothing here validates a name
    // against this list, and nothing counts how often it is ignored.
    private var suggestions: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(RoutineDraft.suggestions, id: \.self) { offered in
                Button { name = offered } label: {
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
        .padding(.top, WindmillSpace.x2)
    }

    private var next: some View {
        Button(action: commit) {
            Text("Next · add movements")
                .font(WindmillFont.body(16.5, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .padding(.top, WindmillSpace.x3)
        .padding(.bottom, WindmillSpace.x4)
    }

    private func commit() {
        let said = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        onNext(said)
    }
}

// SCREEN 29 — the day as a list, and the target sheet over it. The list is the routine: order is
// the routine's order, a row opens its targets, and a swipe drops it.
//
// SAVE IS OFFERED THE MOMENT THERE IS A MOVEMENT, and never later. Rows with no targets are `open`
// and ask at the rack — a program copied in over two sittings is a routine, not a half-finished
// form — so nothing on this screen withholds the way out until the numbers are all in.
struct RoutineEditorScreen: View {
    let catalog: [Exercise]
    let untested: Bool
    let saving: Bool
    let failure: String?
    let onSave: (RoutineDraft) -> Void
    let onCreateMovement: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>

    @Environment(\.gymSkin) private var skin
    // SEEDED ONCE AND OWNED HERE. The room hands a draft in and gets one back at the tap; everything
    // between is this screen's, so a movement added and a target typed do not need a round trip
    // through the room to appear.
    @State private var draft: RoutineDraft
    @State private var sheet: Sheet?
    @State private var minting = false
    @State private var mintFailure: String?

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

    init(draft: RoutineDraft, catalog: [Exercise],
         untested: Bool, saving: Bool, failure: String?,
         onSave: @escaping (RoutineDraft) -> Void,
         onCreateMovement: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>) {
        self.catalog = catalog
        self.untested = untested
        self.saving = saving
        self.failure = failure
        self.onSave = onSave
        self.onCreateMovement = onCreateMovement
        _draft = State(initialValue: draft)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(draft.trimmedName)
                .font(WindmillFont.display(22))
                .foregroundStyle(skin.ink)
                .padding(.horizontal, WindmillSpace.x5)
                .padding(.top, WindmillSpace.x8)

            if draft.lines.isEmpty {
                nothingYet
                // The list is what fills this screen, so with no rows the space has to come from
                // somewhere — the two buttons belong at the foot, in the thumb zone, and not
                // stacked under a sentence at the top of an empty page.
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

            save
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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

    private var save: some View {
        Button { onSave(draft) } label: {
            Text(saving ? "Saving…" : "Save routine")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(draft.isSavable ? skin.onAccent : skin.inkFaint)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(draft.isSavable ? skin.accent : skin.raised))
        }
        .disabled(saving || !draft.isSavable)
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
