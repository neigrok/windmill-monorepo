package works.windmill.gym.domain

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

// The logger's horizontal walk between movements, which took the two chevron buttons off the screen
// a lifter looks at with a bar in their hands.
//
// Three collisions, all answered here rather than in the composable: the today column under the
// stroke is a nested vertical scroll, so the walk claims a stroke only once it is clearly
// HORIZONTAL; the title is a full-width tap target, so the stroke is attached above it; and a stroke
// that begins in the strip the system takes for back is not the walk's at all — mid-workout back
// already means STAY IN THE WORKOUT, and one stroke may not carry two meanings (Law 3).
object LoggerWalk {
    const val edgeDp = 24
    const val slopDp = 36
    const val dominance = 1.6f

    fun startsInTheEdge(x: Float, width: Float, edgePx: Float): Boolean =
        x <= edgePx || (width > 0f && x >= width - edgePx)

    fun horizontal(dx: Float, dy: Float, slopPx: Float): Boolean =
        kotlin.math.abs(dx) >= slopPx && kotlin.math.abs(dx) > kotlin.math.abs(dy) * dominance

    // Left walks to the NEXT movement: the page moves the way the thumb does.
    fun to(dx: Float, previous: String?, next: String?): String? = if (dx < 0) next else previous

    // A stroke makes two-in-a-moment ordinary where a tap never did, and the deviation the last walk
    // raised lives in ONE slot: a second walk that overwrote it would take the question about the
    // movement you left and never ask it. So the second walk is REFUSED — and says so, naming the
    // movement whose question is open, because a stroke that does nothing reads as a broken stroke.
    fun oneAtATime(movement: String): String = "$movement first — that question is still open."
}

object LiveLines {
    data class Card(val title: String, val body: String)

    const val onThisDevice = "on this device"

    data class Row(
        val id: String,
        val index: String,      // the performed ordinal, or "w" — only a warmup skips a number
        val value: String,
        val note: String,
        val isWarmup: Boolean,
        val isOnThisDevice: Boolean,
    )

    data class MovementRow(
        val id: String,
        val name: String,
        val tag: String?,          // "3 sets" · "3 of 5 sets" · "just added" · nothing yet
        val line: String?,         // said only where there are no sets to say it instead
        val sets: List<Row>,
        val isCurrent: Boolean,
        val justAdded: Boolean,
        val canDrop: Boolean,
    )

    // "set 3 of 5". A plan line with no set count answers like no line at all — "set 3", never
    // "set 3 of 0".
    fun counter(workingSetsToday: Int, planEntry: PlanEntry?): String {
        val sets = planEntry?.sets ?: return "set ${workingSetsToday + 1}"
        return "set ${workingSetsToday + 1} of $sets"
    }

    // The set the last-time chip draws for the coming working set: last time's Nth WORKING set, past
    // its end the last working set, and only where last time was warmups alone its last set. Null
    // where last time holds no set at all — no chip, never a crash.
    fun lastTimeSet(lastTime: List<TrainingSet>, workingSetsToday: Int): TrainingSet? {
        val working = lastTime.filter { it.kind == SetKind.Working }
        return working.getOrNull(workingSetsToday) ?: working.lastOrNull() ?: lastTime.lastOrNull()
    }

    // Counted off the merged walk by position, never off a plan index; a walk of one has no place.
    fun place(order: List<String>, movement: String?): String? {
        val at = movement?.let { order.indexOf(it) } ?: -1
        if (at < 0 || order.size < 2) return null
        return "movement ${at + 1} of ${order.size}"
    }

    // The chip's spoken card. No history is NULL — the screen draws nothing for a first time — and a
    // failed read is a card, because a read that missed must never draw as no history.
    fun prefillCard(lastTime: LastTime?, routine: String?, readFailed: Boolean, now: Long): Card? {
        if (lastTime == null) {
            if (!readFailed) return null
            return Card(title = "Last time", body = "the log didn’t answer")
        }
        val session = lastTime.session ?: return null
        val elsewhere = lastTime.routine?.takeIf { it != routine }?.let { "  ·  $it" } ?: ""
        val shown = lastTime.sets.take(4)
            .joinToString(",   ") { Readout.effort(it.weightKg, it.reps) }
        val more = if (lastTime.sets.size > 4) ",   +${lastTime.sets.size - 4} more" else ""
        return Card(
            title = "Last time · ${Readout.day(session.startedAtMs)} · ${Readout.ago(session.startedAtMs, now)}$elsewhere",
            body = shown + more
        )
    }

    fun rows(sets: List<TrainingSet>, stalled: Set<String>): List<Row> {
        var ordinal = 0
        return sets.map { set ->
            val isWarmup = set.kind == SetKind.Warmup
            if (!isWarmup) ordinal += 1
            val held = set.id in stalled
            Row(id = set.id,
                index = if (isWarmup) "w" else ordinal.toString(),
                value = Readout.effort(set.weightKg, set.reps),
                note = if (isWarmup) "warmup" else (if (held) onThisDevice else ""),
                isWarmup = isWarmup,
                isOnThisDevice = held)
        }
    }

    // Only `working` counts toward a target, a plan counter or a record.
    fun workingCount(sets: List<TrainingSet>, of: String? = null): Int =
        sets.count { it.kind == SetKind.Working && (of == null || it.exerciseId == of) }

    // `just added` is the empty row at the FOOT of the walk and follows position, never the clock.
    fun assemblyRows(order: List<String>, sets: List<TrainingSet>, plan: PlanSnapshot?,
                     catalog: List<Exercise>, current: String?,
                     stalled: Set<String> = emptySet()): List<MovementRow> {
        val foot = order.lastOrNull()
        return order.map { exerciseId ->
            val performed = sets.filter { it.exerciseId == exerciseId }
            val done = workingCount(performed)
            val entry = plan?.entry(exerciseId)
            val planned = entry?.sets
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
                sets = rows(performed, stalled),
                isCurrent = exerciseId == current,
                justAdded = justAdded,
                canDrop = LiveOrder.droppable(exerciseId, sets, plan),
            )
        }
    }

    // The count is `TrainingStore.strandedCount` — offered and not landed — never every queued set.
    fun onThisDeviceLine(count: Int, by: Blocker?): String? {
        if (count <= 0) return null
        val subject = if (count == 1) "1 set is" else "$count sets are"
        val why = when (by) {
            Blocker.Offline -> "No signal down here — they flush when you’re back up."
            Blocker.LogFailed -> "The log didn’t answer — they flush when it does."
            Blocker.SignInLapsed -> "Your sign-in lapsed — they flush once you sign in again."
            null -> "They flush when the log takes them."
        }
        return "$subject saved on this device only. $why"
    }
}
