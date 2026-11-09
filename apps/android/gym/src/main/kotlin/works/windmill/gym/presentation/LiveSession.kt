package works.windmill.gym.presentation

import androidx.annotation.StringRes
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import works.windmill.gym.domain.sync.LastTime
import works.windmill.gym.domain.sync.Prefill

// "set 4 of 3" is legal: where plan and log disagree the log is right, so no target is hidden.

object LiveOrder {
    // Held order first, then the plan's lines in plan order, then the rest as first performed.
    fun merged(held: List<String>, plan: PlanSnapshot?, sets: List<TrainingSet>): List<String> {
        val order = held.toMutableList()
        for (entry in plan?.entries ?: emptyList()) {
            if (entry.exerciseId !in order) order.add(entry.exerciseId)
        }
        for (set in sets.sortedBy { it.completedAtMs }) {
            if (set.exerciseId !in order) order.add(set.exerciseId)
        }
        return order
    }

    // A plan that changed under the open workout takes the walk with it. What left the plan leaves the walk unless a set stands under it, a line it gained lands after the line it follows, and lines the plan reordered trade the places they hold. A movement walked beside the plan stays where it is.
    fun replanned(held: List<String>, before: PlanSnapshot?, after: PlanSnapshot?, sets: List<TrainingSet>): List<String> {
        val was = before?.entries.orEmpty().map { it.exerciseId }.distinct()
        val now = after?.entries.orEmpty().map { it.exerciseId }.distinct()
        if (was == now) return held
        val logged = sets.mapTo(mutableSetOf()) { it.exerciseId }
        val walk = held.filterTo(mutableListOf()) { it in now || it !in was || it in logged }
        now.forEachIndexed { at, movement ->
            if (movement !in walk) walk.add(if (at == 0) 0 else walk.indexOf(now[at - 1]) + 1, movement)
        }
        val staying = now.filter { it in was }.iterator()
        return walk.map { if (it in was && it in now) staying.next() else it }
    }

    // Where the lifter stands once the movement in hand left the walk: on what took its place.
    fun standing(walked: List<String>, movement: String, walk: List<String>): String? =
        walk.getOrNull(walked.indexOf(movement).coerceIn(0, (walk.size - 1).coerceAtLeast(0)))

    fun resume(order: List<String>, sets: List<TrainingSet>): String? {
        val last = sets.sortedBy { it.completedAtMs }.lastOrNull()?.exerciseId
        if (last != null && last in order) return last
        return order.firstOrNull()
    }

    // An out-of-range index answers with the list unchanged rather than throwing.
    fun moved(order: List<String>, from: Int, to: Int): List<String> {
        if (from !in order.indices || to !in order.indices || from == to) return order
        val walked = order.toMutableList()
        walked.add(to, walked.removeAt(from))
        return walked
    }

    fun droppable(exerciseId: String, sets: List<TrainingSet>, plan: PlanSnapshot?): Boolean {
        if (sets.any { it.exerciseId == exerciseId }) return false
        return plan?.entry(exerciseId) == null
    }
}

// Four hours without activity ends a session AT ITS LAST SET; one with no sets ended when it began.
object AutoClose {
    const val AFTER_MS = 4L * 60 * 60 * 1000

    fun at(session: Session, sets: List<TrainingSet>, nowMs: Long): Long? {
        if (session.finishedAtMs != null) return null
        val lastActivityMs = sets.maxOfOrNull { it.completedAtMs } ?: session.startedAtMs
        if (nowMs < lastActivityMs + AFTER_MS) return null
        return lastActivityMs
    }
}

// Why a set is still on this device: the transport failed · the log answered without taking it · the
// account's session lapsed (401).
enum class Blocker { Offline, LogFailed, SignInLapsed }

// A set still to lift: the load the plan expects, `—` while there is none to name, and the plan's reps.
private fun SetTarget.shown(expectedKg: Double?, unit: String): Words = Words.Message(R.string.gym_live_target,
    listOf(expectedKg?.let { "${Readout.weight(it)} $unit" } ?: "—", Readout.repsTarget(reps)))

// The same set as TalkBack says it, the placeholders spelled out.
private fun SetTarget.said(expectedKg: Double?, unit: String): Words = Words.Message(R.string.gym_live_target_spoken, listOf(
    expectedKg?.let { Words.Plain("${Readout.weight(it)} $unit") } ?: Words.Message(R.string.gym_live_no_load_yet),
    reps?.let(Readout::reps) ?: Words.Message(R.string.gym_live_max_reps)))

object LiveLines {
    // One set that landed, numbered in performed order.
    data class Row(
        val id: String,
        val index: String,
        val weight: String,
        val reps: Int,
        val isOnThisDevice: Boolean,
        val unit: String = "kg",
    ) {
        val line: String get() = "$weight $unit × $reps"
        val said: Words
            get() = Words.Message(if (isOnThisDevice) R.string.gym_live_logged_here_spoken else R.string.gym_live_logged_spoken,
                listOf(index, "$weight $unit", Readout.reps(reps)))
    }

    data class MovementRow(
        val id: String,
        val name: String,
        val tagged: Words?,        // "3 sets" · "3 of 5 sets" · "just added" · nothing yet
        val prompt: Words?,        // said only where there are no sets to say it instead
        val sets: List<Row>,
        val isCurrent: Boolean,
        val justAdded: Boolean,
        val canDrop: Boolean,
        val facts: Words = Words.Plain(""),
    )

    // "set 3 of 5". An open plan line answers like no line at all — "set 3", never "set 3 of 0".
    fun counted(setsToday: Int, planEntry: PlanEntry?): Words {
        val sets = planEntry?.sets?.size?.takeIf { it > 0 } ?: return Words.Message(R.string.gym_live_set_n, listOf((setsToday + 1).toString()))
        return Words.Message(R.string.gym_live_set_n_of, listOf((setsToday + 1).toString(), sets.toString()))
    }

    // One row of the logger's ledger. State is never printed as a word: a row's look carries it on
    // screen and `said` carries it to TalkBack.
    sealed interface Slot {
        val said: Words
        val shown: Words?
        val number: String
        val key: String

        data class Landed(val row: Row) : Slot {
            override val said: Words get() = row.said
            override val shown: Words get() = Words.Plain(row.line)
            override val number: String get() = row.index
            override val key: String get() = row.id
        }

        // The set about to be lifted. The rack is its editor; past the plan the row names nothing.
        data class Current(val index: Int, val target: SetTarget?, val expectedKg: Double?, val unit: String = "kg") : Slot {
            override val shown: Words? get() = target?.shown(expectedKg, unit)
            override val said: Words
                get() = target?.let { Words.Message(R.string.gym_live_current_spoken, listOf(index.toString(), it.said(expectedKg, unit))) }
                    ?: Words.Message(R.string.gym_live_current_open_spoken, listOf(index.toString()))
            override val number: String get() = index.toString()
            override val key: String get() = "current"
        }

        data class Planned(val index: Int, val target: SetTarget, val expectedKg: Double?, val unit: String = "kg") : Slot {
            override val shown: Words get() = target.shown(expectedKg, unit)
            override val said: Words get() = Words.Message(R.string.gym_live_planned_spoken, listOf(index.toString(), target.said(expectedKg, unit)))
            override val number: String get() = index.toString()
            override val key: String get() = "planned $index"
        }
    }

    // Performed sets of the workout `sessionId`, the set in hand, and the remaining planned slots, each naming the load
    // the plan expects by the shared `Prefill.expectedLoads`; no set logged today changes them.
    fun slots(sets: List<TrainingSet>, sessionId: String, planEntry: PlanEntry?, lastTime: LastTime, stalled: Set<String>,
              unit: String = "kg"): List<Slot> {
        val landed = rows(sets, stalled, unit).map { Slot.Landed(it) }
        val lifted = setCount(sets)
        val plan = planEntry?.sets.orEmpty()
        val expected = Prefill.expectedLoads(lifted, planEntry?.domain, lastTime)
        val current = Slot.Current(index = lifted + 1, target = plan.getOrNull(lifted), expectedKg = expected.firstOrNull(), unit = unit)
        val coming = plan.drop(lifted + 1).mapIndexed { offset, target ->
            Slot.Planned(index = lifted + offset + 2, target = target, expectedKg = expected.getOrNull(offset + 1), unit = unit)
        }
        return landed + current + coming
    }

    data class Place(val at: Int, val of: Int) {
        val said: Words get() = Words.Message(R.string.gym_live_exercise_of, listOf(at.toString(), of.toString()))
        val markers: List<Marker>
            get() {
                if (of < 2) return emptyList()
                val count = minOf(of, 7)
                val start = (at - count / 2).coerceIn(1, of - count + 1)
                return (start until start + count).map { position ->
                    Marker(position == at, position == start && start > 1 || position == start + count - 1 && position < of)
                }
            }
    }

    data class Marker(val current: Boolean, val continuation: Boolean)

    fun place(order: List<String>, movement: String?): Place? {
        val at = movement?.let { order.indexOf(it) } ?: -1
        if (at < 0) return null
        return Place(at + 1, order.size)
    }

    fun rows(sets: List<TrainingSet>, stalled: Set<String>, unit: String = "kg"): List<Row> =
        sets.mapIndexed { index, set ->
            Row(id = set.id,
                index = (index + 1).toString(),
                weight = Readout.weight(set.weightKg),
                reps = set.reps,
                isOnThisDevice = set.id in stalled,
                unit = unit)
        }

    fun setCount(sets: List<TrainingSet>, of: String? = null): Int =
        sets.count { of == null || it.exerciseId == of }

    // `just added` is the empty row at the FOOT of the walk and follows position, never the clock.
    fun assemblyRows(order: List<String>, sets: List<TrainingSet>, plan: PlanSnapshot?,
                     catalog: List<Exercise>, current: String?,
                     stalled: Set<String> = emptySet()): List<MovementRow> {
        val foot = order.lastOrNull()
        val next = order.firstOrNull { id -> sets.none { it.exerciseId == id } }
        return order.map { exerciseId ->
            val exercise = catalog.firstOrNull { it.id == exerciseId }
            val unit = Readout.loadUnit(exercise)
            val performed = sets.filter { it.exerciseId == exerciseId }
            val done = setCount(performed)
            val entry = plan?.entry(exerciseId)
            val planned = entry?.sets?.size?.takeIf { it > 0 }
            // Off the plan LINE and never off its set count: an open row is still a written line.
            val justAdded = performed.isEmpty() && exerciseId == foot && entry == null
            MovementRow(
                id = exerciseId,
                name = Readout.movement(exerciseId, catalog),
                tagged = when {
                    justAdded -> Words.Message(R.string.gym_live_just_added)
                    performed.isEmpty() -> null
                    planned == null -> Readout.sets(done)
                    else -> Words.Message(R.string.gym_live_done_of_planned, listOf(done.toString(), planned.toString()))
                },
                prompt = if (performed.isEmpty()) Words.Message(R.string.gym_live_no_sets_yet) else null,
                sets = rows(performed, stalled, unit),
                isCurrent = exerciseId == current,
                justAdded = justAdded,
                canDrop = LiveOrder.droppable(exerciseId, sets, plan),
                facts = when {
                    performed.isNotEmpty() -> {
                        val values = performed.map { "${Readout.weight(it.weightKg)} $unit × ${it.reps}" }.distinct()
                        val effort = values.singleOrNull()?.let(Words::Plain) ?: Readout.scheme(performed.map { SetTarget(it.reps, it.weightKg) }, exercise)
                        val progress = if (planned != null) Words.Message(R.string.gym_live_done_of_planned, listOf(done.toString(), planned.toString()))
                            else Readout.sets(performed.size)
                        Words.Message(R.string.gym_live_progress_effort, listOf(progress, effort))
                    }
                    exerciseId == next -> entry?.sets?.takeIf { it.isNotEmpty() }?.let { Words.Message(R.string.gym_live_up_next_scheme, listOf(Readout.scheme(it, exercise))) }
                        ?: Words.Message(R.string.gym_live_up_next)
                    entry?.sets?.isNotEmpty() == true -> Readout.scheme(entry.sets, exercise)
                    else -> Words.Message(R.string.gym_live_no_sets)
                },
            )
        }
    }

    // The count is `WorkoutSession.strandedCount` — drawn sets whose append or correction a walk could
    // not land — never every queued set.
    fun onThisDevice(count: Int, by: Blocker?): Words? {
        if (count <= 0) return null
        val said = when (by) {
            Blocker.Offline -> R.plurals.gym_live_held_offline
            Blocker.LogFailed -> R.plurals.gym_live_held_no_answer
            Blocker.SignInLapsed -> R.plurals.gym_live_held_sign_in
            null -> R.plurals.gym_live_held_waiting
        }
        return Words.Counted(said, count, listOf(count.toString()))
    }
}

class WorkoutClocks(session: Session, sets: List<TrainingSet>, nowMs: Long) {
    val latestSetAtMs: Long? = sets.maxOfOrNull { it.completedAtMs }
    val workoutMs: Long = ((session.finishedAtMs ?: nowMs) - session.startedAtMs).coerceAtLeast(0)
    val sinceSetMs: Long = ((session.finishedAtMs ?: nowMs) - (latestSetAtMs ?: session.startedAtMs)).coerceAtLeast(0)
    @StringRes val sinceSetLabel: Int = if (latestSetAtMs == null) R.string.gym_live_since_start else R.string.gym_live_since_last_set
}
