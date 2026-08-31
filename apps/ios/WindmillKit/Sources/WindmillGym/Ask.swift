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

    public init(answer: String, steps: [AskStep] = [], read: ReadTally,
                proposals: [String] = []) {
        self.answer = answer
        self.steps = steps
        self.read = read
        self.proposals = proposals
    }

    enum CodingKeys: String, CodingKey {
        case answer, steps, read, proposals
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        answer = try fields.decode(String.self, forKey: .answer)
        read = try fields.decode(ReadTally.self, forKey: .read)
        steps = try fields.decodeIfPresent([AskStep].self, forKey: .steps) ?? []
        proposals = try fields.decodeIfPresent([String].self, forKey: .proposals) ?? []
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

    public var capReached: Bool { ceiling != nil }

    public init(line: String, mayRetry: Bool = false, closesTheDoor: Bool = false,
                opensAFreshThread: Bool = false, ceiling: AskCeiling? = nil) {
        self.line = line
        self.mayRetry = mayRetry
        self.closesTheDoor = closesTheDoor
        self.opensAFreshThread = opensAFreshThread
        self.ceiling = ceiling
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
        case .refused(404, _):
            // 404 is the route being absent: this deployment has no Anthropic key.
            self = AskRefusal(line: Ask.absentLine, closesTheDoor: true)
        case .refused(502, let refusal):
            // Nothing was stored, so the same thread and question sent again land exactly once.
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

    public init(id: String = UUID().uuidString, question: String, outcome: Outcome = .waiting) {
        self.id = id
        self.question = question
        self.outcome = outcome
    }
}

// The thread id is client-minted: a fresh one opens a thread, and the server refuses one another account holds.
public struct AskConversation: Equatable, Sendable {
    public private(set) var threadId: String
    public var exchanges: [AskExchange]

    public init(threadId: String = Ask.mintThreadId(), exchanges: [AskExchange] = []) {
        self.threadId = threadId
        self.exchanges = exchanges
    }

    public mutating func openAFreshThread() {
        threadId = Ask.mintThreadId()
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
    // The composer's bound; the thread's own turn ceiling arrives as a 409 instead.
    public static let maxTurnBytes = 1000

    // The server's alphabet: [A-Za-z0-9_-], 8–64.
    public static func mintThreadId() -> String {
        "thr_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static let title = "Coach"
    public static let subtitle = "reads your log · proposes only"

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
        "propose_routine_change": "wrote a proposal for one of your routines",
        "propose_routine_removal": "wrote a proposal to remove a routine",
    ]

    // One line per distinct phrase, in call order; the receipt stays whether or not any survive.
    public static func stepLines(_ steps: [AskStep]) -> [String] {
        var lines: [String] = []
        for line in steps.compactMap(\.line) where !lines.contains(line) { lines.append(line) }
        return lines
    }

    public static let scope = """
        Ask about anything in your log — a movement that stalled, what a week actually looked like, \
        whether a routine is doing what you wanted. It reads what you have logged and it can propose \
        a change to a routine. It can never change what you lifted: a set that needs fixing is yours, \
        in the log.
        """

    public static let freeDoor = """
        If you already use Claude, Cursor, Codex or anything else that speaks MCP, connect it \
        instead — it’s free, and it reaches what Coach can’t: it knows the rest of your life.
        """

    public static let connect = "Connect your own"

    public static let proposalNote = """
        Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.
        """

    // The promise sits immediately above the composer, always; the cap-reached moment replaces the composer.
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
