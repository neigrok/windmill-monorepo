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

public struct AskStep: Equatable, Decodable, Sendable {
    public let tool: String
    public let failed: Bool

    public init(tool: String, failed: Bool = false) {
        self.tool = tool
        self.failed = failed
    }

    public var line: String {
        failed ? "\(tool) · no answer" : tool
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

public struct AskRefusal: Equatable, Error, Sendable {
    public let line: String
    public let mayRetry: Bool
    public let closesTheDoor: Bool
    // Answered by opening a new thread: the retry carries the same question into a fresh id.
    public let opensAFreshThread: Bool

    public init(line: String, mayRetry: Bool = false, closesTheDoor: Bool = false,
                opensAFreshThread: Bool = false) {
        self.line = line
        self.mayRetry = mayRetry
        self.closesTheDoor = closesTheDoor
        self.opensAFreshThread = opensAFreshThread
    }

    public init(_ error: Error) {
        guard let failure = error as? WindmillApiError else {
            self = AskRefusal(line: "Ask didn’t answer. Try again in a moment", mayRetry: true)
            return
        }
        switch failure {
        case .offline:
            self = AskRefusal(line: failure.line, mayRetry: true)
        case .malformed:
            self = AskRefusal(line: "Ask didn’t answer. Try again in a moment", mayRetry: true)
        case .refused(404, _):
            // 404 is the route being absent: this deployment has no Anthropic key.
            self = AskRefusal(line: Ask.absentLine, closesTheDoor: true)
        case .refused(502, let refusal):
            // Nothing was stored, so the same thread and question sent again land exactly once.
            self = AskRefusal(line: refusal.message ?? "Ask didn’t answer. Try again in a moment",
                              mayRetry: true)
        case .refused(409, let refusal) where refusal.code == "ask-thread-full"
            || refusal.code == "ask-thread-taken":
            self = AskRefusal(
                line: refusal.message ?? "That conversation is full — this starts a new one",
                mayRetry: true, opensAFreshThread: true)
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

public struct AskDiffRow: Equatable, Sendable {
    public let name: String
    public let change: String

    public init(name: String, change: String) {
        self.name = name
        self.change = change
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
}

public enum Ask {
    // The composer's bound; the thread's own turn ceiling arrives as a 409 instead.
    public static let maxTurnBytes = 1000

    // The server's alphabet: [A-Za-z0-9_-], 8–64.
    public static func mintThreadId() -> String {
        "thr_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static let title = "Ask"
    public static let subtitle = "reads your log · proposes only"

    public static let needsSignIn = "Ask reads your log, so it needs you signed in."
    public static let signIn = "Sign in"
    public static let absentLine = "Ask isn’t available on this Windmill."

    public static let scope = """
        Ask about anything in your log — a movement that stalled, what a week actually looked like, \
        whether a routine is doing what you wanted. It reads what you have logged and it can propose \
        a change to a routine. It can never change what you lifted: a set that needs fixing is yours, \
        in the log.
        """

    public static let freeDoor = """
        If you already use Claude, Cursor, Codex or anything else that speaks MCP, connect it \
        instead — it’s free, and it’s better, because it knows the rest of your life.
        """

    public static let connect = "Connect your own"

    public static let proposalNote = """
        Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.
        """

    public static let dailyLimit = """
        It answers about ten questions a day, three back to back. That cap is what keeps Ask open to \
        everyone — when you reach it, it says so, and it answers again later.
        """

    public static let placeholder = "Ask about your training"
    public static let waiting = "reading your log…"

    public static let tooLong = "That question is longer than Ask takes. Shorten it to send."

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

    public static func diffRows(of proposal: Proposal, in catalog: [Exercise]) -> [AskDiffRow] {
        proposal.rows.map { row in
            switch row {
            case .renamed(let before, let after):
                return AskDiffRow(name: "name", change: "\(before) → \(after)")
            case .entry(let change, _):
                let name = Readout.movement(change.exerciseId, in: catalog)
                switch change.kind {
                case .added:
                    guard let after = change.after else { return AskDiffRow(name: name, change: "+ added") }
                    return AskDiffRow(name: name, change: "+ added · "
                        + Readout.target(sets: after.sets, reps: after.reps, weightKg: after.weightKg))
                case .removed:
                    return AskDiffRow(name: name, change: "− \(change.removedLine)")
                case .retargeted:
                    let moved = change.moves.map { "\($0.before) → \($0.after)" }
                    guard !moved.isEmpty else { return AskDiffRow(name: name, change: "retargeted") }
                    return AskDiffRow(name: name, change: moved.joined(separator: " · "))
                case .kept:
                    // Unreachable: `Proposal.rows` drops every kept entry.
                    return AskDiffRow(name: name, change: "unchanged")
                }
            }
        }
    }
}
