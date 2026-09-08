import SwiftUI
import WindmillPlatform

// Every weight and rep tap goes through `Ladder`; step sizes are never re-derived here.

struct LoggerScreen: View {
    @ObservedObject var store: TrainingStore
    // The logger's drawn Undo comes off the busiest screen in the product; the room's transient
    // carries both the action and the fact that the window is open (`16-the-workout.md`).
    @ObservedObject var withheld: WithheldWindow
    let isSignedIn: Bool
    // nil once something already reaches this log.
    let onConnect: (() -> Void)?
    let say: (String?) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var weightKg = Prefill.emptyBarKg
    @State private var reps = Prefill.emptyBarReps
    @State private var kind: SetKind = .working
    @State private var sheet: Sheet?
    @State private var goingTo: String?
    @State private var pendingDeviation: Deviation?
    @State private var asked: Set<String> = []

    // Creating a movement is not here: it is drawn over the picker that opened it, by the picker
    // (`15-the-routine.md`), so the search a lifter typed is still there when they cancel.
    private enum Sheet: Identifiable {
        case weight
        case reps
        case jump
        case picker
        case deviation(Deviation, movement: String)

        var id: String {
            switch self {
            case .weight: return "weight"
            case .reps: return "reps"
            case .jump: return "jump"
            case .picker: return "picker"
            case .deviation(let deviation, _): return "deviation-\(deviation.exerciseId)"
            }
        }

        var detents: Set<PresentationDetent> {
            switch self {
            case .weight, .reps: return [.height(520)]
            case .picker, .jump: return [.large]
            case .deviation: return [.medium, .large]
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: GymLayout.blockGap) {
            header
            if let line = LiveLines.onThisDeviceLine(store.strandedCount, stall: store.strandedBy) {
                unsynced(line)
            }
            RefusalRows(refusals: store.refusals, catalog: store.catalog,
                        onDismiss: { store.clearRefusals() })

            if store.exerciseId == nil {
                assembling
            } else {
                movementHead
                Spacer(minLength: 0)
                slotColumn
                value
                Spacer(minLength: 0)
                VStack(spacing: GymLayout.blockGap) {
                    kindPill
                    ladder
                    repsRow
                    logButton.padding(.top, WindmillSpace.x2)
                }
            }
        }
        .padding(.horizontal, GymLayout.gutter)
        .padding(.top, WindmillSpace.x2)
        .padding(.bottom, WindmillSpace.x3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // Simultaneous, and layered over the whole body: the title is a full-width tap target and
        // the today column is a nested vertical scroll, and neither may swallow the walk.
        .simultaneousGesture(walkStroke)
        .onChange(of: store.prefill) { _, dialled in
            weightKg = dialled.weightKg
            reps = dialled.reps
        }
        .task {
            weightKg = store.prefill.weightKg
            reps = store.prefill.reps
        }
        .sheet(item: $sheet, onDismiss: settleTheMove) { sheet in
            content(of: sheet)
                .presentationBackground(skin.surface)
                .presentationDetents(sheet.detents)
        }
    }

    // MARK: - the session

    private var header: some View {
        TimelineView(.periodic(from: .now, by: 1)) { beat in
            HStack(spacing: WindmillSpace.x3) {
                Circle().fill(skin.accent).frame(width: 8, height: 8)
                Text(store.session.map(Readout.routine) ?? Readout.noRoutine)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(Readout.clock(stamp(beat.date) - (store.session?.startedAtMs ?? 0)))
                    .font(GymType.numeral(14))
                    .foregroundStyle(skin.inkDim)
            }
        }
    }

    private func unsynced(_ line: String) -> some View {
        Text(line)
            .font(GymType.numeral(12))
            .foregroundStyle(skin.unsyncedInk)
            .lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var assembling: some View {
        OpeningPicker(catalog: store.catalog, taken: store.order, lastSets: store.lastSets,
                      sessions: store.recent, isSignedIn: isSignedIn,
                      onPick: { move(to: $0) },
                      onCreate: { name, equipment in await mint(name, loadedAs: equipment) },
                      onConnect: onConnect)
            .task { await store.loadLastSets() }
    }

    // MARK: - the movement in hand

    // A horizontal stroke steps through `store.order` and stops at its ends rather than wrapping; the
    // dots under the title are the position readout that stroke needs. Two chevron buttons came off
    // the screen a lifter looks at with a bar in their hands, and VoiceOver keeps both as named
    // actions on the head, because a drag is not something it can perform (`13-gestures.md` Law 1).
    private var movementHead: some View {
        HStack(spacing: WindmillSpace.x2) {
            Button { sheet = .jump } label: {
                VStack(spacing: WindmillSpace.x1) {
                    Text(Readout.movement(store.exerciseId ?? "", in: store.catalog))
                        .font(WindmillFont.display(26))
                        .foregroundStyle(skin.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let position = LiveLines.movementPosition(order: store.order,
                                                                 current: store.exerciseId),
                       let standing = store.exerciseId.flatMap({ store.order.firstIndex(of: $0) }) {
                        HStack(spacing: 5) {
                            ForEach(store.order.indices, id: \.self) { place in
                                Circle()
                                    .fill(place <= standing ? skin.accent : skin.lineStrong)
                                    .frame(width: 7, height: 7)
                            }
                        }
                        .padding(.top, WindmillSpace.x1)
                        .accessibilityHidden(true)
                        Text(position)
                            .font(GymType.numeral(10.5))
                            .textCase(.uppercase)
                            .kerning(0.7)
                            .foregroundStyle(skin.inkFaint)
                    }
                }
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .accessibilityHint("This session’s movements")
        }
        .accessibilityAction(named: "Previous movement") { walked(-1) }
        .accessibilityAction(named: "Next movement") { walked(1) }
    }

    // Dominant-horizontal, so the today column's own vertical scroll still wins its strokes, and
    // started away from the leading edge, which the shell's way home owns at this depth
    // (`13-gestures.md` Law 3, D1).
    private var walkStroke: some Gesture {
        DragGesture(minimumDistance: Self.walkThreshold, coordinateSpace: .global)
            .onEnded { stroke in
                guard stroke.startLocation.x > Self.systemEdge else { return }
                let across = stroke.translation.width
                guard abs(across) >= Self.walkThreshold,
                      abs(across) > abs(stroke.translation.height) * Self.dominance else { return }
                walked(across < 0 ? 1 : -1)
            }
    }

    // The system's own screen-edge strip: a stroke that starts inside it is never the room's.
    private static let systemEdge: CGFloat = 20
    private static let walkThreshold: CGFloat = 44
    private static let dominance: CGFloat = 1.5

    private func walked(_ direction: Int) {
        guard let neighbour = walk(direction) else { return }
        GymConfirm.revealed()
        move(to: neighbour)
    }

    private func walk(_ direction: Int) -> String? {
        guard let current = store.exerciseId,
              let standing = store.order.firstIndex(of: current) else { return nil }
        let next = standing + direction
        guard store.order.indices.contains(next) else { return nil }
        return store.order[next]
    }

    // The slot strip: this movement's landed sets, the slot about to be lifted, the slots still to
    // come — and, last, the set a window is still open on, carried under its own movement's name;
    // taking it back is the transient's job, not this row's.
    private var slotColumn: some View {
        // Rows and height are both read on the beat: nothing publishes the window closing.
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let slots = slots(undoable: store.undoable)
            let current = slots.first { slot in
                guard case .current = slot else { return false }
                return true
            }?.id
            ScrollViewReader { column in
                ScrollView {
                    VStack(spacing: WindmillSpace.x2) {
                        ForEach(slots) { slot in SlotRow(slot: slot).id(slot.id) }
                    }
                    .frame(maxWidth: .infinity)
                }
                .scrollBounceBehavior(.basedOnSize)
                .defaultScrollAnchor(.bottom)
                // Only this column is elastic, and it asks for exactly what it holds; past three rows it scrolls inside itself.
                .frame(maxHeight: min(Self.columnCap, CGFloat(slots.count) * Self.rowHeight))
                // The bottom anchor shows the newest landed set; with slots still to come under it,
                // the one about to be lifted is what has to stay in view.
                .onChange(of: current, initial: true) { _, current in
                    guard let current else { return }
                    column.scrollTo(current, anchor: .center)
                }
            }
        }
        .layoutPriority(1)
    }

    // Named rather than measured: the column claims its height before its rows are laid out.
    private static let rowHeight: CGFloat = GymTap.minimum + WindmillSpace.x2
    private static let columnCap: CGFloat = rowHeight * 3

    // `column`'s rows that are not this movement's own are the one carried row.
    private func slots(undoable: TrainingSet?) -> [LiveLines.Slot] {
        let here = store.todaySets
        let carried = LiveLines.column(store.sets, of: store.exerciseId, undoable: undoable,
                                       catalog: store.catalog, stalled: store.stalled)
            .filter { row in !here.contains { $0.id == row.id } }
        return LiveLines.slots(here, plan: store.planEntry, stalled: store.stalled)
            + carried.map(LiveLines.Slot.landed)
    }

    // MARK: - the value

    // One line, the count in the faint ink and the current slot's target after it in the target ink:
    // `Set 3 of 5 · target 3 @ 90`; `Set 6 of 5` alone past the plan, `Set 3` alone on an open line.
    private var setLine: Text {
        let count = Text(counter.count.prefix(1).uppercased() + counter.count.dropFirst())
        guard let target = counter.target else { return count }
        return count + Text(" · \(target)").foregroundStyle(skin.targetInk)
    }

    private var value: some View {
        VStack(spacing: WindmillSpace.x2) {
            setLine
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)

            HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
                Button { sheet = .weight } label: {
                    Text(Readout.weight(weightKg))
                        .font(GymType.weight)
                        .foregroundStyle(skin.weightInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                        .overlay(alignment: .bottom) { TypeableRule() }
                }
                .accessibilityLabel("Weight \(Readout.weight(weightKg)) kilograms")
                .accessibilityHint("Type a weight")
                Text("kg")
                    .font(GymType.numeral(15))
                    .foregroundStyle(skin.inkFaint)
                Text("× \(reps)")
                    .font(GymType.reps)
                    .foregroundStyle(skin.inkDim)
            }

            if store.lastTimeFailed {
                Text("the log didn’t answer — this isn’t your last time")
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.unsyncedInk)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // SwiftUI's `underline(pattern: .dot)` scales its rule with the font; this stays 2pt under both numbers.
    // MARK: - the dial

    // Which kind the next set is filed as. It disarms itself the moment a set lands: a warmup counts toward nothing, and a
    // toggle left on would file every working set after it as a ramp-up.
    private var kindPill: some View {
        HStack(spacing: 0) {
            // A Menu holding a Picker, so all four kinds are one tap away in place rather than a trip
            // through a sheet, and the armed one carries the platform's own checkmark.
            Menu {
                Picker("Log the next set as", selection: $kind) {
                    ForEach(SetKind.allCases, id: \.self) { choice in
                        Text(choice.rawValue).tag(choice)
                    }
                }
            } label: {
                HStack(spacing: WindmillSpace.x1) {
                    Text(kind.rawValue)
                        .font(WindmillFont.body(13, .bold))
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .foregroundStyle(kind == .working ? skin.inkDim : skin.warmupInk)
                .padding(.horizontal, WindmillSpace.x4)
                .frame(minHeight: GymTap.minimum)
                .background(Capsule().fill(skin.surface))
                .overlay(Capsule().strokeBorder(skin.lineStrong, lineWidth: 1))
            }
            .menuOrder(.fixed)
            .accessibilityLabel("Set type")
            .accessibilityValue(kind.rawValue)
            Spacer(minLength: 0)
        }
    }

    // `Ladder.labels` is the order: down-plate, down-fine, up-fine, up-plate.
    private var ladder: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(Array(Ladder.labels(for: weightKg).enumerated()), id: \.offset) { index, label in
                let plate = index == 0 || index == 3
                Button { weightKg = Ladder.bump(weight: weightKg, direction: index < 2 ? -1 : 1,
                                                big: plate) } label: {
                    Text(label)
                        .font(GymType.numeral(plate ? 13 : 18, .semibold))
                        .foregroundStyle(plate ? skin.inkFaint : skin.ink)
                        .frame(maxWidth: plate ? 54 : .infinity, minHeight: GymTap.row)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .fill(plate ? skin.surface : skin.raised))
                        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .strokeBorder(plate ? skin.line : skin.lineStrong, lineWidth: 1))
                }
            }
        }
    }

    private var repsRow: some View {
        HStack(spacing: WindmillSpace.x2) {
            Text("reps")
                .font(WindmillFont.body(13))
                .foregroundStyle(skin.inkFaint)
            Spacer(minLength: 0)
            Button { reps = Ladder.bumpReps(reps, direction: -1) } label: { step("minus") }
                .accessibilityLabel("One rep fewer")
            Button { sheet = .reps } label: {
                Text(String(reps))
                    .font(GymType.numeral(20, .bold))
                    .foregroundStyle(skin.ink)
                    .overlay(alignment: .bottom) { TypeableRule() }
                    .frame(minWidth: 40, minHeight: GymTap.minimum)
            }
            .accessibilityLabel("\(reps) reps")
            .accessibilityHint("Type a rep count")
            Button { reps = Ladder.bumpReps(reps, direction: 1) } label: { step("plus") }
                .accessibilityLabel("One rep more")
        }
    }

    private func step(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(skin.inkDim)
            .frame(width: GymTap.minimum, height: GymTap.minimum)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
    }

    private var logButton: some View {
        Button {
            let filedAs = kind
            // One haptic for one act: the set confirmation, and nothing else fires here.
            GymConfirm.setLogged(under: store.preferences)
            kind = .working
            Task {
                await store.logSet(weightKg: weightKg, reps: reps, kind: filedAs)
                // Nil once the window is zero-length or the set has already gone: the room draws no
                // transient over an act it cannot take back.
                guard let held = store.undoable else { return }
                await withheld.hold(Withheld(
                    .loggedSet, subject: held.id,
                    line: WithheldWords.logged(Readout.effort(weightKg: held.weightKg,
                                                              reps: held.reps)),
                    closesAtMs: store.undoableUntilMs,
                    settle: {
                    await store.flushPendingSets()
                    return true
                },
                    restore: { store.withdraw(held.id) }))
            }
        } label: {
            Text("Log set  ·  \(Readout.effort(weightKg: weightKg, reps: reps))")
                .font(WindmillFont.body(19, .bold))
                .foregroundStyle(store.isFinishing ? skin.inkFaint : skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(store.isFinishing ? skin.raised : skin.accent))
        }
        // The store refuses a set once a finish is in flight.
        .disabled(store.isFinishing)
    }

    // MARK: - the sheets

    @ViewBuilder
    private func content(of sheet: Sheet) -> some View {
        switch sheet {
        case .weight:
            KeypadSheet(mode: .weight, current: weightKg,
                        onCommit: { weightKg = $0; self.sheet = nil },
                        onCancel: { self.sheet = nil })
        case .reps:
            KeypadSheet(mode: .reps, current: Double(reps),
                        onCommit: { reps = Int($0); self.sheet = nil },
                        onCancel: { self.sheet = nil })
        case .jump:
            JumpSheet(rows: LiveLines.jumpRows(order: store.order, sets: store.sets,
                                               plan: store.session?.plan, catalog: store.catalog,
                                               current: store.exerciseId, stalled: store.stalled),
                      assembling: store.session?.routineId == nil,
                      onJump: { move(to: $0) },
                      onMove: { store.reorder(from: $0, to: $1) },
                      onDrop: { movement in Task { await store.drop(movement) } },
                      onAdd: { self.sheet = .picker },
                      onClose: { self.sheet = nil })
        case .picker:
            MovementPicker(catalog: store.catalog, taken: store.order, lastSets: store.lastSets,
                           sessions: store.recent,
                           onPick: { move(to: $0) },
                           onCreate: { name, equipment in await mint(name, loadedAs: equipment) },
                           onClose: { self.sheet = nil })
                .task { await store.loadLastSets() }
        case .deviation(let deviation, let movement):
            DeviationSheet(deviation: deviation, movement: movement,
                           onSave: {
                               self.sheet = nil
                               say(nil)
                               Task {
                                   guard let why = await store.save(deviation.offered,
                                                                    toRoutine: deviation.routineId,
                                                                    at: deviation.position,
                                                                    for: deviation.exerciseId) else { return }
                                   say(why.line("\(deviation.routine) wasn’t changed"))
                               }
                           },
                           onToday: { self.sheet = nil })
        }
    }

    // The room's own note goes first: the create step draws the refusal this write raises, and nothing
    // older than it stands behind the picker while it does.
    private func mint(_ name: String,
                      loadedAs equipment: String) async -> Result<Exercise, TrainingStore.WriteFailure> {
        say(nil)
        return await store.create(name, loadedAs: equipment)
    }

    // A deviation is raised only on leaving a movement, and only after the sheet that raised it has closed.
    //
    // The guard below is the one a swipe made load-bearing. `pendingDeviation` is a single slot, and
    // at swipe velocity two movements can be crossed before `settleTheMove` runs — a second walk
    // would overwrite the slot, and the question about the first movement would never be asked. It is
    // refused with the reason said, never queued and never overwritten.
    private func move(to movement: String) {
        switch LiveLines.walk(pendingMovement: pendingDeviation.map {
                                  Readout.movement($0.exerciseId, in: store.catalog)
                              },
                              inFlight: goingTo != nil) {
        case .refuse(let why):
            say(why)
            return
        case .wait:
            return
        case .go:
            break
        }
        if let leaving = store.exerciseId, leaving != movement,
           let deviation = Deviation(leaving: leaving, session: store.session,
                                     sets: store.sets, asked: asked) {
            asked.insert(leaving)
            pendingDeviation = deviation
        }
        goingTo = movement
        guard sheet == nil else {
            sheet = nil
            return
        }
        settleTheMove()
    }

    private func settleTheMove() {
        if let movement = goingTo {
            goingTo = nil
            Task { await store.choose(movement) }
        }
        guard let deviation = pendingDeviation else { return }
        pendingDeviation = nil
        sheet = .deviation(deviation, movement: Readout.movement(deviation.exerciseId, in: store.catalog))
    }

    private var counter: LiveLines.Counter {
        LiveLines.counter(workingSetsToday: LiveLines.workingCount(store.todaySets),
                          planEntry: store.planEntry)
    }

    private func stamp(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
    }
}

// One pill of the slot strip, drawn three ways: a landed set as lifted with its ✓, the set about to
// be lifted reading its target in the target ink under the accent outline, and a set still to come
// reading its target in the faint ink. A planned pill is not a door — there is nothing to fix yet —
// and VoiceOver reads every pill as one sentence rather than as its parts.
struct SlotRow: View {
    let slot: LiveLines.Slot

    @Environment(\.gymSkin) private var skin

    var body: some View {
        HStack(spacing: WindmillSpace.x3) {
            switch slot {
            case .landed(let row):
                Text(row.index)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.inkFaint)
                    .frame(width: 16, alignment: .leading)
                Text(row.value)
                    .font(GymType.numeral(14.5))
                    .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.ink)
                Text(row.note)
                    .font(GymType.numeral(11))
                    .foregroundStyle(row.isOnThisDevice ? skin.unsyncedInk : skin.inkFaint)
                Spacer(minLength: 0)
                Text("✓")
                    .font(GymType.numeral(13))
                    .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.setDone)
            case .current(let ordinal, let target, _):
                Text(String(ordinal))
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.targetInk)
                    .frame(width: 16, alignment: .leading)
                Text(target)
                    .font(GymType.numeral(14.5, .semibold))
                    .foregroundStyle(skin.targetInk)
                Spacer(minLength: 0)
            case .coming(let ordinal, let target, _):
                Text(String(ordinal))
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .frame(width: 16, alignment: .leading)
                Text(target)
                    .font(GymType.numeral(14.5))
                    .foregroundStyle(skin.inkFaint)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, GymLayout.rowInset)
        .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
            .strokeBorder(isCurrent ? skin.accent : skin.line, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    private var isCurrent: Bool {
        guard case .current = slot else { return false }
        return true
    }

    // A landed pill is `set 2, 80 × 5`, a warmup `warmup, 40 × 5`, with the note after when it says
    // something more; a planned pill is the domain's `set 4, target 100 × 1`.
    var spoken: String {
        switch slot {
        case .landed(let row):
            let head = row.index == "w" ? "warmup" : "set \(row.index)"
            let note = row.note.isEmpty || row.note == head ? [] : [row.note]
            return ([head, row.value] + note).joined(separator: ", ")
        case .current(_, _, let spoken), .coming(_, _, let spoken):
            return spoken
        }
    }
}

// The rule under a numeral says the number takes a keypad. Both screens that raise one draw it — the
// logger and the fix sheet — so it is one view rather than two copies of five lines.
struct TypeableRule: View {
    @Environment(\.gymSkin) private var skin

    var body: some View {
        DottedRule()
            .stroke(style: StrokeStyle(lineWidth: 2, dash: [2, 3]))
            .foregroundStyle(skin.lineStrong)
            .frame(height: 2)
    }
}

// SwiftUI has no dashed line, and its dashed borders are four sides of one.
private struct DottedRule: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

// A notice, not data: it is swiped away rather than tapped away, and the drawn `Dismiss` comes off.
// The stroke is the room's own rather than `.swipeActions`, because these rows are drawn inside a
// List on two screens and inside a plain stack on the logger, and one row may not behave two ways.
// A drag is not something VoiceOver can perform, so the action is declared beside it (Law 1).
struct RefusalRows: View {
    let refusals: [RefusedWrite]
    let catalog: [Exercise]
    let onDismiss: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var pushed: CGFloat = 0

    // Far enough that a scroll's sideways wobble is never one.
    private static let dismissAt: CGFloat = 64

    var body: some View {
        ForEach(refusals) { refused in
            HStack(alignment: .top, spacing: WindmillSpace.x3) {
                VStack(alignment: .leading, spacing: GymLayout.pair) {
                    Text(Self.headline(of: refused, in: catalog))
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.alarmInk)
                    Text(refused.reason)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkDim)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: GymTap.minimum)
            .contentShape(Rectangle())
            .offset(x: pushed)
            .opacity(Double(max(0, 1 - abs(pushed) / (Self.dismissAt * 2))))
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onChanged { stroke in
                        guard abs(stroke.translation.width) > abs(stroke.translation.height) else { return }
                        pushed = stroke.translation.width
                    }
                    .onEnded { stroke in
                        guard abs(stroke.translation.width) >= Self.dismissAt,
                              abs(stroke.translation.width) > abs(stroke.translation.height) else {
                            withAnimation(.snappy) { pushed = 0 }
                            return
                        }
                        GymConfirm.revealed()
                        pushed = 0
                        onDismiss()
                    }
            )
            .accessibilityElement(children: .combine)
            .accessibilityAction(named: "Dismiss", onDismiss)
        }
    }

    // Pinned to the word with Android's LoggerScreen.kt. A lost set and a lost change are different losses: the first never
    // reached the log, the second is a set the log still holds under the old numbers.
    static func headline(of refused: RefusedWrite, in catalog: [Exercise]) -> String {
        switch refused {
        case .set(let set):
            return "\(Readout.movement(set.exerciseId, in: catalog)) "
                + "\(Readout.effort(weightKg: set.weightKg, reps: set.reps)) never reached the log"
        case .change(let set):
            return "\(Readout.movement(set.exerciseId, in: catalog)) "
                + "\(Readout.effort(weightKg: set.weightKg, reps: set.reps)) — that change didn’t land"
        case .claim(let claim):
            return "“\(claim.name)” couldn’t be claimed"
        }
    }
}
