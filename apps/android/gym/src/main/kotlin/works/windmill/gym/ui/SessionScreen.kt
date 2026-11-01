package works.windmill.gym.ui

import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import works.windmill.platform.design.WindmillSheet
import works.windmill.gym.sharing.WorkoutShareCard
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.Stable
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Ladder
import works.windmill.gym.presentation.PlanEntry
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Review
import works.windmill.gym.presentation.Scheme
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.SetEffort
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TheSix
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.DeletionsStore
import works.windmill.gym.store.HeldDeletes
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WorkoutSession
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

// What the workout page draws.
@Stable
interface SessionState {
    val catalog: List<Exercise>
    val allSessions: List<SessionSummary>
    val deletedSets: Set<String>
    fun retainedSession(detail: SessionDetail): SessionDetail
}

// What the workout page asks of the stores.
interface SessionEvents {
    suspend fun sessionDetail(sessionId: String, seed: SessionDetail?): GymResult<SessionDetail>
    suspend fun review(of: String): Review?
    suspend fun delete(deletion: Deletion): WriteFailure?
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin): FixOutcome
}

// The workout page over the room's stores.
class SessionBinding(
    private val history: HistoryReads,
    private val held: HeldDeletes,
    private val routines: RoutinesStore,
    private val workout: WorkoutSession,
    private val deletions: DeletionsStore,
) : SessionState, SessionEvents {
    constructor(store: TrainingStore) : this(store.history, store.held, store.routines, store.workout, store.deletions)

    override val catalog: List<Exercise> get() = routines.catalog
    override val allSessions: List<SessionSummary> get() = history.allSessions
    override val deletedSets: Set<String> get() = held.deletedSets
    override fun retainedSession(detail: SessionDetail): SessionDetail = history.retainedSession(detail)
    override suspend fun sessionDetail(sessionId: String, seed: SessionDetail?): GymResult<SessionDetail> =
        history.sessionDetail(sessionId, seed)
    override suspend fun review(of: String): Review? = history.review(of)
    override suspend fun delete(deletion: Deletion): WriteFailure? = deletions.delete(deletion)
    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin): FixOutcome =
        workout.fixSet(sessionId, setId, fix, origin)
}

// The frozen plan beside these rows is a snapshot and is the ONLY source for what the plan said.
object Performed {
    data class Note(val text: String, val short: Boolean = false)

    sealed interface Against {
        data class Plan(val entry: PlanEntry, val line: String) : Against
        data object Unplanned : Against
        data object Silent : Against
    }

    // `position` counts the movement's sets 1..N in logged order, so the rows that remain after a delete count again.
    // The workout page draws it and never the log's own `setNumber`, which keeps a delete's gap and can read 2, 3, 1.
    data class Row(val set: TrainingSet, val position: Int, val note: Note?, val unit: String) {
        val id: String get() = set.id
        val effort: String get() = Readout.effort(set.weightKg, set.reps)

        // A copy kept on this phone is inspected by the numbers it saved, the ones a `source-numbering` refusal names.
        val savedNumber: Int get() = set.setNumber ?: position

        // The quiet digit is drawn bare; TalkBack hears it named, with the load's unit and the reps spelled out.
        val spoken: String
            get() = listOfNotNull("Set $position", "${Readout.weight(set.weightKg)} $unit", Readout.repCount(set.reps),
                note?.text, set.rpe?.let(SetEffort::rpeReading), set.note.trim().takeIf { it.isNotEmpty() }).joinToString(", ")
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
        // Logged order; two sets logged at the same instant keep one order by their ids.
        val performed = sets.sortedWith(compareBy({ it.completedAtMs }, { it.id }))
        val order = mutableListOf<String>()
        for (set in performed) if (set.exerciseId !in order) order.add(set.exerciseId)

        return order.map { exerciseId ->
            val mine = performed.filter { it.exerciseId == exerciseId }
            val exercise = catalog.find { it.id == exerciseId }
            val against = planned(plan, exerciseId, exercise)
            val unit = Readout.loadUnit(exercise)
            Movement(
                id = exerciseId,
                movement = Readout.movement(exerciseId, catalog),
                against = against,
                equipment = exercise?.equipment,
                rows = mine.mapIndexed { slot, set ->
                    Row(
                        set = set,
                        position = slot + 1,
                        note = note(set, against, opening = slot == 0, slot = slot),
                        unit = unit,
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
    state: SessionState,
    events: SessionEvents,
    sharing: WorkoutShareActions,
    backTo: String,
    onBack: () -> Unit,
    say: (String?) -> Unit,
    onOpenMovement: (String) -> Unit,
    onDiscard: (String) -> Unit,
    seed: SessionDetail? = null,
    onDraftOpen: (Boolean) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
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
    var corrected by remember(summary.id) { mutableIntStateOf(0) }
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

    val currentDetail = detail?.let(state::retainedSession)
    val readId = currentDetail?.session?.id ?: summary.id
    val visibleSets = currentDetail?.sets?.filterNot { it.id in state.deletedSets }
    val standing = currentDetail?.let { SessionSummary(it.session, visibleSets.orEmpty(), state.catalog) }
        ?: state.allSessions.firstOrNull { it.id == summary.id } ?: summary
    var shareOpen by rememberSaveable(summary.id) { mutableStateOf(false) }
    // Null until the read lands, distinct from a workout with no sets.
    val movements = currentDetail?.let { held ->
        Performed.movements(
            held.sets.filterNot { it.id in state.deletedSets },
            state.catalog,
            held.session.plan,
        )
    }

    LaunchedEffect(currentDetail) {
        if (currentDetail != null && detail != currentDetail) detail = currentDetail
    }

    LaunchedEffect(readId) {
        when (val found = events.sessionDetail(readId, currentDetail)) {
            is GymResult.Ok -> { detail = found.value; setsFailure = null }
            is GymResult.Failed -> setsFailure = found.why
        }
    }

    // A deleted or restored row changes the review as well as the set list.
    LaunchedEffect(readId, corrected, state.deletedSets) {
        review = events.review(readId)
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
                            val failure = events.delete(Deletion.Set(readId, row))
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
                        style = GymType.numeral,
                        color = colors.onSurfaceVariant,
                    )
                }
            }
            if (read && (review == null || Finish.recordSentence(review?.record, state.catalog) != null ||
                    Finish.comparison(review?.against, state.catalog) != null)) {
                item("review") { ReviewRemarks(review, state.catalog) }
            }
            item("actions") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(16.dp)).background(colors.surfaceContainerHighest)
                        .clickable(role = Role.Button) { shareOpen = true }, contentAlignment = Alignment.Center) {
                        Text("Share this workout", style = WindmillType.label, color = colors.onSurface)
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
            containerColor = colors.surfaceContainer,
            scrimColor = colors.scrim,
        ) {
            val (movement, row) = open
            fixStates.SaveableStateProvider(fixing!!) {
            FixSheet(
                set = row.set,
                exercise = state.catalog.firstOrNull { it.id == row.set.exerciseId },
                origin = FixOrigin.Session,
                movement = movement,
                position = row.position,
                routine = standing.plan?.routine,
                onSave = { fix ->
                    val ended = events.fixSet(readId, row.id, fix, FixOrigin.Session)
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
                    scope.launch { say(events.delete(Deletion.Set(readId, row.set))?.line("that set is still on the log")) }
                },
            )
            }
        }
    }
    if (shareOpen) WindmillSheet(onDismissRequest = { shareOpen = false },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surfaceContainer, scrimColor = colors.scrim) {
        WorkoutShareCard(sharing, readId)
    }

}

@Composable
private fun SessionHead(summary: SessionSummary) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(headLine(summary), style = WindmillType.detail, color = colors.onSurfaceVariant)
        Text("Volume", style = WindmillType.caption, color = colors.onSurfaceVariant)
        Text(summary.tonnageKg?.let { "${Readout.weight(it)} kg" } ?: "—",
            style = GymType.sessionVolume, color = colors.onSurface)
        val count = Readout.setCount(summary.workingSetCount ?: summary.setCount)
        Text("$count · ${summary.exercises.size} ${if (summary.exercises.size == 1) "movement" else "movements"}", style = WindmillType.detail, color = colors.onSurfaceVariant)
        if (summary.plan != null) Text("Plan saved at start", style = WindmillType.caption, color = gymColors.inkFaint)
        if (summary.closedItself) Text("Closed after four hours without a set", style = WindmillType.detailCompact, color = colors.onSurfaceVariant)
    }
}

@Composable
private fun MovementCard(
    movement: Performed.Movement,
    onOpenMovement: (String) -> Unit,
    onFix: (String) -> Unit,
    onDelete: suspend (TrainingSet) -> Boolean,
) {
    val colors = MaterialTheme.colorScheme
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
                movement.equipment?.let { EquipmentIcon(it, Modifier.size(20.dp), tint = colors.onSurfaceVariant) }
                Text(movement.movement, style = GymType.heading,
                    color = colors.onSurface, modifier = Modifier.weight(1f))
            }
            when (val against = movement.against) {
                is Performed.Against.Plan -> Text(against.line, style = WindmillType.caption, color = colors.onSurfaceVariant)
                Performed.Against.Unplanned -> Text("not in the plan", style = WindmillType.caption, color = colors.onSurfaceVariant)
                Performed.Against.Silent -> Unit
            }
        }
        // One group of sets. KEYED by the set: a swipe box remembered by its POSITION would hand the row that moves
        // up into a deleted row's slot the dismissed state that belongs to the row that left.
        Column(verticalArrangement = Arrangement.spacedBy(GymSegment.gap), modifier = Modifier.fillMaxWidth()) {
            movement.rows.forEachIndexed { index, performed ->
                key(performed.id) {
                    val shape = GymSegment.shape(index, movement.rows.size)
                    DeleteSwipeRow(actionLabel = "Delete", onDelete = { onDelete(performed.set) }, shape = shape, declaresAction = false) {
                        SetRow(performed, shape, onFix, onDelete)
                    }
                }
            }
        }
    }
}

// Tap to fix, swipe to delete — one trailing action and nothing on the leading edge, because two
// actions would push the set's count and load off the row a lifter is deciding about.
//
// LAW 1, and on Android it is the half that is easy to forget: TalkBack sees a drag, so the same
// action is declared again BY HAND on the row. This row carries no overflow to inherit it from, and it
// is its own TalkBack stop, so the action sits on it rather than on the swipe around it.
//
// The row says itself once, as `Performed.Row.spoken`. The count sits on the load's baseline in a column at
// least 24 dp wide, so the load starts 40 dp in on every row and a second line starts under it; a count too
// wide for the column, two digits at 200 % text, widens its own row's column rather than clipping.
@Composable
private fun SetRow(set: Performed.Row, shape: Shape, onFix: (String) -> Unit, onDelete: suspend (TrainingSet) -> Boolean) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val scope = rememberCoroutineScope()
    val pressing = remember { MutableInteractionSource() }
    val pressed by pressing.collectIsPressedAsState()
    val largeText = GymTextScale.large
    val underLoad = Modifier.padding(start = 24.dp)
    Column(Modifier.fillMaxWidth().heightIn(min = GymTap.minimum).clip(shape)
        .background(if (pressed) colors.surfaceContainerHighest else colors.surfaceContainer)
        .clickable(interactionSource = pressing, indication = null) { onFix(set.id) }
        .clearAndSetSemantics {
            contentDescription = set.spoken
            role = Role.Button
            onClick("fix this set") { onFix(set.id); true }
            customActions = listOf(CustomAccessibilityAction("Delete") { scope.launch { onDelete(set.set) }; true })
        }
        .padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f)) {
                Text(set.position.toString(), style = GymType.setPosition, color = gymColors.inkFaint,
                    maxLines = 1, softWrap = false, modifier = Modifier.widthIn(min = 24.dp).alignByBaseline())
                BasicText(set.effort, maxLines = 1,
                    autoSize = GymType.setLoadFit,
                    style = GymType.setLoad.copy(color = colors.onSurface),
                    modifier = Modifier.weight(1f).alignByBaseline())
            }
            if (!largeText) set.note?.let { Text(it.text, style = WindmillType.caption, color = colors.onSurfaceVariant) }
        }
        if (largeText) set.note?.let {
            Text(it.text, style = WindmillType.caption, color = colors.onSurfaceVariant, modifier = underLoad)
        }
        SetEffort.line(set.set.rpe, set.set.note)?.let {
            Text(it, style = WindmillType.detailCompact, color = colors.onSurfaceVariant, modifier = underLoad)
        }
    }
}

private fun headLine(summary: SessionSummary): String = listOfNotNull(
    Readout.day(summary.startedAtMs),
    summary.finishedAtMs?.let { Readout.duration(it - summary.startedAtMs) },
).joinToString(" · ")

private data class PreviewSessionState(
    override val catalog: List<Exercise> = TheSix.movements,
    override val allSessions: List<SessionSummary> = emptyList(),
    override val deletedSets: Set<String> = emptySet(),
) : SessionState {
    override fun retainedSession(detail: SessionDetail): SessionDetail = detail
}

// Nothing answers, so the seeded workout stands.
private object PreviewSessionEvents : SessionEvents {
    override suspend fun sessionDetail(sessionId: String, seed: SessionDetail?): GymResult<SessionDetail> = awaitCancellation()
    override suspend fun review(of: String): Review? = awaitCancellation()
    override suspend fun delete(deletion: Deletion): WriteFailure? = awaitCancellation()
    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin): FixOutcome = awaitCancellation()
}

@DarkAndDaylight
@Composable
private fun FinishedWorkoutPreview() {
    val started = 1_761_984_000_000L
    val plan = PlanSnapshot("Push Day", listOf(
        PlanEntry("bench-press", List(3) { SetTarget(8, 75.0) }),
        PlanEntry("overhead-press", List(2) { SetTarget(6, 47.5) }),
    ))
    val workout = SessionDetail(Session("session-push", started, started + 52 * 60_000L, "routine-push", plan), listOf(
        TrainingSet("set-1", "bench-press", 1, 75.0, 8, completedAtMs = started + 6 * 60_000L),
        TrainingSet("set-2", "bench-press", 2, 75.0, 6, rpe = 9.0, completedAtMs = started + 10 * 60_000L),
        TrainingSet("set-3", "bench-press", 3, 80.0, 8, completedAtMs = started + 14 * 60_000L),
        TrainingSet("set-4", "overhead-press", 1, 47.5, 6, completedAtMs = started + 24 * 60_000L),
        TrainingSet("set-5", "overhead-press", 2, 47.5, 5, note = "Left shoulder tight", completedAtMs = started + 28 * 60_000L),
    ))
    GymPreview {
        SessionScreen(
            summary = SessionSummary(workout.session, workout.sets, TheSix.movements),
            state = PreviewSessionState(),
            events = PreviewSessionEvents,
            sharing = WorkoutShareActions("https://windmill.works", { awaitCancellation() }, { awaitCancellation() }),
            backTo = "The log", onBack = {}, say = {}, onOpenMovement = {}, onDiscard = {}, seed = workout,
        )
    }
}
