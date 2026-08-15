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
    // EVERY PROPOSAL THE ACCOUNT HOLDS, newest first, pending and settled together — the one list
    // the pending cards and every routine's History are both folded out of. It is deliberately not
    // read off the routine's own `pendingProposal`: the wire carries that field for the agent's
    // `list_routines`, and a room reading both would have two answers to "is there a card".
    //
    // Signed out it is EMPTY and stays empty. A proposal belongs to an account — no account, no
    // proposal — so there is no anonymous half of this list and nothing for the claim to replay.
    @Published public private(set) var proposals: [ProposalHead] = []
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
    // having asked yet. §K deleted the card that drew the four states and it was right to: three of
    // them were numbers already dialled in under the thumb, or a sentence about a read in flight.
    // This one is not — without it the dial silently shows the empty bar over a movement the lifter
    // has trained for a year, which is the product lying in the one pixel it exists for.
    @Published public private(set) var lastTimeFailed = false
    // THE PICKER'S META, and it is optional because the absence of a key is an ASSERTION: a movement
    // with no line here has never been trained, which is exactly what `never logged` says. Nil is the
    // state where nothing may be asserted at all — the read has not landed, or it failed — and the
    // picker draws no meta rather than telling a lifter of ten years they have never squatted.
    @Published public private(set) var lastSets: [String: LastSet]?
    // Whether a picker has ever ASKED for that map on this store. §J22's card is a door out of the
    // room — the You sheet, then the sign-in — and the room stays mounted behind it, which is what
    // lands the lifter back mid-session; the price is that the picker's own `.task` never runs a
    // second time when the account arrives. So the seat that comes in re-answers what the seat that
    // left was asked, and a launch nobody opened a picker on still costs no read at all.
    private var lastSetsWanted = false
    @Published public private(set) var prefill: Prefill = .emptyBar
    // How the room is set up (§I). Read from the device before the first frame and from the account
    // once there is one, so the logger's plate readout and rest clock never wait on a round trip.
    @Published public private(set) var preferences: GymPreferences = .defaults
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
    // True while the settings document is on the wire. It is what keeps two whole documents from
    // being in flight at once — see `save`, where the reason is written.
    private var settingsSending = false

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

    // Every set still in the queue AS AN APPEND is saved on this device and nowhere else, whether or
    // not the log has been asked yet. A retry counter cannot decide this — a set that has been
    // attempted zero times is exactly as undelivered as one behind a jam. A correction or a deletion
    // still owed is a different fact and must not wear this word: the log holds that row, under
    // numbers this device is trying to move.
    public var stalled: Set<String> {
        Set(queue.pending.filter { $0.owes == .append }.map(\.set.id))
    }

    // The mistake seconds ago, and it is taken back HERE rather than asked of the log: while the row
    // is still owed this device is the only place it exists, so withdrawing it costs nobody anything.
    // It is nil the instant the row lands — a set the account holds is corrected or deleted through
    // §G18's sheet, which confirms and offers its own way back, and a button here that outlived the
    // window would be a second door onto that with neither.
    public var undoable: TrainingSet? {
        queue.withdrawable(at: now())?.set
    }

    // THE DELETION THAT CAN STILL BE TAKEN BACK, and the row it would put back. It is kept here
    // rather than in the queue because a deleted set comes from one of several homes and each takes
    // a different repair — the shelf takes its ROW back, the queue takes its DELETE back, and a row
    // the log never had takes its APPEND back — and one record over all of them is what keeps the
    // screen from having to know which. It carries the whole set for the same reason a refusal does:
    // between the tap and the Undo, this is the only copy of it anywhere.
    public struct Deletion: Equatable {
        public let set: TrainingSet
        public let sessionId: String
        let untilMs: Int64
    }

    private var taken: Deletion?

    public var restorable: Deletion? {
        guard let taken, taken.untilMs > now() else { return nil }
        return taken
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
        // a seat that did not write the file falls back to the sixty-four the app SHIPS with
        // (`DeviceCatalog.seeded`), which is where the anonymous room's catalog comes from at all.
        // Whatever survives is on screen in the same synchronous breath as the live session below,
        // so a room in a basement never waits on a round trip to stop drawing `bench-press` at 28pt.
        catalog = merged(deviceCatalog.open(under: account.user?.id))
        // Whoever is signed in now brings their own history: every cached last time was computed
        // against the previous log (or none), so the answers go and the movement in hand asks
        // again once the connect has settled — a shelf-computed "first time" surviving a sign-in
        // would answer for a movement the account has trained for a year.
        lastTimes.removeAll()
        lastTime = nil
        lastTimeFailed = false
        // The picker's lines go with them and for the same reason: this map's whole meaning is
        // "these are the movements YOU have trained", so one seat's may never be read under another.
        lastSets = nil
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
        // The cards go with the seat that left. A proposal is one account's, and one drawn under
        // another would be a card about a program this lifter cannot see — signed out the list
        // stays empty, because there is nothing to ask and nobody to ask it of.
        proposals = []
        // Opened under whoever is signed in, exactly as the catalog is a few lines up and for a
        // sharper reason: settings are one ACCOUNT's, so a document this seat did not write is let
        // go of rather than drawn. The anonymous document the claim is about to carry is the one
        // crossing (LocalLog.open).
        preferences = localLog.open(preferencesUnder: account.user?.id) ?? .defaults
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
            if lastSetsWanted { await loadLastSets() }
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
        await loadRoutines(from: gym)
        // AFTER the routines, because every proposal names one: a card that landed on screen before
        // the routine it is about would have nothing to name.
        await loadProposals(from: gym)
        // Read AFTER the claim, and only while this device is not still holding an answer the log has
        // never heard: a served document landing on top of one the lifter set signed-out would take
        // their own plates off the screen before they were ever sent. Held on the device as well, so
        // the next cold launch draws the rest dial and the plate set on its first frame.
        if !localLog.preferencesOwed, let held = try? await gym.preferences() {
            preferences = held
            localLog.keep(held, owed: false)
            localLog.flush()
        }
        if session != nil, let movement = exerciseId { await choose(movement) }
        if lastSetsWanted { await loadLastSets() }
    }

    // HOW THE ROOM IS SET UP, CHANGED. The same order as every other write in this file — store on the
    // device, then tell the log or owe it — and the document travels WHOLE, because the route replaces
    // it whole: a screen that sent one field would reset the six it did not touch to their defaults.
    //
    // Nobody signed in is not a degraded case: the device is the only store there is, the settings are
    // held exactly as sessions and routines are, and the claim carries them at sign-in.
    @discardableResult
    public func save(_ wanted: GymPreferences) async -> WriteFailure? {
        preferences = wanted
        localLog.keep(wanted, owed: true)
        localLog.flush()
        guard let gym else { return nil }
        let outcome = await sendWhatIsOwed(with: gym)
        // Still owed, on a road that heals: the claim's own walk carries it on the queue's cadence
        // rather than on a second timer. The screen goes on drawing what the lifter chose — it is on
        // this device and it is what they meant — and the sentence says the log has not got it yet.
        if outcome.ending == .retry {
            claimOwedRetryably = true
            scheduleDeliver(after: retryAfter)
        }
        return outcome.why
    }

    // ONE WRITE AT A TIME, AND THE LAST TAP IS THE ONE THAT STANDS. Two whole documents in flight can
    // reach the log in either order, and last-write-wins would leave it holding the older one — a
    // plate chip that came back on by itself. So a send that is already running is left to finish and
    // this returns, and the running loop picks the newest thing owed up before it ends. That is why
    // both doors onto this row — the settings screen's tap and the claim's own walk — come through
    // here: a claim that pushed once would leave a tap that landed mid-claim owed, unsent and unsaid
    // until the next launch.
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

    // THE ONE PLACE THIS DOCUMENT MEETS THE LOG, and two callers read different halves of one answer:
    // the settings screen wants the sentence, the claim wants to know whether to come back for it.
    // Both reach it through the loop above, which is what makes the single file hold across them —
    // a connect that lands mid-tap must not put a second copy of this row in flight.
    private func push(_ wanted: GymPreferences,
                      with gym: any TrainingSyncing) async -> (ClaimEnding, WriteFailure?) {
        settingsSending = true
        defer { settingsSending = false }
        do {
            let stored = try await gym.savePreferences(wanted)
            // A TAP THAT LANDED WHILE THIS WAS ON THE WIRE is a newer document, already drawn and
            // already owed. This reply is about the older one: it may not put that back on the
            // screen, and it may not clear a flag that now belongs to the newer one — which is the
            // flag the loop above reads to send it on the next turn.
            guard localLog.preferences == wanted else { return (.settled, nil) }
            preferences = stored
            localLog.keep(stored, owed: false)
            localLog.flush()
            return (.settled, nil)
        } catch {
            // There is no remint and no wait here — one row, no id to collide with, nothing queued
            // behind it — so the two endings are the two roads. A document the log refuses outright
            // can never land as written, so it is LET GO of rather than replayed against every future
            // connect; the device goes on drawing it, because it is still what the lifter chose.
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

    // Start. Signed in, the log opens the session and freezes the plan snapshot off the routine's
    // own row. Signed out this DEVICE is the shelf the routine lives on, so freezing the snapshot
    // here is the same staleness rule against the only copy that exists — and the claim replays the
    // session under this same id when an account arrives.
    //
    // A START IS NEVER A SILENT JOIN (the 13 Aug start contract). Every user-tapped start says
    // `joinOpenSession: false`, because the join default ignores the tapped routine — "Start
    // workout" on routine B would land the lifter in yesterday's workout under the wrong plan. When
    // the account already has a session open the log answers 409 `session-already-open`; the log is
    // re-read so that workout is adopted and the room can stand where its sets are, and the refusal
    // is repeated in the log's own words rather than swallowed.
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
                    SessionStart(id: id, startedAtMs: now(), routineId: routineId,
                                 joinOpenSession: false))
                await adopt(opened, joined: opened.id != id)
                guard let live = session else { return .failure(.noAnswer) }
                return .success(live)
            } catch let failure as WindmillApiError {
                // The account already has a workout open — on this phone before a relaunch, or on
                // another device. The log is re-read so that workout is on this screen to resume or
                // finish deliberately, and the refusal rides back in the log's own words.
                if case .refused(409, let refusal) = failure, refusal.code == "session-already-open" {
                    await loadLog()
                    return .failure(WriteFailure(failure))
                }
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
        // and nothing can have failed — there is nobody to ask.
        guard let gym else {
            let answer = lastTimes[movement] ?? localLog.lastTime(movement) ?? LastTime(exerciseId: movement)
            lastTimes[movement] = answer
            lastTime = answer
            redial()
            return
        }
        guard lastTime == nil else { return }
        guard let answer = try? await gym.lastTime(movement) else {
            // Said on the dial, and only while the lifter is still standing at the movement it was
            // asked for: the numbers under the thumb are the empty bar or the plan's, and nothing
            // else on the screen would tell them apart from their own history.
            lastTimeFailed = exerciseId == movement
            return
        }
        // The movement is echoed back for exactly this: a reply for a movement the lifter has
        // already left is dropped rather than aimed at the dial in front of them.
        guard answer.exerciseId == movement, exerciseId == movement else { return }
        lastTimes[movement] = answer
        lastTime = answer
        redial()
    }

    // THE PICKER'S META, read when the picker OPENS and never per keystroke — the live filter runs
    // over the catalog this client already holds, and these join onto it by id.
    //
    // Signed out the device is the log and answers whole. Signed in the served map is the account's,
    // and this device's unclaimed sessions are folded in on top of it: those workouts happened, the
    // log has simply never heard of them, and the newer line is the true one either way.
    //
    // A read that did not land leaves the map ALONE — nil until one does. Every screen that draws
    // this treats a missing movement as one that was never trained, so an empty map from a failed
    // read would tell a lifter their whole history is gone.
    //
    // Asking once REGISTERS the picker: `connect` drops the map when the seat changes and asks this
    // again on the way out, because the screen that wanted it is still on screen and its own `.task`
    // has already run (see `lastSetsWanted`).
    public func loadLastSets() async {
        lastSetsWanted = true
        guard let gym else {
            lastSets = localLog.lastSets()
            return
        }
        guard let served = try? await gym.lastSets() else { return }
        let account = Dictionary(served.map { ($0.exerciseId, $0) }) { first, _ in first }
        lastSets = account.merging(localLog.lastSets()) { onTheLog, onThisDevice in
            onThisDevice.atMs > onTheLog.atMs ? onThisDevice : onTheLog
        }
    }

    // THE WALK ORDER, MOVED — the drag on the assembly list (§A screen 2), and the only thing in this
    // room that reorders anything. It moves IDS and nothing else: the sets are keyed by session and
    // movement and are not consulted here, so no arrangement of this list can lose one, and the same
    // list redrawn from the queue comes back in the order the thumb left it (`LiveOrder.merged` keeps
    // what the device already holds at the head).
    public func reorder(from source: IndexSet, to destination: Int) {
        var moved = order
        moved.move(fromOffsets: source, toOffset: destination)
        queue.hold(order: moved)
        queue.flush()
        order = moved
    }

    // THE SWIPE THAT TAKES A MOVEMENT OFF THE LIST, and it is narrow by construction: only a movement
    // with no sets that the plan never named can go (`LiveOrder.droppable`). A movement that was
    // lifted is a fact and a plan line is what the routine said — both would be put straight back by
    // the next redraw, so neither is ever offered.
    //
    // Dropping the movement IN HAND moves the hand: to wherever the walk resumes, or to nothing,
    // which is the picker again — standing on a movement that is no longer in the session would be
    // the screen disagreeing with the list the lifter just edited.
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

    // Local-first: the row lands and the device holds it before the network is consulted at all.
    //
    // THE KIND IS THE CALLER'S, and getting it right at the tap still matters most: the record rules
    // read `kind == working` and the prefill read exists precisely to exclude warmups, so a ramp-up
    // filed as working becomes the mark to beat and answers "what did I do last time" with a lie, in
    // the product's single highest-value pixel. §G18 can repair it afterwards — but only for a lifter
    // who noticed, and the number was already wrong on every screen in between.
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
    // answers false rather than pretending once the log holds the row: from there a set is moved
    // through §G18's sheet, which confirms first and offers its own way back, and a logger button
    // that quietly deleted an account's set would be neither.
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

    // ONE ROUTINE, READ IN FULL (§M screen 30). It is a route of its own and not a lookup in
    // `routines`, because HISTORY rides only here: the list read carries none, so a page drawn off
    // the list would show a routine with no past and quietly claim it had none.
    //
    // The device's own shelf answers first and answers completely — a routine this device made has
    // no history to have — and only a routine the log holds is asked for. Signed out that is the
    // whole truth: a routine that is on neither is a routine that is gone.
    public func routine(_ id: String) async -> Result<Routine, WriteFailure> {
        if let local = localLog.routine(id) { return .success(local) }
        guard let gym else { return .failure(.refused("that routine is on your account — sign in to read it")) }
        do {
            // Absent and another account's are the same 404, folded into the type by GymApi — so
            // there is no sentence from the log to repeat, and this is the plain fact instead. A row
            // the log denies is dropped from the list here, where this device learns it is gone.
            guard let found = try await gym.routine(id) else {
                forget(routine: id)
                return .failure(.refused("that routine is no longer on the log"))
            }
            routines = Routine.byLastTrained(routines.map { $0.id == found.id ? found : $0 })
            return .success(found)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // A ROUTINE BUILT AT HOME (§M) — the third door, and it lands through the same create every
    // other routine on this device goes through. Signed out it is kept on the shelf and the claim
    // replays it, first, when an account arrives; there is nothing special about a routine nobody
    // has trained yet.
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
            return .success(saved)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // AN EDIT, and a routine PUT is a whole-document replace — which is why the draft carries every
    // line rather than the ones that moved. A routine still on this device's shelf is replaced
    // there, whoever is signed in: the shelf entry is the pending create, so the edited document is
    // simply the one the log first hears.
    public func replace(_ draft: RoutineDraft) async -> Result<Routine, WriteFailure> {
        if let held = localLog.routine(draft.id) {
            // THE LAST-TRAINED STAMP IS NOT THE DRAFT'S TO CARRY. Signed out this device is the
            // server, and it stamps that fact when a session finishes — a replace composed from the
            // write alone would drop it, and the routine would go back to reading `untested` after
            // a workout that had already tested it.
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
            // A write by the lifter's own hand sets every pending proposal on that routine aside, in
            // the same transaction — so this device's cards are stale the instant the PUT answers.
            // The list is re-read rather than re-derived: the supersede is the server's rule, and a
            // second copy of it on the phone is a rule that will eventually disagree.
            await loadProposals(from: gym)
            return .success(saved)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // DELETE A ROUTINE (§B screen 6's alarm row — the editor's foot, in edit mode). The log's
    // delete cascades the proposal ledger with it, so this device forgets both together; the
    // sessions trained from it keep their frozen plans, because a snapshot is not a reference.
    // A routine still on this device's shelf is the device's alone to let go of — the claim simply
    // never replays it. A 404 is the outcome asked for: the routine is already gone.
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

    // The mid-session change offer, applied (screen 8). The server never infers this, never
    // auto-writes it and never asks — and the READ is not optional: a routine PUT is a whole-document
    // replace, so writing from a copy this device last read would delete every line added since.
    //
    // It answers with WHAT WENT WRONG rather than with a bool nobody reads. This is the write that
    // moves next week's target, and a sheet that closed identically either way would leave the lifter
    // believing their program had changed.
    //
    // THE LINE IS ADDRESSED BY POSITION, and a routine that has changed under the session — the
    // position gone, or naming another movement now — is REFUSED rather than written unchanged: a
    // PUT of the same document would still move the revision and set every pending proposal on that
    // routine aside, for a change that never happened.
    public func save(_ weightKg: Double, toRoutine routineId: String, at position: Int,
                     for exerciseId: String) async -> WriteFailure? {
        // A routine still on the local shelf is retargeted there — same read-modify-write, same
        // whole-document rule, no wire. The claim carries the changed copy when it replays.
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
            // Absent and another account's are the same 404, folded into the type by GymApi — so
            // there is no sentence from the log to repeat, and this is the plain fact instead.
            guard let routine = try await gym.routine(routineId) else {
                return .refused("that routine is no longer on the log")
            }
            guard let changed = routine.retargeting(position: position, exerciseId: exerciseId,
                                                    toWeightKg: weightKg) else {
                return .refused("\(routine.name) has changed since this session started")
            }
            let saved = try await gym.replaceRoutine(routineId, with: RoutineWrite(changed))
            routines = routines.map { $0.id == saved.id ? saved : $0 }
            // THE HUMAN'S HAND SETS EVERY PENDING PROPOSAL ON THAT ROUTINE ASIDE, in the same
            // transaction as the write — so this device's cards are stale the instant the PUT
            // answers, and one of them left on screen would be a diff offering to change a base
            // that no longer stands. The list is re-read rather than re-derived here: the supersede
            // is the server's rule, and a second copy of it on the phone is a rule that will
            // eventually disagree.
            await loadProposals(from: gym)
            return nil
        } catch {
            return WriteFailure(error)
        }
    }

    // EVERYTHING WAITING ON A ROUTINE, newest first. The ledger's rule is one pending proposal per
    // (routine, DOOR, connection) and not one per routine — so a routine carries two the moment a
    // second door exists, and a room that answered this with a single row would draw a marker
    // saying "1 proposal" over two of them. The list is the COUNT as well as the door: the newest
    // is what the marker opens, and the rest surface as each one is settled.
    public func pending(of routineId: String) -> [ProposalHead] {
        proposals.filter { $0.routineId == routineId && $0.isPending }
    }

    // The routine's HISTORY (§B screen 6) — every proposal on it that has been settled, applied and
    // dismissed and set aside alike. An agent's suggestion is part of the program's history
    // whichever way it went, so nothing is filtered out by its outcome.
    //
    // ORDERED BY THE DAY EACH ROW IS ABOUT, which is the day it PRINTS. The log's own order is
    // newest-MINTED, and a section sorted that way and dated by its settlement reads with its dates
    // running backwards — a proposal written on Sunday and decided this morning belongs above one
    // written on Tuesday and dismissed last week. Ties fall back to the log's order, because an
    // apply stamps every row its supersede touches at the same instant.
    public func history(of routineId: String) -> [ProposalHead] {
        proposals
            .filter { $0.routineId == routineId && !$0.isPending }
            .sorted {
                guard $0.recordedAtMs == $1.recordedAtMs else { return $0.recordedAtMs > $1.recordedAtMs }
                guard $0.createdAtMs == $1.createdAtMs else { return $0.createdAtMs > $1.createdAtMs }
                return $0.id > $1.id
            }
    }

    // The whole diff, read on the way into the screen that draws it. Signed out there is nothing to
    // ask and nobody to ask it of, and the plain precondition is the honest answer — "the log didn't
    // answer" over a log nobody asked would be the wrong fact, exactly as it is for a share.
    public func proposal(_ id: String) async -> Result<Proposal, WriteFailure> {
        guard let gym else { return .failure(.refused("proposals need your account — sign in first")) }
        do {
            // Absent, another account's and never-existed are the same 404, folded into the type by
            // GymApi — so there is no sentence from the log to repeat, and this is the plain fact.
            //
            // A READ THAT FINDS NOTHING IS ALSO AN ANSWER ABOUT THE LIST. The card on home and the
            // marker on the routine are drawn from rows this device is holding, and a row the log
            // denies must not go on offering a decision that has nowhere to land — so it is dropped
            // here, where this device learns it is gone.
            guard let found = try await gym.proposal(id) else {
                forget(proposal: id)
                return .failure(.refused("that proposal is no longer on the log"))
            }
            return .success(found)
        } catch {
            return .failure(WriteFailure(error))
        }
    }

    // WHAT BECAME OF A DECISION THE LIFTER TOOK. `.settled` carries the row as the LOG now holds it,
    // which is not always the decision that was tapped: a routine that moved under the diff comes
    // back set aside, and a proposal the other phone already answered comes back the way that phone
    // answered it. Both are terminal, both are drawn, and neither is an error the lifter can retry.
    public enum Settling: Equatable {
        case settled(Proposal)
        case removed            // an applied removal: the routine and its ledger are gone
        case gone               // no such proposal, and there never will be
        case failed(WriteFailure)
    }

    // THE TAP, and the only thing in this product that changes a routine on an agent's word. It is
    // atomic against the base the diff was written on — all of it or none — and the routine that
    // comes back is the one that now stands, so nothing here composes what the change did.
    //
    // It takes the whole proposal rather than an id because the INTENT decides what an absent
    // routine can mean: a removal that landed takes its own ledger with it, so on that one route a
    // 404 may be the receipt rather than a refusal — and which of the two it is, is a question the
    // log answers below rather than one this device settles from the intent alone.
    public func apply(_ proposal: Proposal) async -> Settling {
        guard let gym else { return .failed(.refused("proposals need your account — sign in first")) }
        do {
            let landed = try await gym.applyProposal(proposal.id)
            settle(landed.proposal)
            guard let routine = landed.routine else {
                // The removal took the routine and, through the cascade, every proposal row that
                // named it — and nothing else. There is no ledger left on this routine to re-read.
                forget(routine: proposal.routineId)
                return .removed
            }
            routines = Routine.byLastTrained(routines.map { $0.id == routine.id ? routine : $0 })
            // AN APPLY IS A WRITE LIKE ANY OTHER, so it sets every OTHER proposal waiting on that
            // routine aside in the same transaction the lifter's own PUT does — which makes this
            // device's remaining cards for it stale the instant the tap answers. Re-read rather than
            // re-derived, exactly as the mid-session save does: the supersede is the server's rule,
            // and a second copy of it on the phone is a rule that will eventually disagree.
            await loadProposals(from: gym)
            return .settled(landed.proposal)
        } catch let error as WindmillApiError {
            // A removal's 404 is its RECEIPT — the delete takes this very row with it — and this
            // device asks rather than assumes: the cascade is the server's invariant, so the
            // routines are re-read and the day is called gone only where the log agrees it is. A
            // 404 whose routine still stands is a proposal this account no longer has and nothing
            // more, which is the sentence `settling` says.
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

    // Dismissing asks for no reason and changes nothing — but it is still a DECISION, so it goes to
    // the log and the row that comes back is the dated record the routine keeps. A card that
    // vanished on the tap would be the one outcome this design refuses: an agent's suggestion is
    // part of the program's history whichever way it went.
    public func dismiss(_ proposalId: String) async -> Settling {
        guard let gym else { return .failed(.refused("proposals need your account — sign in first")) }
        do {
            let settled = try await gym.dismissProposal(proposalId)
            settle(settled)
            return .settled(settled)
        } catch let error as WindmillApiError {
            return await settling(after: error, of: proposalId, with: gym)
        } catch {
            return .failed(.noAnswer)
        }
    }

    // The two 409s the apply route carries — the base moved, or the other decision was already
    // taken — and they are ANSWERS rather than failures. Neither is retryable and neither may be
    // drawn as if the tap had landed, so this device stops repeating what it hoped and re-reads
    // what the log holds: the row's own state is the whole story, and both lists come with it —
    // the routine that moved is on the screen behind, and the cards on it moved with it.
    //
    // The CODE decides, never the sentence — a 409 this build has never heard of is reported in the
    // log's own words rather than folded into a settlement it may not be.
    private func settling(after error: WindmillApiError, of proposalId: String,
                          with gym: any TrainingSyncing) async -> Settling {
        guard case .refused(let status, let refusal) = error else { return .failed(.noAnswer) }
        // Gone is gone, and the card goes with it: a row the log denies would otherwise wait on
        // home and on its routine until the next seat change, offering a decision with nowhere to
        // land — and the screen behind this answer only ever redraws the sentence.
        if status == 404 {
            forget(proposal: proposalId)
            return .gone
        }
        guard status == 409,
              refusal.code == "proposal-superseded" || refusal.code == "proposal-settled" else {
            return .failed(WriteFailure(error))
        }
        // Both codes say the same thing about this device: the log moved under it. The routine that
        // moved is on the screen behind, and every other card on that routine was set aside by
        // whatever moved it — so both lists are read again before the row itself is.
        await loadRoutines(from: gym)
        await loadProposals(from: gym)
        switch await proposal(proposalId) {
        case .success(let fresh):
            settle(fresh)
            return .settled(fresh)
        case .failure(let why):
            // The re-read is the only way this device learns which decision stands, so a re-read
            // that missed leaves the screen as it was rather than guessing at one.
            return .failed(why)
        }
    }

    // The settled row replaces the head the card was drawn from, in place: the list is the log's own
    // order and a settlement does not move a proposal in it. A row this device never had is not
    // invented here — every door onto a proposal on this surface came off this list.
    private func settle(_ proposal: Proposal) {
        proposals = proposals.map { $0.id == proposal.id ? proposal.head : $0 }
    }

    // A routine that is gone takes its whole ledger with it — the server cascades the rows, and a
    // history row left behind here would point at a proposal nothing can read.
    private func forget(routine routineId: String) {
        routines = routines.filter { $0.id != routineId }
        proposals = proposals.filter { $0.routineId != routineId }
    }

    // One row the log no longer holds. It is dropped rather than settled: there is no state to draw
    // and no dated record to keep — the log has nothing to date it by.
    private func forget(proposal proposalId: String) {
        proposals = proposals.filter { $0.id != proposalId }
    }

    // The account's routines under the device's own, in one order. A read that missed leaves the
    // shelf's own routines on screen — they are real — and asks nothing further: an empty answer
    // and a missing one draw the same list, and no screen claims "this lifter has written none".
    private func loadRoutines(from gym: any TrainingSyncing) async {
        guard let written = try? await gym.routines() else { return }
        routines = Routine.byLastTrained(written + localLog.routines)
    }

    // The cards, read once per seat — this is what refills the list `connect` let go of above, so a
    // read that missed draws NOTHING. That is the honest silence rather than a gap: no surface in
    // gym ever says "nothing is waiting for you", so an absent card asserts nothing at all, where a
    // card held over from a read that never answered would assert that one is waiting.
    private func loadProposals(from gym: any TrainingSyncing) async {
        guard let read = try? await gym.proposals() else { return }
        proposals = read
    }

    // A movement the catalog has never heard of, minted through §N screen 31. HOW IT IS LOADED IS
    // ASKED and never assumed: this wrote `equipment: "barbell"` in itself until 2026-08-13, which
    // is a fact about somebody's gym invented by a phone, and it is the one thing on that screen the
    // lifter is actually asked for. `pattern` still is not asked, and stays the domain's own value
    // for "unknown" — a movement nobody classified is not a movement classified wrongly.
    //
    // Signed out the movement is minted onto this device — a fresh phone has no catalog at all, so
    // without this the anonymous room could not log its first set. The claim replays the create
    // BEFORE any session, because a set naming a movement the log has never heard of is refused.
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

    // THE SESSION AS THIS DEVICE HOLDS IT — whatever the log (or the shelf) answered with, under the
    // corrections and deletions this device has not managed to send yet. Without it a screen reopened
    // after a relaunch would draw the numbers the lifter corrected AWAY, because the log is still
    // honestly answering with the row it has, and a delete would come back from the dead.
    private func holding(_ detail: SessionDetail) -> SessionDetail {
        let owed = queue.owed(in: detail.session.id)
        guard !owed.isEmpty else { return detail }
        return SessionDetail(session: detail.session,
                             sets: detail.sets.compactMap { set -> TrainingSet? in
                                 guard let mine = owed.first(where: { $0.set.id == set.id }) else { return set }
                                 return mine.owes == .delete ? nil : mine.set
                             })
    }

    // FIX A SET (§G18). Local-first exactly as logging one is: the corrected row is on this device
    // and on screen before the log is consulted, and the wire write rides the same queue with the
    // same lanes, the same retry cadence and the same verdicts by code. It cannot fail here — a
    // correction the log will never take is SAID afterwards, in the banner every lost write rides.
    //
    // WHERE THE SET LIVES DECIDES WHICH WRITE THIS IS, and `logHasNeverSeen` below is the whole of
    // that question. A session still on this device's shelf is corrected THERE, so the claim replays
    // the corrected set and never the original; a row still owed as an append is rewritten in the
    // queue; only a row the log actually holds is corrected over the wire. No path can reach
    // `gym_sessions.plan` or a routine — the log moves and the program does not.
    @discardableResult
    public func fix(_ set: TrainingSet, in sessionId: String, by correction: SetFix) async -> TrainingSet {
        let corrected = set.corrected(by: correction)
        if localLog.holds(session: sessionId) {
            localLog.fix(set: set.id, in: sessionId, by: correction)
            localLog.flush()
            // The log's row for a shelf session is this device's own arithmetic, so it is recomputed
            // here — the tonnage and the top set both move when a working set does.
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
        // WHAT STANDS, WHICH IS NOT ALWAYS WHAT WAS ASKED FOR. A change the log refused outright is
        // not a change: the row is still on the log under the numbers it had, and the screen is told
        // so here rather than drawing a correction that never happened underneath a banner saying it
        // never happened. Only refusals THIS call collected are read — an older loss for the same
        // set is still on the banner, and would otherwise answer for a write nobody has made yet.
        let refused = refusals.dropFirst(said).contains {
            guard case .change(let lost) = $0 else { return false }
            return lost.id == set.id
        }
        return refused ? set : corrected
    }

    // DELETE A SET (§G18) — the one place in gym where a set the log already holds can be taken away,
    // and the sheet that offers it promises nothing about getting it back. What it does offer is the
    // same nine seconds the logger's Undo keeps, because a training log is a multi-year artifact
    // nobody can regenerate and a destruction with no way back is the one thing this screen could get
    // wrong that a lifter could not repair.
    //
    // The homes again, and the deletion is remembered across all of them so one Undo answers any.
    public func delete(_ set: TrainingSet, in sessionId: String) async {
        let until = now() + undoWindowMs
        taken = Deletion(set: set, sessionId: sessionId, untilMs: until)
        if localLog.holds(session: sessionId) {
            localLog.drop(set: set.id, in: sessionId)
            localLog.flush()
            recent = mergedRecent(served)
            return
        }
        // A row the log has never been told about is taken back HERE and no wire write is ever
        // enqueued: the id names nothing on the log, so a DELETE would be a write about nothing —
        // benign today only because the route is unconditionally idempotent. Letting the queue's own
        // row go IS the whole deletion; the queue was that set's only home, and the Undo below puts
        // it back the same way.
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

    // The delete taken back, inside its window and never after it: past that the row has left the log
    // and no route brings it home, which is exactly what the sheet declines to promise.
    //
    // THE RECORD IS LET GO ONLY ONCE A REPAIR HAS TAKEN. Clearing it first and then finding the home
    // it named already gone — the claim empties this shelf on the queue's own cadence, so an ordinary
    // return to signal does it — is how an Undo ends with the offer off the screen, the row put back
    // nowhere, and nothing said.
    @discardableResult
    public func restore() async -> Bool {
        guard let taken = restorable else { return false }
        // The shelf still holding the session is what says the row came off it, and the row simply
        // goes back — in its performed place, because `keep` sorts.
        if let local = localLog.session(taken.sessionId) {
            localLog.keep(local.session, sets: local.sets + [taken.set])
            localLog.flush()
            recent = mergedRecent(served)
            self.taken = nil
            return true
        }
        // The log holds the session and the repair is the DELETE the queue has not sent yet.
        if queue.restore(taken.set.id) {
            queue.flush()
            drawFromQueue()
            self.taken = nil
            return true
        }
        // Neither, and there are two ways here: the row was withdrawn from the queue because the log
        // had never seen it, or the claim filed its whole session on the account mid-window and took
        // the shelf with it. One repair covers both — a set only ever reaches the log one way, so it
        // goes back as an APPEND under its own idempotent id. A session the log has since closed
        // refuses that append, and the refusal is SAID with the numbers on it: the one thing this
        // store may never do with a set somebody lifted is lose it quietly.
        self.taken = nil
        queue.store(taken.set, in: taken.sessionId, needsPush: true)
        queue.flush()
        drawFromQueue()
        await deliver()
        return true
    }

    // WHETHER THE LOG HAS EVER BEEN TOLD ABOUT THIS ROW — the question §G18's two writes turn on, and
    // there are THREE homes to ask it of rather than two. The shelf is the first and both callers ask
    // it directly. The other two live in the queue: a session composed on this device that no account
    // has claimed yet — gym's default state since the room opened anonymous-first — and a set logged
    // seconds ago whose append is still owed. The server has no id for either, so a PATCH or a DELETE
    // naming one is a write about nothing, and the PATCH is worse than nothing: filed over the append
    // it destroys the only copy of a set on its way to a log that never heard of it. `discard` one
    // screen up already asks the middle question.
    private func logHasNeverSeen(_ setId: String, in sessionId: String) -> Bool {
        if queue.sessionIsUnclaimed, queue.session?.id == sessionId { return true }
        return queue.owes(setId) == .append
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
        // Whether anything this walk landed changed a session that is already HISTORY — a correction
        // or a deletion does, an append into the live workout does not.
        var movedHistory = false
        while let owed = queue.nextOwed(skipping: blocked, readyAt: force ? nil : now()) {
            do {
                switch owed.write {
                case .append:
                    let stored = try await gym.appendSet(to: owed.sessionId, SetWrite(owed.set))
                    queue.delivered(stored, for: owed.set.id, in: owed.sessionId)
                case .fix:
                    let stored = try await gym.fixSet(owed.set.id, in: owed.sessionId,
                                                      SetFix(weightKg: owed.set.weightKg,
                                                             reps: owed.set.reps, kind: owed.set.kind))
                    queue.delivered(stored, for: owed.set.id, in: owed.sessionId)
                    movedHistory = true
                case .delete:
                    try await gym.deleteSet(owed.set.id, in: owed.sessionId)
                    queue.drop(owed.set.id)
                    movedHistory = true
                }
            } catch {
                let verdict = Verdict(refusing: error)
                // `set-not-found` NAMES a row the write expects to already be there, which makes it a
                // CHANGE's word and never an append's. Today's log emits it from one handler and an
                // append cannot honestly meet it — but nothing on either side of the wire pins that,
                // and a queue that dropped a set on a code it was never sent would be losing training
                // to a server change nobody here would see. An append keeps waiting instead.
                if case .gone = verdict, owed.write == .append {
                    blocked.insert(owed.lane)
                    continue
                }
                // A SPENT ID IS AN APPEND'S REPAIR AND ONLY AN APPEND'S: a correction and a deletion
                // NAME a row that already stands, so a fresh id would send the write at a set nobody
                // has ever logged. Spending their whole budget up front is how that is said — the
                // collision is simply terminal for them, in the log's own words.
                let budget = owed.write == .append ? owed.remints : SetQueue.maxRemints
                if let reason = verdict.terminalReason(afterRemints: budget) {
                    // Removed and SAID, never swallowed. A lost APPEND is the only copy left of a set
                    // somebody lifted; a lost correction or deletion is a set the log still holds
                    // under numbers the lifter tried to move it off. Two losses, two sentences, one
                    // banner — and a queue that dropped either quietly would count it as intended.
                    queue.drop(owed.set.id)
                    refusals.append(owed.write == .append
                                    ? .set(RefusedSet(owed.set, reason: reason))
                                    : .change(RefusedSet(owed.set, reason: reason)))
                    // The NOTE under the logger speaks for the set the lifter just logged, so only an
                    // append's loss moves it. A change that will never land is said in the banner and
                    // nowhere else — the row it names is still on the log, under the numbers it had.
                    if owed.write == .append { refusal = reason }
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
        // The log's row for a past session — its working count, its tonnage, its top e1RM, its gold
        // dot — is the SERVER's arithmetic over the sets it holds, and a correction moves all of
        // them. A stale row beside a session the lifter just changed is the screen disagreeing with
        // the log about a number they moved themselves.
        if movedHistory { await loadLog() }

        // WHAT IS STILL OWED IS OWED WHATEVER ELSE THE WALK MET. The next attempt is scheduled off
        // the queue before anything is said, because a refusal in one lane must not take the retry
        // away from a set merely jammed in another: nothing else carries that one, and returning at
        // the refusal left it on the device with no task at all until the next tap. It is scheduled
        // off EVERY write still carried — a correction jammed behind a 500 needs the cadence exactly
        // as much as a set does. Parked sets are not carried by the WALK at all — the claim is their
        // road, riding the same beat when it is owed retryably.
        let carried = queue.pending.filter { $0.sessionId != parked }
        if let earliestReady = carried.map({ $0.heldUntilMs ?? 0 }).min() {
            let waiting = earliestReady - now()
            scheduleDeliver(after: waiting > 0 ? .milliseconds(waiting) : retryAfter)
        } else if claimOwedRetryably {
            // Nothing for the walk to carry — but a claim still owed retryably is the parked
            // sets' own road, and this walk just cancelled the task that was carrying it.
            scheduleDeliver(after: retryAfter)
        }

        // AND THE WORD IS ABOUT SETS THIS DEVICE IS THE ONLY HOME OF. A correction is not one of
        // them — the log holds that row already — so a fix jammed behind a 500 for a session from
        // last week may not put "offline · saved here" under a set that landed a second ago, which
        // is the one thing this note exists to state. `strandedCount` and `stalled` were taught the
        // same distinction; a change that is lost for good is said in the banner instead.
        if let refusal {
            settle(.refused(refusal))
            return
        }
        let owedSets = queue.pending.filter { $0.owes == .append }
        // A set the walk never offered is not a set that failed. Everything owed being inside its own
        // undo window means this device is holding them ON PURPOSE, so the next walk is the one that
        // opens — and saying "offline" over a send nobody has attempted would put the wrong word
        // under a healthy connection. Parked sets read "saved on this device", which is where they are.
        guard let earliestSet = owedSets.filter({ $0.sessionId != parked })
            .map({ $0.heldUntilMs ?? 0 }).min() else {
            settle(owedSets.isEmpty ? .onTheLog : .onThisDevice)
            return
        }
        guard earliestSet - now() > 0 else {
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
            // claim that stopped being owed re-reads the log, so what landed reaches the room with no
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
    // movements, then routines, then finished sessions oldest first, then the live session's start,
    // then the settings — and strictly per session: start with the client-minted id, the TRUE
    // startedAt and `joinOpenSession: false` (the join default once filed a past session's sets into
    // a live workout), then every set per lane in original order, then finish at the true instant.
    // No log or stats read interleaves, because settleOpen would auto-close a >4h-old session
    // mid-replay and refuse every later set forever.
    //
    // Verdicts by CODE only, and a failure aborts the walk rather than dropping anything: what is
    // still owed is owed. A WAIT — the account's other workout still open — stands down whole and
    // stays event-driven, resumed by the next connect or the next local finish; a RETRYABLE ending
    // (offline, 5xx, 401, 404) arms the queue's own cadence and replays from where this one
    // stopped — idempotent ids make the repetition free.
    //
    // SETTINGS RIDE ALONG AND NEED NO NEW VERB (§11.7 step 4): the device's document goes out through
    // `sendWhatIsOwed` as one ordinary whole-document PUT, and because that write is last-write-wins,
    // replaying it after sign-in is exactly what makes the DEVICE's copy the one that stands — they
    // are the values the lifter just touched. It walks LAST, behind every lift, and that order is
    // load-bearing in one direction only: nothing in the log reads this row, so a settings route an
    // older server has never heard of must never be able to keep a set off the log.
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
            let ending = await claimLive(live, with: gym)
            guard ending == .settled else { return ending }
        }
        return await sendWhatIsOwed(with: gym).ending
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

        // THE SHELF IS RE-READ PER SET rather than walked off the snapshot taken above, and §G18 is
        // why: a lifter can correct or delete a set of a session that is still this device's while
        // this replay is parked on a slow call. Off the snapshot that correction would land on the
        // account as the ORIGINAL number, or a deleted set would be resurrected there — and the
        // shelf that held the truth is cleared the moment this session finishes.
        //
        // What is left is one race and it is stated rather than hidden: a repair made AFTER its own
        // set has already gone out, but before the finish below clears the shelf, is lost — the log
        // has the original and no copy survives to correct it from. It is a window of milliseconds
        // against a session the lifter is watching being claimed, and the cost is a correction that
        // has to be made again, never a set.
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
                    let verdict = Verdict(refusing: error)
                    // The claim only ever appends, and `set-not-found` is not an append's word (the
                    // walk says why): the set stays on the shelf and the cadence tries again rather
                    // than the only copy of it being dropped over a code it was never sent.
                    if case .gone = verdict { return (nil, .retry) }
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

    // THE LOG, READ AGAIN — and never shallower than it already was. `served` is both what the log
    // draws and the cursor `loadOlder` pages from, so an answer of one page would scroll a lifter who
    // had loaded three back to the top and take the older two with it — including, whenever the
    // session a correction was just made in is older than a page, the session they are standing in.
    // The depth is what they asked for themselves, so re-reading it costs one round trip per page
    // they scrolled and only on the reads that change history.
    private func loadLog() async {
        guard let gym else { return }
        logFoot = .loading
        var read: [SessionSummary] = []
        var more = true
        while more, read.count < max(served.count, Self.logPage) {
            guard let page = try? await gym.sessions(before: read.last?.session.startedAtMs,
                                                     beforeId: read.last?.id,
                                                     limit: Self.logPage) else {
                // The rows already on screen stay — they are real sessions and worth reading — and
                // the foot says the read failed rather than that the log ends here. A screen
                // admitting it could not load has not earned the right to also name somebody's
                // first session.
                logFoot = .failed
                return
            }
            read += page
            more = page.count == Self.logPage
        }
        served = read
        logFoot = more ? .more : .bottom
        recent = mergedRecent(read)

        // A page read while the claim is mid-replay may hold the replay's own past session open.
        // The merge above stands — history is history — but nothing is settled or adopted off it:
        // adopting would hand the room a workout the claim is about to finish at a stale instant,
        // and closing would act on a picture the replay is still changing. The read after the
        // claim ends decides.
        guard !claiming else { return }
        guard let open = read.first(where: { $0.session.isOpen }) else {
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
        // word. Nor is a correction or a deletion still owed — the log holds those rows, so they are
        // not sets this device is the only home for.
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

    // One write, one beat. The tick is what the note watches, so two sets landing in the same state
    // still read as two saves rather than as one that never faded.
    private func settle(_ state: SaveState) {
        saveState = state
        saveTick += 1
    }
}
