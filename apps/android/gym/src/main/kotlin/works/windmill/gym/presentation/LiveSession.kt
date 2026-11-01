package works.windmill.gym.presentation

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

// A set still to lift: the load its rack will offer, `—` while there is no offer to name, and the plan's reps.
private fun SetTarget.line(offeredKg: Double?, unit: String): String =
    "${offeredKg?.let { "${Readout.weight(it)} $unit" } ?: "—"} × ${Readout.repTarget(reps)}"

// The same set as TalkBack says it, the placeholders spelled out.
private fun SetTarget.spoken(offeredKg: Double?, unit: String): String =
    (offeredKg?.let { "${Readout.weight(it)} $unit" } ?: "no load yet") + ", " + (reps?.let(Readout::repCount) ?: "max reps")

object LiveLines {
    const val onThisDevice = "on this device"

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
        val spoken: String
            get() = listOfNotNull("Set $index", "logged", "$weight $unit",
                Readout.repCount(reps), onThisDevice.takeIf { isOnThisDevice }).joinToString(", ")
    }

    data class MovementRow(
        val id: String,
        val name: String,
        val tag: String?,          // "3 sets" · "3 of 5 sets" · "just added" · nothing yet
        val line: String?,         // said only where there are no sets to say it instead
        val sets: List<Row>,
        val isCurrent: Boolean,
        val justAdded: Boolean,
        val canDrop: Boolean,
        val metadata: String = "",
    )

    // "set 3 of 5". An open plan line answers like no line at all — "set 3", never "set 3 of 0".
    fun counter(setsToday: Int, planEntry: PlanEntry?): String {
        val sets = planEntry?.sets?.size?.takeIf { it > 0 } ?: return "set ${setsToday + 1}"
        return "set ${setsToday + 1} of $sets"
    }

    // One row of the logger's ledger. State is never printed as a word: a row's look carries it on
    // screen and `spoken` carries it to TalkBack.
    sealed interface Slot {
        val spoken: String
        val line: String?

        data class Landed(val row: Row) : Slot {
            override val spoken: String get() = row.spoken
            override val line: String get() = row.line
        }

        // The set about to be lifted. The rack is its editor; past the plan the row names nothing.
        data class Current(val index: Int, val target: SetTarget?, val offeredKg: Double?, val unit: String = "kg") : Slot {
            override val line: String? get() = target?.line(offeredKg, unit)
            override val spoken: String
                get() = listOfNotNull("Set $index", "current", target?.spoken(offeredKg, unit)).joinToString(", ")
        }

        data class Planned(val index: Int, val target: SetTarget, val offeredKg: Double?, val unit: String = "kg") : Slot {
            override val line: String get() = target.line(offeredKg, unit)
            override val spoken: String get() = "Set $index, planned, ${target.spoken(offeredKg, unit)}"
        }
    }

    // Performed sets of the workout `sessionId`, the set in hand, and the remaining planned slots, each naming the load
    // its rack will offer by the shared `Prefill.offeredLoads`.
    fun slots(sets: List<TrainingSet>, sessionId: String, planEntry: PlanEntry?, lastTime: LastTime, stalled: Set<String>,
              unit: String = "kg"): List<Slot> {
        val landed = rows(sets, stalled, unit).map { Slot.Landed(it) }
        val lifted = setCount(sets)
        val plan = planEntry?.sets.orEmpty()
        val offers = Prefill.offeredLoads(sets.map { it.domain(sessionId) }, planEntry?.domain, lastTime)
        val current = Slot.Current(index = lifted + 1, target = plan.getOrNull(lifted), offeredKg = offers.firstOrNull(), unit = unit)
        val coming = plan.drop(lifted + 1).mapIndexed { offset, target ->
            Slot.Planned(index = lifted + offset + 2, target = target, offeredKg = offers.getOrNull(offset + 1), unit = unit)
        }
        return landed + current + coming
    }

    data class Place(val at: Int, val of: Int) {
        val spoken: String get() = "Exercise $at of $of"
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
                tag = when {
                    justAdded -> "just added"
                    performed.isEmpty() -> null
                    planned == null -> Readout.setCount(done)
                    else -> "$done of $planned sets"
                },
                line = if (performed.isEmpty()) "no sets yet — logging one starts it" else null,
                sets = rows(performed, stalled, unit),
                isCurrent = exerciseId == current,
                justAdded = justAdded,
                canDrop = LiveOrder.droppable(exerciseId, sets, plan),
                metadata = when {
                    performed.isNotEmpty() -> {
                        val values = performed.map { "${Readout.weight(it.weightKg)} $unit × ${it.reps}" }.distinct()
                        val effort = values.singleOrNull() ?: Readout.targetWithUnit(performed.map { SetTarget(it.reps, it.weightKg) }, exercise)
                        val progress = if (planned != null) "$done of $planned sets" else Readout.setCount(performed.size)
                        "$progress · $effort"
                    }
                    exerciseId == next -> "Up next" + (entry?.sets?.takeIf { it.isNotEmpty() }?.let { " · ${Readout.targetWithUnit(it, exercise)}" } ?: "")
                    entry?.sets?.isNotEmpty() == true -> Readout.targetWithUnit(entry.sets, exercise)
                    else -> "No sets yet"
                },
            )
        }
    }

    // The count is `WorkoutSession.strandedCount` — drawn sets whose append or correction a walk could
    // not land — never every queued set.
    fun onThisDeviceLine(count: Int, by: Blocker?): String? {
        if (count <= 0) return null
        val subject = if (count == 1) "1 set is" else "$count sets are"
        val why = when (by) {
            Blocker.Offline -> "They’ll sync when you’re online."
            Blocker.LogFailed -> "The log didn’t answer. They’ll sync when it’s available."
            Blocker.SignInLapsed -> "Sign in again to sync these sets."
            null -> "They’re waiting to sync."
        }
        return "$subject saved on this device only. $why"
    }
}

class WorkoutClocks(session: Session, sets: List<TrainingSet>, nowMs: Long) {
    val latestSetAtMs: Long? = sets.maxOfOrNull { it.completedAtMs }
    val workoutMs: Long = ((session.finishedAtMs ?: nowMs) - session.startedAtMs).coerceAtLeast(0)
    val sinceSetMs: Long = ((session.finishedAtMs ?: nowMs) - (latestSetAtMs ?: session.startedAtMs)).coerceAtLeast(0)
    val sinceSetName: String = if (latestSetAtMs == null) "Since start" else "Since last set"
}
