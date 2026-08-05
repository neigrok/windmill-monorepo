import Foundation
import SwiftUI
import WindmillPlatform

// The live session, wired — the native twin of web/src/products/gym/logger/useLiveSession.js, and the
// one place in gym where the pure rules meet the network, the clock and the disk. Everything it
// decides it decides by asking a module: the ladder moves the weight, Prefill picks the number, the
// queue owns durability. This file is the plumbing and none of the meaning.
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
    @Published public private(set) var refusals: [RefusedSet] = []        // sets that never landed
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

    private let queue: SetQueue
    private let deviceCatalog: DeviceCatalog
    private let now: () -> Int64
    private let mintSession: () -> String
    private let mintSet: () -> String
    private let sync: (Account) -> (any TrainingSyncing)?
    private var gym: (any TrainingSyncing)?
    private var lastTimes: [String: LastTime] = [:]
    private var retryTask: Task<Void, Never>?

    // At or under the server's own ceiling: the handler clamps `limit` to 200, and a larger page here
    // would come back short of what was asked for and read as the bottom of the log.
    private static let logPage = 50

    private let undoWindowMs: Int64
    private let retryAfter: Duration

    public init(queue: SetQueue = SetQueue(),
                deviceCatalog: DeviceCatalog = DeviceCatalog(),
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
        self.now = now
        self.mintSession = mintSession
        self.mintSet = mintSet
        self.undoWindowMs = undoWindowMs
        self.retryAfter = retryAfter
        self.sync = sync
        // The names before the first frame. A movement is a stable id everywhere except on screen,
        // so a room that waited for the catalog read would draw `bench-press` at 28pt in the
        // meantime — in a basement, for a whole session.
        catalog = deviceCatalog.movements
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
        gym = sync(account)
        drawFromQueue()
        isLoading = false

        guard let gym else {
            saveState = queue.pending.isEmpty ? .idle : .onThisDevice
            return
        }
        // The queue goes out BEFORE the first read, and it is not an optimisation: reading the log
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
            catalog = exercises
            deviceCatalog.hold(exercises)
        }
        if let written = try? await gym.routines() { routines = written }
    }

    // Start. A session cannot be opened without the log, because the plan snapshot is FROZEN BY THE
    // SERVER off the routine's own row — a client-composed copy would freeze whatever that client
    // last read, which is exactly the staleness the snapshot exists to prevent.
    public func start(routineId: String? = nil) async -> Result<Session, WriteFailure> {
        guard let gym else { return .failure(.noAnswer) }
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

        // Signed out there is no log to answer, so the read is not pending — it is over. A card left
        // saying "reading your log…" would be waiting on a request nobody made.
        guard let gym else {
            lastTimeFailed = lastTime == nil
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
    public func finish() async -> FinishOutcome {
        guard let gym, let live = session else { return .noAnswer }
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

    // The one destructive action in the product, and it is offered only at the finish screen: the log
    // refuses to delete a session somebody may still be logging into, because only the device holding
    // the queue knows every set landed.
    public func discard(_ sessionId: String) async -> Bool {
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
    // the tap; declining costs nothing and the offer returns next session.
    public func keep(_ sets: [TrainingSet], asRoutineNamed name: String) async -> Routine? {
        guard let gym else { return nil }
        guard let write = RoutineWrite(named: name, from: sets, position: routines.count) else { return nil }
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
        guard let gym else { return .noAnswer }
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
    public func create(_ name: String) async -> Result<Exercise, WriteFailure> {
        guard let gym else { return .failure(.noAnswer) }
        let write = ExerciseWrite(name: name, pattern: "isolation", equipment: "barbell")
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
    // DOMAIN and read here, never re-derived. A second opinion drawn on the phone would be the
    // product arguing with itself in its own loudest pixel.
    public func review(of sessionId: String) async -> Review? {
        guard let gym else { return nil }
        return try? await gym.review(of: sessionId)
    }

    // THE WALK. One pass over what is owed, per (session, movement) lane, so a set that cannot land
    // holds up its own lane and nothing else — a jam that stopped the whole queue would stop a whole
    // workout, silently.
    private func deliver(force: Bool = false) async {
        retryTask?.cancel()
        retryTask = nil
        guard !queue.pending.isEmpty else { return }
        guard let gym else {
            settle(.onThisDevice)
            return
        }

        var blocked: Set<SetQueue.Lane> = []
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
                    refusals.append(RefusedSet(owed.set, reason: reason))
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
        // the refusal left it on the device with no task at all until the next tap.
        guard let earliestReady = queue.pending.map({ $0.heldUntilMs ?? 0 }).min() else {
            settle(refusal.map(SaveState.refused) ?? .onTheLog)
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
            await deliver()
        }
    }

    private func loadLog() async {
        guard let gym else { return }
        guard let page = try? await gym.sessions(before: nil, beforeId: nil, limit: Self.logPage) else { return }
        recent = page

        guard let open = page.first(where: { $0.session.isOpen }) else {
            // The log holds no open session, so whatever this device was holding is over — a finish
            // from another surface, or the four-hour auto-close. The session row goes; a set that is
            // still OWED does not, because a set nobody has answered for has not been refused.
            if let live = queue.session { queue.close(live.id) }
            queue.flush()
            drawFromQueue()
            return
        }
        await adopt(open.session, joined: true)
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
        // Signed out nothing is stranded either: there is no log to reach, which is a different fact
        // and has its own word.
        let instant = now()
        strandedCount = gym == nil ? 0 : queue.pending.filter { !$0.isHeld(at: instant) }.count
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
