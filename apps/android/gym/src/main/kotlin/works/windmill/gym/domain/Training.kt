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

// `aliases` is what THIS ACCOUNT used to call this movement, newest first — the log keeps at most
// five and omits the key entirely when there are none, so an ordinary catalog reads exactly as it
// did before §N. The picker matches a name AND its aliases, which is the whole point of keeping
// them: a lifter who renamed `Bench Press` to `Flat press` in March still finds it by the word
// their hands learned. They are never drawn as a second row unless the match came from one — an
// alias is a name, not a label.
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
    // How this movement is loaded, as §N's second question asks it — the ONE thing about a created
    // movement that is not admin. Four are offered at creation and the schema keeps six: `cable` and
    // `kettlebell` are what seeded movements use, and a creation screen is not a taxonomy.
    companion object {
        val loadings = listOf("barbell", "dumbbell", "machine", "bodyweight")

        // The domain's own value for "we did not ask": the picker asks a name and a loading, and
        // nothing on this surface reads the pattern — the ladder is taken off the MAGNITUDE of the
        // load and never off the equipment.
        const val unclassified = "isolation"
    }
}

// THE SIX — the barbell movements a written program is made of, and the one slice of the catalog
// this client carries itself (§J22 lists them on the first screen, each reading `never logged`).
//
// They are here because an anonymous room has no catalog at all: every gym route wants an account,
// so a fresh install signed out opens its picker over nothing and would make a lifter TYPE "Bench
// Press" — minting a device movement that duplicates the seeded one the moment they sign in, which
// is exactly the merge this wave deliberately does not build. With the ids held here, an anonymous
// squat is logged against `back-squat` and the claim lands it on the movement the log already has.
//
// So they ride with every seat, filling only ids the catalog does not already hold — signed in the
// server's row wins, because that row carries the name THIS account calls it. Ids and names are
// byte-identical to backend/db/schema.sql's seed for the same reason: signing in must never rename
// a movement under somebody mid-session.
object TheSix {
    val movements = listOf(
        Exercise("back-squat", "Back Squat", "squat", "barbell", 2.5),
        Exercise("bench-press", "Bench Press", "press", "barbell", 2.5),
        Exercise("deadlift", "Deadlift", "hinge", "barbell", 2.5),
        Exercise("overhead-press", "Overhead Press", "press", "barbell", 2.5),
        Exercise("barbell-row", "Barbell Row", "pull", "barbell", 2.5),
        Exercise("chin-up", "Chin Up", "pull", "bodyweight", 2.5),
    )

    // Everything the catalog does not already hold, in the design's own order. The caller appends
    // rather than replaces, so a rename this account made is never overwritten by a constant.
    fun missingFrom(catalog: List<Exercise>): List<Exercise> =
        movements.filter { six -> catalog.none { it.id == six.id } }
}

// NO `sets` IS THE OPEN LINE, FROZEN. A routine row that names no target asks at the rack, and the
// snapshot keeps that absence rather than freezing a zero nobody wrote — so the logger's counter
// says `set 3` instead of `set 3 of 0`, and the prefill has nothing to reach for and reaches for
// last time instead.
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

// THE PICKER'S META — `GET /v1/gym/exercises/last`, and it is SPARSE: one row per movement this
// lifter has trained and no row at all for the rest, so a movement absent from the reply is the
// picker's `never logged`, said by saying nothing. There is no sentinel, no null row and no zero.
//
// The row is the LAST set of the movement's last-time block and never its heaviest, and `at` is
// that SESSION's start rather than the set's own instant — the mark every date in this product is
// placed by. One read for the whole list rather than one per row: a picker that fired sixty-two
// requests to draw a list is the N+1 the log read already refused once.
@Serializable
data class LastSet(
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    @SerialName("at") val atMs: Long,
) {
    companion object {
        // The signed-out answer, read off the device's own finished sessions by the server's rule:
        // the most recent FINISHED session holding a NON-WARMUP set of the movement, then the last
        // such set in it. Non-warmup and not working-only, because that is the predicate the log
        // uses here — a drop set and a set taken to failure are both what happened last time — and
        // one device answering a different question from the wire is how a picker starts saying one
        // thing signed out and another signed in.
        //
        // IT IS NOT THE SET THE PREFILL DIALS, and the two are not trying to be. This line REPORTS
        // what was lifted last, so it is one set read off the block whole; `LastTime` + `Prefill`
        // AIM the next one, so they read the WORKING sets only — a ramp-up and a back-off are not
        // what the next set is aimed at. A block of 100 × 5 then 60 × 12 therefore reads
        // `last 60 × 12` here and opens the dial at 100 × 5, which is the same pair of answers the
        // iOS twin gives (LocalLog.lastSets) and the same pair the two routes give signed in.
        //
        // The device orders that block by the instant a set was performed where the log orders by
        // set number, which is one order: the log numbers a movement's sets in the order they land.
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

// THE OPEN ROW — no `targetSets` is a line that decides at the rack, and the ABSENCE is the state:
// there is no flag beside it, no zero standing in for it, and no other field to read. An open row
// carries no reps and no weight either (the log refuses a half-open line outright), so `open` is
// the whole of what it has to say. Rest is still legal on one — how long you wait is not what you
// are asked to do.
@Serializable
data class RoutineEntry(
    val position: Int = 0,
    val exerciseId: String,
    val targetSets: Int? = null,
    val targetReps: Int? = null,
    val targetWeightKg: Double? = null,
    val restSeconds: Int? = null,
)

// `revision` is the token a proposal is applied AGAINST, and it is READ-ONLY on the wire — the log
// moves it, no client ever sends it, and `RoutineWrite` carries no field for it. It is what stops
// the mid-session "Save 87.5 to Push A" (a whole-document PUT) from silently destroying the base an
// agent's diff was written on: the PUT bumps the revision, every pending proposal on that routine
// is superseded in the same breath, and the card says so rather than applying over the top.
//
// `pendingProposal` is present only while one is waiting, and it is the CARD — this product has no
// notifications and needs none, because the proposal lives on home and on the routine it touches
// until the lifter applies or dismisses it. A routine the shelf holds never has one: proposals are
// signed-in only, and the claim has nothing of the kind to replay.
@Serializable
data class Routine(
    val id: String,
    val name: String,
    val position: Int = 0,
    @SerialName("lastTrainedAt") val lastTrainedAtMs: Long? = null,
    val entries: List<RoutineEntry> = emptyList(),
    val revision: Int = 1,
    val pendingProposal: Proposal? = null,
    // ONE READ ONLY — `GET /v1/gym/routines/{id}` carries this and the list read does not, because
    // it is one section of one screen. Newest first, and the `created` row is always last.
    val history: List<RoutineEvent> = emptyList(),
) {
    // NO `lastTrainedAt` == UNTESTED, and there is no other field: a routine built at home has
    // never been trained, and the day its first session starts the log's own aggregate fills in.
    // Derived rather than stored for that reason — a flag would still read `untested` the day the
    // routine was trained, and still read tested the day that only session was discarded.
    val untested: Boolean get() = lastTrainedAtMs == null

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

    // The mid-session "Save 87.5 to Push A" (§8), addressed by POSITION — the routine row the frozen
    // plan line was snapshotted from (plan index + 1), not the movement's name. A program legitimately
    // holds the same movement twice — a heavy top set at 100 and a back-off at 80 are two rows with
    // two positions — and a name-addressed rewrite moved BOTH to 105 when only the top set was beaten.
    //
    // NULL IS NOTHING TO WRITE. The routine may have changed under the running session from another
    // surface: the row at that position gone, or now naming another movement, or opened. A PUT of an
    // unchanged document is not harmless — it moves the revision and supersedes every proposal pending
    // on the routine — so the store writes nothing and says so instead. The open-line rule stays: a
    // weight on a row with no sets is a half-open line the log refuses outright, and the offer never
    // raises for one anyway (an open line has no planned weight to have been beaten).
    fun retargeting(position: Int, exerciseId: String, toWeightKg: Double): Routine? {
        val row = entries.firstOrNull { it.position == position } ?: return null
        if (row.exerciseId != exerciseId) return null
        if (row.targetSets == null) return null
        return copy(entries = entries.map {
            if (it.position == position) it.copy(targetWeightKg = toWeightKg) else it
        })
    }
}

// A DAY OF THE PROGRAM, DATED — how the routine came to exist and every proposal made about it
// since, in one list, newest first. The `created` row is always last and never falls off, whatever
// the ledger above it holds.
//
// `by` ABSENT IS THE LIFTER'S OWN HAND, and that absence is the claim: `create_routine` lands
// immediately over MCP, so drawing "created by you" over a day an agent typed would be putting
// words in somebody's mouth. `movements` is the count the day was BUILT with — absent on a routine
// made before this wave, where the row draws without a count rather than borrowing today's.
//
// `kind` stays a String and the LINE is what parses it: a word this build has never heard of draws
// nothing at all, because a row it cannot name is a row it cannot describe, and a fallback that
// picked either sentence would date somebody's program with a guess.
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

    // The pending one is the CARD and is drawn as one, over this list rather than inside it — the
    // same rule the settled history has always followed.
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

// planned.reps absent = "max"; planned.weightKg absent = "last time" — absences that mean things.
//
// AND `sets` ABSENT IS THE OPEN ROW, arriving here the way it arrives everywhere else in this room:
// as the absence itself. The comparison of a session run under a routine that decided at the rack
// carries `"planned": {}` — every field omitted, the object still there — so a required `sets` here
// took the whole finish screen down with a MissingFieldException, and the room reported it as "the
// log didn’t answer".
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
    // WHICH routines, by name, in program order — the third line of §N's proof block, and the
    // reason it is a real read rather than a constant: `routines Push A · Legs` is the promise a
    // rename makes, and a sheet that named them from anywhere but the log would be the product
    // asserting something it did not check. It is exactly `routineCount` long, and omitted rather
    // than empty, as every list on this read is.
    val routines: List<String> = emptyList(),
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

// EVERY REAL START ON THIS PHONE STATES `joinOpenSession: false` — the user-tapped ones (decisions
// §5: a start is never a silent join under a different plan) and the claim's replays alike (a
// replayed past session that silently joined a live workout would file yesterday's sets into
// today's — the bug gym's ARCHITECTURE.md §11 records shipping once). The field stays
// NULLABLE-WITH-EXPLICIT-FALSE rather than defaulting to false: WindmillJson omits a value equal to
// its declared default, and an omitted flag is the wire's word for "join whatever is open".
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

// THE OPEN ROW, GOING OUT — and `null` is the only default this field may ever have. WindmillJson
// omits a value that equals its declared default, so a non-null default here would drop a real
// target off the wire and land on the server as an open line: the lifter's 3 × 5 quietly becoming
// "decide at the rack". OMIT the key, never send 0 — the log refuses a target of nothing, and
// refuses reps or a weight on a row with no sets.
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

    // A CONVERSATION IS MINTED HERE TOO, and it is the id the whole of §O hangs off: a fresh one
    // opens a thread on the log, and the same one carries the next question into it. It is the only
    // id in this list that is not about a row, and the only one that is not a replay key — every
    // other id here says "this row again", while this one says "the same conversation". It is minted
    // on the phone rather than by the server so that a question can be asked before a thread exists.
    fun thread(): String = mint("thr_")
    fun exercise(): String = mint("ex_")

    private fun mint(prefix: String): String {
        val bytes = ByteArray(8)
        random.nextBytes(bytes)
        return prefix + bytes.joinToString("") { "%02x".format(it) }
    }
}
