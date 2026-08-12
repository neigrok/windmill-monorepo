import Foundation
import WindmillPlatform

// ASK (§L, screens 26–27) — gym's own chat, and the SECOND DOOR onto the engine the connected log
// already describes: same reads, same typed diffs, same tap, for the lifter who does not have a
// Claude or a ChatGPT of their own. This file is everything Ask decides; AskScreen.swift only draws
// it, which is why every rule worth a test is a value or a function here.
//
// WHAT IT IS NOT IS A COACH. It answers questions about numbers the lifter owns and it can still
// only ever propose — so nothing in this file encourages, congratulates, speaks first, or suggests a
// training decision nobody asked for, and the word itself is not in this product's chat vocabulary.
// The coach SHARE (CoachShare.swift) is a different object — a link to one workout, minted by the
// lifter's own hand — and it keeps the word honestly.
//
// EVERY NUMBER UNDER AN ANSWER IS THE SERVER'S. `read 214 sets · 12 weeks · 34 sessions` is printable
// only because those rows were served to this connection, so the count is made in the tool envelope
// and carried on the wire. A tally this file added up would be a number the model could have made up,
// laundered through our own chrome — which is worse than no number at all.
//
// THE ROUTE IS CONDITIONAL. A deployment with no Anthropic key does not mount `POST /v1/gym/ask` at
// all, and the framework's own 404 comes back with no body. That is the one refusal that takes the
// door away rather than saying a sentence about it — see `AskRefusal.closesTheDoor`.

// One turn of the thread as the wire spells it. The two voices are `lifter` and `ask` and never
// `user`/`assistant` — the transport's vocabulary is not this product's — and the server keeps
// nothing, so the whole thread goes out with every question.
public struct AskTurn: Equatable, Encodable, Sendable {
    public enum Voice: String, Encodable, Sendable {
        case lifter
        case ask
    }

    public let from: Voice
    public let text: String

    public init(from: Voice, text: String) {
        self.from = from
        self.text = text
    }
}

// WHAT THE SERVER SERVED THIS EXCHANGE, counted by identity where the ids are and deduped there, so
// two tool calls over one week count that week once. Never summed across answers and never computed
// here: this type has no arithmetic in it on purpose.
public struct ReadTally: Equatable, Decodable, Sendable {
    public let sets: Int
    public let sessions: Int
    public let weeks: Int

    public init(sets: Int, sessions: Int, weeks: Int) {
        self.sets = sets
        self.sessions = sessions
        self.weeks = weeks
    }

    // `read 214 sets · 12 weeks · 34 sessions`, in the design's own order. A zero is OMITTED rather
    // than printed — "0 sessions" is a fact nobody needs and reads as a failure — and an answer that
    // touched no log rows at all says so plainly instead of printing an empty line.
    public var line: String {
        var counted: [String] = []
        if sets > 0 { counted.append(Readout.setCount(sets)) }
        if weeks > 0 { counted.append(Readout.weekCount(weeks)) }
        if sessions > 0 { counted.append(Readout.sessionCount(sessions)) }
        guard !counted.isEmpty else { return "read nothing from your log" }
        return "read " + counted.joined(separator: " · ")
    }
}

// ONE TOOL THE MODEL ASKED FOR, in call order. The opening read Ask makes on the lifter's behalf is
// not one of these — the model did not choose it — so this list is exactly what the answer was
// steered by.
public struct AskStep: Equatable, Decodable, Sendable {
    public let tool: String
    public let failed: Bool

    public init(tool: String, failed: Bool = false) {
        self.tool = tool
        self.failed = failed
    }

    // The tool's own name, unchanged. It is the name a lifter's own Claude sees over MCP, and
    // renaming it here would put two vocabularies on one catalog — the seam §2 exists to keep single.
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

// ONE ANSWER. `read` is decoded STRICTLY and not defaulted: §L's rule is that every answer states
// what it read, so a body this build cannot find a receipt in is not an answer it may draw — it
// fails the read and becomes "Ask didn't answer", which is the honest thing to say about prose we
// cannot check.
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

// A QUESTION THAT DID NOT GET AN ANSWER, and the three facts the screen needs about it: what to say,
// whether trying again is worth offering, and whether Ask is on this deployment at all.
//
// The eight refusals collapse to this rather than to eight cases because the screen treats them
// identically — it prints the server's sentence and offers nothing else. That is not laziness, it is
// the money decision (contract §4): the daily limit and the AI ceiling are stated plainly and NOTHING
// is sold against either, so the case that would carry an upgrade button does not exist to be filled
// in later.
public struct AskRefusal: Equatable, Error, Sendable {
    public let line: String
    public let mayRetry: Bool
    public let closesTheDoor: Bool

    public init(line: String, mayRetry: Bool = false, closesTheDoor: Bool = false) {
        self.line = line
        self.mayRetry = mayRetry
        self.closesTheDoor = closesTheDoor
    }

    // The log's own words wherever it sent any — the sign-in line, the mid-session line, the daily
    // limit and the ceiling are all written on the server, so the three surfaces cannot drift apart
    // in tone. Only the two silences below are spelled here, because there was nothing to repeat.
    public init(_ error: Error) {
        guard let failure = error as? WindmillApiError else {
            self = AskRefusal(line: "Ask didn’t answer. Try again in a moment", mayRetry: true)
            return
        }
        switch failure {
        case .offline:
            self = AskRefusal(line: failure.line, mayRetry: true)
        case .malformed:
            // A 2xx whose body this build could not read. The lifter's consequence is identical to
            // the 502's — no answer — and a second attempt may well land, so it is offered the same
            // sentence and the same retry rather than a paragraph about JSON.
            self = AskRefusal(line: "Ask didn’t answer. Try again in a moment", mayRetry: true)
        case .refused(404, _):
            // The route is ABSENT, not failing: this deployment has no Anthropic key, so there is no
            // Ask here to try again at. The door goes rather than the sentence staying.
            self = AskRefusal(line: "Ask isn’t available on this Windmill.", closesTheDoor: true)
        case .refused(502, let refusal):
            self = AskRefusal(line: refusal.message ?? "Ask didn’t answer. Try again in a moment",
                              mayRetry: true)
        case .refused(_, let refusal):
            self = AskRefusal(line: refusal.message ?? "That didn’t go through")
        }
    }
}

// ONE QUESTION AND WHAT BECAME OF IT. The thread is a list of these rather than a list of turns,
// because a question that was refused produced no answer at all — and a refused question resent as a
// bare extra turn would be two lifter turns side by side, a 400 the lifter never caused.
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

// One row of the compact diff §L draws inside the message stream: the movement, and what would
// happen to it. The full document — every field, both spellings, the atomic tap — is one screen away
// and is the only place the change can actually be applied.
public struct AskDiffRow: Equatable, Sendable {
    public let name: String
    public let change: String

    public init(name: String, change: String) {
        self.name = name
        self.change = change
    }
}

public enum Ask {
    // The server's own bounds, restated so the composer can respect them instead of discovering them
    // as a 400. A turn over 1000 bytes and a thread over 8 turns are both terminal refusals.
    public static let maxTurnBytes = 1000
    public static let maxTurns = 8

    // HOW MUCH OF THE THREAD GOES BACK OUT, and the arithmetic is the server's rule read backwards:
    // turns must alternate, and the first and last must both be `lifter` — so a valid thread always
    // holds an ODD number of turns, and the most that fits under a ceiling of 8 is 7. Seven is three
    // answered exchanges plus the new question.
    public static let history = 3

    public static let title = "Ask"
    public static let subtitle = "reads your log · proposes only"

    // What Ask is, said before it has said anything — it does not speak first, so this is a
    // description of the surface and never an opening line from it. It names the ceiling of what Ask
    // can do in the same breath as the floor, because the safeguard ladder's third rung (never
    // writes) is the fact a lifter is most likely to test.
    public static let scope = """
        Ask about anything in your log — a movement that stalled, what a week actually looked like, \
        whether a routine is doing what you wanted. It reads what you have logged and it can propose \
        a change to a routine. It can never change what you lifted: a set that needs fixing is yours, \
        in the log.
        """

    // THE LINE THAT TELLS YOU HOW TO STOP NEEDING THIS SCREEN (contract §5). An in-app chat that
    // points at the free door costs one paragraph and is the strongest proof we have that the MCP
    // thesis is real — shipping Ask without it would be the retreat.
    public static let freeDoor = """
        If you already use Claude or ChatGPT, connect them instead — it’s free, and it’s better, \
        because it knows the rest of your life.
        """

    public static let connect = "Connect your own"

    // Said under every proposal Ask mints, in the stream, before the lifter ever reaches the diff.
    public static let proposalNote = """
        Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal.
        """

    // THE CAP, SAID BEFORE IT IS HIT (contract §4). Ask is the first thing in this product with a
    // marginal cost per use and therefore the first with a structural incentive to ration, so the
    // ration is a line on the screen rather than an ops detail a lifter meets for the first time as a
    // refusal. Both numbers are the server's — `kAskPerDay` and `kAskBackToBack`,
    // backend/products/gym/application/AskService.h — and they move together with it.
    //
    // Nothing is sold against it, here or at the 429: the cap is what keeps Ask open to everybody
    // rather than a locked door with a price on it.
    public static let dailyLimit = """
        It answers about ten questions a day, three back to back. That cap is what keeps Ask open to \
        everyone — when you reach it, it says so, and it answers again later.
        """

    public static let placeholder = "Ask about your training"
    public static let waiting = "reading your log…"

    // Said in the composer, while the question can still be shortened — never after the fact, and
    // never instead of sending what was typed. It is the server's own refusal (`questionTooLong`,
    // 400 "that question is longer than Ask takes") reached before a lifter spends a question on it.
    public static let tooLong = "That question is longer than Ask takes. Shorten it to send."

    // THE DOOR, AND THE THREE THINGS THAT TAKE IT AWAY. Ask is never a fourth tab and never offered
    // mid-session — a chat is not a place you live, and a workout is the one screen in this product
    // that is time-critical. The mid-session rule is enforced by the server too (409
    // `ask-session-open`); this is the client half, stated once, so Today and the proposal card
    // cannot disagree about it.
    //
    // Signed out there is no account for Ask to read, so the door is not drawn at all rather than
    // drawn onto a 401 — the same reason a proposal card is never on a signed-out Today.
    public static func doorIsOpen(signedIn: Bool, sessionIsOpen: Bool, onThisDeployment: Bool) -> Bool {
        signedIn && !sessionIsOpen && onThisDeployment
    }

    // WHAT GOES OUT: the last few exchanges that actually got an answer, then the new question.
    // Only ANSWERED ones are carried — a refused question never produced an `ask` turn, and sending
    // it again would break the alternation the server checks.
    public static func turns(after exchanges: [AskExchange], asking question: String) -> [AskTurn] {
        let answered = exchanges.compactMap { exchange -> (asked: String, said: String)? in
            guard case .answered(let answer) = exchange.outcome else { return nil }
            return (exchange.question, answer.answer)
        }
        var thread: [AskTurn] = []
        for exchange in answered.suffix(history) {
            thread.append(AskTurn(from: .lifter, text: clipped(exchange.asked)))
            thread.append(AskTurn(from: .ask, text: clipped(exchange.said)))
        }
        thread.append(AskTurn(from: .lifter, text: clipped(question)))
        return thread
    }

    // WHETHER A QUESTION MAY GO OUT AS TYPED, asked in the composer BEFORE anything is sent. A
    // question is never shortened to fit: one clipped on the way out is answered half-asked, and the
    // thread then shows the lifter a question they did not finish typing — two lies for the price of
    // one, where the honest move is to say so while it can still be edited. The ceiling is the
    // server's own byte count (`kMaxAskTurnBytes`, backend/products/gym/application/AskService.h).
    public static func fits(_ draft: String) -> Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count <= maxTurnBytes
    }

    // The question, or nothing at all. Blank is not a question and too long is not a shorter one —
    // both are drafts that stay in the composer, which is why this answers with an optional rather
    // than with the best string it could make out of what it was handed.
    public static func question(from draft: String) -> String? {
        let asked = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asked.isEmpty, fits(asked) else { return nil }
        return asked
    }

    // Trimmed, and cut to the server's byte ceiling on a CHARACTER boundary so nothing ever goes out
    // half an emoji. It is the ANSWERS this exists for: a few paragraphs of prose passes 1000 bytes
    // easily, and carrying one back unclipped would refuse the lifter's next question with a 400
    // about a turn they never typed. On the QUESTIONS it is a no-op held for safety — `question(from:)`
    // is what admits one, and it refuses the long ones outright instead of trimming them down.
    public static func clipped(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count > maxTurnBytes else { return trimmed }
        var kept = ""
        var used = 0
        for character in trimmed {
            let width = String(character).utf8.count
            guard used + width <= maxTurnBytes else { break }
            kept.append(character)
            used += width
        }
        return kept
    }

    // THE COMPACT DIFF, and every word of it is the diff screen's own (`ProposalChange`), never a
    // second grammar for the same change. A card in the stream and the document it opens saying the
    // same removal two different ways is exactly the drift this product has one `Readout` to prevent.
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
                    // Unreachable: `Proposal.rows` drops every kept entry, because a row the routine
                    // already says is the document rather than a change.
                    return AskDiffRow(name: name, change: "unchanged")
                }
            }
        }
    }
}
