import Foundation
import WindmillPlatform

// THE LOCAL-FIRST WRITE — a set is the lifter's the instant they tap, and the network's problem
// afterwards. This and Android's SetQueue.kt are the contract's two surviving statements — the
// same rules in two languages, pinned by gym ARCHITECTURE.md §11's verdict contract — and the two
// must not drift. (The web's flushQueue.js was the reference implementation until 2026-08-09; it
// went with the web logger.)
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
//
// SINCE 2026-08-12 THE QUEUE CARRIES MORE THAN APPENDS. §G18 lets a lifter correct or delete a set
// the log already holds, and both ride here rather than beside here: one walk, one retry cadence,
// one set of verdicts read by code, and one place a write can be lost instead of three.

// WHAT THIS DEVICE OWES THE LOG ABOUT ONE ROW. Until §G18 there was one verb and `needsPush` was the
// whole of it — a set was owed or it was settled — and the three cases below are what a client has to
// tell apart now, because the repair for each is different and using the wrong one loses training.
public enum Owed: String, Codable, Sendable {
    case append     // the log has never seen this row
    case fix        // the log holds this row, and this device holds numbers it does not
    case delete     // the log holds this row, and this device has taken it back
}

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
        // THE UNDO WINDOW, and it is a promise the DEVICE keeps rather than a request to the log.
        // A set still owed exists nowhere else, so withdrawing it costs nobody anything; §G18's
        // delete is the other half — a row the log already holds waits out the same window here
        // before the DELETE goes, because a destruction with no way back for nine seconds is the
        // one thing this product could get wrong that a lifter could not repair.
        //
        // Optional because a queue file written before the window existed has no such key, and a
        // synthesized decoder tolerates a missing key only for an optional — a file that failed to
        // decode opens EMPTY and takes a live session's sets down with it.
        let heldUntilMs: Int64?
        // WHICH WRITE THIS ROW IS. Optional for the same reason and read the same way: a file
        // written before §G18 has no such key and every owed row in it is an append.
        let owedWrite: Owed?

        public var lane: Lane { Lane(sessionId: sessionId, exerciseId: set.exerciseId) }

        public var write: Owed { owedWrite ?? .append }

        // The two facts as the one question every caller actually asks: what does this device still
        // have to say to the log about this row, or nothing at all.
        public var owes: Owed? { needsPush ? write : nil }

        public func isHeld(at instant: Int64) -> Bool { (heldUntilMs ?? 0) > instant }
    }

    // The repair budget is its own counter: a set that spent an hour offline has not spent any of
    // the three id collisions it is allowed to survive. Past this, the collision is not a coincidence
    // and re-minting forever would hammer the log instead of telling the lifter.
    public static let maxRemints = 3

    // Android's window (SetQueue.kt), to the millisecond: the two phones must agree on how long a
    // set can be taken back, or the same mistake is undoable on one phone and permanent on the
    // other.
    public static let undoWindowMs: Int64 = 9_000

    private struct Queue: Codable {
        var session: Session?
        var entries: [String: Entry]
        // The movements this session holds, in the order it will walk them — the plan's lines first,
        // then whatever was added on the bench mid-rest. It is not derivable from the sets, because
        // a movement appended and not yet logged has none, and that intention is exactly what
        // "no sets yet — logging one starts it" is drawing. Optional for the same reason Entry's
        // hold is: an older file must still open.
        var order: [String]?
        // Whether the live session was composed on this DEVICE with no account asked — the claim
        // replay is what turns it false. Optional so an older file still opens, and nil honestly
        // reads as claimed: every session before this flag existed was opened by the server.
        // (Android's SetQueue.kt reads an absent bit the other way, deliberately; the two are
        // documented as differing and nothing in this wave turns on it.)
        var unclaimed: Bool?
    }

    // ONE QUEUE PER SEAT, AND THE SEAT IS THE KEY — the shape the shelf next door has, for the same
    // reason. A live workout and its owed sets are one account's: before 2026-08-22 this file had no
    // seat in it, so the next person to open gym on a lent phone was shown the previous lifter's
    // workout, and their own sets went out against that session id under their own bearer, where the
    // log's 404 read as "the workout vanished" and the sets were dropped (audit MOBILE-3). The key
    // is named in `open(under:)` and nowhere else, so no read below can forget it — and A's workout
    // survives B's whole visit, because B's queue is a different key rather than the same slot.
    private struct Held: Codable {
        // The pre-seat queue, at the top level, from every build before 2026-08-22 — moved on the
        // first open under this code to whoever the device was HOLDING a session for, which is the
        // lifter whose workout it is (retireThePreSeatQueue). The one thing that must not happen to
        // somebody mid-workout on an upgrade is their session disappearing.
        var session: Session?
        var entries: [String: Entry]?
        var order: [String]?
        var unclaimed: Bool?
        var queues: [String: Queue]?
    }

    private let url: URL
    private var held: Held
    private var key = SetQueue.anonymousQueue

    static let anonymousQueue = "anon"
    // The one key `open(under:)` can never name — see LocalLog.quarantinedShelf.
    static let quarantinedQueue = "quarantine"

    public init(url: URL = SetQueue.defaultURL(),
                deviceHolds: @escaping @autoclosure () -> String? = KeychainSessions().readUser()?.id) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
        retireThePreSeatQueue(heldBy: deviceHolds)
    }

    // The shelf's rule, applied to the live workout: a phone still holding a session was being used
    // by that lifter when it upgraded, so the workout is theirs and carries on under their seat — the
    // mid-workout upgrade is whole and nobody is asked anything. A phone holding no session cannot
    // say whose workout this is, and a workout handed to the next account is the finding itself, so
    // it goes to the key no seat opens.
    private func retireThePreSeatQueue(heldBy deviceHolds: () -> String?) {
        guard held.session != nil || held.entries != nil || held.order != nil else { return }
        let landing = deviceHolds().map { "u.\($0)" } ?? Self.quarantinedQueue
        var queues = held.queues ?? [:]
        var theirs = queues[landing] ?? Queue(session: nil, entries: [:])
        theirs.session = theirs.session ?? held.session
        theirs.entries.merge(held.entries ?? [:]) { alreadyHeld, _ in alreadyHeld }
        theirs.order = theirs.order ?? held.order
        theirs.unclaimed = theirs.unclaimed ?? held.unclaimed
        queues[landing] = theirs
        held.queues = queues
        held.session = nil
        held.entries = nil
        held.order = nil
        held.unclaimed = nil
        flush()
    }

    // Opened under whoever is signed in — the first thing every connect does, before anything is
    // drawn, delivered or claimed.
    public func open(under seat: String?) {
        key = seat.map { "u.\($0)" } ?? Self.anonymousQueue
    }

    // The claim's half of the live session: a workout composed before anybody signed in follows the
    // person who signs in, whole — the session, its owed sets and its movement order together,
    // because they are one workout and half of it is not claimable.
    //
    // It waits if this seat is already mid-workout. Two live sessions cannot be drawn at once, and
    // the anonymous one is not lost by waiting: this seat's own workout ends, and the next connect
    // finds the anonymous queue exactly where it was.
    public func adoptTheAnonymousQueue() {
        guard key != Self.anonymousQueue, queue.session == nil,
              let anonymous = held.queues?[Self.anonymousQueue], anonymous.session != nil else { return }
        var mine = queue
        mine.session = anonymous.session
        mine.unclaimed = anonymous.unclaimed
        mine.order = anonymous.order
        mine.entries.merge(anonymous.entries) { alreadyHeld, _ in alreadyHeld }
        queue = mine
        held.queues?[Self.anonymousQueue] = nil
        flush()
    }

    private var queue: Queue {
        get { held.queues?[key] ?? Queue(session: nil, entries: [:]) }
        set {
            var queues = held.queues ?? [:]
            queues[key] = newValue
            held.queues = queues
        }
    }

    public var order: [String] { queue.order ?? [] }

    // Appending is a rest-time action, not a setup task: the movement joins the session the moment
    // it is chosen, before it has a set to its name.
    public func append(_ exerciseId: String) {
        guard !order.contains(exerciseId) else { return }
        queue.order = order + [exerciseId]
    }

    public func hold(order: [String]) {
        queue.order = order
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-sets.json")
    }

    public var session: Session? { queue.session }

    public var sessionIsUnclaimed: Bool { queue.session != nil && (queue.unclaimed ?? false) }

    // A different session is a different workout, so the movement order goes with the old one. It is
    // cleared rather than merged: the two lists share nothing, and carrying yesterday's movements
    // into today would draw a session the lifter never started.
    //
    // `unclaimed` defaults to false because every caller but one is holding a session the SERVER
    // answered with; only the anonymous local start passes true, and the claim's success passes
    // false again for the same id.
    public func hold(_ session: Session?, unclaimed: Bool = false) {
        if queue.session?.id != session?.id { queue.order = nil }
        queue.session = session
        queue.unclaimed = session == nil ? nil : unclaimed
    }

    // The claim reminted the live session's id (409 session-id-taken): the session row and every
    // entry pinned to the old id follow it, or the sets would be owed against an id the log will
    // never know.
    public func remapSession(_ old: String, to fresh: String) {
        queue.entries = queue.entries.mapValues { entry in
            guard entry.sessionId == old else { return entry }
            return Entry(set: entry.set, sessionId: fresh, needsPush: entry.needsPush,
                         remints: entry.remints, heldUntilMs: entry.heldUntilMs,
                         owedWrite: entry.owedWrite)
        }
        guard let live = queue.session, live.id == old else { return }
        queue.session = Session(id: fresh, startedAtMs: live.startedAtMs,
                               finishedAtMs: live.finishedAtMs, routineId: live.routineId,
                               plan: live.plan)
    }

    // The claim reminted a LOCAL id the live session still references — a routine, or a movement in
    // its sets, its walk order and its frozen plan's own lines. Every repair moves the key and
    // nothing else, exactly as `remint` does for a set's own id.
    public func remapRoutine(_ old: String, to fresh: String) {
        guard let live = queue.session, live.routineId == old else { return }
        queue.session = Session(id: live.id, startedAtMs: live.startedAtMs,
                               finishedAtMs: live.finishedAtMs, routineId: fresh, plan: live.plan)
    }

    public func remapExercise(_ old: String, to fresh: String) {
        queue.entries = queue.entries.mapValues { entry in
            guard entry.set.exerciseId == old else { return entry }
            let moved = TrainingSet(id: entry.set.id, exerciseId: fresh, setNumber: entry.set.setNumber,
                                    weightKg: entry.set.weightKg, reps: entry.set.reps,
                                    kind: entry.set.kind, rpe: entry.set.rpe, note: entry.set.note,
                                    completedAtMs: entry.set.completedAtMs)
            return Entry(set: moved, sessionId: entry.sessionId, needsPush: entry.needsPush,
                         remints: entry.remints, heldUntilMs: entry.heldUntilMs,
                         owedWrite: entry.owedWrite)
        }
        queue.order = queue.order.map { $0.map { $0 == old ? fresh : $0 } }
        guard let live = queue.session, let plan = live.plan,
              plan.entries.contains(where: { $0.exerciseId == old }) else { return }
        let entries = plan.entries.map { entry in
            guard entry.exerciseId == old else { return entry }
            return PlanEntry(exerciseId: fresh, sets: entry.sets, reps: entry.reps,
                             weightKg: entry.weightKg, restSeconds: entry.restSeconds)
        }
        queue.session = Session(id: live.id, startedAtMs: live.startedAtMs,
                               finishedAtMs: live.finishedAtMs, routineId: live.routineId,
                               plan: PlanSnapshot(routine: plan.routine, entries: entries))
    }

    // The open session's sets in the order they were performed — queued and delivered together,
    // because a row on this device is a set that happened whether or not the log has heard of it.
    public var sets: [TrainingSet] {
        guard let live = queue.session else { return [] }
        return sets(in: live.id)
    }

    // A row this device has DELETED is not in here from the instant the thumb lifts — its entry
    // survives only to carry the DELETE, and drawing it would be the screen disagreeing with the
    // move the lifter just made.
    public func sets(in sessionId: String) -> [TrainingSet] {
        queue.entries.values
            .filter { $0.sessionId == sessionId && $0.owes != .delete }
            .map(\.set)
            .sorted { $0.completedAtMs < $1.completedAtMs }
    }

    // Everything this device owes the log, oldest first — the queue a flush drains. Sorting by the
    // instant the set was performed is what makes the per-lane walk the server's own order.
    public var pending: [Entry] {
        queue.entries.values
            .filter(\.needsPush)
            .sorted { $0.set.completedAtMs < $1.set.completedAtMs }
    }

    public func owed(in sessionId: String) -> [Entry] {
        pending.filter { $0.sessionId == sessionId }
    }

    // What this device still owes the log about ONE row, asked by id because a caller holds a set
    // and not an entry. It is the question that tells §G18's two writes apart from the appends they
    // ride beside: a row still owed as an append is a row the log has never been told about, and a
    // PATCH or a DELETE naming it would be a write about nothing.
    public func owes(_ id: String) -> Owed? {
        queue.entries[id]?.owes
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
    //
    // APPENDS ONLY. A deletion is held on the same clock but is taken back through §G18's own door,
    // and offering it here would put "Logged 47.5 × 4" under a set nobody just logged.
    public func withdrawable(at instant: Int64) -> Entry? {
        pending.filter { $0.isHeld(at: instant) && $0.owes == .append }.last
    }

    // Taking a set back is only ever legal while it is still owed AS AN APPEND. Once the log holds
    // the row this returns false and says so, rather than deleting a set from the screen that the
    // account keeps.
    public func withdraw(_ id: String) -> Bool {
        guard let entry = queue.entries[id], entry.owes == .append else { return false }
        queue.entries[id] = nil
        return true
    }

    // One door for both directions: a set the lifter just logged (owed), and a row the log handed
    // back on a read (not owed). A server row arriving for a set this device owes SETTLES it — the
    // log holding the row IS delivery, however the news arrived. This door files APPENDS and
    // settlements; a correction and a deletion have their own, because each carries a different
    // repair and a shared door would take the verb as a parameter nobody could read at the call site.
    public func store(_ set: TrainingSet, in sessionId: String, needsPush: Bool, heldUntilMs: Int64? = nil) {
        let remints = queue.entries[set.id]?.remints ?? 0
        queue.entries[set.id] = Entry(set: set, sessionId: sessionId, needsPush: needsPush,
                                     remints: remints, heldUntilMs: heldUntilMs, owedWrite: .append)
    }

    // A CORRECTION THE LOG HAS NOT TAKEN YET (§G18). What lands here is the set as it should NOW
    // read, so every screen reading this queue draws the corrected numbers from the tap and a
    // relaunch does not hand the lifter back the number they just moved. The PATCH goes under the
    // same id and is idempotent, so a repeat costs nothing.
    //
    // There may have been no entry at all: a set of a session read back from the log has never been
    // in this queue. The correction brings the whole row with it, which is also what lets a refusal
    // say the numbers out loud.
    public func fix(_ corrected: TrainingSet, in sessionId: String) {
        queue.entries[corrected.id] = Entry(set: corrected, sessionId: sessionId, needsPush: true,
                                           remints: 0, heldUntilMs: nil, owedWrite: .fix)
    }

    // A CORRECTION TO A ROW THE LOG HAS NEVER SEEN (§G18, case 1) — the set still owed as an APPEND,
    // and the whole of the repair is that it stays one. What has to change is the write that is
    // still going out, not a row the server would have to be asked about: a `fix` filed over it
    // would replace the append that is the set's only copy, and the set would die on its way to a
    // log that never heard of it. The hold and the repair budget travel with the row — the window
    // belongs to the tap that logged the set, and a correction is not a second chance to spend an
    // id's collisions.
    public func rewrite(_ corrected: TrainingSet, in sessionId: String) {
        let owed = queue.entries[corrected.id]
        queue.entries[corrected.id] = Entry(set: corrected, sessionId: sessionId, needsPush: true,
                                           remints: owed?.remints ?? 0,
                                           heldUntilMs: owed?.heldUntilMs, owedWrite: .append)
    }

    // A DELETION, HELD. The row leaves `sets` at once and the DELETE waits out the undo window the
    // way a freshly logged set waits out its own — a delete that went immediately could not be taken
    // back by anything this device has, because the wire has no route that un-deletes a set.
    public func delete(_ set: TrainingSet, in sessionId: String, heldUntilMs: Int64) {
        queue.entries[set.id] = Entry(set: set, sessionId: sessionId, needsPush: true,
                                     remints: 0, heldUntilMs: heldUntilMs, owedWrite: .delete)
    }

    // The deletion taken back inside its window. What comes back is owed as a CORRECTION rather than
    // as nothing: this device may have been holding numbers the log does not have — a fix deleted
    // before it landed — and a PATCH that changes nothing answers the stored row anyway, where a
    // settle that guessed wrong would drop a correction silently.
    public func restore(_ id: String) -> Bool {
        guard let entry = queue.entries[id], entry.owes == .delete else { return false }
        queue.entries[id] = Entry(set: entry.set, sessionId: entry.sessionId, needsPush: true,
                                 remints: entry.remints, heldUntilMs: nil, owedWrite: .fix)
        return true
    }

    // The reply to a send. The row comes back under the id that went out — always, because that id
    // is the idempotency key — and clearing the SENT key anyway is what stops a reply that ever
    // disagreed from leaving an entry owed, resent, and owed again forever.
    public func delivered(_ stored: TrainingSet, for id: String, in sessionId: String) {
        queue.entries[id] = nil
        // A SETTLED ROW IS KEPT FOR THE LIVE SESSION AND NOTHING ELSE, because that is the session
        // this queue draws. A correction to a session that is already history has nothing left to
        // say once it lands — and nobody would ever collect it: `close` and `forget` run for the
        // live session alone, so a settled row filed here for a past one would sit in the file
        // forever, one more on every correction ever made, in a file rewritten on every tap.
        guard queue.session?.id == sessionId else { return }
        queue.entries[stored.id] = Entry(set: stored, sessionId: sessionId, needsPush: false,
                                        remints: 0, heldUntilMs: nil, owedWrite: nil)
    }

    // The one repair a spent id allows: the same set under a new key, still owed, with the budget
    // counted down. Everything the lifter did travels unchanged.
    public func remint(_ id: String, as fresh: String) {
        guard let entry = queue.entries.removeValue(forKey: id) else { return }
        // The fresh id carries no hold: the window was spent waiting for the send that collided, and
        // a set the lifter stopped watching nine seconds ago must not wait another nine to land.
        queue.entries[fresh] = Entry(set: entry.set.reminted(as: fresh), sessionId: entry.sessionId,
                                    needsPush: true, remints: entry.remints + 1, heldUntilMs: nil,
                                    owedWrite: entry.owedWrite)
    }

    public func drop(_ id: String) {
        queue.entries[id] = nil
    }

    // A session that is over. Its delivered sets live on the log now, so this device stops holding
    // them — but an owed set is dropped by nobody quietly: it stays queued until the log answers for
    // it, and a `session-finished` refusal is what tells the lifter it never landed.
    public func close(_ sessionId: String) {
        queue.entries = queue.entries.filter { $0.value.sessionId != sessionId || $0.value.needsPush }
        if queue.session?.id == sessionId { letGo() }
    }

    // A session that no longer exists. Discard deletes the row out from under whatever this device
    // still held, and that is the one case where an owed set has nowhere left to go — keeping it
    // would re-send it against a session id the log no longer knows, forever.
    public func forget(_ sessionId: String) {
        queue.entries = queue.entries.filter { $0.value.sessionId != sessionId }
        if queue.session?.id == sessionId { letGo() }
    }

    // The session row, its movement order, its claim state and its seat are one fact and end
    // together — an order left standing over no session is a list of movements belonging to a
    // workout that is over.
    private func letGo() {
        queue.session = nil
        queue.order = nil
        queue.unclaimed = nil
    }

    public func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

// WHAT IS KEEPING A SET ON THIS DEVICE, once the walk has offered it and the log did not take it.
// Three different facts and three different sentences: the transport failed (there is no signal
// down here); the log answered without taking it (a 5xx, an unreadable reply, a lane its own words
// blocked — the log's own trouble, and it clears when the log does); the account's session lapsed
// under a signed-in room (a 401 — nothing lands until the lifter signs in again). It is read off
// the FAILURE and never by elimination: a strip that said "no signal" over a 500 pointed the
// lifter at the wrong thing entirely.
public enum Stall: Equatable {
    case offline
    case logFailed
    case signInLapsed

    public init(_ error: Error) {
        guard let failure = error as? WindmillApiError else {
            self = .logFailed
            return
        }
        if case .offline = failure {
            self = .offline
            return
        }
        self = failure.isUnauthorized ? .signInLapsed : .logFailed
    }
}

// THE SIX VERDICTS, and none of them is guesswork about English. The code is the contract; the
// sentence is copy for a human reading a banner, and it may be reworded any day — a queue that told
// the 409s apart by string-comparing it degrades to "terminal, reason unknown" the first time one is
// edited, and drops a set it should have minted a fresh id for.
public enum Verdict: Equatable {
    case remint(String)     // 409 set-id-taken / session-id-taken — that id names a row elsewhere
    case dropped(String)    // 409 session-finished — this set never landed and never will
    case gone(String)       // 404 set-not-found — the row this write NAMES is not on the log
    case vanished(String)   // 404 no such session, for a session the log ONCE HELD — the workout is gone
    case refused(String)    // 400, any other 409 — this body will never land as written
    case retry              // 5xx, no reply at all, and everything that is only waiting

    // `sessionOnTheLog` is whether the log has ever answered for this write's session — a session
    // this device holds as CLAIMED. It decides what a plain 404 means: for a session the log once
    // held, the workout has been discarded elsewhere and no amount of waiting brings it back; for a
    // session still unclaimed, the 404 is a start that has not landed yet, and the set waits.
    public init(refusing error: Error, sessionOnTheLog: Bool = false) {
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
        // The word §G18 had to add, and it is a 404 that means the opposite of the retryable one at
        // the foot of this initialiser. A correction or a deletion NAMES a row that must already be
        // there; `set-not-found` says it is not, and no amount of waiting will put it back. Nothing
        // is lost but the change — the log still holds whatever it had.
        //
        // It is a CHANGE'S word. Today's log emits it from one handler (fixSet) and an append's own
        // 404 is a session that has not been opened yet, which waits — but nothing on either side of
        // the wire pins that, so the WALK asks which write it is carrying before it treats this as
        // terminal. A set is never lost to a code it was not sent.
        if refusal.code == "set-not-found" {
            self = .gone("that set is no longer on the log")
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
        // A 404 FOR A SESSION THE LOG ONCE HELD is the workout being gone — discarded from another
        // surface — and it is terminal and SAID: a set retried every four seconds against a session
        // that will never come back is a set labelled "offline · saved here" under a healthy
        // connection, forever.
        if status == 404, sessionOnTheLog {
            self = .vanished("that workout is no longer on the log")
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
        case .dropped(let said), .refused(let said), .gone(let said), .vanished(let said):
            return said
        }
    }
}

// What is SAID when a write is lost for good — the one surface every loss rides, because a loss
// dropped quietly would count as intended. Three shapes, one banner: a set that never landed carries
// its numbers, a CHANGE to a set that did carries the numbers it was trying to reach, and a
// claim-level document (a movement, a routine) has none, so it is said under its NAME — Android's
// RefusedWrite in SetQueue.kt. The Identifiable id is this side's own need — ForEach keys the rows
// by it, so it is the kind plus the DOCUMENT's id, never the name: two same-named losses are two
// rows, not one drawn twice.
public enum RefusedWrite: Equatable, Identifiable, Sendable {
    case set(RefusedSet)
    case change(RefusedSet)
    case claim(RefusedClaim)

    public var id: String {
        switch self {
        case .set(let set): return set.id
        case .change(let set): return "change-\(set.id)"
        case .claim(let claim): return "claim-\(claim.id)"
        }
    }

    public var reason: String {
        switch self {
        case .set(let set), .change(let set): return set.reason
        case .claim(let claim): return claim.reason
        }
    }
}

// The numbers a write was carrying when it was lost, kept so it can be said out loud. Under `.set`
// this is the LAST COPY of a set somebody lifted — "82.5 × 8 never reached the log" is unloggable
// again without knowing of what. Under `.change` it is not: the log still holds that row, under the
// numbers the lifter was trying to move it off. One struct, because both losses are said the same
// way — a movement and an effort — and only the sentence over them differs.
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

// The claim's own loss: a movement or routine document the server refuses outright, let go from the
// shelf so the same terminal write is not re-sent on every connect. It keeps the document's own id —
// never shown, but the banner keys its rows by it.
public struct RefusedClaim: Equatable, Sendable {
    public let id: String
    public let name: String
    public let reason: String

    public init(id: String, name: String, reason: String) {
        self.id = id
        self.name = name
        self.reason = reason
    }
}
