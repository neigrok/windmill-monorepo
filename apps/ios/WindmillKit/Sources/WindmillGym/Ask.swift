import Foundation
import WindmillPlatform

// What the server served this exchange. Never summed across answers and never computed here.
public struct ReadTally: Equatable, Decodable, Sendable {
    public let sets: Int
    public let sessions: Int
    public let weeks: Int

    public init(sets: Int, sessions: Int, weeks: Int) {
        self.sets = sets
        self.sessions = sessions
        self.weeks = weeks
    }

    public var line: String {
        var counted: [String] = []
        if sets > 0 { counted.append(Readout.setCount(sets)) }
        if weeks > 0 { counted.append(Readout.weekCount(weeks)) }
        if sessions > 0 { counted.append(Readout.sessionCount(sessions)) }
        guard !counted.isEmpty else { return "read nothing from your log" }
        return "read " + counted.joined(separator: " · ")
    }
}

// A tool this build has no phrase for prints nothing: the receipt is the honesty check, the step list is detail.
public struct AskStep: Equatable, Decodable, Sendable {
    public let tool: String
    public let failed: Bool

    public init(tool: String, failed: Bool = false) {
        self.tool = tool
        self.failed = failed
    }

    public var line: String? {
        guard let phrase = Ask.phrase[tool] else { return nil }
        return failed ? phrase + " (nothing came back)" : phrase
    }

    enum CodingKeys: String, CodingKey {
        case tool, failed
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        tool = try fields.decode(String.self, forKey: .tool)
        failed = try fields.decodeIfPresent(Bool.self, forKey: .failed) ?? false
    }
}

// `read` is decoded strictly and never defaulted: a body without it fails the decode.
public struct AskAnswer: Equatable, Decodable, Sendable {
    public let answer: String
    public let steps: [AskStep]
    public let read: ReadTally
    public let proposals: [String]
    public let results: [CoachResult]
    public let hasReceipt: Bool

    public init(answer: String, steps: [AskStep] = [], read: ReadTally,
                proposals: [String] = [], results: [CoachResult] = [], hasReceipt: Bool = true) {
        self.answer = answer
        self.steps = steps
        self.read = read
        self.proposals = proposals
        self.results = results
        self.hasReceipt = hasReceipt
    }

    enum CodingKeys: String, CodingKey {
        case answer, steps, read, proposals, results
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        answer = try fields.decode(String.self, forKey: .answer)
        read = try fields.decode(ReadTally.self, forKey: .read)
        steps = try fields.decodeIfPresent([AskStep].self, forKey: .steps) ?? []
        proposals = try fields.decodeIfPresent([String].self, forKey: .proposals) ?? []
        results = try fields.decodeIfPresent([CoachResult].self, forKey: .results) ?? []
        hasReceipt = true
    }
}

// Two refusals take the composer down, and which one it was decides two things: the wordless fallback,
// and which door the block leads with. Under the account's ceiling a fresh conversation cannot take a
// question either, so the unrationed door goes first.
public enum AskCeiling: String, Equatable, Sendable {
    case daily
    case account
}

public struct AskRefusal: Equatable, Error, Sendable {
    public let line: String
    public let mayRetry: Bool
    public let closesTheDoor: Bool
    // Answered by opening a new thread: the retry carries the same question into a fresh id.
    public let opensAFreshThread: Bool
    // An allowance is spent: the composer gives way to the cap-reached state for this visit.
    public let ceiling: AskCeiling?
    public let needsPhotoUpload: Bool

    public var capReached: Bool { ceiling != nil }

    public init(line: String, mayRetry: Bool = false, closesTheDoor: Bool = false,
                opensAFreshThread: Bool = false, ceiling: AskCeiling? = nil, needsPhotoUpload: Bool = false) {
        self.line = line
        self.mayRetry = mayRetry
        self.closesTheDoor = closesTheDoor
        self.opensAFreshThread = opensAFreshThread
        self.ceiling = ceiling
        self.needsPhotoUpload = needsPhotoUpload
    }

    public init(_ error: Error) {
        guard let failure = error as? WindmillApiError else {
            self = AskRefusal(line: Ask.noAnswer, mayRetry: true)
            return
        }
        switch failure {
        case .offline:
            self = AskRefusal(line: failure.line, mayRetry: true)
        case .malformed:
            self = AskRefusal(line: Ask.noAnswer, mayRetry: true)
        case .refused(_, let refusal) where refusal.code == "ask-attachment-invalid":
            self = AskRefusal(line: refusal.message ?? "This photo needs to be uploaded again.",
                              mayRetry: true, needsPhotoUpload: true)
        case .refused(404, _):
            // 404 is the route being absent: this deployment has no Anthropic key.
            self = AskRefusal(line: Ask.absentLine, closesTheDoor: true)
        case .refused(502, let refusal):
            // A failed generation may already have completed a tool operation; retain its request identity.
            self = AskRefusal(line: refusal.message ?? Ask.noAnswer, mayRetry: true)
        case .refused(409, let refusal) where refusal.code == "ask-thread-full":
            self = AskRefusal(line: refusal.message ?? Ask.threadCeiling,
                              mayRetry: true, opensAFreshThread: true)
        case .refused(409, let refusal) where refusal.code == "ask-thread-taken":
            self = AskRefusal(line: refusal.message ?? Ask.threadTaken,
                              mayRetry: true, opensAFreshThread: true)
        case .refused(429, let refusal) where refusal.code == "ask-daily-limit" || refusal.code == "ask-out-of-budget":
            // One state, two ceilings: the connect door is unrationed under either, and every surface
            // says the sentence it was SENT. The constant is the wordless fallback only, chosen on the
            // code — a ceiling that borrowed the daily line would promise a couple of hours over a
            // thirty-day window.
            let ceiling: AskCeiling = refusal.code == "ask-daily-limit" ? .daily : .account
            self = AskRefusal(line: refusal.message ?? Ask.reached(ceiling), ceiling: ceiling)
        case .refused(_, let refusal):
            self = AskRefusal(line: refusal.message ?? "That didn’t go through")
        }
    }
}

public struct AskExchange: Equatable, Sendable, Identifiable {
    public enum Outcome: Equatable, Sendable {
        case waiting
        case answered(AskAnswer)
        case refused(AskRefusal)
    }

    public let id: String
    public let question: String
    public var outcome: Outcome
    public var snapshot: AskAnswer?
    public var position: Int?
    public var attachments: [CoachAttachment]
    public var revision: Int64 = -1
    public var stopRequested = false

    public init(id: String = UUID().uuidString, question: String, outcome: Outcome = .waiting, snapshot: AskAnswer? = nil, position: Int? = nil, attachments: [CoachAttachment] = []) {
        self.id = id
        self.question = question
        self.outcome = outcome
        self.snapshot = snapshot
        self.position = position
        self.attachments = attachments
    }
}

// The thread id is client-minted: a fresh one opens a thread, and the server refuses one another account holds.
public struct AskConversation: Equatable, Sendable {
    public private(set) var threadId: String
    public var exchanges: [AskExchange]
    public var nextCursor: String?
    public var historyProposals: [ThreadProposal] = []
    public var draft = ""
    public var historyFailure: String?
    public var isLoading = false

    public init(threadId: String = Ask.mintThreadId(), exchanges: [AskExchange] = []) {
        self.threadId = threadId
        self.exchanges = exchanges
    }

    public mutating func openAFreshThread() {
        threadId = Ask.mintThreadId()
    }

    // The exchange is on screen, waiting, BEFORE anything goes out: a retry puts its own exchange
    // back to waiting, a new question appends one. Answers with the id the send settles under.
    public mutating func open(_ question: String, replacing id: String?) -> String {
        if let standing = id.flatMap({ known in exchanges.firstIndex { $0.id == known } }) {
            exchanges[standing].outcome = .waiting
            return exchanges[standing].id
        }
        let fresh = AskExchange(question: question)
        exchanges.append(fresh)
        return fresh.id
    }

    // Found by id, never by index: the conversation may have moved on under the await, and an
    // exchange that is no longer here settles nothing. Answers whether it landed, because a refusal
    // that would re-mint the thread must not re-mint a conversation the exchange was never part of.
    @discardableResult
    public mutating func settle(_ id: String, _ outcome: AskExchange.Outcome) -> Bool {
        guard let landed = exchanges.firstIndex(where: { $0.id == id }) else { return false }
        exchanges[landed].outcome = outcome
        return true
    }

    // One question in flight at a time; the composer and the retry are grey while it is.
    public var waiting: Bool {
        exchanges.contains { $0.outcome == .waiting }
    }

    // The refusal that took the composer down, if the last question met one: the cap-reached state stands
    // until a new conversation opens, and it says the words that refusal carried.
    public var cappedRefusal: AskRefusal? {
        guard case .refused(let why) = exchanges.last?.outcome, why.capReached else { return nil }
        return why
    }

    public var capReached: Bool { cappedRefusal != nil }
}

public enum Ask {
    // The composer’s UTF-8 bound.
    public static let maxTurnBytes = 1000

    // The server's alphabet: [A-Za-z0-9_-], 8–64.
    public static func mintThreadId() -> String {
        "thr_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static let title = "Coach"
    public static let subtitle = "reads your log · helps with your routines"

    public static let needsSignIn = "Coach reads your log, so it needs you signed in."
    public static let signIn = "Sign in"
    public static let absentLine = "Coach isn’t part of this Windmill. Your log is still yours to read."
    public static let noAnswer = "Coach didn’t answer. Try again in a moment"

    // Each phrase is the web's `TOOL_PHRASE` word for word, plus the notes read. A tool absent here is not drawn.
    public static let phrase: [String: String] = [
        "list_sessions": "read your recent workouts",
        "get_session": "read one workout",
        "last_time": "read the last time you trained a movement",
        "list_exercises": "read your movement list",
        "list_routines": "read your program",
        "get_stats": "read your movement history",
        "list_notes": "read your notes",
        "list_bodyweight": "read your bodyweight",
        "create_routine": "created a routine",
        "propose_routine_change": "wrote a proposal for one of your routines",
        "propose_routine_removal": "wrote a proposal to remove a routine",
    ]

    // One line per distinct phrase, in call order; the receipt stays whether or not any survive.
    public static func stepLines(_ steps: [AskStep]) -> [String] {
        var lines: [String] = []
        for line in steps.compactMap(\.line) where !lines.contains(line) { lines.append(line) }
        return lines
    }

    public static let scope = "Ask about your training. Coach can create a routine or propose a change — you decide on the diff."

    public static let freeDoor = """
        If you already use Claude, Cursor, Codex or anything else that speaks MCP, connect it \
        instead — it’s free, and it reaches what Coach can’t: it knows the rest of your life.
        """

    public static let connect = "Connect your own"

    public static let proposalNote = """
        Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.
        """

    public static let allowance = "Ten questions a day, three back to back."
    public static let capReached = "The next question frees up in a couple of hours."
    // The account's 30-day AI ceiling, which is not the daily bucket and never says its hours. Byte-
    // identical to the web's `OUT_OF_BUDGET_NOTE` and Android's `Ask.ceilingReached`: it is the only
    // sentence the state draws when the 429 arrives wordless, so it has to name the ceiling itself.
    public static let ceilingReached =
        "This account has reached its AI ceiling for the last 30 days. Coach will answer again as "
        + "that window rolls on."

    public static func reached(_ ceiling: AskCeiling) -> String {
        ceiling == .daily ? capReached : ceilingReached
    }

    // Local fallbacks for a 409 that arrived without a sentence; the server's own words win when sent.
    public static let threadCeiling = "This conversation holds four questions. Start a new one."
    public static let threadTaken = "That conversation id is already in use — this starts a new one."

    public static let notesDoor = "Notes"

    public static let placeholder = "Ask about your training"
    public static let waiting = "reading your log…"

    public static let tooLong = "That question is longer than Coach takes. Shorten it to send."

    public static func doorIsOpen(signedIn: Bool, sessionIsOpen: Bool, onThisDeployment: Bool) -> Bool {
        signedIn && !sessionIsOpen && onThisDeployment
    }

    public static func fits(_ draft: String) -> Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count <= maxTurnBytes
    }

    public static func question(from draft: String) -> String? {
        let asked = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asked.isEmpty, fits(asked) else { return nil }
        return asked
    }

}

public struct CoachResult: Equatable, Decodable, Sendable, Identifiable {
    public let kind: String
    public let operationId: String
    public let routineId: String
    public let routineName: String
    public var id: String { operationId }
}

public struct CoachReceipt: Equatable, Decodable, Sendable {
    public let read: ReadTally
    public let steps: [AskStep]
    public let proposals: [String]
}

public struct CoachGeneration: Equatable, Decodable, Sendable {
    public let id: String
    public let requestId: String
    public let question: String
    public let status: String
    public let answer: String
    public let at: Int64
    public let steps: [AskStep]
    public let receipt: CoachReceipt?
    public let results: [CoachResult]
    public let revision: Int64
    public let attachments: [CoachAttachment]
    public let stopRequested: Bool

    public init(id: String, requestId: String, question: String, status: String, answer: String,
                at: Int64, steps: [AskStep], receipt: CoachReceipt?, results: [CoachResult],
                revision: Int64 = 0, attachments: [CoachAttachment] = [], stopRequested: Bool = false) {
        self.id = id
        self.requestId = requestId
        self.question = question
        self.status = status
        self.answer = answer
        self.at = at
        self.steps = steps
        self.receipt = receipt
        self.results = results
        self.revision = revision
        self.attachments = attachments
        self.stopRequested = stopRequested
    }

    enum CodingKeys: String, CodingKey {
        case id, requestId, question, status, answer, at, steps, receipt, results, revision, attachments, stopRequested
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try fields.decode(String.self, forKey: .id),
                  requestId: try fields.decode(String.self, forKey: .requestId),
                  question: try fields.decode(String.self, forKey: .question),
                  status: try fields.decode(String.self, forKey: .status),
                  answer: try fields.decode(String.self, forKey: .answer),
                  at: try fields.decode(Int64.self, forKey: .at),
                  steps: try fields.decodeIfPresent([AskStep].self, forKey: .steps) ?? [],
                  receipt: try fields.decodeIfPresent(CoachReceipt.self, forKey: .receipt),
                  results: try fields.decodeIfPresent([CoachResult].self, forKey: .results) ?? [],
                  revision: try fields.decodeIfPresent(Int64.self, forKey: .revision) ?? 0,
                  attachments: try fields.decodeIfPresent([CoachAttachment].self, forKey: .attachments) ?? [],
                  stopRequested: try fields.decodeIfPresent(Bool.self, forKey: .stopRequested) ?? false)
    }

    public var terminal: Bool { ["completed", "failed", "stopped"].contains(status) }

    public var snapshot: AskAnswer {
        AskAnswer(answer: answer, steps: receipt?.steps ?? steps,
                  read: receipt?.read ?? ReadTally(sets: 0, sessions: 0, weeks: 0),
                  proposals: receipt?.proposals ?? [], results: results, hasReceipt: receipt != nil)
    }
}

public struct CoachResponse: Decodable, Sendable {
    public let generation: CoachGeneration
}

public struct CoachThreadPage: Decodable, Sendable {
    public let threads: [AskThread]
    public let nextCursor: String?
}

extension AskConversation {
    public var unresolved: AskExchange? {
        guard let last = exchanges.last else { return nil }
        if case .waiting = last.outcome { return last }
        if case .refused(let why) = last.outcome, why.mayRetry { return last }
        return nil
    }

    public mutating func merge(_ thread: AskThread, older: Bool = false) {
        guard thread.id == threadId else { return }
        historyProposals = thread.proposals
        let turns = (thread.turns ?? []).filter(\.isDrawn)
        var page: [AskExchange] = []
        for (index, turn) in turns.enumerated() where turn.from == .lifter {
            let reply = turns.dropFirst(index + 1).first
            let answer = reply?.from == .ask ? reply : nil
            let id = turn.requestId ?? "history_\(turn.position ?? index)_\(turn.atMs)"
            let receipt = answer?.receipt
            let value = AskAnswer(answer: answer?.text ?? "", steps: receipt?.steps ?? [],
                                  read: receipt?.read ?? ReadTally(sets: 0, sessions: 0, weeks: 0),
                                  proposals: receipt?.proposals ?? [], results: answer?.results ?? [],
                                  hasReceipt: receipt != nil)
            let outcome: AskExchange.Outcome
            switch answer?.status {
            case "failed": outcome = .refused(AskRefusal(line: "Response interrupted.", mayRetry: turn.requestId != nil))
            case "stopped": outcome = .refused(AskRefusal(line: "Response stopped."))
            default: outcome = .answered(value)
            }
            page.append(AskExchange(id: id, question: turn.text, outcome: outcome,
                                    snapshot: value, position: turn.position, attachments: turn.attachments))
        }
        let ids = Set(page.map(\.id))
        let retained = exchanges.filter { !ids.contains($0.id) }
        exchanges = older ? page + retained : retained + page
        exchanges.sort { ($0.position ?? Int.max) < ($1.position ?? Int.max) }
        nextCursor = thread.nextCursor
        if !older, let generation = thread.generation { accept(generation) }
        historyFailure = nil
    }

    public mutating func accept(_ generation: CoachGeneration) {
        let outcome: AskExchange.Outcome
        switch generation.status {
        case "completed": outcome = .answered(generation.snapshot)
        case "running": outcome = .waiting
        case "stopped": outcome = .refused(AskRefusal(line: "Response stopped."))
        default: outcome = .refused(AskRefusal(line: "Response interrupted.", mayRetry: true))
        }
        if let index = exchanges.firstIndex(where: { $0.id == generation.requestId }) {
            if generation.revision > 0, generation.revision <= exchanges[index].revision { return }
            exchanges[index].outcome = outcome
            exchanges[index].snapshot = generation.snapshot
            exchanges[index].revision = generation.revision
            exchanges[index].stopRequested = generation.stopRequested
            exchanges[index].attachments = generation.attachments
            return
        }
        var exchange = AskExchange(id: generation.requestId, question: generation.question,
                                   outcome: outcome, snapshot: generation.snapshot, attachments: generation.attachments)
        exchange.revision = generation.revision
        exchange.stopRequested = generation.stopRequested
        exchanges.append(exchange)
    }
}
