package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import works.windmill.platform.telemetry.LocalTelemetry
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.runtime.collectAsState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SheetValue
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import works.windmill.gym.R
import works.windmill.gym.presentation.WorkoutClocks
import works.windmill.platform.design.WindmillFont
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.key
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.draw.shadow
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.SideEffect
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.KeepOnBack
import works.windmill.gym.presentation.Blocker
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.gym.presentation.NumberEntry
import works.windmill.gym.presentation.LoggedSetLimits
import works.windmill.gym.presentation.Ladder
import works.windmill.gym.presentation.LiveLines
import works.windmill.gym.presentation.Readout
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.TrainingStore
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Stable
import androidx.compose.ui.tooling.preview.Preview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.sync.Exercise as DomainExercise
import works.windmill.gym.domain.sync.LastTime
import works.windmill.gym.domain.sync.Prefill
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.ExerciseWrite
import works.windmill.gym.presentation.LastSet
import works.windmill.gym.presentation.LogSetAcceptance
import works.windmill.gym.presentation.LogSetCommand
import works.windmill.gym.presentation.PlanEntry
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TheSix
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.WorkoutKey
import works.windmill.gym.presentation.WorkoutNotification
import works.windmill.gym.presentation.WorkoutRack
import works.windmill.gym.store.DeletionsStore
import works.windmill.gym.store.HeldDeletes
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.RefusedWrite
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.WorkoutSession
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.gym.store.MovementCreateOutcome
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillSpace
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

// What the workout draws: the open session, its walk and sets, the rack, and the catalogue and log the picker reads.
@Stable
interface LoggerState {
    val accountKey: String
    val replica: String?
    val notification: StateFlow<WorkoutNotification?>
    val session: Session?
    val sets: List<TrainingSet>
    val todaySets: List<TrainingSet>
    val order: List<String>
    val exerciseId: String?
    val rack: WorkoutRack?
    val prefill: Prefill
    val lastSets: Map<String, LastSet>?
    val stalled: Set<String>
    val strandedCount: Int
    val strandedBy: Blocker?
    val refusals: List<RefusedWrite>
    val isFinishing: Boolean
    val workoutFailure: String?
    val canFinish: Boolean
    val catalog: List<Exercise>
    val recent: List<SessionSummary>
    val withheldIds: Set<String>
    val deletedSets: Set<String>
    fun lastTimeOf(movement: String): LastTime
}

// What the workout asks of the stores.
interface LoggerEvents {
    suspend fun choose(movement: String)
    suspend fun loadLastSets()
    fun editWorkout(open: Boolean): WorkoutChange
    fun editRack(weightKg: Double, reps: Int): WorkoutChange
    fun acceptSet(command: LogSetCommand): LogSetAcceptance
    fun showWorkout(key: WorkoutKey, hidden: Boolean): WorkoutChange
    fun reorder(from: Int, to: Int)
    fun drop(exerciseId: String): Boolean
    suspend fun createForWorkout(write: ExerciseWrite, workoutId: String, expectedAccountKey: String,
        expectedReplica: String?): MovementCreateOutcome
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin): FixOutcome
    suspend fun delete(deletion: Deletion): WriteFailure?
    fun clearRefusals()
}

// The workout over the room's stores.
class LoggerBinding(
    private val seat: TrainingSeat,
    private val held: HeldDeletes,
    private val workout: WorkoutSession,
    private val routines: RoutinesStore,
    private val history: HistoryReads,
    private val deletions: DeletionsStore,
    private val dismissRefusals: () -> Unit,
) : LoggerState, LoggerEvents {
    constructor(store: TrainingStore) : this(store.seat, store.held, store.workout, store.routines, store.history,
        store.deletions, store::clearRefusals)

    override val accountKey: String get() = seat.accountKey
    override val replica: String? get() = seat.replica
    override val notification: StateFlow<WorkoutNotification?> get() = workout.notification
    override val session: Session? get() = workout.session
    override val sets: List<TrainingSet> get() = workout.sets
    override val todaySets: List<TrainingSet> get() = workout.todaySets
    override val order: List<String> get() = workout.order
    override val exerciseId: String? get() = workout.exerciseId
    override val rack: WorkoutRack? get() = workout.rack
    override val prefill: Prefill get() = workout.prefill
    override val lastSets: Map<String, LastSet>? get() = workout.lastSets
    override val stalled: Set<String> get() = workout.stalled
    override val strandedCount: Int get() = workout.strandedCount
    override val strandedBy: Blocker? get() = workout.strandedBy
    override val refusals: List<RefusedWrite> get() = workout.refusals
    override val isFinishing: Boolean get() = workout.isFinishing
    override val workoutFailure: String? get() = workout.workoutFailure
    override val canFinish: Boolean get() = workout.canFinish
    override val catalog: List<Exercise> get() = routines.catalog
    override val recent: List<SessionSummary> get() = history.recent
    override val withheldIds: Set<String> get() = held.withheldIds
    override val deletedSets: Set<String> get() = held.deletedSets
    override fun lastTimeOf(movement: String): LastTime = workout.lastTimeOf(movement)

    override suspend fun choose(movement: String) = workout.choose(movement)
    override suspend fun loadLastSets() = workout.loadLastSets()
    override fun editWorkout(open: Boolean): WorkoutChange = workout.editWorkout(open)
    override fun editRack(weightKg: Double, reps: Int): WorkoutChange = workout.editRack(weightKg, reps)
    override fun acceptSet(command: LogSetCommand): LogSetAcceptance = workout.acceptSet(command)
    override fun showWorkout(key: WorkoutKey, hidden: Boolean): WorkoutChange = workout.showWorkout(key, hidden)
    override fun reorder(from: Int, to: Int) = workout.reorder(from, to)
    override fun drop(exerciseId: String): Boolean = workout.drop(exerciseId)
    override suspend fun createForWorkout(write: ExerciseWrite, workoutId: String, expectedAccountKey: String,
        expectedReplica: String?): MovementCreateOutcome = workout.createForWorkout(write, workoutId, expectedAccountKey, expectedReplica)
    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin): FixOutcome =
        workout.fixSet(sessionId, setId, fix, origin)
    override suspend fun delete(deletion: Deletion): WriteFailure? = deletions.delete(deletion)
    override fun clearRefusals() = dismissRefusals()
}

// The movement page and the rack scroll as one above a pinned Log set. All loads remain kilograms.
private sealed class LoggerSheet {
    data object Assembly : LoggerSheet()
    data object Picker : LoggerSheet()
    data class Fix(val setId: String) : LoggerSheet()
}

private val loggerSheetSaver = Saver<LoggerSheet?, String>(
    save = { when (it) {
        LoggerSheet.Assembly -> "assembly"
        LoggerSheet.Picker -> "picker"
        is LoggerSheet.Fix -> "fix:${it.setId}"
        else -> ""
    } },
    restore = { when {
        it == "assembly" -> LoggerSheet.Assembly
        it == "picker" -> LoggerSheet.Picker
        it.startsWith("fix:") -> LoggerSheet.Fix(it.removePrefix("fix:"))
        else -> null
    } },
)

private data class LoggerMove(val movement: String, val fromPicker: Boolean)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun LoggerScreen(
    state: LoggerState,
    events: LoggerEvents,
    say: (String?) -> Unit,
    onFinish: () -> Unit,
    // The transient overlays the ledger without covering the rack.
    transient: SnackbarHostState? = null,
    onHide: () -> Unit = {},
) {
    val skin = LocalGymColors.current
    val notification = state.notification.collectAsState().value
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    val weightKg = state.rack?.weightKg ?: state.prefill.weightKg
    val reps = state.rack?.reps ?: state.prefill.reps
    val pickerState = rememberMovementPickerState(state.accountKey, state.session?.id)
    var sheet by rememberSaveable(stateSaver = loggerSheetSaver) { mutableStateOf<LoggerSheet?>(null) }
    val rackOwner = state.accountKey
    val rackSession = state.session?.id
    val rackMovement = state.exerciseId
    var rackEditing by remember(rackOwner, rackSession, rackMovement) { mutableStateOf(false) }
    var fixBusy by remember { mutableStateOf(false) }
    var cancelFixEntry by remember { mutableStateOf<(() -> Unit)?>(null) }
    var goingTo by remember(rackOwner, rackSession) { mutableStateOf<LoggerMove?>(null) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    // Zero while nothing is showing: an empty host measures no height.
    var transientHeight by remember { mutableStateOf(0.dp) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { destination ->
            when {
                fixBusy -> false
                destination == SheetValue.Hidden && cancelFixEntry != null -> {
                    cancelFixEntry?.invoke()
                    false
                }
                else -> true
            }
        })
    val sheetStates = rememberSaveableStateHolder()
    val direction = LocalLayoutDirection.current

    LaunchedEffect(sheet, goingTo, rackOwner, rackSession) {
        if (sheet != null) return@LaunchedEffect
        val destination = goingTo ?: return@LaunchedEffect
        val previous = state.exerciseId
        try { events.choose(destination.movement) }
        finally {
            if (state.accountKey == rackOwner && state.session?.id == rackSession && goingTo == destination) {
                if (previous != destination.movement && state.exerciseId == destination.movement) {
                    telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "movement_switch", "outcome" to "ok"))
                }
                if (destination.fromPicker) telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "picker_add",
                    "outcome" to if (state.exerciseId == destination.movement) "ok" else "refused"))
                goingTo = null
            }
        }
    }

    fun cancelPicker() {
        if (sheet != LoggerSheet.Picker) return
        sheet = LoggerSheet.Assembly
        scope.launch { sheetState.show() }
        telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "picker_cancel", "outcome" to "ok"))
    }

    val pickerUp = state.exerciseId == null || sheet == LoggerSheet.Picker
    LaunchedEffect(pickerUp) {
        if (pickerUp) events.loadLastSets()
    }

    LaunchedEffect(sheet) {
        events.editWorkout(rackEditing || sheet is LoggerSheet.Fix)
    }

    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }

    val movement = state.exerciseId
    val order = state.order
    val at = order.indexOf(movement)
    val pagerOrder by rememberUpdatedState(order)
    val pager = rememberPagerState(initialPage = at.coerceAtLeast(0)) { pagerOrder.size }
    var alignedMovement by remember(state.accountKey, state.session?.id) { mutableStateOf<String?>(null) }
    var alignedOrder by remember(state.accountKey, state.session?.id) { mutableStateOf(emptyList<String>()) }
    val bodyDrag = remember { MutableInteractionSource() }
    var dragCancelled by remember(state.accountKey, state.session?.id) { mutableStateOf(false) }
    var dragStopped by remember(state.accountKey, state.session?.id) { mutableStateOf(false) }
    val ready = !pager.isScrollInProgress && pager.currentPageOffsetFraction == 0f && !dragCancelled &&
        order.getOrNull(pager.settledPage) == movement && goingTo == null
    val fling = PagerDefaults.flingBehavior(state = pager)
    val finishing = state.isFinishing || state.workoutFailure != null
    val rackExercise = state.catalog.firstOrNull { it.id == movement }
    val rackKey = "$rackOwner:$rackSession:$movement"
    val entry = RackEntry(
        load = rememberNumberDraft(rackKey, NumberEntry.Field.Load, weightKg, rackExercise?.loadFloor),
        count = rememberNumberDraft(rackKey, NumberEntry.Field.Reps, reps.toDouble()),
        accepting = ready && !finishing,
        change = events::editRack,
    )
    // Back hides the workout as the button does, keeping what is typed first.
    KeepOnBack { entry.leave() }

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    fun close() {
        events.editWorkout(false)
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            sheet?.let { sheetStates.removeState(if (it is LoggerSheet.Fix) "fix:${it.setId}" else it.javaClass.simpleName) }
            sheet = null
        }
    }

    fun move(to: String, fromPicker: Boolean = false): Boolean {
        if (goingTo != null) return false
        entry.leave()
        say(null)
        goingTo = LoggerMove(to, fromPicker)
        if (sheet != null) close()
        return true
    }

    fun hide() {
        entry.leave()
        sheet = null
        onHide()
    }
    val onMove by rememberUpdatedState<(String) -> Boolean> { move(it) }

    LaunchedEffect(state.accountKey, state.session?.id, movement, order) {
        if (alignedMovement == movement && alignedOrder == order) return@LaunchedEffect
        if (at >= 0) {
            with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(at) } }
        }
        alignedMovement = movement
        alignedOrder = order
    }
    LaunchedEffect(pager, state.accountKey, state.session?.id) {
        snapshotFlow {
            if (pager.isScrollInProgress || pager.currentPageOffsetFraction != 0f) null
            else Triple(pager.settledPage, dragCancelled, dragStopped)
        }.collect { settled ->
            val (page, cancelled, stopped) = settled ?: return@collect
            if (cancelled) {
                val current = state.order.indexOf(state.exerciseId)
                if (current >= 0 && page != current) {
                    with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(current) } }
                } else dragCancelled = false
                return@collect
            }
            if (!stopped) return@collect
            dragStopped = false
            if (alignedMovement != state.exerciseId || alignedOrder != state.order) return@collect
            val destination = state.order.getOrNull(page) ?: return@collect
            if (destination == state.exerciseId) return@collect
            if (!onMove(destination)) {
                val current = state.order.indexOf(state.exerciseId)
                if (current >= 0) pager.scrollToPage(current)
            }
        }
    }
    LaunchedEffect(bodyDrag, pager, state.accountKey, state.session?.id) {
        bodyDrag.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> { dragCancelled = false; dragStopped = false }
                is DragInteraction.Stop -> dragStopped = true
                is DragInteraction.Cancel -> {
                    dragStopped = false
                    dragCancelled = true
                    val current = state.order.indexOf(state.exerciseId)
                    if (current >= 0) {
                        with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(current) } }
                    }
                }
            }
        }
    }

    val title = state.session?.plan?.routine ?: Readout.noRoutine
    GymScreen(
        title = title,
        titleAlignment = TextAlign.Center,
        navigation = { TopAction("Finish", enabled = state.canFinish, onClick = { entry.leave(); onFinish() }) },
        actions = { IconButton(onClick = ::hide) {
            Icon(Icons.Rounded.KeyboardArrowDown, "Hide workout", tint = skin.inkDim)
        } },
    ) {
      Column(Modifier.fillMaxSize().imePadding()
          .scrollable(
              state = pager,
              orientation = Orientation.Horizontal,
              enabled = movement != null && order.size > 1 && sheet == null && goingTo == null && !rackEditing,
              reverseDirection = direction == LayoutDirection.Ltr,
              flingBehavior = fling,
              interactionSource = bodyDrag,
          )) {
        val clocks = state.session?.let { session ->
            WorkoutClocks(session, state.sets.filterNot { it.id in state.withheldIds || it.id in state.deletedSets }, nowMs)
        }
        if (movement == null) {
            Column(Modifier.fillMaxSize().padding(horizontal = GymLayout.gutter)) {
                clocks?.let { WorkoutClockRow(it) }
                Column(
                    Modifier.fillMaxWidth().padding(top = GymLayout.contentTop),
                    verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                ) {
                    StrandedBand(state.strandedCount, state.strandedBy)
                    Refusals(state.refusals, state.catalog, onDismiss = { events.clearRefusals() })
                }
                // The running session is already drawn twice above — the title and Finish exist only
                // while one runs — so a free session's picker carries no subtitle.
                MovementPicker(
                    catalog = state.catalog,
                    taken = state.order,
                    lastSets = state.lastSets,
                    nowMs = nowMs,
                    sessions = state.recent,
                    title = "What are you lifting?",
                    subtitle = if (state.session?.plan == null) null else "nothing in this plan is left to walk",
                    onPick = { picked -> scope.launch { events.choose(picked) } },
                    onCreate = { write ->
                        val result = events.createForWorkout(write, rackSession.orEmpty(), rackOwner, state.replica)
                        if (state.accountKey == rackOwner && state.session?.id == rackSession) result
                        else MovementCreateOutcome.Failed(WriteFailure.Refused("The workout changed. Open this again."))
                    },
                    state = pickerState,
                    modifier = Modifier.weight(1f),
                )
            }
            return@Column
        }

        var pageHeight by remember { mutableStateOf(0.dp) }
        Rack(
            entry = entry,
            modifier = Modifier.weight(1f),
            top = {
                val density = LocalDensity.current
                Box(Modifier.fillMaxWidth().onSizeChanged { pageHeight = with(density) { it.height.toDp() } }) {
                    HorizontalPager(
                        state = pager,
                        key = { pagerOrder[it] },
                        beyondViewportPageCount = 1,
                        userScrollEnabled = false,
                        modifier = Modifier.fillMaxWidth().testTag("Movement pager"),
                    ) { page ->
                        val pageOrder = pagerOrder
                        val pageMovement = pageOrder[page]
                        val active = pageMovement == movement
                        val visible = kotlin.math.abs(pager.currentPage - page + pager.currentPageOffsetFraction) < 1f
                        val enabled = active && ready
                        val today = state.sets.filter {
                            it.exerciseId == pageMovement && it.id !in state.withheldIds && it.id !in state.deletedSets
                        }
                        val exercise = state.catalog.firstOrNull { it.id == pageMovement }
                        val unit = Readout.loadUnit(exercise)
                        val slots = LiveLines.slots(today, state.session?.id.orEmpty(), state.session?.plan?.entry(pageMovement), state.lastTimeOf(pageMovement),
                            state.stalled, unit)
                        var ledgerBottom by remember(pageMovement) { mutableStateOf(0.dp) }
                        val pageSemantics = if (!visible) Modifier.clearAndSetSemantics {}
                            else Modifier.semantics { if (!active) hideFromAccessibility() }
                        Column(
                            Modifier.fillMaxWidth().then(pageSemantics).padding(horizontal = GymLayout.gutter),
                        ) {
                            MovementHead(
                                name = Readout.movement(pageMovement, state.catalog),
                                equipment = exercise?.equipment.orEmpty(),
                                place = LiveLines.place(pageOrder, pageMovement),
                                enabled = enabled,
                                previous = pageOrder.getOrNull(page - 1),
                                next = pageOrder.getOrNull(page + 1),
                                onMove = { move(it) },
                                onOpenSession = {
                                    sheet = LoggerSheet.Assembly
                                    telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "open_workout", "outcome" to "ok"))
                                },
                            )
                            clocks?.let { WorkoutClockRow(it) }
                            StrandedBand(state.strandedCount, state.strandedBy)
                            Refusals(state.refusals, state.catalog, onDismiss = { events.clearRefusals() })
                            Ledger(
                                slots = slots,
                                inHand = active,
                                enabled = enabled,
                                onFix = { sheet = LoggerSheet.Fix(it) },
                                coveredBelow = (transientHeight - (pageHeight - ledgerBottom)).coerceAtLeast(0.dp),
                                modifier = Modifier.onPlaced {
                                    ledgerBottom = with(density) { (it.positionInParent().y + it.size.height).toDp() }
                                },
                            )
                        }
                    }
                    transient?.let { GymSnackbarHost(it, Modifier.align(Alignment.BottomCenter).testTag("Transient")
                        .onSizeChanged { size -> transientHeight = with(density) { size.height.toDp() } }) }
                }
            },
            exercise = rackExercise,
            finishing = finishing,
            failure = state.workoutFailure,
            enabled = ready,
            onEdit = { active ->
                if (state.accountKey == rackOwner && state.session?.id == rackSession && state.exerciseId == rackMovement &&
                    rackEditing != active) {
                    rackEditing = active
                    events.editWorkout(active || sheet is LoggerSheet.Fix)
                }
            },
            onLog = {
                val offer = state.notification.value?.offer
                if (offer == null) say(state.workoutFailure ?: "Check the weight and reps before logging.")
                else when (val accepted = events.acceptSet(LogSetCommand(offer.key, offer.id))) {
                    is LogSetAcceptance.Unavailable -> say(accepted.reason)
                    LogSetAcceptance.Stale -> say("The workout changed. Check the current set.")
                    is LogSetAcceptance.Accepted -> say(null)
                }
            },
        )
      }
    }

    // Fix set stands on a row the ledger draws and is titled by that row's count. A fix for a set that has since left
    // the ledger, held or deleted, has nothing to stand on.
    val drawnToday = state.todaySets.filter { it.id !in state.withheldIds && it.id !in state.deletedSets }
    val fixing = (sheet as? LoggerSheet.Fix)?.let { fix -> drawnToday.firstOrNull { it.id == fix.setId } }
    val open = sheet?.takeUnless { it is LoggerSheet.Fix && fixing == null }
    if (open != null) {
        // The picker steps back to the workout sheet. Fix set's own handlers answer Back first: a busy save
        // swallows it and open entry cancels it; a drag waits on the same two through the sheet state.
        WindmillSheet(
            onDismissRequest = { if (open == LoggerSheet.Picker) cancelPicker() else close() },
            onBack = if (open == LoggerSheet.Picker) ::cancelPicker else null,
            sheetState = sheetState,
            containerColor = skin.surface,
            scrimColor = skin.scrim,
        ) {
            sheetStates.SaveableStateProvider(if (open is LoggerSheet.Fix) "fix:${open.setId}" else open.javaClass.simpleName) {
            when (open) {
                LoggerSheet.Assembly -> AssemblySheet(
                    rows = LiveLines.assemblyRows(state.order, state.sets.filterNot { it.id in state.withheldIds || it.id in state.deletedSets }, state.session?.plan,
                                                  state.catalog, state.exerciseId, state.stalled),
                    routine = state.session?.plan?.routine,
                    onJump = { move(it) },
                    onReorder = { from, to ->
                        val before = state.order
                        events.reorder(from, to)
                        if (before != state.order) telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "reorder", "outcome" to "ok"))
                    },
                    onDrop = {
                        val accepted = events.drop(it)
                        telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "remove", "outcome" to if (accepted) "ok" else "refused"))
                        accepted
                    },
                    onHide = ::hide,
                    notificationOff = notification?.hidden == true,
                    onShowNotification = {
                        val result = notification?.key?.let { events.showWorkout(it, false) }
                            ?: WorkoutChange.Unavailable(state.workoutFailure ?: "The workout is not ready.")
                        telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "show_notification",
                            "outcome" to if (result == WorkoutChange.Saved) "ok" else "refused"))
                        if (result is WorkoutChange.Unavailable) { sheet = null; say(result.reason) }
                    },
                    onAdd = {
                        sheet = LoggerSheet.Picker
                        telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "picker_open", "outcome" to "ok"))
                    },
                )
                LoggerSheet.Picker -> MovementPicker(
                    catalog = state.catalog,
                    taken = state.order,
                    lastSets = state.lastSets,
                    nowMs = nowMs,
                    sessions = state.recent,
                    title = "Add movement",
                    onPick = { move(it, fromPicker = true) },
                    onCreate = { write ->
                        val previous = state.exerciseId
                        val result = events.createForWorkout(write, rackSession.orEmpty(), rackOwner, state.replica)
                        if (state.accountKey != rackOwner || state.session?.id != rackSession)
                            MovementCreateOutcome.Failed(WriteFailure.Refused("The workout changed. Open this again."))
                        else {
                            if (result is MovementCreateOutcome.Added && previous != result.movement.id)
                                telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "movement_switch", "outcome" to "ok"))
                            result
                        }
                    },
                    onAdded = {
                        telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "picker_add", "outcome" to "ok"))
                        close()
                    },
                    state = pickerState,
                    modifier = Modifier
                        .heightIn(max = pickerMaxHeight())
                        .background(skin.surface)
                        .padding(horizontal = GymLayout.gutter)
                        .padding(bottom = GymLayout.sheetBottom),
                    onClose = { cancelPicker() },
                )
                is LoggerSheet.Fix -> {
                    val set = fixing!!
                    val sessionId = state.session?.id
                    FixSheet(
                        set = set,
                        exercise = state.catalog.firstOrNull { it.id == set.exerciseId },
                        origin = FixOrigin.Workout,
                        movement = Readout.movement(set.exerciseId, state.catalog),
                        position = drawnToday.indexOf(set) + 1,
                        routine = state.session?.plan?.routine,
                        onSave = { fix ->
                            if (sessionId == null) {
                                telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "fix", "outcome" to "refused"))
                                FixOutcome.Gone("that workout is no longer open")
                            }
                            else events.fixSet(sessionId, set.id, fix, FixOrigin.Workout)
                        },
                        onSaved = { close(); say(null) },
                        onGone = { close(); say(it) },
                        onBusy = { fixBusy = it },
                        onEntryCancel = { cancelFixEntry = it },
                        onDelete = {
                            close()
                            say(null)
                            if (sessionId != null) scope.launch { say(events.delete(Deletion.Set(sessionId, set))?.line("that set is still on the log")) }
                        },
                    )
                }
            }
        }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun WorkoutClockRow(clocks: WorkoutClocks) {
    val skin = LocalGymColors.current
    FlowRow(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(
            Triple("Workout time", R.drawable.gym_clock, clocks.workoutMs),
            Triple(clocks.sinceSetName, R.drawable.gym_stopwatch, clocks.sinceSetMs),
        ).forEach { (name, icon, duration) ->
            val value = Readout.clock(duration)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.clearAndSetSemantics { contentDescription = "$name, $value" }) {
                Icon(painterResource(icon), contentDescription = null, tint = skin.inkDim, modifier = Modifier.size(16.dp))
                Text(value, style = GymType.numeral(14), color = skin.inkDim)
            }
        }
    }
}

@Composable
private fun MovementHead(
    name: String,
    equipment: String,
    place: LiveLines.Place?,
    enabled: Boolean,
    previous: String?,
    next: String?,
    onMove: (String) -> Unit,
    onOpenSession: () -> Unit,
) {
    val skin = LocalGymColors.current
    Column(
        Modifier.fillMaxWidth().heightIn(min = GymTap.minimum)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "open this workout", onClick = onOpenSession)
            .semantics(mergeDescendants = true) {
                place?.let { contentDescription = it.spoken }
                customActions = if (!enabled) emptyList() else buildList {
                    previous?.let { add(CustomAccessibilityAction("Previous movement") { onMove(it); true }) }
                    next?.let { add(CustomAccessibilityAction("Next movement") { onMove(it); true }) }
                }
            }.padding(vertical = 5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
            EquipmentIcon(equipment)
            Text(name, style = WindmillFont.body(22, FontWeight.Bold), color = skin.ink,
                textAlign = TextAlign.Center, modifier = Modifier.weight(1f, fill = false))
        }
        val markers = place?.markers.orEmpty()
        if (markers.isNotEmpty()) Row(Modifier.height(6.dp).clearAndSetSemantics {},
            horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            markers.forEach { marker ->
                val size = if (marker.continuation) 4.dp else 6.dp
                Box(Modifier.size(if (marker.current) 18.dp else size, if (marker.current) 6.dp else size)
                    .background(if (marker.current) skin.accent else skin.inkDim.copy(alpha = 0.45f), RoundedCornerShape(3.dp)))
            }
        }
    }
}

// The one caption that survives: a disclosure at the moment of consequence — your data is not on
// the server — and it exists only while something is wrong.
@Composable
private fun StrandedBand(count: Int, by: Blocker?) {
    val skin = LocalGymColors.current
    val line = LiveLines.onThisDeviceLine(count, by) ?: return
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(painterResource(R.drawable.gym_cloud_off), contentDescription = null, tint = skin.unsyncedInk,
             modifier = Modifier.size(16.dp).padding(top = 1.dp))
        Text(line, style = MaterialTheme.typography.bodySmall, color = skin.inkDim,
             lineHeight = 17.sp, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun Ledger(
    slots: List<LiveLines.Slot>,
    inHand: Boolean,
    enabled: Boolean,
    onFix: (String) -> Unit,
    coveredBelow: Dp,
    modifier: Modifier = Modifier,
) {
    val skin = LocalGymColors.current
    val reading = rememberScrollState()
    var current by remember { mutableStateOf<IntRange?>(null) }
    val landed = slots.count { it is LiveLines.Slot.Landed }
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val indexWidth = remember(slots.size, density, measurer) {
        with(density) {
            maxOf(64.dp, (measurer.measure("Set ${slots.size}", GymType.numeral(16)).size.width + measurer.measure("✓", WindmillFont.body(16)).size.width + 4.dp.roundToPx()).toDp())
        }
    }
    // The window holds three whole rows however tall large text makes them; its rows scroll inside it.
    val heights = remember { mutableStateMapOf<Any, Int>() }
    val keys = slots.map { if (it is LiveLines.Slot.Landed) it.row.id else it }
    val window = keys.mapNotNull { heights[it] }.sortedDescending().take(3).sum()
    SideEffect { heights.keys.retainAll(keys.toSet()) }
    val coveredPx = with(density) { coveredBelow.roundToPx() }
    LaunchedEffect(landed, inHand, coveredPx, reading.viewportSize) {
        if (!inHand) return@LaunchedEffect
        withFrameNanos {}
        val row = current ?: return@LaunchedEffect
        val viewport = (reading.viewportSize - coveredPx).coerceAtLeast(0)
        when {
            row.last > reading.value + viewport -> reading.animateScrollTo(row.last - viewport)
            row.first < reading.value -> reading.animateScrollTo(row.first)
        }
    }
    Column(modifier.fillMaxWidth().heightIn(max = if (window > 0) with(density) { window.toDp() } else 144.dp)
        .testTag("Set ledger").verticalScroll(reading).padding(bottom = coveredBelow)) {
        slots.forEachIndexed { at, slot ->
            key(keys[at]) {
                val active = slot is LiveLines.Slot.Current
                val index = when (slot) {
                    is LiveLines.Slot.Landed -> slot.row.index
                    is LiveLines.Slot.Current -> slot.index.toString()
                    is LiveLines.Slot.Planned -> slot.index.toString()
                }
                val row = (slot as? LiveLines.Slot.Landed)?.row
                // The line stands beside its index while both fit, and wraps under it when they do not.
                FlowRow(
                    Modifier.fillMaxWidth().heightIn(min = GymTap.minimum).onSizeChanged { heights[keys[at]] = it.height }
                        .clip(RoundedCornerShape(12.dp))
                        .then(if (active) Modifier.background(skin.accentSoft)
                            .drawBehind { drawRect(skin.accent, size = Size(3.dp.toPx(), size.height)) }
                            .onPlaced { current = it.positionInParent().y.toInt().let { top -> top..(top + it.size.height) } }
                        else Modifier)
                        .then(if (row != null) Modifier.clickable(enabled = enabled, role = Role.Button, onClickLabel = "fix this set") { onFix(row.id) } else Modifier)
                        .semantics(mergeDescendants = true) { contentDescription = slot.spoken }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                ) {
                    Row(Modifier.width(indexWidth).align(Alignment.CenterVertically), horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text("Set $index", style = if (active) WindmillFont.body(16, FontWeight.Bold) else GymType.numeral(16),
                            color = if (active) skin.targetInk else skin.ink)
                        if (row != null) Text("✓", style = WindmillFont.body(16), color = skin.setDone)
                    }
                    slot.line?.let { Text(it, style = GymType.numeral(16), color = if (active) skin.inkDim else skin.ink,
                        modifier = Modifier.align(Alignment.CenterVertically)) }
                    if (row?.isOnThisDevice == true) Icon(painterResource(R.drawable.gym_cloud_off), contentDescription = null, tint = skin.unsyncedInk,
                        modifier = Modifier.size(14.dp).align(Alignment.CenterVertically))
                }
            }
        }
    }
}

// The rack's two numbers, owned by the screen so that leaving it never drops one. A field commits against what
// the other one stands for; Log set reads both; Hide, Finish, Back and a move commit a valid typed value the way
// Done does, and an invalid one keeps its refusal and the old value.
private class RackEntry(
    val load: NumberDraft,
    val count: NumberDraft,
    private val accepting: Boolean,
    private val change: (Double, Int) -> WorkoutChange,
) {
    fun save(loadValue: Double, repsValue: Int, field: NumberDraft): NumberEditResult {
        if (!accepting) return NumberEditResult.Refused
        if (loadValue == load.committed && repsValue.toDouble() == count.committed) {
            load.accept(loadValue)
            count.accept(repsValue.toDouble())
            return NumberEditResult.Unchanged
        }
        return when (val result = change(loadValue, repsValue)) {
            WorkoutChange.Saved -> {
                val loadChanged = load.accept(loadValue) == NumberEditResult.Changed
                val repsChanged = count.accept(repsValue.toDouble()) == NumberEditResult.Changed
                if (loadChanged || repsChanged) NumberEditResult.Changed else NumberEditResult.Unchanged
            }
            WorkoutChange.Stale -> field.refuse("The workout changed. Check the current set.")
            is WorkoutChange.Unavailable -> field.refuse(result.reason)
        }
    }

    fun commit(field: NumberDraft, both: Boolean = false): NumberEditResult {
        val loadValue = (if (both || field === load) load.read() else load.standing) ?: return NumberEditResult.Refused
        val repsValue = (if (both || field === count) count.read() else count.standing) ?: return NumberEditResult.Refused
        return save(loadValue, repsValue.toInt(), field)
    }

    fun stepLoad(step: NumberStep, big: Boolean): NumberEditResult {
        val loadValue = load.bumped(if (step == NumberStep.Increase) 1 else -1, big) ?: return NumberEditResult.Refused
        return save(loadValue, count.standing.toInt(), load)
    }

    fun stepReps(step: NumberStep): NumberEditResult {
        val repsValue = count.read() ?: return NumberEditResult.Refused
        return save(load.standing, Ladder.bumpReps(repsValue.toInt(), if (step == NumberStep.Increase) 1 else -1)
            .coerceAtMost(LoggedSetLimits.maxReps), count)
    }

    fun leave() {
        if (load.isEdited) commit(load)
        if (count.isEdited) commit(count)
    }
}

// The page above the rack and the rack's controls scroll as one; Log set stays in a band pinned below them. While
// everything fits, the page stands still and the rack sits on the band.
@Composable
private fun Rack(
    entry: RackEntry,
    exercise: Exercise?,
    finishing: Boolean,
    failure: String?,
    enabled: Boolean,
    onEdit: (Boolean) -> Unit,
    onLog: () -> Unit,
    top: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    val skin = LocalGymColors.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val unit = Readout.loadUnit(exercise)
    val load = entry.load
    val count = entry.count
    val page = rememberScrollState()
    val panel = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val edge = with(LocalDensity.current) { Brush.verticalGradient(listOf(skin.accent, Color.Transparent), endY = 24.dp.toPx()) }
    DisposableEffect(load) { onDispose { if (load.focused || count.focused) onEdit(false) } }
    // While a number is typed, the whole rack stands on the band above the keyboard and the page above it scrolls away.
    val typing = load.focused || count.focused
    LaunchedEffect(typing, page.maxValue) { if (typing) page.animateScrollTo(page.maxValue) }
    Column(modifier.fillMaxWidth()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val viewport = constraints.maxHeight
            Layout(content = {
                top()
                Column(Modifier.fillMaxWidth().clip(panel).background(skin.surface).border(1.dp, edge, panel)
                    .testTag("Numeric rack").padding(horizontal = GymLayout.gutter).padding(top = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SetNumbers(load, count, unit, stepLoad = entry::stepLoad, stepReps = entry::stepReps, commit = entry::commit,
                        enabled = enabled && !finishing, loadRefusal = load.shownRefusal ?: failure,
                        onFocusChange = { onEdit(load.focused || count.focused) })
                }
            }, modifier = Modifier.fillMaxWidth().testTag("Rack page").verticalScroll(page)) { measurables, limits ->
                val rack = measurables[1].measure(limits.copy(minHeight = 0, maxHeight = Constraints.Infinity))
                val above = measurables[0].measure(limits.copy(minHeight = (viewport - rack.height).coerceAtLeast(0),
                    maxHeight = Constraints.Infinity))
                layout(limits.maxWidth, above.height + rack.height) {
                    above.placeRelative(0, 0)
                    rack.placeRelative(0, above.height)
                }
            }
        }
        LogBand(lifted = page.maxValue > 0, finishing = finishing, enabled = enabled) {
            if (entry.commit(if (count.focused) count else load, both = true) != NumberEditResult.Refused) {
                focus.clearFocus()
                keyboard?.hide()
                onEdit(false)
                onLog()
            }
        }
    }
}

// The store refuses a set once Finish is in flight, so the button says so before the tap. The two numerals stand
// directly above it, so it echoes neither. Lifted, the band lies over the scrolled page with its own edge.
@Composable
private fun LogBand(lifted: Boolean, finishing: Boolean, enabled: Boolean, onLog: () -> Unit) {
    val skin = LocalGymColors.current
    val shape = if (lifted) RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp) else RectangleShape
    val edge = with(LocalDensity.current) { Brush.verticalGradient(listOf(skin.accent, Color.Transparent), endY = 24.dp.toPx()) }
    Box(
        Modifier.fillMaxWidth()
            .then(if (lifted) Modifier.shadow(16.dp, shape, ambientColor = Color.Black.copy(alpha = 0.25f), spotColor = Color.Black.copy(alpha = 0.25f)) else Modifier)
            .background(skin.surface, shape)
            .then(if (lifted) Modifier.border(1.dp, edge, shape) else Modifier)
            .padding(horizontal = if (lifted) 16.dp else GymLayout.gutter)
            .padding(top = 12.dp, bottom = 16.dp),
    ) {
        // Disabled reads as 02.16's Done at 38 %; finishing reads as the raised wait.
        Button(
            onClick = onLog,
            enabled = enabled && !finishing,
            modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.logSet),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = skin.accent,
                contentColor = skin.onAccent,
                disabledContainerColor = if (finishing) skin.raised else skin.accent.copy(alpha = .38f),
                disabledContentColor = if (finishing) skin.inkDim else skin.onAccent.copy(alpha = .38f),
            ),
        ) {
            Text("Log set", style = GymType.primary)
        }
    }
}

private data class LoggerPreviewState(
    override val session: Session?,
    override val sets: List<TrainingSet> = emptyList(),
    override val order: List<String> = emptyList(),
    override val exerciseId: String? = null,
    override val rack: WorkoutRack? = null,
    override val isFinishing: Boolean = false,
    override val lastSets: Map<String, LastSet>? = emptyMap(),
    override val catalog: List<Exercise> = TheSix.movements,
    override val recent: List<SessionSummary> = emptyList(),
) : LoggerState {
    override val accountKey: String get() = "preview"
    override val replica: String? get() = null
    override val notification: StateFlow<WorkoutNotification?> = MutableStateFlow(null)
    override val todaySets: List<TrainingSet> get() = sets.filter { it.exerciseId == exerciseId }
    override val prefill: Prefill get() = Prefill()
    override val stalled: Set<String> get() = emptySet()
    override val strandedCount: Int get() = 0
    override val strandedBy: Blocker? get() = null
    override val refusals: List<RefusedWrite> get() = emptyList()
    override val workoutFailure: String? get() = null
    override val canFinish: Boolean get() = session != null && !isFinishing
    override val withheldIds: Set<String> get() = emptySet()
    override val deletedSets: Set<String> get() = emptySet()
    override fun lastTimeOf(movement: String): LastTime = LastTime(Id(movement, DomainExercise))
}

private object LoggerPreviewEvents : LoggerEvents {
    override suspend fun choose(movement: String) = Unit
    override suspend fun loadLastSets() = Unit
    override fun editWorkout(open: Boolean): WorkoutChange = WorkoutChange.Saved
    override fun editRack(weightKg: Double, reps: Int): WorkoutChange = WorkoutChange.Saved
    override fun acceptSet(command: LogSetCommand): LogSetAcceptance = LogSetAcceptance.Stale
    override fun showWorkout(key: WorkoutKey, hidden: Boolean): WorkoutChange = WorkoutChange.Saved
    override fun reorder(from: Int, to: Int) = Unit
    override fun drop(exerciseId: String): Boolean = false
    override suspend fun createForWorkout(write: ExerciseWrite, workoutId: String, expectedAccountKey: String,
        expectedReplica: String?): MovementCreateOutcome = MovementCreateOutcome.Failed(WriteFailure.NoAnswer)
    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix, origin: FixOrigin): FixOutcome =
        FixOutcome.Gone("that workout is no longer open")
    override suspend fun delete(deletion: Deletion): WriteFailure? = null
    override fun clearRefusals() = Unit
}

// Push A, forty minutes in: two sets of bench press logged and the third in hand.
private fun benchInHand(finishing: Boolean = false): LoggerPreviewState {
    val startedAt = System.currentTimeMillis() - 40 * 60_000
    val plan = PlanSnapshot("Push A", listOf(
        PlanEntry("bench-press", List(3) { SetTarget(reps = 5, weightKg = 60.0) }),
        PlanEntry("overhead-press", List(3) { SetTarget(reps = 8, weightKg = 40.0) }),
        PlanEntry("barbell-row", List(3) { SetTarget(reps = 8, weightKg = 50.0) }),
    ))
    return LoggerPreviewState(
        session = Session("s1", startedAt, routineId = "push-a", plan = plan),
        sets = listOf(
            TrainingSet("t1", "bench-press", 1, 60.0, 5, completedAtMs = startedAt + 12 * 60_000),
            TrainingSet("t2", "bench-press", 2, 60.0, 5, completedAtMs = startedAt + 16 * 60_000),
        ),
        order = plan.entries.map { it.exerciseId },
        exerciseId = "bench-press",
        rack = WorkoutRack("bench-press", 60.0, 5, basisSetCount = 2, edited = false, revision = 2),
        isFinishing = finishing,
    )
}

// A free workout just opened: nothing in hand, so the picker asks what is lifted.
private fun nothingInHand(): LoggerPreviewState {
    val now = System.currentTimeMillis()
    return LoggerPreviewState(
        session = Session("s2", now - 2 * 60_000),
        lastSets = mapOf(
            "back-squat" to LastSet("back-squat", 100.0, 5, now - 3 * 86_400_000L),
            "deadlift" to LastSet("deadlift", 140.0, 3, now - 5 * 86_400_000L),
        ),
    )
}

@Composable
private fun LoggerPreview(state: LoggerState, dark: Boolean) {
    CompositionLocalProvider(LocalWindmillDark provides dark) {
        GymMaterial { LoggerScreen(state, LoggerPreviewEvents, say = {}, onFinish = {}) }
    }
}

@Preview(name = "Movement in hand · Dark", widthDp = 412, heightDp = 915)
@Composable
private fun MovementInHandDarkPreview() = LoggerPreview(benchInHand(), dark = true)

@Preview(name = "Movement in hand · Daylight", widthDp = 412, heightDp = 915)
@Composable
private fun MovementInHandDaylightPreview() = LoggerPreview(benchInHand(), dark = false)

@Preview(name = "Picker · Dark", widthDp = 412, heightDp = 915)
@Composable
private fun PickerDarkPreview() = LoggerPreview(nothingInHand(), dark = true)

@Preview(name = "Picker · Daylight", widthDp = 412, heightDp = 915)
@Composable
private fun PickerDaylightPreview() = LoggerPreview(nothingInHand(), dark = false)

@Preview(name = "Finishing · Dark", widthDp = 412, heightDp = 915)
@Composable
private fun FinishingDarkPreview() = LoggerPreview(benchInHand(finishing = true), dark = true)

@Preview(name = "Finishing · Daylight", widthDp = 412, heightDp = 915)
@Composable
private fun FinishingDaylightPreview() = LoggerPreview(benchInHand(finishing = true), dark = false)
