import SwiftUI
import WindmillPlatform

// A SESSION, REVISITED — what the plan said beside what you did (§G17): the sets as they were
// performed, the domain's reading of them, and the coach share.
//
// EVERY SET ROW IS A DOOR ONTO §G18, since 2026-08-12, and NOTHING ON THE SCREEN SAYS SO. The
// paragraph that used to — dim against bright, tap any set to fix it — explained the design at the
// foot of a screen the design does not need explained, and the sweep took it. Nothing replaced it:
// `tap to fix` on every row without a plan comment is that paragraph in a smaller font, printed
// once per set. The row is a 46pt button and the sheet it opens introduces itself.
// A movement's NAME is the other door on this screen: it opens that movement's record (§H).
//
// THE FROZEN PLAN SNAPSHOT IS THE ONLY SOURCE for "what the plan said". Never today's routine: a
// routine renamed or retargeted since must not rewrite what the log says about the past, and that is
// the whole reason the snapshot exists.

// The sets of a session as they are read back: grouped by movement in the order the movements were
// first touched, and inside a movement in the order the sets were performed. That is the order the
// session was LIVED in, and the same one "Keep this as a routine" composes a program from.
enum Performed {
    // The one line the plan gets to say about a set. A shortfall reads a step brighter than the
    // rest because it is the only one worth a second look — and it is still one line, in the room's
    // own ink. Nothing here is red and nothing here is a grade.
    struct Note: Equatable {
        let text: String
        let emphasised: Bool

        init(_ text: String) {
            self.text = text
            emphasised = false
        }

        // Spelled as a word, because the column it sits beside is a column of numerals and `2 short`
        // there reads as another load. Past ten it is a digit again: "seventeen" is not a word
        // anybody wants at the end of a set.
        init(short reps: Int) {
            let words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
            text = ((1...words.count).contains(reps) ? words[reps - 1] : String(reps)) + " short"
            emphasised = true
        }
    }

    // What the frozen plan has to say about a movement — the header line, and the entry every set of
    // it is read against.
    enum Against: Equatable {
        case plan(PlanEntry)
        case unplanned          // the session had a plan and this movement is not in it
        case none               // no plan at all, or a plan that names this movement twice
    }

    // Named for what it is on screen rather than for the domain's `TrainingSet`, which is also what
    // keeps it from shadowing the standard library's `Set` inside this namespace.
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

    // `setNumber` is the LOG's own count of this movement in this session, and it is what the row
    // prints when it is there. A session read back from the log always carries it; the fallback is
    // the position in this movement's own run, so a row is never numberless.
    static func movements(_ sets: [TrainingSet], catalog: [Exercise],
                          plan: PlanSnapshot? = nil) -> [Movement] {
        let performed = sets.sorted { $0.completedAtMs < $1.completedAtMs }
        var order: [String] = []
        for set in performed where !order.contains(set.exerciseId) { order.append(set.exerciseId) }

        return order.map { exerciseId in
            let mine = performed.filter { $0.exerciseId == exerciseId }
            let against = planned(plan, for: exerciseId)
            // A warmup counts toward nothing — not the records, not the prefill, not the plan — so it
            // is never compared to one, and "added today" opens the first WORKING set rather than a
            // ramp-up that happens to come first.
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

    // PLANENTRY CARRIES NO ID, so a movement the plan names TWICE cannot be matched to one of its
    // entries: the set does not record which one it was performed for, and position in the plan is a
    // guess about a session that may have walked them in any order. Such a movement is annotated
    // with nothing at all — a wrong "two short" beside somebody's training is worse than a blank.
    //
    // A snapshot with a routine name and NO entries is a plan that says nothing — the clamp over a
    // `plan` object the log could not read whole leaves one — and it is read as no plan rather than
    // as a plan naming nothing. Read the other way it accuses: every movement "not in the plan",
    // every opening set "added today", and no chip on the head to explain where that came from,
    // because the chip is suppressed for exactly this snapshot.
    static func planned(_ plan: PlanSnapshot?, for exerciseId: String) -> Against {
        guard let plan, !plan.entries.isEmpty else { return .none }
        let named = plan.entries.filter { $0.exerciseId == exerciseId }
        if named.isEmpty { return .unplanned }
        guard named.count == 1 else { return .none }
        return .plan(named[0])
    }

    // What the plan makes of one set, fail-fast in the order the facts outrank each other: the load
    // it named, then the reps it asked for. A set that is both heavier and short reads as heavier —
    // the load is the claim the plan makes, and two clauses on one row is the scolding this screen
    // refuses. An absent weight target is "whatever you did last time" and compares against nothing.
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

    // The set the sheet is open over, with the two things the sheet may not work out for itself: the
    // movement's NAME as this screen already spelled it, and the NUMBER the row gave it — the log's
    // own count where there is one, its place in the movement's run where there is not.
    private struct Fixing: Identifiable {
        let set: TrainingSet
        let movement: String
        let number: String

        // Spelled through `self` because a bare `set` at the head of an accessor body is the setter
        // keyword, and the field is named for what it holds.
        var id: String { self.set.id }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                head
                // A correction the log will never take is SAID here, over the very set it was made
                // on — the third mount of the one banner every lost write in gym rides. Without it
                // this screen would draw a fix as though it had landed, which is the one thing a
                // room may not do.
                RefusalRows(refusals: store.refusals, catalog: store.catalog,
                            onDismiss: { store.clearRefusals() })
                undoRow
                sets
                // The record and the comparison, and only those: the three facts the tiles would
                // otherwise carry are already in the head line above, and one fact belongs in one
                // place. Drawn once the log has answered, because "the log didn't answer" is this
                // read's empty state and the screen has not asked yet on the first frame.
                if read { ReviewReadout(review: review, catalog: store.catalog, stats: false) }
                CoachShareCard(doors: coach)
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
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
            Text(Readout.routine(of: row.session))
                .font(WindmillFont.display(28))
                .foregroundStyle(skin.ink)
            Text(when)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)
            // The chip names WHEN the plan was frozen, which is the fact that makes everything dim
            // on this screen trustworthy: the targets below are the ones this session actually had,
            // not the ones the routine has now.
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
            // The four-hour rule closed this one rather than a tap, which is a fact about the
            // session a lifter reading it back deserves — the duration above is a phone left
            // running, not a workout that lasted that long.
            if row.closedItself {
                Text("closed on its own — no set for four hours")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // The delete, still takeable back — the same shape and the same nine seconds the logger's Undo
    // keeps, and it is the whole of what this screen promises. Past the window the row has left the
    // log and nothing here pretends otherwise: there is no trash and no recovery to point at.
    //
    // It reserves NOTHING when there is nothing to take back, which is nearly always on this screen —
    // the logger holds its own row's height open because a set lands there every ninety seconds, and
    // a permanent gap under the head here would be air paid for by every session ever read back. The
    // beat inside is what ends the offer: the store owns how long the window is, and is asked rather
    // than told.
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

    @ViewBuilder
    private var sets: some View {
        if let detail {
            ForEach(Performed.movements(detail.sets, catalog: store.catalog,
                                        plan: row.session.plan)) { movement in
                VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                    HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                        // The name is a door onto that movement's record (§H) — one tap from "what
                        // did I do here" to "how has this moved", which is the question a session
                        // read back raises and cannot answer.
                        MovementDoor(exerciseId: movement.id, name: movement.movement,
                                     font: WindmillFont.body(16, .bold), ink: skin.ink,
                                     open: onMovement)
                        Spacer(minLength: 0)
                        planLine(movement.against)
                    }
                    // No spacing of its own: every row is a tap target now, and a 46pt row already
                    // carries the air a 6pt gap used to add.
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(movement.rows) { performed in row(performed, of: movement.movement) }
                    }
                }
                .padding(WindmillSpace.x4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
            }
        } else if let setsFailure {
            // The log's own sentence when it sent one — including the one this store writes for a
            // session that has been discarded from another surface since the log listed it, which is
            // a fact about the log and not about this phone's signal.
            Text(setsFailure.line("the sets are on your account"))
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
        }
    }

    @ViewBuilder
    private func planLine(_ against: Performed.Against) -> some View {
        switch against {
        case .plan(let entry):
            // An OPEN line (§M) reads `plan open` in the room's faintest ink: the routine named
            // nothing for this movement and the lifter decided at the rack, which is a different
            // fact from a plan that named a number this session did not meet.
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

    // A warmup counts toward nothing — not the records, not the prefill, not the comparison — so it
    // is drawn in the ink that says so rather than beside a working set as though it were one. The
    // kind takes the annotation slot when there is one to name: a drop set is not "on plan".
    //
    // The whole row is the door onto §G18, at the room's own tap target and not the text's height:
    // this is read at arm's length with chalked hands, and a 25pt row is the mistake the two named
    // sizes in `GymTap` exist to make unwritable.
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
                // AND NOTHING WHEN THE PLAN HAS NOTHING TO SAY. The board draws `tap to fix` once,
                // on the one row it is showing under a thumb, and the annotation slot of its last
                // row is empty. Printed on every unannotated row instead it is an instruction six
                // times down a session with no routine, which is the paragraph this wave deleted
                // wearing a smaller font. The row is a door because it is a 46pt button, and the
                // sheet it opens says what it is.
            }
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityHint("Fix this set")
    }

    // The row names a set; the SHEET needs the set itself, and it comes from the detail this screen
    // is drawing rather than from anywhere else — that copy already carries whatever correction this
    // device is still holding, so the sheet opens on what is on screen.
    private func open(_ row: Performed.Row, of movement: String) {
        guard let held = detail?.sets.first(where: { $0.id == row.id }) else { return }
        fixing = Fixing(set: held, movement: movement, number: row.number)
    }

    // THIS SESSION'S ROW AS THE LOG NOW STATES IT. The head's numbers are the log's own arithmetic —
    // the working count, the tonnage — and a correction moves them, so it reads them off `recent`,
    // which the store re-reads whenever a change lands. Reading the copy this screen was opened with
    // would leave "2 working · 742 kg" standing over a list drawing one of those two in warmup ink.
    //
    // That opening copy is the fallback and stays honest as one: a session older than everything the
    // lifter has scrolled to is not on the page, and the row they arrived with is still the log's own
    // answer for it.
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

    // Two reads, and neither one blocks the other: the sets are the session and the review is what
    // the domain makes of it, so a screen missing one still says everything it can about the other.
    private func load() async {
        switch await store.sessionDetail(summary.session.id) {
        case .success(let found): detail = found
        case .failure(let why): setsFailure = why
        }
        review = await store.review(of: summary.session.id)
        read = true
    }

    // THE THREE MOVES, EACH APPLIED HERE AND NOT RE-READ. The store has already put the change where
    // it belongs — the shelf, or the queue that will carry it — and a round trip for the SETS would
    // be asking the log to confirm a fact this device is the author of, on a screen that must work in
    // a basement.
    //
    // What the store answers with is what STANDS, which is not always what was asked for: a change
    // the log refused outright leaves the row exactly as it was, and drawing the corrected numbers
    // under a banner saying they never landed is the one thing this screen may not do.
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

    // What the DOMAIN makes of the sets is asked again after every move, because a correction is
    // exactly what moves a record: the sentence and the comparison drawn under the sets are a reading
    // of the numbers that just changed. An answer replaces an answer and a silence leaves the last
    // one standing — a re-read that could not reach the log has learned nothing worth blanking a
    // line for. (The head above needs no ask: it follows `store.recent`.)
    private func moved() async {
        guard let read = await store.review(of: summary.session.id) else { return }
        review = read
    }
}
