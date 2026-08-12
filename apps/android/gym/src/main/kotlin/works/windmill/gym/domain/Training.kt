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
//
// `setCount` is every set of every kind and keeps that meaning; `workingSetCount` beside it is the
// only kind that counts toward anything, and the log draws THAT one — the row used to print the
// total next to a top set picked from the working sets alone, so a session's "sets" number counted
// warmups and its top set did not.
@Serializable
data class SessionSummary(
    val id: String,
    @SerialName("startedAt") val startedAtMs: Long,
    @SerialName("finishedAt") val finishedAtMs: Long? = null,
    val routineId: String? = null,
    val plan: PlanSnapshot? = null,
    val setCount: Int = 0,
    // Absent rather than zero when the log does not send them. A release APK outlives a deploy, and
    // a `0` defaulted in for a field an older server never wrote would print `0 working` over a
    // session somebody spent an hour on — the exact false zero this wave exists to refuse.
    val workingSetCount: Int? = null,
    val tonnageKg: Double? = null,
    val exercises: List<String> = emptyList(),
    val topSet: TopSet? = null,
    // The best Epley over EVERY working set the session held — not over its heaviest one — made by
    // the log's DOMAIN, because the selection is an ordering and the estimate on top of it is a
    // formula. There is one copy of that formula per language and no phone holds one, so a row with
    // no estimate draws no estimate rather than computing a second.
    val topE1rm: Double? = null,
    // §G's gold dot: a personal record happened inside this workout, judged by the log against
    // itself AS IT IS NOW rather than frozen at finish — §G18's corrections move records, and a dot
    // that lied after a fix would be worse than no dot. Defaulted FALSE and not to null, because
    // the dot is an ASSERTION and its absence is merely an omission: a release APK outlives a
    // deploy, and a server that never wrote this field has said nothing, which is exactly what no
    // dot means. A session composed on the device is false for the same reason its `topE1rm` is
    // absent — the three record rules need the log's whole history and Epley, and neither is here.
    val record: Boolean = false,
    val closedItself: Boolean = false,
) {
    // A log row composed on the device, for a session only the device holds: the same facts the
    // server's row carries, read off the session and its own sets. `topE1rm` stays absent for the
    // reason it is absent from `Review.of` and from every mark `MovementRecord.of` composes — no
    // Epley is computed here, and a session claimed onto an account gets the log's own estimate back.
    constructor(session: Session, sets: List<TrainingSet>) : this(
        id = session.id,
        startedAtMs = session.startedAtMs,
        finishedAtMs = session.finishedAtMs,
        routineId = session.routineId,
        plan = session.plan,
        setCount = sets.size,
        workingSetCount = sets.count { it.kind == SetKind.Working },
        // The server's own sum, clamped the same way: an assisted set moved no external load, so it
        // adds zero rather than subtracting from the week it happened in.
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

// ONE MOVEMENT READ WHOLE — `GET /v1/gym/exercises/:id/record`, the page §H is. A mark is one set
// stamped with its SESSION's start, which is what every date on that page is placed by.
//
// `e1rm` is absent exactly where Epley is undefined — at or below zero load — and an absence is
// never a zero: a mark without one is a real set the estimator has nothing to say about.
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

// The two counts are OPTIONAL for the reason `workingSetCount` is: a release APK outlives a
// deploy, and a `0` defaulted in for a field an older server never wrote would print `never
// logged` over a movement with thirty-four sessions in it. Zero itself is a real answer and means
// what it says.
//
// `bestE1rm`, `e1rmSeries` and `records` are all absent together wherever the estimator has
// nothing to say — a bodyweight or band-assisted movement has no e1RM at all, so it draws no
// tile and no chart rather than a dash inside a chart frame.
@Serializable
data class MovementRecord(
    val exercise: Exercise,
    val routineCount: Int? = null,
    val sessionCount: Int? = null,
    val bestE1rm: RecordMark? = null,
    val heaviest: RecordMark? = null,
    val e1rmSeries: List<RecordMark> = emptyList(),   // oldest first, the last twelve weeks
    val records: List<RecordMark> = emptyList(),      // NEWEST first, lifetime
    val recentDays: List<RecordDay> = emptyList(),    // newest first, at most ten
) {
    companion object {
        // The server's own ceiling on the recent list, restated so the shelf answers the same
        // question the log does.
        const val recentDaysShown = 10

        // The signed-out record, read off the device's own finished sessions by the server's
        // rules: a session counts when it holds a WORKING set of the movement, the heaviest is the
        // heaviest working set with ties going to more reps, and a recent day carries the
        // movement's non-warmup sets in performed order.
        //
        // The three e1RM fields stay absent, and that is the same refusal `Review.of` makes:
        // Epley lives in one place per language and this phone is not one of them. So an anonymous
        // record page draws exactly what a bodyweight movement's does — the heaviest set and the
        // sets — and the screen says which of the two absences it is looking at rather than
        // collapsing them into one silence.
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

            return MovementRecord(
                exercise = exercise,
                routineCount = routines.count { routine ->
                    routine.entries.any { it.exerciseId == exercise.id }
                },
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

// THE CORRECTION — §G18, and the three fields a lifter may move. NOT `exerciseId`: a set logged
// against the wrong movement is a different set, and the design draws no repair for that. Not
// `completedAt` and not `setNumber`, which the log owns — a delete leaves a gap and the next set
// still mints max+1, because renumbering would rewrite rows nobody asked to change.
//
// All three ride on every fix and none of them has a default: WindmillJson omits a defaulted value,
// so a default here would vanish from the wire and read on the server as "leave what is stored" —
// the one thing a correction may never do by accident.
@Serializable
data class SetFix(val weightKg: Double, val reps: Int, val kind: SetKind) {
    constructor(set: TrainingSet) : this(set.weightKg, set.reps, set.kind)

    fun corrected(set: TrainingSet): TrainingSet =
        set.copy(weightKg = weightKg, reps = reps, kind = kind)

    // Whether this fix actually changes the row, read on the LADDER's grid and never off raw
    // doubles: a load that went out, was stored and came back is the same load, and a hundredth of
    // a gram's disagreement would send a correction that corrects nothing on every claim, forever.
    fun moves(set: TrainingSet): Boolean =
        Ladder.round(weightKg) != Ladder.round(set.weightKg) || reps != set.reps || kind != set.kind
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

// The rename, and the ONE field it may carry: the server refuses any other key outright, because a
// PATCH that quietly accepted a `pattern` beside the name would be a second door onto the catalog.
// The id is not in here and never changes — that is the whole promise §H's page exists to show.
@Serializable
data class ExerciseRename(val name: String)

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
