import Foundation

// A draft is savable while incomplete: a row with no target is `open` and asks at the rack.

public struct RoutineDraft: Equatable {
    // Sixty characters is what the counter shows; eighty bytes is the column's cap and the one that refuses a save.
    public static let maxNameLength = 60
    public static let maxNameBytes = 80

    public static let suggestions = ["Push C", "Lower B", "Thursday"]

    // Where a row with no target at all opens. There is no opening weight: an absent one means whatever you did last time.
    public static let openingSets = 3
    public static let openingReps = 5

    // The wire's own bounds, restated where the steppers move.
    public static let setsRange = 1...20
    public static let repsRange = 1...100

    // Identity is neither the place nor the movement: a routine may name one movement twice. The id never leaves this device.
    public struct Line: Equatable, Identifiable {
        public let id: String
        public var entry: RoutineWrite.Entry

        public init(_ entry: RoutineWrite.Entry, id: String = UUID().uuidString) {
            self.id = id
            self.entry = entry
        }
    }

    public let id: String
    public var name: String
    public var lines: [Line]
    // Absent for a routine being made: a replace may not renumber the position the log gave it.
    public let position: Int

    public init(id: String = Ids.routine(), name: String = "",
                entries: [RoutineWrite.Entry] = [], position: Int) {
        self.id = id
        self.name = name
        self.lines = entries.map { Line($0) }
        self.position = position
    }

    // The id and the position travel unchanged: a replace writes over this row.
    public init(editing routine: Routine) {
        self.init(id: routine.id, name: routine.name,
                  entries: RoutineWrite(routine).entries, position: routine.position)
    }

    // The day as it stands on screen, unsaved edits included, under a new id.
    public init(duplicating draft: RoutineDraft, position: Int) {
        self.init(name: draft.name, entries: draft.entries, position: position)
    }

    public var entries: [RoutineWrite.Entry] { lines.map(\.entry) }

    public var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // The denominator is whichever cap binds: characters, or the bytes the column counts.
    public static func counter(_ name: String) -> String {
        let full = capped(name + "a").count == name.count
        return "\(name.count)/\(full ? name.count : maxNameLength)"
    }

    // Cut to whichever bound runs out first, always on a character. Applied where a name is typed, never to one that arrived.
    public static func capped(_ typed: String) -> String {
        var kept = String(typed.prefix(maxNameLength))
        while kept.utf8.count > maxNameBytes { kept.removeLast() }
        return kept
    }

    // The log refuses a blank name; everything else may be left open.
    public var isNamed: Bool { !trimmedName.isEmpty }

    public var isSavable: Bool { isNamed && !lines.isEmpty }

    public var write: RoutineWrite {
        RoutineWrite(id: id, name: trimmedName, position: position, entries: entries)
    }

    public func place(of lineId: String) -> String {
        guard let place = lines.firstIndex(where: { $0.id == lineId }) else { return trimmedName }
        return "\(place + 1) of \(lines.count) · \(isNamed ? trimmedName : "this routine")"
    }

    public func line(_ lineId: String) -> Line? {
        lines.first { $0.id == lineId }
    }

    @discardableResult
    public mutating func add(_ exerciseId: String) -> Line {
        let made = Line(RoutineWrite.Entry(exerciseId: exerciseId))
        lines.append(made)
        return made
    }

    // Absent reps is `3 × max` and absent weight is whatever you did last time. Rest is untouched.
    public mutating func set(_ lineId: String, sets: Int, reps: Int?, weightKg: Double?) {
        edit(lineId) { entry in
            RoutineWrite.Entry(exerciseId: entry.exerciseId, targetSets: sets, targetReps: reps,
                               targetWeightKg: weightKg, restSeconds: entry.restSeconds)
        }
    }

    // Clears the whole row, not just the set count: the server refuses the half-open line.
    public mutating func leaveOpen(_ lineId: String) {
        edit(lineId) { RoutineWrite.Entry(exerciseId: $0.exerciseId, restSeconds: $0.restSeconds) }
    }

    public mutating func remove(_ lineId: String) {
        lines.removeAll { $0.id == lineId }
    }

    public mutating func move(from source: IndexSet, to destination: Int) {
        lines.move(fromOffsets: source, toOffset: destination)
    }

    private mutating func edit(_ lineId: String,
                               _ rewrite: (RoutineWrite.Entry) -> RoutineWrite.Entry) {
        guard let place = lines.firstIndex(where: { $0.id == lineId }) else { return }
        lines[place].entry = rewrite(lines[place].entry)
    }
}

public struct RoutineTarget: Equatable {
    public var sets: Int
    // Both may be absent and the absence is the instruction: no rep target is `3 × max`, no weight is last time's.
    public var reps: Int?
    public var weightKg: Double?

    // Only the fully open row opens on the draft's opening pair, and not even that row is given a weight.
    public init(_ entry: RoutineWrite.Entry) {
        guard let named = entry.targetSets else {
            sets = RoutineDraft.openingSets
            reps = RoutineDraft.openingReps
            weightKg = nil
            return
        }
        sets = named
        reps = entry.targetReps
        weightKg = entry.targetWeightKg
    }

    // Sets and reps clamp into the wire's range rather than holding, so a number from outside it climbs back in.
    public mutating func bumpSets(_ direction: Int) {
        sets = min(RoutineDraft.setsRange.upperBound,
                   max(RoutineDraft.setsRange.lowerBound, sets + direction))
    }

    // From `max`, either key lands on the opening value.
    public mutating func bumpReps(_ direction: Int) {
        guard let named = reps else {
            reps = RoutineDraft.openingReps
            return
        }
        reps = min(RoutineDraft.repsRange.upperBound, Ladder.bumpReps(named, direction: direction))
    }

    // What the four keys are drawn against while the row names no weight, and where the first tap lands.
    public var ladderWeight: Double { weightKg ?? Prefill.emptyBarKg }

    // The same `Ladder` as the rack, pinned by packages/api-contract/gym-ladder.json.
    public mutating func bump(direction: Int, big: Bool) {
        guard weightKg != nil else {
            weightKg = ladderWeight
            return
        }
        weightKg = Ladder.bump(weight: ladderWeight, direction: direction, big: big)
    }

    public var commitLine: String {
        "Set · \(Readout.target(sets: sets, reps: reps, weightKg: weightKg))"
    }
}

public enum RoutineReadout {
    // The count is today's; the history row's is the one it was created with.
    public static func meta(_ routine: Routine, now: Int64) -> String {
        let movements = routine.entries.count == 1 ? "1 movement" : "\(routine.entries.count) movements"
        guard let created = routine.history.last(where: { $0.kind == .created }) else { return movements }
        return "built \(Readout.when(created.atMs, now: now)) · \(movements)"
    }

    public static func openRows(_ routine: Routine, in catalog: [Exercise]) -> String? {
        let open = routine.entries.filter(\.isOpen)
        guard let only = open.first else { return nil }
        guard open.count == 1 else {
            return "\(open.count) movements have no target — they will ask at the rack."
        }
        return "\(Readout.movement(only.exerciseId, in: catalog)) has no target — it will ask at the rack."
    }

    // No door named means the lifter's own hand.
    public static func created(_ event: RoutineEvent) -> String {
        var said = [Readout.date(event.atMs)]
        said.append(event.by.map { "created by \(ProposalSource(door: $0).agentName)" } ?? "created by you")
        // Absent where the log never counted; the row then says less rather than borrowing today's count.
        if let movements = event.movements {
            said.append(movements == 1 ? "1 movement" : "\(movements) movements")
        }
        return said.joined(separator: " · ")
    }
}
