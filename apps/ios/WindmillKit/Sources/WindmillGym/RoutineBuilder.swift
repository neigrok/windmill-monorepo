import Foundation

// BUILDING A ROUTINE BEFORE YOU GO (§M) — the third of the three doors onto one routine, and the
// one a lifter with a program in a notebook reaches for first. The other two already exist and
// neither is replaced: a routine falls out of a session you already did (the finish screen's offer),
// or an agent proposes one (the diff). This is the Sunday-night door.
//
// It is a DRAFT and not a wizard: no step counter, no template gallery, no "choose your split", no
// weekly calendar. A routine is a list with a name; a week is a thing lifters keep in their head.
//
// THE ORDER IS NAME, THEN MOVEMENTS, THEN TARGETS, and the first of those is a real question asked
// once — a routine you built on purpose deserves the word you call it, not "Workout 3". The targets
// come last, in a sheet over the list, so the shape of the day stays visible while numbers are typed
// into it.
//
// A DRAFT IS SAVABLE WHILE INCOMPLETE. A row with no target is `open` and asks at the rack, which is
// what lets a program be copied in over two sittings — and it is why nothing here has a "finish
// setting this up" state to be stuck in.

public struct RoutineDraft: Equatable {
    // THE CLIENT'S CAP, IN THE TWO UNITS THAT BIND IT, because they are not the same unit and only
    // one of them is visible. Sixty CHARACTERS is the board's bound and the one a lifter watching
    // the counter can check; eighty BYTES is the column's (domain/Training.h), and it is the one
    // that actually refuses a save. A forty-five-letter Cyrillic name is ninety bytes: a client
    // counting only characters would draw `45/60`, take the tap, and come back "routine name too
    // long" from a log the lifter cannot argue with. So the field stops before the log has to.
    public static let maxNameLength = 60
    public static let maxNameBytes = 80

    // THE SUGGESTIONS, and they are suggestions and never rules. Tapping one fills the field and
    // typing over it is the expected case — a lifter who calls it "the slanty one day" is right and
    // this list is wrong. They are a shortcut past an empty field, not a vocabulary.
    public static let suggestions = ["Push C", "Lower B", "Thursday"]

    // WHERE A ROW WITH NO TARGET AT ALL OPENS, and the pair is a starting point to type over rather
    // than a guess dressed as a fact: three of five is the opening of nearly every barbell program
    // there is, it is on screen, and one tap moves it. Nothing here reaches for last time — a
    // routine built at home has no history to reach into, which the sheet says out loud over a
    // routine nobody has trained. The web opens on the same two (`NEW_ENTRY_SETS` · `NEW_ENTRY_REPS`),
    // because a lifter's Sunday may not differ by surface.
    //
    // THERE IS NO OPENING WEIGHT, deliberately: a load nobody has ever lifted is the one number this
    // sheet may not invent, and "whatever you did last time" is what an absent one already means.
    public static let openingSets = 3
    public static let openingReps = 5

    // The wire's own bounds, restated where the steppers move. A tap that produced a number the log
    // refuses would be an affordance the product cannot honour.
    public static let setsRange = 1...20
    public static let repsRange = 1...100

    // ONE LINE OF THE DRAFT, under an identity that is NOT its place in the list and NOT the
    // movement it names. A routine may name one movement twice — bench heavy then bench back-off —
    // so the movement cannot be the key; and a place-keyed list is a list whose rows swap identity
    // under a drag, and whose open sheet points at whichever row moved into that slot. The id never
    // leaves this device: it is gone the moment the draft is written.
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
    // Absent for a routine being made, present for one being edited — the position the log already
    // gave it, which a replace may not renumber.
    public let position: Int

    public init(id: String = Ids.routine(), name: String = "",
                entries: [RoutineWrite.Entry] = [], position: Int) {
        self.id = id
        self.name = name
        self.lines = entries.map { Line($0) }
        self.position = position
    }

    // EDIT — the same draft, seeded off the routine as the log holds it. The id and the position
    // travel unchanged, because a replace writes over this row and a fresh id would leave the old
    // routine standing beside it.
    public init(editing routine: Routine) {
        self.init(id: routine.id, name: routine.name,
                  entries: RoutineWrite(routine).entries, position: routine.position)
    }

    // DUPLICATE — the movements and their targets, under a NEW id, and the name goes back through
    // screen 28. A copy is a new routine and a new routine gets named: seeding the field with the
    // one it was copied from is a starting point to type over, which is what every suggestion on
    // that screen is.
    public init(duplicating routine: Routine, position: Int) {
        self.init(name: routine.name, entries: RoutineWrite(routine).entries, position: position)
    }

    public var entries: [RoutineWrite.Entry] { lines.map(\.entry) }

    public var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // What a name field's counter reads — `14/60`, over the CHARACTERS a person sees rather than the
    // bytes the column counts. A name in any script counts the way it looks on screen, which is the
    // only count a lifter watching the number can check. Static because three fields draw one:
    // screen 28's, screen 31's and the rename sheet's.
    //
    // THE DENOMINATOR IS THE CAP THAT BINDS, and in a script of two-byte letters that is not sixty:
    // the column fills at forty of them, and a counter still climbing toward sixty would be
    // promising room the store does not have. Asked of the name with one more letter on it, so the
    // two bounds are read the one way they are applied.
    public static func counter(_ name: String) -> String {
        let full = capped(name + "a").count == name.count
        return "\(name.count)/\(full ? name.count : maxNameLength)"
    }

    // THE NAME AS IT CAN ACTUALLY BE SAVED, cut to whichever bound runs out first. The cut lands on
    // a CHARACTER and never inside one — half a letter is bytes that are not a letter, and the
    // column refuses those outright rather than storing the head of somebody's word.
    //
    // It is applied where a name is TYPED, on all three fields, so nothing longer is ever on screen
    // to be tapped Save on. A name that ARRIVED longer — from the web, from an agent, from before
    // this bound existed — is drawn and counted as it stands and only fresh typing is bounded.
    public static func capped(_ typed: String) -> String {
        var kept = String(typed.prefix(maxNameLength))
        while kept.utf8.count > maxNameBytes { kept.removeLast() }
        return kept
    }

    // A name is the ONE thing a routine cannot be saved without: the log refuses a blank, and the
    // whole of screen 28 is asking for it. Everything else about a draft may be left open.
    public var isNamed: Bool { !trimmedName.isEmpty }

    public var isSavable: Bool { isNamed && !lines.isEmpty }

    public var write: RoutineWrite {
        RoutineWrite(id: id, name: trimmedName, position: position, entries: entries)
    }

    // The sheet's own header — `2 of 4 · Heavy Thursday`. It is where you are in the day rather than
    // a step counter for the flow: there is no flow to count, and a lifter may open any row. A line
    // that has since been dropped is not in the list at all, and the sheet over it draws nothing.
    public func place(of lineId: String) -> String {
        guard let place = lines.firstIndex(where: { $0.id == lineId }) else { return trimmedName }
        return "\(place + 1) of \(lines.count) · \(isNamed ? trimmedName : "this routine")"
    }

    public func line(_ lineId: String) -> Line? {
        lines.first { $0.id == lineId }
    }

    // Answers the line it made, because the caller opens the target sheet on it — a screen that
    // reached for "the last one" would be reading the list a frame after a drag moved it.
    @discardableResult
    public mutating func add(_ exerciseId: String) -> Line {
        let made = Line(RoutineWrite.Entry(exerciseId: exerciseId))
        lines.append(made)
        return made
    }

    // The target sheet, committed. Sets, reps and weight arrive together because the sheet holds all
    // three and knows what the row should now read — "unchanged" has no second spelling here to get
    // wrong. Two of the three may arrive ABSENT and the absence is the answer: no reps is `3 × max`
    // and no weight is "whatever you did last time". Rest is untouched: this wave draws no rest
    // control, and a replace that dropped what an agent or the web had set would be deleting a field
    // nobody asked about.
    public mutating func set(_ lineId: String, sets: Int, reps: Int?, weightKg: Double?) {
        edit(lineId) { entry in
            RoutineWrite.Entry(exerciseId: entry.exerciseId, targetSets: sets, targetReps: reps,
                               targetWeightKg: weightKg, restSeconds: entry.restSeconds)
        }
    }

    // `Leave it open` — and it clears the WHOLE row, not just the set count. The server refuses the
    // half-open line, and a row that kept its reps would be saying "5 reps of nothing" on every
    // screen that draws it.
    public mutating func leaveOpen(_ lineId: String) {
        edit(lineId) { RoutineWrite.Entry(exerciseId: $0.exerciseId, restSeconds: $0.restSeconds) }
    }

    public mutating func remove(_ lineId: String) {
        lines.removeAll { $0.id == lineId }
    }

    public mutating func move(from source: IndexSet, to destination: Int) {
        lines.move(fromOffsets: source, toOffset: destination)
    }

    // Both writes find their line the same way, and a line that is no longer there is a write
    // that has nothing to land on rather than a crash: the sheet over a dropped row simply does
    // nothing.
    private mutating func edit(_ lineId: String,
                               _ rewrite: (RoutineWrite.Entry) -> RoutineWrite.Entry) {
        guard let place = lines.firstIndex(where: { $0.id == lineId }) else { return }
        lines[place].entry = rewrite(lines[place].entry)
    }
}

// THE NUMBERS IN THE TARGET SHEET while a thumb is moving them. It is a value and not a view state
// so the two steppers, the ladder and the button's own label read one number — and so the bounds
// live where the numbers are minted rather than only on the buttons that move them.
public struct RoutineTarget: Equatable {
    public var sets: Int
    // BOTH OF THESE MAY BE ABSENT AND THE ABSENCE IS AN INSTRUCTION, which is why they are held the
    // way the wire holds them rather than as numbers with a default underneath. No rep target is
    // `3 × max`, a movement taken to whatever it gives that day; no weight is "whatever you did last
    // time", which the prefill answers at the rack off this lifter's own log. A sheet that opened
    // them on numbers would WRITE those numbers the moment `Set` was tapped — an agent's chin-up
    // line, opened out of curiosity, would come back five reps of twenty kilos — and inventing a
    // target is the one thing this screen exists not to do. Only a set count is always named: a row
    // that names none is `open`, and `Leave it open` is how a row goes back to it.
    public var reps: Int?
    public var weightKg: Double?

    // OPENED ON WHAT THE ROW ALREADY SAYS. Only the fully open row — no sets, and therefore no reps
    // and no weight either — opens on numbers, and they are the draft's opening pair rather than a
    // prefill: a routine built at home has no history to prefill from, which is the rule this sheet
    // exists to keep and which it says out loud over a routine nobody has trained. Not even that row
    // is given a weight, because a load nobody has lifted is the invention that line is about.
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

    // The two steppers. Sets and reps move by one and CLAMP INTO the wire's range rather than
    // holding at the value — a draft rehydrated with a number from outside it climbs back in on
    // whichever button the thumb finds first, which is `Ladder.bumpReps`'s own rule one field over.
    public mutating func bumpSets(_ direction: Int) {
        sets = min(RoutineDraft.setsRange.upperBound,
                   max(RoutineDraft.setsRange.lowerBound, sets + direction))
    }

    // FROM `max`, EITHER KEY LANDS ON THE OPENING VALUE rather than one either side of it: the first
    // tap is choosing to have a rep target at all, not moving one that is already there.
    public mutating func bumpReps(_ direction: Int) {
        guard let named = reps else {
            reps = RoutineDraft.openingReps
            return
        }
        reps = min(RoutineDraft.repsRange.upperBound, Ladder.bumpReps(named, direction: direction))
    }

    // What the four keys are drawn AGAINST while the row names no weight. The bands are a function
    // of a number, so an absent load still needs one to read them off, and it is the empty bar — the
    // product's own statement that nothing is known. The labels a lifter reads are therefore the
    // ones the first tap uses, because the tap lands on this same number.
    public var ladderWeight: Double { weightKg ?? Prefill.emptyBarKg }

    // IT IS THE SAME LADDER AS THE RACK. The bands, the boundary rule and the rounding are
    // `Ladder`'s, pinned across three languages by packages/api-contract/gym-ladder.json — a second
    // stepper written here would be a fourth copy with no golden behind it, and a target typed on
    // Sunday would step differently from the same weight on Thursday.
    public mutating func bump(direction: Int, big: Bool) {
        guard weightKg != nil else {
            weightKg = ladderWeight
            return
        }
        weightKg = Ladder.bump(weight: ladderWeight, direction: direction, big: big)
    }

    // `Set · 3 × 5 · 140`, `Set · 3 × max`, `Set · 5 × 5` — what the button commits, spelled by the
    // one place gym spells a target, so the button and the row it will become read the same line.
    public var commitLine: String {
        "Set · \(Readout.target(sets: sets, reps: reps, weightKg: weightKg))"
    }
}

// WHAT SCREEN 30 SAYS ABOUT A ROUTINE, decided outside a view body. Every line here is read off the
// routine and its history; nothing is a constant and nothing is a guess.
public enum RoutineReadout {
    // `built today · 4 movements`. The day comes from the history's own `created` row — the one row
    // that is always there — so a routine the log has never heard of (still on this device's shelf,
    // still owed to a claim) simply counts its movements and says nothing about when it was built.
    //
    // THE COUNT IS TODAY'S and the history row's is the one it was CREATED with, which is why they
    // are drawn in two places and never swapped: this line describes the routine in front of you,
    // and the history row describes the day it was written.
    public static func meta(_ routine: Routine, now: Int64) -> String {
        let movements = routine.entries.count == 1 ? "1 movement" : "\(routine.entries.count) movements"
        guard let created = routine.history.last(where: { $0.kind == .created }) else { return movements }
        return "built \(Readout.when(created.atMs, now: now)) · \(movements)"
    }

    // THE FACT ABOUT THE OPEN ROWS, and it is a fact about this lifter's training rather than an
    // explanation of why we allow them: the routine names no target for these, so they will ask when
    // the lifter is standing at the rack. One open row is NAMED, because a name is the useful thing
    // to know; several are counted, because a routine may hold fifty and a list of them would push
    // the movements it is about off the screen.
    //
    // No open rows, no sentence. There is nothing to say and this product does not fill the space.
    public static func openRows(_ routine: Routine, in catalog: [Exercise]) -> String? {
        let open = routine.entries.filter(\.isOpen)
        guard let only = open.first else { return nil }
        guard open.count == 1 else {
            return "\(open.count) movements have no target — they will ask at the rack."
        }
        return "\(Readout.movement(only.exerciseId, in: catalog)) has no target — it will ask at the rack."
    }

    // `9 Aug · created by you · 4 movements`, and the middle of it is composed from an ABSENCE: no
    // door named means the lifter's own hand. An agent that typed the day names itself instead, and
    // "by you" over that would be putting words in a lifter's mouth.
    public static func created(_ event: RoutineEvent) -> String {
        var said = [Readout.date(event.atMs)]
        said.append(event.by.map { "created by \(ProposalSource(door: $0).agentName)" } ?? "created by you")
        // Absent for every routine written before the log started counting. The row says less rather
        // than borrowing the number of movements it holds today, which is a different fact.
        if let movements = event.movements {
            said.append(movements == 1 ? "1 movement" : "\(movements) movements")
        }
        return said.joined(separator: " · ")
    }
}
