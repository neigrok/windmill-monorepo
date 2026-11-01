package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import works.windmill.gym.sharing.WorkoutShareCard
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import works.windmill.platform.net.WindmillJson
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Scheme
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetEffort
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.design.WindmillFont
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

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
        val effort: String get() = Readout.effort(set.weightKg, set.reps)
    }

    data class Movement(
        val id: String,
        val movement: String,
        val against: Against,
        val rows: List<Row>,
        val equipment: String? = null,
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
            val exercise = catalog.find { it.id == exerciseId }
            val against = planned(plan, exerciseId, exercise)
            val opening = mine.firstOrNull()?.id
            Movement(
                id = exerciseId,
                movement = Readout.movement(exerciseId, catalog),
                against = against,
                equipment = exercise?.equipment,
                rows = mine.mapIndexed { index, set ->
                    val slot = index
                    Row(
                        set = set,
                        number = set.setNumber ?: (index + 1),
                        note = note(set, against, opening = set.id == opening, slot = slot),
                    )
                },
            )
        }
    }

    // A PlanEntry carries NO ID, so a movement the plan names TWICE is annotated with nothing at all.
    private fun planned(plan: PlanSnapshot?, exerciseId: String, exercise: Exercise?): Against {
        if (plan == null) return Against.Silent
        val named = plan.entries.filter { it.exerciseId == exerciseId }
        if (named.isEmpty()) return Against.Unplanned
        if (named.size > 1) return Against.Silent
        val entry = named.single()
        if (entry.isOpen) return Against.Silent
        return Against.Plan(entry, "Plan ${Readout.targetWithUnit(entry.sets, exercise)}")
    }

    // Read against the slot this set filled — the Nth set against the plan's Nth
    // set — fail-fast in the order the facts outrank each other: the load the plan named, then the
    // reps. A set logged past the plan has no slot and is read against nothing.
    private fun note(set: TrainingSet, against: Against, opening: Boolean, slot: Int): Note? {
        if (against is Against.Unplanned) return if (opening) Note("added today") else null
        if (against !is Against.Plan) return null
        val planned = Scheme.slot(against.entry.sets, slot) ?: return null
        val target = planned.weightKg
        if (target != null && target != 0.0) {
            // Rounded on the LADDER's grid before it is compared to zero.
            val delta = Ladder.round(set.weightKg - target)
            if (delta > 0) return Note("+${Readout.weight(delta)} over plan")
            // THE MAGNITUDE, never the signed difference: the word already carries the direction.
            if (delta < 0) return Note("${Readout.weight(-delta)} under plan")
        }
        val reps = planned.reps
        if (reps != null && set.reps < reps) return Note(Readout.spelled(reps - set.reps) + " short", short = true)
        return Note("on plan")
    }

}

private fun sessionDetailSaver(telemetry: Telemetry) = Saver<SessionDetail?, String>(
    save = { it?.let { detail -> WindmillJson.encodeToString(SessionDetail.serializer(), detail) } ?: "" },
    restore = { raw -> raw.takeIf(String::isNotEmpty)?.let {
        runCatching { WindmillJson.decodeFromString(SessionDetail.serializer(), it) }
            .onFailure { telemetry.failure("gym.restoreSessionDetail", it) }.getOrNull()
    } },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    summary: SessionSummary,
    store: TrainingStore,
    sharing: WorkoutShareActions,
    backTo: String,
    onBack: () -> Unit,
    say: (String?) -> Unit,
    onOpenMovement: (String) -> Unit,
    onDiscard: (String) -> Unit,
    seed: SessionDetail? = null,
    onDraftOpen: (Boolean) -> Unit = {},
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    var detail by rememberSaveable(summary.id, stateSaver = remember(telemetry) { sessionDetailSaver(telemetry) }) { mutableStateOf<SessionDetail?>(seed) }
    var setsFailure by remember(summary.id) { mutableStateOf<WriteFailure?>(null) }
    var review by remember(summary.id) { mutableStateOf<Review?>(null) }
    var read by remember(summary.id) { mutableStateOf(false) }
    var fixing by rememberSaveable(summary.id) { mutableStateOf<String?>(null) }
    val currentDraftOpen by rememberUpdatedState(onDraftOpen)
    DisposableEffect(fixing) {
        currentDraftOpen(fixing != null)
        onDispose { currentDraftOpen(false) }
    }
    val fixStates = rememberSaveableStateHolder()
    // Half of the review's key — the session's id does not change when its sets do.
    var corrected by remember(summary.id) { mutableStateOf(0) }
    var fixBusy by remember { mutableStateOf(false) }
    var cancelFixEntry by remember { mutableStateOf<(() -> Unit)?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { destination ->
            when {
                fixBusy -> false
                destination == SheetValue.Hidden && cancelFixEntry != null -> {
                    cancelFixEntry?.invoke()
                    false
                }
                else -> true
            }
        })

    val currentDetail = detail?.let(store::retainedSession)
    val readId = currentDetail?.session?.id ?: summary.id
    val visibleSets = currentDetail?.sets?.filterNot { it.id in store.deletedSets || it.id in store.withheldIds }
    val standing = currentDetail?.let { SessionSummary(it.session, visibleSets.orEmpty(), store.catalog) }
        ?: store.recent.firstOrNull { it.id == summary.id } ?: summary
    var shareOpen by rememberSaveable(summary.id) { mutableStateOf(false) }
    // Null until the read lands, distinct from a workout with no sets.
    val movements = currentDetail?.let { held ->
        Performed.movements(
            held.sets.filterNot { it.id in store.deletedSets || it.id in store.withheldIds },
            store.catalog,
            held.session.plan,
        )
    }

    LaunchedEffect(currentDetail) {
        if (currentDetail != null && detail != currentDetail) detail = currentDetail
    }

    LaunchedEffect(readId) {
        when (val found = store.sessionDetail(readId, currentDetail)) {
            is GymResult.Ok -> { detail = found.value; setsFailure = null }
            is GymResult.Failed -> setsFailure = found.why
        }
    }

    // A deleted or restored row changes the review as well as the set list.
    LaunchedEffect(readId, corrected, store.deletedSets) {
        review = store.review(readId)
        read = true
    }

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            fixing?.let(fixStates::removeState)
            fixing = null
        }
    }

    GymScreen(
        title = standing.plan?.routine ?: Readout.noRoutine,
        onBack = onBack,
        backTo = backTo,
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = GymLayout.gutter,
                end = GymLayout.gutter,
                top = 4.dp,
                bottom = GymLayout.scrollTail,
            ),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item("head") { SessionHead(standing) }
            val held = movements
            if (held != null) {
                items(held, key = { it.id }) { movement ->
                    MovementCard(
                        movement = movement,
                        onOpenMovement = onOpenMovement,
                        onFix = { fixing = it },
                        onDelete = { row ->
                            val failure = store.delete(Deletion.Set(readId, row))
                            say(failure?.line("that set is still on the log"))
                            failure == null
                        },
                    )
                }
            }
            setsFailure?.let { failure ->
                item("failure") {
                    Text(
                        failure.line("the saved sets are shown"),
                        style = GymType.numeral(13),
                        color = skin.inkDim,
                    )
                }
            }
            if (read && (review == null || Finish.recordSentence(review?.record, store.catalog) != null ||
                    Finish.comparison(review?.against, store.catalog) != null)) {
                item("review") { ReviewRemarks(review, store.catalog) }
            }
            item("actions") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(16.dp)).background(skin.raised)
                        .clickable(role = Role.Button) { shareOpen = true }, contentAlignment = Alignment.Center) {
                        Text("Share this workout", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                    GymErrorTextButton("Discard workout", onClick = { onDiscard(readId) },
                        modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }

    val open = movements.orEmpty().firstNotNullOfOrNull { movement ->
        movement.rows.firstOrNull { it.id == fixing }?.let { movement.movement to it }
    }
    if (open != null) {
        // Back reaches Fix set's own handlers first: a busy save swallows it and open entry cancels it. A drag
        // waits on the same two through the sheet state.
        WindmillSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = skin.surface,
            scrimColor = skin.scrim,
        ) {
            val (movement, row) = open
            fixStates.SaveableStateProvider(fixing!!) {
            FixSheet(
                set = row.set,
                exercise = store.catalog.firstOrNull { it.id == row.set.exerciseId },
                origin = FixOrigin.Session,
                movement = movement,
                setNumber = row.number,
                routine = standing.plan?.routine,
                onSave = { fix ->
                    val ended = store.fixSet(readId, row.id, fix, FixOrigin.Session)
                    when (ended) {
                        is FixOutcome.Corrected -> {
                            detail = currentDetail?.let { held -> held.copy(sets = held.sets.map {
                                if (it.id == row.id) ended.set else it
                            }) }
                            corrected += 1
                        }
                        is FixOutcome.Gone -> {
                            detail = currentDetail?.let { held -> held.copy(sets = held.sets.filterNot { it.id == row.id }) }
                            corrected += 1
                        }
                        is FixOutcome.Failed -> Unit
                    }
                    ended
                },
                onSaved = { close(); say(null) },
                onGone = { close(); say(it) },
                onBusy = { fixBusy = it },
                onEntryCancel = { cancelFixEntry = it },
                onDelete = {
                    close()
                    say(null)
                    scope.launch { say(store.delete(Deletion.Set(readId, row.set))?.line("that set is still on the log")) }
                },
            )
            }
        }
    }
    if (shareOpen) WindmillSheet(onDismissRequest = { shareOpen = false },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = skin.surface, scrimColor = skin.scrim) {
        WorkoutShareCard(sharing, readId)
    }

}

@Composable
private fun SessionHead(summary: SessionSummary) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(headLine(summary), style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        Text("Volume", style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim)
        Text(summary.tonnageKg?.let { "${Readout.weight(it)} kg" } ?: "—",
            style = WindmillFont.display(34, FontWeight.ExtraBold).copy(lineHeight = 40.sp), color = skin.ink)
        val count = Readout.setCount(summary.workingSetCount ?: summary.setCount)
        Text("$count · ${summary.exercises.size} ${if (summary.exercises.size == 1) "movement" else "movements"}", style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        if (summary.plan != null) Text("Plan saved at start", style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkFaint)
        if (summary.closedItself) Text("Closed after four hours without a set", style = WindmillFont.body(13), color = skin.inkDim)
    }
}

@Composable
private fun MovementCard(
    movement: Performed.Movement,
    onOpenMovement: (String) -> Unit,
    onFix: (String) -> Unit,
    onDelete: suspend (TrainingSet) -> Boolean,
) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.minimum)
                .clickable(role = Role.Button, onClickLabel = "open this movement") { onOpenMovement(movement.id) },
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                movement.equipment?.let { EquipmentIcon(it, Modifier.size(20.dp), tint = skin.inkDim) }
                Text(movement.movement, style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp),
                    color = skin.ink, modifier = Modifier.weight(1f))
            }
            when (val against = movement.against) {
                is Performed.Against.Plan -> Text(against.line, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim)
                Performed.Against.Unplanned -> Text("not in the plan", style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim)
                Performed.Against.Silent -> Unit
            }
        }
        // KEYED by the set: a swipe box remembered by its POSITION would hand the row that moves
        // up into a deleted row's slot the dismissed state that belongs to the row that left.
        movement.rows.forEach { performed ->
            key(performed.id) { SwipeableSetRow(performed, onFix, onDelete) }
        }
    }
}

// Tap to fix, swipe to delete — one trailing action and nothing on the leading edge, because two
// actions would push the set's own number and load off the row a lifter is deciding about.
//
// LAW 1, and on Android it is the half that is easy to forget: TalkBack sees a drag, so the same
// action is declared again BY HAND on the row. This row carries no overflow to inherit it from.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableSetRow(
    set: Performed.Row,
    onFix: (String) -> Unit,
    onDelete: suspend (TrainingSet) -> Boolean,
) {
    DeleteSwipeRow(actionLabel = "Delete", onDelete = { onDelete(set.set) }) {
        SetRow(set, onFix)
    }
}

@Composable
private fun SetRow(set: Performed.Row, onFix: (String) -> Unit) {
    val skin = LocalGymColors.current
    val pressing = remember { MutableInteractionSource() }
    val pressed by pressing.collectIsPressedAsState()
    val largeText = LocalDensity.current.fontScale > 1.3f
    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp))
        .background(if (pressed) skin.raised else skin.surface)
        .clickable(interactionSource = pressing, indication = null, role = Role.Button,
            onClickLabel = "fix this set") { onFix(set.id) }
        .padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(set.number.toString(), style = GymType.numeral(12).copy(lineHeight = 16.sp), color = skin.inkFaint,
                modifier = Modifier.widthIn(min = 8.dp))
            BasicText(set.effort, maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 14.sp, maxFontSize = 18.sp),
                style = GymType.numeral(18).copy(color = skin.ink, lineHeight = 24.sp), modifier = Modifier.weight(1f))
            if (!largeText) set.note?.let { Text(it.text, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim) }
        }
        if (largeText) set.note?.let {
            Text(it.text, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim, modifier = Modifier.padding(start = 24.dp))
        }
        SetEffort.line(set.set.rpe, set.set.note)?.let {
            Text(it, style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.padding(start = 24.dp))
        }
    }
}

private fun headLine(summary: SessionSummary): String = listOfNotNull(
    Readout.day(summary.startedAtMs),
    summary.finishedAtMs?.let { Readout.duration(it - summary.startedAtMs) },
).joinToString(" · ")
