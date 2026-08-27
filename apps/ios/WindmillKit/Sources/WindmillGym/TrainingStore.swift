import Foundation
import SwiftUI
import WindmillPlatform

// The order of every write never varies: mint an id → store on the device → tell the log, or owe it.

@MainActor
public final class TrainingStore: ObservableObject {
    @Published public private(set) var catalog: [Exercise] = []
    @Published public private(set) var routines: [Routine] = []
    @Published public private(set) var proposals: [ProposalHead] = []
    @Published public private(set) var recent: [SessionSummary] = []      // the log, newest first
    @Published public private(set) var deviceOnly: Set<String> = []
    @Published public private(set) var logFoot: LogFoot = .loading
    @Published public private(set) var session: Session?
    @Published public private(set) var sets: [TrainingSet] = []           // performed order
    @Published public private(set) var order: [String] = []               // walk order
    @Published public private(set) var exerciseId: String?
    @Published public private(set) var lastTime: LastTime?
    // Asked and came back empty-handed — not the same fact as not having asked yet.
    @Published public private(set) var lastTimeFailed = false
    // A movement with no line has never been trained; nil is the map unread, asserting nothing.
    @Published public private(set) var lastSets: [String: LastSet]?
    private var lastSetsWanted = false
    @Published public private(set) var prefill: Prefill = .emptyBar
    @Published public private(set) var preferences: GymPreferences = .defaults
    @Published public private(set) var bodyweight: [BodyweightEntry] = []        // ascending by day
    @Published public private(set) var refusals: [RefusedWrite] = []      // writes that never landed
    @Published public private(set) var saveState: SaveState = .idle
    @Published public private(set) var saveTick = 0                       // bumps once per write
    @Published public private(set) var strandedCount = 0
    // What blocked the lane those sets are stranded in; nil until a walk has met them.
    @Published public private(set) var strandedBy: Stall?
    @Published public private(set) var isLoading = true
    // A set logged into a session that closes under the finish is refused forever.
    @Published public private(set) var isFinishing = false

    // What the server has answered, page after page; its tail is the next page's cursor.
    private var served: [SessionSummary] = []

    // `recent`'s own oldest cannot stand in: this device's unclaimed sessions are merged in at any age.
    public var servedOldestMs: Int64? { served.last?.session.startedAtMs }

    private let queue: SetQueue
    private let deviceCatalog: DeviceCatalog
    private let accountCopy: AccountCopy
    private let localLog: LocalLog
    private let bodyweightStore: BodyweightStore
    private let now: () -> Int64
    private let mintSession: () -> String
    private let mintSet: () -> String
    private let sync: (Account) -> (any TrainingSyncing)?
    private var gym: (any TrainingSyncing)?
    private var lastTimes: [String: LastTime] = [:]
    private var retryTask: Task<Void, Never>?
    // While the shelf replays, an ordinary start composes on the device: the server would join instead.
    private var claiming = false
    private var claimAgainWhenDone = false
    // Reads that settle staleness park here: one fired mid-replay auto-closes the session under the walk.
    private var untilTheClaimEnds: [CheckedContinuation<Void, Never>] = []
    // Bumped by every connect; an ending computed under an old seat is discarded.
    private var seat = 0
    // The last claim ended owing the shelf for a reason that can heal; a WAIT does not set it.
    private var claimOwedRetryably = false
    // Two whole settings documents may never be in flight.
    private var settingsSending = false

    // At or under the server's ceiling of 200; a larger page comes back short and reads as the bottom.
    private static let logPage = 50

    private let undoWindowMs: Int64
    private let retryAfter: Duration

    public init(queue: SetQueue = SetQueue(),
                deviceCatalog: DeviceCatalog = DeviceCatalog(),
                accountCopy: AccountCopy = AccountCopy(),
                localLog: LocalLog = LocalLog(),
                bodyweightStore: BodyweightStore = BodyweightStore(),
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                mintSession: @escaping () -> String = Ids.session,
                mintSet: @escaping () -> String = Ids.set,
                undoWindowMs: Int64 = SetQueue.undoWindowMs,
                retryAfter: Duration = .seconds(4),
                sync: @escaping (Account) -> (any TrainingSyncing)? = {
                    $0.isSignedIn ? GymApi(api: $0.api) : nil
                }) {
        self.queue = queue
        self.deviceCatalog = deviceCatalog
        self.accountCopy = accountCopy
        self.localLog = localLog
        self.bodyweightStore = bodyweightStore
        self.now = now
        self.mintSession = mintSession
        self.mintSet = mintSet
        self.undoWindowMs = undoWindowMs
        self.retryAfter = retryAfter
        self.sync = sync
    }

    public enum SaveState: Equatable {
        case idle
        case onTheLog           // the account has it
        case onThisDevice       // nobody signed in, so there is no log to reach
        case blocked(Stall)     // signed in and offered, and this is what stopped it landing
        case refused(String)

        public var line: String? {
            switch self {
            case .idle: return nil
            case .onTheLog: return "on the log"
            case .onThisDevice: return "saved on this device"
            case .blocked(.offline): return "offline · saved here"
            case .blocked(.logFailed): return "the log didn’t answer · saved here"
            case .blocked(.signInLapsed): return "sign in again · saved here"
            case .refused(let reason): return reason
            }
        }
    }

    public enum WriteFailure: Equatable, Error {
        case refused(String)    // the log answered, in its own words
        case noAnswer           // no reply at all, or one this build could not read

        init(_ error: Error) {
            guard let failure = error as? WindmillApiError, case .refused = failure else {
                self = .noAnswer
                return
            }
            self = .refused(failure.line)
        }

        public func line(_ subject: String) -> String {
            switch self {
            case .refused(let said): return said
            case .noAnswer: return "the log didn’t answer — \(subject)"
            }
        }
    }

    public enum FinishOutcome: Equatable {
        case closed(Session)
        case stranded(Int)      // this session's sets that never landed
        case failed(WriteFailure)
    }

    public enum LogFoot: Equatable {
        case more
        case loading
        case bottom
        case failed
    }

    public var todaySets: [TrainingSet] {
        guard let exerciseId else { return [] }
        return sets.filter { $0.exerciseId == exerciseId }
    }

    public var planEntry: PlanEntry? {
        guard let exerciseId else { return nil }
        return session?.plan?.entry(for: exerciseId)
    }

    // Owed as an append means this device is the only home; a correction or deletion is not.
    public var stalled: Set<String> {
        Set(queue.pending.filter { $0.owes == .append }.map(\.set.id))
    }

    public var undoable: TrainingSet? {
        queue.withdrawable(at: now())?.set
    }

    // The instant the queue itself will let that set go. The transient runs on this clock rather than
    // on a second one started after the walk, so it never offers an undo the queue has already spent.
    public var undoableUntilMs: Int64? {
        queue.withdrawable(at: now())?.heldUntilMs
    }

    // A delete whose window is still open: gone from every list published here, still on the log.
    // `WithheldWindow` owns the clock and is what finally sends it — this store only hides the row.
    // The routine is held by value, not by id, because the device's own cache is written from the
    // published list and a hidden routine may not fall out of it while the delete can still be undone.
    private var withheldRoutines: [String: Routine] = [:]
    private var withheldSessions: Set<String> = []

    private func standing(_ list: [Routine]) -> [Routine] {
        guard !withheldRoutines.isEmpty else { return list }
        return list.filter { withheldRoutines[$0.id] == nil }
    }

    public func connect(to account: Account) async {
        seat += 1
        gym = sync(account)
        // Opened under the arriving seat ahead of the repair, the draw, the walk and the claim.
        localLog.open(under: account.user?.id)
        queue.open(under: account.user?.id)
        bodyweightStore.open(under: account.user?.id)
        // Only under a seat the log confirmed this launch: adopting is irreversible.
        if account.isSignedIn, account.verified {
            localLog.adoptTheAnonymousShelf()
            queue.adoptTheAnonymousQueue()
            bodyweightStore.adoptTheAnonymousShelf()
        }
        catalog = merged(deviceCatalog.open(under: account.user?.id))
        lastTimes.removeAll()
        lastTime = nil
        lastTimeFailed = false
        lastSets = nil
        strandedBy = nil
        if let live = queue.session, let kept = localLog.session(live.id) {
            let known = Set(kept.sets.map(\.id))
            let strays = queue.sets(in: live.id).filter { !known.contains($0.id) }
            if !strays.isEmpty {
                localLog.keep(kept.session, sets: kept.sets + strays)
                localLog.flush()
            }
            queue.forget(live.id)
            queue.flush()
        }
        // A live session idle past the auto-close window ended at its last activity.
        if let live = queue.session,
           let closeAt = live.autoCloseAt(lastSetAtMs: queue.sets(in: live.id).last?.completedAtMs,
                                          nowMs: now()) {
            if queue.sessionIsUnclaimed {
                let closed = Session(id: live.id, startedAtMs: live.startedAtMs, finishedAtMs: closeAt,
                                     routineId: live.routineId, plan: live.plan)
                localLog.keep(closed, sets: queue.sets(in: live.id))
                localLog.trained(routine: live.routineId, atMs: closeAt)
                localLog.flush()
                queue.forget(live.id)
            } else {
                queue.close(live.id)
            }
            queue.flush()
        }
        drawFromQueue()
        accountCopy.open(under: account.user?.id)
        routines = Routine.byLastTrained(standing(accountCopy.routines + localLog.routines))
        proposals = []
        preferences = localLog.open(preferencesUnder: account.user?.id) ?? .defaults
        bodyweight = bodyweightStore.entries
        served = []
        recent = mergedRecent([])
        isLoading = false

        guard let gym else {
            logFoot = .bottom
            claimOwedRetryably = false
            saveState = queue.pending.isEmpty ? .idle : .onThisDevice
            if session != nil, let movement = exerciseId { await choose(movement) }
            if lastSetsWanted { await loadLastSets() }
            return
        }
        // Queue, then claim, then the sets parked behind the claim's starts: every read and every start
        // settles the log's open session, so nothing owed may wait behind one.
        await deliver(force: true)
        await claimWhatIsOwed()
        await deliver(force: true)
        await loadLog()
        if let exercises = try? await gym.exercises() {
            catalog = merged(exercises)
            deviceCatalog.hold(catalog)
        }
        await loadRoutines(from: gym)
        await loadProposals(from: gym)
        // Only when nothing is owed: a served document may not land on one the log has never heard.
        if !localLog.preferencesOwed, let held = try? await gym.preferences() {
            preferences = held
            localLog.keep(held, owed: false)
            localLog.flush()
        }
        await loadBodyweight(from: gym)
        if session != nil, let movement = exerciseId { await choose(movement) }
        if lastSetsWanted { await loadLastSets() }
    }

    // ── bodyweight ─────────────────────────────────────────────────────────────────────────────

    // Lands on the device first and is told to the log at once; refused for good it is let go, unreachable it
    // stays owed and the claim replays it. The day is the identity, so a second save for a day is a correction.
    @discardableResult
    public func weighIn(_ weightKg: Double, on dateLocal: String) async -> WriteFailure? {
        // Today is the device's local calendar day, the same day the sheet's picker ends on.
        if let refusal = Bodyweight.dateRefusal(dateLocal, today: Bodyweight.dateLocal(Date())) {
            return .refused(refusal)
        }
        let entry = BodyweightEntry(dateLocal: dateLocal, weightKg: weightKg, recordedAt: now())
        bodyweightStore.keep(entry, owed: true)
        bodyweightStore.flush()
        bodyweight = bodyweightStore.entries
        guard let gym else { return nil }
        // The reply lands on the seat that sent it and on the write it answered — never on the next seat's shelf,
        // never over a deletion or a newer save made while it was in flight.
        let seated = seat
        do {
            let stored = try await gym.putBodyweight(on: dateLocal, BodyweightWrite(weightKg: weightKg,
                                                                                 recordedAt: entry.recordedAt))
            guard seated == seat else { return nil }
            if !bodyweightStore.claimed(entry, as: stored) {
                bodyweightStore.oweDeletion(of: stored, at: now())
                claimOwedRetryably = true
                scheduleDeliver(after: retryAfter)
            }
            bodyweightStore.flush()
            bodyweight = bodyweightStore.entries
            return nil
        } catch {
            guard seated == seat else { return WriteFailure(error) }
            guard case .refused(let said) = claimVerdict(of: error, remintCode: "") else {
                claimOwedRetryably = true
                scheduleDeliver(after: retryAfter)
                return WriteFailure(error)
            }
            bodyweightStore.letGo(entry)
            bodyweightStore.flush()
            bodyweight = bodyweightStore.entries
            return .refused(said ?? "the log refused that weigh-in")
        }
    }

    // Signed out the day simply leaves the shelf; signed in the log is told, and a deletion it could not hear
    // stays owed as a hidden row stamped with the instant it was made, which the claim replays.
    @discardableResult
    public func deleteWeighIn(on dateLocal: String) async -> WriteFailure? {
        guard let gym else {
            bodyweightStore.letGo(on: dateLocal)
            bodyweightStore.flush()
            bodyweight = bodyweightStore.entries
            return nil
        }
        guard let tombstone = bodyweightStore.markDeleted(on: dateLocal, at: now()) else { return nil }
        bodyweightStore.flush()
        bodyweight = bodyweightStore.entries
        // The reply settles the tombstone it answered, on the seat that sent it: a save made for the day while the
        // deletion was in flight stands, still owed.
        let seated = seat
        do {
            try await gym.deleteBodyweight(on: dateLocal)
            guard seated == seat else { return nil }
            bodyweightStore.letGo(tombstone)
            bodyweightStore.flush()
            return nil
        } catch {
            guard seated == seat else { return WriteFailure(error) }
            guard case .refused = claimVerdict(of: error, remintCode: "") else {
                claimOwedRetryably = true
                scheduleDeliver(after: retryAfter)
                return WriteFailure(error)
            }
            bodyweightStore.letGo(tombstone)
            bodyweightStore.flush()
            return WriteFailure(error)
        }
    }

    // The served series lands over the shelf of the seat that asked for it; a read that fails, or one that answers
    // after the seat moved on, leaves the device's rows standing.
    private func loadBodyweight(from gym: any TrainingSyncing) async {
        let seated = seat
        guard let series = try? await gym.bodyweight(), seated == seat else { return }
        bodyweightStore.served(series)
        bodyweightStore.flush()
        bodyweight = bodyweightStore.entries
    }

    // The claim's last slot: every owed weigh-in and deletion, ascending by day, after every session landed.
    // A reply that arrives under another seat touches nothing; a reply for a write the day no longer holds
    // leaves what the day holds now, still owed, and the cadence comes back for it. A replayed deletion reads
    // the day first: a row the log took after the deletion was made is a newer correction, and it wins.
    private func claimBodyweight(with gym: any TrainingSyncing) async -> ClaimEnding {
        defer { bodyweight = bodyweightStore.entries }
        let seated = seat
        var movedOn = false
        for row in bodyweightStore.owed {
            let day = row.entry.dateLocal
            do {
                if row.deleted {
                    if let stored = try await gym.bodyweight(on: day), stored.supersedes(row.entry) {
                        guard seated == seat else { return .settled }
                        bodyweightStore.withdrawDeletion(row.entry, for: stored)
                    } else {
                        try await gym.deleteBodyweight(on: day)
                        guard seated == seat else { return .settled }
                        bodyweightStore.letGo(row.entry)
                    }
                } else {
                    let stored = try await gym.putBodyweight(on: day, BodyweightWrite(weightKg: row.entry.weightKg,
                                                                                    recordedAt: row.entry.recordedAt))
                    guard seated == seat else { return .settled }
                    if !bodyweightStore.claimed(row.entry, as: stored) { bodyweightStore.oweDeletion(of: stored, at: now()) }
                }
                movedOn = movedOn || bodyweightStore.row(on: day)?.owed == true
                bodyweightStore.flush()
            } catch {
                guard seated == seat else { return .settled }
                guard case .refused(let said) = claimVerdict(of: error, remintCode: "") else { return .retry }
                // Terminal as written: let go, so no later connect re-sends it.
                if !row.deleted {
                    refusals.append(.claim(RefusedClaim(id: "weigh-in-\(day)",
                                                        name: "weigh-in · \(Bodyweight.dayMonthYear(day))",
                                                        reason: said ?? "the log refused that weigh-in")))
                }
                bodyweightStore.letGo(row.entry)
                bodyweightStore.flush()
            }
        }
        return movedOn ? .retry : .settled
    }

    @discardableResult
    public func save(_ wanted: GymPreferences) async -> WriteFailure? {
        preferences = wanted
        localLog.keep(wanted, owed: true)
        localLog.flush()
        guard let gym else { return nil }
        let outcome = await sendWhatIsOwed(with: gym)
        if outcome.ending == .retry {
            claimOwedRetryably = true
            scheduleDeliver(after: retryAfter)
        }
        return outcome.why
    }

    private func sendWhatIsOwed(with gym: any TrainingSyncing)
        async -> (ending: ClaimEnding, why: WriteFailure?) {
        guard !settingsSending else { return (.settled, nil) }
        var outcome: (ending: ClaimEnding, why: WriteFailure?) = (.settled, nil)
        while localLog.preferencesOwed, let latest = localLog.preferences {
            outcome = await push(latest, with: gym)
            guard outcome.ending == .settled, outcome.why == nil else { break }
        }
        return outcome
    }

    private func push(_ wanted: GymPreferences,
                      with gym: any TrainingSyncing) async -> (ClaimEnding, WriteFailure?) {
        settingsSending = true
        defer { settingsSending = false }
        do {
            let stored = try await gym.savePreferences(wanted)
            // A tap that landed mid-flight is a newer document; this reply may neither redraw it nor
            // clear its flag.
            guard localLog.preferences == wanted else { return (.settled, nil) }
            preferences = stored
            localLog.keep(stored, owed: false)
            localLog.flush()
            return (.settled, nil)
        } catch {
            // A document refused outright is let go rather than replayed against every future connect.
            guard case .retry = claimVerdict(of: error, remintCode: "") else {
                if localLog.preferences == wanted {
                    localLog.keep(wanted, owed: false)
                    localLog.flush()
                }
                return (.settled, WriteFailure(error))
            }
            return (.retry, WriteFailure(error))
        }
    }

    // A start is never a silent join: every user-tapped start says `joinOpenSession: false`. An account
    // with a session open answers 409 `session-already-open`, re-read here so that workout is adopted.
    public func start(routineId: String? = nil) async -> Result<Session, WriteFailure> {
        guard let gym, !claiming else { return startLocally(routineId: routineId) }
        if let routineId, session == nil, localLog.routine(routineId) != nil {
            return startLocally(routineId: routineId)
        }
        // Every owed append goes out first: a start settles, auto-closing a stale open session.
        await deliver(force: true)
        // One id collision is a coincidence and a fresh id lands. Two is a device that cannot mint.
        var collision = WriteFailure.noAnswer
        for _ in 0..<2 {
            let attempted = Session(id: mintSession(), startedAtMs: now(), routineId: routineId)
            do {
                let opened = try await gym.startSession(
                    SessionStart(id: attempted.id, startedAtMs: attempted.startedAtMs,
                                 routineId: routineId, joinOpenSession: false))
                await adopt(opened, joined: opened.id != attempted.id)
                guard let live = session else { return .failure(.noAnswer) }
                return .success(live)
            } catch let failure as WindmillApiError {
                if case .refused(409, let refusal) = failure, refusal.code == "session-already-open" {
                    await loadLog()
                    return .failure(WriteFailure(failure))
                }
                if case .refused(409, let refusal) = failure, refusal.code == "session-id-taken" {
                    collision = WriteFailure(failure)
                    continue
                }
                // Compose under the id and instant this attempt wore: the claim replays this session.
                guard case .refused(let status, let refusal) = failure,
                      status < 500, refusal.code != "clock-ahead" else {
                    return startLocally(attempted)
                }
                return .failure(WriteFailure(failure))
            } catch {
                return startLocally(attempted)
            }
        }
        return .failure(collision)
    }

    private func startLocally(routineId: String?) -> Result<Session, WriteFailure> {
        startLocally(Session(id: mintSession(), startedAtMs: now(), routineId: routineId))
    }

    private func startLocally(_ attempted: Session) -> Result<Session, WriteFailure> {
        let routineId = attempted.routineId
        var plan: PlanSnapshot?
        if let routineId {
            guard let routine = localLog.routine(routineId) ?? routines.first(where: { $0.id == routineId }) else {
                return .failure(.refused("that routine is not on this device"))
            }
            plan = PlanSnapshot(routine: routine.name,
                                entries: routine.entries
                                    .sorted { $0.position < $1.position }
                                    .map { PlanEntry(exerciseId: $0.exerciseId, sets: $0.targetSets,
                                                     reps: $0.targetReps, weightKg: $0.targetWeightKg,
                                                     restSeconds: $0.restSeconds) })
        }
        let opened = Session(id: attempted.id, startedAtMs: attempted.startedAtMs, routineId: routineId,
                             plan: plan)
        queue.hold(opened, unclaimed: true)
        queue.flush()
        drawFromQueue()
        if gym != nil, !claiming {
            claimOwedRetryably = true
            scheduleDeliver(after: retryAfter)
        }
        return .success(opened)
    }

    // A last time names a finished session, so no answer can change within one workout.
    public func choose(_ movement: String) async {
        queue.append(movement)
        queue.flush()
        order = queue.order
        exerciseId = movement
        lastTime = lastTimes[movement]
        lastTimeFailed = false
        redial()

        guard let gym else {
            let answer = lastTimes[movement] ?? localLog.lastTime(movement) ?? LastTime(exerciseId: movement)
            lastTimes[movement] = answer
            lastTime = answer
            redial()
            return
        }
        guard lastTime == nil else { return }
        guard let answer = try? await gym.lastTime(movement) else {
            lastTimeFailed = exerciseId == movement
            return
        }
        guard answer.exerciseId == movement, exerciseId == movement else { return }
        lastTimes[movement] = answer
        lastTime = answer
        redial()
    }

    public func loadLastSets() async {
        lastSetsWanted = true
        guard let gym else {
            lastSets = localLog.lastSets()
            return
        }
        // Only a seat that has never read leaves the map nil.
        guard let served = (try? await gym.lastSets()) ?? accountCopy.lastSets else { return }
        accountCopy.hold(lastSets: served)
        let account = Dictionary(served.map { ($0.exerciseId, $0) }) { first, _ in first }
        lastSets = account.merging(localLog.lastSets()) { onTheLog, onThisDevice in
            onThisDevice.atMs > onTheLog.atMs ? onThisDevice : onTheLog
        }
    }

    public func reorder(from source: IndexSet, to destination: Int) {
        var moved = order
        moved.move(fromOffsets: source, toOffset: destination)
        queue.hold(order: moved)
        queue.flush()
        order = moved
    }

    public func drop(_ movement: String) async {
        guard LiveOrder.droppable(movement, sets: sets, plan: session?.plan) else { return }
        queue.hold(order: order.filter { $0 != movement })
        queue.flush()
        order = queue.order
        guard exerciseId == movement else { return }
        exerciseId = nil
        lastTime = nil
        lastTimeFailed = false
        guard let resumed = LiveOrder.resume(order: order, sets: sets) else {
            redial()
            return
        }
        await choose(resumed)
    }

    // The kind is the caller's, and the record rules read `kind == working`.
    public func logSet(weightKg: Double, reps: Int, kind: SetKind = .working) async {
        guard let live = session, let movement = exerciseId, !isFinishing else { return }
        let set = TrainingSet(id: mintSet(), exerciseId: movement, weightKg: weightKg, reps: reps,
                              kind: kind, completedAtMs: now())
        queue.store(set, in: live.id, needsPush: true, heldUntilMs: now() + undoWindowMs)
        queue.flush()
        drawFromQueue()
        await deliver()
    }

    @discardableResult
    public func undoLast() -> Bool {
        guard let set = undoable else { return false }
        return withdraw(set.id)
    }

    // The set named, and only while it is still owed as an append: past that the log has it, and no
    // route un-logs a set. The window register calls this one, so an undo cannot take back the wrong row.
    @discardableResult
    public func withdraw(_ setId: String) -> Bool {
        guard queue.withdraw(setId) else { return false }
        queue.flush()
        drawFromQueue()
        return true
    }

    // Leaving keeps the window: what is still held stays held, and the queue's own clock — written to
    // disk beside the row — is what sends it, on the next walk or the next launch.
    public func flushPendingSets() async {
        await deliver()
    }

    // Finishing waits for this session's sets: a session that closed before a set reached it refuses
    // that set forever. An unclaimed session closes on the device and the claim replays it whole.
    public func finish() async -> FinishOutcome {
        guard let live = session else { return .failed(.noAnswer) }
        if queue.sessionIsUnclaimed || gym == nil {
            return await finishLocally(live)
        }
        guard let gym else { return .failed(.noAnswer) }
        isFinishing = true
        defer { isFinishing = false }
        // Forced: a set still inside its window would be skipped by the walk and refused by the close.
        await deliver(force: true)

        let stranded = queue.owed(in: live.id).count
        guard stranded == 0 else { return .stranded(stranded) }
        let closed: Session
        do {
            closed = try await gym.finishSession(live.id, at: now())
        } catch let failure as WindmillApiError {
            guard case .refused(404, _) = failure else { return .failed(WriteFailure(failure)) }
            queue.forget(live.id)
            queue.flush()
            lastTimes.removeAll()
            exerciseId = nil
            lastTime = nil
            drawFromQueue()
            await loadLog()
            return .failed(.refused("that workout is no longer on the log"))
        } catch {
            return .failed(.noAnswer)
        }

        queue.close(live.id)
        queue.flush()
        lastTimes.removeAll()
        exerciseId = nil
        lastTime = nil
        drawFromQueue()
        if !localLog.isEmpty { await claimWhatIsOwed() }
        await loadLog()
        return .closed(closed)
    }

    private func finishLocally(_ live: Session) async -> FinishOutcome {
        isFinishing = true
        defer { isFinishing = false }
        let performed = queue.sets(in: live.id)
        let closed = Session(id: live.id, startedAtMs: live.startedAtMs,
                             finishedAtMs: max(now(), live.startedAtMs),
                             routineId: live.routineId, plan: live.plan)
        localLog.keep(closed, sets: performed)
        localLog.trained(routine: live.routineId, atMs: closed.finishedAtMs ?? live.startedAtMs)
        localLog.flush()
        queue.forget(live.id)
        queue.flush()
        lastTimes.removeAll()
        exerciseId = nil
        lastTime = nil
        drawFromQueue()
        if gym != nil {
            // Hand on the session the log holds: the claim may have reminted the id.
            let landed = await claimWhatIsOwed()
            await loadLog()
            return .closed(landed[closed.id] ?? localLog.session(closed.id)?.session ?? closed)
        }
        routines = Routine.byLastTrained(standing(localLog.routines))
        recent = mergedRecent([])
        return .closed(localLog.session(closed.id)?.session ?? closed)
    }

    // A session the log has never heard of is the device's alone to delete; asking the server 404s.
    public func discard(_ sessionId: String) async -> Bool {
        if localLog.holds(session: sessionId) || (queue.sessionIsUnclaimed && queue.session?.id == sessionId) {
            localLog.claimed(session: sessionId)
            localLog.flush()
            queue.forget(sessionId)
            queue.flush()
            drawFromQueue()
            recent = recent.filter { $0.id != sessionId }
            deviceOnly.remove(sessionId)
            return true
        }
        guard let gym else { return false }
        do {
            try await gym.discardSession(sessionId)
        } catch {
            return false
        }
        queue.forget(sessionId)
        queue.flush()
        drawFromQueue()
        await loadLog()
        return true
    }

    public func keep(_ sets: [TrainingSet], asRoutineNamed name: String) async -> Routine? {
        guard let write = RoutineWrite(named: name, from: sets, position: routines.count) else { return nil }
        guard let gym else {
            let made = write.made
            localLog.keep(made)
            localLog.flush()
            routines.append(made)
            return made
        }
        guard let saved = try? await gym.createRoutine(write) else { return nil }
        routines.append(saved)
        rememberTheProgram()
        return saved
    }

    // History rides only on this read; the list read carries none.
    public func routine(_ id: String) async -> Result<Routine, WriteFailure> {
        if let local = localLog.routine(id) { return .success(local) }
        guard let gym else { return .failure(.refused("that routine is on your account — sign in to read it")) }
        do {
            guard let found = try await gym.routine(id) else {
                forget(routine: id)
                return .failure(.refused("that routine is no longer on the log"))
            }
            routines = Routine.byLastTrained(routines.map { $0.id == found.id ? found : $0 })
            rememberTheProgram()
            return .success(found)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    public func create(_ draft: RoutineDraft) async -> Result<Routine, WriteFailure> {
        let write = draft.write
        guard let gym else {
            let made = write.made
            localLog.keep(made)
            localLog.flush()
            routines = Routine.byLastTrained(routines + [made])
            return .success(made)
        }
        do {
            let saved = try await gym.createRoutine(write)
            routines = Routine.byLastTrained(routines + [saved])
            rememberTheProgram()
            return .success(saved)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // A routine PUT is a whole-document replace, which is why the draft carries every line.
    public func replace(_ draft: RoutineDraft) async -> Result<Routine, WriteFailure> {
        if let held = localLog.routine(draft.id) {
            // The last-trained stamp is not the draft's to carry: this device stamps it at a finish.
            let written = draft.write.made
            let changed = Routine(id: written.id, name: written.name, position: written.position,
                                  lastTrainedAtMs: held.lastTrainedAtMs, entries: written.entries)
            localLog.replace(changed)
            localLog.flush()
            routines = Routine.byLastTrained(routines.map { $0.id == changed.id ? changed : $0 })
            return .success(changed)
        }
        guard let gym else { return .failure(.refused("that routine is not on this device")) }
        do {
            let saved = try await gym.replaceRoutine(draft.id, with: draft.write)
            routines = Routine.byLastTrained(routines.map { $0.id == saved.id ? saved : $0 })
            rememberTheProgram()
            // The write sets every pending proposal aside in the same transaction: re-read, never derived.
            await loadProposals(from: gym)
            return .success(saved)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // The delete cascades the proposal ledger, so this device forgets both; a 404 is the outcome asked for.
    public func deleteRoutine(_ id: String) async -> WriteFailure? {
        if localLog.routine(id) != nil {
            localLog.claimed(routine: id)
            localLog.flush()
            forget(routine: id)
            return nil
        }
        guard let gym else { return .refused("that routine is not on this device") }
        do {
            try await gym.deleteRoutine(id)
        } catch let error as WindmillApiError {
            guard case .refused(404, _) = error else { return WriteFailure(error) }
        } catch {
            return .noAnswer
        }
        forget(routine: id)
        return nil
    }

    // The read is not optional: a PUT replaces the whole document, so an older copy would delete every
    // line added since. The line is addressed by position; a routine that moved under it is refused.
    public func save(_ weightKg: Double, toRoutine routineId: String, at position: Int,
                     for exerciseId: String) async -> WriteFailure? {
        if let local = localLog.routine(routineId) {
            guard let changed = local.retargeting(position: position, exerciseId: exerciseId,
                                                  toWeightKg: weightKg) else {
                return .refused("\(local.name) has changed since this session started")
            }
            localLog.replace(changed)
            localLog.flush()
            routines = routines.map { $0.id == changed.id ? changed : $0 }
            return nil
        }
        guard let gym else { return .refused("that routine is not on this device") }
        do {
            guard let routine = try await gym.routine(routineId) else {
                return .refused("that routine is no longer on the log")
            }
            guard let changed = routine.retargeting(position: position, exerciseId: exerciseId,
                                                    toWeightKg: weightKg) else {
                return .refused("\(routine.name) has changed since this session started")
            }
            let saved = try await gym.replaceRoutine(routineId, with: RoutineWrite(changed))
            routines = routines.map { $0.id == saved.id ? saved : $0 }
            rememberTheProgram()
            await loadProposals(from: gym)
            return nil
        } catch {
            return WriteFailure(error)
        }
    }

    public func pending(of routineId: String) -> [ProposalHead] {
        proposals.filter { $0.routineId == routineId && $0.isPending }
    }

    // Ordered by the day each row is about; ties fall back to the log's newest-minted order.
    public func history(of routineId: String) -> [ProposalHead] {
        proposals
            .filter { $0.routineId == routineId && !$0.isPending }
            .sorted {
                guard $0.recordedAtMs == $1.recordedAtMs else { return $0.recordedAtMs > $1.recordedAtMs }
                guard $0.createdAtMs == $1.createdAtMs else { return $0.createdAtMs > $1.createdAtMs }
                return $0.id > $1.id
            }
    }

    public func proposal(_ id: String) async -> Result<Proposal, WriteFailure> {
        guard let gym else { return .failure(.refused("proposals need your account — sign in first")) }
        do {
            guard let found = try await gym.proposal(id) else {
                forget(proposal: id)
                return .failure(.refused("that proposal is no longer on the log"))
            }
            return .success(found)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // `said` is the server's own sentence when it answered with the row's state instead of the decision asked for
    // (a 409); nil when the decision landed. The room prints it as sent, never in local words.
    public enum Settling: Equatable {
        case settled(Proposal, said: String?)
        case removed            // an applied removal: the routine and its ledger are gone
        case gone               // no such proposal, and there never will be
        case failed(WriteFailure)
    }

    public func apply(_ proposal: Proposal) async -> Settling {
        guard let gym else { return .failed(.refused("proposals need your account — sign in first")) }
        do {
            let landed = try await gym.applyProposal(proposal.id)
            settle(landed.proposal)
            guard let routine = landed.routine else {
                forget(routine: proposal.routineId)
                return .removed
            }
            routines = Routine.byLastTrained(routines.map { $0.id == routine.id ? routine : $0 })
            rememberTheProgram()
            await loadProposals(from: gym)
            return .settled(landed.proposal, said: nil)
        } catch let error as WindmillApiError {
            if proposal.intent == .remove, case .refused(404, _) = error {
                await loadRoutines(from: gym)
                if !routines.contains(where: { $0.id == proposal.routineId }) {
                    forget(routine: proposal.routineId)
                    return .removed
                }
            }
            return await settling(after: error, of: proposal.id, with: gym)
        } catch {
            return .failed(.noAnswer)
        }
    }

    public func dismiss(_ proposalId: String) async -> Settling {
        guard let gym else { return .failed(.refused("proposals need your account — sign in first")) }
        do {
            let settled = try await gym.dismissProposal(proposalId)
            settle(settled)
            return .settled(settled, said: nil)
        } catch let error as WindmillApiError {
            return await settling(after: error, of: proposalId, with: gym)
        } catch {
            return .failed(.noAnswer)
        }
    }

    // `proposal-superseded` and `proposal-settled` are answers, not failures, and neither is retryable. The
    // server's sentence rides with the fresh row, so the room says why in the server's words.
    private func settling(after error: WindmillApiError, of proposalId: String,
                          with gym: any TrainingSyncing) async -> Settling {
        guard case .refused(let status, let refusal) = error else { return .failed(.noAnswer) }
        if status == 404 {
            forget(proposal: proposalId)
            return .gone
        }
        guard status == 409,
              refusal.code == "proposal-superseded" || refusal.code == "proposal-settled" else {
            return .failed(WriteFailure(error))
        }
        await loadRoutines(from: gym)
        await loadProposals(from: gym)
        switch await proposal(proposalId) {
        case .success(let fresh):
            settle(fresh)
            return .settled(fresh, said: refusal.message)
        case .failure(let why):
            return .failed(why)
        }
    }

    private func settle(_ proposal: Proposal) {
        proposals = proposals.map { $0.id == proposal.id ? proposal.head : $0 }
    }

    private func forget(routine routineId: String) {
        routines = routines.filter { $0.id != routineId }
        proposals = proposals.filter { $0.routineId != routineId }
        rememberTheProgram()
    }

    private func forget(proposal proposalId: String) {
        proposals = proposals.filter { $0.id != proposalId }
    }

    private func loadRoutines(from gym: any TrainingSyncing) async {
        guard let written = try? await gym.routines() else { return }
        routines = Routine.byLastTrained(standing(written + localLog.routines))
        rememberTheProgram()
    }

    // What this device would draw with no answer from the log — which includes a routine whose delete
    // is still withheld, because that delete has not happened yet.
    private func rememberTheProgram() {
        let held = routines + withheldRoutines.values
        accountCopy.hold(routines: held.filter { localLog.routine($0.id) == nil })
    }

    private func loadProposals(from gym: any TrainingSyncing) async {
        guard let read = try? await gym.proposals() else { return }
        proposals = read
    }

    // `pattern` is not asked and stays "isolation", the value for unknown.
    public func create(_ name: String, loadedAs equipment: String) async -> Result<Exercise, WriteFailure> {
        let write = ExerciseWrite(name: name, pattern: "isolation", equipment: equipment)
        guard let gym else {
            let made = Exercise(id: write.id, name: write.name, pattern: write.pattern,
                                equipment: write.equipment, custom: true)
            localLog.keep(exercise: write)
            localLog.flush()
            catalog.append(made)
            deviceCatalog.hold(catalog)
            return .success(made)
        }
        do {
            let made = try await gym.createExercise(write)
            catalog.append(made)
            deviceCatalog.hold(catalog)
            return .success(made)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    public func clearRefusals() {
        refusals.removeAll()
    }

    public func review(of sessionId: String) async -> Review? {
        if let local = localLog.review(of: sessionId) { return local }
        guard let gym else { return nil }
        return try? await gym.review(of: sessionId)
    }

    public func sessionDetail(_ sessionId: String) async -> Result<SessionDetail, WriteFailure> {
        if let local = localLog.detail(of: sessionId) { return .success(holding(local)) }
        guard let gym else { return .failure(.refused("that session is on your account — sign in to read it")) }
        do {
            guard let detail = try await gym.session(sessionId) else {
                return .failure(.refused("that session is no longer on the log"))
            }
            return .success(holding(detail))
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    private func holding(_ detail: SessionDetail) -> SessionDetail {
        let owed = queue.owed(in: detail.session.id)
        guard !owed.isEmpty else { return detail }
        return SessionDetail(session: detail.session,
                             sets: detail.sets.compactMap { set -> TrainingSet? in
                                 guard let mine = owed.first(where: { $0.set.id == set.id }) else { return set }
                                 return mine.owes == .delete ? nil : mine.set
                             })
    }

    // Where the set lives decides the write: a shelf session is corrected there, a row owed as an
    // append is rewritten in the queue, and only a row the log holds goes over the wire.
    @discardableResult
    public func fix(_ set: TrainingSet, in sessionId: String, by correction: SetFix) async -> TrainingSet {
        let corrected = set.corrected(by: correction)
        if localLog.holds(session: sessionId) {
            localLog.fix(set: set.id, in: sessionId, by: correction)
            localLog.flush()
            recent = mergedRecent(served)
            return corrected
        }
        if logHasNeverSeen(set.id, in: sessionId) {
            queue.rewrite(corrected, in: sessionId)
            queue.flush()
            drawFromQueue()
            await deliver()
            return corrected
        }
        let said = refusals.count
        queue.fix(corrected, in: sessionId)
        queue.flush()
        await deliver()
        // Only refusals this call collected: an older loss would answer for a write nobody has made.
        let refused = refusals.dropFirst(said).contains {
            guard case .change(let lost) = $0 else { return false }
            return lost.id == set.id
        }
        return refused ? set : corrected
    }

    // The one place a set the log holds can be taken away. The room's window register owns the clock
    // and hands the instant in; the queue writes its own copy to disk, so a delete outlives the
    // process that made it and no undo can arrive after the wire.
    public func delete(_ set: TrainingSet, in sessionId: String, heldUntilMs: Int64? = nil) async {
        let until = heldUntilMs ?? (now() + undoWindowMs)
        if localLog.holds(session: sessionId) {
            localLog.drop(set: set.id, in: sessionId)
            localLog.flush()
            recent = mergedRecent(served)
            return
        }
        // A row the log has never been told about: letting the queue's row go is the whole deletion.
        if logHasNeverSeen(set.id, in: sessionId) {
            queue.drop(set.id)
            queue.flush()
            drawFromQueue()
            return
        }
        queue.delete(set, in: sessionId, heldUntilMs: until)
        queue.flush()
        await deliver()
    }

    // Offered while the window register still holds the delete, and never after it: the record is
    // let go only once a repair has taken.
    @discardableResult
    public func restore(_ set: TrainingSet, in sessionId: String) async -> Bool {
        if let local = localLog.session(sessionId) {
            guard !local.sets.contains(where: { $0.id == set.id }) else { return false }
            localLog.keep(local.session, sets: local.sets + [set])
            localLog.flush()
            recent = mergedRecent(served)
            return true
        }
        if queue.restore(set.id) {
            queue.flush()
            drawFromQueue()
            return true
        }
        queue.store(set, in: sessionId, needsPush: true)
        queue.flush()
        drawFromQueue()
        await deliver()
        return true
    }

    // A routine, a conversation and a finished workout have no on-disk hold to wait in, so the row
    // leaves the list here and the send waits for the window's own clock. Nothing is on the wire yet.
    public func withhold(routine: Routine) {
        withheldRoutines[routine.id] = routine
        routines = routines.filter { $0.id != routine.id }
    }

    public func restore(routine: Routine) {
        withheldRoutines[routine.id] = nil
        routines = Routine.byLastTrained(routines.filter { $0.id != routine.id } + [routine])
    }

    public func settleDelete(routine id: String) async -> WriteFailure? {
        withheldRoutines[id] = nil
        return await deleteRoutine(id)
    }

    public func withhold(session id: String) {
        withheldSessions.insert(id)
        recent = mergedRecent(served)
    }

    public func restore(session id: String) {
        withheldSessions.remove(id)
        recent = mergedRecent(served)
    }

    public func settleDelete(session id: String) async -> Bool {
        withheldSessions.remove(id)
        return await discard(id)
    }

    // A PATCH filed over an owed append destroys the only copy of that set.
    private func logHasNeverSeen(_ setId: String, in sessionId: String) -> Bool {
        if queue.sessionIsUnclaimed, queue.session?.id == sessionId { return true }
        return queue.owes(setId) == .append
    }

    // The device answers only where it is the only home. Who answered rides back: it computes no Epley.
    public func record(of exerciseId: String) async -> Result<Record.Answer, WriteFailure> {
        let named = catalog.first { $0.id == exerciseId } ?? Exercise(id: exerciseId, name: exerciseId)
        guard let gym, !localLog.exercises.contains(where: { $0.id == exerciseId }) else {
            return .success(Record.Answer(localLog.record(of: named), from: .thisDevice))
        }
        // A served record settles the log's open session, so it waits out a claim mid-replay.
        await waitOutTheClaim()
        do {
            guard let record = try await gym.record(of: exerciseId) else {
                return .failure(.refused("that movement is no longer in your catalog"))
            }
            return .success(Record.Answer(record, from: .theLog))
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    public func unclaimed(_ exerciseId: String) -> Bool {
        localLog.holdsSets(of: exerciseId)
    }

    // The id never moves, so every set, entry and frozen plan still points at the same movement. A
    // movement on the shelf is renamed there whoever is signed in: a PATCH would 404.
    public func rename(_ exerciseId: String, to name: String) async -> WriteFailure? {
        if localLog.exercises.contains(where: { $0.id == exerciseId }) {
            localLog.rename(exercise: exerciseId, to: name)
            localLog.flush()
            catalog = catalog.map {
                guard $0.id == exerciseId else { return $0 }
                return Exercise(id: $0.id, name: name, pattern: $0.pattern, equipment: $0.equipment,
                                stepKg: $0.stepKg, custom: $0.custom)
            }
            deviceCatalog.hold(catalog)
            return nil
        }
        guard let gym else { return .refused("renaming this movement needs your account — sign in first") }
        do {
            guard let saved = try await gym.renameExercise(exerciseId, to: name) else {
                return .refused("that movement is no longer in your catalog")
            }
            catalog = catalog.map { $0.id == saved.id ? saved : $0 }
            deviceCatalog.hold(catalog)
            return nil
        } catch {
            return WriteFailure(error)
        }
    }

    public func share(_ sessionId: String) async -> Result<SessionShare, WriteFailure> {
        guard let gym else { return .failure(.refused("sharing needs your account — sign in first")) }
        do {
            return .success(try await gym.share(sessionId))
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    public func revokeShare(_ sessionId: String) async -> WriteFailure? {
        guard let gym else { return .refused("sharing needs your account — sign in first") }
        do {
            try await gym.revokeShare(sessionId)
            return nil
        } catch {
            return WriteFailure(error)
        }
    }

    // One pass per (session, movement) lane, so a set that cannot land holds up its own lane only.
    private func deliver(force: Bool = false) async {
        retryTask?.cancel()
        retryTask = nil
        guard !queue.pending.isEmpty else {
            if claimOwedRetryably { scheduleDeliver(after: retryAfter) }
            return
        }
        guard let gym else {
            settle(.onThisDevice)
            return
        }

        // Sets of an unclaimed session are parked: every send would 404 until the claim opens the road.
        let parked = queue.sessionIsUnclaimed ? queue.session?.id : nil
        var blocked: Set<SetQueue.Lane> = Set(parked.map { queue.owed(in: $0).map(\.lane) } ?? [])
        var refusal: String?
        var movedHistory = false
        var vanished: Set<String> = []
        var blockedBy: Stall?
        while let owed = queue.nextOwed(skipping: blocked, readyAt: force ? nil : now()) {
            do {
                switch owed.write {
                case .append:
                    let stored = try await gym.appendSet(to: owed.sessionId, SetWrite(owed.set))
                    queue.delivered(stored, for: owed.set.id, in: owed.sessionId)
                case .fix:
                    let stored = try await gym.fixSet(owed.set.id, in: owed.sessionId,
                                                      SetFix(whole: owed.set))
                    queue.delivered(stored, for: owed.set.id, in: owed.sessionId)
                    movedHistory = true
                case .delete:
                    try await gym.deleteSet(owed.set.id, in: owed.sessionId)
                    queue.drop(owed.set.id)
                    movedHistory = true
                }
            } catch {
                // Every session the walk carries is one the log once answered for: a 404 is it gone.
                let verdict = Verdict(refusing: error, sessionOnTheLog: true)
                // `set-not-found` is a change's word, never an append's, so an append keeps waiting.
                if case .gone = verdict, owed.write == .append {
                    blocked.insert(owed.lane)
                    if blockedBy == nil { blockedBy = Stall(error) }
                    continue
                }
                if case .vanished = verdict { vanished.insert(owed.sessionId) }
                // A spent id is an append's repair alone: a fresh id aims a change at nothing.
                let budget = owed.write == .append ? owed.remints : SetQueue.maxRemints
                if let reason = verdict.terminalReason(afterRemints: budget) {
                    queue.drop(owed.set.id)
                    refusals.append(owed.write == .append
                                    ? .set(RefusedSet(owed.set, reason: reason))
                                    : .change(RefusedSet(owed.set, reason: reason)))
                    if owed.write == .append { refusal = reason }
                    continue
                }
                if case .remint = verdict {
                    queue.remint(owed.set.id, as: mintSet())
                    continue
                }
                blocked.insert(owed.lane)
                if blockedBy == nil { blockedBy = Stall(error) }
            }
        }

        for sessionId in vanished { queue.forget(sessionId) }
        queue.flush()
        drawFromQueue()
        strandedBy = blockedBy
        // A past session's row is the server's arithmetic, and a correction moves all of it.
        if movedHistory || !vanished.isEmpty { await loadLog() }

        // Scheduled off every write still carried, so a refusal in one lane cannot take the retry from
        // a set jammed in another. Parked sets are not carried.
        let carried = queue.pending.filter { $0.sessionId != parked }
        if let earliestReady = carried.map({ $0.heldUntilMs ?? 0 }).min() {
            let waiting = earliestReady - now()
            scheduleDeliver(after: waiting > 0 ? .milliseconds(waiting) : retryAfter)
        } else if claimOwedRetryably {
            scheduleDeliver(after: retryAfter)
        }

        if let refusal {
            settle(.refused(refusal))
            return
        }
        let owedSets = queue.pending.filter { $0.owes == .append }
        guard let earliestSet = owedSets.filter({ $0.sessionId != parked })
            .map({ $0.heldUntilMs ?? 0 }).min() else {
            settle(owedSets.isEmpty ? .onTheLog : .onThisDevice)
            return
        }
        guard earliestSet - now() > 0 else {
            settle(.blocked(blockedBy ?? .logFailed))
            return
        }
    }

    private func scheduleDeliver(after delay: Duration) {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            // Let go of the handle first: `deliver` cancels the pending send, and would cancel itself.
            retryTask = nil
            // Queue before the shelf and again after it, and never while one is already replaying.
            if claimOwedRetryably, !claiming {
                await deliver()
                await claimWhatIsOwed()
                await deliver()
                if !claimOwedRetryably { await loadLog() }
                return
            }
            await deliver()
        }
    }

    // Replayed in dependency order: settings, movements, routines, finished sessions oldest first, the
    // live session's start, then bodyweight last. Per session — start under the client-minted id at the true
    // startedAt with `joinOpenSession: false`, every set per lane in order, finish at the true instant.
    // No log or stats read interleaves: one would auto-close a stale session mid-replay. Keyed by the
    // id each session wore before the claim.
    @discardableResult
    private func claimWhatIsOwed() async -> [String: Session] {
        var landed: [String: Session] = [:]
        // One runner, ever: a claim asked for mid-replay parks a rerun and returns.
        if claiming {
            claimAgainWhenDone = true
            return landed
        }
        claiming = true
        defer {
            claiming = false
            let waiting = untilTheClaimEnds
            untilTheClaimEnds = []
            for read in waiting { read.resume() }
        }
        repeat {
            claimAgainWhenDone = false
            guard let gym else {
                claimOwedRetryably = false
                return landed
            }
            let seated = seat
            let ending = await replayTheShelf(with: gym, landing: &landed)
            guard seated == seat else { continue }
            claimOwedRetryably = ending == .retry
            if ending == .retry { scheduleDeliver(after: retryAfter) }
        } while claimAgainWhenDone
        return landed
    }

    private func waitOutTheClaim() async {
        while claiming {
            await withCheckedContinuation { untilTheClaimEnds.append($0) }
        }
    }

    private func replayTheShelf(with gym: any TrainingSyncing,
                                landing landed: inout [String: Session]) async -> ClaimEnding {
        // Settings halt nothing behind them: a document that could not go out rides the cadence with the rest.
        let settings = await sendWhatIsOwed(with: gym).ending
        for write in localLog.exercises {
            let ending = await claim(exercise: write, with: gym)
            guard ending == .settled else { return ending }
        }
        for routine in localLog.routines {
            let ending = await claim(routine: routine, with: gym)
            guard ending == .settled else { return ending }
        }
        for local in localLog.sessions {
            switch await claim(session: local, with: gym) {
            case .landed(let claimed): landed[local.session.id] = claimed
            case .skipped: continue
            case .halted(let ending): return ending
            }
        }
        if queue.sessionIsUnclaimed, let live = queue.session {
            let ending = await claimLive(live, with: gym)
            guard ending == .settled else { return ending }
        }
        let weighIns = await claimBodyweight(with: gym)
        return settings == .retry || weighIns == .retry ? .retry : .settled
    }

    private func claim(exercise write: ExerciseWrite, with gym: any TrainingSyncing) async -> ClaimEnding {
        var write = write
        for _ in 0...SetQueue.maxRemints {
            do {
                _ = try await gym.createExercise(write)
                localLog.claimed(exercise: write.id)
                localLog.flush()
                return .settled
            } catch {
                switch claimVerdict(of: error, remintCode: "exercise-id-taken") {
                case .remint:
                    let fresh = Ids.exercise()
                    localLog.remint(exercise: write.id, as: fresh)
                    localLog.flush()
                    queue.remapExercise(write.id, to: fresh)
                    queue.flush()
                    catalog = catalog.map {
                        $0.id == write.id
                            ? Exercise(id: fresh, name: $0.name, pattern: $0.pattern,
                                       equipment: $0.equipment, stepKg: $0.stepKg, custom: true)
                            : $0
                    }
                    deviceCatalog.hold(catalog)
                    write = ExerciseWrite(id: fresh, name: write.name, pattern: write.pattern,
                                          equipment: write.equipment, stepKg: write.stepKg)
                case .refused(let said):
                    // Terminal as written: let go, so no later connect re-sends it. Its sets keep the id.
                    refusals.append(.claim(RefusedClaim(id: write.id, name: write.name,
                                                        reason: said ?? "the log refused this movement")))
                    localLog.claimed(exercise: write.id)
                    localLog.flush()
                    return .settled
                case .retry:
                    return .retry
                case .wait, .dropped:
                    return .wait
                }
            }
        }
        return .wait
    }

    private func claim(routine: Routine, with gym: any TrainingSyncing) async -> ClaimEnding {
        var routine = routine
        for _ in 0...SetQueue.maxRemints {
            do {
                _ = try await gym.createRoutine(RoutineWrite(routine))
                localLog.claimed(routine: routine.id)
                localLog.flush()
                return .settled
            } catch {
                switch claimVerdict(of: error, remintCode: "routine-id-taken") {
                case .remint:
                    let fresh = Ids.routine()
                    localLog.remint(routine: routine.id, as: fresh)
                    localLog.flush()
                    queue.remapRoutine(routine.id, to: fresh)
                    queue.flush()
                    routines = routines.map {
                        $0.id == routine.id
                            ? Routine(id: fresh, name: $0.name, position: $0.position,
                                      lastTrainedAtMs: $0.lastTrainedAtMs, entries: $0.entries)
                            : $0
                    }
                    routine = Routine(id: fresh, name: routine.name, position: routine.position,
                                      lastTrainedAtMs: routine.lastTrainedAtMs, entries: routine.entries)
                case .refused(let said):
                    // Terminal as written, then orphaned: the sessions keep their frozen plan.
                    refusals.append(.claim(RefusedClaim(id: routine.id, name: routine.name,
                                                        reason: said ?? "the log refused this routine")))
                    localLog.orphan(routine: routine.id)
                    localLog.flush()
                    return .settled
                case .retry:
                    return .retry
                case .wait, .dropped:
                    return .wait
                }
            }
        }
        return .wait
    }

    private enum SessionClaim {
        case landed(Session)
        case skipped        // the session stays on the shelf for a later pass
        case halted(ClaimEnding)
    }

    private func claim(session local: LocalLog.LocalSession,
                       with gym: any TrainingSyncing) async -> SessionClaim {
        var local = local
        var opened = false
        var remints = 0
        while !opened {
            do {
                _ = try await gym.startSession(SessionStart(id: local.session.id,
                                                            startedAtMs: Instants.clamped(local.session.startedAtMs),
                                                            routineId: local.session.routineId,
                                                            joinOpenSession: false))
                opened = true
            } catch {
                // The one 404 a start can meet is a deleted routine; the plan is frozen already.
                if let failure = error as? WindmillApiError, case .refused(404, _) = failure,
                   let gone = local.session.routineId {
                    localLog.orphan(routine: gone)
                    localLog.flush()
                    guard let moved = localLog.session(local.session.id) else { return .halted(.wait) }
                    local = moved
                    continue
                }
                switch claimVerdict(of: error, remintCode: "session-id-taken") {
                case .remint:
                    remints += 1
                    guard remints <= SetQueue.maxRemints else { return .halted(.wait) }
                    let fresh = mintSession()
                    localLog.remint(session: local.session.id, as: fresh)
                    localLog.flush()
                    guard let moved = localLog.session(fresh) else { return .halted(.wait) }
                    local = moved
                case .retry:
                    return .halted(.retry)
                case .wait:
                    // When the open workout is this phone's own live session the shelf session skips:
                    // halting would park everything behind it.
                    guard queue.session != nil, !queue.sessionIsUnclaimed else { return .halted(.wait) }
                    return .skipped
                case .refused(let said):
                    // A start refused as written can never land: let go with its sets, never re-sent.
                    return letGo(local.session, saying: said ?? "the log refused this workout")
                case .dropped:
                    return .halted(.wait)
                }
            }
        }

        // Re-read per set rather than walked off the snapshot: a correction or deletion made while the
        // replay is parked would otherwise land as the original number, or resurrect a deleted set.
        for id in local.sets.map(\.id) {
            guard let held = localLog.session(local.session.id)?.sets.first(where: { $0.id == id }) else {
                continue
            }
            var write = held
            var remints = 0
            var settled = false
            while !settled {
                do {
                    _ = try await gym.appendSet(to: local.session.id, SetWrite(write.clamped))
                    settled = true
                } catch {
                    // The start answered, so a plain 404 is the workout gone.
                    let verdict = Verdict(refusing: error, sessionOnTheLog: true)
                    // The claim only ever appends, and `set-not-found` is not an append's word.
                    if case .gone = verdict { return .halted(.retry) }
                    if case .vanished(let said) = verdict {
                        return letGo(local.session, saying: said)
                    }
                    if case .remint = verdict, remints < SetQueue.maxRemints {
                        remints += 1
                        let fresh = mintSet()
                        localLog.remint(set: write.id, in: local.session.id, as: fresh)
                        localLog.flush()
                        write = write.reminted(as: fresh)
                        continue
                    }
                    if let reason = verdict.terminalReason(afterRemints: SetQueue.maxRemints) {
                        localLog.drop(set: write.id, in: local.session.id)
                        localLog.flush()
                        refusals.append(.set(RefusedSet(write, reason: reason)))
                        settled = true
                        continue
                    }
                    return .halted(.retry)
                }
            }
        }

        let startedAt = Instants.clamped(local.session.startedAtMs)
        let finishedAt = max(Instants.clamped(local.session.finishedAtMs ?? startedAt), startedAt)
        do {
            let settled = try await gym.finishSession(local.session.id, at: finishedAt)
            localLog.claimed(session: local.session.id)
            localLog.flush()
            return .landed(settled)
        } catch {
            if case .vanished(let said) = Verdict(refusing: error, sessionOnTheLog: true) {
                return letGo(local.session, saying: said)
            }
            if case .retry = claimVerdict(of: error, remintCode: "") { return .halted(.retry) }
            return .halted(.wait)
        }
    }

    private func letGo(_ session: Session, saying reason: String) -> SessionClaim {
        refusals.append(.claim(RefusedClaim(
            id: session.id,
            name: "\(Readout.routine(of: session)) · \(Readout.dateWithYear(session.startedAtMs))",
            reason: reason)))
        localLog.claimed(session: session.id)
        localLog.flush()
        return .skipped
    }

    // The live session claims the same way minus finish; the ordinary queue then owns its sets.
    private func claimLive(_ live: Session, with gym: any TrainingSyncing) async -> ClaimEnding {
        var live = live
        for _ in 0...SetQueue.maxRemints {
            do {
                let opened = try await gym.startSession(SessionStart(id: live.id,
                                                                     startedAtMs: Instants.clamped(live.startedAtMs),
                                                                     routineId: live.routineId,
                                                                     joinOpenSession: false))
                queue.hold(opened, unclaimed: false)
                queue.flush()
                drawFromQueue()
                return .settled
            } catch {
                switch claimVerdict(of: error, remintCode: "session-id-taken") {
                case .remint:
                    let fresh = mintSession()
                    queue.remapSession(live.id, to: fresh)
                    queue.flush()
                    drawFromQueue()
                    guard let moved = queue.session else { return .wait }
                    live = moved
                case .retry:
                    return .retry
                case .refused(let said):
                    // The live session cannot be let go — the lifter is standing in it — so it parks.
                    let loss = RefusedWrite.claim(RefusedClaim(
                        id: live.id, name: Readout.routine(of: live),
                        reason: said ?? "the log refused this workout"))
                    if !refusals.contains(loss) { refusals.append(loss) }
                    return .wait
                case .wait, .dropped:
                    return .wait
                }
            }
        }
        return .wait
    }

    // `wait` covers what only an event can move; `retry` rides the queue's cadence.
    private enum ClaimEnding: Equatable {
        case settled, wait, retry
    }

    // By code and never by sentence, extended with the codes only a start can meet.
    private enum ClaimVerdict {
        case remint, wait, dropped, retry
        case refused(String?)
    }

    private func claimVerdict(of error: Error, remintCode: String) -> ClaimVerdict {
        guard let failure = error as? WindmillApiError,
              case .refused(let status, let refusal) = failure else { return .retry }
        if refusal.code == remintCode { return .remint }
        if refusal.code == "session-already-open" { return .wait }
        if refusal.code == "session-finished" { return .dropped }
        // Clock-ahead is transient — the instant ages into the past — so it rides the cadence.
        if refusal.code == "clock-ahead" { return .retry }
        if status >= 500 { return .retry }
        if status == 400 || status == 409 { return .refused(refusal.message) }
        // 401 waits for the Keychain, 404 for the thing to exist: the retry class, never a drop.
        return .retry
    }

    // Never shallower than it already was: `served` is both the drawn log and `loadOlder`'s cursor.
    private func loadLog() async {
        guard gym != nil else { return }
        await waitOutTheClaim()
        guard let gym else { return }
        logFoot = .loading
        var read: [SessionSummary] = []
        var more = true
        while more, read.count < max(served.count, Self.logPage) {
            guard let page = try? await gym.sessions(before: read.last?.session.startedAtMs,
                                                     beforeId: read.last?.id,
                                                     limit: Self.logPage) else {
                logFoot = .failed
                return
            }
            read += page
            more = page.count == Self.logPage
        }
        served = read
        logFoot = more ? .more : .bottom
        recent = mergedRecent(read)

        // A claim begun while the pages were on the wire may hold a replayed session open.
        guard !claiming else { return }
        guard let open = read.first(where: { $0.session.isOpen }) else {
            // The session row goes; a set still owed does not, because a set nobody answered for has
            // not been refused. An unclaimed session is the exception: the log never held it.
            if let live = queue.session, !queue.sessionIsUnclaimed { queue.close(live.id) }
            queue.flush()
            drawFromQueue()
            return
        }
        // Another session open on the account: the phone keeps its own unclaimed workout and waits.
        if queue.sessionIsUnclaimed, queue.session?.id != open.session.id { return }
        await adopt(open.session, joined: true)
    }

    // The cursor is both halves of the sort key: two sessions can share an instant.
    public func loadOlder() async {
        guard gym != nil, logFoot != .loading else { return }
        logFoot = .loading
        await waitOutTheClaim()
        guard let gym else { return }
        let cursor = served.last
        guard let page = try? await gym.sessions(before: cursor?.session.startedAtMs,
                                                 beforeId: cursor?.id,
                                                 limit: Self.logPage) else {
            logFoot = .failed
            return
        }
        served += page
        logFoot = page.count < Self.logPage ? .bottom : .more
        recent = mergedRecent(served)
    }

    private func mergedRecent(_ server: [SessionSummary]) -> [SessionSummary] {
        let known = Set(server.map(\.id))
        let local = localLog.summaries().filter { !known.contains($0.id) }
        deviceOnly = Set(local.map(\.id))
        return (server + local)
            .filter { !withheldSessions.contains($0.id) }
            .sorted { $0.session.startedAtMs > $1.session.startedAtMs }
    }

    // Without the fold, a catalog read while the claim is still owed erases a movement mid-session.
    private func merged(_ server: [Exercise]) -> [Exercise] {
        let known = Set(server.map(\.id))
        let unclaimed = localLog.exercises.filter { !known.contains($0.id) }
            .map { Exercise(id: $0.id, name: $0.name, pattern: $0.pattern,
                            equipment: $0.equipment, stepKg: $0.stepKg, custom: true) }
        return server + unclaimed
    }

    private func adopt(_ opened: Session, joined: Bool) async {
        queue.hold(opened)
        // A joined session holds sets this device may not have: the row alone would draw an empty one.
        if joined, let gym, let detail = try? await gym.session(opened.id) {
            queue.hold(detail.session)
            for set in detail.sets { queue.store(set, in: detail.session.id, needsPush: false) }
        }
        queue.flush()
        drawFromQueue()
    }

    private func drawFromQueue() {
        session = queue.session
        sets = queue.sets
        let merged = LiveOrder.merged(held: queue.order, plan: session?.plan, sets: sets)
        if merged != queue.order {
            queue.hold(order: merged)
            queue.flush()
        }
        order = merged
        // Counted off the queue, never off `saveState`. A set inside its undo window is not stranded,
        // nor is a parked set, a correction, a deletion, or anything signed out.
        let instant = now()
        let parked = queue.sessionIsUnclaimed ? queue.session?.id : nil
        strandedCount = gym == nil
            ? 0
            : queue.pending.filter {
                $0.owes == .append && !$0.isHeld(at: instant) && $0.sessionId != parked
            }.count
        redial()
    }

    private func redial() {
        prefill = Prefill(todaySets: todaySets, planEntry: planEntry, lastTime: lastTime)
    }

    private func settle(_ state: SaveState) {
        saveState = state
        saveTick += 1
    }
}
