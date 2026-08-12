import Foundation

// THE RULES THE LOGGER DRAWS — every decision the live surface makes, with no SwiftUI in them: which
// movements this session holds and in what order, where to stand when the room opens onto a workout
// already running, and the exact words above the weight. It used to be named as the twin of the web
// logger's `prefill.js` and `Logger.jsx`; the web stopped lifting on 2026-08-09 (§11) and both went
// with the surface, so this is where these rules live now and there is no second copy to keep in
// step.
//
// The screen never congratulates and never warns. "set 4 of 3" is legal, normal, and drawn in the
// same ink as "set 3 of 5": the plan is a snapshot of what was written down, the log is what
// happened, and when they disagree the log is right — so the counter never scolds and the target is
// never hidden.

public enum LiveOrder {
    // The plan's lines first in the plan's own order, then everything performed the plan never
    // named, in the order it was first performed.
    //
    // What the device already holds keeps its place at the head. A movement appended on the bench
    // mid-rest belongs where the lifter put it, and a second pass that re-sorted it behind the plan
    // would move the list under a thumb that is already reaching for it.
    public static func merged(held: [String], plan: PlanSnapshot?, sets: [TrainingSet]) -> [String] {
        var order = held
        for entry in plan?.entries ?? [] where !order.contains(entry.exerciseId) {
            order.append(entry.exerciseId)
        }
        for set in sets.sorted(by: { $0.completedAtMs < $1.completedAtMs })
        where !order.contains(set.exerciseId) {
            order.append(set.exerciseId)
        }
        return order
    }

    // Where to stand when the room opens onto a session that is already running: at the movement the
    // last set went into, because that is where the lifter is. Nothing logged yet means the head of
    // the plan, and a session with no movements at all means the picker.
    public static func resume(order: [String], sets: [TrainingSet]) -> String? {
        let performed = sets.sorted { $0.completedAtMs < $1.completedAtMs }
        if let last = performed.last?.exerciseId, order.contains(last) { return last }
        return order.first
    }

    // WHAT A SWIPE MAY TAKE OFF THE LIST (§A screen 2), and the narrowness is the whole safety of the
    // gesture. A movement with a set in it HAPPENED, and no gesture on a list may un-happen a lift; a
    // movement the frozen plan names is what the routine asked for, and taking today's walk off the
    // program is screen 8's question, which this wave does not build. Both are also put straight back
    // by `merged` on the next redraw, so offering the swipe over them would be an affordance that
    // undoes itself — the list is only ever allowed to lose what nothing else is holding on to.
    public static func droppable(_ movement: String, sets: [TrainingSet], plan: PlanSnapshot?) -> Bool {
        guard !sets.contains(where: { $0.exerciseId == movement }) else { return false }
        return plan?.entry(for: movement) == nil
    }
}

public enum LiveLines {
    public struct Counter: Equatable {
        public let count: String        // "set 3 of 5"
        public let tail: String         // "  ·  plan 5 × 5 @ 82.5"
    }

    public struct Card: Equatable {
        public let title: String
        public let body: String
    }

    public struct Row: Equatable, Identifiable {
        public let id: String
        public let index: String        // the performed ordinal, or "w" — only a warmup skips a number
        public let value: String
        public let note: String
        public let time: String
        public let isWarmup: Bool
        public let isOnThisDevice: Bool
    }

    // A movement as the assembly list draws it (§A screen 2): what it is, what has gone into it, and
    // the two things a gesture is allowed to do to it. `sets` is the same readout the logger's today
    // list draws, because they are one session seen from two places and one of them may not spell a
    // set differently from the other.
    public struct JumpRow: Equatable, Identifiable {
        public let id: String
        public let name: String
        public let meta: String         // "3 sets" · "2 of 5 sets" · "just added"
        public let note: String?        // the sentence under a movement nothing has gone into yet
        public let isJustAdded: Bool
        public let sets: [Row]
        public let isCurrent: Bool
        public let canDrop: Bool
    }

    // Only WORKING sets advance the counter — `workingCount` above is the whole of that rule — and a
    // movement with no target says so rather than borrowing a number from somewhere else. A plan line
    // that names sets but no rep target reads `plan 3 × max`: the routine asked for whatever the
    // movement gives that day.
    public static func counter(workingSetsToday: Int, planEntry: PlanEntry?) -> Counter {
        guard let planEntry else {
            return Counter(count: "set \(workingSetsToday + 1)", tail: "  ·  no target")
        }
        let load = planEntry.weightKg.map { " @ \(Readout.weight($0))" } ?? ""
        return Counter(count: "set \(workingSetsToday + 1) of \(planEntry.sets)",
                       tail: "  ·  plan \(planEntry.sets) × \(Readout.repTarget(planEntry.reps))\(load)")
    }

    // FOUR STATES, NOT TWO, and the difference between them is the whole reason this card exists.
    // A read still in flight says so and waits; a read that came back empty-handed says THAT instead
    // of going on claiming to be reading; and ONLY an answer may say "first time". A card drawing
    // "no history" over a movement the lifter has squatted for a year, because the phone was in a
    // basement, is the product lying in the one pixel it exists for.
    public static func prefillCard(lastTime: LastTime?, planEntry: PlanEntry?, routine: String?,
                                   readFailed: Bool, now: Int64) -> Card {
        guard let lastTime else {
            return Card(title: "Last time", body: readFailed ? "the log didn’t answer" : "reading your log…")
        }
        guard let session = lastTime.session else {
            guard let planned = planEntry?.weightKg else {
                return Card(title: "First time logging this", body: "no history — start where you like")
            }
            return Card(title: "First time logging this",
                        body: "no history — dialled to the plan’s \(Readout.weight(planned)) kg")
        }
        // Which day of the program that block belonged to, when it was not this one — hiding the
        // difference is what would make a lifter read Tuesday's numbers as Thursday's.
        let elsewhere = lastTime.routine.flatMap { $0 == routine ? nil : "  ·  \($0)" } ?? ""
        let shown = lastTime.sets.prefix(4)
            .map { Readout.effort(weightKg: $0.weightKg, reps: $0.reps) }
            .joined(separator: ",   ")
        let more = lastTime.sets.count > 4 ? ",   +\(lastTime.sets.count - 4) more" : ""
        return Card(
            title: "Last time · \(Readout.day(session.startedAtMs)) · \(Readout.ago(session.startedAtMs, now: now))\(elsewhere)",
            body: shown + more
        )
    }

    // This movement's sets in the order performed, with real wall-clock times and never "2 minutes
    // ago" — the lifter is reconstructing a session, not reading a feed. A set still on this device
    // says so plainly, in its own row, because that is where the fact belongs.
    public static func rows(_ sets: [TrainingSet], stalled: Set<String>) -> [Row] {
        var ordinal = 0
        return sets.map { set in
            let isWarmup = set.kind == .warmup
            if !isWarmup { ordinal += 1 }
            let held = stalled.contains(set.id)
            return Row(id: set.id,
                       index: isWarmup ? "w" : String(ordinal),
                       value: Readout.effort(weightKg: set.weightKg, reps: set.reps),
                       note: isWarmup ? "warmup" : (held ? "on this device" : ""),
                       time: Readout.time(set.completedAtMs),
                       isWarmup: isWarmup,
                       isOnThisDevice: held)
        }
    }

    // ONE WORD FOR WHAT COUNTS. A set counts toward a target, toward a plan counter and toward the
    // number under the thumb only when its kind is `working` — the kinds are warmup · working · drop
    // · failure, and the last three are all things that happened to a set the plan never asked for.
    // The domain's record rules read the same word and so does log.js `workingSetsOf`, so a drop must
    // not advance "set 4 of 5" here while counting toward nothing there. The movement is optional
    // because a session's sets are sometimes already one movement's.
    public static func workingCount(_ sets: [TrainingSet], of exerciseId: String? = nil) -> Int {
        sets.filter { $0.kind == .working && (exerciseId == nil || $0.exerciseId == exerciseId) }.count
    }

    // Moving on is the lifter's decision and never the app's: nothing advances when a plan's set
    // count is reached, and nothing advances when a rest lands. This list is the only thing that
    // moves them, and it says where everything stands so the choice is theirs to make.
    //
    // IT IS ALSO THE ASSEMBLY SURFACE (§A screen 2), which is the same list read forwards: what you
    // have done so far IS the routine you will be offered at the end, so appending happens here, on
    // the bench, mid-rest — never in an editor before the first set.
    //
    // `just added` is the last movement in the walk with nothing in it yet, and it is exactly the
    // row a swipe may drop: the same two facts — no sets, not in the plan — say both, so the list
    // can never tell a lifter something was just added and then refuse to take it back.
    public static func jumpRows(order: [String], sets: [TrainingSet], plan: PlanSnapshot?,
                                catalog: [Exercise], current: String?,
                                stalled: Set<String> = []) -> [JumpRow] {
        order.map { exerciseId in
            let performed = sets.filter { $0.exerciseId == exerciseId }
            let droppable = LiveOrder.droppable(exerciseId, sets: sets, plan: plan)
            let justAdded = droppable && exerciseId == order.last
            return JumpRow(id: exerciseId,
                           name: Readout.movement(exerciseId, in: catalog),
                           meta: justAdded
                               ? "just added"
                               : meta(done: workingCount(sets, of: exerciseId),
                                      planned: plan?.entry(for: exerciseId)?.sets),
                           note: performed.isEmpty ? "no sets yet — logging one starts it" : nil,
                           isJustAdded: justAdded,
                           sets: rows(performed, stalled: stalled),
                           isCurrent: exerciseId == current,
                           canDrop: droppable)
        }
    }

    // The count is the sets the walk has already OFFERED and could not land (`TrainingStore
    // .strandedCount`), never every queued set: every set is briefly pending on purpose, and
    // counting those would flash this strip for the whole undo window on a healthy connection.
    public static func onThisDeviceLine(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        let subject = count == 1 ? "1 set is" : "\(count) sets are"
        return "\(subject) saved on this device only. No signal down here — they flush when you’re back up."
    }

    // The right-hand count, and only the count: what a movement with nothing in it says is the row's
    // own `note`, drawn under the name where the design puts it, so the two never say it twice.
    private static func meta(done: Int, planned: Int?) -> String {
        guard let planned else { return Readout.setCount(done) }
        return "\(done) of \(planned) sets"
    }
}
