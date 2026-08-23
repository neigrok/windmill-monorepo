import Foundation
import WindmillPlatform

// The log as this device holds it: finished sessions with their sets, routines, movements and the
// settings. Signing in claims it — TrainingStore walks these shelves oldest first and empties them as
// the log answers. Whole-file atomic writes; a file this build cannot read opens EMPTY. No local read
// carries an Epley estimate.

public final class LocalLog {
    public struct LocalSession: Equatable, Codable {
        public var session: Session
        public var sets: [TrainingSet]

        public init(session: Session, sets: [TrainingSet]) {
            self.session = session
            self.sets = sets
        }
    }

    // Every shelf optional: a file written by a build with fewer shelves must not decode to empty.
    private struct Shelf: Codable {
        var sessions: [LocalSession]?
        var routines: [Routine]?
        var exercises: [ExerciseWrite]?
    }

    // One shelf per seat, and the seat is the key: `open(under:)` names it and nothing else does.
    // `anon` holds everything made before anybody signed in, and is the shelf the claim carries.
    private struct Held: Codable {
        var sessions: [LocalSession]?
        var routines: [Routine]?
        var exercises: [ExerciseWrite]?
        var shelves: [String: Shelf]?
        var preferences: GymPreferences?
        var preferencesOwed: Bool?
        var preferencesSeat: String?
    }

    // Mirrors backend/products/gym/domain/Review.h kSlightWorkingSets.
    static let slightWorkingSets = 4

    private let url: URL
    private var held: Held
    private var key = LocalLog.anonymousShelf

    static let anonymousShelf = "anon"
    // The one key `open(under:)` can never name — a seat is `anon` or `u.<id>`.
    static let quarantinedShelf = "quarantine"

    // `deviceHolds` is asked lazily, so a launch with nothing to move never touches the Keychain.
    public init(url: URL = LocalLog.defaultURL(),
                deviceHolds: @escaping @autoclosure () -> String? = KeychainSessions().readUser()?.id) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
        retireThePreSeatShelves(heldBy: deviceHolds)
    }

    // Rows land, still owed, on the shelf of whoever this device holds a session for; a phone holding
    // none cannot say whose they are, so they go to the key no seat opens.
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

    // The only place a seat is named, and the first thing every connect does.
    public func open(under seat: String?) {
        key = seat.map { "u.\($0)" } ?? Self.anonymousShelf
    }

    // The one thing that ever crosses a shelf, and it moves rather than copies: no second account can
    // be given the same work.
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

    // Nil is "nobody has answered on this device" and draws the defaults; an empty document is a real
    // and different answer.
    public var preferences: GymPreferences? { held.preferences }

    // Every write is the whole document, so one this seat did not write is let go of, on disk as well
    // as in memory. An anonymous document still owed crosses at sign-in; nothing crosses back.
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

    // Makes the claim send this device's answer, and keeps a served read from overwriting it first.
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

    public func fix(set id: String, in sessionId: String, by correction: SetFix) {
        shelf.sessions = (shelf.sessions ?? []).map { local in
            guard local.session.id == sessionId else { return local }
            return LocalSession(session: local.session,
                                sets: local.sets.map { $0.id == id ? $0.corrected(by: correction) : $0 })
        }
    }

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

    // Every session started from it follows, or the claim would name a routine the log never heard of.
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

    // The sessions that named it keep their frozen plan and drop only the id.
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

    // This device stamps lastTrainedAt the way the server does at a finish.
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

    // The shelf entry is the pending create, so the new name is the one the log first hears. The id
    // does not move: every set and routine entry naming it points at the same movement.
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

    // Newest first: the top set is the heaviest working set, ties to the reps. `setCount` counts
    // every set, warmups included, the way the server does; `workingSetCount` and tonnage cover
    // working sets only. Tonnage clamps each set at zero rather than subtracting. `topE1rm` stays
    // absent.
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

    public func holdsSets(of exerciseId: String) -> Bool {
        sessions.contains { local in
            local.sets.contains { $0.exerciseId == exerciseId && $0.kind != .warmup }
        }
    }

    // The newest finished session holding a non-warmup set of the movement, in performed order.
    public func lastTime(_ exerciseId: String) -> LastTime? {
        for local in sessions.reversed() {
            let performed = local.sets.filter { $0.exerciseId == exerciseId && $0.kind != .warmup }
            guard !performed.isEmpty else { continue }
            return LastTime(exerciseId: exerciseId, session: local.session,
                            routine: local.session.plan?.routine, sets: performed)
        }
        return nil
    }

    // Sparse, exactly as `GET /v1/gym/exercises/last` answers it: the last non-warmup set of the
    // newest finished session holding one. An unfinished session is not a last time.
    public func lastSets() -> [String: LastSet] {
        var found: [String: LastSet] = [:]
        for local in sessions.reversed() where local.session.finishedAtMs != nil {
            var block: [String: LastSet] = [:]
            for set in local.sets where set.kind != .warmup {
                block[set.exerciseId] = LastSet(exerciseId: set.exerciseId, weightKg: set.weightKg,
                                                reps: set.reps, atMs: local.session.startedAtMs)
            }
            // Newest first, so an older session never overwrites a movement already found.
            found.merge(block) { alreadyFound, _ in alreadyFound }
        }
        return found
    }

    // The record line and the comparison stay absent: both are claims against the account's history.
    public func review(of sessionId: String) -> Review? {
        guard let local = session(sessionId), let finishedAt = local.session.finishedAtMs else { return nil }
        let working = local.sets.filter { $0.kind == .working }.count
        return Review(stats: Review.Stats(durationMs: max(0, finishedAt - local.session.startedAtMs),
                                          workingSets: working),
                      slight: working < Self.slightWorkingSets)
    }

    // The estimate, the series and the record ladder are absent rather than zero: all are Epley.
    public func record(of exercise: Exercise, days limit: Int = 10) -> MovementRecord {
        let finished = sessions.filter { $0.session.finishedAtMs != nil }
        // Worked means a working set; a recent day is drawn from every non-warmup set.
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

    // Heaviest, ties broken by more reps and then by the earlier one.
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

    // A heavier load takes the mark; a tie goes to more reps, then to the earlier one. The marks
    // arrive oldest first, which is what makes "then the earlier one" a rule.
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
