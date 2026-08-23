package works.windmill.gym.store

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet

// The local-first write queue. A set's client-minted id IS the idempotency key, so sends may repeat
// in any order and the log converges on one row per id.
//
// Walk by identity, never by position: entries are keyed by the minted set id.
// Order is per (session, exercise) — the only order the server keeps, numbering sets max+1 per lane.
// A set that cannot land holds up its own lane and nothing else.
//
// A set that never landed is refused once the session is finished, so the queue must flush BEFORE a
// finish, before the boot read and before the claim's starts.
// `deviceOwner` is the account this device holds a session for at open time.
class SetQueue(
    private val file: File,
    deviceOwner: String? = null,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    // The key the server numbers sets under.
    data class Lane(val sessionId: String, val exerciseId: String)

    @Serializable
    data class Entry(
        val set: TrainingSet,
        val sessionId: String,
        val needsPush: Boolean,
        val remints: Int,
        // The undo window: a set can be taken back only while this device is the only place it
        // exists. Defaulted — the decoder tolerates a missing key only where there is a default.
        val heldUntilMs: Long? = null,
    ) {
        val lane: Lane get() = Lane(sessionId, set.exerciseId)

        fun isHeld(at: Long): Boolean = (heldUntilMs ?: 0) > at
    }

    companion object {
        // Id collisions one set may survive before the refusal is said out loud.
        const val maxRemints = 3

        // Must match iOS SetQueue.swift to the millisecond.
        const val undoWindowMs = 9_000L

        // Resolved by the room edge against context.filesDir; this file touches no android class.
        const val fileName = "windmill-gym-sets.json"
    }

    // The file holds one queue per seat; only the seat in hand is reachable.
    @Serializable
    private data class Queued(
        val session: Session? = null,
        val entries: Map<String, Entry> = emptyMap(),
        // The movements this session walks, in order. Not derivable from the sets: a movement
        // appended and not yet logged has none.
        val order: List<String>? = null,
        // True for a session composed on this device with no server answer; the claim's landed start
        // turns it false. Absent reads as unclaimed, costing at most one start replay.
        val unclaimed: Boolean? = null,
    ) {
        val isEmpty: Boolean get() = session == null && entries.isEmpty()
    }

    @Serializable
    private data class Held(val queues: Map<String, Queued> = emptyMap())

    private var seat: String = Seat.of(deviceOwner)
    private var migrated = false
    private var held: Held = open(deviceOwner)

    init {
        if (migrated) flush()
    }

    // An unnamed queue is seated to the device's account, or quarantined when it holds no session;
    // quarantine is reachable by no seat and adopted by no arriving account.
    private fun open(deviceOwner: String?): Held {
        val text = runCatching { file.readText() }.getOrNull() ?: return Held()
        val before = runCatching { diskJson.decodeFromString(Queued.serializer(), text) }.getOrNull()
        if (before != null && !before.isEmpty) {
            migrated = true
            return Held(mapOf((if (deviceOwner == null) Seat.quarantine else seat) to before))
        }
        return runCatching { diskJson.decodeFromString(Held.serializer(), text) }.getOrElse { Held() }
    }

    private val mine: Queued get() = held.queues[seat] ?: Queued()

    private fun keep(next: Queued) {
        held = Held(held.queues + (seat to next))
    }

    // The one place the seat changes hands. The departing seat's live session and owed sets stay on
    // disk under their own key, so no set is re-sent under somebody else's bearer. The anonymous
    // queue rides onto an arriving account seat only when that seat has nothing live of its own, and
    // only once the server has answered for this seat in this process (`confirmed`).
    fun adopt(owner: String?, confirmed: Boolean = true) {
        val next = Seat.of(owner)
        val arriving = held.queues[next] ?: Queued()
        val anonymous = held.queues[Seat.anonymous] ?: Queued()
        // Not conditioned on the seat changing: a confirmed account seat with a free slot sweeps any
        // anonymous queue.
        val carrying = owner != null && confirmed && !anonymous.isEmpty && arriving.isEmpty
        if (next == seat && !carrying) return
        val parked = if (carrying) held.queues - Seat.anonymous else held.queues
        val landed = if (carrying) anonymous else arriving
        seat = next
        held = Held((parked + (next to landed)).filterValues { !it.isEmpty })
        flush()
    }

    // Names no movement and no numbers: whoever reads this may not be who lifted them.
    val unattributedSession: Session? get() = held.queues[Seat.quarantine]?.session

    // There can be owed sets and no live session.
    val hasUnattributed: Boolean get() = Seat.quarantine in held.queues

    // Only a signed-in seat may claim the quarantine, and only onto a seat holding nothing of its
    // own: there is room for one live workout and one set of owed lanes.
    fun release(): Boolean {
        if (seat == Seat.anonymous) return false
        val quarantined = held.queues[Seat.quarantine] ?: return false
        if (!mine.isEmpty) return false
        held = Held(held.queues - Seat.quarantine + (seat to quarantined))
        flush()
        return true
    }

    fun discardUnattributed() {
        if (Seat.quarantine !in held.queues) return
        held = Held(held.queues - Seat.quarantine)
        flush()
    }

    val order: List<String> get() = mine.order ?: emptyList()

    fun append(exerciseId: String) {
        if (exerciseId in order) return
        keep(mine.copy(order = order + exerciseId))
    }

    fun hold(order: List<String>) {
        keep(mine.copy(order = order))
    }

    val session: Session? get() = mine.session

    // Nothing walks its sets while this holds, and no read may trade it for the account's other open
    // workout.
    val sessionIsUnclaimed: Boolean get() = mine.session != null && (mine.unclaimed ?: true)

    // A different session id clears the movement order rather than merging it.
    // `unclaimed` defaults to false: only the on-device start passes true.
    fun hold(session: Session?, unclaimed: Boolean = false) {
        val kept = if (mine.session?.id == session?.id) mine.order else null
        keep(mine.copy(session = session, order = kept, unclaimed = if (session == null) null else unclaimed))
    }

    fun claimed(sessionId: String) {
        if (mine.session?.id != sessionId) return
        keep(mine.copy(unclaimed = false))
    }

    val sets: List<TrainingSet>
        get() {
            val live = mine.session ?: return emptyList()
            return sets(live.id)
        }

    fun sets(sessionId: String): List<TrainingSet> = mine.entries.values
        .filter { it.sessionId == sessionId }
        .map { it.set }
        .sortedBy { it.completedAtMs }

    // Oldest first: sorting by the instant performed makes the per-lane walk the server's own order.
    val pending: List<Entry>
        get() = mine.entries.values
            .filter { it.needsPush }
            .sortedBy { it.set.completedAtMs }

    fun owed(sessionId: String): List<Entry> = pending.filter { it.sessionId == sessionId }

    // `readyAt` is the instant the walk stands at; an entry still inside its undo window is not
    // offered at it. A forced walk passes null, which ends the window.
    fun nextOwed(skipping: Set<Lane>, readyAt: Long?): Entry? = pending.firstOrNull { entry ->
        if (entry.lane in skipping) return@firstOrNull false
        if (readyAt == null) return@firstOrNull true
        !entry.isHeld(readyAt)
    }

    // The newest set still inside its undo window.
    fun withdrawable(at: Long = clock()): Entry? = pending.lastOrNull { it.isHeld(at) }

    // Legal only while the set is still owed; false once the log holds the row.
    fun withdraw(id: String): Boolean {
        val entry = mine.entries[id] ?: return false
        if (!entry.needsPush) return false
        keep(mine.copy(entries = mine.entries - id))
        return true
    }

    // Both directions: a set just logged (owed), and a row the log handed back (not owed), which
    // settles an owed set.
    fun store(set: TrainingSet, sessionId: String, needsPush: Boolean, heldUntilMs: Long? = null) {
        val remints = mine.entries[set.id]?.remints ?: 0
        keep(mine.copy(
            entries = mine.entries + (set.id to Entry(set, sessionId, needsPush, remints, heldUntilMs))))
    }

    // Clear the sent key as well as the stored one, or a reply that disagreed leaves an entry owed
    // forever.
    fun delivered(stored: TrainingSet, id: String, sessionId: String) {
        keep(mine.copy(entries = mine.entries - id +
            (stored.id to Entry(stored, sessionId, needsPush = false, remints = 0, heldUntilMs = null))))
    }

    // The same set under a new key, still owed, with the remint budget counted down.
    fun remint(id: String, fresh: String) {
        val entry = mine.entries[id] ?: return
        // The fresh id carries no hold: the undo window was already spent.
        keep(mine.copy(entries = mine.entries - id +
            (fresh to Entry(entry.set.copy(id = fresh), entry.sessionId, needsPush = true,
                remints = entry.remints + 1, heldUntilMs = null))))
    }

    fun drop(id: String) {
        keep(mine.copy(entries = mine.entries - id))
    }

    // Set ids do not move: each is its own key with its own remint budget.
    fun remapSession(old: String, fresh: String) {
        val entries = mine.entries.mapValues { (_, entry) ->
            if (entry.sessionId == old) entry.copy(sessionId = fresh) else entry
        }
        val session = mine.session?.let { if (it.id == old) it.copy(id = fresh) else it }
        keep(mine.copy(session = session, entries = entries))
    }

    // A movement id must change everywhere this queue wrote it: the sets, the walk order and the
    // live plan's lines.
    fun remapExercise(old: String, fresh: String) {
        val entries = mine.entries.mapValues { (_, entry) ->
            if (entry.set.exerciseId == old) entry.copy(set = entry.set.copy(exerciseId = fresh)) else entry
        }
        val order = mine.order?.map { if (it == old) fresh else it }
        val session = mine.session?.let { live ->
            val plan = live.plan?.let { plan ->
                plan.copy(entries = plan.entries.map {
                    if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
                })
            }
            live.copy(plan = plan)
        }
        keep(mine.copy(session = session, entries = entries, order = order))
    }

    // Delivered sets are released; an owed set stays queued until the log answers for it.
    fun close(sessionId: String) {
        keep(mine.copy(entries = mine.entries.filterValues { it.sessionId != sessionId || it.needsPush }))
        if (mine.session?.id == sessionId) letGo()
    }

    // A session that no longer exists: the one case where an owed set is dropped.
    fun forget(sessionId: String) {
        keep(mine.copy(entries = mine.entries.filterValues { it.sessionId != sessionId }))
        if (mine.session?.id == sessionId) letGo()
    }

    private fun letGo() {
        keep(mine.copy(session = null, order = null, unclaimed = null))
    }

    fun flush() {
        val text = runCatching { diskJson.encodeToString(Held.serializer(), held) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}

// A refusal stripped of the transport that carried it.
data class RefusalFacts(
    val status: Int? = null,
    val code: String? = null,
    val sentence: String? = null,
    val offline: Boolean = false,
    val malformed: Boolean = false,
) {
    // Only a transport failure is "offline"; a lapsed session is its own fact.
    val blocker: Blocker
        get() = when {
            offline -> Blocker.Offline
            status == 401 -> Blocker.SignInLapsed
            else -> Blocker.LogFailed
        }
}

// The code is the contract; the sentence is copy and may be reworded any day — never branch on it.
sealed class Verdict {
    data class Remint(val said: String) : Verdict()     // 409 set-id-taken / session-id-taken — that id names a row elsewhere
    data class Dropped(val said: String) : Verdict()    // 409 session-finished — this set never landed and never will
    data class Refused(val said: String) : Verdict()    // 400, any other 409 — this body will never land as written
    data object Retry : Verdict()                       // 5xx, no reply at all, and everything that is only waiting

    // The sentence to say, or null while the set is still owed.
    fun terminalReason(afterRemints: Int): String? = when (this) {
        is Retry -> null
        is Remint -> if (afterRemints < SetQueue.maxRemints) null else said
        is Dropped -> said
        is Refused -> said
    }

    companion object {
        fun refusing(facts: RefusalFacts): Verdict {
            // Neither `offline` nor `malformed` is a lost set: replay is free, so both stay queued.
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Retry
            val said = facts.sentence ?: "the log refused this set"
            if (facts.code == "set-id-taken" || facts.code == "session-id-taken") return Remint(said)
            if (facts.code == "session-finished") {
                return Dropped("the session closed before this set reached it")
            }
            // 5xx is the server's and retryable; 400 and the remaining 409s are terminal.
            if (status >= 500) return Retry
            if (status == 400 || status == 409) {
                return Refused(if (facts.code == "unknown-exercise") "that movement is not in the catalog" else said)
            }
            // 401 waits for a sign-in and 404 for a session to exist; here a 404 only waits.
            return Retry
        }
    }
}

// `Gone` means the log does not hold that set at all, so the drawn row is stale. `Unwritable` means
// the row is there and these bytes will never land. Everything else waits.
sealed class FixVerdict {
    data class Gone(val said: String) : FixVerdict()        // 404 set-not-found — that row is not on the log
    data class Unwritable(val said: String) : FixVerdict()  // 400 fix-unreadable — this body never lands
    data object Retry : FixVerdict()                        // 5xx, 401, no reply at all

    companion object {
        fun refusing(facts: RefusalFacts): FixVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Retry
            val said = facts.sentence ?: "the log refused this fix"
            if (facts.code == "set-not-found") return Gone("that set is no longer on the log")
            if (facts.code == "fix-unreadable") return Unwritable(said)
            if (status >= 500) return Retry
            // A code-less 404/400 is an older server, not a different meaning.
            if (status == 404) return Gone("that set is no longer on the log")
            if (status == 400 || status == 409) return Unwritable(said)
            return Retry
        }
    }
}

// `Superseded` means the routine moved after the diff was written: never retried, never merged.
// None of the three is retryable, and none is a loss — an undecided proposal still sits on the routine.
sealed class ProposalVerdict {
    data class Superseded(val said: String) : ProposalVerdict()   // 409 proposal-superseded — the routine moved first
    data class Settled(val said: String) : ProposalVerdict()      // 409 proposal-settled — the other decision was already taken
    data class Gone(val said: String) : ProposalVerdict()         // 404 — absent, another account's, never existed
    data object Retry : ProposalVerdict()                         // 5xx, 401, no reply at all

    companion object {
        fun refusing(facts: RefusalFacts): ProposalVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Retry
            if (facts.code == "proposal-superseded") {
                return Superseded("the routine moved after this was written — nothing was applied")
            }
            if (facts.code == "proposal-settled") {
                return Settled("that proposal was already decided")
            }
            if (status >= 500) return Retry
            // A code-less 404/400/409 is an older server, not a different meaning.
            if (status == 404) return Gone("that proposal is no longer on the log")
            if (status == 400 || status == 409) {
                return Settled(facts.sentence ?: "that proposal was already decided")
            }
            return Retry
        }
    }
}

// Told apart by status and code, never by the English. `Absent` is a deployment with no model
// configured, and the room takes the door down for it.
sealed class AskVerdict {
    data class Said(val said: String) : AskVerdict()   // the answer is the sentence, and it will not change on a retry
    data class Again(val said: String) : AskVerdict()  // 5xx, no reply at all — the one worth offering a retry on
    data class Fresh(val said: String) : AskVerdict()  // 409 — this conversation cannot take the question; the next one opens a new thread
    data object Absent : AskVerdict()                  // 404 — this deployment has no Ask

    companion object {
        fun refusing(facts: RefusalFacts): AskVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Again(noAnswer)
            if (status == 404) return Absent
            if (status >= 500) return Again(facts.sentence ?: noAnswer)
            // Both are answered by opening a new thread; nothing is re-sent on its own.
            if (facts.code == "ask-thread-full" || facts.code == "ask-thread-taken") {
                return Fresh(facts.sentence ?: "that conversation is full — ask again to start a new one")
            }
            return Said(facts.sentence ?: "Ask couldn't take that one")
        }

        private const val noAnswer = "Ask didn't answer. Try again in a moment"
    }
}

// What is said when a write is lost for good.
sealed interface RefusedWrite {
    val reason: String
}

// The last copy of the set, so the movement and numbers travel with the reason.
data class RefusedSet(
    val id: String,
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    override val reason: String,
) : RefusedWrite {
    constructor(set: TrainingSet, reason: String) :
        this(set.id, set.exerciseId, set.weightKg, set.reps, reason)
}

// Let go from the shelf so the same terminal write is not re-sent on every connect. The id rides
// unshown, so two passes refusing the same workout are one loss on the banner.
data class RefusedClaim(val id: String, val name: String, override val reason: String) : RefusedWrite {
    constructor(session: Session, reason: String) :
        this(session.id, "${session.plan?.routine ?: "workout"} · ${Readout.date(session.startedAtMs)}", reason)
}

// How a write reports itself. Silence is a state: a room that has just opened says nothing.
sealed class SaveState {
    data object Idle : SaveState()
    data object OnTheLog : SaveState()          // the account has it
    data object OnThisDevice : SaveState()      // held on purpose: nobody signed in, or the log cannot take this session yet
    data class Blocked(val by: Blocker) : SaveState()   // signed in and offered, and this is what stopped it landing
    data class Refused(val reason: String) : SaveState()

    // "offline" is said only when the transport failed; a 500 and a lapsed session get their own words.
    val line: String?
        get() = when (this) {
            Idle -> null
            OnTheLog -> "on the log"
            OnThisDevice -> "saved on this device"
            is Blocked -> when (by) {
                Blocker.Offline -> "offline · saved here"
                Blocker.LogFailed -> "the log didn’t answer · saved here"
                Blocker.SignInLapsed -> "sign in again · saved here"
            }
            is Refused -> reason
        }
}

// The key every device store files rows under. The account id is IN THE KEY rather than in a field a
// reader filters on, so a shelf opened for one seat can never resolve another seat's rows.
object Seat {
    const val anonymous = "anon"

    // Rows nothing on disk attributes, parked under a key `of` can never return. The settings screen
    // is the one door out, and it takes a human.
    const val quarantine = "unattributed"

    fun of(owner: String?): String = if (owner == null) anonymous else "u.$owner"
}

// Unknown keys are tolerated and an absent optional is omitted rather than written as null.
internal val diskJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

// Temp file renamed over the old copy, so a crash mid-write leaves the last good file on disk.
// Failures are swallowed: the memory copy is the truth.
internal fun writeAtomically(file: File, text: String) {
    runCatching {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        try {
            Files.move(tmp.toPath(), file.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
