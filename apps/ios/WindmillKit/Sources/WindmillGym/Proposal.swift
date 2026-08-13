import Foundation

// A CHANGE AN AGENT WANTS MADE, AND HAS NOT MADE — the native statement of
// backend/products/gym/domain/Proposal.h, and the object §D screen 14 draws.
//
// The rule the whole file exists to serve: a mutation that RECORDS something that already happened
// lands immediately at every door, and a mutation that changes something that WILL happen mints one
// of these and does nothing at all until the lifter taps Apply. "Log 100 × 5" is the first kind —
// the bar is already back on the rack and the blast radius is one legible row. Next Tuesday's bench
// is the second: it speaks to a tired future person in a room where the conversation that caused it
// is gone, and Apply is the only UI that decision will ever have.
//
// NOTHING HERE IS EVER WRITTEN FROM THIS DEVICE. The phone never mints a proposal, never keeps one
// on its shelf and never sends one — a proposal belongs to an ACCOUNT, so there is no anonymous
// half of this object and nothing for the claim replay to carry. That is why every type below is
// `Decodable` and not `Codable`: the one direction it travels is inward.
//
// THE ENUMS ARE CLOSED, and this is the one place in gym where a lenient default would not be
// honest. `SetKind(parsing:)` folds an unknown word to `working` because the SERVER has that same
// default; there is no such default here, and a row this build could not draw would be a row
// MISSING from a diff the lifter taps Apply on once, for all of it. So a word this build has never
// heard of fails the read and the room draws no card at all, rather than a partial truth with a
// button under it.

public enum ProposalIntent: String, Decodable, Sendable {
    case revise
    case remove
}

// The four states, and the room's own word for the fourth. The wire calls it `superseded`; on
// screen it is SET ASIDE, because the lifter superseded nothing — their own hand landed on the
// routine first, and this diff was written against a program that no longer stands.
public enum ProposalState: String, Decodable, Sendable {
    case pending
    case applied
    case dismissed
    case superseded

    public var word: String {
        switch self {
        case .pending: return "Pending"
        case .applied: return "Applied"
        case .dismissed: return "Dismissed"
        case .superseded: return "Set aside"
        }
    }
}

// WHICH DOOR IT CAME THROUGH, and which agent behind it. "A change appeared in my Tuesday and I
// cannot tell whether it was my own Claude or the app's own Ask" is the exact mental-model failure
// this column exists to prevent — so provenance is a field on every proposal rather than a fork in
// the object. The two doors mint the same type through the same mechanism; only this field differs.
//
// `door` stays a String where `state` and `kind` are closed enums, and the difference is what each
// one decides: a door this build has never heard of only picks which fallback name to print, while
// an unknown state or kind would put a wrong control or a missing row in front of a tap.
public struct ProposalSource: Equatable, Decodable, Sendable {
    public let door: String
    public let connection: String?
    public let agent: String?
    // THE CONVERSATION THIS CAME OUT OF (§O), and its ABSENCE is a fact rather than a gap: either
    // the change came through the MCP door, where there was no conversation, or the lifter deleted
    // the one it came from. Deleting a thread deletes the conversation and not the consequence — the
    // history row still says the change came from Ask, it just no longer opens something that is
    // gone. So the door onto it is offered only where this key is present, and never inferred from
    // `door == "ask"`.
    public let thread: String?

    public init(door: String, connection: String? = nil, agent: String? = nil,
                thread: String? = nil) {
        self.door = door
        self.connection = connection
        self.agent = agent
        self.thread = thread
    }

    // The wire OMITS `connection` and `agent` today — the MCP transport carries no identity for the
    // server to store — so this is a fallback in practice and not in theory. "your connected agent"
    // is the true thing to say about a name gym does not have; printing a vendor nobody read would
    // be worse than saying less.
    public var agentName: String {
        guard let agent, !agent.isEmpty else { return door == "ask" ? "Ask" : "your connected agent" }
        return agent
    }
}

// WHAT A CARD AND A HISTORY ROW ARE DRAWN FROM — everything except the diff itself, which is one
// more read away. The room holds a list of these and nothing else: `GET /v1/gym/proposals` answers
// every proposal on the account, newest first, and both the pending cards and every routine's
// history are folds over that one list.
public struct ProposalHead: Equatable, Decodable, Sendable, Identifiable {
    public let id: String
    public let routineId: String
    public let intent: ProposalIntent
    public let state: ProposalState
    public let summary: String
    public let changeCount: Int
    public let createdAtMs: Int64
    public let settledAtMs: Int64?
    public let source: ProposalSource

    public init(id: String, routineId: String, intent: ProposalIntent = .revise,
                state: ProposalState = .pending, summary: String = "", changeCount: Int = 0,
                createdAtMs: Int64, settledAtMs: Int64? = nil,
                source: ProposalSource = ProposalSource(door: "mcp")) {
        self.id = id
        self.routineId = routineId
        self.intent = intent
        self.state = state
        self.summary = summary
        self.changeCount = changeCount
        self.createdAtMs = createdAtMs
        self.settledAtMs = settledAtMs
        self.source = source
    }

    public var isPending: Bool { state == .pending }

    // What the card says when the agent wrote no summary. It is a count and a routine name rather
    // than an invented sentence: the agent's own words are the only voice allowed to describe its
    // own diff, and a room that made one up for it would be putting words in a mouth the lifter is
    // about to judge.
    public func line(about routineName: String) -> String {
        guard summary.isEmpty else { return summary }
        guard intent == .revise else { return "A proposal to remove \(routineName)." }
        return "\(changes) to \(routineName)."
    }

    public var reviewLabel: String {
        guard intent == .revise else { return "Review the removal" }
        return "Review \(changes)"
    }

    // What the routines list marks a routine with (§B screen 5). The board draws `1 proposal` and
    // this is a COUNT, because the ledger's rule is one pending proposal per door: two doors put two
    // on one routine, and a mark that said "1" over both would be the room miscounting the only
    // thing it is there to say.
    public static func waitingLine(_ count: Int) -> String {
        count == 1 ? "1 proposal" : "\(count) proposals"
    }

    // THE DAY THE RECORD IS ABOUT — the one the History row prints, and the one that section is
    // ordered by. A proposal written on Sunday and applied on Tuesday belongs to Tuesday in the
    // program's history, so the date and the order have to come off the same instant: read one way
    // and sorted the other, a list runs backwards.
    public var recordedAtMs: Int64 { settledAtMs ?? createdAtMs }

    // The routine's History row (§B screen 6): `2 Aug · applied 3 changes from Claude`.
    public func historyLine(now: Int64) -> String {
        let when = Readout.when(recordedAtMs, now: now)
        let what = intent == .revise ? changes : "a removal"
        switch state {
        case .pending: return "\(when) · \(what) from \(source.agentName), waiting"
        case .applied: return "\(when) · applied \(what) from \(source.agentName)"
        case .dismissed: return "\(when) · dismissed \(what) from \(source.agentName)"
        case .superseded: return "\(when) · set aside \(what) from \(source.agentName)"
        }
    }

    // `4 changes` — the count as a NOUN, for the two places that print it without a verb in front:
    // the review button's own label above, and the chip on the card Ask draws in its message stream.
    public var changes: String { Readout.changeCount(changeCount) }

    enum CodingKeys: String, CodingKey {
        case id, routineId, intent, state, summary, changeCount, source
        case createdAtMs = "createdAt"
        case settledAtMs = "settledAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        routineId = try fields.decode(String.self, forKey: .routineId)
        intent = try fields.decode(ProposalIntent.self, forKey: .intent)
        state = try fields.decode(ProposalState.self, forKey: .state)
        summary = try fields.decodeIfPresent(String.self, forKey: .summary) ?? ""
        changeCount = try fields.decodeIfPresent(Int.self, forKey: .changeCount) ?? 0
        createdAtMs = try fields.decode(Int64.self, forKey: .createdAtMs)
        settledAtMs = try fields.decodeIfPresent(Int64.self, forKey: .settledAtMs)
        // A door is the least this can carry and the server always sends one; an answer without it
        // still names the agent the only way this room ever could.
        source = try fields.decodeIfPresent(ProposalSource.self, forKey: .source)
            ?? ProposalSource(door: "")
    }
}

// ONE LINE OF THE DIFF. The rows are the document as well as the diff: rows up to the first
// `removed` are the run the routine would take on, in order, and the rest are what it would take
// away. `before` is absent on an added row, `after` on a removed one, and `loggedSets` rides only
// on a removed one — where 0 is a real answer and not a missing field.
public struct ProposalChange: Equatable, Decodable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case kept
        case added
        case removed
        case retargeted
    }

    // What a routine asks a movement for. The same three numbers `RoutineEntry` carries, under the
    // names the proposal wire uses — absent reps is `max`, absent weight is whatever you did last
    // time, absent rest is the global target, and absent SETS is the open row (§M): the routine
    // names nothing and the movement is decided at the rack.
    //
    // WHICH SIDE OF A DIFF IS MISSING IS `kind` AND NEVER AN ABSENT `sets`. `added` has no `before`
    // and `removed` has no `after`; a reader that inferred the side from a null set count would
    // read `+ Deadlift · open` as a line with nothing added to it.
    public struct Targets: Equatable, Decodable, Sendable {
        public let sets: Int?
        public let reps: Int?
        public let weightKg: Double?
        public let restSeconds: Int?

        public init(sets: Int? = nil, reps: Int? = nil, weightKg: Double? = nil,
                    restSeconds: Int? = nil) {
            self.sets = sets
            self.reps = reps
            self.weightKg = weightKg
            self.restSeconds = restSeconds
        }
    }

    // One field that moved, spelled both ways. Drawn as `sets 5 × 5 → 5 × 3` (§D14).
    public struct Move: Equatable, Sendable {
        public let field: String
        public let before: String
        public let after: String
    }

    public let position: Int
    public let kind: Kind
    public let exerciseId: String
    public let before: Targets?
    public let after: Targets?
    public let loggedSets: Int?

    public init(position: Int, kind: Kind, exerciseId: String,
                before: Targets? = nil, after: Targets? = nil, loggedSets: Int? = nil) {
        self.position = position
        self.kind = kind
        self.exerciseId = exerciseId
        self.before = before
        self.after = after
        self.loggedSets = loggedSets
    }

    // THE FIELD-LEVEL ROWS, and sets and reps are ONE move rather than two: `5 × 5` is how this
    // product says what a movement is asked for on every other screen, and splitting it would put
    // two lines on screen for one decision. A target the proposal declines to name prints the
    // product's own mark for a fact it does not have.
    public var moves: [Move] {
        guard let before, let after else { return [] }
        var moved: [Move] = []
        if before.sets != after.sets || before.reps != after.reps {
            // A side with no set count is the OPEN row (§M) — the routine names nothing at all —
            // and it prints that one word rather than a count of nothing. `Readout.target` carries
            // no weight here on purpose: the load is its own row two lines down, and naming it
            // twice would be one decision drawn as two.
            moved.append(Move(field: "sets",
                              before: Readout.target(sets: before.sets, reps: before.reps,
                                                     weightKg: nil),
                              after: Readout.target(sets: after.sets, reps: after.reps,
                                                    weightKg: nil)))
        }
        if before.weightKg != after.weightKg {
            moved.append(Move(field: "weight",
                              before: before.weightKg.map(Readout.weight) ?? "—",
                              after: after.weightKg.map(Readout.weight) ?? "—"))
        }
        if before.restSeconds != after.restSeconds {
            moved.append(Move(field: "rest",
                              before: before.restSeconds.map { Readout.clock(Int64($0) * 1000) } ?? "—",
                              after: after.restSeconds.map { Readout.clock(Int64($0) * 1000) } ?? "—"))
        }
        return moved
    }

    // `added · 3 × 10 · 24 · after Bench Press` — the PLACE is part of the change, because a
    // movement arriving third is a different program from the same movement arriving first.
    public func addedLine(after previous: String?) -> String {
        var said = ["added"]
        if let after { said.append(Readout.target(sets: after.sets, reps: after.reps, weightKg: after.weightKg)) }
        said.append(previous.map { "after \($0)" } ?? "first in the routine")
        return said.joined(separator: " · ")
    }

    // `removed from the routine · 41 logged sets kept`. The count is what the removal DOES NOT
    // touch, and zero is a real answer rather than a missing one — a movement removed before it was
    // ever trained says so instead of pretending the reassurance applies.
    public var removedLine: String {
        guard let loggedSets else { return "removed from the routine" }
        guard loggedSets > 0 else { return "removed from the routine · never logged" }
        let sets = loggedSets == 1 ? "1 logged set" : "\(loggedSets) logged sets"
        return "removed from the routine · \(sets) kept"
    }

    enum CodingKeys: String, CodingKey {
        case position, kind, exerciseId, before, after, loggedSets
    }
}

// WHAT SCREEN 14 DRAWS, top to bottom. A `kept` row is the document and never a change, so it is
// not here; a renamed routine IS a change and is, because the count under the button includes it
// and a diff whose rows did not add up to its own button would be the worst kind of quiet lie.
public enum ProposalRow: Equatable, Sendable {
    case renamed(from: String, to: String)
    // `follows` is the movement this entry would come after, and it is read only on an added row —
    // the one row whose position is a fact the lifter has to be told.
    case entry(ProposalChange, follows: String?)
}

// THE WHOLE PROPOSAL: the head, the base it was written against, and the typed diff. `baseRevision`
// is the token apply is atomic against — a proposal minted before a human's own edit is set aside
// rather than merged over the top — and this device never checks it: only the server sees both
// halves at once, under the lock that owns them.
public struct Proposal: Equatable, Decodable, Sendable, Identifiable {
    public let head: ProposalHead
    public let baseRevision: Int
    public let baseName: String
    public let name: String
    public let changes: [ProposalChange]

    public init(head: ProposalHead, baseRevision: Int, baseName: String,
                name: String, changes: [ProposalChange]) {
        self.head = head
        self.baseRevision = baseRevision
        self.baseName = baseName
        self.name = name
        self.changes = changes
    }

    public var id: String { head.id }
    public var routineId: String { head.routineId }
    public var intent: ProposalIntent { head.intent }
    public var state: ProposalState { head.state }

    public var rows: [ProposalRow] {
        var drawn: [ProposalRow] = []
        if name != baseName { drawn.append(.renamed(from: baseName, to: name)) }
        for change in changes where change.kind != .kept {
            let previous = change.position > 1
                ? changes.first { $0.position == change.position - 1 }?.exerciseId
                : nil
            drawn.append(.entry(change, follows: previous))
        }
        return drawn
    }

    // THE COUNT IS THE SERVER'S AND NEVER THE ROWS THIS BUILD MANAGED TO DRAW. The button states
    // what the tap DOES, and apply is atomic against the whole document — so a build that drew four
    // of five rows must still not promise to apply four. That is the same rule the tool names live
    // under: never promise an effect you do not have.
    public var applyLabel: String {
        guard intent == .revise else { return "Remove \(baseName)" }
        return "Apply all \(head.changeCount)"
    }

    // "All four or none. Nothing is applied until you tap." The count is a WORD here and a NUMERAL
    // on the button, because one is a sentence and the other is a control.
    public var footnote: String {
        guard intent == .revise else {
            return "The routine goes and your logged sets stay. Nothing is removed until you tap."
        }
        guard head.changeCount > 1 else { return "Nothing is applied until you tap." }
        return "All \(Proposal.spelled(head.changeCount)) or none. Nothing is applied until you tap."
    }

    // Settled states say so with a timestamp and STAY — the program's history, not a toast that
    // disappears. A superseded one explains itself, because "set aside" is the only outcome here
    // that the lifter did not choose.
    public func settledNote(now: Int64) -> String? {
        guard let settledAtMs = head.settledAtMs else { return nil }
        let when = "\(Readout.when(settledAtMs, now: now)) at \(Readout.time(settledAtMs))"
        switch state {
        case .pending:
            return nil
        case .applied:
            return "Applied to \(baseName) \(when). Kept on the routine as a dated record — the program’s history, not a toast that disappears."
        case .dismissed:
            return "Dismissed \(when). No reason asked for, nothing changed, and it stays in the routine’s history in case you want it back."
        case .superseded:
            return "\(baseName) changed after this was written, so it was set aside \(when). None of it was applied, and it stays in the routine’s history."
        }
    }

    // Prose stops spelling numbers where the word stops being easier to read than the digit.
    private static func spelled(_ count: Int) -> String {
        let words = ["two", "three", "four", "five", "six", "seven",
                     "eight", "nine", "ten", "eleven", "twelve"]
        guard count >= 2, count - 2 < words.count else { return String(count) }
        return words[count - 2]
    }

    enum CodingKeys: String, CodingKey {
        case baseRevision, baseName, name, changes
    }

    // The head's fields are on the SAME flat object, so it is decoded from the same container
    // rather than repeated field for field — one wire shape, one statement of it.
    public init(from decoder: Decoder) throws {
        head = try ProposalHead(from: decoder)
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        baseRevision = try fields.decodeIfPresent(Int.self, forKey: .baseRevision) ?? 0
        baseName = try fields.decodeIfPresent(String.self, forKey: .baseName) ?? ""
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        changes = try fields.decodeIfPresent([ProposalChange].self, forKey: .changes) ?? []
    }
}

// What an applied proposal answers with. The routine is ABSENT when the intent was to remove —
// there is no routine left to describe — which is the shape rather than a null.
public struct AppliedProposal: Equatable, Decodable, Sendable {
    public let proposal: Proposal
    public let routine: Routine?

    public init(proposal: Proposal, routine: Routine? = nil) {
        self.proposal = proposal
        self.routine = routine
    }

    enum CodingKeys: String, CodingKey {
        case proposal, routine
    }
}
