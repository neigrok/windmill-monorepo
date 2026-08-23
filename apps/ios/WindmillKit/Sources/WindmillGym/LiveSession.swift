import Foundation

public enum LiveOrder {
    // Held movements first, then the plan's lines in the plan's order, then the rest in the order first performed.
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

    public static func resume(order: [String], sets: [TrainingSet]) -> String? {
        let performed = sets.sorted { $0.completedAtMs < $1.completedAtMs }
        if let last = performed.last?.exerciseId, order.contains(last) { return last }
        return order.first
    }

    // A movement with a set in it, or one the frozen plan names, may not be dropped.
    public static func droppable(_ movement: String, sets: [TrainingSet], plan: PlanSnapshot?) -> Bool {
        guard !sets.contains(where: { $0.exerciseId == movement }) else { return false }
        return plan?.entry(for: movement) == nil
    }
}

public enum LiveLines {
    public struct Counter: Equatable {
        public let count: String  // "set 3 of 5"
        public let plan: String  // "plan 5 × 5 @ 82.5" · "no target"
    }

    public struct Row: Equatable, Identifiable {
        public let id: String
        public let index: String  // the performed ordinal, or "w" — only a warmup skips a number
        public let value: String
        public let note: String  // the kind, when it is not a working set — else where it is saved
        public let countsTowardNothing: Bool
        public let isOnThisDevice: Bool
    }

    public struct JumpRow: Equatable, Identifiable {
        public let id: String
        public let name: String
        public let meta: String  // "3 sets" · "2 of 5 sets" · "just added"
        public let note: String?  // the sentence under a movement nothing has gone into yet
        public let isJustAdded: Bool
        public let sets: [Row]
        public let isCurrent: Bool
        public let canDrop: Bool
    }

    // Only working sets advance the counter, and a plan line with no set count reads like no plan at all.
    public static func counter(workingSetsToday: Int, planEntry: PlanEntry?) -> Counter {
        guard let planEntry, let sets = planEntry.sets else {
            return Counter(count: "set \(workingSetsToday + 1)", plan: "no target")
        }
        let load = planEntry.weightKg.map { " @ \(Readout.weight($0))" } ?? ""
        return Counter(count: "set \(workingSetsToday + 1) of \(sets)",
                       plan: "plan \(sets) × \(Readout.repTarget(planEntry.reps))\(load)")
    }

    // Counted off the merged session order, never the plan alone.
    public static func movementPosition(order: [String], current: String?) -> String? {
        guard let current, let standing = order.firstIndex(of: current) else { return nil }
        guard order.count > 1 else { return nil }
        return "movement \(standing + 1) of \(order.count)"
    }

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

    // Carries the one row an Undo may still be owed on, named with its own movement, until the undo window closes.
    public static func column(_ sets: [TrainingSet], of movement: String?, undoable: TrainingSet?,
                              catalog: [Exercise], stalled: Set<String>) -> [Row] {
        let here = rows(sets.filter { $0.exerciseId == movement }, stalled: stalled)
        guard let undoable, undoable.exerciseId != movement,
              let left = rows(sets.filter { $0.exerciseId == undoable.exerciseId }, stalled: stalled)
                  .first(where: { $0.id == undoable.id })
        else { return here }
        return here + [Row(id: left.id, index: left.index, value: left.value,
                           note: Readout.movement(undoable.exerciseId, in: catalog),
                           countsTowardNothing: left.countsTowardNothing, isOnThisDevice: false)]
    }

    // Only a `working` set counts toward a target, a plan counter or the number under the thumb.
    public static func workingCount(_ sets: [TrainingSet], of exerciseId: String? = nil) -> Int {
        sets.filter { $0.kind == .working && (exerciseId == nil || $0.exerciseId == exerciseId) }.count
    }

    // `just added` is the last movement in the walk with nothing in it yet.
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
                                      // Absent for a movement the plan does not name and for one it left open.
                                      planned: plan?.entry(for: exerciseId).flatMap(\.sets)),
                           note: performed.isEmpty ? "no sets yet — logging one starts it" : nil,
                           isJustAdded: justAdded,
                           sets: rows(performed, stalled: stalled),
                           isCurrent: exerciseId == current,
                           canDrop: droppable)
        }
    }

    // The count is the sets the walk offered and could not land, never every queued set.
    public static func onThisDeviceLine(_ count: Int, stall: Stall?) -> String? {
        guard count > 0 else { return nil }
        let subject = count == 1 ? "1 set is" : "\(count) sets are"
        let why: String
        switch stall {
        case .none: why = "They flush when the log takes them."
        case .offline: why = "No signal down here — they flush when you’re back up."
        case .logFailed: why = "The log didn’t answer — they flush when it does."
        case .signInLapsed: why = "Your sign-in lapsed — they flush once you sign in again."
        }
        return "\(subject) saved on this device only. \(why)"
    }

    private static func meta(done: Int, planned: Int?) -> String {
        guard let planned else { return Readout.setCount(done) }
        return "\(done) of \(planned) sets"
    }
}
