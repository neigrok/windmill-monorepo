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
    // TWO FACTS AND TWO STRINGS, because §K sends them to two places: the count sits over the
    // numeral and the target under the movement's name. They used to be one line joined by a
    // separator this struct carried, which is a layout decision a domain string had no business
    // holding.
    public struct Counter: Equatable {
        public let count: String        // "set 3 of 5"
        public let plan: String         // "plan 5 × 5 @ 82.5" · "no target"
    }

    public struct Row: Equatable, Identifiable {
        public let id: String
        public let index: String        // the performed ordinal, or "w" — only a warmup skips a number
        public let value: String
        public let note: String         // the kind, when it is not a working set — else where it is saved
        public let countsTowardNothing: Bool
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
    //
    // AN OPEN LINE (§M) READS EXACTLY LIKE NO PLAN AT ALL, because that is what it is at the rack:
    // the routine named nothing, so there is no set count to count towards and no target to state.
    // The one thing it may not do is borrow — `set 3 of 0` over a row the lifter deliberately left
    // open would be the routine answering the question it left them.
    public static func counter(workingSetsToday: Int, planEntry: PlanEntry?) -> Counter {
        guard let planEntry, let sets = planEntry.sets else {
            return Counter(count: "set \(workingSetsToday + 1)", plan: "no target")
        }
        let load = planEntry.weightKg.map { " @ \(Readout.weight($0))" } ?? ""
        return Counter(count: "set \(workingSetsToday + 1) of \(sets)",
                       plan: "plan \(sets) × \(Readout.repTarget(planEntry.reps))\(load)")
    }

    // `movement 3 of 6` (§K) — where the walk stands, counted off the MERGED session order: the
    // plan's lines plus everything appended on the bench, which is the same list the chevrons step
    // through and the jump sheet draws. Counting the plan alone would number an appended movement
    // "7 of 6", and a session with no plan at all still has an order to stand in — the one the
    // lifter assembled. It degrades to silence rather than to a line that says nothing: nil when
    // nothing is in hand — the picker's screen, not this line's — and over a walk of one, where
    // `movement 1 of 1` would be the screen narrating itself.
    public static func movementPosition(order: [String], current: String?) -> String? {
        guard let current, let standing = order.firstIndex(of: current) else { return nil }
        guard order.count > 1 else { return nil }
        return "movement \(standing + 1) of \(order.count)"
    }

    // This movement's sets in the order performed, which is why the row carries no wall-clock any
    // more: at the rack a row is read for its numbers. The instant stays on the set itself
    // (`completedAtMs`, what everything here sorts by) and no screen in this app draws it now — the
    // log and the session detail time the SESSION, never its rows. A set the log has not taken yet
    // says so in its own row, and a kind that counts toward nothing is NAMED there, because a drop
    // set numbered beside a working one is the column claiming a lift the plan counter above it
    // does not count.
    public static func rows(_ sets: [TrainingSet], stalled: Set<String>) -> [Row] {
        var ordinal = 0
        return sets.map { set in
            let isWarmup = set.kind == .warmup
            if !isWarmup { ordinal += 1 }
            let held = stalled.contains(set.id)
            return Row(id: set.id,
                       index: isWarmup ? "w" : String(ordinal),
                       value: Readout.effort(weightKg: set.weightKg, reps: set.reps),
                       note: set.kind == .working ? (held ? "on this device" : "") : set.kind.rawValue,
                       countsTowardNothing: set.kind != .working,
                       isOnThisDevice: held)
        }
    }

    // THE COLUMN THE LOGGER DRAWS (§K) — this movement's sets, and then the one row an Undo may
    // still be owed on when the walk has already moved past the movement it belongs to.
    //
    // §K put Undo on the row of the set it takes back, and the title's chevrons can change the
    // movement INSIDE the undo window: a lifter logs a set, taps `›`, and the row that carried the
    // verb is no longer in any column. A verb with nowhere to be drawn is a verb that is gone, so
    // the row travels — NAMED with the movement it would take the set off, because a foreign row
    // sitting unlabelled under this movement's would be the column claiming a lift that did not
    // happen here. It leaves again the moment the window closes, with the set that landed.
    public static func column(_ sets: [TrainingSet], of movement: String?, undoable: TrainingSet?,
                              catalog: [Exercise], stalled: Set<String>) -> [Row] {
        let here = rows(sets.filter { $0.exerciseId == movement }, stalled: stalled)
        guard let undoable, undoable.exerciseId != movement,
              let left = rows(sets.filter { $0.exerciseId == undoable.exerciseId }, stalled: stalled)
                  .first(where: { $0.id == undoable.id })
        else { return here }
        // The note slot carries the movement rather than "on this device": the row is about to be
        // withdrawn, and where it is saved is not the fact the lifter needs to read off it.
        return here + [Row(id: left.id, index: left.index, value: left.value,
                           note: Readout.movement(undoable.exerciseId, in: catalog),
                           countsTowardNothing: left.countsTowardNothing, isOnThisDevice: false)]
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
                                      // Absent for a movement the plan does not name AND for one it
                                      // left open — neither has a number of sets to count towards.
                                      planned: plan?.entry(for: exerciseId).flatMap(\.sets)),
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
