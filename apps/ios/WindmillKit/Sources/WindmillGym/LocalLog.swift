import Foundation

// THE LOG AS THIS DEVICE HOLDS IT — everything gym made before anybody signed in: finished sessions
// with their sets, routines, and movements minted from the picker. The room works out of this file
// signed out (auth canon §2, "claiming, not gating"), and signing in CLAIMS it — the replay in
// TrainingStore walks these shelves oldest first and empties them as the log answers, the same shape
// journal's PageStore.claimWhatIsOwed gives its pages.
//
// It sits beside the queue, not inside it: `windmill-gym-sets.json` is the LIVE session and is
// flushed on every tap; a finished session is history and is written once. The queue's file keeps
// its name and its shape — GymDevice reads it directly — and this one follows the same two rules:
// whole-file atomic writes, and a file this build cannot read opens EMPTY rather than taking the
// room down with it.
//
// The reads at the foot of the file are what "the log" answers signed out — recent sessions, the
// last-time prefill, the review of a finished session, the statistics window — computed from the
// held sessions by the same rules the server states, minus the one number this device refuses to
// invent: Epley lives in one place per language and this is not it, so every local point carries
// `e1rm: nil` and the statistics axis falls honestly to load or reps (Statistics.swift).

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
    private struct Held: Codable {
        var sessions: [LocalSession]?
        var routines: [Routine]?
        var exercises: [ExerciseWrite]?
    }

    // Mirrors backend/products/gym/domain/Review.h kSlightWorkingSets — the one threshold the local
    // review needs, restated because the domain lives server-side and a session finished in a
    // basement still deserves the honest word over it.
    static let slightWorkingSets = 4

    private let url: URL
    private var held: Held

    public init(url: URL = LocalLog.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-local.json")
    }

    public var sessions: [LocalSession] {
        (held.sessions ?? []).sorted { $0.session.startedAtMs < $1.session.startedAtMs }
    }

    public var routines: [Routine] { held.routines ?? [] }
    public var exercises: [ExerciseWrite] { held.exercises ?? [] }
    public var isEmpty: Bool { sessions.isEmpty && routines.isEmpty && exercises.isEmpty }

    public func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // ── the sessions shelf ─────────────────────────────────────────────────────────────────────

    public func keep(_ session: Session, sets: [TrainingSet]) {
        var kept = (held.sessions ?? []).filter { $0.session.id != session.id }
        kept.append(LocalSession(session: session, sets: sets.sorted { $0.completedAtMs < $1.completedAtMs }))
        held.sessions = kept
    }

    public func session(_ id: String) -> LocalSession? {
        held.sessions?.first { $0.session.id == id }
    }

    public func holds(session id: String) -> Bool {
        session(id) != nil
    }

    // Claimed and discarded end the same way: the log — the account's or nobody's — no longer owes
    // this row to anyone, so the device lets go of it.
    public func claimed(session id: String) {
        held.sessions = (held.sessions ?? []).filter { $0.session.id != id }
    }

    public func remint(session old: String, as fresh: String) {
        held.sessions = (held.sessions ?? []).map { local in
            guard local.session.id == old else { return local }
            let moved = Session(id: fresh, startedAtMs: local.session.startedAtMs,
                                finishedAtMs: local.session.finishedAtMs,
                                routineId: local.session.routineId, plan: local.session.plan)
            return LocalSession(session: moved, sets: local.sets)
        }
    }

    public func remint(set id: String, in sessionId: String, as fresh: String) {
        held.sessions = (held.sessions ?? []).map { local in
            guard local.session.id == sessionId else { return local }
            return LocalSession(session: local.session,
                                sets: local.sets.map { $0.id == id ? $0.reminted(as: fresh) : $0 })
        }
    }

    public func drop(set id: String, in sessionId: String) {
        held.sessions = (held.sessions ?? []).map { local in
            guard local.session.id == sessionId else { return local }
            return LocalSession(session: local.session, sets: local.sets.filter { $0.id != id })
        }
    }

    // ── the routines shelf ─────────────────────────────────────────────────────────────────────

    public func keep(_ routine: Routine) {
        replace(routine)
    }

    public func replace(_ routine: Routine) {
        var kept = held.routines ?? []
        if let index = kept.firstIndex(where: { $0.id == routine.id }) {
            kept[index] = routine
        } else {
            kept.append(routine)
        }
        held.routines = kept
    }

    public func routine(_ id: String) -> Routine? {
        held.routines?.first { $0.id == id }
    }

    public func claimed(routine id: String) {
        held.routines = (held.routines ?? []).filter { $0.id != id }
    }

    // The routine landed under a fresh id — every session started from it follows, or the claim
    // would replay them naming a routine the log has never heard of.
    public func remint(routine old: String, as fresh: String) {
        held.routines = (held.routines ?? []).map { routine in
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
        held.sessions = (held.sessions ?? []).map {
            LocalSession(session: rewrite($0.session), sets: $0.sets)
        }
    }

    // The server stamps lastTrainedAt when a session finishes against a routine; signed out this
    // device is the server, so it keeps the same fact the same way.
    public func trained(routine id: String?, atMs instant: Int64) {
        guard let id else { return }
        held.routines = (held.routines ?? []).map { routine in
            guard routine.id == id else { return routine }
            return Routine(id: routine.id, name: routine.name, position: routine.position,
                           lastTrainedAtMs: instant, entries: routine.entries)
        }
    }

    // ── the movements shelf ────────────────────────────────────────────────────────────────────

    public func keep(exercise write: ExerciseWrite) {
        held.exercises = (held.exercises ?? []).filter { $0.id != write.id } + [write]
    }

    public func claimed(exercise id: String) {
        held.exercises = (held.exercises ?? []).filter { $0.id != id }
    }

    public func remint(exercise old: String, as fresh: String) {
        held.exercises = (held.exercises ?? []).map { write in
            guard write.id == old else { return write }
            return ExerciseWrite(id: fresh, name: write.name, pattern: write.pattern,
                                 equipment: write.equipment, stepKg: write.stepKg)
        }
        held.routines = (held.routines ?? []).map { routine in
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
        held.sessions = (held.sessions ?? []).map { local in
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

    // The prefill's question, answered from this device's history: the newest finished session
    // holding a WORKING set of the movement, its working sets in performed order — warmups already
    // dropped, exactly as `GET /v1/gym/last` drops them.
    public func lastTime(_ exerciseId: String) -> LastTime? {
        for local in sessions.reversed() {
            let working = local.sets.filter { $0.exerciseId == exerciseId && $0.kind == .working }
            guard !working.isEmpty else { continue }
            return LastTime(exerciseId: exerciseId, session: local.session,
                            routine: local.session.plan?.routine, sets: working)
        }
        return nil
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

    // The long window over the local log — weeks Monday to Monday in UTC, contiguous with the gaps
    // in, and one line per movement from each session's top working set. Every point carries
    // `e1rm: nil`: no Epley is computed on this device, and Stats.Axis falls to load or reps.
    public func statistics() -> TrainingStatistics {
        let finished = sessions.filter { $0.session.finishedAtMs != nil }
        guard !finished.isEmpty else { return TrainingStatistics() }

        var weeks: [Int64: (sessions: Int, workingSets: Int)] = [:]
        for local in finished {
            let week = Self.weekStartMs(of: local.session.startedAtMs)
            let working = local.sets.filter { $0.kind == .working }.count
            let held = weeks[week] ?? (0, 0)
            weeks[week] = (held.sessions + 1, held.workingSets + working)
        }
        let span = weeks.keys.sorted()
        var contiguous: [TrainingWeek] = []
        var cursor = span.first ?? 0
        while cursor <= (span.last ?? 0) {
            let counted = weeks[cursor] ?? (0, 0)
            contiguous.append(TrainingWeek(startedAtMs: cursor, sessions: counted.sessions,
                                           workingSets: counted.workingSets))
            cursor += 7 * 86_400_000
        }

        var points: [String: [MovementPoint]] = [:]
        var lastTrained: [String: Int64] = [:]
        for local in finished {
            var walked: [String] = []
            for set in local.sets where set.kind == .working && !walked.contains(set.exerciseId) {
                walked.append(set.exerciseId)
            }
            for exerciseId in walked {
                let mine = local.sets.filter { $0.exerciseId == exerciseId && $0.kind == .working }
                guard let top = topWorkingSet(of: mine) else { continue }
                points[exerciseId, default: []].append(
                    MovementPoint(atMs: local.session.startedAtMs, weightKg: top.weightKg, reps: top.reps))
                lastTrained[exerciseId] = local.session.startedAtMs
            }
        }
        let movements = points.map { exerciseId, line in
            MovementProgress(exerciseId: exerciseId,
                             lastTrainedAtMs: lastTrained[exerciseId] ?? 0,
                             points: line,
                             heaviest: heaviest(of: line))
        }.sorted { left, right in
            if left.lastTrainedAtMs != right.lastTrainedAtMs {
                return left.lastTrainedAtMs > right.lastTrainedAtMs
            }
            return left.exerciseId < right.exerciseId
        }

        return TrainingStatistics(weeks: contiguous, movements: movements)
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
    // PgTrainingRepository) feeding Statistics.cpp's bestByLoad, so the same log shows the same
    // best before and after the claim. No estimate rides along, for the reason every local point
    // has none.
    private func heaviest(of points: [MovementPoint]) -> MovementBest? {
        var best: MovementBest?
        for point in points {
            if let held = best {
                if point.weightKg < held.weightKg { continue }
                if point.weightKg == held.weightKg, point.reps <= held.reps { continue }
            }
            best = MovementBest(weightKg: point.weightKg, reps: point.reps, atMs: point.atMs)
        }
        return best
    }

    // Monday 00:00 UTC of the week holding this instant. Day zero of the epoch was a Thursday, so
    // the Monday offset is four days.
    static func weekStartMs(of ms: Int64) -> Int64 {
        let day = Int64((Double(ms) / 86_400_000).rounded(.down))
        let sinceMonday = (((day - 4) % 7) + 7) % 7
        return (day - sinceMonday) * 86_400_000
    }
}
