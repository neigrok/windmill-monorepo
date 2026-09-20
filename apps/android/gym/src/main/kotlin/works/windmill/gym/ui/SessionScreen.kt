package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow
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
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import works.windmill.platform.net.WindmillJson
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.CoachDoors
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
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
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
                    val slot = mine.take(index).count { it.kind == SetKind.Working }
                    Row(
                        set = set,
                        number = set.setNumber ?: (index + 1),
                        note = if (set.kind != SetKind.Working) Note(set.kind.wire)
                               else note(set, against, opening = set.id == opening, slot = slot),
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
        if (entry.isOpen) return Against.Silent
        return Against.Plan(entry, planLine(entry))
    }

    // Read against the slot this working set filled — the Nth working set against the plan's Nth
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

    private fun planLine(entry: PlanEntry): String = "Plan ${Readout.targetWithUnit(entry.sets)}"
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
    coach: CoachDoors,
    backTo: String,
    onBack: () -> Unit,
    say: (String?) -> Unit,
    onOpenMovement: (String) -> Unit,
    onDiscard: (String) -> Unit,
    seed: SessionDetail? = null,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    var detail by rememberSaveable(summary.id, stateSaver = remember(telemetry) { sessionDetailSaver(telemetry) }) { mutableStateOf<SessionDetail?>(seed) }
    var setsFailure by remember(summary.id) { mutableStateOf<WriteFailure?>(null) }
    var review by remember(summary.id) { mutableStateOf<Review?>(null) }
    var read by remember(summary.id) { mutableStateOf(false) }
    var fixing by rememberSaveable(summary.id) { mutableStateOf<String?>(null) }
    var fixSetId by rememberSaveable(summary.id) { mutableStateOf<String?>(null) }
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
    val standing = currentDetail?.let { SessionSummary(it.session, visibleSets.orEmpty()) }
        ?: store.recent.firstOrNull { it.id == summary.id } ?: summary
    var shareOpen by rememberSaveable(summary.id) { mutableStateOf(false) }
    // Null until the read lands, which is a different silence from a session with no sets in it. A
    // set inside its undo window is off the screen and nothing has been sent.
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

    // A delete keys off `deletedSets`, which grows only when the log has ACTUALLY taken the row.
    LaunchedEffect(readId, corrected, store.deletedSets) {
        review = store.review(readId)
        read = true
    }

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            fixing?.let(fixStates::removeState)
            fixing = null
            fixSetId = null
        }
    }

    // The withheld row's undo is the room's transient, not a row inside this scroll: the window has
    // to stay visible while it is open, and a scroll can put a row out of sight.
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
                top = GymLayout.contentTop,
                bottom = GymLayout.scrollTail,
            ),
            verticalArrangement = Arrangement.spacedBy(GymLayout.cardGap),
        ) {
            item("head") { SessionHead(standing) }
            val held = movements
            if (held != null) {
                items(held, key = { it.id }) { movement ->
                    MovementCard(
                        movement = movement,
                        onOpenMovement = onOpenMovement,
                        onFix = { fixing = it; fixSetId = it },
                        onDelete = { row -> store.withhold(Deletion.Set(readId, row)) },
                    )
                }
            }
            if (setsFailure != null || currentDetail?.let(store::retainedSessionFailure) != null) {
                item("failure") {
                    Text(
                        (currentDetail?.let(store::retainedSessionFailure) ?: setsFailure)!!.line("the saved sets are shown"),
                        style = GymType.numeral(13),
                        color = skin.inkDim,
                    )
                }
            }
            if (read) {
                item("review") {
                    Column(Modifier.padding(top = WindmillSpace.x2)) {
                        ReviewRemarks(review, store.catalog)
                    }
                }
            }
            item("share") {
                Column(Modifier.padding(top = WindmillSpace.x2)) {
                    Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).background(skin.raised, RoundedCornerShape(16.dp))
                        .clickable(role = Role.Button) { shareOpen = true }, contentAlignment = Alignment.Center) {
                        Text("Share this workout", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    }
                }
            }
            // The drawn door into the act the log row's long press also reaches: a gesture may
            // replace a control and may never be the only way to an action (13-gestures Law 1). It
            // asks nothing first — the window and its transient ARE the way back, and a confirmation
            // over an act that has an undo is a tap that buys nothing (Law 2). Same words, same
            // window, same undo as every other door into it.
            item("discard") {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = WindmillSpace.x2)
                        .heightIn(min = GymTap.row)
                        .clickable(role = Role.Button, onClick = { onDiscard(readId) }),
                ) {
                    Text(
                        Finish.discard,
                        style = WindmillFont.body(16, FontWeight.SemiBold),
                        color = skin.alarmInk,
                    )
                }
            }
        }
    }

    val open = movements.orEmpty().firstNotNullOfOrNull { movement ->
        movement.rows.firstOrNull { it.id == (fixSetId ?: fixing)?.let(store::canonicalSetId) }?.let { movement.movement to it }
    }
    LaunchedEffect(open?.second?.id) { if (open != null) fixSetId = open.second.id }
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { if (!fixBusy) cancelFixEntry?.invoke() ?: close() },
            sheetState = sheetState,
            properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
            containerColor = skin.surface,
            scrimColor = skin.scrim,
        ) {
            WindmillSheetWindow()
            val (movement, row) = open
            fixStates.SaveableStateProvider(fixing!!) {
            WindmillSheetBack(onDismiss = { if (!fixBusy) cancelFixEntry?.invoke() ?: close() }) {
                FixSheet(
                    set = row.set,
                    draftKey = fixing ?: row.id,
                    movement = movement,
                    setNumber = row.number,
                    routine = standing.plan?.routine,
                    onSave = { fix ->
                        val ended = store.fixSet(readId, row.id, fix)
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
                    // Nothing is told yet: the row comes off the screen and the window opens, because the
                    // log has no undelete. A second delete opens a window of its own and settles nothing.
                    onDelete = {
                        close()
                        say(null)
                        store.withhold(Deletion.Set(readId, row.set))
                    },
                )
            }
            }
        }
    }
    if (shareOpen) ModalBottomSheet(onDismissRequest = { shareOpen = false },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = skin.surface, scrimColor = skin.scrim) {
            WindmillSheetWindow()
        CoachShareCard(coach, readId)
    }

}

@Composable
private fun SessionHead(summary: SessionSummary) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(headLine(summary), style = WindmillFont.body(14), color = skin.inkDim)
        Text("Volume", style = WindmillFont.body(12), color = skin.inkDim)
        Text(summary.tonnageKg?.let { "${Readout.weight(it)} kg" } ?: "—", style = WindmillFont.display(32, FontWeight.ExtraBold), color = skin.ink)
        val count = summary.workingSetCount?.let { "$it working ${if (it == 1) "set" else "sets"}" } ?: Readout.setCount(summary.setCount)
        Text("$count · ${summary.exercises.size} ${if (summary.exercises.size == 1) "movement" else "movements"}", style = WindmillFont.body(14), color = skin.inkDim)
        if (summary.plan != null) Text("Plan saved at start", style = WindmillFont.body(12), color = skin.inkDim)
        if (summary.closedItself) Text("Closed after four hours without a set", style = WindmillFont.body(13), color = skin.inkDim)
    }
}

@Composable
private fun MovementCard(
    movement: Performed.Movement,
    onOpenMovement: (String) -> Unit,
    onFix: (String) -> Unit,
    onDelete: (TrainingSet) -> Unit,
) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.minimum)
                .clickable(role = Role.Button, onClickLabel = "open this movement") { onOpenMovement(movement.id) },
        ) {
            Text(movement.movement, style = WindmillFont.body(20, FontWeight.Bold), color = skin.ink)
            when (val against = movement.against) {
                is Performed.Against.Plan -> Text(against.line, style = WindmillFont.body(13), color = skin.inkDim)
                Performed.Against.Unplanned -> Text("not in the plan", style = WindmillFont.body(13), color = skin.inkDim)
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
    onDelete: (TrainingSet) -> Unit,
) {
    val haptics = rememberGymHaptics()
    // A leading swipe never settles here — and a row put back by a refusal or an Undo arrives with
    // no act owed, which is `rememberRowDismiss`'s whole reason to exist.
    val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
        haptics.revealed()
        onDelete(set.set)
    }
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = false,
        backgroundContent = { DeleteGround() },
        modifier = Modifier.semantics {
            customActions = listOf(CustomAccessibilityAction("Delete") { onDelete(set.set); true })
        },
    ) {
        SetRow(set, onFix)
    }
}

@Composable
private fun DeleteGround() {
    val skin = LocalGymColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.sm))
            .background(skin.alarmInk.copy(alpha = 0.18f))
            .padding(horizontal = GymLayout.rowInset),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Delete", style = GymType.numeral(12, FontWeight.Bold), color = skin.alarmInk)
    }
}

@Composable
private fun SetRow(set: Performed.Row, onFix: (String) -> Unit) {
    val skin = LocalGymColors.current
    val pressing = remember { MutableInteractionSource() }
    val pressed by pressing.collectIsPressedAsState()
    val largeText = LocalDensity.current.fontScale > 1.3f
    Column(Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(12.dp))
        .background(if (pressed) skin.raised else skin.surface)
        .clickable(interactionSource = pressing, indication = null, role = Role.Button,
            onClickLabel = "fix this set") { onFix(set.id) }
        .padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(set.number.toString(), style = GymType.numeral(14), color = skin.inkDim,
                modifier = Modifier.widthIn(min = 24.dp))
            BasicText(set.effort, maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 14.sp, maxFontSize = 18.sp),
                style = GymType.numeral(18).copy(color = skin.ink), modifier = Modifier.weight(1f))
            if (!largeText) set.note?.let { Text(it.text, style = WindmillFont.body(13), color = skin.inkDim) }
        }
        if (largeText) set.note?.let {
            Text(it.text, style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.padding(start = 36.dp))
        }
        SetEffort.line(set.set.rpe, set.set.note)?.let {
            Text(it, style = WindmillFont.body(13), color = skin.inkDim, modifier = Modifier.padding(start = 36.dp))
        }
    }
}

private fun headLine(summary: SessionSummary): String = listOfNotNull(
    Readout.day(summary.startedAtMs),
    summary.finishedAtMs?.let { Readout.duration(it - summary.startedAtMs) },
).joinToString(" · ")
