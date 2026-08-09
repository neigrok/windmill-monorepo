package works.windmill.gym.domain

// THE RULES THE LOGGER DRAWS — every decision the live surface makes, with no Compose in them: which
// movements this session holds and in what order, where to stand when the room opens onto a workout
// already running, and the exact words above the weight. The twin of the pure half of
// web/src/products/gym/logger/prefill.js and Logger.jsx's own lists.
//
// The screen never congratulates and never warns. "set 4 of 3" is legal, normal, and drawn in the
// same ink as "set 3 of 5": the plan is a snapshot of what was written down, the log is what
// happened, and when they disagree the log is right — so the counter never scolds and the target is
// never hidden.

object LiveOrder {
    // The plan's lines first in the plan's own order, then everything performed the plan never
    // named, in the order it was first performed.
    //
    // What the device already holds keeps its place at the head. A movement appended on the bench
    // mid-rest belongs where the lifter put it, and a second pass that re-sorted it behind the plan
    // would move the list under a thumb that is already reaching for it.
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

    // Where to stand when the room opens onto a session that is already running: at the movement the
    // last set went into, because that is where the lifter is. Nothing logged yet means the head of
    // the plan, and a session with no movements at all means the picker.
    fun resume(order: List<String>, sets: List<TrainingSet>): String? {
        val last = sets.sortedBy { it.completedAtMs }.lastOrNull()?.exerciseId
        if (last != null && last in order) return last
        return order.firstOrNull()
    }
}

object LiveLines {
    data class Counter(
        val count: String,      // "set 3 of 5"
        val tail: String,       // "  ·  plan 5 × 5 @ 82.5"
    )

    data class Card(val title: String, val body: String)

    data class Row(
        val id: String,
        val index: String,      // the performed ordinal, or "w" — only a warmup skips a number
        val value: String,
        val note: String,
        val time: String,
        val isWarmup: Boolean,
        val isOnThisDevice: Boolean,
    )

    data class JumpRow(
        val id: String,
        val name: String,
        val meta: String,
        val isCurrent: Boolean,
    )

    // Only WORKING sets advance the counter — `workingCount` below is the whole of that rule — and a
    // movement with no target says so rather than borrowing a number from somewhere else. A plan line
    // that names sets but no rep target reads `plan 3 × max`: the routine asked for whatever the
    // movement gives that day.
    fun counter(workingSetsToday: Int, planEntry: PlanEntry?): Counter {
        if (planEntry == null) {
            return Counter(count = "set ${workingSetsToday + 1}", tail = "  ·  no target")
        }
        val load = planEntry.weightKg?.let { " @ ${Readout.weight(it)}" } ?: ""
        return Counter(count = "set ${workingSetsToday + 1} of ${planEntry.sets}",
                       tail = "  ·  plan ${planEntry.sets} × ${Readout.repTarget(planEntry.reps)}$load")
    }

    // FOUR STATES, NOT TWO, and the difference between them is the whole reason this card exists.
    // A read still in flight says so and waits; a read that came back empty-handed says THAT instead
    // of going on claiming to be reading; and ONLY an answer may say "first time". A card drawing
    // "no history" over a movement the lifter has squatted for a year, because the phone was in a
    // basement, is the product lying in the one pixel it exists for.
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
        // Which day of the program that block belonged to, when it was not this one — hiding the
        // difference is what would make a lifter read Tuesday's numbers as Thursday's.
        val elsewhere = lastTime.routine?.takeIf { it != routine }?.let { "  ·  $it" } ?: ""
        val shown = lastTime.sets.take(4)
            .joinToString(",   ") { Readout.effort(it.weightKg, it.reps) }
        val more = if (lastTime.sets.size > 4) ",   +${lastTime.sets.size - 4} more" else ""
        return Card(
            title = "Last time · ${Readout.day(session.startedAtMs)} · ${Readout.ago(session.startedAtMs, now)}$elsewhere",
            body = shown + more
        )
    }

    // This movement's sets in the order performed, with real wall-clock times and never "2 minutes
    // ago" — the lifter is reconstructing a session, not reading a feed. A set still on this device
    // says so plainly, in its own row, because that is where the fact belongs.
    fun rows(sets: List<TrainingSet>, stalled: Set<String>): List<Row> {
        var ordinal = 0
        return sets.map { set ->
            val isWarmup = set.kind == SetKind.Warmup
            if (!isWarmup) ordinal += 1
            val held = set.id in stalled
            Row(id = set.id,
                index = if (isWarmup) "w" else ordinal.toString(),
                value = Readout.effort(set.weightKg, set.reps),
                note = if (isWarmup) "warmup" else (if (held) "on this device" else ""),
                time = Readout.time(set.completedAtMs),
                isWarmup = isWarmup,
                isOnThisDevice = held)
        }
    }

    // ONE WORD FOR WHAT COUNTS. A set counts toward a target, toward a plan counter and toward the
    // number under the thumb only when its kind is `working` — the kinds are warmup · working · drop
    // · failure, and the last three are all things that happened to a set the plan never asked for.
    // The domain's record rules read the same word and so does log.js `workingSetsOf`, so a drop must
    // not advance "set 4 of 5" here while counting toward nothing there. The movement is optional
    // because a session's sets are sometimes already one movement's.
    fun workingCount(sets: List<TrainingSet>, of: String? = null): Int =
        sets.count { it.kind == SetKind.Working && (of == null || it.exerciseId == of) }

    // Moving on is the lifter's decision and never the app's: nothing advances when a plan's set
    // count is reached, and nothing advances when a rest lands. This sheet is the only thing that
    // moves them, and it says where everything stands so the choice is theirs to make.
    fun jumpRows(order: List<String>, sets: List<TrainingSet>, plan: PlanSnapshot?,
                 catalog: List<Exercise>, current: String?): List<JumpRow> =
        order.map { exerciseId ->
            val done = workingCount(sets, of = exerciseId)
            val planned = plan?.entry(exerciseId)?.sets
            JumpRow(id = exerciseId,
                    name = Readout.movement(exerciseId, catalog),
                    meta = meta(done, planned),
                    isCurrent = exerciseId == current)
        }

    // The count is the sets the walk has already OFFERED and could not land (`TrainingStore
    // .strandedCount`), never every queued set: every set is briefly pending on purpose, and
    // counting those would flash this strip for the whole undo window on a healthy connection.
    fun onThisDeviceLine(count: Int): String? {
        if (count <= 0) return null
        val subject = if (count == 1) "1 set is" else "$count sets are"
        return "$subject saved on this device only. No signal down here — they flush when you’re back up."
    }

    private fun meta(done: Int, planned: Int?): String {
        if (done == 0) return "no sets yet — logging one starts it"
        if (planned == null) return Readout.setCount(done)
        return "$done of $planned sets"
    }
}
