package works.windmill.gym.domain

import java.security.SecureRandom
import kotlin.math.floor
import kotlin.math.max
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Wire conventions: instants are epoch-ms Longs, weights are signed kg (negative = band-assisted),
// ids are client-minted, absent optionals are omitted rather than null, reads default rather than throw.

@Serializable(with = SetKindSerializer::class)
enum class SetKind(val wire: String) {
    Warmup("warmup"), Working("working"), Drop("drop"), Failure("failure");

    companion object {
        fun parse(raw: String?): SetKind = entries.firstOrNull { it.wire == raw } ?: Working
    }
}

object SetKindSerializer : KSerializer<SetKind> {
    override val descriptor = PrimitiveSerialDescriptor("SetKind", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: SetKind) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): SetKind = SetKind.parse(decoder.decodeString())
}

// `aliases` is what this account called this movement before, newest first, at most five.
@Serializable
data class Exercise(
    val id: String,
    val name: String,
    val pattern: String = "isolation",
    val equipment: String = "barbell",
    val stepKg: Double? = null,
    val custom: Boolean = false,
    val aliases: List<String> = emptyList(),
) {
    companion object {
        val loadings = listOf("barbell", "dumbbell", "machine", "bodyweight")

        // The value for "we did not ask".
        const val unclassified = "isolation"
    }
}

// Ids and names must stay byte-identical to backend/db/schema.sql's seed; signed in, the server wins.
object TheSix {
    val movements = listOf(
        Exercise("back-squat", "Back Squat", "squat", "barbell", 2.5),
        Exercise("bench-press", "Bench Press", "press", "barbell", 2.5),
        Exercise("deadlift", "Deadlift", "hinge", "barbell", 2.5),
        Exercise("overhead-press", "Overhead Press", "press", "barbell", 2.5),
        Exercise("barbell-row", "Barbell Row", "pull", "barbell", 2.5),
        Exercise("chin-up", "Chin Up", "pull", "bodyweight", 2.5),
    )

    fun missingFrom(catalog: List<Exercise>): List<Exercise> =
        movements.filter { six -> catalog.none { it.id == six.id } }
}

// No `sets` is the open line, frozen as the absence itself and never as a zero.
@Serializable
data class PlanEntry(
    val exerciseId: String,
    val sets: Int? = null,
    val reps: Int? = null,
    val weightKg: Double? = null,
    val restSeconds: Int? = null,
)

@Serializable
data class PlanSnapshot(val routine: String, val entries: List<PlanEntry> = emptyList()) {
    constructor(routine: Routine) : this(
        routine = routine.name,
        entries = routine.entries.sortedBy { it.position }.map {
            PlanEntry(exerciseId = it.exerciseId, sets = it.targetSets, reps = it.targetReps,
                weightKg = it.targetWeightKg, restSeconds = it.restSeconds)
        },
    )

    fun entry(exerciseId: String): PlanEntry? = entries.firstOrNull { it.exerciseId == exerciseId }
}

@Serializable
data class Session(
    val id: String,
    @SerialName("startedAt") val startedAtMs: Long,
    @SerialName("finishedAt") val finishedAtMs: Long? = null,
    val routineId: String? = null,
    val plan: PlanSnapshot? = null,
) {
    val isOpen: Boolean get() = finishedAtMs == null
}

@Serializable
data class TrainingSet(
    val id: String,
    val exerciseId: String,
    val setNumber: Int? = null,
    val weightKg: Double,
    val reps: Int,
    val kind: SetKind = SetKind.Working,
    val rpe: Double? = null,
    val note: String = "",
    @SerialName("completedAt") val completedAtMs: Long,
)

@Serializable
data class SessionDetail(val session: Session, val sets: List<TrainingSet> = emptyList())

@Serializable
data class TopSet(val weightKg: Double, val reps: Int)

// Session fields arrive FLAT. `setCount` is every set of every kind; `workingSetCount` is drawn.
@Serializable
data class SessionSummary(
    val id: String,
    @SerialName("startedAt") val startedAtMs: Long,
    @SerialName("finishedAt") val finishedAtMs: Long? = null,
    val routineId: String? = null,
    val plan: PlanSnapshot? = null,
    val setCount: Int = 0,
    // Absent rather than zero: a defaulted 0 would print `0 working` over a real session.
    val workingSetCount: Int? = null,
    val tonnageKg: Double? = null,
    val exercises: List<String> = emptyList(),
    val topSet: TopSet? = null,
    val topE1rm: Double? = null,
    // Defaults FALSE and never null: the dot is an assertion and its absence is an omission.
    val record: Boolean = false,
    val closedItself: Boolean = false,
) {
    constructor(session: Session, sets: List<TrainingSet>) : this(
        id = session.id,
        startedAtMs = session.startedAtMs,
        finishedAtMs = session.finishedAtMs,
        routineId = session.routineId,
        plan = session.plan,
        setCount = sets.size,
        workingSetCount = sets.count { it.kind == SetKind.Working },
        // Clamped the server's way: an assisted set adds zero rather than subtracting.
        tonnageKg = sets.filter { it.kind == SetKind.Working }
            .sumOf { max(0.0, it.weightKg) * it.reps },
        exercises = sets.sortedBy { it.completedAtMs }.map { it.exerciseId }.distinct(),
        topSet = sets.filter { it.kind == SetKind.Working }
            .maxWithOrNull(compareBy({ it.weightKg }, { it.reps }))
            ?.let { TopSet(it.weightKg, it.reps) },
        topE1rm = null,
        record = false,
        closedItself = false,
    )

    val session: Session get() = Session(id, startedAtMs, finishedAtMs, routineId, plan)
}

@Serializable
data class LastTime(
    val exerciseId: String,
    val session: Session? = null,
    val routine: String? = null,
    val sets: List<TrainingSet> = emptyList(),
) {
    val isFirstTime: Boolean get() = session == null

    companion object {
        // The server's rule: the most recent FINISHED session holding a non-warmup set, its sets in
        // performed order — the predicate is `kind <> 'warmup'`, not working-only.
        fun of(exerciseId: String, history: List<SessionDetail>): LastTime {
            val last = history
                .filter { it.session.finishedAtMs != null }
                .sortedByDescending { it.session.startedAtMs }
                .firstOrNull { detail ->
                    detail.sets.any { it.exerciseId == exerciseId && it.kind != SetKind.Warmup }
                }
                ?: return LastTime(exerciseId)
            return LastTime(
                exerciseId = exerciseId,
                session = last.session,
                routine = last.session.plan?.routine,
                sets = last.sets
                    .filter { it.exerciseId == exerciseId && it.kind != SetKind.Warmup }
                    .sortedBy { it.completedAtMs },
            )
        }
    }
}

// SPARSE: an absent movement is `never logged`. The row is the LAST set of that movement's last-time
// block, and `at` is that SESSION's start.
@Serializable
data class LastSet(
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    @SerialName("at") val atMs: Long,
) {
    companion object {
        fun of(history: List<SessionDetail>): List<LastSet> {
            val closed = history
                .filter { it.session.finishedAtMs != null }
                .sortedByDescending { it.session.startedAtMs }
            val trained = closed
                .flatMap { it.sets }
                .filter { it.kind != SetKind.Warmup }
                .map { it.exerciseId }
                .distinct()
            return trained.mapNotNull { movement ->
                val block = closed.firstOrNull { detail ->
                    detail.sets.any { it.exerciseId == movement && it.kind != SetKind.Warmup }
                } ?: return@mapNotNull null
                val last = block.sets
                    .filter { it.exerciseId == movement && it.kind != SetKind.Warmup }
                    .maxByOrNull { it.completedAtMs } ?: return@mapNotNull null
                LastSet(movement, last.weightKg, last.reps, block.session.startedAtMs)
            }.sortedBy { it.exerciseId }
        }
    }
}

// No `targetSets` is the open row and the ABSENCE is the state; an open row carries no reps and no
// weight either, since the log refuses a half-open line.
@Serializable
data class RoutineEntry(
    val position: Int = 0,
    val exerciseId: String,
    val targetSets: Int? = null,
    val targetReps: Int? = null,
    val targetWeightKg: Double? = null,
    val restSeconds: Int? = null,
)

// `revision` is READ-ONLY on the wire; a PUT bumps it and supersedes every pending proposal.
@Serializable
data class Routine(
    val id: String,
    val name: String,
    val position: Int = 0,
    @SerialName("lastTrainedAt") val lastTrainedAtMs: Long? = null,
    val entries: List<RoutineEntry> = emptyList(),
    val revision: Int = 1,
    val pendingProposal: Proposal? = null,
    // `GET /v1/gym/routines/{id}` carries this; the list read does not. Newest first, `created` last.
    val history: List<RoutineEvent> = emptyList(),
) {
    // No `lastTrainedAt` is untested; derived so a discarded session takes it back.
    val untested: Boolean get() = lastTrainedAtMs == null

    constructor(write: RoutineWrite) : this(
        id = write.id,
        name = write.name,
        position = write.position,
        entries = write.entries.mapIndexed { index, entry ->
            RoutineEntry(position = index + 1, exerciseId = entry.exerciseId,
                targetSets = entry.targetSets, targetReps = entry.targetReps,
                targetWeightKg = entry.targetWeightKg, restSeconds = entry.restSeconds)
        },
    )

    // Addressed by POSITION (plan index + 1), never by movement name; a PUT of an unchanged document
    // still supersedes pending proposals.
    fun retargeting(position: Int, exerciseId: String, toWeightKg: Double): Routine? {
        val row = entries.firstOrNull { it.position == position } ?: return null
        if (row.exerciseId != exerciseId) return null
        if (row.targetSets == null) return null
        return copy(entries = entries.map {
            if (it.position == position) it.copy(targetWeightKg = toWeightKg) else it
        })
    }
}

// Newest first, `created` always last. `by` absent is the lifter's own hand; an unknown `kind` draws
// nothing.
@Serializable
data class RoutineEvent(
    val kind: String = "",
    @SerialName("at") val atMs: Long = 0,
    val by: String? = null,
    val movements: Int? = null,
    val proposal: Proposal? = null,
) {
    fun line(nowMs: Long): String? {
        if (kind == "proposal") return proposal?.historyLine(nowMs)
        if (kind != "created") return null
        val said = mutableListOf(Readout.shortDate(atMs, nowMs))
        said += if (by == null) "created by you" else "created by an agent"
        movements?.let { said += if (it == 1) "1 movement" else "$it movements" }
        return said.joinToString(" · ")
    }

    val isPending: Boolean get() = proposal?.isPending == true
}

@Serializable
data class ReviewStats(val durationMs: Long, val workingSets: Int, val topE1rm: Double? = null)

@Serializable
data class PersonalRecord(
    val kind: String,
    val exerciseId: String,
    val value: Double,
    val weightKg: Double,
    val reps: Int,
    val previous: Double? = null,
    @SerialName("previousAt") val previousAtMs: Long? = null,
)

@Serializable
data class Effort(val sets: Int, val reps: Int, val weightKg: Double)

// A routine that decided at the rack sends `"planned": {}`, so every field here must stay optional.
@Serializable
data class Target(val sets: Int? = null, val reps: Int? = null, val weightKg: Double? = null)

@Serializable
data class AgainstMovement(
    val exerciseId: String,
    val now: Effort,
    val before: Effort? = null,
    val planned: Target? = null,
)

@Serializable
data class Against(
    val sessionId: String,
    val routine: String? = null,
    @SerialName("startedAt") val startedAtMs: Long,
    val movements: List<AgainstMovement> = emptyList(),
)

@Serializable
data class Review(
    val stats: ReviewStats,
    val slight: Boolean = false,
    val record: PersonalRecord? = null,
    val against: Against? = null,
) {
    companion object {
        // The server's own slight rule; duration is not in the predicate.
        const val slightWorkingSets = 4

        fun of(detail: SessionDetail): Review {
            val working = detail.sets.count { it.kind == SetKind.Working }
            val until = detail.session.finishedAtMs
                ?: detail.sets.maxOfOrNull { it.completedAtMs }
                ?: detail.session.startedAtMs
            return Review(
                stats = ReviewStats(
                    durationMs = max(0, until - detail.session.startedAtMs),
                    workingSets = working,
                    topE1rm = null,
                ),
                slight = working < slightWorkingSets,
            )
        }
    }
}

// `e1rm` is absent exactly where Epley is undefined — at or below zero load — and never a zero.
@Serializable
data class RecordMark(
    val weightKg: Double,
    val reps: Int,
    @SerialName("at") val atMs: Long,
    val e1rm: Double? = null,
)

@Serializable
data class RecordDay(
    val sessionId: String,
    @SerialName("startedAt") val startedAtMs: Long,
    val sets: List<TrainingSet> = emptyList(),
)

// The two counts are OPTIONAL, never defaulted to 0; zero itself is a real answer. The three e1RM
// fields are absent together where the estimator has nothing to say.
@Serializable
data class MovementRecord(
    val exercise: Exercise,
    val routineCount: Int? = null,
    // Which routines, by name, in program order — exactly `routineCount` long, omitted rather than empty.
    val routines: List<String> = emptyList(),
    val sessionCount: Int? = null,
    val bestE1rm: RecordMark? = null,
    val heaviest: RecordMark? = null,
    val e1rmSeries: List<RecordMark> = emptyList(),   // oldest first, the last twelve weeks
    val records: List<RecordMark> = emptyList(),      // NEWEST first, lifetime
    val recentDays: List<RecordDay> = emptyList(),    // newest first, at most ten
) {
    companion object {
        const val recentDaysShown = 10

        // The server's rules: a session counts when it holds a WORKING set, and ties on the heaviest
        // go to more reps.
        fun of(exercise: Exercise, history: List<SessionDetail>, routines: List<Routine>): MovementRecord {
            val closed = history.filter { it.session.finishedAtMs != null }
            val worked = closed.filter { detail ->
                detail.sets.any { it.exerciseId == exercise.id && it.kind == SetKind.Working }
            }
            val heaviest = worked
                .flatMap { detail ->
                    detail.sets
                        .filter { it.exerciseId == exercise.id && it.kind == SetKind.Working }
                        .map { RecordMark(it.weightKg, it.reps, detail.session.startedAtMs) }
                }
                .maxWithOrNull(compareBy({ it.weightKg }, { it.reps }))

            val named = routines
                .filter { routine -> routine.entries.any { it.exerciseId == exercise.id } }
                .map { it.name }
            return MovementRecord(
                exercise = exercise,
                routineCount = named.size,
                routines = named,
                sessionCount = worked.size,
                heaviest = heaviest,
                recentDays = closed
                    .sortedByDescending { it.session.startedAtMs }
                    .mapNotNull { detail ->
                        val performed = detail.sets
                            .filter { it.exerciseId == exercise.id && it.kind != SetKind.Warmup }
                            .sortedBy { it.completedAtMs }
                        if (performed.isEmpty()) return@mapNotNull null
                        RecordDay(detail.session.id, detail.session.startedAtMs, performed)
                    }
                    .take(recentDaysShown),
            )
        }
    }
}

@Serializable
data class SessionShare(
    val token: String,
    val url: String? = null,
    @SerialName("expiresAt") val expiresAtMs: Long,
)

@Serializable
data class SetWrite(
    val id: String,
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    val kind: SetKind,
    val completedAt: Long,
) {
    constructor(set: TrainingSet) :
        this(set.id, set.exerciseId, set.weightKg, set.reps, set.kind, set.completedAtMs)
}

// `exerciseId`, `completedAt` and `setNumber` belong to the log, and none of them is a correction.
// A fix names ONLY what it changes: an absent field reads on the server as "leave what is stored",
// `note: ""` clears a note and `rpe: null` clears an rpe. Those two clears are VALUES and not
// omissions, which is why `rpeNamed` rides beside `rpe` and why this writes its own wire object.
@Serializable(with = SetFixWire::class)
data class SetFix(
    val weightKg: Double? = null,
    val reps: Int? = null,
    val kind: SetKind? = null,
    val note: String? = null,
    val rpeNamed: Boolean = false,
    val rpe: Double? = null,
) {
    // What a sheet asks for, read against what the log holds: only the fields that moved travel.
    constructor(stored: TrainingSet, weightKg: Double, reps: Int, kind: SetKind, rpe: Double?, note: String) :
        this(
            weightKg = weightKg.takeIf { Ladder.round(it) != Ladder.round(stored.weightKg) },
            reps = reps.takeIf { it != stored.reps },
            kind = kind.takeIf { it != stored.kind },
            note = note.takeIf { it != stored.note },
            rpeNamed = rpe != stored.rpe,
            // Held only where it is named, so an untouched sheet is equal to an empty diff.
            rpe = rpe.takeIf { it != stored.rpe },
        )

    // The claim's replay restates the whole stored row, rpe included — an absent rpe there would
    // leave the account's copy of a set the shelf has corrected saying something else.
    constructor(set: TrainingSet) :
        this(set.weightKg, set.reps, set.kind, set.note, rpeNamed = true, rpe = set.rpe)

    fun corrected(set: TrainingSet): TrainingSet = set.copy(
        weightKg = weightKg ?: set.weightKg,
        reps = reps ?: set.reps,
        kind = kind ?: set.kind,
        note = note ?: set.note,
        rpe = if (rpeNamed) rpe else set.rpe,
    )

    // Read on the ladder's grid, never off raw doubles.
    fun moves(set: TrainingSet): Boolean {
        val after = corrected(set)
        if (Ladder.round(after.weightKg) != Ladder.round(set.weightKg)) return true
        return after.reps != set.reps || after.kind != set.kind ||
            after.note != set.note || after.rpe != set.rpe
    }
}

// The wire shape is a DIFF, so the encoder's absent-is-null rule cannot carry it: `rpe: null` is the
// one field whose explicit null is a value, and an omitted field is the only way to say "leave it".
object SetFixWire : KSerializer<SetFix> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("SetFix") {
        element<Double>("weightKg", isOptional = true)
        element<Int>("reps", isOptional = true)
        element<String>("kind", isOptional = true)
        element<String>("note", isOptional = true)
        element<Double?>("rpe", isOptional = true)
    }

    override fun serialize(encoder: Encoder, value: SetFix) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("a fix is json or nothing")
        json.encodeJsonElement(buildJsonObject {
            value.weightKg?.let { put("weightKg", it) }
            value.reps?.let { put("reps", it) }
            value.kind?.let { put("kind", it.wire) }
            value.note?.let { put("note", it) }
            if (value.rpeNamed) put("rpe", value.rpe)
        })
    }

    override fun deserialize(decoder: Decoder): SetFix =
        throw SerializationException("a fix is written, never read")
}

// The two things a lifter can say about a set that are not the set. RPE is the log's 1–10 and the
// sheet offers the half-point band a lifter actually uses; the note is theirs and nothing reads it
// back to Coach.
object SetEffort {
    const val rpeLabel = "RPE"
    val rpeBand: List<Double> = generateSequence(6.0) { it + 0.5 }.takeWhile { it <= 10.0 }.toList()
    // The seat that means nothing was said, and it says so in words: a bare `—` is read out as
    // nothing at all, so a lifter on TalkBack would hear an unlabelled seat where the way back is.
    const val rpeUnrated = "Not rated"

    const val noteLabel = "Set note"
    const val noteCaption = "A record for you — not an instruction to Coach."
    const val noteMaxBytes = 4000
    // Chrome only in the last fifth, exactly as the note editor draws its own: one room may not
    // draw two rules for one shape.
    const val noteCounterFrom = 3200
    // The log refuses an overlong note with one generic sentence about the whole fix, so this is the
    // only reason a lifter will ever read. It is said at the field, before anything is sent, and in
    // the shape the notes bound already ships — the rule, not the complaint.
    const val noteTooLong = "A set note runs to 4000 bytes."

    // ONE count behind both readouts, so the counter and the refusal can never flip on different
    // bytes. Untrimmed, because what is counted is what would ride the wire.
    fun noteBytes(note: String): Int = note.toByteArray(Charsets.UTF_8).size

    // Null below the threshold: nothing is drawn.
    fun noteCounter(note: String): String? {
        val used = noteBytes(note)
        if (used < noteCounterFrom) return null
        return "$used of $noteMaxBytes bytes"
    }

    // Past the bound the counter goes alarm, wherever a byte counter is drawn in this room.
    fun noteOverlong(note: String): Boolean = noteBytes(note) > noteMaxBytes

    // `8` and `8.5`, never `8.0`.
    fun rpeNumeral(rpe: Double): String =
        if (rpe == floor(rpe)) rpe.toInt().toString() else rpe.toString()

    fun rpeReading(rpe: Double): String = "RPE ${rpeNumeral(rpe)}"

    // Printed on the session row where the log carries either: `RPE 8 · felt heavy`.
    fun line(rpe: Double?, note: String): String? {
        val said = listOfNotNull(rpe?.let(::rpeReading), note.trim().takeIf { it.isNotEmpty() })
        return said.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }
}

// `joinOpenSession` is stated explicitly false: an omitted flag means "join whatever is open".
@Serializable
data class SessionStart(
    val id: String,
    val startedAt: Long,
    val routineId: String? = null,
    val joinOpenSession: Boolean? = null,
)

@Serializable
data class SessionFinish(val finishedAt: Long)

// No defaults on pattern/equipment: a defaulted value vanishes from the wire and the server refuses it.
@Serializable
data class ExerciseWrite(
    val id: String,
    val name: String,
    val pattern: String,
    val equipment: String,
    val stepKg: Double? = null,
)

// The one field a rename may carry: the server refuses any other key outright. The id never changes.
@Serializable
data class ExerciseRename(val name: String)

// `null` is the only default these fields may have: a non-null default is omitted from the wire and
// lands as an open line. Omit the key, never send 0.
@Serializable
data class RoutineEntryWrite(
    val exerciseId: String,
    val targetSets: Int? = null,
    val targetReps: Int? = null,
    val targetWeightKg: Double? = null,
    val restSeconds: Int? = null,
)

@Serializable
data class RoutineWrite(
    val id: String,
    val name: String,
    val position: Int,
    val entries: List<RoutineEntryWrite>,
) {
    // The whole document in position order: a PUT of only the changed line would delete the rest.
    constructor(routine: Routine) : this(
        routine.id,
        routine.name,
        routine.position,
        routine.entries.sortedBy { it.position }.map {
            RoutineEntryWrite(it.exerciseId, it.targetSets, it.targetReps, it.targetWeightKg, it.restSeconds)
        },
    )

    companion object {
        // targetReps is the modal count, ties to the smaller; a warmup-only session yields null.
        fun from(name: String, detail: SessionDetail, position: Int = 0): RoutineWrite? {
            val working = detail.sets
                .filter { it.kind == SetKind.Working }
                .sortedBy { it.completedAtMs }
            if (working.isEmpty()) return null
            val order = mutableListOf<String>()
            for (set in working) if (set.exerciseId !in order) order.add(set.exerciseId)
            val entries = order.map { movement ->
                val sets = working.filter { it.exerciseId == movement }
                val modalReps = sets.groupingBy { it.reps }.eachCount().entries
                    .maxWith(compareBy({ it.value }, { -it.key })).key
                RoutineEntryWrite(
                    exerciseId = movement,
                    targetSets = sets.size,
                    targetReps = modalReps,
                    targetWeightKg = sets.maxOf { it.weightKg },
                )
            }
            return RoutineWrite(Ids.routine(), name, position, entries)
        }
    }
}

// Sticky beats the plan beats last time beats the empty bar; weight from the LAST non-warmup set of
// last time, reps from the FIRST.
data class Prefill(val weightKg: Double, val reps: Int) {
    companion object {
        const val EMPTY_BAR_KG = 20.0
        const val EMPTY_BAR_REPS = 5

        fun of(todaySets: List<TrainingSet>, planEntry: PlanEntry?, lastTime: LastTime?): Prefill {
            val sticky = todaySets.lastOrNull { it.kind == SetKind.Working }
            if (sticky != null) return Prefill(sticky.weightKg, max(1, sticky.reps))
            val history = lastTime?.sets ?: emptyList()
            val weight = planEntry?.weightKg ?: history.lastOrNull()?.weightKg ?: EMPTY_BAR_KG
            val reps = planEntry?.reps ?: history.firstOrNull()?.reps ?: EMPTY_BAR_REPS
            return Prefill(weight, max(1, reps))
        }
    }
}

// The server's bound on any instant is (0, 253402300799000]; outside it is a terminal 400.
object Instants {
    const val MAX_MS = 253_402_300_799_000L

    fun repaired(ms: Long): Long = ms.coerceIn(1, MAX_MS)
}

// The idempotency key: 8 random bytes as hex behind a noun prefix, inside the server's 8..64 rule.
object Ids {
    private val random = SecureRandom()

    fun session(): String = mint("ses_")
    fun set(): String = mint("set_")
    fun routine(): String = mint("rt_")

    // The one id here that is not a replay key: a fresh one opens a thread, the same one continues it.
    fun thread(): String = mint("thr_")
    fun exercise(): String = mint("ex_")
    // Minted once per editor, so a save whose reply was lost replays as the same note.
    fun note(): String = mint("note_")

    private fun mint(prefix: String): String {
        val bytes = ByteArray(8)
        random.nextBytes(bytes)
        return prefix + bytes.joinToString("") { "%02x".format(it) }
    }
}
