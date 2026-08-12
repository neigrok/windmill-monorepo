import Foundation
import SwiftUI
import WindmillPlatform

// The live session, wired — the Swift twin of Android's TrainingStore.kt, and the one place in gym
// where the pure rules meet the network, the clock and the disk. Everything it decides it decides
// by asking a module: the ladder moves the weight, Prefill picks the number, the queue owns
// durability. This file is the plumbing and none of the meaning.
//
// The order of every write is the same and never varies: mint an id → store on the device → tell the
// log, or owe it. Nothing is ever held in memory waiting for a network call to decide whether it
// counts, and nothing about logging changes offline.
//
// Named for what it holds — the training, beside `TrainingRepository` and `TrainingSyncing` — and not
// for the session, because `WindmillPlatform.SessionStore` is the Keychain secret store behind
// AuthStore. Two unrelated things wearing one name in one app is the shape that hides a bug.

@MainActor
public final class TrainingStore: ObservableObject {
    @Published public private(set) var catalog: [Exercise] = []
    @Published public private(set) var routines: [Routine] = []
    @Published public private(set) var recent: [SessionSummary] = []      // the log, newest first
    // Which of those rows this device is still the only home for — the hollow ring on the log (§G16).
    // Set by the same fold that puts them in `recent`, because it is one fact read twice: a session
    // is the device's alone exactly when the served page did not name it.
    @Published public private(set) var deviceOnly: Set<String> = []
    @Published public private(set) var logFoot: LogFoot = .loading
    @Published public private(set) var session: Session?                  // the open one, or none
    @Published public private(set) var sets: [TrainingSet] = []           // its sets, performed order
    @Published public private(set) var order: [String] = []               // its movements, walk order
    @Published public private(set) var exerciseId: String?                // the movement in hand
    @Published public private(set) var lastTime: LastTime?
    // Whether the read was ASKED and came back empty-handed, which is a different fact from not
    // having asked yet. Without it the card says "reading your log…" forever after a failure, and a
    // movement the lifter has trained for a year reads as one they never have.
    @Published public private(set) var lastTimeFailed = false
    @Published public private(set) var prefill: Prefill = .emptyBar
    @Published public private(set) var refusals: [RefusedWrite] = []      // writes that never landed
    @Published public private(set) var saveState: SaveState = .idle
    @Published public private(set) var saveTick = 0                       // bumps once per write
    // How many sets are on this device and nowhere else after the walk has already OFFERED them —
    // the strip's own fact, kept apart from `saveState` because they are two facts and one word
    // cannot say both. A set refused outright in one lane and a set merely jammed behind a 500 in
    // another happen in the same walk, and the second one is what the strip exists to name.
    @Published public private(set) var strandedCount = 0
    @Published public private(set) var isLoading = true
    // Finish is a round trip, and a set logged into a session that closes under it is refused
    // forever. Published rather than private so the room can say where that set can still go —
    // silently dropping the tap and silently taking it are both ways of losing a lift.
    @Published public private(set) var isFinishing = false

    // The log as the SERVER has answered it so far, page after page, in the order it came back. The
    // cursor for the next page is its tail, and the fold that makes `recent` runs over the whole of
    // it — a page that replaced the last one would drop everything a lifter had already loaded.
    private var served: [SessionSummary] = []

    // The oldest instant the SERVER has answered for — the floor of everything that has been read,
    // and what tells the log's fold which weeks are whole. `recent`'s own oldest cannot stand in for
    // it: this device's unclaimed sessions are merged in at ANY age, so one of them sits below the
    // served page and would pass off a half-loaded week as a finished one.
    public var servedOldestMs: Int64? { served.last?.session.startedAtMs }

    private let queue: SetQueue
    private let deviceCatalog: DeviceCatalog
    private let localLog: LocalLog
    private let now: () -> Int64
    private let mintSession: () -> String
    private let mintSet: () -> String
    private let sync: (Account) -> (any TrainingSyncing)?
    private var gym: (any TrainingSyncing)?
    private var lastTimes: [String: LastTime] = [:]
    private var retryTask: Task<Void, Never>?
    // True while THE claim runner is replaying the shelf — the window in which an ordinary start
    // must compose on the device instead, because the server would default-JOIN a replayed session.
    // One runner ever holds it: a claim asked for mid-replay parks `claimAgainWhenDone` on the
    // runner instead of walking beside it. Two walks over one shelf would each re-file the other's
    // sessions, and whichever ended first would drop this flag while the other still had a replayed
    // session open on the log — the exact window a Start would JOIN.
    private var claiming = false
    // The rerun the one runner owes: a connect or a local finish asked to claim while a replay was
    // in flight. The runner clears it before each walk, so one mark buys one rerun — under
    // whatever seat is current by the time it walks.
    private var claimAgainWhenDone = false
    // Bumped by every connect. The claim run captures it before replaying, and an ending computed
    // under an old seat is discarded — the account changed while the run was parked on a slow
    // call, and that seat's own connect owns the flags and the cadence now (Android's `gym !== log`
    // identity check, done by generation here because `GymApi` is a value).
    private var seat = 0
    // The last claim ended still owing the shelf for a reason that can heal on its own — offline, a
    // 5xx, a 401 waiting for the Keychain, a 404. While this is true the queue's own retry cadence
    // carries the claim as well as the sets (wave 2 §A): one scheduler, one beat, no second timer. A
    // claim parked behind the account's open workout (WAIT) does NOT set it — polling a remote
    // human's live session every four seconds is noise, and the next connect resumes it.
    private var claimOwedRetryably = false

    // At or under the server's own ceiling: the handler clamps `limit` to 200, and a larger page here
    // would come back short of what was asked for and read as the bottom of the log.
    private static let logPage = 50

    private let undoWindowMs: Int64
    private let retryAfter: Duration

    public init(queue: SetQueue = SetQueue(),
                deviceCatalog: DeviceCatalog = DeviceCatalog(),
                localLog: LocalLog = LocalLog(),
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
        self.localLog = localLog
        self.now = now
        self.mintSession = mintSession
        self.mintSet = mintSet
        self.undoWindowMs = undoWindowMs
        self.retryAfter = retryAfter
        self.sync = sync
    }

    // How a write reports itself: mono, lower-case, never a toast and never an alert (the journal's
    // voice, JournalRoom's SavedNote). Silence is a state — a room that has just opened says nothing.
    // A refusal speaks in the log's own words, because it is the last copy of a set that never landed.
    public enum SaveState: Equatable {
        case idle
        case onTheLog           // the account has it
        case onThisDevice       // nobody signed in — there is no log to reach, and that is fine
        case offline            // signed in, but this set has not landed yet
        case refused(String)

        public var line: String? {
            switch self {
            case .idle: return nil
            case .onTheLog: return "on the log"
            case .onThisDevice: return "saved on this device"
            case .offline: return "offline · saved here"
            case .refused(let reason): return reason
            }
        }
    }

    // What a write that did not land can say, and the one distinction that matters: A LOG THAT
    // ANSWERED WITH A REASON IS NOT A LOG THAT WENT QUIET. The lifter can act on the first — the
    // routine was deleted from the web, the movement id is spent, the session is already over — and
    // can only wait out the second. Collapsing both into nil pointed them at their signal instead.
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

        // `subject` is what did not happen, in the room's own voice — read only when there is no
        // sentence from the log to say instead.
        public func line(_ subject: String) -> String {
            switch self {
            case .refused(let said): return said
            case .noAnswer: return "the log didn’t answer — \(subject)"
            }
        }
    }

    public enum FinishOutcome: Equatable {
        case closed(Session)
        case stranded(Int)      // this session's sets that never landed — a closed one cannot take them
        case noAnswer
    }

    // THE FOOT OF THE LOG, and its four states in the order a scroll meets them (§G16). They are the
    // paging read stated as a place to stand: there is more and the tap is yours, that tap is in
    // flight, there is nothing older, or the read failed and can be asked again.
    //
    // `.bottom` is the only one that is an ANSWER rather than a step — "first session · 6 May 2026"
    // — so nothing may reach it on a guess: a store that has not read yet starts at `.loading`, and
    // a store with nobody signed in is at the bottom the moment it draws, because the device holds
    // the whole log and there is no page to ask anybody for.
    public enum LogFoot: Equatable {
        case more
        case loading
        case bottom
        case failed
    }

    // This movement's sets in this session, performed order, warmups included — the whole record of
    // it, which is what the today list draws. What CARRIES FORWARD is narrower: `Prefill` follows the
    // working sets only, because a ramp-up is not what the next set is aimed at.
    public var todaySets: [TrainingSet] {
        guard let exerciseId else { return [] }
        return sets.filter { $0.exerciseId == exerciseId }
    }

    public var planEntry: PlanEntry? {
        guard let exerciseId else { return nil }
        return session?.plan?.entry(for: exerciseId)
    }

    // Every set still in the queue is saved on this device and nowhere else, whether or not the log
    // has been asked yet. A retry counter cannot decide this — a set that has been attempted zero
    // times is exactly as undelivered as one behind a jam.
    public var stalled: Set<String> {
        Set(queue.pending.map(\.set.id))
    }

    // The mistake seconds ago. The log is append-only and has no route that takes a set back, so
    // this is nil the instant the row lands — Undo is offered exactly while it is true, and never
    // as a button that would have to apologise.
    public var undoable: TrainingSet? {
        queue.withdrawable(at: now())?.set
    }

    // Called on launch and on every change of who is signed in. Draws from the device first and
    // always — a room that waited for a round trip would be a workout that waits.
    public func connect(to account: Account) async {
        seat += 1
        gym = sync(account)
        // THE NAMES BEFORE THE FIRST FRAME, and they are read here rather than at init because a
        // name is what ONE ACCOUNT calls a movement: a seed renamed on the record page is a
        // per-account override, and a movement somebody created is theirs. The device's own
        // unclaimed movements fold in under every seat — they are this device's, not the log's — and
        // everything else opens empty under a seat that did not write it. Whatever survives is on
        // screen in the same synchronous breath as the live session below, so a room in a basement
        // never waits on a round trip to stop drawing `bench-press` at 28pt.
        catalog = merged(deviceCatalog.open(under: account.user?.id))
        // Whoever is signed in now brings their own history: every cached last time was computed
        // against the previous log (or none), so the answers go and the movement in hand asks
        // again once the connect has settled — a shelf-computed "first time" surviving a sign-in
        // would answer for a movement the account has trained for a year.
        lastTimes.removeAll()
        lastTime = nil
        lastTimeFailed = false
        // A crash between the local finish's two flushes leaves the workout both live and
        // finished. The finished shelf already holds it, so the queue's copy is the stale half:
        // any set only the queue still has folds into the finished session, and the queue lets
        // go — resuming it would run a workout that ended, and claiming both copies would file
        // the same session twice.
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
        drawFromQueue()
        // The device's shelves are on screen before any wire answers — the room mounts on local
        // state, and a signed-in read that lands later only ever adds to it.
        routines = Routine.byLastTrained(localLog.routines)
        served = []
        recent = mergedRecent([])
        isLoading = false

        guard let gym else {
            // Nobody signed in: the device holds the whole log, so its oldest session really is the
            // first one and the foot may say so. There is no page to ask anybody for.
            logFoot = .bottom
            claimOwedRetryably = false
            saveState = queue.pending.isEmpty ? .idle : .onThisDevice
            if session != nil, let movement = exerciseId { await choose(movement) }
            return
        }
        // What this device made before anybody signed in goes out FIRST — movements, routines,
        // finished sessions, the live session's start — because the queue's own walk can only land
        // sets in a session the log knows (the journal's claimWhatIsOwed, in gym's grammar).
        await claimWhatIsOwed()
        // Then the queue, BEFORE the first read, and it is not an optimisation: reading the log
        // SETTLES a stale open session, and a set that arrives after that close is refused forever.
        // Logged in a basement last night, opened in the morning — the app's own boot read is what
        // would destroy them.
        //
        // Forced, because nothing survives a relaunch to undo: the row is gone from the screen and
        // the window would be protecting a gesture nobody can still make.
        await deliver(force: true)
        await loadLog()
        // Held on the device as well as in memory: the ids are the truth and the names are display
        // strings, so the next cold launch draws `Bench Press` from here rather than the slug.
        if let exercises = try? await gym.exercises() {
            catalog = merged(exercises)
            deviceCatalog.hold(catalog)
        }
        if let written = try? await gym.routines() {
            routines = Routine.byLastTrained(written + localLog.routines)
        }
        if session != nil, let movement = exerciseId { await choose(movement) }
    }

    // Start. Signed in, the log opens the session and freezes the plan snapshot off the routine's
    // own row. Signed out this DEVICE is the shelf the routine lives on, so freezing the snapshot
    // here is the same staleness rule against the only copy that exists — and the claim replays the
    // session under this same id when an account arrives.
    public func start(routineId: String? = nil) async -> Result<Session, WriteFailure> {
        // Composed on the device whenever the log could not honestly take it: nobody signed in,
        // a claim still mid-replay (a server start would default-JOIN whatever session the replay
        // has open — today's sets filed into yesterday's workout), or a routine still on the local
        // shelf the log has never heard of. The claim picks the session up the moment its road is
        // open — the in-flight claim's own tail, the retry cadence, or the next connect.
        guard let gym, !claiming else { return startLocally(routineId: routineId) }
        if let routineId, session == nil, localLog.routine(routineId) != nil {
            return startLocally(routineId: routineId)
        }
        // One id collision is a coincidence and a fresh id lands. Two is a device that cannot mint,
        // and looping on it would hammer the log rather than say so.
        var collision = WriteFailure.noAnswer
        for _ in 0..<2 {
            let id = mintSession()
            do {
                let opened = try await gym.startSession(
                    SessionStart(id: id, startedAtMs: now(), routineId: routineId))
                // A start JOINS whatever session is already open, so the id that comes back is the
                // truth and may not be the one that went out. Pressing Start cannot re-plan a workout
                // that is already running: the snapshot that comes back is that session's own.
                await adopt(opened, joined: opened.id != id)
                guard let live = session else { return .failure(.noAnswer) }
                return .success(live)
            } catch let failure as WindmillApiError {
                // Only a spent session id is worth a second attempt. Every other refusal is a fact
                // about the routine or the account and it is REPEATED rather than swallowed: a 404
                // for a routine deleted from the web must not read as a phone with no signal.
                guard case .refused(409, let refusal) = failure, refusal.code == "session-id-taken" else {
                    return .failure(WriteFailure(failure))
                }
                collision = WriteFailure(failure)
            } catch {
                return .failure(.noAnswer)
            }
        }
        return .failure(collision)
    }

    private func startLocally(routineId: String?) -> Result<Session, WriteFailure> {
        var plan: PlanSnapshot?
        if let routineId {
            guard let routine = localLog.routine(routineId) else {
                return .failure(.refused("that routine is not on this device"))
            }
            plan = PlanSnapshot(routine: routine.name,
                                entries: routine.entries
                                    .sorted { $0.position < $1.position }
                                    .map { PlanEntry(exerciseId: $0.exerciseId, sets: $0.targetSets,
                                                     reps: $0.targetReps, weightKg: $0.targetWeightKg,
                                                     restSeconds: $0.restSeconds) })
        }
        let opened = Session(id: mintSession(), startedAtMs: now(), routineId: routineId, plan: plan)
        queue.hold(opened, unclaimed: true)
        queue.flush()
        drawFromQueue()
        return .success(opened)
    }

    // The movement in hand, and the number in front of the lifter before they touch anything. The
    // answer is kept for as long as the session lasts: within one workout the same three or four
    // movements are walked repeatedly and none of their answers can change, because a last time is a
    // FINISHED session and today's is not one yet.
    public func choose(_ movement: String) async {
        // Choosing a movement is what puts it in the session — appending is a rest-time action, and
        // the row it makes reads "no sets yet — logging one starts it" until the first one lands.
        queue.append(movement)
        queue.flush()
        order = queue.order
        exerciseId = movement
        lastTime = lastTimes[movement]
        lastTimeFailed = false
        redial()

        // Signed out this device's own history is the log, and it answers synchronously: the last
        // finished LOCAL session holding the movement, or an honest first time. Nothing is pending
        // and nothing failed — a card left saying "reading your log…" would be waiting on a request
        // nobody made.
        guard let gym else {
            let answer = lastTimes[movement] ?? localLog.lastTime(movement) ?? LastTime(exerciseId: movement)
            lastTimes[movement] = answer
            lastTime = answer
            lastTimeFailed = false
            redial()
            return
        }
        guard lastTime == nil else { return }
        guard let answer = try? await gym.lastTime(movement) else {
            lastTimeFailed = exerciseId == movement
            return
        }
        // The movement is echoed back for exactly this: a reply for a movement the lifter has already
        // left is dropped, which leaves the card still reading rather than claiming a history the log
        // never denied.
        guard answer.exerciseId == movement, exerciseId == movement else { return }
        lastTimes[movement] = answer
        lastTime = answer
        redial()
    }

    // Local-first: the row lands and the device holds it before the network is consulted at all.
    //
    // THE KIND IS THE CALLER'S, and it is the one thing about a set that cannot be repaired later:
    // the record rules read `kind == working` and the prefill read exists precisely to exclude
    // warmups, so a ramp-up filed as working becomes the mark to beat and answers "what did I do last
    // time" with a lie, in the product's single highest-value pixel.
    public func logSet(weightKg: Double, reps: Int, kind: SetKind = .working) async {
        guard let live = session, let movement = exerciseId, !isFinishing else { return }
        let set = TrainingSet(id: mintSet(), exerciseId: movement, weightKg: weightKg, reps: reps,
                              kind: kind, completedAtMs: now())
        queue.store(set, in: live.id, needsPush: true, heldUntilMs: now() + undoWindowMs)
        queue.flush()
        drawFromQueue()
        await deliver()
    }

    // Taking back the set just logged, while this device is still the only place it exists. It
    // answers false rather than pretending once the log holds the row, because the wire has no route
    // that deletes a set and a screen that removed it anyway would be showing a workout the account
    // disagrees with.
    @discardableResult
    public func undoLast() -> Bool {
        guard let set = undoable, queue.withdraw(set.id) else { return false }
        queue.flush()
        drawFromQueue()
        return true
    }

    // Drain on the way out. This is called on `.onDisappear` AS WELL AS on a scenePhase change, and
    // the second door is the one journal does not have: leaving a room tears its subtree down and
    // deallocates the store, so a retry that was still pending never fires. Journal pays for that
    // with a dropped keystroke; gym would pay for it with a set that is refused forever once the
    // session finishes.
    //
    // Pocketing the phone is not a reason to break the undo window — the row is still on screen when
    // it comes back out. LEAVING the room is: the affordance goes with the subtree, so the window is
    // over whether or not its nine seconds are.
    public func flushPendingSets(force: Bool = false) async {
        await deliver(force: force)
    }

    // Finishing waits for THIS session's sets to land: a session that closed before a set reached it
    // refuses that set forever, so Finish only completes when there is nothing left to lose. A set
    // stranded against some other session — one that closed under it, one from a sign-in that has
    // since ended — is not this session's business and can never stop it closing.
    //
    // An UNCLAIMED session closes on the device whoever is signed in: the log has never heard of it,
    // so there is nothing to drain and nothing that can strand — the whole session, sets and true
    // finish instant together, moves to the local shelf and the claim replays it start → sets →
    // finish when the account can take it.
    public func finish() async -> FinishOutcome {
        guard let live = session else { return .noAnswer }
        if queue.sessionIsUnclaimed || gym == nil {
            return await finishLocally(live)
        }
        guard let gym else { return .noAnswer }
        isFinishing = true
        defer { isFinishing = false }
        // Forced: finishing is this device's statement that everything the session holds is already
        // delivered, and a set still inside its window would be left behind by a walk that skipped it
        // and then refused forever by the close.
        await deliver(force: true)

        let stranded = queue.owed(in: live.id).count
        guard stranded == 0 else { return .stranded(stranded) }
        guard let closed = try? await gym.finishSession(live.id, at: now()) else { return .noAnswer }

        queue.close(live.id)
        queue.flush()
        // The session that just closed is the next last time for every movement in it, so nothing
        // that was true a minute ago is true now.
        lastTimes.removeAll()
        exerciseId = nil
        lastTime = nil
        drawFromQueue()
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
        // The entries move shelves rather than being dropped: the local session owns its sets now,
        // and the claim replays them from there.
        queue.forget(live.id)
        queue.flush()
        lastTimes.removeAll()
        exerciseId = nil
        lastTime = nil
        drawFromQueue()
        if gym != nil {
            // Signed in, the close IS the moment the account can take the whole session — claim it
            // now, so the review and the coach share on the next screen answer from the log. The
            // session handed on is the one the LOG holds: a claim that reminted the id would leave
            // the finish screen reviewing — and discarding — an id spent on nothing.
            let landed = await claimWhatIsOwed()
            await loadLog()
            return .closed(landed[closed.id] ?? localLog.session(closed.id)?.session ?? closed)
        }
        routines = Routine.byLastTrained(localLog.routines)
        recent = mergedRecent([])
        return .closed(localLog.session(closed.id)?.session ?? closed)
    }

    // The one destructive action in the product, and it is offered only at the finish screen: the log
    // refuses to delete a session somebody may still be logging into, because only the device holding
    // the queue knows every set landed. A session the log has never heard of is the device's alone to
    // delete, and asking the server about it would 404 a delete that must succeed.
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

    // "Keep this as a routine" (screen 3) — composed from the session's own sets, in the order they
    // were performed, with the weights actually used as next week's targets. Nothing is created until
    // the tap; declining costs nothing and the offer returns next session. Signed out the routine is
    // kept on this device — the claim replays it, first, when an account arrives.
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
        return saved
    }

    // The mid-session change offer, applied (screen 8). The server never infers this, never
    // auto-writes it and never asks — and the READ is not optional: a routine PUT is a whole-document
    // replace, so writing from a copy this device last read would delete every line added since.
    //
    // It answers with WHAT WENT WRONG rather than with a bool nobody reads. This is the write that
    // moves next week's target, and a sheet that closed identically either way would leave the lifter
    // believing their program had changed.
    public func save(_ weightKg: Double, toRoutine routineId: String,
                     for exerciseId: String) async -> WriteFailure? {
        // A routine still on the local shelf is retargeted there — same read-modify-write, same
        // whole-document rule, no wire. The claim carries the changed copy when it replays.
        if let local = localLog.routine(routineId) {
            let changed = local.retargeting(exerciseId, toWeightKg: weightKg)
            localLog.replace(changed)
            localLog.flush()
            routines = routines.map { $0.id == changed.id ? changed : $0 }
            return nil
        }
        guard let gym else { return .refused("that routine is not on this device") }
        do {
            // Absent and another account's are the same 404, folded into the type by GymApi — so
            // there is no sentence from the log to repeat, and this is the plain fact instead.
            guard let routine = try await gym.routine(routineId) else {
                return .refused("that routine is no longer on the log")
            }
            let write = RoutineWrite(routine.retargeting(exerciseId, toWeightKg: weightKg))
            let saved = try await gym.replaceRoutine(routineId, with: write)
            routines = routines.map { $0.id == saved.id ? saved : $0 }
            return nil
        } catch {
            return WriteFailure(error)
        }
    }

    // A movement the catalog has never heard of, minted from the picker's `Create “{query}”`. The
    // picker asks for a name and nothing else, so the classification is the domain's own value for
    // "unknown" rather than a guess dressed as a fact — and nothing on this surface reads it, because
    // the ladder is taken off the MAGNITUDE of the load and never off the equipment.
    //
    // Signed out the movement is minted onto this device — a fresh phone has no catalog at all, so
    // without this the anonymous room could not log its first set. The claim replays the create
    // BEFORE any session, because a set naming a movement the log has never heard of is refused.
    public func create(_ name: String) async -> Result<Exercise, WriteFailure> {
        let write = ExerciseWrite(name: name, pattern: "isolation", equipment: "barbell")
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

    // The finish screen's three facts, its one record line and its comparison — computed by the
    // DOMAIN and read here, never re-derived. A session still on the local shelf gets the local
    // review instead: the three facts and the honest word over a short one, with the record line and
    // the comparison absent because both are claims against a history this device does not hold.
    public func review(of sessionId: String) async -> Review? {
        if let local = localLog.review(of: sessionId) { return local }
        guard let gym else { return nil }
        return try? await gym.review(of: sessionId)
    }

    // One finished session and its sets, read back — from the local shelf while it is still this
    // device's, from the log once claimed. Absent and another account's are the same 404, folded
    // into the type by GymApi — so there is no sentence from the log to repeat, and this is the
    // plain fact instead, exactly as the routine read one screen down says it.
    public func sessionDetail(_ sessionId: String) async -> Result<SessionDetail, WriteFailure> {
        if let local = localLog.detail(of: sessionId) { return .success(local) }
        guard let gym else { return .failure(.refused("that session is on your account — sign in to read it")) }
        do {
            guard let detail = try await gym.session(sessionId) else {
                return .failure(.refused("that session is no longer on the log"))
            }
            return .success(detail)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // ONE MOVEMENT'S RECORD (§H). Nothing is held: the store keeps no copy to invalidate, so there
    // is no cache key here to get wrong — the banked lesson from Lift's progress tab, whose cache was
    // keyed on the number of sessions and went stale the day one was edited rather than added.
    //
    // THE DEVICE ANSWERS FOR WHAT IT IS STILL THE ONLY HOME OF, and that is two cases and not one:
    // nobody signed in, and a movement whose CREATE is still owed. The log has never heard of that
    // id — so a served read would 404 over a movement that is on screen, in the catalog, with sets
    // under it — and no set naming it can have landed either, because the claim replays a create
    // before any session that names it. The device's answer is therefore the whole of it.
    //
    // What the device can honestly state is the counts, the heaviest set and the recent days, and no
    // estimate anywhere. WHO ANSWERED rides back with the answer, because the same absence means two
    // different things: this device computes no Epley for any movement, and the page may not report
    // that as a fact about the bar. The catalog is a display layer and the sets are the record, so a
    // movement the catalog has not answered for still has a history here — the slug stands in for
    // the name exactly as it does in every other line the room draws.
    //
    // It answers with a REASON and not with nil, for the reason every write in this store does: a
    // log that refused with a sentence is not a log that went quiet, and a screen collapsing the two
    // points the lifter at their signal when the answer was on the server.
    public func record(of exerciseId: String) async -> Result<Record.Answer, WriteFailure> {
        let named = catalog.first { $0.id == exerciseId } ?? Exercise(id: exerciseId, name: exerciseId)
        guard let gym, !localLog.exercises.contains(where: { $0.id == exerciseId }) else {
            return .success(Record.Answer(localLog.record(of: named), from: .thisDevice))
        }
        do {
            // Absent and another account's are the same 404, folded into the type by GymApi — so
            // there is no sentence from the log to repeat, and this is the plain fact instead.
            guard let record = try await gym.record(of: exerciseId) else {
                return .failure(.refused("that movement is no longer in your catalog"))
            }
            return .success(Record.Answer(record, from: .theLog))
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // Whether this device is still the only home for a session that holds this movement — the
    // caveat the record page owes when the LOG answered it, because a served record cannot count a
    // session the log has never been told about. Asked per movement, never off `deviceOnly`: that is
    // a set of session ids, and a caveat printed on every movement's page is noise on all of them.
    public func unclaimed(_ exerciseId: String) -> Bool {
        localLog.holdsSets(of: exerciseId)
    }

    // RENAME — what this account calls a movement, and nothing else about it. The id never moves, so
    // every set, routine entry and frozen plan snapshot still points at the same movement: that is
    // the promise §H's page exists to make visible, and it is why a rename cannot rewrite the past.
    //
    // A movement still on this device's own shelf is renamed THERE, whoever is signed in — the shelf
    // entry is the pending create, so the new name is simply the name the log first hears, and a PATCH
    // would 404 against a movement the log has never held. Signed out, anything else is the account's
    // to keep: the catalog is global and a device cannot hold a per-account name for a row it does
    // not own.
    public func rename(_ exerciseId: String, to name: String) async -> WriteFailure? {
        if localLog.exercises.contains(where: { $0.id == exerciseId }) {
            localLog.rename(exercise: exerciseId, to: name)
            localLog.flush()
            // The catalog is what every screen reads a name out of, so a rename that reached only
            // the shelf would leave the logger, the routines and the log rows spelling the old one
            // until the next cold launch.
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

    // The coach share, minted and revoked. Both answer with WHAT WENT WRONG rather than with a bool
    // nobody can act on: a link that was not made and a link that is still live after a failed
    // revoke are the two facts a lifter has to be told, in the log's own words where it sent any.
    // Signed out the answer is the plain precondition — a link is a capability the ACCOUNT mints,
    // and "the log didn't answer" over a log nobody asked would be the wrong fact.
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

    // THE WALK. One pass over what is owed, per (session, movement) lane, so a set that cannot land
    // holds up its own lane and nothing else — a jam that stopped the whole queue would stop a whole
    // workout, silently.
    private func deliver(force: Bool = false) async {
        retryTask?.cancel()
        retryTask = nil
        guard !queue.pending.isEmpty else {
            // A claim still owed keeps the beat even when the queue owes nothing itself: a local
            // finish moves whole sessions to the shelf, so the queue can be empty while the shelf
            // is not — and this walk just cancelled the task that was carrying them.
            if claimOwedRetryably { scheduleDeliver(after: retryAfter) }
            return
        }
        guard let gym else {
            settle(.onThisDevice)
            return
        }

        // Sets of an UNCLAIMED session are parked, not walked: the log has never heard of their
        // session, so every send would 404 — the claim's start is what opens their road, and until
        // it lands they are saved on this device on purpose.
        let parked = queue.sessionIsUnclaimed ? queue.session?.id : nil
        var blocked: Set<SetQueue.Lane> = Set(parked.map { queue.owed(in: $0).map(\.lane) } ?? [])
        var refusal: String?
        while let owed = queue.nextOwed(skipping: blocked, readyAt: force ? nil : now()) {
            do {
                let stored = try await gym.appendSet(to: owed.sessionId, SetWrite(owed.set))
                queue.delivered(stored, for: owed.set.id, in: owed.sessionId)
            } catch {
                let verdict = Verdict(refusing: error)
                if let reason = verdict.terminalReason(afterRemints: owed.remints) {
                    // Removed and SAID, never swallowed. This is the only copy left of a set somebody
                    // lifted, and a queue that dropped it quietly would count the loss as intended.
                    queue.drop(owed.set.id)
                    refusals.append(.set(RefusedSet(owed.set, reason: reason)))
                    refusal = reason
                    continue
                }
                if case .remint = verdict {
                    queue.remint(owed.set.id, as: mintSet())
                    continue
                }
                blocked.insert(owed.lane)
            }
        }

        queue.flush()
        drawFromQueue()

        // WHAT IS STILL OWED IS OWED WHATEVER ELSE THE WALK MET. The next attempt is scheduled off
        // the queue before anything is said, because a refusal in one lane must not take the retry
        // away from a set merely jammed in another: nothing else carries that one, and returning at
        // the refusal left it on the device with no task at all until the next tap. Parked sets are
        // not carried by the WALK at all — the claim is their road, riding the same beat when it is
        // owed retryably — and they read "saved on this device", which is exactly where they are.
        let carried = queue.pending.filter { $0.sessionId != parked }
        guard let earliestReady = carried.map({ $0.heldUntilMs ?? 0 }).min() else {
            // Nothing for the walk to carry — but a claim still owed retryably is the parked
            // sets' own road, and this walk just cancelled the task that was carrying it.
            if claimOwedRetryably { scheduleDeliver(after: retryAfter) }
            if let refusal {
                settle(.refused(refusal))
                return
            }
            settle(queue.pending.isEmpty ? .onTheLog : .onThisDevice)
            return
        }
        // A set the walk never offered is not a set that failed. Everything owed being inside its own
        // undo window means this device is holding them ON PURPOSE, so the next walk is the one that
        // opens — and saying "offline" over a send nobody has attempted would put the wrong word
        // under a healthy connection.
        let waiting = earliestReady - now()
        scheduleDeliver(after: waiting > 0 ? .milliseconds(waiting) : retryAfter)
        if let refusal {
            settle(.refused(refusal))
            return
        }
        guard waiting > 0 else {
            settle(.offline)
            return
        }
    }

    // A set that did not land is not a lost set — it is on the device, still owed, and this carries
    // it: the retry after a failure, and the send after a window closes. The task dies with the
    // store, which is why leaving the room flushes rather than trusting it.
    private func scheduleDeliver(after delay: Duration) {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            // Let go of the handle BEFORE the walk. `deliver` cancels whatever send is pending, and
            // a walk still holding its own task would cancel itself — which URLSession honours, so
            // every send inside it would fail as a transport error and schedule another walk that
            // did exactly the same thing.
            retryTask = nil
            // The shelf goes out before the queue, exactly as it does on connect: parked sets can
            // only land behind their session's own start, and the claim is what sends it. Never
            // while one is already replaying — a failing claim re-arms itself on the way out. A
            // claim that stopped being owed re-reads the log, so what landed reaches Today with no
            // remount (Android's reclaimed(), to the step) — and loadLog's own gate keeps that
            // read from adopting anything should a later claim already be mid-replay.
            if claimOwedRetryably, !claiming {
                await claimWhatIsOwed()
                await deliver()
                if !claimOwedRetryably { await loadLog() }
                return
            }
            await deliver()
        }
    }

    // THE CLAIM (section D of the wave contract; journal's claimWhatIsOwed is the house shape).
    // Everything this device made before there was an account, replayed in dependency order —
    // movements, then routines, then finished sessions oldest first, then the live session's start —
    // and strictly per session: start with the client-minted id, the TRUE startedAt and
    // `joinOpenSession: false` (the join default once filed a past session's sets into a live
    // workout), then every set per lane in original order, then finish at the true instant. No log
    // or stats read interleaves, because settleOpen would auto-close a >4h-old session mid-replay
    // and refuse every later set forever.
    //
    // Verdicts by CODE only, and a failure aborts the walk rather than dropping anything: what is
    // still owed is owed. A WAIT — the account's other workout still open — stands down whole and
    // stays event-driven, resumed by the next connect or the next local finish; a RETRYABLE ending
    // (offline, 5xx, 401, 404) arms the queue's own cadence and replays from where this one
    // stopped — idempotent ids make the repetition free.
    //
    // What landed comes back keyed by the id each session wore BEFORE the claim: a remint mid-claim
    // means the log holds the session under a fresh id, and the local finish reads its own session
    // out of this rather than reviewing an id the log has never heard of.
    @discardableResult
    private func claimWhatIsOwed() async -> [String: Session] {
        var landed: [String: Session] = [:]
        // One runner, ever. A claim asked for while the shelf is already being replayed parks a
        // rerun on that runner and returns — what it wanted claimed is claimed by the rerun, and
        // `claiming` cannot be dropped by one walk while another is still mid-session.
        if claiming {
            claimAgainWhenDone = true
            return landed
        }
        claiming = true
        defer { claiming = false }
        repeat {
            claimAgainWhenDone = false
            guard let gym else {
                claimOwedRetryably = false
                return landed
            }
            let seated = seat
            let ending = await replayTheShelf(with: gym, landing: &landed)
            // A run that outlived its seat settles nothing: the account changed while it was
            // parked on a slow call, and that seat's own connect owns the flags and the cadence
            // now. A rerun it parked still walks — reading the seat's gym fresh.
            guard seated == seat else { continue }
            claimOwedRetryably = ending == .retry
            if ending == .retry { scheduleDeliver(after: retryAfter) }
        } while claimAgainWhenDone
        return landed
    }

    private func replayTheShelf(with gym: any TrainingSyncing,
                                landing landed: inout [String: Session]) async -> ClaimEnding {
        for write in localLog.exercises {
            let ending = await claim(exercise: write, with: gym)
            guard ending == .settled else { return ending }
        }
        for routine in localLog.routines {
            let ending = await claim(routine: routine, with: gym)
            guard ending == .settled else { return ending }
        }
        for local in localLog.sessions {
            let (claimed, ending) = await claim(session: local, with: gym)
            guard let claimed else { return ending }
            landed[local.session.id] = claimed
        }
        if queue.sessionIsUnclaimed, let live = queue.session {
            return await claimLive(live, with: gym)
        }
        return .settled
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
                    // Terminal as written and it never will be: SAID under its name and let go,
                    // so no later connect is jammed behind — or re-sends — the same terminal
                    // write. Its sets keep the id and are refused by name when they replay.
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
                    // The write can never land as written: SAID under its name, then orphaned —
                    // the sessions keep their frozen plan (a snapshot, not a reference) and drop
                    // only the id that will never resolve.
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

    private func claim(session local: LocalLog.LocalSession,
                       with gym: any TrainingSyncing) async -> (Session?, ClaimEnding) {
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
                // The one 404 a claimed start can meet is a routine the account deleted from
                // another surface since. The plan is frozen on the session already — a snapshot,
                // not a reference — so the id that will never resolve goes, and the start retries.
                if let failure = error as? WindmillApiError, case .refused(404, _) = failure,
                   let gone = local.session.routineId {
                    localLog.orphan(routine: gone)
                    localLog.flush()
                    guard let moved = localLog.session(local.session.id) else { return (nil, .wait) }
                    local = moved
                    continue
                }
                switch claimVerdict(of: error, remintCode: "session-id-taken") {
                case .remint:
                    remints += 1
                    guard remints <= SetQueue.maxRemints else { return (nil, .wait) }
                    let fresh = mintSession()
                    localLog.remint(session: local.session.id, as: fresh)
                    localLog.flush()
                    guard let moved = localLog.session(fresh) else { return (nil, .wait) }
                    local = moved
                case .retry:
                    return (nil, .retry)
                case .wait, .dropped, .refused:
                    return (nil, .wait)
                }
            }
        }

        for set in local.sets {
            var write = set
            var remints = 0
            var settled = false
            while !settled {
                do {
                    _ = try await gym.appendSet(to: local.session.id, SetWrite(write.clamped))
                    settled = true
                } catch {
                    let verdict = Verdict(refusing: error)
                    if case .remint = verdict, remints < SetQueue.maxRemints {
                        remints += 1
                        let fresh = mintSet()
                        localLog.remint(set: write.id, in: local.session.id, as: fresh)
                        localLog.flush()
                        write = write.reminted(as: fresh)
                        continue
                    }
                    if let reason = verdict.terminalReason(afterRemints: SetQueue.maxRemints) {
                        // Removed and SAID, exactly as the queue says it: this is the last copy of
                        // a set somebody lifted, and a claim that dropped it quietly would count
                        // the loss as intended.
                        localLog.drop(set: write.id, in: local.session.id)
                        localLog.flush()
                        refusals.append(.set(RefusedSet(write, reason: reason)))
                        settled = true
                        continue
                    }
                    return (nil, .retry)
                }
            }
        }

        let startedAt = Instants.clamped(local.session.startedAtMs)
        let finishedAt = max(Instants.clamped(local.session.finishedAtMs ?? startedAt), startedAt)
        do {
            let settled = try await gym.finishSession(local.session.id, at: finishedAt)
            localLog.claimed(session: local.session.id)
            localLog.flush()
            return (settled, .settled)
        } catch {
            // The sets are on the log and the session stands open there; the shelf keeps its copy
            // and a later pass closes it. Only the retry class rides the cadence.
            if case .retry = claimVerdict(of: error, remintCode: "") { return (nil, .retry) }
            return (nil, .wait)
        }
    }

    // The live session claims the same way minus finish; once the start lands, the ordinary queue
    // owns its sets exactly as it owns any signed-in session's.
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
                    // The session stays this device's — its sets are parked, not stranded — and
                    // the retry cadence tries again.
                    return .retry
                case .wait, .dropped, .refused:
                    // Still this device's, still parked — and only an event moves it: the
                    // account's open workout closing, the next connect, the next finish.
                    return .wait
                }
            }
        }
        return .wait
    }

    // How the whole claim ended when it could not settle everything owed. WAIT covers everything
    // only an event can move — the account's open workout elsewhere, a repair budget that ran out,
    // a terminal start — and stays event-driven; RETRY is a road that heals on its own (offline,
    // 5xx, 401, 404) and rides the queue's cadence.
    private enum ClaimEnding: Equatable {
        case settled, wait, retry
    }

    // The claim's reading of a refusal, by CODE and never by sentence — the same contract the queue's
    // Verdict states for sets, extended with the two codes only a start can meet. The sentence rides
    // along on `refused` because a claim-level loss is SAID in the log's own words.
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
        if status >= 500 { return .retry }
        if status == 400 || status == 409 { return .refused(refusal.message) }
        // 401 waits for the Keychain, 404 for the thing to exist — the contract's retry class,
        // never a drop.
        return .retry
    }

    private func loadLog() async {
        guard let gym else { return }
        logFoot = .loading
        guard let page = try? await gym.sessions(before: nil, beforeId: nil, limit: Self.logPage) else {
            // The rows already on screen stay — they are real sessions and worth reading — and the
            // foot says the read failed rather than that the log ends here. A screen admitting it
            // could not load has not earned the right to also name somebody's first session.
            logFoot = .failed
            return
        }
        served = page
        logFoot = page.count < Self.logPage ? .bottom : .more
        recent = mergedRecent(page)

        // A page read while the claim is mid-replay may hold the replay's own past session open.
        // The merge above stands — history is history — but nothing is settled or adopted off it:
        // adopting would hand the room a workout the claim is about to finish at a stale instant,
        // and closing would act on a picture the replay is still changing. The read after the
        // claim ends decides.
        guard !claiming else { return }
        guard let open = page.first(where: { $0.session.isOpen }) else {
            // The log holds no open session, so whatever this device was holding is over — a finish
            // from another surface, or the four-hour auto-close. The session row goes; a set that is
            // still OWED does not, because a set nobody has answered for has not been refused. An
            // UNCLAIMED session is the exception both ways: the log has never held it, so the log's
            // silence about it says nothing, and closing it here would throw away a live workout.
            if let live = queue.session, !queue.sessionIsUnclaimed { queue.close(live.id) }
            queue.flush()
            drawFromQueue()
            return
        }
        // A different session open on the ACCOUNT while this device holds an unclaimed one: the
        // phone keeps its own workout — that is the ownership rule — and the claim waits for the
        // other session to close rather than letting the adopt overwrite a session the log cannot
        // give back.
        if queue.sessionIsUnclaimed, queue.session?.id != open.session.id { return }
        await adopt(open.session, joined: true)
    }

    // ONE PAGE OLDER, and the tap is the lifter's (§G16): twelve weeks back is a destination, and
    // infinite scroll has no arrival. The cursor is BOTH halves of the sort key, because two
    // sessions can share an instant and an instant alone would repeat one across the page edge.
    //
    // It is also the retry, and that is why it reads from the head when nothing has been served yet:
    // the state the foot offers `retry` in is most often the FIRST read having failed, and asking
    // for what comes before nothing would answer with the bottom of a log nobody has seen.
    public func loadOlder() async {
        guard let gym, logFoot != .loading else { return }
        let cursor = served.last
        logFoot = .loading
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

    // The log's page with this device's unclaimed sessions folded in, newest first — the merge rule
    // of section D: after a claim confirms, the server row is the truth, so a local copy that shares
    // an id with a served row stands down. The device's own sessions are ALL of them, never a page:
    // there is nothing to ask anybody for, so they never move the foot.
    private func mergedRecent(_ server: [SessionSummary]) -> [SessionSummary] {
        let known = Set(server.map(\.id))
        let local = localLog.summaries().filter { !known.contains($0.id) }
        deviceOnly = Set(local.map(\.id))
        return (server + local).sorted { $0.session.startedAtMs > $1.session.startedAtMs }
    }

    // The served catalog plus whatever this device minted and has not yet claimed — without the
    // fold, a catalog read while the claim is still owed would erase the movement mid-session.
    private func merged(_ server: [Exercise]) -> [Exercise] {
        let known = Set(server.map(\.id))
        let unclaimed = localLog.exercises.filter { !known.contains($0.id) }
            .map { Exercise(id: $0.id, name: $0.name, pattern: $0.pattern,
                            equipment: $0.equipment, stepKg: $0.stepKg, custom: true) }
        return server + unclaimed
    }

    private func adopt(_ opened: Session, joined: Bool) async {
        queue.hold(opened)
        // A joined session is a list of sets this device may know nothing about — its own from before
        // a relaunch, or a second phone's — and adopting the row without them would draw an empty
        // workout over a live one.
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
        // The order is seeded from the plan and from what has already been performed, so a session
        // joined from another device — or reopened after a relaunch — walks the movements it really
        // holds rather than the ones this device happened to watch being logged.
        let merged = LiveOrder.merged(held: queue.order, plan: session?.plan, sets: sets)
        if merged != queue.order {
            queue.hold(order: merged)
            queue.flush()
        }
        order = merged
        // Counted off the queue and never off `saveState`, so no single word can silence it. A set
        // still inside its own undo window is not stranded — it is being held on purpose, and the
        // strip would otherwise flash for nine seconds after every set on a healthy connection.
        // Signed out nothing is stranded, and neither is a set parked behind an unclaimed session:
        // there is no log those sets could have reached yet, which is a different fact with its own
        // word.
        let instant = now()
        let parked = queue.sessionIsUnclaimed ? queue.session?.id : nil
        strandedCount = gym == nil
            ? 0
            : queue.pending.filter { !$0.isHeld(at: instant) && $0.sessionId != parked }.count
        redial()
    }

    private func redial() {
        prefill = Prefill(todaySets: todaySets, planEntry: planEntry, lastTime: lastTime)
    }

    // One write, one beat. The tick is what the note watches, so two sets landing in the same state
    // still read as two saves rather than as one that never faded.
    private func settle(_ state: SaveState) {
        saveState = state
        saveTick += 1
    }
}
