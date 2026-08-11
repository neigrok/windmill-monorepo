import SwiftUI
import WindmillPlatform

// A SESSION, REVISITED — what the plan said beside what you did (§G17). It is the finished session
// and nothing else: the sets as they were performed, the domain's reading of them, and the coach
// share. It draws no editing of any kind — the log is append-only, the phone owns the OPEN session,
// and a screen offering to change a closed one would promise a route the wire does not have.
//
// TAPPING A SET DOES NOTHING YET, so nothing here says it does. §G17 draws `tap to fix` on one row;
// the correction path is W3 and the copy waits for it — a line promising a move the product cannot
// make is the same defect as a door onto a screen that does not exist.
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

    @Environment(\.gymSkin) private var skin
    @State private var detail: SessionDetail?
    @State private var setsFailure: TrainingStore.WriteFailure?
    @State private var review: Review?
    @State private var read = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                head
                sets
                Text("Dim is what the plan said. Bright is what you did. A miss gets one line and no scolding.")
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
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
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(Readout.routine(of: summary.session))
                .font(WindmillFont.display(28))
                .foregroundStyle(skin.ink)
            Text(when)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)
            // The chip names WHEN the plan was frozen, which is the fact that makes everything dim
            // on this screen trustworthy: the targets below are the ones this session actually had,
            // not the ones the routine has now.
            if let frozen = summary.session.plan, !frozen.entries.isEmpty {
                HStack(spacing: WindmillSpace.x2) {
                    Circle()
                        .fill(skin.targetInk)
                        .frame(width: 6, height: 6)
                    Text("plan snapshot · frozen \(Readout.time(summary.session.startedAtMs))")
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
            if summary.closedItself {
                Text("closed on its own — no set for four hours")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    @ViewBuilder
    private var sets: some View {
        if let detail {
            ForEach(Performed.movements(detail.sets, catalog: store.catalog,
                                        plan: summary.session.plan)) { movement in
                VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                    HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                        Text(movement.movement)
                            .font(WindmillFont.body(16, .bold))
                            .foregroundStyle(skin.ink)
                        Spacer(minLength: 0)
                        planLine(movement.against)
                    }
                    ForEach(movement.rows) { performed in row(performed) }
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
            Text("plan \(Readout.target(sets: entry.sets, reps: entry.reps, weightKg: entry.weightKg))")
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.targetInk)
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
    private func row(_ set: Performed.Row) -> some View {
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
    }

    // The head's own line, and the numbers on it are the ones the log's row already showed: tapping
    // a row may not change a session's facts on the way in.
    private var when: String {
        var said = [Readout.day(summary.session.startedAtMs)]
        if let finished = summary.session.finishedAtMs {
            said.append(Readout.duration(finished - summary.session.startedAtMs))
        }
        if let working = summary.workingSetCount { said.append(Readout.workingCount(working)) }
        if let tonnage = summary.tonnageKg.flatMap(Readout.tonnage) { said.append(tonnage) }
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
}
