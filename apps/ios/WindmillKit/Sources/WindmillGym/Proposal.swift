import Foundation

// The native statement of backend/products/gym/domain/Proposal.h; every type here is `Decodable` only — a proposal is
// never written from this device.
// The enums are closed with no lenient default: an unknown word must fail the read rather than drop a row from a diff.

public enum ProposalIntent: String, Decodable, Sendable {
    case revise
    case remove
}

// The wire calls the fourth `superseded`; on screen it is set aside.
public enum ProposalState: String, Decodable, Sendable {
    case pending
    case applied
    case dismissed
    case superseded

    public var word: String {
        switch self {
        case .pending: return "Pending"
        case .applied: return "Applied"
        case .dismissed: return "Turned down"
        case .superseded: return "Set aside"
        }
    }
}

// `door` stays a String where `state` and `kind` are closed enums: an unknown door only picks a fallback name.
public struct ProposalSource: Equatable, Decodable, Sendable {
    public let door: String
    public let connection: String?
    public let agent: String?
    // nil is a fact, not a gap: there was no conversation, or it was deleted. Never inferred from `door == "ask"`.
    public let thread: String?

    public init(door: String, connection: String? = nil, agent: String? = nil,
                thread: String? = nil) {
        self.door = door
        self.connection = connection
        self.agent = agent
        self.thread = thread
    }

    // A connection's name counts as the agent's name, for the byline and the kicker alike.
    public var named: String? {
        [agent, connection].compactMap { $0 }.first { !$0.isEmpty }
    }

    public var agentName: String {
        guard let named else { return door == "ask" ? "Coach" : "your connected agent" }
        return named
    }
}

// `GET /v1/gym/proposals` answers every proposal on the account, newest first.
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

    public func line(about routineName: String) -> String {
        guard summary.isEmpty else { return summary }
        guard intent == .revise else { return "A proposal to remove \(routineName)." }
        return "\(changes) to \(routineName)."
    }

    // A count: the ledger keeps one pending proposal per door, so two doors put two on one routine.
    public static func waitingLine(_ count: Int) -> String {
        count == 1 ? "1 proposal" : "\(count) proposals"
    }

    // The date and the History order come off the same instant: a settled proposal belongs to the day it settled.
    public var recordedAtMs: Int64 { settledAtMs ?? createdAtMs }

    public func historyLine(now: Int64) -> String {
        let when = Readout.when(recordedAtMs, now: now)
        let what = intent == .revise ? changes : "a removal"
        switch state {
        case .pending: return "\(when) · \(what) from \(source.agentName), waiting"
        case .applied: return "\(when) · applied \(what) from \(source.agentName)"
        case .dismissed: return "\(when) · turned down \(what) from \(source.agentName)"
        case .superseded: return "\(when) · set aside \(what) from \(source.agentName)"
        }
    }

    public var changes: String { Readout.changeCount(changeCount) }

    // The model's prose is attributed by its door, never bare: Coach for the ask door, the agent or the connection
    // by name over MCP, and `Your agent` when the MCP source carries neither.
    public var kicker: String {
        if source.door == "ask" { return "Coach wrote:" }
        return "\(source.named ?? "Your agent") wrote:"
    }

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
        source = try fields.decodeIfPresent(ProposalSource.self, forKey: .source)
            ?? ProposalSource(door: "")
    }
}

// Rows up to the first `removed` are the run the routine would take on, in order; the rest are what it would take away.
// `before` is absent on an added row, `after` on a removed one, and `loggedSets` rides only on a removed one, where 0 is real.
public struct ProposalChange: Equatable, Decodable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case kept
        case added
        case removed
        case retargeted
    }

    // Absent reps is `max`, absent weight is last time's, absent rest is the global target, and absent sets is the open row.
    // Which side of a diff is missing is `kind`, never an absent `sets`.
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

    // Sets and reps are one move rather than two.
    public var moves: [Move] {
        guard let before, let after else { return [] }
        var moved: [Move] = []
        if before.sets != after.sets || before.reps != after.reps {
            // The load is its own row, so no weight is passed here.
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

    public func addedLine(after previous: String?) -> String {
        var said = ["added"]
        if let after { said.append(Readout.target(sets: after.sets, reps: after.reps, weightKg: after.weightKg)) }
        said.append(previous.map { "after \($0)" } ?? "first in the routine")
        return said.joined(separator: " · ")
    }

    // The count is what the removal does not touch, and zero is a real answer.
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

// The rows are the document as well as the diff: every entry in its position, a kept line among them, and a renamed
// routine first. A change is a row that is not `kept`; the count under the button is the server's.
public enum ProposalRow: Equatable, Sendable {
    case renamed(from: String, to: String)
    // `follows` is read only on an added row.
    case entry(ProposalChange, follows: String?)
    case kept(ProposalChange)

    public var isKept: Bool {
        if case .kept = self { return true }
        return false
    }
}

// What the sheet draws: a changed row at full weight, a run of kept rows folded to a count IN PLACE, so expanding
// never shows the document out of order.
public enum ProposalBlock: Equatable, Sendable, Identifiable {
    case row(Int, ProposalRow)
    case unchanged(Int, [ProposalChange])

    public var id: Int {
        switch self {
        case .row(let index, _), .unchanged(let index, _): return index
        }
    }
}

// `baseRevision` is the token apply is atomic against; this device never checks it.
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
        for change in changes {
            guard change.kind != .kept else {
                drawn.append(.kept(change))
                continue
            }
            let previous = change.position > 1
                ? changes.first { $0.position == change.position - 1 }?.exerciseId
                : nil
            drawn.append(.entry(change, follows: previous))
        }
        return drawn
    }

    public var blocks: [ProposalBlock] { Proposal.folded(rows) }

    public static func folded(_ rows: [ProposalRow]) -> [ProposalBlock] {
        var blocks: [ProposalBlock] = []
        for (index, row) in rows.enumerated() {
            guard case .kept(let change) = row else {
                blocks.append(.row(index, row))
                continue
            }
            if case .unchanged(let start, let run) = blocks.last {
                blocks[blocks.count - 1] = .unchanged(start, run + [change])
            } else {
                blocks.append(.unchanged(index, [change]))
            }
        }
        return blocks
    }

    public static func unchangedLabel(_ count: Int) -> String {
        count == 1 ? "and 1 line unchanged" : "and \(count) lines unchanged"
    }

    // The server's count, never the rows this build drew: apply is atomic against the whole document.
    // Turning down is settled for good, so it is asked before it runs; closing the screen decides nothing.
    public static let turnDown = "Turn this down"
    public static let turnDownTitle = "Turn this down?"
    public static let turnDownBody = "Nothing changes, and it stays in the routine’s history as a record."
    public static let turnDownConfirm = "Turn down"
    public static let turnDownKeep = "Keep it"

    // Closing the sheet decides nothing; the card then says so.
    public static let waiting = "waiting"
    public static let stillWaiting = "still waiting"
    public static let review = "Review"
    public static let close = "Close"
    public static let applyHint = "Scroll to the end to apply."

    // The receipt is the server's reply, never the model's prose; it is not stored and it does not pretend to be.
    // A revision names the routine as it now stands (`name`, which a rename moved); a removal names what went.
    public static func receipt(applied: Proposal) -> String {
        guard applied.intent == .revise else { return removalReceipt(of: applied.baseName) }
        let name = applied.name.isEmpty ? applied.baseName : applied.name
        return "Applied · \(name) · \(Readout.changeCount(applied.head.changeCount))"
    }

    // A removal's reply carries no routine: the log confirmed the routine is gone, and that is the receipt.
    public static func removalReceipt(of baseName: String) -> String {
        "Applied · \(baseName) · routine removed"
    }

    public static let turnedDownReceipt = "Turned down · nothing changed."

    public var applyLabel: String {
        guard intent == .revise else { return "Remove \(baseName)" }
        if head.changeCount == 1 { return "Apply" }
        return "Apply all \(head.changeCount)"
    }

    public var footnote: String {
        guard intent == .revise else {
            return "Removes the routine from your program · every logged set stays."
        }
        guard head.changeCount > 1 else { return "Nothing is applied until you tap." }
        return "All \(Proposal.spelled(head.changeCount)) or none. Nothing is applied until you tap."
    }

    public func settledNote(now: Int64) -> String? {
        guard let settledAtMs = head.settledAtMs else { return nil }
        let when = "\(Readout.when(settledAtMs, now: now)) at \(Readout.time(settledAtMs))"
        switch state {
        case .pending:
            return nil
        case .applied:
            return "Applied to \(baseName) \(when). Kept on the routine as a dated record — the program’s history, not a toast that disappears."
        case .dismissed:
            return "Turned down \(when). Nothing changed, and it stays in the routine’s history as a record."
        case .superseded:
            return "\(baseName) changed after this was written, so it was set aside \(when). None of it was applied, and it stays in the routine’s history."
        }
    }

    private static func spelled(_ count: Int) -> String {
        let words = ["two", "three", "four", "five", "six", "seven",
                     "eight", "nine", "ten", "eleven", "twelve"]
        guard count >= 2, count - 2 < words.count else { return String(count) }
        return words[count - 2]
    }

    enum CodingKeys: String, CodingKey {
        case baseRevision, baseName, name, changes
    }

    // The head's fields are on the same flat object, so both decode from one container.
    public init(from decoder: Decoder) throws {
        head = try ProposalHead(from: decoder)
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        baseRevision = try fields.decodeIfPresent(Int.self, forKey: .baseRevision) ?? 0
        baseName = try fields.decodeIfPresent(String.self, forKey: .baseName) ?? ""
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        changes = try fields.decodeIfPresent([ProposalChange].self, forKey: .changes) ?? []
    }
}

// The routine is absent when the intent was to remove.
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
