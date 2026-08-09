package works.windmill.gym.domain

import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.max
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// The gym wire conventions, stated once: instants are epoch-ms Longs, weights are signed kg
// (negative = band-assisted), ids are client-minted, an absent optional is omitted rather than
// null, a field the server owns (setNumber) is never on a write, and reads default rather than
// throw — a new kind word from a future server parses as .Working, never as a crash.

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

@Serializable
data class Exercise(
    val id: String,
    val name: String,
    val pattern: String = "isolation",
    val equipment: String = "barbell",
    val stepKg: Double? = null,
    val custom: Boolean = false,
)

@Serializable
data class PlanEntry(
    val exerciseId: String,
    val sets: Int,
    val reps: Int? = null,
    val weightKg: Double? = null,
    val restSeconds: Int? = null,
)

@Serializable
data class PlanSnapshot(val routine: String, val entries: List<PlanEntry> = emptyList()) {
    // The signed-out start: the plan frozen off the LOCAL routine's own row at the moment the
    // session opens — the same staleness rule the server applies, on a different shelf.
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

// A log row is a Session plus its shape — the session fields arrive FLAT on the same object.
@Serializable
data class SessionSummary(
    val id: String,
    @SerialName("startedAt") val startedAtMs: Long,
    @SerialName("finishedAt") val finishedAtMs: Long? = null,
    val routineId: String? = null,
    val plan: PlanSnapshot? = null,
    val setCount: Int = 0,
    val exercises: List<String> = emptyList(),
    val topSet: TopSet? = null,
    val closedItself: Boolean = false,
) {
    // A log row composed on the device, for a session only the device holds: the same facts the
    // server's row carries, read off the session and its own sets.
    constructor(session: Session, sets: List<TrainingSet>) : this(
        id = session.id,
        startedAtMs = session.startedAtMs,
        finishedAtMs = session.finishedAtMs,
        routineId = session.routineId,
        plan = session.plan,
        setCount = sets.size,
        exercises = sets.sortedBy { it.completedAtMs }.map { it.exerciseId }.distinct(),
        topSet = sets.filter { it.kind == SetKind.Working }
            .maxWithOrNull(compareBy({ it.weightKg }, { it.reps }))
            ?.let { TopSet(it.weightKg, it.reps) },
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
        // The signed-out answer to "what did I do last time", read off the device's own finished
        // sessions by the server's rule: the most recent FINISHED session holding a working set of
        // this movement, and only its working sets — a ramp-up is not what the next set is aimed
        // at. No history is a first time, never a failure.
        fun of(exerciseId: String, history: List<SessionDetail>): LastTime {
            val last = history
                .filter { it.session.finishedAtMs != null }
                .sortedByDescending { it.session.startedAtMs }
                .firstOrNull { detail ->
                    detail.sets.any { it.exerciseId == exerciseId && it.kind == SetKind.Working }
                }
                ?: return LastTime(exerciseId)
            return LastTime(
                exerciseId = exerciseId,
                session = last.session,
                routine = last.session.plan?.routine,
                sets = last.sets
                    .filter { it.exerciseId == exerciseId && it.kind == SetKind.Working }
                    .sortedBy { it.completedAtMs },
            )
        }
    }
}

@Serializable
data class RoutineEntry(
    val position: Int = 0,
    val exerciseId: String,
    val targetSets: Int,
    val targetReps: Int? = null,
    val targetWeightKg: Double? = null,
    val restSeconds: Int? = null,
)

@Serializable
data class Routine(
    val id: String,
    val name: String,
    val position: Int = 0,
    @SerialName("lastTrainedAt") val lastTrainedAtMs: Long? = null,
    val entries: List<RoutineEntry> = emptyList(),
) {
    // The signed-out create: the routine the write describes, numbered 1..n exactly as the server
    // would number it — so the claim can later send the same document and land the same routine.
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

    fun retargeting(exerciseId: String, toWeightKg: Double): Routine = copy(
        entries = entries.map {
            if (it.exerciseId == exerciseId) it.copy(targetWeightKg = toWeightKg) else it
        }
    )
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

// planned.reps absent = "max"; planned.weightKg absent = "last time" — absences that mean things.
@Serializable
data class Target(val sets: Int, val reps: Int? = null, val weightKg: Double? = null)

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
        // The server's own slight rule (gym Review.h kSlightWorkingSets): under four working sets
        // a session says nothing beyond its three facts. Duration is deliberately not in the
        // predicate — a heavy triple day is short and real, a forgotten phone is long and empty.
        const val slightWorkingSets = 4

        // The device's reading of a session only the device holds: the three facts and the slight
        // rule, never a record and never a comparison — both need the log's whole history, and
        // topE1rm stays absent because the estimate is computed in one place per surface and this
        // is not it.
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

@Serializable
data class StatPoint(
    @SerialName("at") val atMs: Long,
    val weightKg: Double,
    val reps: Int,
    val e1rm: Double? = null,
)

@Serializable
data class StatWeek(
    @SerialName("startedAt") val startedAtMs: Long,
    val sessions: Int,
    val workingSets: Int,
)

@Serializable
data class StatMovement(
    val exerciseId: String,
    @SerialName("lastTrainedAt") val lastTrainedAtMs: Long? = null,
    val points: List<StatPoint> = emptyList(),
    val bestE1rm: StatPoint? = null,
    val heaviest: StatPoint? = null,
)

@Serializable
data class TrainingStatistics(
    val weeks: List<StatWeek> = emptyList(),
    val movements: List<StatMovement> = emptyList(),
) {
    companion object {
        // The signed-out statistics, computed from the device's own finished sessions by the
        // server's rules: weeks are contiguous UTC-Monday buckets so a gap reads as a gap, a point
        // is a session's heaviest working set with ties going to more reps, movements read most
        // recently trained first with ties to the id ascending (Statistics.cpp's own order — every
        // multi-movement session ties, and the list may not reorder the moment the claim lands),
        // and only working sets count toward anything. e1RM stays absent — an estimate arrives
        // with a point or not at all, and the estimator is not written on this phone.
        fun of(finished: List<SessionDetail>): TrainingStatistics {
            val closed = finished
                .filter { it.session.finishedAtMs != null }
                .sortedBy { it.session.startedAtMs }
            if (closed.isEmpty()) return TrainingStatistics()

            val weekMs = 7 * 86_400_000L
            val first = weekStart(closed.first().session.startedAtMs)
            val last = weekStart(closed.last().session.startedAtMs)
            val weeks = generateSequence(first) { it + weekMs }
                .takeWhile { it <= last }
                .map { start ->
                    val inWeek = closed.filter { weekStart(it.session.startedAtMs) == start }
                    StatWeek(
                        startedAtMs = start,
                        sessions = inWeek.size,
                        workingSets = inWeek.sumOf { detail ->
                            detail.sets.count { it.kind == SetKind.Working }
                        },
                    )
                }
                .toList()

            val movements = closed
                .flatMap { detail ->
                    detail.sets.filter { it.kind == SetKind.Working }.map { it.exerciseId }
                }
                .distinct()
                .map { id ->
                    val points = closed.mapNotNull { detail ->
                        val top = detail.sets
                            .filter { it.exerciseId == id && it.kind == SetKind.Working }
                            .maxWithOrNull(compareBy({ it.weightKg }, { it.reps }))
                            ?: return@mapNotNull null
                        StatPoint(atMs = detail.session.startedAtMs, weightKg = top.weightKg,
                            reps = top.reps, e1rm = null)
                    }
                    StatMovement(
                        exerciseId = id,
                        lastTrainedAtMs = points.last().atMs,
                        points = points,
                        bestE1rm = null,
                        heaviest = points.maxWith(compareBy({ it.weightKg }, { it.reps })),
                    )
                }
                .sortedWith(compareByDescending<StatMovement> { it.lastTrainedAtMs }
                    .thenBy { it.exerciseId })

            return TrainingStatistics(weeks, movements)
        }

        // The server buckets by date_trunc('week', … AT TIME ZONE 'UTC'), so a week starts on a
        // UTC Monday midnight — Readout.day(utc = true) exists for exactly this instant.
        private fun weekStart(ms: Long): Long {
            val date = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
            val monday = date.minusDays(((date.dayOfWeek.value + 6) % 7).toLong())
            return monday.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
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

// An ordinary start omits joinOpenSession — the phone joins by default, so a lost race, a relaunch
// or a borrowed second device all land in the live workout instead of refusing it. The CLAIM sends
// `false`, and must: a replayed past session that silently joined a live workout would file
// yesterday's sets into today's — the exact bug gym's ARCHITECTURE.md §11 records shipping once.
@Serializable
data class SessionStart(
    val id: String,
    val startedAt: Long,
    val routineId: String? = null,
    val joinOpenSession: Boolean? = null,
)

@Serializable
data class SessionFinish(val finishedAt: Long)

// No defaults on pattern/equipment, deliberately: WindmillJson does not encode defaulted values,
// so a default here silently VANISHES from the wire — and the server refuses a movement without
// them. The caller states all three, exactly as the Swift twin does.
@Serializable
data class ExerciseWrite(
    val id: String,
    val name: String,
    val pattern: String,
    val equipment: String,
    val stepKg: Double? = null,
)

@Serializable
data class RoutineEntryWrite(
    val exerciseId: String,
    val targetSets: Int,
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
    // The read-modify-write body: the whole document, entries in position order — a PUT of only
    // the changed line would delete the rest of the program.
    constructor(routine: Routine) : this(
        routine.id,
        routine.name,
        routine.position,
        routine.entries.sortedBy { it.position }.map {
            RoutineEntryWrite(it.exerciseId, it.targetSets, it.targetReps, it.targetWeightKg, it.restSeconds)
        },
    )

    companion object {
        // "Keep this as a routine", composed from the session's own working sets: movements in
        // performed order, targetSets = how many, targetReps = the modal count (ties go to the
        // smaller), targetWeightKg = the heaviest working load. A warmup-only session yields
        // null — the server refuses an empty routine.
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

// The number standing in front of the lifter. Sticky carry-forward beats the plan beats last
// time beats the empty bar — and the asymmetry is deliberate: weight from the LAST working set
// of last time, reps from the FIRST. Warmups never carry forward.
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

// The server's bound on any instant: (0, 253402300799000] — year 9999. A local timestamp outside
// it (a zeroed clock, a nanosecond value) is a terminal 400 on the wire, so the claim repairs
// before it replays rather than losing a session to a clock that lied once.
object Instants {
    const val MAX_MS = 253_402_300_799_000L

    fun repaired(ms: Long): Long = ms.coerceIn(1, MAX_MS)
}

// The idempotency key: 8 random bytes as hex behind a noun prefix — 20 chars, comfortably
// inside the server's 8..64 [A-Za-z0-9_-] rule. Replay = same id; a duplicate = a fresh one.
object Ids {
    private val random = SecureRandom()

    fun session(): String = mint("ses_")
    fun set(): String = mint("set_")
    fun routine(): String = mint("rt_")
    fun exercise(): String = mint("ex_")

    private fun mint(prefix: String): String {
        val bytes = ByteArray(8)
        random.nextBytes(bytes)
        return prefix + bytes.joinToString("") { "%02x".format(it) }
    }
}
