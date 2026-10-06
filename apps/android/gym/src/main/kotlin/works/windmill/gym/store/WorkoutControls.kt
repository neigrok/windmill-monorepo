package works.windmill.gym.store

import java.io.File
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.storage.AtomicDocument
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WorkoutEvent
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.gym.domain.WorkoutState

// The phone's controls over the open workout, projected from the engine replica: the session and its
// sets with the device clock each was logged at, the movement walk, the movement in hand and the
// rack's offer. The engine holds the training; this document holds what only this phone knows, so
// the notification and a cold start can draw the workout before anything else is read.
class WorkoutControls private constructor(
    private val file: File,
    deviceOwner: String?,
    private val write: (File, String) -> Unit,
    private val telemetry: Telemetry,
) {
    constructor(file: File, deviceOwner: String? = null, telemetry: Telemetry = Telemetry.None) :
        this(file, deviceOwner, AtomicDocument::write, telemetry)

    internal constructor(file: File, deviceOwner: String? = null, write: (File, String) -> Unit) :
        this(file, deviceOwner, write, Telemetry.None)

    @Serializable
    data class Entry(
        val set: TrainingSet,
        val sessionId: String,
        val loggedAtMs: Long? = null,
        val event: WorkoutEvent? = null,
        val eventOrder: Long = 0,
    )

    companion object {
        // Resolved by the room edge against context.filesDir; this file touches no android class.
        const val fileName = "windmill-gym-sets.json"
    }

    // The file holds one document per seat; only the seat in hand is reachable.
    @Serializable
    private data class Held(
        val session: Session? = null,
        val entries: Map<String, Entry> = emptyMap(),
        // The movements this session walks, in order. Not derivable from the sets: a movement
        // appended and not yet logged has none.
        val order: List<String>? = null,
        val chosenMovement: String? = null,
        val workout: WorkoutState? = null,
        val engineReplica: String? = null,
    )

    // The file keeps each seat's controls under `queues`.
    @Serializable
    private data class Document(@SerialName("queues") val seats: Map<String, Held> = emptyMap())

    private val storage = StoredDocument(file, telemetry)
    private var writeFailed = false
    private var seat: String = Seat.of(deviceOwner)
    var unreadable: Boolean = false
        private set
    private var held: Document = open()
    private var saved: Document? = null

    private fun open(): Document {
        val document = storage.tree() ?: run {
            if (file.exists()) unreadable = true
            return Document()
        }
        if (document["queues"] != null && document["queues"] !is JsonObject) unreadable = true
        val seats = document["queues"] as? JsonObject ?: JsonObject(emptyMap())
        return Document(seats.mapValues { held(it.value) })
    }

    // Item by item: a set this build cannot read is the one thing lost.
    private fun held(node: JsonElement): Held {
        val fields = node as? JsonObject ?: run { unreadable = true; return Held() }
        if (fields["workout"] != null) {
            try {
                val authority = fields.getValue("workout") as? JsonObject
                    ?: throw SerializationException("Workout controls must be an object")
                val current = JsonObject(authority - setOf("rest", "attemptedRest", "alertAccess", "restAlerts"))
                val workout = Json { explicitNulls = false }.decodeFromJsonElement(WorkoutState.serializer(), current)
                return diskJson.decodeFromJsonElement(Held.serializer(), fields).copy(workout = workout)
            } catch (error: Exception) {
                telemetry.failure("gym.storage.decode", error)
                unreadable = true
            }
        }
        return Held(
            session = storage.one(fields["session"], Session.serializer()),
            entries = storage.keyed(fields["entries"], Entry.serializer()),
            order = storage.each(fields["order"], String.serializer()),
            chosenMovement = storage.one(fields["chosenMovement"], String.serializer()),
            workout = fields["workout"]?.let {
                try { diskJson.decodeFromJsonElement(WorkoutState.serializer(), it) }
                catch (error: Exception) { telemetry.failure("gym.storage.decode", error); unreadable = true; null }
            },
            engineReplica = storage.one(fields["engineReplica"], String.serializer()),
        )
    }

    private val mine: Held get() = held.seats[seat] ?: Held()

    private fun keep(next: Held) {
        commit(held.copy(seats = held.seats + (seat to next)))
    }

    private fun commit(next: Document) {
        check(!writeFailed && !unreadable) { "Restart the app to recover the saved workout." }
        if (next == saved) return
        try {
            write(file, diskJson.encodeToString(Document.serializer(), next))
        } catch (failure: Exception) {
            writeFailed = true
            throw failure
        }
        held = next
        saved = next
    }

    // Selecting a seat never transfers a workout from another seat.
    fun adopt(owner: String?) {
        val nextSeat = Seat.of(owner)
        if (nextSeat == seat) return
        val seats = held.seats.mapValues { (key, controls) ->
            if (key != seat && key != nextSeat) controls
            else controls.copy(workout = controls.workout?.invalidate())
        }
        if (seats != held.seats) commit(held.copy(seats = seats))
        seat = nextSeat
    }

    val order: List<String> get() = mine.order ?: emptyList()
    val chosenMovement: String? get() = mine.chosenMovement?.takeIf { it in order }
    val ownerKey: String get() = seat
    val workout: WorkoutState get() = mine.workout ?: WorkoutState()
    val writable: Boolean get() = !writeFailed && !unreadable
    val engineReplica: String? get() = mine.engineReplica

    fun project(replica: String, session: Session?, sets: List<TrainingSet>) {
        val sameSession = mine.session?.id == session?.id
        val entries = if (session == null) emptyMap() else sets.associate { set ->
            val previous = mine.entries[set.id]
            set.id to (previous?.copy(set = set, sessionId = session.id) ?: Entry(set, session.id))
        }
        keep(mine.copy(session = session, entries = entries,
            order = mine.order.takeIf { sameSession }, chosenMovement = mine.chosenMovement.takeIf { sameSession },
            workout = mine.workout.takeIf { sameSession }?.let { if (mine.engineReplica == replica) it else it.invalidate() },
            engineReplica = replica))
    }

    fun latestSet(moment: WorkoutMoment): WorkoutEvent? {
        val live = mine.session ?: return null
        val entry = mine.entries.values.filter { it.sessionId == live.id }
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

    private fun prepared(controls: Held, lastTime: LastTime?,
        moment: WorkoutMoment, ready: Boolean, mint: () -> String): Held {
        val live = controls.session ?: return controls
        val movement = controls.chosenMovement
        val plan = movement?.let { live.plan?.entry(it) }
        val current = controls.entries.values.filter { it.sessionId == live.id }
        val previous = controls.workout ?: WorkoutState()
        val started = (previous.started ?: WorkoutMoment(live.startedAtMs, 0, "legacy")).reconciled(moment)
        var state = previous.copy(started = started).reconcile(moment)
        if (movement == null) return controls.copy(workout = state.offered(WorkoutKey(seat, live.id), 0, false, ""))
        val today = current.map { it.set }.filter { it.exerciseId == movement }.sortedBy { it.completedAtMs }
        val savedRack = state.rack
        val unresolvedPrefill = lastTime == null && today.isEmpty() && plan?.sets.isNullOrEmpty()
        if (!unresolvedPrefill || savedRack?.exerciseId != movement || savedRack.basisSetCount != today.size) {
            state = state.redial(movement, today.size, Prefill.of(today, plan, lastTime))
        }
        val ordinal = LiveLines.workingCount(today) + 1
        state = state.offered(WorkoutKey(seat, live.id), ordinal, ready, state.offer?.id ?: if (ready && !state.editorOpen) mint() else "")
        return controls.copy(workout = state)
    }

    // The offered set is recorded with the moment it was accepted and the offer is consumed in the
    // same write, so a repeated tap or a redelivered command can never log it twice.
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
        val entry = Entry(set, live.id, loggedAtMs = moment.wallMs,
            event = WorkoutEvent(offer.id, moment), eventOrder = workout.revision + 1)
        val next = prepared(mine.copy(entries = mine.entries + (set.id to entry), workout = workout.consume(command)),
            lastTime, moment, true, mint)
        keep(next)
        return LogSetAcceptance.Accepted(set.id)
    }

    fun entry(id: String): Entry? = mine.entries[id]

    fun choose(exerciseId: String) {
        keep(mine.copy(order = if (exerciseId in order) order else order + exerciseId,
            chosenMovement = exerciseId,
            workout = if (mine.chosenMovement == exerciseId) mine.workout else mine.workout?.invalidate()))
    }

    fun hold(order: List<String>) {
        keep(mine.copy(order = order, chosenMovement = mine.chosenMovement?.takeIf { it in order }))
    }

    val session: Session? get() = mine.session

    // A different session id clears the movement order rather than merging it.
    fun hold(session: Session?) {
        val same = mine.session?.id == session?.id
        keep(mine.copy(session = session, order = mine.order.takeIf { same },
            chosenMovement = mine.chosenMovement.takeIf { same }, workout = mine.workout.takeIf { same }))
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

    // The set as the engine holds it, keeping the moment this phone logged it.
    fun store(set: TrainingSet, sessionId: String, moment: WorkoutMoment? = null) {
        val existing = mine.entries[set.id]
        keep(mine.copy(entries = mine.entries + (set.id to Entry(set, sessionId,
            existing?.loggedAtMs ?: if (existing == null && moment != null) set.completedAtMs else null,
            existing?.event ?: moment?.let { WorkoutEvent(set.id, it) },
            existing?.eventOrder ?: if (moment != null) workout.revision + 1 else 0)),
            workout = if (existing?.set == set) mine.workout else mine.workout?.invalidate()))
    }

    fun drop(id: String) {
        keep(mine.copy(entries = mine.entries - id, workout = mine.workout?.invalidate()))
    }

    fun close(sessionId: String) {
        val next = mine.copy(entries = mine.entries.filterValues { it.sessionId != sessionId })
        keep(if (mine.session?.id == sessionId) next.copy(session = null, order = null, chosenMovement = null, workout = null) else next)
    }

    fun flush() {
        commit(held)
    }
}

// The key every device document files rows under. The account id is IN THE KEY rather than in a
// field a reader filters on, so a document opened for one seat can never resolve another seat's rows.
object Seat {
    const val anonymous = "anon"
    fun of(owner: String?): String = if (owner == null) anonymous else "u.$owner"
}
