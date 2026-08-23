import Foundation

// The wire's two voices are `lifter` and `ask`, and the enum has no lenient default.
public struct AskTurn: Equatable, Decodable, Sendable {
    public enum Voice: String, Decodable, Sendable {
        case lifter
        case ask
    }

    public let from: Voice
    public let text: String
    public let atMs: Int64

    public init(from: Voice, text: String, atMs: Int64 = 0) {
        self.from = from
        self.text = text
        self.atMs = atMs
    }

    enum CodingKeys: String, CodingKey {
        case from, text
        case atMs = "at"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        from = try fields.decode(Voice.self, forKey: .from)
        text = try fields.decode(String.self, forKey: .text)
        atMs = try fields.decodeIfPresent(Int64.self, forKey: .atMs) ?? 0
    }
}

public struct ThreadOutcome: Equatable, Decodable, Sendable {
    public enum Kind: String, Decodable, CaseIterable, Sendable {
        case readOnly = "read-only"
        case proposed
        case applied
        case dismissed
        case superseded
        case unknown
    }

    public let kind: Kind
    public let changes: Int
    public let routineId: String?
    public let routine: String?

    public init(kind: Kind, changes: Int = 0, routineId: String? = nil, routine: String? = nil) {
        self.kind = kind
        self.changes = changes
        self.routineId = routineId
        self.routine = routine
    }

    // routine and routineId are absent when the changes spanned more than one.
    public var line: String {
        switch kind {
        case .readOnly:
            return "no changes proposed"
        case .applied:
            guard let routine, !routine.isEmpty else { return Readout.changeCount(changes) }
            return "\(Readout.changeCount(changes)) → \(routine)"
        case .proposed:
            return "\(Readout.changeCount(changes)) waiting"
        case .dismissed:
            return "\(Readout.changeCount(changes)) dismissed"
        case .superseded:
            return "\(Readout.changeCount(changes)) set aside"
        case .unknown:
            return changes > 0 ? Readout.changeCount(changes) : ""
        }
    }

    public var word: String? {
        switch kind {
        case .readOnly: return "read only"
        case .proposed: return "waiting"
        case .applied: return "applied"
        case .dismissed: return "dismissed"
        case .superseded: return "set aside"
        case .unknown: return nil
        }
    }

    public var changedTheProgram: Bool { kind == .applied }

    enum CodingKeys: String, CodingKey {
        case kind, changes, routineId, routine
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        let said = try fields.decodeIfPresent(String.self, forKey: .kind) ?? ""
        kind = Kind(rawValue: said) ?? .unknown
        changes = try fields.decodeIfPresent(Int.self, forKey: .changes) ?? 0
        routineId = try fields.decodeIfPresent(String.self, forKey: .routineId)
        routine = try fields.decodeIfPresent(String.self, forKey: .routine)
    }
}

public struct ThreadProposal: Equatable, Decodable, Sendable, Identifiable {
    public let id: String
    public let state: ProposalState
    public let changeCount: Int
    public let routineId: String
    public let routine: String
    public let createdAtMs: Int64

    public init(id: String, state: ProposalState, changeCount: Int,
                routineId: String, routine: String, createdAtMs: Int64) {
        self.id = id
        self.state = state
        self.changeCount = changeCount
        self.routineId = routineId
        self.routine = routine
        self.createdAtMs = createdAtMs
    }

    public var line: String {
        "\(Readout.changeCount(changeCount)) to \(routine) · \(state.word)"
    }

    enum CodingKeys: String, CodingKey {
        case id, state, changeCount, routineId, routine
        case createdAtMs = "createdAt"
    }
}

// `turns` rides only on the single-thread read: nil means the row came off the list, not that the thread was empty.
public struct AskThread: Equatable, Decodable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let createdAtMs: Int64
    public let askedAtMs: Int64
    public let outcome: ThreadOutcome
    public let proposals: [ThreadProposal]
    public let turns: [AskTurn]?

    public init(id: String, title: String, createdAtMs: Int64, askedAtMs: Int64,
                outcome: ThreadOutcome, proposals: [ThreadProposal] = [],
                turns: [AskTurn]? = nil) {
        self.id = id
        self.title = title
        self.createdAtMs = createdAtMs
        self.askedAtMs = askedAtMs
        self.outcome = outcome
        self.proposals = proposals
        self.turns = turns
    }

    enum CodingKeys: String, CodingKey {
        case id, title, outcome, proposals, turns
        case createdAtMs = "createdAt"
        case askedAtMs = "askedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        title = try fields.decode(String.self, forKey: .title)
        createdAtMs = try fields.decode(Int64.self, forKey: .createdAtMs)
        askedAtMs = try fields.decode(Int64.self, forKey: .askedAtMs)
        outcome = try fields.decode(ThreadOutcome.self, forKey: .outcome)
        proposals = try fields.decodeIfPresent([ThreadProposal].self, forKey: .proposals) ?? []
        turns = try fields.decodeIfPresent([AskTurn].self, forKey: .turns)
    }
}

// Rows arrive newest-asked first and are gathered in that order.
public struct ThreadMonth: Equatable, Sendable, Identifiable {
    public let label: String
    public let threads: [AskThread]

    public var id: String { label }
}

public enum AskThreads {
    public static let title = "Threads"
    public static let door = "Threads"
    public static let askSomethingNew = "Ask something new"

    // The list read is capped and carries no total: a full page prints `200+`.
    public static let served = 200

    public static func meta(_ count: Int) -> String {
        if count == 1 { return "1 conversation · yours to delete" }
        if count >= served { return "\(served)+ conversations · yours to delete" }
        return "\(count) conversations · yours to delete"
    }

    public static let empty = """
        Nothing here yet. A question you ask lands here in your own words, with what came of it — \
        so a conversation about a plateau is still findable in six weeks.
        """

    public static let delete = "Delete this conversation"

    public static let deleteNote = """
        The conversation goes for good. A change you applied stays in the routine’s history — that \
        is a fact about your program, not a message.
        """

    public static let reading = "reading your conversations…"

    public static let fromTheConversation = "Open the conversation"

    public static func months(of threads: [AskThread], now: Int64) -> [ThreadMonth] {
        var grouped: [ThreadMonth] = []
        for thread in threads {
            let label = Readout.month(thread.askedAtMs, now: now)
            guard let last = grouped.last, last.label == label else {
                grouped.append(ThreadMonth(label: label, threads: [thread]))
                continue
            }
            grouped[grouped.count - 1] = ThreadMonth(label: label, threads: last.threads + [thread])
        }
        return grouped
    }
}
