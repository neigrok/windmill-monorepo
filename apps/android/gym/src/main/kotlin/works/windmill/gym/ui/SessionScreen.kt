package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A SESSION, REVISITED — what the plan said beside what was done, which is the whole of §G17 and
// the reason this screen exists rather than being a list of numbers. Dim is the plan, bright is the
// lifter. A miss gets one line and no scolding.
//
// It draws no editing of any kind. The log is append-only, the phone owns the OPEN session, and
// correcting a past set is W3 — so no set here says `tap to fix`, because a set that cannot be
// fixed may not be drawn as though it could.

// The sets of a session as they are read back: grouped by movement in the order the movements were
// first touched, and inside a movement in the order the sets were performed. That is the order the
// session was LIVED in, and the same one "Keep this as a routine" composes a program from.
//
// THE FROZEN PLAN IS THE ONLY SOURCE for what the plan said, and never today's routine: a routine
// renamed or retargeted since must not rewrite what the log says about a session that already
// happened. That is the whole reason a snapshot is frozen at start.
object Performed {
    // The one line the plan gets to say about a set. A shortfall reads a step brighter than the
    // rest because it is the only one worth a second look — and it is still one line, in the room's
    // own ink. Nothing here is red and nothing here is a grade.
    data class Note(val text: String, val short: Boolean = false)

    // What the frozen plan has to say about a movement: the line it asked for, that it never asked
    // for this movement at all, or nothing — no plan, or a plan that names it twice.
    sealed interface Against {
        data class Plan(val entry: PlanEntry, val line: String) : Against
        data object Unplanned : Against
        data object Silent : Against
    }

    data class Row(val id: String, val effort: String, val kind: SetKind, val note: Note?)

    data class Movement(
        val id: String,
        val movement: String,
        val against: Against,
        val rows: List<Row>,
    )

    fun movements(
        sets: List<TrainingSet>,
        catalog: List<Exercise>,
        plan: PlanSnapshot? = null,
    ): List<Movement> {
        val performed = sets.sortedBy { it.completedAtMs }
        val order = mutableListOf<String>()
        for (set in performed) if (set.exerciseId !in order) order.add(set.exerciseId)

        return order.map { exerciseId ->
            val mine = performed.filter { it.exerciseId == exerciseId }
            val against = planned(plan, exerciseId)
            // A warmup counts toward nothing — not the records, not the prefill, not the plan — so
            // "added today" opens the first WORKING set rather than a ramp-up that came before it.
            val opening = mine.firstOrNull { it.kind == SetKind.Working }?.id
            Movement(
                id = exerciseId,
                movement = Readout.movement(exerciseId, catalog),
                against = against,
                rows = mine.map { set ->
                    Row(
                        id = set.id,
                        effort = Readout.effort(set.weightKg, set.reps),
                        kind = set.kind,
                        // A set the plan never asked for is not measured against it and still says
                        // what it was: a warmup, a drop, a set taken to failure. Only a working set
                        // is read against a target, because only a working set counts toward one.
                        note = if (set.kind != SetKind.Working) Note(set.kind.wire)
                               else note(set, against, opening = set.id == opening),
                    )
                },
            )
        }
    }

    // ⚠️ A PlanEntry CARRIES NO ID, so a movement the plan names TWICE — a heavy triple and a
    // back-off set, written as two entries — cannot be matched to one of them: the set does not
    // record which line it was performed for, and its position in the plan is a guess about a
    // session that may have walked them in any order. Such a movement is annotated with nothing at
    // all; a wrong "two short" beside somebody's training is worse than a blank. Entry ids would
    // settle it, and this is what asks for them.
    private fun planned(plan: PlanSnapshot?, exerciseId: String): Against {
        if (plan == null) return Against.Silent
        val named = plan.entries.filter { it.exerciseId == exerciseId }
        if (named.isEmpty()) return Against.Unplanned
        if (named.size > 1) return Against.Silent
        return Against.Plan(named.single(), planLine(named.single()))
    }

    // What the plan makes of one set, fail-fast in the order the facts outrank each other: the load
    // it named, then the reps it asked for. A set that is both heavier and short reads as heavier —
    // the load is the claim the plan makes, and two clauses on one row is the scolding this screen
    // refuses. An absent weight target is "whatever you did last time" and compares against nothing.
    private fun note(set: TrainingSet, against: Against, opening: Boolean): Note? {
        if (against is Against.Unplanned) return if (opening) Note("added today") else null
        if (against !is Against.Plan) return null
        val entry = against.entry
        val target = entry.weightKg
        if (target != null && target != 0.0) {
            // Rounded on the LADDER's grid before it is compared to zero, so a load rehydrated from
            // storage cannot read as a two-gram deviation from the plan it exactly matched.
            val delta = Ladder.round(set.weightKg - target)
            if (delta > 0) return Note("+${Readout.weight(delta)} over plan")
            // THE MAGNITUDE, never the signed difference. `Readout.weight` spells a negative load
            // with a real minus because band-assisted work sits below zero — but here the word is
            // already carrying the direction, and "−2.5 under plan" reads as minus two and a half
            // under, which is the opposite of what happened. The room next door says it the same
            // way (SessionScreen.swift takes the absolute value first).
            //
            // §G17's sample draws only the over case, because no set in it came in light. This is
            // its mirror, spelled by engineering the way the four foot states were — a lifter who
            // dropped the bar 2.5 kg is owed the same one line as one who added it.
            if (delta < 0) return Note("${Readout.weight(-delta)} under plan")
        }
        val reps = entry.reps
        if (reps != null && set.reps < reps) return Note(Readout.spelled(reps - set.reps) + " short", short = true)
        return Note("on plan")
    }

    // The plan's SET COUNT is not drawn: the rows under this line are the count, and the two numbers
    // a lifter checks a set against are the reps and the load. A movement the routine declines to
    // load — a chin-up, a plan written as `3 × max` — says what it does ask for and no more.
    private fun planLine(entry: PlanEntry): String {
        val weight = entry.weightKg
        if (weight == null || weight == 0.0) return "plan ${Readout.repTarget(entry.reps)} reps"
        return "plan ${Readout.repTarget(entry.reps)} × ${Readout.weight(weight)}"
    }
}

// The store stays for the two reads a revisit is made of (the sets, the review); only the share
// half crosses through CoachDoors, because the mint and the revoke are the two writes this screen
// may reach.
@Composable
fun SessionScreen(summary: SessionSummary, store: TrainingStore, coach: CoachDoors) {
    var detail by remember(summary.id) { mutableStateOf<SessionDetail?>(null) }
    var setsFailure by remember(summary.id) { mutableStateOf<WriteFailure?>(null) }
    var review by remember(summary.id) { mutableStateOf<Review?>(null) }
    var read by remember(summary.id) { mutableStateOf(false) }

    // Two reads, and neither one blocks the other: the sets are the session and the review is what
    // the domain makes of it, so a screen missing one still says everything it can about the other.
    LaunchedEffect(summary.id) {
        when (val found = store.sessionDetail(summary.id)) {
            is GymResult.Ok -> detail = found.value
            is GymResult.Failed -> setsFailure = found.why
        }
        review = store.review(summary.id)
        read = true
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x8),
    ) {
        SessionHead(summary)
        SetsBlock(detail, setsFailure, store.catalog)
        // The section's whole thesis, and the reason the plan line is dim and the sets are not.
        if (detail != null && summary.plan != null) {
            Text(
                "Dim is what the plan said. Bright is what you did. A miss gets one line and no scolding.",
                style = WindmillFont.body(13).copy(lineHeight = 19.sp),
                color = GymSkin.inkFaint,
            )
        }
        // The three facts are the head's now, so what is left of the review here is what the head
        // cannot say: the record, and the comparison against the last time this routine ran.
        if (read) ReviewRemarks(review, store.catalog)
        CoachShareCard(coach, summary.id)
    }
}

@Composable
private fun SessionHead(summary: SessionSummary) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text(
            summary.plan?.routine ?: Readout.noRoutine,
            style = WindmillFont.display(28),
            color = GymSkin.ink,
        )
        Text(headLine(summary), style = GymType.numeral(12), color = GymSkin.inkDim)
        // The four-hour rule closed this one rather than a tap, which is a fact about the session a
        // lifter reading it back deserves — the duration beside it is a phone left running, not a
        // workout that lasted that long.
        if (summary.closedItself) {
            Text(
                "closed on its own — no set for four hours",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }
        // WHEN the plan was frozen, because that is the fact that makes the dim column trustworthy:
        // what is compared against below is the routine as it stood at this instant, not as it
        // stands now.
        summary.plan?.let {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                modifier = Modifier
                    .padding(top = WindmillSpace.x1)
                    .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.full))
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.full))
                    .padding(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
            ) {
                Box(
                    Modifier
                        .size(6.dp)
                        .background(GymSkin.targetInk, CircleShape),
                )
                Text(
                    "plan snapshot · frozen ${Readout.time(summary.startedAtMs)}",
                    style = GymType.numeral(11),
                    color = GymSkin.inkDim,
                )
            }
        }
    }
}

@Composable
private fun SetsBlock(detail: SessionDetail?, setsFailure: WriteFailure?, catalog: List<Exercise>) {
    if (detail != null) {
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Performed.movements(detail.sets, catalog, detail.session.plan).forEach { movement ->
                MovementCard(movement)
            }
        }
        return
    }
    if (setsFailure != null) {
        // The log's own sentence when it sent one — including the one the store writes for a
        // session that has been discarded from another surface since Today listed it, which is a
        // fact about the log and not about this phone's signal.
        Text(
            setsFailure.line("the sets are on your account"),
            style = GymType.numeral(13),
            color = GymSkin.inkFaint,
        )
    }
}

@Composable
private fun MovementCard(movement: Performed.Movement) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(
                movement.movement,
                style = WindmillFont.body(16, FontWeight.Bold),
                color = GymSkin.ink,
            )
            Spacer(Modifier.weight(1f))
            // The plan reads in the ink the plan is drawn in everywhere in this room; a movement it
            // never asked for is not a target and is not drawn as one.
            when (val against = movement.against) {
                is Performed.Against.Plan ->
                    Text(against.line, style = GymType.numeral(11), color = GymSkin.targetInk)
                Performed.Against.Unplanned ->
                    Text("not in the plan", style = GymType.numeral(11), color = GymSkin.inkFaint)
                Performed.Against.Silent -> Unit
            }
        }
        movement.rows.forEach { performed -> SetRow(performed) }
    }
}

// A set that counts toward nothing is drawn in the ink that says so — the tick is the room's
// "logged, settled, not celebrated", and a warmup does not get one.
@Composable
private fun SetRow(set: Performed.Row) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth(),
    ) {
        val counts = set.kind == SetKind.Working
        Text(
            if (set.kind == SetKind.Warmup) "·" else "✓",
            style = GymType.numeral(13),
            color = if (counts) GymSkin.setDone else GymSkin.warmupInk,
            modifier = Modifier.alignByBaseline(),
        )
        Text(
            set.effort,
            style = GymType.numeral(14),
            color = if (counts) GymSkin.ink else GymSkin.warmupInk,
            modifier = Modifier.alignByBaseline(),
        )
        Spacer(Modifier.weight(1f))
        set.note?.let {
            Text(
                it.text,
                style = GymType.numeral(11),
                color = when {
                    !counts -> GymSkin.warmupInk
                    it.short -> GymSkin.inkDim
                    else -> GymSkin.inkFaint
                },
                modifier = Modifier.alignByBaseline(),
            )
        }
    }
}

// Every fact the head states is one the row already carried, and each is dropped rather than
// dashed where it is missing: an open session has no length, and a log that sent no working count
// gets no number invented for it.
private fun headLine(summary: SessionSummary): String {
    val facts = mutableListOf(Readout.day(summary.startedAtMs))
    summary.finishedAtMs?.let { facts.add(Readout.duration(it - summary.startedAtMs)) }
    summary.workingSetCount?.let { facts.add(Readout.workingSets(it)) }
    summary.tonnageKg?.let(Readout::tonnes)?.let { facts.add(it) }
    return facts.joinToString(" · ")
}
