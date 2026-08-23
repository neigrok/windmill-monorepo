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

object LiveLines {
    data class Counter(
        val count: String,      // "set 3 of 5"
        val plan: String,       // "plan 5 × 5 @ 82.5" · "no target"
    )

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

    // A plan line with no set count answers like no line at all — "set 3", never "set 3 of 0".
    fun counter(workingSetsToday: Int, planEntry: PlanEntry?): Counter {
        val sets = planEntry?.sets
        if (planEntry == null || sets == null) {
            return Counter(count = "set ${workingSetsToday + 1}", plan = "no target")
        }
        val load = planEntry.weightKg?.let { " @ ${Readout.weight(it)}" } ?: ""
        return Counter(count = "set ${workingSetsToday + 1} of $sets",
                       plan = "plan $sets × ${Readout.repTarget(planEntry.reps)}$load")
    }

    // Counted off the merged walk by position, never off a plan index; a walk of one has no place.
    fun place(order: List<String>, movement: String?): String? {
        val at = movement?.let { order.indexOf(it) } ?: -1
        if (at < 0 || order.size < 2) return null
        return "movement ${at + 1} of ${order.size}"
    }

    // Only an ANSWER may say "first time" — a failed read must never draw as "no history".
    fun prefillCard(lastTime: LastTime?, planEntry: PlanEntry?, routine: String?,
                    readFailed: Boolean, now: Long): Card {
        if (lastTime == null) {
            return Card(title = "Last time", body = if (readFailed) "the log didn’t answer" else "reading your log…")
        }
        val session = lastTime.session
        if (session == null) {
            val planned = planEntry?.weightKg
                ?: return Card(title = "First time logging this", body = "no history — start where you like")
            return Card(title = "First time logging this",
                        body = "no history — dialled to the plan’s ${Readout.weight(planned)} kg")
        }
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
