import Foundation

// A draft is savable while incomplete: a row with no target is `open` and asks at the rack.

public struct RoutineDraft: Equatable {
    // Sixty characters, the cap web and Android draw too, and the only bound a name has. A character
    // is a CODE POINT here — the unit Postgres `char_length` counts, and the unit the other two
    // surfaces count — never a grapheme cluster, which `String.count` gives and which no number of
    // bytes bounds. Sixty code points weigh at most 240 bytes, exactly the store's ceiling, so a name
    // this client accepts is a name the store takes and nothing here counts bytes.
    public static let maxNameLength = 60

    // A counter is chrome a short name never carries: it appears in the last fifth of the cap and is
    // silent before that — the same rule and the same fifth as the note editor's title counter
    // (`Notes.counterFromCharacters`), because a lifter should not have to learn two rules for the
    // same idea.
    public static let counterFromCharacters = 48

    // Why Save is grey, one at a time and never concatenated. The name comes first because there is
    // no screen in front of the editor that could have asked for one (`Program.missing` is the twin).
    public static let nameItToSaveIt = "Name it to save it."
    public static let atLeastOneMovement = "A routine is at least one movement."

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

    // nil below the threshold: nothing is drawn.
    public static func counter(_ name: String) -> String? {
        let used = name.unicodeScalars.count
        guard used >= counterFromCharacters else { return nil }
        return "\(used)/\(maxNameLength)"
    }

    // Cut at the cap and always on a whole code point. Applied where a name is typed, never to one that arrived.
    public static func capped(_ typed: String) -> String {
        String(String.UnicodeScalarView(typed.unicodeScalars.prefix(maxNameLength)))
    }

    // The log refuses a blank name; everything else may be left open.
    public var isNamed: Bool { !trimmedName.isEmpty }

    public var isSavable: Bool { isNamed && !lines.isEmpty }

    // What the draft is still missing, one at a time and in the order the editor meets it; nil once
    // Save can be pressed. Drawn under the name field, which is where the first of the two is fixed.
    public var saveRefusal: String? {
        if !isNamed { return Self.nameItToSaveIt }
        if lines.isEmpty { return Self.atLeastOneMovement }
        return nil
    }

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

public enum RoutineReadout {
    // The count is today's; the history row's is the one it was created with.
    public static func meta(_ routine: Routine, now: Int64) -> String {
        let movements = routine.entries.count == 1 ? "1 movement" : "\(routine.entries.count) movements"
        guard let created = routine.history.last(where: { $0.kind == .created }) else { return movements }
        return "built \(Readout.when(created.atMs, now: now)) · \(movements)"
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
