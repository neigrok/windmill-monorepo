package works.windmill.gym.store

import java.io.File
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.storage.AtomicDocument
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimSource
import works.windmill.gym.domain.ClaimKind
import works.windmill.gym.domain.ClaimItem
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.WorkoutEvent
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.gym.domain.WorkoutState

// The local-first write queue: appends, corrections and deletions of the live session's sets ride
// one walk. iOS's SetQueue.swift is the same contract and the two must not drift. A set's
// client-minted id IS the idempotency key, so sends may repeat in any order and the log converges on
// one row per id. An append once sent may be on the log until the log answers it, so a change to that
// set is filed behind the append rather than over it, and a reply settles an entry only while it
// still reads as it did when sent.
//
// Walk by identity, never by position: entries are keyed by the minted set id.
// Order is per (session, exercise) — the only order the server keeps, numbering sets max+1 per lane.
// A set that cannot land holds up its own lane and nothing else.
//
// A set that never landed is refused once the session is finished, so the queue must flush BEFORE a
// finish, before the boot read and before the claim's starts.
// `deviceOwner` is the account this device holds a session for at open time.
class SetQueue private constructor(
    private val file: File,
    deviceOwner: String?,
    private val write: (File, String) -> Unit,
    private val telemetry: Telemetry,
) {
    constructor(file: File, deviceOwner: String? = null, telemetry: Telemetry = Telemetry.None) :
        this(file, deviceOwner, AtomicDocument::write, telemetry)

    internal constructor(file: File, deviceOwner: String? = null, write: (File, String) -> Unit) :
        this(file, deviceOwner, write, Telemetry.None)

    // The key the server numbers sets under.
    data class Lane(val sessionId: String, val exerciseId: String)

    @Serializable
    data class Entry(
        val set: TrainingSet,
        val sessionId: String,
        val needsPush: Boolean,
        val remints: Int,
        // Defaulted — the decoder tolerates a missing key only where there is a default.
        val loggedAtMs: Long? = null,
        val event: WorkoutEvent? = null,
        val eventOrder: Long = 0,
        // An append of this row went out and the log has not answered it, so the row may be on the
        // log: a lost reply looks exactly like a send that never arrived. Marked on disk before the
        // send, cleared only by the log's answer, and carried through every change filed meanwhile.
        val attempted: Boolean = false,
        // In an older file every owed row is an append.
        val write: Owed = Owed.Append,
    ) {
        val lane: Lane get() = Lane(sessionId, set.exerciseId)

        val owes: Owed? get() = if (needsPush) write else null

        // What goes on the wire next. A change filed over an unanswered append waits behind it: the
        // append goes again first — a replay answers the stored row — so the change meets a row the
        // log holds.
        val step: Owed get() = if (attempted) Owed.Append else write

        // Owed as an append that never went out: the one row this device may rewrite or let go of
        // alone.
        val unsent: Boolean get() = owes == Owed.Append && !attempted

        // Whether a reply to `sent` may settle this entry: never once its body changed after it left.
        fun readsAs(sent: Entry): Boolean = needsPush && set == sent.set && write == sent.write
    }

    companion object {
        // Id collisions one set may survive before the refusal is said out loud.
        const val maxRemints = 3

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
        val chosenMovement: String? = null,
        // True for a session composed on this device with no server answer; the claim's landed start
        // turns it false. Absent reads as unclaimed, costing at most one start replay.
        val unclaimed: Boolean? = null,
        val workout: WorkoutState? = null,
    ) {
        val isEmpty: Boolean get() = session == null && entries.isEmpty()

        fun matchesClaim(value: Queued): Boolean {
            if (copy(workout = null) != value.copy(workout = null)) return false
            if (value.workout == null) return workout?.rack?.edited != true
            fun content(state: WorkoutState?): WorkoutState? = state?.copy(revision = 0,
                rack = state.rack?.copy(revision = 0), offer = null)
            return content(workout) == content(value.workout)
        }
    }

    @Serializable
    private data class Held(val queues: Map<String, Queued> = emptyMap(), val claims: Map<String, String> = emptyMap())

    private val storage = StoredDocument(file, telemetry)
    private var transferFailed = false
    private var seat: String = Seat.of(deviceOwner)
    private var migrated = false
    var unreadable: Boolean = false
        private set
    private var held: Held = open(deviceOwner)
    private var saved: Held? = null

    init {
        if (migrated) flush()
    }

    // An unnamed queue is seated to the device's account, or quarantined when it holds no session;
    // quarantine is reachable by no seat and adopted by no arriving account.
    private fun open(deviceOwner: String?): Held {
        val document = storage.tree() ?: run {
            if (file.exists()) unreadable = true
            return Held()
        }
        val before = queued(document)
        if (!before.isEmpty) {
            migrated = true
            return Held(mapOf((if (deviceOwner == null) Seat.quarantine else seat) to before))
        }
        if (document["queues"] != null && document["queues"] !is JsonObject) unreadable = true
        val queues = document["queues"] as? JsonObject ?: JsonObject(emptyMap())
        return Held(queues.mapValues { queued(it.value) },
            document["claims"]?.let {
                try { diskJson.decodeFromJsonElement(MapSerializer(String.serializer(), String.serializer()), it) }
                catch (error: Exception) { telemetry.failure("gym.storage.decode", error); unreadable = true; emptyMap() }
            }.orEmpty())
    }

    // Item by item: a live session or an owed set this build cannot read is the one thing lost.
    private fun queued(node: JsonElement): Queued {
        val fields = node as? JsonObject ?: run { unreadable = true; return Queued() }
        if (fields["workout"] != null) {
            try {
                val authority = Json { explicitNulls = false }.decodeFromJsonElement(WorkoutState.serializer(), fields.getValue("workout"))
                return diskJson.decodeFromJsonElement(Queued.serializer(), fields).copy(workout = authority)
            } catch (error: Exception) {
                telemetry.failure("gym.storage.decode", error)
                unreadable = true
            }
        }
        return Queued(
            session = storage.one(fields["session"], Session.serializer()),
            entries = storage.keyed(fields["entries"], Entry.serializer()),
            order = storage.each(fields["order"], String.serializer()),
            unclaimed = storage.one(fields["unclaimed"], Boolean.serializer()),
            chosenMovement = storage.one(fields["chosenMovement"], String.serializer()),
            workout = fields["workout"]?.let {
                try { diskJson.decodeFromJsonElement(WorkoutState.serializer(), it) }
                catch (error: Exception) { telemetry.failure("gym.storage.decode", error); unreadable = true; null }
            },
        )
    }

    private val mine: Queued get() = held.queues[seat] ?: Queued()

    private fun keep(next: Queued) {
        commit(held.copy(queues = held.queues + (seat to next)))
    }

    private fun commit(next: Held) {
        check(!transferFailed && !unreadable) { "Restart the app to recover the saved workout." }
        if (next == saved) return
        try {
            write(file, diskJson.encodeToString(Held.serializer(), next))
        } catch (failure: Exception) {
            transferFailed = true
            throw failure
        }
        held = next
        saved = next
    }

    // Selecting a seat never transfers training from another seat.
    fun adopt(owner: String?) {
        val nextSeat = Seat.of(owner)
        if (nextSeat == seat) return
        val queues = held.queues.mapValues { (key, queue) ->
            if (key != seat && key != nextSeat) queue
            else queue.copy(workout = queue.workout?.invalidate())
        }
        if (queues != held.queues) commit(held.copy(queues = queues))
        seat = nextSeat
    }

    fun claimItems(): List<ClaimItem> = ClaimSource.entries.mapNotNull { source ->
        val queue = held.queues[source.seat]?.takeUnless { it.isEmpty } ?: return@mapNotNull null
        claimItem(source, ClaimKind.Queue, queue.session?.id ?: "pending", queue, Queued.serializer(),
            queue.session?.startedAtMs, active = queue.session != null)
    }

    fun preflight(batch: ClaimBatch, owner: String?) { transfer(batch, owner) }

    fun complete(batch: ClaimBatch, owner: String?) {
        val next = transfer(batch, owner)
        if (next == held) return
        commit(next)
    }

    private fun transfer(batch: ClaimBatch, owner: String?): Held {
        check(!transferFailed && !unreadable) { "Restart the app to recover the local-data decision." }
        if (held.claims.completed(batch, owner)) return held
        var queues = held.queues
        for (item in batch.items.filter { it.kind == ClaimKind.Queue }) {
            val value = item.decode(Queued.serializer())
            check(item.id == (value.session?.id ?: "pending"))
            if (owner != null) {
                val target = queues[Seat.of(owner)] ?: Queued()
                check(target.isEmpty || target.matchesClaim(value)) { "Finish the account’s current workout before adding this training." }
                queues = queues + (Seat.of(owner) to value.copy(workout = value.workout?.invalidate()))
            }
            val source = queues[item.source.seat]
            if (source != null && source.matchesClaim(value)) queues = queues - item.source.seat
        }
        return held.copy(queues = queues, claims = held.claims + (batch.id to (owner?.let { "owner:$it" } ?: "discard")))
    }

    // Names no movement and no numbers: whoever reads this may not be who lifted them.
    val unattributedSession: Session? get() = held.queues[Seat.quarantine]?.session

    // There can be owed sets and no live session.
    val hasUnattributed: Boolean get() = Seat.quarantine in held.queues

    val order: List<String> get() = mine.order ?: emptyList()

    val chosenMovement: String? get() = mine.chosenMovement?.takeIf { it in order }
    val ownerKey: String get() = seat
    val workout: WorkoutState get() = mine.workout ?: WorkoutState()
    val writable: Boolean get() = !transferFailed && !unreadable

    fun latestSet(moment: WorkoutMoment): WorkoutEvent? {
        val live = mine.session ?: return null
        val entry = mine.entries.values.filter { it.sessionId == live.id && it.owes != Owed.Delete }
            .maxWithOrNull(compareBy<Entry> { it.eventOrder }
                .thenBy { it.event?.origin?.bootId == moment.bootId }
                .thenBy { if (it.event?.origin?.bootId == moment.bootId) it.event.origin.elapsedMs else it.loggedAtMs ?: it.set.completedAtMs })
            ?: return null
        return entry.event ?: WorkoutEvent(entry.set.id, WorkoutMoment(entry.loggedAtMs ?: entry.set.completedAtMs, 0, "legacy"))
    }

    fun control(next: WorkoutState) {
        keep(mine.copy(workout = next))
    }

    fun prepare(lastTime: LastTime?, moment: WorkoutMoment,
        ready: Boolean, mint: () -> String): WorkoutState {
        val live = mine.session ?: return workout
        val entries = mine.entries.mapValues { (_, entry) ->
            if (entry.sessionId != live.id) entry else {
                val oldOrigin = entry.event?.origin ?: WorkoutMoment(entry.loggedAtMs ?: entry.set.completedAtMs, 0, "legacy")
                entry.copy(event = WorkoutEvent(entry.event?.id ?: entry.set.id, oldOrigin.reconciled(moment) ?: oldOrigin))
            }
        }
        val next = prepared(mine.copy(entries = entries), lastTime, moment, ready, mint)
        keep(next)
        return requireNotNull(next.workout)
    }

    private fun prepared(queue: Queued, lastTime: LastTime?,
        moment: WorkoutMoment, ready: Boolean, mint: () -> String): Queued {
        val live = queue.session ?: return queue
        val movement = queue.chosenMovement
        val plan = movement?.let { live.plan?.entry(it) }
        val current = queue.entries.values.filter { it.sessionId == live.id && it.owes != Owed.Delete }
        val previous = queue.workout ?: WorkoutState()
        val started = (previous.started ?: WorkoutMoment(live.startedAtMs, 0, "legacy")).reconciled(moment)
        var state = previous.copy(started = started).reconcile(moment)
        if (movement == null) return queue.copy(workout = state.offered(WorkoutKey(seat, live.id), 0, false, ""))
        val today = current.map { it.set }.filter { it.exerciseId == movement }.sortedBy { it.completedAtMs }
        val savedRack = state.rack
        val unresolvedPrefill = lastTime == null && today.isEmpty() && plan?.sets.isNullOrEmpty()
        if (!unresolvedPrefill || savedRack?.exerciseId != movement || savedRack.basisSetCount != today.size) {
            state = state.redial(movement, today.size, Prefill.of(today, plan, lastTime))
        }
        val ordinal = LiveLines.workingCount(today) + 1
        state = state.offered(WorkoutKey(seat, live.id), ordinal, ready, state.offer?.id ?: if (ready && !state.editorOpen) mint() else "")
        return queue.copy(workout = state)
    }

    fun accept(command: LogSetCommand, moment: WorkoutMoment, lastTime: LastTime?,
        mint: () -> String): LogSetAcceptance {
        val live = mine.session ?: return LogSetAcceptance.Stale
        if (command.key != WorkoutKey(seat, live.id) || !workout.accepts(command)) return LogSetAcceptance.Stale
        val offer = requireNotNull(workout.offer)
        if (offer.exerciseId != chosenMovement || offer.workingOrdinal != LiveLines.workingCount(sets, chosenMovement) + 1) {
            return LogSetAcceptance.Stale
        }
        val set = TrainingSet(offer.id, offer.exerciseId, weightKg = offer.weightKg, reps = offer.reps,
            completedAtMs = moment.wallMs)
        val entry = Entry(set, live.id, needsPush = true, remints = 0, loggedAtMs = moment.wallMs,
            event = WorkoutEvent(offer.id, moment), eventOrder = workout.revision + 1)
        val next = prepared(mine.copy(entries = mine.entries + (set.id to entry), workout = workout.consume(command)),
            lastTime, moment, true, mint)
        keep(next)
        return LogSetAcceptance.Accepted(set.id)
    }

    fun choose(exerciseId: String) {
        keep(mine.copy(order = if (exerciseId in order) order else order + exerciseId,
            chosenMovement = exerciseId,
            workout = if (mine.chosenMovement == exerciseId) mine.workout else mine.workout?.invalidate()))
    }

    fun append(exerciseId: String) {
        if (exerciseId in order) return
        keep(mine.copy(order = order + exerciseId))
    }

    fun hold(order: List<String>) {
        keep(mine.copy(order = order, chosenMovement = mine.chosenMovement?.takeIf { it in order }))
    }

    val session: Session? get() = mine.session

    // Nothing walks its sets while this holds, and no read may trade it for the account's other open
    // workout.
    val sessionIsUnclaimed: Boolean get() = mine.session != null && (mine.unclaimed ?: true)

    // A different session id clears the movement order rather than merging it.
    // `unclaimed` defaults to false: only the on-device start passes true.
    fun hold(session: Session?, unclaimed: Boolean = false) {
        val kept = if (mine.session?.id == session?.id) mine.order else null
        keep(mine.copy(session = session, order = kept, chosenMovement = mine.chosenMovement.takeIf { mine.session?.id == session?.id },
            unclaimed = if (session == null) null else unclaimed,
            workout = mine.workout.takeIf { mine.session?.id == session?.id }))
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

    // A deleted row leaves here at once; its entry survives only to carry the DELETE.
    fun sets(sessionId: String): List<TrainingSet> = mine.entries.values
        .filter { it.sessionId == sessionId && it.owes != Owed.Delete }
        .map { it.set }
        .sortedBy { it.completedAtMs }

    // Oldest first: sorting by the instant performed makes the per-lane walk the server's own order.
    val pending: List<Entry>
        get() = mine.entries.values
            .filter { it.needsPush }
            .sortedBy { it.set.completedAtMs }

    fun owed(sessionId: String): List<Entry> = pending.filter { it.sessionId == sessionId }

    fun nextOwed(skipping: Set<Lane>): Entry? = pending.firstOrNull { it.lane !in skipping }

    fun isUnsent(id: String): Boolean = mine.entries[id]?.unsent ?: false

    // Both directions: a set just logged (owed), and a row the log handed back (not owed), which
    // settles an owed append. A change still owed stands, since the row handed back is the one it
    // corrects.
    fun store(set: TrainingSet, sessionId: String, needsPush: Boolean, moment: WorkoutMoment? = null) {
        val existing = mine.entries[set.id]
        if (!needsPush && existing?.owes.let { it == Owed.Fix || it == Owed.Delete }) return
        val loggedAt = existing?.loggedAtMs ?: if (needsPush && existing == null) set.completedAtMs else null
        keep(mine.copy(entries = mine.entries + (set.id to Entry(set, sessionId, needsPush,
            existing?.remints ?: 0, loggedAt, existing?.event ?: moment?.let { WorkoutEvent(set.id, it) },
            existing?.eventOrder ?: if (moment != null) workout.revision + 1 else 0,
            attempted = needsPush && existing?.attempted == true)),
            workout = if (existing?.set == set) mine.workout else mine.workout?.invalidate()))
    }

    // Only for an append never sent: a correction filed over it would replace the set's only copy.
    fun rewrite(corrected: TrainingSet) {
        val entry = mine.entries[corrected.id]?.takeIf { it.unsent } ?: return
        keep(mine.copy(entries = mine.entries + (corrected.id to entry.copy(set = corrected)),
            workout = if (entry.set == corrected) mine.workout else mine.workout?.invalidate()))
    }

    // The set as it should now read; the PATCH goes under the same id, behind an append still
    // unanswered.
    fun fix(corrected: TrainingSet) {
        val entry = mine.entries[corrected.id] ?: return
        keep(mine.copy(entries = mine.entries + (corrected.id to
            entry.copy(set = corrected, needsPush = true, write = Owed.Fix)),
            workout = if (entry.set == corrected) mine.workout else mine.workout?.invalidate()))
    }

    // The row leaves `sets` at once and the DELETE goes behind an append still unanswered: no route
    // un-deletes a set. Answers whether there was a row to take back.
    fun delete(id: String): Boolean {
        val entry = mine.entries[id] ?: return false
        keep(mine.copy(entries = mine.entries + (id to entry.copy(needsPush = true, write = Owed.Delete)),
            workout = mine.workout?.invalidate()))
        return true
    }

    // The entry as it goes on the wire. An append is marked on disk before it leaves, so neither a
    // lost answer nor a dead app lets this device treat a row the log may hold as its own.
    fun sending(owed: Entry): Entry {
        val entry = mine.entries[owed.set.id] ?: owed
        if (entry.step != Owed.Append || entry.attempted) return entry
        val marked = entry.copy(attempted = true)
        keep(mine.copy(entries = mine.entries + (entry.set.id to marked)))
        return marked
    }

    // The log's answer to an append. A change filed while it was on the wire stays owed, now aimed at
    // the row the log is known to hold, under the id and number the log answered with; only an
    // append nobody touched is settled by the reply. Answers the set as it is now drawn, or null when
    // the entry had already gone.
    fun appended(stored: TrainingSet, sent: Entry): TrainingSet? {
        val current = mine.entries[sent.set.id] ?: return null
        if (current.readsAs(sent) && sent.write == Owed.Append) {
            settle(stored, current)
            return stored
        }
        val aimed = current.copy(set = current.set.copy(id = stored.id, setNumber = stored.setNumber),
            attempted = false)
        keep(mine.copy(entries = mine.entries - sent.set.id + (stored.id to aimed),
            workout = if (stored.id == sent.set.id) mine.workout else mine.workout?.invalidate()))
        return aimed.set
    }

    // A correction filed again while this one was on the wire is the newer word, and stays owed.
    fun fixed(stored: TrainingSet, sent: Entry): Boolean {
        val current = mine.entries[sent.set.id]?.takeIf { it.readsAs(sent) } ?: return false
        settle(stored, current)
        return true
    }

    // A correction the log refused for good owes nothing more; the row stays as the device drew it
    // until a read of the log hands back the log's own numbers. Not while something newer was filed.
    fun withdraw(sent: Entry): Boolean = fixed(sent.set, sent)

    // The log took the delete, so the entry leaves, unless something newer was filed over it while
    // it was on the wire.
    fun letGo(sent: Entry): Boolean {
        if (mine.entries[sent.set.id]?.readsAs(sent) != true) return false
        drop(sent.set.id)
        return true
    }

    // Clear the sent key as well as the stored one, or a reply that disagreed leaves an entry owed
    // forever. Settled rows are kept for the live session alone: `close` and `forget` reach no other.
    private fun settle(stored: TrainingSet, sent: Entry) {
        val entries = mine.entries - sent.set.id
        val kept = if (mine.session?.id != sent.sessionId) entries else entries +
            (stored.id to Entry(stored, sent.sessionId, needsPush = false, remints = 0,
                loggedAtMs = sent.loggedAtMs, event = sent.event, eventOrder = sent.eventOrder))
        keep(mine.copy(entries = kept,
            workout = if (stored.id == sent.set.id) mine.workout else mine.workout?.invalidate()))
    }

    // The same set under a new key, owed as the append it never became, with the remint budget
    // counted down. A set taken back needs no new key: it never landed, and nobody wants it now.
    fun remint(id: String, fresh: String) {
        val entry = mine.entries[id] ?: return
        if (entry.write == Owed.Delete) {
            drop(id)
            return
        }
        keep(mine.copy(entries = mine.entries - id +
            (fresh to Entry(entry.set.copy(id = fresh), entry.sessionId, needsPush = true,
                remints = entry.remints + 1, loggedAtMs = entry.loggedAtMs, event = entry.event, eventOrder = entry.eventOrder)),
            workout = mine.workout?.invalidate()))
    }

    fun drop(id: String) {
        keep(mine.copy(entries = mine.entries - id, workout = mine.workout?.invalidate()))
    }

    // Set ids do not move: each is its own key with its own remint budget.
    fun remapSession(old: String, fresh: String) {
        val entries = mine.entries.mapValues { (_, entry) ->
            if (entry.sessionId == old) entry.copy(sessionId = fresh) else entry
        }
        val session = mine.session?.let { if (it.id == old) it.copy(id = fresh) else it }
        keep(mine.copy(session = session, entries = entries, workout = mine.workout?.invalidate()))
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
        keep(mine.copy(session = session, entries = entries, order = order,
            chosenMovement = if (mine.chosenMovement == old) fresh else mine.chosenMovement,
            workout = mine.workout?.invalidate()))
    }

    // Delivered sets are released; an owed set stays queued until the log answers for it.
    fun close(sessionId: String) {
        val next = mine.copy(entries = mine.entries.filterValues { it.sessionId != sessionId || it.needsPush })
        keep(if (mine.session?.id == sessionId) next.copy(session = null, order = null, chosenMovement = null, unclaimed = null, workout = null) else next)
    }

    // A session that no longer exists: the one case where an owed set is dropped.
    fun forget(sessionId: String) {
        val next = mine.copy(entries = mine.entries.filterValues { it.sessionId != sessionId })
        keep(if (mine.session?.id == sessionId) next.copy(session = null, order = null, chosenMovement = null, unclaimed = null, workout = null) else next)
    }

    fun flush() {
        commit(held)
    }
}

// The write an owed entry carries to the log.
@Serializable
enum class Owed {
    Append,     // the log has never seen this row
    Fix,        // the log holds this row, and this device holds numbers it does not
    Delete,     // the log holds this row, and this device has taken it back
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
            // The log's own sentence reaches the lifter as sent: a superseded proposal has three
            // reasons and only the server knows which. Local words stand in for a sentence-less reply.
            if (facts.code == "proposal-superseded") {
                return Superseded(facts.sentence ?: "the routine moved after this was written — nothing was applied")
            }
            if (facts.code == "proposal-settled") {
                return Settled(facts.sentence ?: "that proposal was already decided")
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
    data class Capped(val said: String, val cap: AskCap) : AskVerdict() // 429 — the composer comes down: the daily bucket, or the account's 30-day ceiling
    data class Again(val said: String) : AskVerdict()  // 5xx, no reply at all — the one worth offering a retry on
    data class Fresh(val said: String) : AskVerdict()  // 409 — this conversation cannot take the question; the next one opens a new thread
    data object Absent : AskVerdict()                  // 404 — this deployment has no Ask

    companion object {
        fun refusing(facts: RefusalFacts): AskVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Again(noAnswer)
            if (status == 404) return Absent
            if (status >= 500) return Again(facts.sentence ?: noAnswer)
            if (facts.code == "ask-daily-limit") {
                return Capped(facts.sentence ?: AskCap.Daily.wordless, AskCap.Daily)
            }
            // The SAME state, because the one unrationed way on — the connect door — is drawn there
            // and is not drawn beside a live composer.
            if (facts.code == "ask-out-of-budget") {
                return Capped(facts.sentence ?: AskCap.Ceiling.wordless, AskCap.Ceiling)
            }
            if (facts.code == "ask-generation-active") return Again(facts.sentence ?: "Coach is answering another message. Try again when it finishes.")
            // Both are answered by opening a new thread; nothing is re-sent on its own.
            if (facts.code == "ask-thread-full" || facts.code == "ask-thread-taken") {
                return Fresh(facts.sentence ?: Ask.threadFull)
            }
            return Said(facts.sentence ?: "Coach couldn’t take that one")
        }

        private const val noAnswer = "Coach didn’t answer. Try again in a moment"
    }
}

// What is said when a write is lost for good.
sealed interface RefusedWrite {
    // The id of the thing that was refused, so a list can key by it: a row keyed by its POSITION
    // hands the next row its predecessor's swipe state, and a dismissed one never comes back.
    val id: String
    val reason: String
}

// The last copy of the set, so the movement and numbers travel with the reason.
data class RefusedSet(
    override val id: String,
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
data class RefusedClaim(override val id: String, val name: String, override val reason: String) : RefusedWrite {
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
