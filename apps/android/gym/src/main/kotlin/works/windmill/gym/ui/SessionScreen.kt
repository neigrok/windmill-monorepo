package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
import works.windmill.gym.store.FixOutcome
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
// AND IT IS WHERE A SET IS FIXED. Tapping any set opens §G18 over this screen: weight, reps, kind,
// or gone. The log moves and the routine does not — the frozen plan beside these rows is a
// snapshot, so what it says about last Tuesday cannot be rewritten by a repair made today.
//
// The affordance is drawn the way §G17 draws it: the row under the thumb raises and says `tap to
// fix`, where at rest it says what the plan made of the set. That is the trade the design makes and
// it is the right one — `tap to fix` on forty rows at once would cost every one of them the line
// this screen exists to print.

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

    // One performed set, ready to draw and ready to fix: the row WHOLE, because the sheet that
    // corrects it needs every field back; the number the log knows it by; and the one line the plan
    // gets to say about it. `setNumber` is the log's own and the position is only the fallback for a
    // session no account has numbered yet — after a delete the log keeps the gap, so 1 and 3 stand
    // beside each other and the next set still mints 4.
    data class Row(val set: TrainingSet, val number: Int, val note: Note?) {
        val id: String get() = set.id
        val kind: SetKind get() = set.kind
        val effort: String get() = Readout.effort(set.weightKg, set.reps)
    }

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
                rows = mine.mapIndexed { index, set ->
                    Row(
                        set = set,
                        number = set.setNumber ?: (index + 1),
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
    //
    // AN OPEN ROW IS SILENT, and that is the same answer the logger's counter gives it (`no target`,
    // never `set 3 of 0`): the routine wrote the movement down and declined to give it a number, so
    // the frozen plan has nothing to say about what was done. It is not `Unplanned` either — the day
    // did name this movement, and `not in the plan` over a line somebody wrote last week is as
    // wrong as a `plan max reps` it never asked for.
    private fun planned(plan: PlanSnapshot?, exerciseId: String): Against {
        if (plan == null) return Against.Silent
        val named = plan.entries.filter { it.exerciseId == exerciseId }
        if (named.isEmpty()) return Against.Unplanned
        if (named.size > 1) return Against.Silent
        val entry = named.single()
        if (entry.sets == null) return Against.Silent
        return Against.Plan(entry, planLine(entry))
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

// The store stays for the two reads a revisit is made of (the sets, the review) and for the two
// writes §G18 adds; only the share half crosses through CoachDoors, because the mint and the revoke
// belong to a card that is otherwise none of this screen's business.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    summary: SessionSummary,
    store: TrainingStore,
    coach: CoachDoors,
    say: (String?) -> Unit,
    onOpenMovement: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var detail by remember(summary.id) { mutableStateOf<SessionDetail?>(null) }
    var setsFailure by remember(summary.id) { mutableStateOf<WriteFailure?>(null) }
    var review by remember(summary.id) { mutableStateOf<Review?>(null) }
    var read by remember(summary.id) { mutableStateOf(false) }
    var fixing by remember(summary.id) { mutableStateOf<String?>(null) }
    // How many corrections §G18 has landed from this screen. It is half of the review's key — the
    // session's id does not change when its sets do — and `store.deletedSets` is the other half,
    // which is the store's own record of the rows it has taken off the log.
    var corrected by remember(summary.id) { mutableStateOf(0) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // THE HEAD FOLLOWS THE LOG, not the row that pushed this screen. A fix moves the working count,
    // the tonnage and the top e1RM, and a header still printing what the list held when the thumb
    // landed would be this wave writing its own false line.
    val standing = store.recent.firstOrNull { it.id == summary.id } ?: summary
    // A delete this device is still holding, and the ones it has already made. Both are filtered out
    // of what is drawn: the first because it can still come back, the second because the copy in
    // hand was read before the row left the log.
    val withheld = store.withheld?.takeIf { it.sessionId == summary.id }
    // Null until the read lands, which is a different silence from a session with no sets in it.
    val movements = detail?.let { held ->
        Performed.movements(
            held.sets.filterNot { it.id in store.deletedSets || it.id == withheld?.set?.id },
            store.catalog,
            held.session.plan,
        )
    }

    // Two reads, and neither one blocks the other: the sets are the session and the review is what
    // the domain makes of it, so a screen missing one still says everything it can about the other.
    LaunchedEffect(summary.id) {
        when (val found = store.sessionDetail(summary.id)) {
            is GymResult.Ok -> detail = found.value
            is GymResult.Failed -> setsFailure = found.why
        }
    }

    // THE REVIEW FOLLOWS THE SETS, and that is why it has its own effect and its own key. It is the
    // domain's reading of exactly the rows drawn above it — the record sentence, the comparison
    // against the last time this routine ran — so a working set corrected into a warmup moves it,
    // and a review still in the hand from before the fix would sit eight lines under sets that
    // disagree with it. The gold dot may not lie after a correction; neither may a sentence.
    //
    // A delete keys off `deletedSets` rather than off the gesture, and the difference is the only
    // one that matters: it grows when the log has ACTUALLY taken the row — a withheld delete inside
    // its window has told nobody, and a settle the log refused has changed nothing to re-read.
    LaunchedEffect(summary.id, corrected, store.deletedSets) {
        review = store.review(summary.id)
        read = true
    }

    // The withheld delete's own clock, hosted where the row it took is drawn — the sheet closes on
    // the gesture, and the set has to be visible as taken while it can still come back. Leaving the
    // room settles whatever is left of it (GymRoom's dispose), so a window nobody waited out is not
    // a delete nobody made.
    LaunchedEffect(withheld) {
        val holding = withheld ?: return@LaunchedEffect
        delay(holding.untilMs - System.currentTimeMillis())
        store.settleWithheld()?.let { say(it.line("that set is still on the log")) }
    }

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { fixing = null }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x8),
    ) {
        SessionHead(standing)
        SetsBlock(movements, setsFailure, onOpenMovement, onFix = { fixing = it })
        withheld?.let { WithheldRow(it.set, onUndo = { store.keepWithheld() }) }
        // The three facts are the head's now, so what is left of the review here is what the head
        // cannot say: the record, and the comparison against the last time this routine ran.
        if (read) ReviewRemarks(review, store.catalog)
        CoachShareCard(coach, summary.id)
    }

    // Resolved off the rows being drawn rather than held as a copy: the sheet is an editor over a
    // row that is still the screen's, and a second copy of it here would be a second answer to
    // "what does this set say" the moment a fix lands.
    val open = movements.orEmpty().firstNotNullOfOrNull { movement ->
        movement.rows.firstOrNull { it.id == fixing }?.let { movement.movement to it }
    }
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
            dragHandle = null,
        ) {
            val (movement, row) = open
            FixSheet(
                set = row.set,
                movement = movement,
                setNumber = row.number,
                routine = standing.plan?.routine,
                onSave = { fix ->
                    close()
                    say(null)
                    scope.launch {
                        when (val ended = store.fixSet(summary.id, row.id, fix)) {
                            is FixOutcome.Corrected -> {
                                detail = detail?.let { held ->
                                    held.copy(sets = held.sets.map {
                                        if (it.id == row.id) ended.set else it
                                    })
                                }
                                corrected += 1
                            }
                            // The log does not hold that row at all, so the drawn one is stale: it
                            // goes, and the sentence says why rather than offering a retry onto
                            // nothing.
                            is FixOutcome.Gone -> {
                                detail = detail?.let { held ->
                                    held.copy(sets = held.sets.filterNot { it.id == row.id })
                                }
                                say(ended.said)
                                corrected += 1
                            }
                            is FixOutcome.Failed -> say(ended.why.line("that set wasn’t changed"))
                        }
                    }
                },
                // Nothing is told yet. The row comes off the screen and the window opens — the log
                // has no undelete, so the only moment this can be taken back is before it is sent.
                // A second delete inside the first one's window sends the first: there is one slot,
                // and a gesture that destroys something may never quietly destroy nothing.
                onDelete = {
                    close()
                    say(null)
                    scope.launch {
                        store.withhold(summary.id, row.set)
                            ?.let { say(it.line("that set is still on the log")) }
                    }
                },
            )
        }
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
private fun SetsBlock(
    movements: List<Performed.Movement>?,
    setsFailure: WriteFailure?,
    onOpenMovement: (String) -> Unit,
    onFix: (String) -> Unit,
) {
    if (movements != null) {
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            movements.forEach { movement -> MovementCard(movement, onOpenMovement, onFix) }
        }
        return
    }
    if (setsFailure != null) {
        // The log's own sentence when it sent one — including the one the store writes for a
        // session that has been discarded from another surface since the log listed it, which is a
        // fact about the log and not about this phone's signal.
        Text(
            setsFailure.line("the sets are on your account"),
            style = GymType.numeral(13),
            color = GymSkin.inkFaint,
        )
    }
}

// TWO DOORS AND THEY DO NOT COLLIDE. The movement's NAME opens its record (§H) — a name is the one
// thing about a movement that can change, and the page behind it is where it changes. Each SET under
// it opens §G18 over this screen. The head is a row of its own and the sets are rows of their own,
// so no tap is ambiguous about which of the two it meant.
@Composable
private fun MovementCard(
    movement: Performed.Movement,
    onOpenMovement: (String) -> Unit,
    onFix: (String) -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clickable { onOpenMovement(movement.id) },
        ) {
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
        movement.rows.forEach { performed -> SetRow(performed, onFix) }
    }
}

// A set that counts toward nothing is drawn in the ink that says so — the tick is the room's
// "logged, settled, not celebrated", and a warmup does not get one.
//
// UNDER THE THUMB IT SAYS WHAT IT DOES, which is §G17's own drawing of this row: the ground raises
// and the note is replaced by `tap to fix` in the accent. The indication is drawn here rather than
// left to the platform's ripple because the design specifies the treatment — a raised ground and a
// changed word — and a ripple over the top would be two answers to one press.
@Composable
private fun SetRow(set: Performed.Row, onFix: (String) -> Unit) {
    val pressing = remember { MutableInteractionSource() }
    val pressed by pressing.collectIsPressedAsState()
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum - 12.dp)
            .clip(RoundedCornerShape(WindmillRadius.sm))
            .background(if (pressed) GymSkin.raised else Color.Transparent)
            .clickable(interactionSource = pressing, indication = null) { onFix(set.id) },
    ) {
        val counts = set.kind == SetKind.Working
        Text(
            if (set.kind == SetKind.Warmup) "·" else "✓",
            style = GymType.numeral(13),
            color = if (counts) GymSkin.setDone else GymSkin.warmupInk,
        )
        Text(
            set.effort,
            style = GymType.numeral(14),
            color = if (counts) GymSkin.ink else GymSkin.warmupInk,
        )
        Spacer(Modifier.weight(1f))
        if (pressed) {
            Text("tap to fix", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.accent)
        } else {
            set.note?.let {
                Text(
                    it.text,
                    style = GymType.numeral(11),
                    color = when {
                        !counts -> GymSkin.warmupInk
                        it.short -> GymSkin.inkDim
                        else -> GymSkin.inkFaint
                    },
                )
            }
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
