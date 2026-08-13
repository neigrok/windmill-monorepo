import Foundation

// ASK HAS A PAST (§O, screen 33) — the conversations the server now keeps, and everything this
// surface is allowed to say about one. It is the reversal of W7, which built Ask stateless on
// purpose: there was no conversation table and the client resent the whole thread with every
// question. The reason for the reversal is a product one and it is the board's own — a conversation
// about your bench plateau is worth more in six weeks than it was that evening.
//
// THE LIST IS NOT A CHAT INBOX. A row is the question IN THE LIFTER'S OWN WORDS plus what came of
// it, because that is what somebody comes back looking for. The title is the first message VERBATIM
// — never a summary a model wrote about somebody — so nothing in this file shortens, cleans or
// re-punctuates it, and the row draws it as it was typed.
//
// EVERY DETAIL A ROW STATES IS SOMETHING THE SERVER OBSERVED. `outcome` is DERIVED on the server
// from the proposals the thread minted (`outcomeOf()`, backend/products/gym/domain/Thread.cpp), so
// the count and the routine on a row are ledger facts. The board draws a dismissed row reading
// `built it myself instead` and THAT LINE IS NOT BUILT: nothing observes why a lifter dismissed a
// proposal and this product does not ask, so a row that said it would be us narrating a motive onto
// somebody's evening — one line under the rule that a thread is titled by your own words and never
// by a story told about you. A dismissed row carries WHAT was dismissed and nothing about why. The
// board's line is filed as a drift-ledger item rather than corrected silently.
//
// AND IT IS NOT AN INBOX IN ANY OF THE WAYS ONE GROWS: no unread count, no badge, no notification,
// no auto-title, no folders, no pinning, and no search — §O refuses search-by-model, and a filter
// over the lifter's own words is not drawn. Nothing here resurfaces a thread on its own; the list is
// read when a lifter walks to it.

// ONE TURN, as the wire spells it. The two voices are `lifter` and `ask` and never
// `user`/`assistant` — the transport's vocabulary is not this product's.
//
// IT TRAVELS ONE WAY NOW, INWARD, and that is the whole shape of the reversal: a question goes out
// as `{ thread, question }` and the server assembles the prompt from what it stored, so the
// conversation a lifter reads back is the one the model actually saw. Turns are only ever decoded.
//
// The voices are a CLOSED enum with no lenient default, for the reason Proposal.swift states about
// its own: a word this build has never heard of would put the wrong name on somebody's sentence,
// and mislabelling who said a thing is worse than failing to draw it.
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

// WHAT CAME OF A CONVERSATION, folded on the server out of the proposals that rode with it — never
// stored as a column, because the proposals ARE the outcome and a second copy would go stale the
// first time a lifter applied one from the routine screen instead.
//
// The kind is lenient where `ProposalState` is strict, and the difference is what each one decides:
// a kind this build has never heard of picks a SENTENCE, and the honest fallback is to say less —
// where an unknown proposal state would put the wrong control under a tap.
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

    // THE ROW'S SECOND LINE, and every word of it is a fact the ledger holds: a count, and the
    // routine the changes landed in when they all landed in one. Both the routine and its id are
    // absent when the changes spanned more than one, and the line then says the count alone rather
    // than naming whichever routine came first.
    //
    // NOTHING HERE SAYS WHY. The dismissed line is the one the board draws a motive on, and it
    // carries the count instead — see the head of this file.
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
            // A kind from a server this build is older than. The count is still a fact and still
            // worth printing; the verb is not ours to guess, and no line at all beats a wrong one.
            return changes > 0 ? Readout.changeCount(changes) : ""
        }
    }

    // The chip beside it, and it is the SAME word the line uses so a row never labels itself one way
    // and describes itself another. The fourth state is SET ASIDE and not the wire's `superseded`,
    // because that is the room's settled word for it (`ProposalState.word`, Proposal.swift: the
    // lifter superseded nothing — their own hand landed on the routine first) and because the thread
    // detail draws this line inches above a `ThreadProposal` row that already says it. One screen,
    // one word.
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

    // Whether the row is drawn in the accent — the board marks an applied thread and leaves the rest
    // quiet, because an applied one is the only outcome that changed the lifter's program.
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

// ONE PROPOSAL A THREAD MINTED, as the thread read spells it — a `ProposalHead` plus the one thing a
// head lacks and the one thing this row says out loud, the routine's NAME. The detail draws these as
// doors onto the diffs themselves, which is where a pending one can still be applied.
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

    // `4 changes to Push A · Applied`. The state is the LOG's word for it and never this list's
    // memory of what was tapped: a proposal settled from the web while this room was open reads
    // settled here too.
    public var line: String {
        "\(Readout.changeCount(changeCount)) to \(routine) · \(state.word)"
    }

    enum CodingKeys: String, CodingKey {
        case id, state, changeCount, routineId, routine
        case createdAtMs = "createdAt"
    }
}

// ONE CONVERSATION. `turns` rides only on the single-thread read — the list carries titles and
// outcomes and no prose at all — so an absent `turns` is "this came off the list" and never "this
// conversation was empty".
public struct AskThread: Equatable, Decodable, Sendable, Identifiable {
    public let id: String
    // THE LIFTER'S FIRST MESSAGE, BYTE FOR BYTE, punctuation and emoji included. Written once by the
    // server on the thread's insert and never rewritten, and drawn here exactly as it arrived.
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

// A MONTH'S WORTH OF ROWS under one heading, in the order the server sent them. The list arrives
// newest-asked first and stays that way: runs of one month are gathered as they pass, so nothing on
// this device decides the order a training history is read in.
public struct ThreadMonth: Equatable, Sendable, Identifiable {
    public let label: String
    public let threads: [AskThread]

    public var id: String { label }
}

public enum AskThreads {
    public static let title = "Threads"
    public static let door = "Threads"
    public static let askSomethingNew = "Ask something new"

    // How many rows the LIST READ SERVES, which is not the same number as how many conversations an
    // account has: the read is capped (`kThreadList`, backend/products/gym/domain/Thread.h) and the
    // reply carries no total, so at the cap `9 conversations` would be this screen asserting
    // something the server never said. A full page says `200+` — that many at least, which is the
    // most this device knows — and anything short of the cap is the exact count, because a short
    // page is the whole list.
    public static let served = 200

    // `9 conversations · yours to delete`. The second half is the promise §O makes and the delete on
    // the detail keeps — and it is a plain fact rather than a reassurance, because the thing it does
    // NOT delete is the interesting half (see `deleteNote`).
    public static func meta(_ count: Int) -> String {
        if count == 1 { return "1 conversation · yours to delete" }
        if count >= served { return "\(served)+ conversations · yours to delete" }
        return "\(count) conversations · yours to delete"
    }

    // What the list says before there is anything in it. It DESCRIBES THE SURFACE and does not
    // speak first — the empty state of a chat that opens by being asked something is the one place
    // a room is most tempted to write an opening line, and Ask has none anywhere.
    public static let empty = """
        Nothing here yet. A question you ask lands here in your own words, with what came of it — \
        so a conversation about a plateau is still findable in six weeks.
        """

    public static let delete = "Delete this conversation"

    // THE ONE SENTENCE THAT MAKES THE DELETE HONEST. Deleting takes the conversation and not the
    // consequence: an applied change stays in the routine's history, because that is a fact about a
    // program rather than a message. The routine's history row goes on saying the change came from
    // Ask; it simply stops opening a conversation that is gone.
    public static let deleteNote = """
        The conversation goes for good. A change you applied stays in the routine’s history — that \
        is a fact about your program, not a message.
        """

    public static let reading = "reading your conversations…"

    // The row on a routine's History that opens the conversation a change came from. It is offered
    // only where the wire carried a thread id: absent means there is nothing to open — the MCP door,
    // or a thread this lifter deleted — and a door onto neither would be worse than no door.
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
