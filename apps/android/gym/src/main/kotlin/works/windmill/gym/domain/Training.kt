package works.windmill.gym.domain

import java.security.SecureRandom
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
)

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
)

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

// joinOpenSession is deliberately absent: the phone always joins, so a lost race, a relaunch or
// a borrowed second device all land in the live workout instead of refusing it.
@Serializable
data class SessionStart(val id: String, val startedAt: Long, val routineId: String? = null)

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
