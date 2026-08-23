import Foundation
import WindmillPlatform

// Appends, corrections and deletions ride one walk. Android's SetQueue.kt is the same contract and
// the two must not drift. A client-minted id IS the idempotency key: a replay answers 200 with the
// stored row even after the session closed, so this queue may send in any order, any number of times.
// A set that never landed is refused once its session is finished, so the queue flushes before finish
// and before the boot read. Entries are keyed by identity, never by position; order is per session and
// movement, the only order the server keeps, so a set that cannot land holds up its own lane alone.
// Flushed to one atomic file; a file this build cannot read opens EMPTY.

public enum Owed: String, Codable, Sendable {
    case append     // the log has never seen this row
    case fix        // the log holds this row, and this device holds numbers it does not
    case delete     // the log holds this row, and this device has taken it back
}

public final class SetQueue {
    // The key the server numbers sets under.
    public struct Lane: Hashable, Sendable {
        public let sessionId: String
        public let exerciseId: String
    }

    public struct Entry: Equatable, Codable {
        public let set: TrainingSet
        public let sessionId: String
        public let needsPush: Bool
        public let remints: Int
        // The undo window the device keeps; a delete waits it out here. Optional: an older file has none.
        let heldUntilMs: Int64?
        // Optional the same way: in an older file every owed row is an append.
        let owedWrite: Owed?

        public var lane: Lane { Lane(sessionId: sessionId, exerciseId: set.exerciseId) }

        public var write: Owed { owedWrite ?? .append }

        public var owes: Owed? { needsPush ? write : nil }

        public func isHeld(at instant: Int64) -> Bool { (heldUntilMs ?? 0) > instant }
    }

    // Time spent offline spends none of the id collisions a set is allowed to survive.
    public static let maxRemints = 3

    // Android's window (SetQueue.kt) to the millisecond: both phones must agree.
    public static let undoWindowMs: Int64 = 9_000

    private struct Queue: Codable {
        var session: Session?
        var entries: [String: Entry]
        // Not derivable from the sets: a movement appended and not yet logged has none.
        var order: [String]?
        // Composed on this device with no account asked; the claim turns it false, and nil reads claimed.
        var unclaimed: Bool?
    }

    // One queue per seat, and the seat is the key: `open(under:)` names it and nothing else does.
    private struct Held: Codable {
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
    // The one key `open(under:)` can never name.
    static let quarantinedQueue = "quarantine"

    public init(url: URL = SetQueue.defaultURL(),
                deviceHolds: @escaping @autoclosure () -> String? = KeychainSessions().readUser()?.id) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
        retireThePreSeatQueue(heldBy: deviceHolds)
    }

    // A phone holding a session carries it under that lifter's seat; one holding none cannot say
    // whose workout it is, so it goes to the key no seat opens.
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

    // The first thing every connect does, before anything is drawn, delivered or claimed.
    public func open(under seat: String?) {
        key = seat.map { "u.\($0)" } ?? Self.anonymousQueue
    }

    // The session, its owed sets and its order move together; it waits if this seat is mid-workout.
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

    // A different session is a different workout, so the order is cleared rather than merged.
    public func hold(_ session: Session?, unclaimed: Bool = false) {
        if queue.session?.id != session?.id { queue.order = nil }
        queue.session = session
        queue.unclaimed = session == nil ? nil : unclaimed
    }

    // Every entry pinned to the old id follows, or the sets are owed against an id the log never knows.
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

    // A local id the live session references. Every repair moves the key and nothing else.
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

    // In the order performed.
    public var sets: [TrainingSet] {
        guard let live = queue.session else { return [] }
        return sets(in: live.id)
    }

    // A deleted row leaves here at once; its entry survives only to carry the DELETE.
    public func sets(in sessionId: String) -> [TrainingSet] {
        queue.entries.values
            .filter { $0.sessionId == sessionId && $0.owes != .delete }
            .map(\.set)
            .sorted { $0.completedAtMs < $1.completedAtMs }
    }

    // Oldest first by the instant performed, which makes the per-lane walk the server's own order.
    public var pending: [Entry] {
        queue.entries.values
            .filter(\.needsPush)
            .sorted { $0.set.completedAtMs < $1.set.completedAtMs }
    }

    public func owed(in sessionId: String) -> [Entry] {
        pending.filter { $0.sessionId == sessionId }
    }

    // A row owed as an append is one the log has never been told about.
    public func owes(_ id: String) -> Owed? {
        queue.entries[id]?.owes
    }

    // An entry inside its undo window is not offered at `readyAt`; a forced walk passes nil.
    public func nextOwed(skipping blocked: Set<Lane>, readyAt instant: Int64?) -> Entry? {
        pending.first { entry in
            guard !blocked.contains(entry.lane) else { return false }
            guard let instant else { return true }
            return !entry.isHeld(at: instant)
        }
    }

    // Appends only — a deletion is held on the same clock but taken back through its own door.
    public func withdrawable(at instant: Int64) -> Entry? {
        pending.filter { $0.isHeld(at: instant) && $0.owes == .append }.last
    }

    // Legal only while the set is still owed as an append.
    public func withdraw(_ id: String) -> Bool {
        guard let entry = queue.entries[id], entry.owes == .append else { return false }
        queue.entries[id] = nil
        return true
    }

    // One door for appends and settlements: a server row for a set this device owes settles it.
    public func store(_ set: TrainingSet, in sessionId: String, needsPush: Bool, heldUntilMs: Int64? = nil) {
        let remints = queue.entries[set.id]?.remints ?? 0
        queue.entries[set.id] = Entry(set: set, sessionId: sessionId, needsPush: needsPush,
                                     remints: remints, heldUntilMs: heldUntilMs, owedWrite: .append)
    }

    // The set as it should now read; the PATCH goes under the same id. There may have been no entry
    // at all, so the correction brings the whole row with it.
    public func fix(_ corrected: TrainingSet, in sessionId: String) {
        queue.entries[corrected.id] = Entry(set: corrected, sessionId: sessionId, needsPush: true,
                                           remints: 0, heldUntilMs: nil, owedWrite: .fix)
    }

    // The set stays owed as an append: a `fix` filed over it would replace the set's only copy.
    public func rewrite(_ corrected: TrainingSet, in sessionId: String) {
        let owed = queue.entries[corrected.id]
        queue.entries[corrected.id] = Entry(set: corrected, sessionId: sessionId, needsPush: true,
                                           remints: owed?.remints ?? 0,
                                           heldUntilMs: owed?.heldUntilMs, owedWrite: .append)
    }

    // The row leaves `sets` at once and the DELETE waits out the undo window: no route un-deletes a set.
    public func delete(_ set: TrainingSet, in sessionId: String, heldUntilMs: Int64) {
        queue.entries[set.id] = Entry(set: set, sessionId: sessionId, needsPush: true,
                                     remints: 0, heldUntilMs: heldUntilMs, owedWrite: .delete)
    }

    // Comes back owed as a correction: this device may hold numbers the log does not.
    public func restore(_ id: String) -> Bool {
        guard let entry = queue.entries[id], entry.owes == .delete else { return false }
        queue.entries[id] = Entry(set: entry.set, sessionId: entry.sessionId, needsPush: true,
                                 remints: entry.remints, heldUntilMs: nil, owedWrite: .fix)
        return true
    }

    // The row comes back under the id that went out; clearing the sent key stops a disagreeing reply
    // leaving an entry owed, resent, and owed again.
    public func delivered(_ stored: TrainingSet, for id: String, in sessionId: String) {
        queue.entries[id] = nil
        // Settled rows are kept for the live session alone: `close` and `forget` reach no other.
        guard queue.session?.id == sessionId else { return }
        queue.entries[stored.id] = Entry(set: stored, sessionId: sessionId, needsPush: false,
                                        remints: 0, heldUntilMs: nil, owedWrite: nil)
    }

    // The same set under a new key, still owed, budget counted down.
    public func remint(_ id: String, as fresh: String) {
        guard let entry = queue.entries.removeValue(forKey: id) else { return }
        // The fresh id carries no hold: the window was spent waiting for the send that collided.
        queue.entries[fresh] = Entry(set: entry.set.reminted(as: fresh), sessionId: entry.sessionId,
                                    needsPush: true, remints: entry.remints + 1, heldUntilMs: nil,
                                    owedWrite: entry.owedWrite)
    }

    public func drop(_ id: String) {
        queue.entries[id] = nil
    }

    // Delivered sets live on the log now; an owed set stays queued until the log answers for it.
    public func close(_ sessionId: String) {
        queue.entries = queue.entries.filter { $0.value.sessionId != sessionId || $0.value.needsPush }
        if queue.session?.id == sessionId { letGo() }
    }

    // Keeping an owed set would re-send it forever against an id the log no longer knows.
    public func forget(_ sessionId: String) {
        queue.entries = queue.entries.filter { $0.value.sessionId != sessionId }
        if queue.session?.id == sessionId { letGo() }
    }

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

// Read off the failure, never by elimination: `offline` is the transport failing, `logFailed` the log
// answering without taking it, `signInLapsed` a 401 under a signed-in room.
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

// The code is the contract; nothing here tells the 409s apart by string-comparing the sentence.
public enum Verdict: Equatable {
    case remint(String)     // 409 set-id-taken / session-id-taken — that id names a row elsewhere
    case dropped(String)    // 409 session-finished — this set never landed and never will
    case gone(String)       // 404 set-not-found — the row this write NAMES is not on the log
    case vanished(String)   // 404 no such session, for a session the log ONCE HELD — the workout is gone
    case refused(String)    // 400, any other 409 — this body will never land as written
    case retry              // 5xx, no reply at all, and everything that is only waiting

    // `sessionOnTheLog` decides what a plain 404 means: a session the log once held is gone, one still
    // unclaimed has simply not had its start land yet.
    public init(refusing error: Error, sessionOnTheLog: Bool = false) {
        // Neither a status nor a lost set: replay is free, so both keep the set queued.
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
        // An append's own 404 is a session not opened yet, so the walk asks which write it carries.
        if refusal.code == "set-not-found" {
            self = .gone("that set is no longer on the log")
            return
        }
        if status >= 500 {
            self = .retry
            return
        }
        if status == 400 || status == 409 {
            self = .refused(refusal.code == "unknown-exercise" ? "that movement is not in the catalog" : said)
            return
        }
        if status == 404, sessionOnTheLog {
            self = .vanished("that workout is no longer on the log")
            return
        }
        // 401 waits for a sign-in and 404 for a session to exist.
        self = .retry
    }

    // Nil while the set is still owed. A remint is terminal only once the repair budget is spent.
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

// The Identifiable id is the kind plus the document's id, never the name.
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

// Under `.set` this is the last copy of a set somebody lifted; under `.change` the log holds the row.
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

// A document the server refuses outright, let go from the shelf so it is not re-sent on every connect.
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
