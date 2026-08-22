import Foundation
import WindmillPlatform

// THE LOG AS THIS DEVICE HOLDS IT — everything gym made before anybody signed in: finished sessions
// with their sets, routines, movements minted from the picker, and the settings the room is set up
// with (§I — the rest dial and the reading unit, which the logger reads on the first frame of every
// launch, signed in or not). The room works out of this file
// signed out (auth canon §2, "claiming, not gating"), and signing in CLAIMS it — the replay in
// TrainingStore walks these shelves oldest first and empties them as the log answers, the same shape
// journal's PageStore.claimWhatIsOwed gives its pages.
//
// The settings shelf is the one that also carries WHOSE it is, because it is the one a claim does not
// empty: a session lands on the log and leaves this file, while a document goes on being held here as
// the copy every cold launch draws from. See `open(preferencesUnder:)`.
//
// It sits beside the queue, not inside it: `windmill-gym-sets.json` is the LIVE session and is
// flushed on every tap; a finished session is history and is written once. The queue's file keeps
// its name and its shape — GymDevice reads it directly — and this one follows the same two rules:
// whole-file atomic writes, and a file this build cannot read opens EMPTY rather than taking the
// room down with it.
//
// The reads at the foot of the file are what THIS DEVICE answers — recent sessions, the last-time
// prefill, the review of a finished session, one movement's record — computed from the held sessions
// by the same rules the server states, minus the one number this device refuses to invent: Epley
// lives in one place per language and this is not it, so no local read carries an estimate, and
// every screen that would draw one draws nothing and says where it is computed.
//
// Signed out they answer everything, because there is no other log. Signed in they still answer for
// whatever is still on these shelves — a session, or a movement whose create is still owed — because
// the account's log has never heard of it and would answer a 404 over something that is on screen.

public final class LocalLog {
    public struct LocalSession: Equatable, Codable {
        public var session: Session
        public var sets: [TrainingSet]

        public init(session: Session, sets: [TrainingSet]) {
            self.session = session
            self.sets = sets
        }
    }

    // Every shelf optional, deliberately: a file written by a build with fewer shelves must not
    // decode to empty — the same backward-decodability rule the queue's Held obeys.
    private struct Shelf: Codable {
        var sessions: [LocalSession]?
        var routines: [Routine]?
        var exercises: [ExerciseWrite]?
    }

    // ONE SHELF PER SEAT, AND THE SEAT IS THE KEY. A training session is one account's, and a phone
    // lent to the next lifter must not replay the first one's workout into the second one's log —
    // which is exactly what it did until 2026-08-22: a session composed on the device while A was
    // signed in but unreachable was claimed by whichever account signed in next, and A's owed sets
    // were re-sent under B's bearer, refused as vanished, and dropped (audit MOBILE-3).
    //
    // The seat is the KEY rather than a column, and `open(under:)` is the only place that names it,
    // so no read below can forget the filter — the same shape the journal's per-seat cache file has
    // and the same one Android's shelves took. `anon` is the shelf everything made before anybody
    // signed in lives on, and it is the one the claim carries.
    private struct Held: Codable {
        // The pre-seat shelves, written at the top level by every build before 2026-08-22. Read once
        // on the first open under this code and moved to whoever the device was HOLDING a session
        // for — see retireThePreSeatShelves. Never dropped: this device is the only copy of a
        // session and a program, and a lifter mid-workout on the upgrade must not find them gone.
        var sessions: [LocalSession]?
        var routines: [Routine]?
        var exercises: [ExerciseWrite]?
        var shelves: [String: Shelf]?
        var preferences: GymPreferences?
        var preferencesOwed: Bool?
        var preferencesSeat: String?
    }

    // Mirrors backend/products/gym/domain/Review.h kSlightWorkingSets — the one threshold the local
    // review needs, restated because the domain lives server-side and a session finished in a
    // basement still deserves the honest word over it.
    static let slightWorkingSets = 4

    private let url: URL
    private var held: Held
    private var key = LocalLog.anonymousShelf

    static let anonymousShelf = "anon"
    // The one key `open(under:)` can never name — a seat is `anon` or `u.<id>`, and nothing else.
    // What lands here is reachable by nobody until a person says otherwise.
    static let quarantinedShelf = "quarantine"

    // `deviceHolds` answers the one question the migration below turns on: WHOSE SESSION IS THIS
    // DEVICE HOLDING. It is the Keychain's answer, asked lazily, because on every launch after the
    // upgrade there is nothing to migrate and the Keychain is never touched.
    public init(url: URL = LocalLog.defaultURL(),
                deviceHolds: @escaping @autoclosure () -> String? = KeychainSessions().readUser()?.id) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
        retireThePreSeatShelves(heldBy: deviceHolds)
    }

    // THE ONE MIGRATION, RUN ONCE, and the question it has to answer is whose these rows are. There
    // is one honest source for that and it is not the shelf: it is WHOSE SESSION THIS DEVICE HOLDS.
    // A phone still holding a session was being used by that lifter when it upgraded — the sessions,
    // the program and the movements on it are theirs, and they land on their shelf, still owed, so
    // the claim sends them and nobody is asked anything.
    //
    // A phone holding NO session cannot say. "Nobody is signed in now" is not "nobody trained here":
    // it is just as likely to be the last account's work after a sign-out, and adopting it as
    // anonymous would replay one lifter's workout into the next account that signs in — MOBILE-3
    // itself, with the migration doing the leaking. So it goes to a key no seat opens.
    private func retireThePreSeatShelves(heldBy deviceHolds: () -> String?) {
        guard held.sessions != nil || held.routines != nil || held.exercises != nil else { return }
        let landing = deviceHolds().map { "u.\($0)" } ?? Self.quarantinedShelf
        var shelves = held.shelves ?? [:]
        var theirs = shelves[landing] ?? Shelf()
        theirs.sessions = (theirs.sessions ?? []) + (held.sessions ?? [])
        theirs.routines = (theirs.routines ?? []) + (held.routines ?? [])
        theirs.exercises = (theirs.exercises ?? []) + (held.exercises ?? [])
        shelves[landing] = theirs
        held.shelves = shelves
        held.sessions = nil
        held.routines = nil
        held.exercises = nil
        flush()
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-local.json")
    }

    // OPENED UNDER WHOEVER IS SIGNED IN — the only place a seat is named, and the first thing every
    // connect does. Everything below reads and writes THIS shelf and cannot reach another: a phone
    // that was lent out still holds the last lifter's sessions, undrawn and unsent, until they come
    // back to it.
    public func open(under seat: String?) {
        key = seat.map { "u.\($0)" } ?? Self.anonymousShelf
    }

    // THE CLAIM'S FIRST MOVE, and the one thing that ever crosses a shelf: everything made before
    // anybody signed in follows the person who signs in (auth canon §2, "claiming, not gating"). It
    // MOVES rather than copies — the anonymous shelf is emptied in the same breath — so no second
    // account can be given the same work, and it runs whenever a confirmed seat finds an anonymous
    // shelf rather than only on a change of seat, because a launch that could not reach the log
    // leaves the shelf sitting there waiting for the next one that can.
    public func adoptTheAnonymousShelf() {
        guard key != Self.anonymousShelf, let anonymous = held.shelves?[Self.anonymousShelf] else { return }
        var mine = shelf
        mine.sessions = (mine.sessions ?? []) + (anonymous.sessions ?? [])
        mine.routines = (mine.routines ?? []) + (anonymous.routines ?? [])
        mine.exercises = (mine.exercises ?? []) + (anonymous.exercises ?? [])
        shelf = mine
        held.shelves?[Self.anonymousShelf] = nil
        flush()
    }

    private var shelf: Shelf {
        get { held.shelves?[key] ?? Shelf() }
        set {
            var shelves = held.shelves ?? [:]
            shelves[key] = newValue
            held.shelves = shelves
        }
    }

    public var sessions: [LocalSession] {
        (shelf.sessions ?? []).sorted { $0.session.startedAtMs < $1.session.startedAtMs }
    }

    public var routines: [Routine] { shelf.routines ?? [] }
    public var exercises: [ExerciseWrite] { shelf.exercises ?? [] }
    public var isEmpty: Bool { sessions.isEmpty && routines.isEmpty && exercises.isEmpty }

    // SETTINGS ARE NOT AN ARTIFACT, which is why they are not in `isEmpty` and not in the account
    // footprint the backend keeps: a lifter who armed the rest timer and left has made nothing. Nil is
    // "nobody has answered on this device", which the room draws as the defaults — never as an empty
    // document, because an empty document is a real and different answer.
    //
    // WHOSE ANSWER IT IS travels with it, so read it through `open(preferencesUnder:)` on every change
    // of seat and this property only afterwards.
    public var preferences: GymPreferences? { held.preferences }

    // WHOSE ANSWER IT IS IS PART OF THE SHELF, for the same reason DeviceCatalog's file carries a
    // seat: this document is one ACCOUNT's, and a phone that lent it to the next lifter would rest
    // them to a timer they never set and then — because every write here is the WHOLE document —
    // put that first account's whole room onto the second one's row. So a shelf this seat did
    // not write is let go of, on disk as well as in memory, and the room opens on the defaults until
    // the log answers.
    //
    // The one crossing is the one the claim exists for: an ANONYMOUS document still owed is what the
    // lifter set before they had an account, and signing in carries it to that account (§2). It goes
    // the other way for nobody — a document already sent, or one belonging to another account,
    // leaves with the seat, and an unsent one leaves with it too rather than being sent by a lifter
    // who did not write it.
    public func open(preferencesUnder seat: String?) -> GymPreferences? {
        let carriedByTheClaim = held.preferencesSeat == nil && preferencesOwed
        let sameSeat = held.preferencesSeat == seat
        held.preferencesSeat = seat
        if sameSeat || carriedByTheClaim { return held.preferences }
        guard held.preferences != nil else { return nil }
        held.preferences = nil
        held.preferencesOwed = nil
        flush()
        return nil
    }

    // Whether this device's copy is one the log has never been told about. It is what makes the claim
    // send the DEVICE's answer after sign-in — those are the values the lifter just touched, so
    // last-write-wins has to run in their favour — and what keeps a served read from overwriting it
    // before it has been sent.
    public var preferencesOwed: Bool { held.preferencesOwed ?? false }

    public func keep(_ preferences: GymPreferences, owed: Bool) {
        held.preferences = preferences
        held.preferencesOwed = owed
    }

    public func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // ── the sessions shelf ─────────────────────────────────────────────────────────────────────

    public func keep(_ session: Session, sets: [TrainingSet]) {
        var kept = (shelf.sessions ?? []).filter { $0.session.id != session.id }
        kept.append(LocalSession(session: session, sets: sets.sorted { $0.completedAtMs < $1.completedAtMs }))
        shelf.sessions = kept
    }

    public func session(_ id: String) -> LocalSession? {
        shelf.sessions?.first { $0.session.id == id }
    }

    public func holds(session id: String) -> Bool {
        session(id) != nil
    }

    // Claimed and discarded end the same way: the log — the account's or nobody's — no longer owes
    // this row to anyone, so the device lets go of it.
    public func claimed(session id: String) {
        shelf.sessions = (shelf.sessions ?? []).filter { $0.session.id != id }
    }

    public func remint(session old: String, as fresh: String) {
        shelf.sessions = (shelf.sessions ?? []).map { local in
            guard local.session.id == old else { return local }
            let moved = Session(id: fresh, startedAtMs: local.session.startedAtMs,
                                finishedAtMs: local.session.finishedAtMs,
                                routineId: local.session.routineId, plan: local.session.plan)
            return LocalSession(session: moved, sets: local.sets)
        }
    }

    public func remint(set id: String, in sessionId: String, as fresh: String) {
        shelf.sessions = (shelf.sessions ?? []).map { local in
            guard local.session.id == sessionId else { return local }
            return LocalSession(session: local.session,
                                sets: local.sets.map { $0.id == id ? $0.reminted(as: fresh) : $0 })
        }
    }

    // A CORRECTION ON THE SHELF (§G18), and it is the same ruling the log makes: the row is rewritten
    // in place and the shelf keeps ONE row per set that still stands. That is the whole reason a typo
    // fixed signed-out survives signing in — the claim replays what is on this shelf, so it replays
    // the corrected set and never the original.
    public func fix(set id: String, in sessionId: String, by correction: SetFix) {
        shelf.sessions = (shelf.sessions ?? []).map { local in
            guard local.session.id == sessionId else { return local }
            return LocalSession(session: local.session,
                                sets: local.sets.map { $0.id == id ? $0.corrected(by: correction) : $0 })
        }
    }

    // A set off the shelf, and two callers reach it: a claim that met a terminal refusal, and §G18's
    // delete. Both mean the same thing here — this device stops holding the row, so nothing replays
    // it and no local read counts it.
    public func drop(set id: String, in sessionId: String) {
        shelf.sessions = (shelf.sessions ?? []).map { local in
            guard local.session.id == sessionId else { return local }
            return LocalSession(session: local.session, sets: local.sets.filter { $0.id != id })
        }
    }

    // ── the routines shelf ─────────────────────────────────────────────────────────────────────

    public func keep(_ routine: Routine) {
        replace(routine)
    }

    public func replace(_ routine: Routine) {
        var kept = shelf.routines ?? []
        if let index = kept.firstIndex(where: { $0.id == routine.id }) {
            kept[index] = routine
        } else {
            kept.append(routine)
        }
        shelf.routines = kept
    }

    public func routine(_ id: String) -> Routine? {
        shelf.routines?.first { $0.id == id }
    }

    public func claimed(routine id: String) {
        shelf.routines = (shelf.routines ?? []).filter { $0.id != id }
    }

    // The routine landed under a fresh id — every session started from it follows, or the claim
    // would replay them naming a routine the log has never heard of.
    public func remint(routine old: String, as fresh: String) {
        shelf.routines = (shelf.routines ?? []).map { routine in
            guard routine.id == old else { return routine }
            return Routine(id: fresh, name: routine.name, position: routine.position,
                           lastTrainedAtMs: routine.lastTrainedAtMs, entries: routine.entries)
        }
        rewriteSessions { session in
            guard session.routineId == old else { return session }
            return Session(id: session.id, startedAtMs: session.startedAtMs,
                           finishedAtMs: session.finishedAtMs, routineId: fresh, plan: session.plan)
        }
    }

    // The routine can never land as written (a terminal refusal): the sessions that named it keep
    // their frozen plan — the plan is a snapshot, not a reference — and drop only the id.
    public func orphan(routine id: String) {
        claimed(routine: id)
        rewriteSessions { session in
            guard session.routineId == id else { return session }
            return Session(id: session.id, startedAtMs: session.startedAtMs,
                           finishedAtMs: session.finishedAtMs, routineId: nil, plan: session.plan)
        }
    }

    private func rewriteSessions(_ rewrite: (Session) -> Session) {
        shelf.sessions = (shelf.sessions ?? []).map {
            LocalSession(session: rewrite($0.session), sets: $0.sets)
        }
    }

    // The server stamps lastTrainedAt when a session finishes against a routine; signed out this
    // device is the server, so it keeps the same fact the same way.
    public func trained(routine id: String?, atMs instant: Int64) {
        guard let id else { return }
        shelf.routines = (shelf.routines ?? []).map { routine in
            guard routine.id == id else { return routine }
            return Routine(id: routine.id, name: routine.name, position: routine.position,
                           lastTrainedAtMs: instant, entries: routine.entries)
        }
    }

    // ── the movements shelf ────────────────────────────────────────────────────────────────────

    public func keep(exercise write: ExerciseWrite) {
        shelf.exercises = (shelf.exercises ?? []).filter { $0.id != write.id } + [write]
    }

    public func claimed(exercise id: String) {
        shelf.exercises = (shelf.exercises ?? []).filter { $0.id != id }
    }

    // Renaming a movement this device minted and has not claimed yet: the shelf entry IS the pending
    // create, so the new name is simply the name the log first hears. The id does not move, which is
    // the same promise the account's own rename makes — every set and routine entry naming it stays
    // pointed at the same movement.
    public func rename(exercise id: String, to name: String) {
        shelf.exercises = (shelf.exercises ?? []).map { write in
            guard write.id == id else { return write }
            return ExerciseWrite(id: write.id, name: name, pattern: write.pattern,
                                 equipment: write.equipment, stepKg: write.stepKg)
        }
    }

    public func remint(exercise old: String, as fresh: String) {
        shelf.exercises = (shelf.exercises ?? []).map { write in
            guard write.id == old else { return write }
            return ExerciseWrite(id: fresh, name: write.name, pattern: write.pattern,
                                 equipment: write.equipment, stepKg: write.stepKg)
        }
        shelf.routines = (shelf.routines ?? []).map { routine in
            Routine(id: routine.id, name: routine.name, position: routine.position,
                    lastTrainedAtMs: routine.lastTrainedAtMs,
                    entries: routine.entries.map { entry in
                        guard entry.exerciseId == old else { return entry }
                        return RoutineEntry(position: entry.position, exerciseId: fresh,
                                            targetSets: entry.targetSets, targetReps: entry.targetReps,
                                            targetWeightKg: entry.targetWeightKg,
                                            restSeconds: entry.restSeconds)
                    })
        }
        shelf.sessions = (shelf.sessions ?? []).map { local in
            LocalSession(session: local.session,
                         sets: local.sets.map { set in
                             guard set.exerciseId == old else { return set }
                             return TrainingSet(id: set.id, exerciseId: fresh, setNumber: set.setNumber,
                                                weightKg: set.weightKg, reps: set.reps, kind: set.kind,
                                                rpe: set.rpe, note: set.note,
                                                completedAtMs: set.completedAtMs)
                         })
        }
    }

    // ── what the log answers signed out ────────────────────────────────────────────────────────

    // The log page the room draws, newest first — the same summary rows the server sends, computed
    // by its rules: the top set is the heaviest WORKING set, ties to the reps, and the count and the
    // tonnage beside it are over the working sets and nothing else.
    //
    // The tonnage clamps each set at zero rather than subtracting, which is the whole reason gym can
    // caption a week with one at all: a band-assisted set moved no external load, and neither did a
    // chin-up. `topE1rm` stays absent — Epley is the domain's, and this device does not hold a copy —
    // so a row this device is the only home for reads its two honest numbers and draws nothing where
    // the estimate would go.
    public func summaries() -> [SessionSummary] {
        sessions.reversed().map { local in
            var walked: [String] = []
            for set in local.sets where !walked.contains(set.exerciseId) {
                walked.append(set.exerciseId)
            }
            let working = local.sets.filter { $0.kind == .working }
            return SessionSummary(session: local.session,
                                  setCount: local.sets.count,
                                  exercises: walked,
                                  topSet: topWorkingSet(of: local.sets).map {
                                      TopSet(weightKg: $0.weightKg, reps: $0.reps)
                                  },
                                  workingSetCount: working.count,
                                  tonnageKg: working.reduce(0) { $0 + max($1.weightKg, 0) * Double($1.reps) })
        }
    }

    public func detail(of sessionId: String) -> SessionDetail? {
        session(sessionId).map { SessionDetail(session: $0.session, sets: $0.sets) }
    }

    // Whether this shelf holds a set of the movement that a record page would DRAW — anything but a
    // warmup, which counts toward nothing here. Signed in, every session on this shelf is one the
    // log has not been told about, so this is the record page's own caveat asked per movement.
    public func holdsSets(of exerciseId: String) -> Bool {
        sessions.contains { local in
            local.sets.contains { $0.exerciseId == exerciseId && $0.kind != .warmup }
        }
    }

    // The prefill's question, answered from this device's history: the newest finished session
    // holding a non-warmup set of the movement, those sets in performed order.
    //
    // THE PREDICATE IS THE SERVER'S (ARCHITECTURE §5): the movement's last block's NON-warmup rows —
    // a drop or failure set is part of last time; only warmups are not. It is not the same as
    // "working only": a drop set and a set taken to failure both happened and both ride along in the
    // log's own answer (PgLogRepository::lastTime). A phone that cut them here would dial a different
    // weight signed out than the same session dials signed in — and §G18's sheet can file any of the
    // four kinds, so this shelf really does hold them.
    public func lastTime(_ exerciseId: String) -> LastTime? {
        for local in sessions.reversed() {
            let performed = local.sets.filter { $0.exerciseId == exerciseId && $0.kind != .warmup }
            guard !performed.isEmpty else { continue }
            return LastTime(exerciseId: exerciseId, session: local.session,
                            routine: local.session.plan?.routine, sets: performed)
        }
        return nil
    }

    // The picker's meta, answered from this device — every movement's last line, sparse, exactly as
    // `GET /v1/gym/exercises/last` answers it. Signed out this shelf is the whole log; signed in it
    // holds what the account has not claimed yet, which is why the store merges rather than replaces.
    //
    // One walk, newest session first, taking the LAST non-warmup set of the first finished session
    // that holds one — the last row of `lastTime`'s block above, and the same row the server's own
    // `DISTINCT ON … set_number DESC` answers with, so the picker says the same thing signed out as
    // signed in. Unfinished sessions are not a last time, however heavy.
    //
    // IT IS NOT THE SET THE PREFILL DIALS, and the two are not trying to be. This line REPORTS what
    // was lifted last, so it is one set read off the block whole; `Prefill` AIMS the next one, so it
    // takes the weight the block ended on and the reps it opened with (Training.swift) — a block of
    // 100 × 5 then 100 × 3 reads `last 100 × 3` here and opens the dial on 100 × 5. Same weight,
    // and the reps differ exactly when the lifter's own reps fell off inside the block.
    public func lastSets() -> [String: LastSet] {
        var found: [String: LastSet] = [:]
        for local in sessions.reversed() where local.session.finishedAtMs != nil {
            var block: [String: LastSet] = [:]
            for set in local.sets where set.kind != .warmup {
                block[set.exerciseId] = LastSet(exerciseId: set.exerciseId, weightKg: set.weightKg,
                                                reps: set.reps, atMs: local.session.startedAtMs)
            }
            // The walk is newest first, so a movement this session names is only news if no newer
            // session already named it. Merging the other way would let last month overwrite today.
            found.merge(block) { alreadyFound, _ in alreadyFound }
        }
        return found
    }

    // The review of a LOCAL session: the three facts and the honest word over a short one. The
    // record line and the comparison stay absent — both are claims against the account's history,
    // which this device does not hold — and an absent line is a state the finish screen already
    // draws for the ~190 sessions in 200 that earn nothing.
    public func review(of sessionId: String) -> Review? {
        guard let local = session(sessionId), let finishedAt = local.session.finishedAtMs else { return nil }
        let working = local.sets.filter { $0.kind == .working }.count
        return Review(stats: Review.Stats(durationMs: max(0, finishedAt - local.session.startedAtMs),
                                          workingSets: working),
                      slight: working < Self.slightWorkingSets)
    }

    // ONE MOVEMENT'S RECORD as this device can honestly answer it (§H). The two counts, the heaviest
    // working set and the recent days are all readable off the shelf. The estimate, the twelve-week
    // series and the record ladder are NOT — every one of them is Epley, which lives in one place per
    // language and none of them is Swift — so they stay ABSENT rather than arriving as zeros, and the
    // page says where they are computed instead of drawing an empty chart frame.
    //
    // The session running right now is deliberately not in here: a record that moved under a lifter
    // between two sets would be reporting on a workout in flight.
    public func record(of exercise: Exercise, days limit: Int = 10) -> MovementRecord {
        let finished = sessions.filter { $0.session.finishedAtMs != nil }
        // A session counts as WORKED when it holds a working set of the movement — a warmup counts
        // toward nothing — while a recent day is drawn from every set that is not a warmup, which is
        // the same cut the served read makes.
        let worked = finished.compactMap { local -> MovementMark? in
            guard let top = topWorkingSet(of: local.sets.filter { $0.exerciseId == exercise.id }) else {
                return nil
            }
            return MovementMark(weightKg: top.weightKg, reps: top.reps, atMs: local.session.startedAtMs)
        }
        let days = finished.reversed().compactMap { local -> TrainingDay? in
            let performed = local.sets.filter { $0.exerciseId == exercise.id && $0.kind != .warmup }
            guard !performed.isEmpty else { return nil }
            return TrainingDay(sessionId: local.session.id,
                               startedAtMs: local.session.startedAtMs, sets: performed)
        }
        // The programs on this device that name it, in program order — §N's rename proof reads
        // these, and the count is exactly the list's length so the two can never disagree.
        let naming = routines
            .filter { routine in routine.entries.contains { $0.exerciseId == exercise.id } }
            .map(\.name)
        return MovementRecord(
            exercise: exercise,
            routineCount: naming.count,
            routines: naming,
            sessionCount: worked.count,
            heaviest: heaviest(of: worked),
            recentDays: Array(days.prefix(limit)))
    }

    // The heaviest set, ties broken by more reps and then by the earlier one — Review.h's
    // topWorkingSet rule, restated for the sessions the server has not seen.
    private func topWorkingSet(of sets: [TrainingSet]) -> TrainingSet? {
        var top: TrainingSet?
        for set in sets.sorted(by: { $0.completedAtMs < $1.completedAtMs }) where set.kind == .working {
            guard let held = top else {
                top = set
                continue
            }
            if (set.weightKg, set.reps) > (held.weightKg, held.reps) { top = set }
        }
        return top
    }

    // A heavier load takes the mark; a tied load goes to more reps, then to the earlier one — the
    // server's marks projection (DISTINCT ON (exercise, weight) … reps DESC, completed_at ASC in
    // PgLogRepository), so the same log shows the same best before and after the claim. The
    // marks arrive oldest first, which is what makes "then the earlier one" a rule rather than an
    // accident. No estimate rides along, for the reason no local read has one.
    private func heaviest(of marks: [MovementMark]) -> MovementMark? {
        var best: MovementMark?
        for mark in marks {
            if let held = best {
                if mark.weightKg < held.weightKg { continue }
                if mark.weightKg == held.weightKg, mark.reps <= held.reps { continue }
            }
            best = mark
        }
        return best
    }
}
