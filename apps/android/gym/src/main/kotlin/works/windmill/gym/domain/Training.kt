package works.windmill.gym.domain

import java.security.SecureRandom
import kotlin.math.floor
import kotlin.math.max
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Wire conventions: instants are epoch-ms Longs, weights are signed kg (negative = band-assisted),
// ids are client-minted, absent optionals are omitted rather than null, reads default rather than throw.

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
    val loadCount: Int = works.windmill.gym.domain.sync.ExerciseRules.defaultLoadCount(equipment, id),
) {
    val loadFloor: Double? get() = works.windmill.gym.domain.sync.ExerciseRules.loadFloor(equipment, loadCount)

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
}

// One set of a scheme. No `reps` is max; no `weightKg` is last time's Nth set.
@Serializable
data class SetTarget(val reps: Int? = null, val weightKg: Double? = null)

// A line's target is a scheme: its sets in lifting order, each naming its own reps and load. A
// straight scheme is one whose sets all agree; `5 × 5 · 80` is five sets that do. Loads are compared
// on the ladder's grid and never on raw doubles.
object Scheme {
    const val maxSets = 20

    fun rounded(sets: List<SetTarget>): List<SetTarget> =
        sets.map { it.copy(weightKg = it.weightKg?.let(Ladder::round)) }

    fun same(a: List<SetTarget>, b: List<SetTarget>): Boolean = rounded(a) == rounded(b)

    fun straight(sets: List<SetTarget>): Boolean = rounded(sets).distinct().size == 1

    // The slot the coming set fills, counted off the sets already lifted today.
    fun slot(sets: List<SetTarget>, setsToday: Int): SetTarget? = sets.getOrNull(setsToday)

    // There is nothing to ramp between two sets — a two-row ramp is its own ends — or between ends
    // that agree.
    fun canRamp(sets: List<SetTarget>): Boolean {
        if (sets.size < 3) return false
        return rounded(sets).let { it.first() != it.last() }
    }

    // Set 1 to set n in a straight line: the two ends stand as typed, each set between takes its
    // reps to the nearest whole and its load onto the plate grid where that load stands
    // (`Ladder.onGrid`), and a column whose ends are not both named is left as it stands.
    fun rampUp(sets: List<SetTarget>): List<SetTarget> {
        if (!canRamp(sets)) return sets
        val first = sets.first()
        val last = sets.last()
        val steps = sets.size - 1
        return sets.mapIndexed { index, set ->
            if (index == 0) return@mapIndexed first
            if (index == steps) return@mapIndexed last
            val along = index.toDouble() / steps
            SetTarget(
                reps = if (first.reps == null || last.reps == null) set.reps
                       else floor(first.reps + (last.reps - first.reps) * along + 0.5).toInt(),
                weightKg = if (first.weightKg == null || last.weightKg == null) set.weightKg
                           else Ladder.onGrid(first.weightKg + (last.weightKg - first.weightKg) * along),
            )
        }
    }
}

// No `sets` is the open line, frozen as the absence itself: the wire never carries an empty array.
@Serializable
data class PlanEntry(
    val exerciseId: String,
    val sets: List<SetTarget> = emptyList(),
) {
    val isOpen: Boolean get() = sets.isEmpty()
}

@Serializable
data class PlanSnapshot(val routine: String, val entries: List<PlanEntry> = emptyList()) {
    constructor(routine: Routine) : this(
        routine = routine.name,
        entries = routine.entries.sortedBy { it.position }.map {
            PlanEntry(exerciseId = it.exerciseId, sets = it.sets)
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
    val rpe: Double? = null,
    val note: String = "",
    @SerialName("completedAt") val completedAtMs: Long,
)

@Serializable
data class SessionDetail(val session: Session, val sets: List<TrainingSet> = emptyList())

@Serializable
data class TopSet(val weightKg: Double, val reps: Int)

// Session fields arrive flat; both count fields include every set.
@Serializable
data class SessionSummary(
    val id: String,
    @SerialName("startedAt") val startedAtMs: Long,
    @SerialName("finishedAt") val finishedAtMs: Long? = null,
    val routineId: String? = null,
    val plan: PlanSnapshot? = null,
    val setCount: Int = 0,
    // Absent rather than zero when the server omitted the count.
    val workingSetCount: Int? = null,
    val tonnageKg: Double? = null,
    val exercises: List<String> = emptyList(),
    val topSet: TopSet? = null,
    val closedItself: Boolean = false,
) {
    constructor(session: Session, sets: List<TrainingSet>, catalog: List<Exercise>) : this(
        id = session.id,
        startedAtMs = session.startedAtMs,
        finishedAtMs = session.finishedAtMs,
        routineId = session.routineId,
        plan = session.plan,
        setCount = sets.size,
        workingSetCount = sets.size,
        // Clamped the server's way: an assisted set adds zero rather than subtracting.
        tonnageKg = works.windmill.gym.domain.sync.GymVolume.total(sets.map { set ->
            works.windmill.gym.domain.sync.VolumePart(set.id, set.weightKg, set.reps,
                catalog.firstOrNull { it.id == set.exerciseId }?.loadCount)
        }),
        exercises = sets.sortedBy { it.completedAtMs }.map { it.exerciseId }.distinct(),
        topSet = sets.maxWithOrNull(compareBy({ it.weightKg }, { it.reps }))
            ?.let { TopSet(it.weightKg, it.reps) },
        closedItself = false,
    )

    val session: Session get() = Session(id, startedAtMs, finishedAtMs, routineId, plan)
}

// The movement's last finished workout and its sets in performed order, as the shared read answers it.
data class LastTime(
    val exerciseId: String,
    val session: Session? = null,
    val routine: String? = null,
    val sets: List<TrainingSet> = emptyList(),
) {
    val isFirstTime: Boolean get() = session == null
}

// SPARSE: an absent movement is `never logged`. The row is the LAST set of that movement's last-time
// block, and `atMs` is that SESSION's start.
data class LastSet(val exerciseId: String, val weightKg: Double, val reps: Int, val atMs: Long)

// No `sets` is the open row and the ABSENCE is the state: the wire omits the key and never sends
// an empty array, which the log refuses like a zero target.
@Serializable
data class RoutineEntry(
    val position: Int = 0,
    val exerciseId: String,
    val sets: List<SetTarget> = emptyList(),
    val restSeconds: Int? = null,
) {
    val isOpen: Boolean get() = sets.isEmpty()
}

// Reads carry the current revision; edits may send their original revision as a stale-write guard.
@Serializable
data class Routine(
    val id: String,
    val name: String,
    val position: Int = 0,
    @SerialName("lastTrainedAt") val lastTrainedAtMs: Long? = null,
    val entries: List<RoutineEntry> = emptyList(),
    val revision: Int = 1,
    val pendingProposal: Proposal? = null,
) {
    constructor(write: RoutineWrite) : this(
        id = write.id,
        name = write.name,
        position = write.position,
        entries = write.entries.mapIndexed { index, entry ->
            RoutineEntry(position = index + 1, exerciseId = entry.exerciseId,
                sets = entry.sets, restSeconds = entry.restSeconds)
        },
    )
}

// The shared review's record: `previous` is the best it beat, from the workout that started at `previousAtMs`.
@Serializable
data class PersonalRecord(
    val kind: String,
    val exerciseId: String,
    val value: Double,
    val weightKg: Double,
    val reps: Int,
    val previous: Double,
    @SerialName("previousAt") val previousAtMs: Long,
)

// Every set of the movement on one side of a comparison: their count and bounds, and the top set the comparison stands on.
@Serializable
data class Effort(
    val sets: Int,
    val reps: Int,
    val weightKg: Double,
    val minReps: Int = reps,
    val maxReps: Int = reps,
    val minWeightKg: Double = weightKg,
)

// What the frozen plan asked of this movement: its scheme, or nothing. A line that decided at the
// rack rides as an open line, with no set to stand against.
@Serializable
data class PlannedLine(val sets: List<SetTarget> = emptyList()) {
    val isOpen: Boolean get() = sets.isEmpty()

    // The set the effort stands against — the heaviest named load, ties to the earlier set (the
    // log's own TopSet rule read over the plan) — and the first set when no set names a load.
    val top: SetTarget? get() = sets.filter { it.weightKg != null }.maxByOrNull { it.weightKg!! } ?: sets.firstOrNull()
}

@Serializable
data class AgainstMovement(
    val exerciseId: String,
    val now: Effort,
    val before: Effort? = null,
    val planned: PlannedLine? = null,
)

@Serializable
data class Against(
    val sessionId: String,
    val routine: String? = null,
    @SerialName("startedAt") val startedAtMs: Long,
    val movements: List<AgainstMovement> = emptyList(),
)

// What a receipt says beside its own sets, read by the shared review: the record the workout earned and the routine's
// previous workout movement by movement. Nothing at all is a review with nothing to say; it is saved with the receipt.
@Serializable
data class Review(val record: PersonalRecord? = null, val against: Against? = null)

// One closed session's sets of a movement.
data class RecordDay(
    val sessionId: String,
    val startedAtMs: Long,
    val sets: List<TrainingSet> = emptyList(),
)

// A movement's page: the movement and its newest days. Its estimates and bests are read from
// `StatsProgress`.
data class MovementRecord(
    val exercise: Exercise,
    val recentDays: List<RecordDay> = emptyList(),    // newest first, at most ten
) {
    companion object {
        const val recentDaysShown = 10

        // A day is a closed session that holds a set of the movement.
        fun of(exercise: Exercise, history: List<SessionDetail>): MovementRecord = MovementRecord(exercise,
            history.filter { it.session.finishedAtMs != null }
                .sortedByDescending { it.session.startedAtMs }
                .mapNotNull { detail ->
                    val performed = detail.sets
                        .filter { it.exerciseId == exercise.id }
                        .sortedBy { it.completedAtMs }
                    if (performed.isEmpty()) return@mapNotNull null
                    RecordDay(detail.session.id, detail.session.startedAtMs, performed)
                }
                .take(recentDaysShown))
    }
}


data class SetWrite(
    val id: String,
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    val completedAt: Long,
) {
    constructor(set: TrainingSet) :
        this(set.id, set.exerciseId, set.weightKg, set.reps, set.completedAtMs)
}

// `exerciseId`, `completedAt` and `setNumber` belong to the log, and none of them is a correction.
// A fix names ONLY what it changes: an absent field leaves what is stored, `note: ""` clears a note
// and `rpe: null` clears an rpe. Clearing an rpe is a value and not an omission, which is why
// `rpeNamed` rides beside `rpe`.
data class SetFix(
    val weightKg: Double? = null,
    val reps: Int? = null,
    val note: String? = null,
    val rpeNamed: Boolean = false,
    val rpe: Double? = null,
) {
    // What a sheet asks for, read against what the log holds: only the fields that moved travel.
    constructor(stored: TrainingSet, weightKg: Double, reps: Int, rpe: Double?, note: String) :
        this(
            weightKg = weightKg.takeIf { Ladder.round(it) != Ladder.round(stored.weightKg) },
            reps = reps.takeIf { it != stored.reps },
            note = note.takeIf { it != stored.note },
            rpeNamed = rpe != stored.rpe,
            // Held only where it is named, so an untouched sheet is equal to an empty diff.
            rpe = rpe.takeIf { it != stored.rpe },
        )

    // An owed correction restates the whole saved row, rpe included, so the account's copy of the
    // set ends up saying exactly what this phone says.
    constructor(set: TrainingSet) :
        this(set.weightKg, set.reps, set.note, rpeNamed = true, rpe = set.rpe)

    fun corrected(set: TrainingSet): TrainingSet = set.copy(
        weightKg = weightKg ?: set.weightKg,
        reps = reps ?: set.reps,
        note = note ?: set.note,
        rpe = if (rpeNamed) rpe else set.rpe,
    )

    // Read on the ladder's grid, never off raw doubles.
    fun moves(set: TrainingSet): Boolean {
        val after = corrected(set)
        if (Ladder.round(after.weightKg) != Ladder.round(set.weightKg)) return true
        return after.reps != set.reps ||
            after.note != set.note || after.rpe != set.rpe
    }
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

data class SessionStart(
    val id: String,
    val startedAt: Long,
    val routineId: String? = null,
)

@Serializable
data class ExerciseWrite(
    val id: String,
    val name: String,
    val pattern: String,
    val equipment: String,
    val stepKg: Double? = null,
    val loadCount: Int? = null,
)

// An open line has no targets: its scheme is empty.
@Serializable
data class RoutineEntryWrite(
    val exerciseId: String,
    val sets: List<SetTarget> = emptyList(),
    val restSeconds: Int? = null,
)

@Serializable
data class RoutineWrite(
    val id: String,
    val name: String,
    val position: Int,
    val entries: List<RoutineEntryWrite>,
    @SerialName("revision") val expectedRevision: Int? = null,
) {
    // The whole routine in position order: a save writes every line, and an omitted line is deleted.
    constructor(routine: Routine, expectedRevision: Int? = null) : this(
        routine.id,
        routine.name,
        routine.position,
        routine.entries.sortedBy { it.position }.map {
            RoutineEntryWrite(it.exerciseId, it.sets, it.restSeconds)
        },
        expectedRevision,
    )
}

// On a scheme whose sets disagree the pad follows the slot: the Nth set takes the Nth set's
// numbers, then last time's Nth, then today's last set, then the bar. On a straight scheme, and on
// no scheme, sticky beats the plan beats last time beats the empty bar — weight from the LAST
// set of last time, reps from the FIRST.
data class Prefill(val weightKg: Double, val reps: Int) {
    companion object {
        const val EMPTY_BAR_KG = 20.0
        const val EMPTY_BAR_REPS = 5

        fun of(todaySets: List<TrainingSet>, planEntry: PlanEntry?, lastTime: LastTime?): Prefill =
            at(todaySets.size, todaySets.lastOrNull()?.let { Prefill(it.weightKg, max(1, it.reps)) }, planEntry, lastTime)

        // The load the rack offers at each set the plan still holds, the set in hand first, each later set offered
        // as though the one before it were logged as offered. `lastTime` is null until it is read, and a load that
        // would come from it is null until then.
        fun offeredLoads(todaySets: List<TrainingSet>, planEntry: PlanEntry?, lastTime: LastTime?): List<Double?> {
            val scheme = planEntry?.sets.orEmpty()
            val slots = todaySets.size until scheme.size
            if (lastTime != null) {
                var sticky = todaySets.lastOrNull()?.let { Prefill(it.weightKg, max(1, it.reps)) }
                return slots.map { slot -> at(slot, sticky, planEntry, lastTime).also { sticky = it }.weightKg }
            }
            val straight = scheme.isNotEmpty() && Scheme.straight(scheme)
            var sticky: Double? = todaySets.lastOrNull()?.weightKg
            return slots.map { slot -> (if (straight) sticky ?: scheme.first().weightKg else scheme[slot].weightKg).also { sticky = it } }
        }

        // The offer at a slot, `sticky` being the set logged just before it.
        fun at(slot: Int, sticky: Prefill?, planEntry: PlanEntry?, lastTime: LastTime?): Prefill {
            val scheme = planEntry?.sets.orEmpty()
            val history = lastTime?.sets ?: emptyList()
            if (scheme.isNotEmpty() && !Scheme.straight(scheme)) {
                val target = Scheme.slot(scheme, slot)
                val lastNth = history.getOrNull(slot)
                val weight = target?.weightKg ?: lastNth?.weightKg ?: sticky?.weightKg ?: EMPTY_BAR_KG
                val reps = target?.reps ?: lastNth?.reps ?: sticky?.reps ?: EMPTY_BAR_REPS
                return Prefill(weight, max(1, reps))
            }
            if (sticky != null) return sticky
            val planned = scheme.firstOrNull()
            val weight = planned?.weightKg ?: history.lastOrNull()?.weightKg ?: EMPTY_BAR_KG
            val reps = planned?.reps ?: history.firstOrNull()?.reps ?: EMPTY_BAR_REPS
            return Prefill(weight, max(1, reps))
        }
    }
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

object LoggedSetLimits {
    const val maxReps = 99
    fun permits(weightKg: Double, reps: Int): Boolean =
        weightKg.isFinite() && reps in 1..maxReps
}
