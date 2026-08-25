import SwiftUI
import WindmillPlatform

// Every weight and rep tap goes through `Ladder`; step sizes are never re-derived here.

struct LoggerScreen: View {
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool
    // nil once something already reaches this log.
    let onBuildRoutine: (() -> Void)?
    let say: (String?) -> Void
    let onFinish: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var weightKg = Prefill.emptyBarKg
    @State private var reps = Prefill.emptyBarReps
    @State private var kind: SetKind = .working
    @State private var kindsUp = false
    @State private var restStartedAtMs: Int64?
    @State private var sheet: Sheet?
    @State private var goingTo: String?
    @State private var pendingDeviation: Deviation?
    @State private var asked: Set<String> = []
    @State private var minting = false
    @State private var mintFailure: String?

    private enum Sheet: Identifiable {
        case weight
        case reps
        case jump
        case picker
        // Replaces the picker rather than stacking over it.
        case creating(String)
        case deviation(Deviation, movement: String)

        var id: String {
            switch self {
            case .weight: return "weight"
            case .reps: return "reps"
            case .jump: return "jump"
            case .picker: return "picker"
            case .creating(let name): return "creating-\(name)"
            case .deviation(let deviation, _): return "deviation-\(deviation.exerciseId)"
            }
        }

        var detents: Set<PresentationDetent> {
            switch self {
            case .weight, .reps: return [.height(520)]
            case .picker, .jump, .creating: return [.large]
            case .deviation: return [.medium, .large]
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            header
            if let clock = restClock { restRow(clock) }
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
                todayColumn
                value
                Spacer(minLength: 0)
                kindPill
                ladder
                repsRow
                logButton
            }
        }
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.top, WindmillSpace.x2)
        .padding(.bottom, WindmillSpace.x3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onChange(of: store.prefill) { _, dialled in
            weightKg = dialled.weightKg
            reps = dialled.reps
        }
        .task {
            weightKg = store.prefill.weightKg
            reps = store.prefill.reps
            // The rest is computed from the last set's own instant, so nothing about it is persisted.
            restStartedAtMs = store.todaySets.last?.completedAtMs
        }
        // Keyed on the whole clock, so a target changed mid-rest replaces this task instead of leaving a sleep to land.
        .task(id: restClock) {
            guard let clock = restClock else { return }
            let started = clock.startedAtMs
            let target = clock.targetSeconds
            let waited = (Int64(Date().timeIntervalSince1970 * 1000) - started) / 1000
            guard waited < Int64(target) else { return }
            try? await Task.sleep(for: .seconds(Int64(target) - waited))
            guard !Task.isCancelled else { return }
            // iOS suspends the app, so the sleep above lands whenever it is next awake; a late chime confirms nothing.
            let elapsed = (Int64(Date().timeIntervalSince1970 * 1000) - started) / 1000
            guard elapsed <= Int64(target) + Rest.lateChimeSeconds else { return }
            GymConfirm.restLanded(under: store.preferences)
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
                Button("Finish", action: onFinish)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(minWidth: 70, minHeight: GymTap.minimum)
            }
        }
    }

    private func restRow(_ clock: Rest.Clock) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { beat in
            let now = stamp(beat.date)
            let filled = Rest.filled(targetSeconds: clock.targetSeconds,
                                     startedAtMs: clock.startedAtMs, now: now)
            let reading = Rest.reading(startedAtMs: clock.startedAtMs, now: now)
            Button { restStartedAtMs = nil } label: {
                HStack(spacing: WindmillSpace.x3) {
                    Capsule().fill(skin.line)
                        .frame(height: 2)
                        .overlay(alignment: .leading) {
                            GeometryReader { rule in
                                Capsule().fill(skin.accent).frame(width: rule.size.width * filled)
                            }
                        }
                    Text(reading)
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkDim)
                }
                .frame(maxWidth: .infinity, minHeight: 22)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Resting")
            .accessibilityValue(reading)
            .accessibilityHint("Clears the rest timer")
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
                      isSignedIn: isSignedIn,
                      onPick: { move(to: $0) },
                      onCreate: { sheet = .creating($0) },
                      onBuildRoutine: onBuildRoutine)
            .task { await store.loadLastSets() }
    }

    // MARK: - the movement in hand

    // The chevrons step through `store.order` and stop at its ends rather than wrapping.
    private var movementHead: some View {
        HStack(spacing: WindmillSpace.x2) {
            walkButton(-1, glyph: "chevron.left", label: "Previous movement")
            Button { sheet = .jump } label: {
                VStack(spacing: 2) {
                    Text(Readout.movement(store.exerciseId ?? "", in: store.catalog))
                        .font(WindmillFont.display(26))
                        .foregroundStyle(skin.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(counter.plan)
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.targetInk)
                        .lineLimit(1)
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
                        .padding(.top, 2)
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
            walkButton(1, glyph: "chevron.right", label: "Next movement")
        }
    }

    private func walkButton(_ direction: Int, glyph: String, label: String) -> some View {
        let neighbour = walk(direction)
        return Button { if let neighbour { move(to: neighbour) } } label: {
            Image(systemName: glyph)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(neighbour == nil ? skin.line : skin.inkFaint)
                .frame(width: GymTap.minimum, height: GymTap.minimum)
        }
        .disabled(neighbour == nil)
        .accessibilityLabel(label)
    }

    private func walk(_ direction: Int) -> String? {
        guard let current = store.exerciseId,
              let standing = store.order.firstIndex(of: current) else { return nil }
        let next = standing + direction
        guard store.order.indices.contains(next) else { return nil }
        return store.order[next]
    }

    // Undo is offered only over the set it takes back, and only while that set is still this device's alone.
    private var todayColumn: some View {
        // Rows and height are both read on the beat: nothing publishes the Undo window closing.
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let undoable = store.undoable
            let rows = LiveLines.column(store.sets, of: store.exerciseId, undoable: undoable,
                                        catalog: store.catalog, stalled: store.stalled)
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(rows) { row in
                        done(row, undoable: row.id == undoable?.id)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.bottom)
            // Only this column is elastic, and it asks for exactly what it holds; past three rows it scrolls inside itself.
            .frame(maxHeight: min(Self.columnCap, CGFloat(rows.count) * Self.rowHeight))
        }
        .layoutPriority(1)
    }

    // Named rather than measured: the column claims its height before its rows are laid out.
    private static let rowHeight: CGFloat = 52
    private static let columnCap: CGFloat = rowHeight * 3

    private func done(_ row: LiveLines.Row, undoable: Bool) -> some View {
        HStack(spacing: WindmillSpace.x3) {
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
            if undoable {
                Button("Undo") { store.undoLast() }
                    .font(WindmillFont.body(13, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(minWidth: 56, minHeight: GymTap.minimum)
            } else {
                Text("✓")
                    .font(GymType.numeral(13))
                    .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.setDone)
            }
        }
        .padding(.horizontal, WindmillSpace.x3)
        .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
    }

    // MARK: - the value

    private var value: some View {
        VStack(spacing: 6) {
            Text(counter.count)
                .font(GymType.numeral(10.5))
                .textCase(.uppercase)
                .kerning(0.7)
                .foregroundStyle(skin.inkFaint)

            HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
                Button { sheet = .weight } label: {
                    Text(Readout.weight(weightKg))
                        .font(GymType.weight)
                        .foregroundStyle(skin.weightInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                        .overlay(alignment: .bottom) { typeable }
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
    private var typeable: some View {
        DottedRule()
            .stroke(style: StrokeStyle(lineWidth: 2, dash: [2, 3]))
            .foregroundStyle(skin.lineStrong)
            .frame(height: 2)
    }

    // MARK: - the dial

    // Which kind the next set is filed as. It disarms itself the moment a set lands: a warmup counts toward nothing, and a
    // toggle left on would file every working set after it as a ramp-up.
    private var kindPill: some View {
        HStack(spacing: 0) {
            Button { kindsUp = true } label: {
                HStack(spacing: WindmillSpace.x1) {
                    Text(kind.rawValue)
                        .font(WindmillFont.body(13, .bold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .foregroundStyle(kind == .working ? skin.inkDim : skin.warmupInk)
                .padding(.horizontal, WindmillSpace.x4)
                .frame(minHeight: GymTap.minimum)
                .background(Capsule().fill(skin.surface))
                .overlay(Capsule().strokeBorder(skin.lineStrong, lineWidth: 1))
            }
            .accessibilityLabel("Set type")
            .accessibilityValue(kind.rawValue)
            Spacer(minLength: 0)
        }
        .confirmationDialog("Log the next set as", isPresented: $kindsUp, titleVisibility: .visible) {
            ForEach([SetKind.working, .warmup], id: \.self) { choice in
                Button(choice.rawValue) { kind = choice }
            }
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
                        .frame(maxWidth: plate ? 54 : .infinity, minHeight: 60)
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
            Button { reps = Ladder.bumpReps(reps, direction: -1) } label: { step("−") }
                .accessibilityLabel("One rep fewer")
            Button { sheet = .reps } label: {
                Text(String(reps))
                    .font(GymType.numeral(20, .bold))
                    .foregroundStyle(skin.ink)
                    .overlay(alignment: .bottom) { typeable }
                    .frame(minWidth: 40, minHeight: GymTap.minimum)
            }
            .accessibilityLabel("\(reps) reps")
            .accessibilityHint("Type a rep count")
            Button { reps = Ladder.bumpReps(reps, direction: 1) } label: { step("+") }
                .accessibilityLabel("One rep more")
        }
    }

    private func step(_ glyph: String) -> some View {
        Text(glyph)
            .font(WindmillFont.display(21, .semibold))
            .foregroundStyle(skin.inkDim)
            .frame(width: GymTap.minimum, height: GymTap.minimum)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
    }

    // nil until a set lands and a target is set: the timer times the gap between two sets.
    private var restClock: Rest.Clock? {
        guard let started = restStartedAtMs,
              let target = Rest.target(planEntry: store.planEntry, preferences: store.preferences)
        else { return nil }
        return Rest.Clock(startedAtMs: started, targetSeconds: target)
    }

    private var logButton: some View {
        Button {
            let landed = Int64(Date().timeIntervalSince1970 * 1000)
            let filedAs = kind
            GymConfirm.setLogged(under: store.preferences)
            restStartedAtMs = landed
            kind = .working
            Task { await store.logSet(weightKg: weightKg, reps: reps, kind: filedAs) }
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
                           onPick: { move(to: $0) },
                           onCreate: { self.sheet = .creating($0) },
                           onClose: { self.sheet = nil })
                .task { await store.loadLastSets() }
        case .creating(let name):
            CreateMovementSheet(opening: name, creating: minting, failure: mintFailure,
                                onCreate: { said, equipment in mint(said, loadedAs: equipment) },
                                onCancel: { self.sheet = nil })
        case .deviation(let deviation, let movement):
            DeviationSheet(deviation: deviation, movement: movement,
                           onSave: {
                               self.sheet = nil
                               say(nil)
                               Task {
                                   guard let why = await store.save(deviation.liftedKg,
                                                                    toRoutine: deviation.routineId,
                                                                    at: deviation.position,
                                                                    for: deviation.exerciseId) else { return }
                                   say(why.line("\(deviation.routine) wasn’t changed"))
                               }
                           },
                           onToday: { self.sheet = nil })
        }
    }

    // The sheet stays up until the log answers, and the refusal is said on it.
    private func mint(_ name: String, loadedAs equipment: String) {
        minting = true
        mintFailure = nil
        say(nil)
        Task {
            switch await store.create(name, loadedAs: equipment) {
            case .success(let made):
                minting = false
                sheet = nil
                await store.choose(made.id)
            case .failure(let why):
                minting = false
                mintFailure = why.line("“\(name)” wasn’t created")
            }
        }
    }

    // A deviation is raised only on leaving a movement, and only after the sheet that raised it has closed.
    private func move(to movement: String) {
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
            restStartedAtMs = nil
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

// SwiftUI has no dashed line, and its dashed borders are four sides of one.
private struct DottedRule: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

struct RefusalRows: View {
    let refusals: [RefusedWrite]
    let catalog: [Exercise]
    let onDismiss: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ForEach(refusals) { refused in
            HStack(alignment: .top, spacing: WindmillSpace.x3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.headline(of: refused, in: catalog))
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.alarmInk)
                    Text(refused.reason)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkDim)
                }
                Spacer(minLength: 0)
                Button("Dismiss", action: onDismiss)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .frame(minHeight: GymTap.minimum)
            }
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
