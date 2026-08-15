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

    // THE GRAB RAIL'S MOVE (§A2). A reorder is a PERMUTATION and nothing else — the list that comes
    // back holds exactly the movements that went in, which is the whole of what this function has to
    // guarantee: the sets are keyed by movement and never by position, so a walk order that lost a
    // row would take a logged movement off the screen it is being logged on. An index nobody can
    // point at answers with the list unchanged rather than throwing, because the gesture that hands
    // these in is a thumb on a moving list.
    fun moved(order: List<String>, from: Int, to: Int): List<String> {
        if (from !in order.indices || to !in order.indices || from == to) return order
        val walked = order.toMutableList()
        walked.add(to, walked.removeAt(from))
        return walked
    }

    // SWIPE TO DROP, and the two movements it refuses. A movement with a SET in it is never dropped
    // by a sideways swipe: the row would be the lifter's own logged work leaving on a gesture made
    // at arm's length, and taking a set off a log is §G18's own repair — at rest, on a past session,
    // behind a window. A movement the session's PLAN names is refused for a duller reason: the walk
    // order is re-seeded from the plan on every draw (`merged`), so a dropped line would walk back
    // on within the second, and a gesture that undoes itself is worse than one that is not offered.
    // Changing the day's plan is screen 8's, not this list's.
    fun droppable(exerciseId: String, sets: List<TrainingSet>, plan: PlanSnapshot?): Boolean {
        if (sets.any { it.exerciseId == exerciseId }) return false
        return plan?.entry(exerciseId) == null
    }
}

// THE SERVER'S AUTO-CLOSE, applied to a session only this device holds (backend/products/gym
// ARCHITECTURE.md §3.2): an open session with no activity for four hours is over, and it ended at
// its last set — not at whenever the phone happened to notice. A session with no sets ended when it
// began. The log runs this rule lazily on every read and every start; a session composed signed out
// never meets a read, so without this copy a workout abandoned for days on a phone in a drawer would
// claim as a multi-day session, finished at whatever instant the lifter next opened the app.
object AutoClose {
    const val AFTER_MS = 4L * 60 * 60 * 1000

    fun at(session: Session, sets: List<TrainingSet>, nowMs: Long): Long? {
        if (session.finishedAtMs != null) return null
        val lastActivityMs = sets.maxOfOrNull { it.completedAtMs } ?: session.startedAtMs
        if (nowMs < lastActivityMs + AFTER_MS) return null
        return lastActivityMs
    }
}

// WHAT IS KEEPING A SET ON THIS DEVICE, once the walk has offered it and the log did not take it.
// Three different facts and three different sentences: the transport failed (there is no signal
// down here); the log answered without taking it (a 5xx, an unreadable reply — the log's own
// trouble, and it clears when the log does); the account's session lapsed under a signed-in room
// (a 401 — nothing lands until the lifter signs in again). A strip that said "no signal" over a
// 500 pointed the lifter at the wrong thing entirely.
enum class Blocker { Offline, LogFailed, SignInLapsed }

object LiveLines {
    // TWO FACTS AND NOT ONE SENTENCE, because §K draws them in two places: what the plan asks for
    // sits under the movement's name, and which set this is sits over the number being dialled. The
    // separator that used to join them was a layout decision living in the domain.
    data class Counter(
        val count: String,      // "set 3 of 5"
        val plan: String,       // "plan 5 × 5 @ 82.5" · "no target"
    )

    data class Card(val title: String, val body: String)

    // A SET STILL ON THIS DEVICE SAYS SO IN ITS OWN ROW, and this is the only copy of that sentence:
    // the logger's column and the assembly list both read it here rather than each spelling it, so
    // the two cannot drift into disagreeing about the same set.
    const val onThisDevice = "on this device"

    data class Row(
        val id: String,
        val index: String,      // the performed ordinal, or "w" — only a warmup skips a number
        val value: String,
        val note: String,
        val isWarmup: Boolean,
        val isOnThisDevice: Boolean,
    )

    // ONE MOVEMENT OF THIS SESSION, as the assembly list draws it (§A2): the name, what it has
    // already taken, and the sets themselves — the same rows the logger prints, so a set never reads
    // one way under the thumb and another way one screen up.
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

    // Only WORKING sets advance the counter — `workingCount` below is the whole of that rule — and a
    // movement with no target says so rather than borrowing a number from somewhere else. A plan line
    // that names sets but no rep target reads `plan 3 × max`: the routine asked for whatever the
    // movement gives that day.
    //
    // AN OPEN LINE IS THE SAME ANSWER AS NO LINE AT ALL, and that is the whole of what the frozen
    // absence buys: a routine row that decided at the rack has no count to be the third of and no
    // reps to name, so the counter says `set 3` and the target says `no target`. Never `set 3 of 0`.
    fun counter(workingSetsToday: Int, planEntry: PlanEntry?): Counter {
        val sets = planEntry?.sets
        if (planEntry == null || sets == null) {
            return Counter(count = "set ${workingSetsToday + 1}", plan = "no target")
        }
        val load = planEntry.weightKg?.let { " @ ${Readout.weight(it)}" } ?: ""
        return Counter(count = "set ${workingSetsToday + 1} of $sets",
                       plan = "plan $sets × ${Readout.repTarget(planEntry.reps)}$load")
    }

    // WHERE THE MOVEMENT STANDS IN THE WALK — "movement 3 of 6", under the title beside the plan
    // line (§K's position answer, the half this surface was missing). Counted off the ORDER — the
    // merged walk of plan lines and everything appended — and by position rather than by any plan
    // index, so a movement added on the bench mid-rest counts the moment it joins. It degrades to
    // silence rather than to a false count: a movement the walk does not hold has no place, and a
    // walk of one is not a position worth a line.
    fun place(order: List<String>, movement: String?): String? {
        val at = movement?.let { order.indexOf(it) } ?: -1
        if (at < 0 || order.size < 2) return null
        return "movement ${at + 1} of ${order.size}"
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

    // This movement's sets in the order performed — `1 · 105 × 5 ✓`, which is how §K answers "where
    // am I" by looking. The wall-clock time each set landed at came OFF this row with the rebuild:
    // the logger draws the session you are standing in, where "when" is now, and reconstructing a
    // past one is §G17's job on the session read back, which reads its own instants.
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

    // ONE WORD FOR WHAT COUNTS. A set counts toward a target, toward a plan counter and toward the
    // number under the thumb only when its kind is `working` — the kinds are warmup · working · drop
    // · failure, and the last three are all things that happened to a set the plan never asked for.
    // The domain's record rules read the same word and so does log.js `workingSetsOf`, so a drop must
    // not advance "set 4 of 5" here while counting toward nothing there. The movement is optional
    // because a session's sets are sometimes already one movement's.
    fun workingCount(sets: List<TrainingSet>, of: String? = null): Int =
        sets.count { it.kind == SetKind.Working && (of == null || it.exerciseId == of) }

    // THE SESSION AS THE ASSEMBLY SURFACE (§A2) — the list a lifter appends to between sets, which
    // is how a routine gets written in this product: not in an editor, before the first set,
    // standing up. It is also the only thing that moves them between movements, and moving on stays
    // their decision — nothing advances when a plan's set count is reached and nothing advances when
    // a rest lands, so this says where everything stands and lets them choose.
    //
    // `just added` belongs to the row with no sets sitting at the FOOT of the walk, which is where
    // appending puts it — and never to a line the PLAN named, however empty: a movement written down
    // last week and not reached yet was not just added, it is simply not started. A reorder can
    // carry the tag elsewhere, and it follows the position rather than the clock, because the lifter
    // is reading a list and not a history.
    fun assemblyRows(order: List<String>, sets: List<TrainingSet>, plan: PlanSnapshot?,
                     catalog: List<Exercise>, current: String?,
                     stalled: Set<String> = emptySet()): List<MovementRow> {
        val foot = order.lastOrNull()
        return order.map { exerciseId ->
            val performed = sets.filter { it.exerciseId == exerciseId }
            val done = workingCount(performed)
            val entry = plan?.entry(exerciseId)
            val planned = entry?.sets
            // Off the LINE and never off its set target: an open row is a movement the program
            // wrote down and declined to give a number to, so tagging it `just added` would date a
            // written line to this afternoon.
            val justAdded = performed.isEmpty() && exerciseId == foot && entry == null
            MovementRow(
                id = exerciseId,
                name = Readout.movement(exerciseId, catalog),
                tag = when {
                    justAdded -> "just added"
                    // Nothing to count and nothing to show: the line below says it instead, and a
                    // `0 sets` beside it would be the same silence said twice.
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

    // The count is the sets the walk has already OFFERED and could not land (`TrainingStore
    // .strandedCount`), never every queued set: every set is briefly pending on purpose, and
    // counting those would flash this strip for the whole undo window on a healthy connection.
    //
    // THE SECOND SENTENCE NAMES WHAT BLOCKED THEM, and only that: "no signal" is asserted only when
    // the transport failed, never inferred from a set that merely has not landed.
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
