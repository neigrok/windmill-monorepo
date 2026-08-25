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

// The frozen plan beside these rows is a snapshot and is the ONLY source for what the plan said.
object Performed {
    data class Note(val text: String, val short: Boolean = false)

    sealed interface Against {
        data class Plan(val entry: PlanEntry, val line: String) : Against
        data object Unplanned : Against
        data object Silent : Against
    }

    // `setNumber` is the log's own; after a delete the log keeps the gap and the next set mints max+1.
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
            val opening = mine.firstOrNull { it.kind == SetKind.Working }?.id
            Movement(
                id = exerciseId,
                movement = Readout.movement(exerciseId, catalog),
                against = against,
                rows = mine.mapIndexed { index, set ->
                    Row(
                        set = set,
                        number = set.setNumber ?: (index + 1),
                        note = if (set.kind != SetKind.Working) Note(set.kind.wire)
                               else note(set, against, opening = set.id == opening),
                    )
                },
            )
        }
    }

    // A PlanEntry carries NO ID, so a movement the plan names TWICE is annotated with nothing at all.
    private fun planned(plan: PlanSnapshot?, exerciseId: String): Against {
        if (plan == null) return Against.Silent
        val named = plan.entries.filter { it.exerciseId == exerciseId }
        if (named.isEmpty()) return Against.Unplanned
        if (named.size > 1) return Against.Silent
        val entry = named.single()
        if (entry.sets == null) return Against.Silent
        return Against.Plan(entry, planLine(entry))
    }

    // Fail-fast in the order the facts outrank each other: the load the plan named, then the reps.
    private fun note(set: TrainingSet, against: Against, opening: Boolean): Note? {
        if (against is Against.Unplanned) return if (opening) Note("added today") else null
        if (against !is Against.Plan) return null
        val entry = against.entry
        val target = entry.weightKg
        if (target != null && target != 0.0) {
            // Rounded on the LADDER's grid before it is compared to zero.
            val delta = Ladder.round(set.weightKg - target)
            if (delta > 0) return Note("+${Readout.weight(delta)} over plan")
            // THE MAGNITUDE, never the signed difference: the word already carries the direction.
            if (delta < 0) return Note("${Readout.weight(-delta)} under plan")
        }
        val reps = entry.reps
        if (reps != null && set.reps < reps) return Note(Readout.spelled(reps - set.reps) + " short", short = true)
        return Note("on plan")
    }

    private fun planLine(entry: PlanEntry): String {
        val weight = entry.weightKg
        if (weight == null || weight == 0.0) return "plan ${Readout.repTarget(entry.reps)} reps"
        return "plan ${Readout.repTarget(entry.reps)} × ${Readout.weight(weight)}"
    }
}

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
    // Half of the review's key — the session's id does not change when its sets do.
    var corrected by remember(summary.id) { mutableStateOf(0) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val standing = store.recent.firstOrNull { it.id == summary.id } ?: summary
    val withheld = store.withheld?.takeIf { it.sessionId == summary.id }
    // Null until the read lands, which is a different silence from a session with no sets in it.
    val movements = detail?.let { held ->
        Performed.movements(
            held.sets.filterNot { it.id in store.deletedSets || it.id == withheld?.set?.id },
            store.catalog,
            held.session.plan,
        )
    }

    LaunchedEffect(summary.id) {
        when (val found = store.sessionDetail(summary.id)) {
            is GymResult.Ok -> detail = found.value
            is GymResult.Failed -> setsFailure = found.why
        }
    }

    // A delete keys off `deletedSets`, which grows only when the log has ACTUALLY taken the row.
    LaunchedEffect(summary.id, corrected, store.deletedSets) {
        review = store.review(summary.id)
        read = true
    }

    // Leaving the room settles whatever is left of the withheld delete's window.
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
        if (read) ReviewRemarks(review, store.catalog)
        CoachShareCard(coach, summary.id)
    }

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
                // Nothing is told yet: the row comes off the screen and the window opens, because the
                // log has no undelete. A second delete inside the window sends the first.
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
        if (summary.closedItself) {
            Text(
                "closed on its own — no set for four hours",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }
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
        Text(
            setsFailure.line("the sets are on your account"),
            style = GymType.numeral(13),
            color = GymSkin.inkFaint,
        )
    }
}

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

@Composable
private fun SetRow(set: Performed.Row, onFix: (String) -> Unit) {
    val pressing = remember { MutableInteractionSource() }
    val pressed by pressing.collectIsPressedAsState()
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
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

private fun headLine(summary: SessionSummary): String {
    val facts = mutableListOf(Readout.day(summary.startedAtMs))
    summary.finishedAtMs?.let { facts.add(Readout.duration(it - summary.startedAtMs)) }
    summary.workingSetCount?.let { facts.add(Readout.workingSets(it)) }
    summary.tonnageKg?.let(Readout::tonnes)?.let { facts.add(it) }
    return facts.joinToString(" · ")
}
