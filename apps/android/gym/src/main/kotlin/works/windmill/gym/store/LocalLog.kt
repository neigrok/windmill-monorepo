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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet

// Locally minted movements, local routines and FINISHED local sessions no account has claimed yet;
// the live session is SetQueue's file. A row leaves the shelf only once the server confirms it.
// `deviceOwner` is the account this device holds a session for at open time.
class LocalLog(private val file: File, deviceOwner: String? = null, telemetry: Telemetry = Telemetry.None) {
    @Serializable
    data class FinishedSession(
        val session: Session,
        val sets: List<TrainingSet> = emptyList(),
        // Sets deleted off this row, kept by id: a partly-claimed session already has some of them
        // on the log, so the claim must be told rather than replaying the survivors.
        val deleted: List<String> = emptyList(),
    )

    // The file holds one shelf per seat; only the seat in hand is reachable.
    @Serializable
    private data class Shelf(
        val exercises: List<Exercise>? = null,
        val routines: List<Routine>? = null,
        val finished: List<FinishedSession>? = null,
    ) {
        val isEmpty: Boolean get() =
            exercises.isNullOrEmpty() && routines.isNullOrEmpty() && finished.isNullOrEmpty()
    }

    @Serializable
    private data class Held(val shelves: Map<String, Shelf> = emptyMap(), val claims: Map<String, String> = emptyMap())

    companion object {
        const val fileName = "windmill-gym-local.json"
    }

    internal val claimConsentFile: File get() = File(file.absoluteFile.parentFile, LocalClaimConsent.fileName)

    private val storage = StoredDocument(file, telemetry)
    private var transferFailed = false
    private var seat: String = Seat.of(deviceOwner)
    private var migrated = false
    private var held: Held = open(deviceOwner)

    init {
        if (migrated) flush()
    }

    // An unnamed shelf is seated to the device's account, or quarantined when it holds no session;
    // quarantine is reachable by no seat and adopted by no arriving account.
    private fun open(deviceOwner: String?): Held {
        val document = storage.tree() ?: return Held()
        val before = shelf(document)
        if (!before.isEmpty) {
            migrated = true
            return Held(mapOf((if (deviceOwner == null) Seat.quarantine else seat) to before))
        }
        val shelves = document["shelves"] as? JsonObject ?: JsonObject(emptyMap())
        return Held(shelves.mapValues { shelf(it.value) },
            document["claims"]?.let { diskJson.decodeFromJsonElement(MapSerializer(String.serializer(), String.serializer()), it) }.orEmpty())
    }

    // Row by row: a movement, a routine or a finished session this build cannot read is the one
    // thing lost.
    private fun shelf(node: JsonElement): Shelf {
        val fields = node as? JsonObject ?: return Shelf()
        return Shelf(
            exercises = storage.each(fields["exercises"], Exercise.serializer()),
            routines = storage.each(fields["routines"], Routine.serializer()),
            finished = storage.each(fields["finished"], FinishedSession.serializer()),
        )
    }

    private val mine: Shelf get() = held.shelves[seat] ?: Shelf()

    private fun keep(next: Shelf) {
        check(!transferFailed) { "Restart the app to recover the local-data decision." }
        held = held.copy(shelves = held.shelves + (seat to next))
        flush()
    }

    // Selecting a seat never transfers training from another seat.
    fun adopt(owner: String?) {
        seat = Seat.of(owner)
    }

    fun claimItems(): List<ClaimItem> = ClaimSource.entries.flatMap { source ->
        val shelf = held.shelves[source.seat] ?: return@flatMap emptyList()
        shelf.exercises.orEmpty().map { claimItem(source, ClaimKind.Movement, it.id, it, Exercise.serializer()) } +
            shelf.routines.orEmpty().map { claimItem(source, ClaimKind.Routine, it.id, it, Routine.serializer()) } +
            shelf.finished.orEmpty().map { claimItem(source, ClaimKind.Session, it.session.id, it,
                FinishedSession.serializer(), it.session.startedAtMs) }
    }

    fun preflight(batch: ClaimBatch, owner: String?) { transfer(batch, owner) }

    fun complete(batch: ClaimBatch, owner: String?) {
        val next = transfer(batch, owner)
        if (next == held) return
        try {
            AtomicDocument.write(file, diskJson.encodeToString(Held.serializer(), next))
        } catch (failure: Exception) {
            transferFailed = true
            throw failure
        }
        held = next
    }

    private fun transfer(batch: ClaimBatch, owner: String?): Held {
        check(!transferFailed) { "Restart the app to recover the local-data decision." }
        if (held.claims.completed(batch, owner)) return held
        var shelves = held.shelves
        for (item in batch.items.filter { it.kind in listOf(ClaimKind.Movement, ClaimKind.Routine, ClaimKind.Session) }) {
            val source = shelves[item.source.seat] ?: Shelf()
            val target = shelves[Seat.of(owner)] ?: Shelf()
            when (item.kind) {
                ClaimKind.Movement -> {
                    val value = item.decode(Exercise.serializer())
                    check(value.id == item.id)
                    if (owner != null) {
                        val existing = target.exercises.orEmpty().firstOrNull { it.id == value.id }
                        check(existing == null || existing == value) { "A movement with this identity already belongs to the account." }
                        shelves = shelves + (Seat.of(owner) to target.copy(exercises = target.exercises.orEmpty().filterNot { it.id == value.id } + value))
                    }
                    shelves = shelves + (item.source.seat to source.copy(exercises = source.exercises.orEmpty().filterNot {
                        it == value
                    }))
                }
                ClaimKind.Routine -> {
                    val value = item.decode(Routine.serializer())
                    check(value.id == item.id)
                    if (owner != null) {
                        val existing = target.routines.orEmpty().firstOrNull { it.id == value.id }
                        check(existing == null || existing == value) { "A routine with this identity already belongs to the account." }
                        shelves = shelves + (Seat.of(owner) to target.copy(routines = target.routines.orEmpty().filterNot { it.id == value.id } + value))
                    }
                    shelves = shelves + (item.source.seat to source.copy(routines = source.routines.orEmpty().filterNot {
                        it == value
                    }))
                }
                ClaimKind.Session -> {
                    val value = item.decode(FinishedSession.serializer())
                    check(value.session.id == item.id)
                    if (owner != null) {
                        val existing = target.finished.orEmpty().firstOrNull { it.session.id == value.session.id }
                        check(existing == null || existing == value) { "A workout with this identity already belongs to the account." }
                        shelves = shelves + (Seat.of(owner) to target.copy(finished = target.finished.orEmpty().filterNot { it.session.id == value.session.id } + value))
                    }
                    shelves = shelves + (item.source.seat to source.copy(finished = source.finished.orEmpty().filterNot {
                        it == value
                    }))
                }
                else -> error("Unsupported local log item.")
            }
        }
        return held.copy(shelves = shelves.filterValues { !it.isEmpty }, claims = held.claims + (batch.id to (owner?.let { "owner:$it" } ?: "discard")))
    }

    // Counts and days only: whoever reads this may not be who trained it.
    data class Unattributed(
        val sessions: Int,
        val routines: Int,
        val movements: Int,
        val days: List<Long>,
    )

    val unattributed: Unattributed?
        get() {
            val quarantined = held.shelves[Seat.quarantine] ?: return null
            return Unattributed(
                sessions = quarantined.finished.orEmpty().size,
                routines = quarantined.routines.orEmpty().size,
                movements = quarantined.exercises.orEmpty().size,
                days = quarantined.finished.orEmpty().map { it.session.startedAtMs }.sortedDescending(),
            )
        }

    val exercises: List<Exercise> get() = mine.exercises ?: emptyList()
    val finished: List<FinishedSession> get() = mine.finished ?: emptyList()

    // Last-trained is derived, never stored: max(startedAtMs) over the sessions run under it.
    val routines: List<Routine> get() = stored.map { routine ->
        routine.copy(lastTrainedAtMs = finished
            .filter { it.session.routineId == routine.id }
            .maxOfOrNull { it.session.startedAtMs })
    }

    private val stored: List<Routine> get() = mine.routines ?: emptyList()

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    fun row(sessionId: String): FinishedSession? = finished.firstOrNull { it.session.id == sessionId }

    fun detail(sessionId: String): SessionDetail? = row(sessionId)
        ?.let { SessionDetail(it.session, it.sets) }

    fun details(): List<SessionDetail> = finished.map { SessionDetail(it.session, it.sets) }

    fun summaries(): List<SessionSummary> = finished
        .sortedByDescending { it.session.startedAtMs }
        .map { SessionSummary(it.session, it.sets) }

    fun hold(exercise: Exercise) {
        keep(mine.copy(exercises = exercises + exercise))
    }

    // Renames only a movement this device minted; null when the shelf does not hold it.
    fun renameExercise(id: String, name: String): Exercise? {
        val standing = exercises.firstOrNull { it.id == id } ?: return null
        val renamed = standing.copy(name = name)
        keep(mine.copy(exercises = exercises.map { if (it.id == id) renamed else it }))
        return renamed
    }

    fun claimExercise(id: String) {
        keep(mine.copy(exercises = exercises.filterNot { it.id == id }))
    }

    // A spent movement id must change everywhere this shelf wrote it: the movement, routine lines,
    // frozen plans and every set.
    fun remintExercise(old: String, fresh: String) {
        keep(mine.copy(
            exercises = exercises.map { if (it.id == old) it.copy(id = fresh) else it },
            routines = stored.map { routine ->
                routine.copy(entries = routine.entries.map {
                    if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
                })
            },
            finished = finished.map { past ->
                past.copy(
                    session = remapPlan(past.session, old, fresh),
                    sets = past.sets.map { if (it.exerciseId == old) it.copy(exerciseId = fresh) else it },
                )
            },
        ))
    }

    // Add or replace by id; the last-trained instant is stripped on the way in.
    fun hold(routine: Routine) {
        keep(mine.copy(routines = stored.filterNot { it.id == routine.id } +
            routine.copy(lastTrainedAtMs = null)))
    }

    fun claimRoutine(id: String) {
        keep(mine.copy(routines = stored.filterNot { it.id == id }))
    }

    fun remintRoutine(old: String, fresh: String) {
        keep(mine.copy(
            routines = stored.map { if (it.id == old) it.copy(id = fresh) else it },
            finished = finished.map { past ->
                if (past.session.routineId != old) past
                else past.copy(session = past.session.copy(routineId = fresh))
            },
        ))
    }

    // Replace by session id, merging sets by id: never a second row, never at the cost of a set from
    // either copy.
    fun hold(finished: FinishedSession) {
        val standing = row(finished.session.id)
        // Tombstones survive every re-hold and filter the merge, or the queue's copy of the same
        // workout resurrects a deleted set.
        val gone = ((standing?.deleted ?: emptyList()) + finished.deleted).distinct()
        val sets = (finished.sets + (standing?.sets ?: emptyList())
            .filter { old -> finished.sets.none { it.id == old.id } })
            .filterNot { it.id in gone }
        keep(mine.copy(finished = this.finished.filterNot { it.session.id == finished.session.id } +
            FinishedSession(finished.session, sets, gone)))
    }

    // Never touches the wire: it rewrites what the claim will send. Null where the shelf holds no
    // such set.
    fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet? {
        val standing = row(sessionId)?.sets?.firstOrNull { it.id == setId } ?: return null
        if (!fix.moves(standing)) return standing
        val corrected = fix.corrected(standing)
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.map { if (it.id == setId) corrected else it })
        }))
        return corrected
    }

    fun acceptSession(oldId: String, stored: Session) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != oldId) past
            else past.copy(session = stored.copy(finishedAtMs = past.session.finishedAtMs,
                plan = stored.plan ?: past.session.plan))
        }))
    }

    fun acceptSet(sessionId: String, sent: TrainingSet, stored: TrainingSet) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(
                sets = past.sets.map { current ->
                    if (current.id != sent.id) current
                    else current.copy(id = stored.id, setNumber = stored.setNumber, completedAtMs = stored.completedAtMs)
                },
                deleted = past.deleted.map { if (it == sent.id) stored.id else it },
            )
        }))
    }

    // The set leaves the row and is remembered as gone: part of this session may already be on the
    // account.
    fun deleteSet(sessionId: String, setId: String): Boolean {
        val standing = row(sessionId) ?: return false
        if (standing.sets.none { it.id == setId }) return false
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.filterNot { it.id == setId },
                           deleted = past.deleted + setId)
        }))
        return true
    }

    fun forget(sessionId: String) {
        keep(mine.copy(finished = finished.filterNot { it.session.id == sessionId }))
    }

    // The document leaves the shelf; sessions that named it keep their frozen plan and drop only the
    // id, so they replay ad-hoc.
    fun orphanRoutine(id: String) {
        keep(mine.copy(
            routines = stored.filterNot { it.id == id },
            finished = finished.map { past ->
                if (past.session.routineId != id) past
                else past.copy(session = past.session.copy(routineId = null))
            },
        ))
    }

    fun remintSession(old: String, fresh: String) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != old) past
            else past.copy(session = past.session.copy(id = fresh))
        }))
    }

    fun remintSet(sessionId: String, old: String, fresh: String) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.map { if (it.id == old) it.copy(id = fresh) else it },
                deleted = past.deleted.map { if (it == old) fresh else it })
        }))
    }

    // No tombstone: the log never took this set.
    fun dropSet(sessionId: String, setId: String) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.filterNot { it.id == setId })
        }))
    }

    private fun remapPlan(session: Session, old: String, fresh: String): Session {
        val plan = session.plan ?: return session
        return session.copy(plan = plan.copy(entries = plan.entries.map {
            if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
        }))
    }

    private fun flush() {
        storage.write(held, Held.serializer())
    }
}
