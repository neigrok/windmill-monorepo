import Foundation
import WindmillPlatform

// THE LOCAL-FIRST WRITE — a set is the lifter's the instant they tap, and the network's problem
// afterwards. This is the Swift statement of web/src/products/gym/logger/flushQueue.js, the same
// contract in another language, and the two must not drift.
//
// Every set carries a CLIENT-MINTED id, which IS the idempotency key: a replay of a set that already
// landed answers 200 with the stored row, even after the session closed, so this queue can send in
// any order, any number of times, and the log converges on one row per id.
//
// The whole thing is held in memory (a workout is a few dozen rows) and flushed to ONE atomic file,
// so a read during a draw is never disk-bound and a file this build cannot read opens EMPTY rather
// than taking the app down with it. What it holds is the live session, that session's sets, and the
// sets that are still owed — which is everything a relaunch needs to carry on from.
//
// Two rules decide the shape of the walk, and each of them is a set somebody lifted:
//   · BY IDENTITY, NEVER BY POSITION. Entries are keyed by the minted set id and found again by it
//     or not at all — a send is in the air while the thumb keeps running, so the head that comes
//     back is not the head that went out.
//   · ORDER IS PER SESSION AND MOVEMENT, because that is the only order the server keeps: it numbers
//     sets max+1 per (session, exercise). A set that cannot land holds up its own LANE and nothing
//     else. A jam that stopped the whole queue stopped a whole workout, silently.
//
// And the rule the backend made non-negotiable: a set that never landed is REFUSED once the session
// is finished. So the queue flushes BEFORE finish and before the boot read, and a refusal is
// reported rather than counted as delivered.

public final class SetQueue {
    // The key the server numbers sets under. A struct rather than an interpolated string because
    // then it is provably collision-free instead of collision-free by an id's spelling.
    public struct Lane: Hashable, Sendable {
        public let sessionId: String
        public let exerciseId: String
    }

    public struct Entry: Equatable, Codable {
        public let set: TrainingSet
        public let sessionId: String
        public let needsPush: Bool
        public let remints: Int
        // THE UNDO WINDOW, and it is a promise the DEVICE keeps rather than a request to the log:
        // the log is append-only and has no route that takes a set back, so the only moment a
        // mis-tapped set can be withdrawn is while this device is still the only place it exists.
        //
        // Optional because a queue file written before the window existed has no such key, and a
        // synthesized decoder tolerates a missing key only for an optional — a file that failed to
        // decode opens EMPTY and takes a live session's sets down with it.
        let heldUntilMs: Int64?

        public var lane: Lane { Lane(sessionId: sessionId, exerciseId: set.exerciseId) }

        public func isHeld(at instant: Int64) -> Bool { (heldUntilMs ?? 0) > instant }
    }

    // The repair budget is its own counter: a set that spent an hour offline has not spent any of
    // the three id collisions it is allowed to survive. Past this, the collision is not a coincidence
    // and re-minting forever would hammer the log instead of telling the lifter.
    public static let maxRemints = 3

    // The web's own window (flushQueue.js), to the millisecond: the two surfaces must agree on how
    // long a set can be taken back, or the same mistake is undoable on one phone and permanent on
    // the other.
    public static let undoWindowMs: Int64 = 9_000

    private struct Held: Codable {
        var session: Session?
        var entries: [String: Entry]
        // The movements this session holds, in the order it will walk them — the plan's lines first,
        // then whatever was added on the bench mid-rest. It is not derivable from the sets, because
        // a movement appended and not yet logged has none, and that intention is exactly what
        // "no sets yet — logging one starts it" is drawing. Optional for the same reason Entry's
        // hold is: an older file must still open.
        var order: [String]?
    }

    private let url: URL
    private var held: Held

    public init(url: URL = SetQueue.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held(session: nil, entries: [:])
    }

    public var order: [String] { held.order ?? [] }

    // Appending is a rest-time action, not a setup task: the movement joins the session the moment
    // it is chosen, before it has a set to its name.
    public func append(_ exerciseId: String) {
        guard !order.contains(exerciseId) else { return }
        held.order = order + [exerciseId]
    }

    public func hold(order: [String]) {
        held.order = order
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-sets.json")
    }

    public var session: Session? { held.session }

    // A different session is a different workout, so the movement order goes with the old one. It is
    // cleared rather than merged: the two lists share nothing, and carrying yesterday's movements
    // into today would draw a session the lifter never started.
    public func hold(_ session: Session?) {
        if held.session?.id != session?.id { held.order = nil }
        held.session = session
    }

    // The open session's sets in the order they were performed — queued and delivered together,
    // because a row on this device is a set that happened whether or not the log has heard of it.
    public var sets: [TrainingSet] {
        guard let live = held.session else { return [] }
        return sets(in: live.id)
    }

    public func sets(in sessionId: String) -> [TrainingSet] {
        held.entries.values
            .filter { $0.sessionId == sessionId }
            .map(\.set)
            .sorted { $0.completedAtMs < $1.completedAtMs }
    }

    // Everything this device owes the log, oldest first — the queue a flush drains. Sorting by the
    // instant the set was performed is what makes the per-lane walk the server's own order.
    public var pending: [Entry] {
        held.entries.values
            .filter(\.needsPush)
            .sorted { $0.set.completedAtMs < $1.set.completedAtMs }
    }

    public func owed(in sessionId: String) -> [Entry] {
        pending.filter { $0.sessionId == sessionId }
    }

    // `readyAt` is the instant the walk is standing at, and an entry still inside its undo window is
    // not offered at it. A forced walk passes `nil`: a finish, a boot read and a room being left all
    // end the window, because each of them is the moment the gesture the window protects has left
    // the screen.
    public func nextOwed(skipping blocked: Set<Lane>, readyAt instant: Int64?) -> Entry? {
        pending.first { entry in
            guard !blocked.contains(entry.lane) else { return false }
            guard let instant else { return true }
            return !entry.isHeld(at: instant)
        }
    }

    // The one set that can still be taken back: the newest one this device is holding for its own
    // window. Newest rather than oldest because Undo answers the tap the lifter just made.
    public func withdrawable(at instant: Int64) -> Entry? {
        pending.filter { $0.isHeld(at: instant) }.last
    }

    // Taking a set back is only ever legal while it is still owed. Once the log holds the row this
    // returns false and says so, rather than deleting a set from the screen that the account keeps.
    public func withdraw(_ id: String) -> Bool {
        guard let entry = held.entries[id], entry.needsPush else { return false }
        held.entries[id] = nil
        return true
    }

    // One door for both directions: a set the lifter just logged (owed), and a row the log handed
    // back on a read (not owed). A server row arriving for a set this device owes SETTLES it — the
    // log holding the row IS delivery, however the news arrived.
    public func store(_ set: TrainingSet, in sessionId: String, needsPush: Bool, heldUntilMs: Int64? = nil) {
        let remints = held.entries[set.id]?.remints ?? 0
        held.entries[set.id] = Entry(set: set, sessionId: sessionId, needsPush: needsPush,
                                     remints: remints, heldUntilMs: heldUntilMs)
    }

    // The reply to a send. The row comes back under the id that went out — always, because that id
    // is the idempotency key — and clearing the SENT key anyway is what stops a reply that ever
    // disagreed from leaving an entry owed, resent, and owed again forever.
    public func delivered(_ stored: TrainingSet, for id: String, in sessionId: String) {
        held.entries[id] = nil
        held.entries[stored.id] = Entry(set: stored, sessionId: sessionId, needsPush: false,
                                        remints: 0, heldUntilMs: nil)
    }

    // The one repair a spent id allows: the same set under a new key, still owed, with the budget
    // counted down. Everything the lifter did travels unchanged.
    public func remint(_ id: String, as fresh: String) {
        guard let entry = held.entries.removeValue(forKey: id) else { return }
        // The fresh id carries no hold: the window was spent waiting for the send that collided, and
        // a set the lifter stopped watching nine seconds ago must not wait another nine to land.
        held.entries[fresh] = Entry(set: entry.set.reminted(as: fresh), sessionId: entry.sessionId,
                                    needsPush: true, remints: entry.remints + 1, heldUntilMs: nil)
    }

    public func drop(_ id: String) {
        held.entries[id] = nil
    }

    // A session that is over. Its delivered sets live on the log now, so this device stops holding
    // them — but an owed set is dropped by nobody quietly: it stays queued until the log answers for
    // it, and a `session-finished` refusal is what tells the lifter it never landed.
    public func close(_ sessionId: String) {
        held.entries = held.entries.filter { $0.value.sessionId != sessionId || $0.value.needsPush }
        if held.session?.id == sessionId { letGo() }
    }

    // A session that no longer exists. Discard deletes the row out from under whatever this device
    // still held, and that is the one case where an owed set has nowhere left to go — keeping it
    // would re-send it against a session id the log no longer knows, forever.
    public func forget(_ sessionId: String) {
        held.entries = held.entries.filter { $0.value.sessionId != sessionId }
        if held.session?.id == sessionId { letGo() }
    }

    // The session row and its movement order are one fact and end together — an order left standing
    // over no session is a list of movements belonging to a workout that is over.
    private func letGo() {
        held.session = nil
        held.order = nil
    }

    public func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

// THE FOUR VERDICTS, and none of them is guesswork about English. The code is the contract; the
// sentence is copy for a human reading a banner, and it may be reworded any day — a queue that told
// the 409s apart by string-comparing it degrades to "terminal, reason unknown" the first time one is
// edited, and drops a set it should have minted a fresh id for.
public enum Verdict: Equatable {
    case remint(String)     // 409 set-id-taken / session-id-taken — that id names a row elsewhere
    case dropped(String)    // 409 session-finished — this set never landed and never will
    case refused(String)    // 400, any other 409 — this body will never land as written
    case retry              // 5xx, no reply at all, and everything that is only waiting

    public init(refusing error: Error) {
        // A transport failure arrives as `.offline` and a reply this build could not read arrives as
        // `.malformed`. Neither is a status and neither is a lost set: replay is free, so both keep
        // the set queued.
        guard let failure = error as? WindmillApiError,
              case .refused(let status, let refusal) = failure else {
            self = .retry
            return
        }
        let said = refusal.message ?? "the log refused this set"
        if refusal.code == "set-id-taken" || refusal.code == "session-id-taken" {
            self = .remint(said)
            return
        }
        if refusal.code == "session-finished" {
            self = .dropped("the session closed before this set reached it")
            return
        }
        // The 500 is the server's and is retryable — a dropped connection, a statement timeout, a
        // deadlock. The 400s and the remaining 409s are the client's and are terminal: retrying an
        // unreadable body never makes it readable.
        if status >= 500 {
            self = .retry
            return
        }
        if status == 400 || status == 409 {
            self = .refused(refusal.code == "unknown-exercise" ? "that movement is not in the catalog" : said)
            return
        }
        // 401 waits for a sign-in and 404 for a session to exist. Terminal and retryable never both
        // hold, and neither follows from the other's absence — a queue that read "not retryable" as
        // "lost" would throw away a set that was only waiting for the Keychain to come back.
        self = .retry
    }

    // The sentence to SAY, or nil while the set is still owed. A remint is terminal only once the
    // repair budget is spent, and then it surrenders under the log's own words rather than a
    // sentence this file invented for a case nobody has ever seen.
    public func terminalReason(afterRemints remints: Int) -> String? {
        switch self {
        case .retry:
            return nil
        case .remint(let said):
            return remints < SetQueue.maxRemints ? nil : said
        case .dropped(let said), .refused(let said):
            return said
        }
    }
}

// A set that never landed, kept so it can be said out loud. The movement and the numbers travel with
// the reason because this is the LAST COPY of a set somebody lifted — "82.5 × 8 never reached the
// log" is unloggable again without knowing of what.
public struct RefusedSet: Equatable, Identifiable, Sendable {
    public let id: String
    public let exerciseId: String
    public let weightKg: Double
    public let reps: Int
    public let reason: String

    public init(_ set: TrainingSet, reason: String) {
        id = set.id
        exerciseId = set.exerciseId
        weightKg = set.weightKg
        reps = set.reps
        self.reason = reason
    }
}
