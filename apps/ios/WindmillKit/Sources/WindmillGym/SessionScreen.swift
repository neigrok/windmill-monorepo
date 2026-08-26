import SwiftUI
import WindmillPlatform

// The frozen plan snapshot is the only source for what the plan said, never today's routine.
// Sets are grouped by movement in the order the movements were first touched, then in performed order inside a movement.
enum Performed {
    struct Note: Equatable {
        let text: String
        let emphasised: Bool

        init(_ text: String) {
            self.text = text
            emphasised = false
        }

        init(short reps: Int) {
            let words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
            text = ((1...words.count).contains(reps) ? words[reps - 1] : String(reps)) + " short"
            emphasised = true
        }
    }

    enum Against: Equatable {
        case plan(PlanEntry)
        case unplanned  // the session had a plan and this movement is not in it
        case none  // no plan at all, or a plan that names this movement twice
    }

    // Named so it does not shadow the standard library's `Set` in this namespace.
    struct Row: Equatable, Identifiable {
        let id: String
        let number: String
        let effort: String
        let kind: SetKind
        let note: Note?
    }

    struct Movement: Equatable, Identifiable {
        let id: String
        let movement: String
        let against: Against
        let rows: [Row]
    }

    // Falls back to the position in this movement's own run, so a row is never numberless.
    static func movements(_ sets: [TrainingSet], catalog: [Exercise],
                          plan: PlanSnapshot? = nil) -> [Movement] {
        let performed = sets.sorted { $0.completedAtMs < $1.completedAtMs }
        var order: [String] = []
        for set in performed where !order.contains(set.exerciseId) { order.append(set.exerciseId) }

        return order.map { exerciseId in
            let mine = performed.filter { $0.exerciseId == exerciseId }
            let against = planned(plan, for: exerciseId)
            // A warmup counts toward nothing, so it is never compared to a plan line.
            let opening = mine.first { $0.kind == .working }?.id
            return Movement(
                id: exerciseId,
                movement: Readout.movement(exerciseId, in: catalog),
                against: against,
                rows: mine.enumerated().map { index, set in
                    Row(id: set.id,
                        number: String(set.setNumber ?? index + 1),
                        effort: Readout.effort(weightKg: set.weightKg, reps: set.reps),
                        kind: set.kind,
                        note: set.kind == .working
                            ? note(for: set, against: against, opening: set.id == opening)
                            : nil)
                })
        }
    }

    // `PlanEntry` carries no id, so a movement the plan names twice is annotated with nothing at all.
    // A snapshot with a routine name and no entries is read as no plan.
    static func planned(_ plan: PlanSnapshot?, for exerciseId: String) -> Against {
        guard let plan, !plan.entries.isEmpty else { return .none }
        let named = plan.entries.filter { $0.exerciseId == exerciseId }
        if named.isEmpty { return .unplanned }
        guard named.count == 1 else { return .none }
        return .plan(named[0])
    }

    // In the order the facts outrank each other: the load, then the reps. Both heavier and short reads as heavier.
    static func note(for set: TrainingSet, against: Against, opening: Bool) -> Note? {
        if case .unplanned = against { return opening ? Note("added today") : nil }
        guard case .plan(let entry) = against else { return nil }
        if let target = entry.weightKg, target != 0, set.weightKg != target {
            let delta = Readout.weight(abs(set.weightKg - target))
            if set.weightKg > target { return Note("+\(delta) over plan") }
            return Note("\(delta) under plan")
        }
        guard let target = entry.reps, set.reps < target else { return Note("on plan") }
        return Note(short: target - set.reps)
    }
}

struct SessionScreen: View {
    let summary: SessionSummary
    @ObservedObject var store: TrainingStore
    let coach: CoachDoors
    let onMovement: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var detail: SessionDetail?
    @State private var setsFailure: TrainingStore.WriteFailure?
    @State private var review: Review?
    @State private var read = false
    @State private var fixing: Fixing?

    private struct Fixing: Identifiable {
        let set: TrainingSet
        let movement: String
        let number: String

        var id: String { self.set.id }
    }

    var body: some View {
        List {
            Section {
                head
                RefusalRows(refusals: store.refusals, catalog: store.catalog,
                            onDismiss: { store.clearRefusals() })
                undoRow
            }
            .modifier(PlainRow())

            sets

            Section {
                if read { ReviewReadout(review: review, catalog: store.catalog, stats: false) }
                CoachShareCard(doors: coach)
            }
            .modifier(PlainRow())
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 1)
        .task { await load() }
        .sheet(item: $fixing) { open in
            FixSheet(set: open.set, movement: open.movement, number: open.number,
                     routine: row.session.plan?.routine,
                     onSave: { correction in
                         fixing = nil
                         Task { await save(correction, to: open.set) }
                     },
                     onDelete: {
                         fixing = nil
                         Task { await delete(open.set) }
                     })
                .presentationBackground(skin.surface)
                .presentationDetents([.height(560)])
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(when)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)
            if let frozen = row.session.plan, !frozen.entries.isEmpty {
                HStack(spacing: WindmillSpace.x2) {
                    Circle()
                        .fill(skin.targetInk)
                        .frame(width: 6, height: 6)
                    Text("plan snapshot · frozen \(Readout.time(row.session.startedAtMs))")
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkDim)
                }
                .padding(.horizontal, WindmillSpace.x3)
                .padding(.vertical, WindmillSpace.x2)
                .overlay(Capsule().strokeBorder(skin.line, lineWidth: 1))
            }
            if row.closedItself {
                Text("closed on its own — no set for four hours")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // Past the undo window the row has left the log; the store owns how long that window is and is asked rather than told.
    @ViewBuilder
    private var undoRow: some View {
        if let taken = store.restorable {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                if store.restorable != nil {
                    HStack {
                        Text("Deleted \(Readout.effort(weightKg: taken.set.weightKg, reps: taken.set.reps))")
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkDim)
                        Spacer(minLength: 0)
                        Button("Undo") {
                            Task {
                                guard await store.restore() else { return }
                                await restored(taken.set)
                            }
                        }
                        .font(WindmillFont.body(14, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(minWidth: 60, minHeight: GymTap.minimum - 8)
                    }
                }
            }
        }
    }

    // One section per movement, in the order the movements were first touched. The card is the
    // section's row background, not a rectangle drawn around a stack.
    @ViewBuilder
    private var sets: some View {
        if let detail {
            ForEach(Performed.movements(detail.sets, catalog: store.catalog,
                                        plan: row.session.plan)) { movement in
                Section {
                    ForEach(movement.rows) { performed in row(performed, of: movement.movement) }
                } header: {
                    HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                        MovementDoor(exerciseId: movement.id, name: movement.movement,
                                     font: WindmillFont.body(16, .bold), ink: skin.ink,
                                     open: onMovement)
                        Spacer(minLength: 0)
                        planLine(movement.against)
                    }
                    .textCase(nil)
                }
                .listRowBackground(skin.surface)
                .listRowSeparatorTint(skin.line)
            }
        } else if let setsFailure {
            Section {
                Text(setsFailure.line("the sets are on your account"))
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
            .modifier(PlainRow())
        }
    }

    @ViewBuilder
    private func planLine(_ against: Performed.Against) -> some View {
        switch against {
        case .plan(let entry):
            Text("plan \(Readout.target(sets: entry.sets, reps: entry.reps, weightKg: entry.weightKg))")
                .font(GymType.numeral(11.5))
                .foregroundStyle(entry.isOpen ? skin.inkFaint : skin.targetInk)
        case .unplanned:
            Text("not in the plan")
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
        case .none:
            EmptyView()
        }
    }

    private func row(_ set: Performed.Row, of movement: String) -> some View {
        Button { open(set, of: movement) } label: {
            HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                Text(set.number)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .frame(width: 18, alignment: .trailing)
                Text(set.effort)
                    .font(GymType.numeral(15))
                    .foregroundStyle(set.kind == .working ? skin.ink : skin.warmupInk)
                Spacer(minLength: WindmillSpace.x3)
                if set.kind != .working {
                    Text(set.kind.rawValue)
                        .font(GymType.numeral(11))
                        .foregroundStyle(skin.warmupInk)
                } else if let note = set.note {
                    Text(note.text)
                        .font(GymType.numeral(11))
                        .foregroundStyle(note.emphasised ? skin.inkDim : skin.inkFaint)
                }
            }
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Fix this set")
    }

    private func open(_ row: Performed.Row, of movement: String) {
        guard let held = detail?.sets.first(where: { $0.id == row.id }) else { return }
        fixing = Fixing(set: held, movement: movement, number: row.number)
    }

    // The head's numbers are the log's arithmetic, read off `recent`; the opening copy is the fallback.
    private var row: SessionSummary {
        store.recent.first { $0.id == summary.id } ?? summary
    }

    private var when: String {
        var said = [Readout.day(row.session.startedAtMs)]
        if let finished = row.session.finishedAtMs {
            said.append(Readout.duration(finished - row.session.startedAtMs))
        }
        if let working = row.workingSetCount { said.append(Readout.workingCount(working)) }
        if let tonnage = row.tonnageKg.flatMap(Readout.tonnage) { said.append(tonnage) }
        return said.joined(separator: " · ")
    }

    private func load() async {
        switch await store.sessionDetail(summary.session.id) {
        case .success(let found): detail = found
        case .failure(let why): setsFailure = why
        }
        review = await store.review(of: summary.session.id)
        read = true
    }

    // What the store answers with is what stands: a change the log refused leaves the row exactly as it was.
    private func save(_ correction: SetFix, to set: TrainingSet) async {
        let stands = await store.fix(set, in: summary.session.id, by: correction)
        if let held = detail {
            detail = SessionDetail(session: held.session,
                                   sets: held.sets.map { $0.id == stands.id ? stands : $0 })
        }
        await moved()
    }

    private func delete(_ set: TrainingSet) async {
        await store.delete(set, in: summary.session.id)
        if let held = detail {
            detail = SessionDetail(session: held.session, sets: held.sets.filter { $0.id != set.id })
        }
        await moved()
    }

    private func restored(_ set: TrainingSet) async {
        if let held = detail {
            detail = SessionDetail(session: held.session,
                                   sets: (held.sets + [set]).sorted { $0.completedAtMs < $1.completedAtMs })
        }
        await moved()
    }

    // Asked again after every move: a correction is exactly what moves a record, and a silence leaves the last answer standing.
    private func moved() async {
        guard let read = await store.review(of: summary.session.id) else { return }
        review = read
    }
}

// A row the List draws no chrome around: the room's own cards paint themselves.
struct PlainRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: WindmillSpace.x5,
                                      bottom: 4, trailing: WindmillSpace.x5))
    }
}
