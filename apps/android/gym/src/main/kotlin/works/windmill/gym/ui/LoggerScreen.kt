package works.windmill.gym.ui

import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow
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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SheetValue
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import works.windmill.gym.R
import works.windmill.gym.domain.WorkoutClocks
import works.windmill.platform.design.WindmillFont
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.WorkoutChange
import works.windmill.gym.domain.NumberEntry
import works.windmill.gym.domain.LoggedSetLimits
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.Readout
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOrigin
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillSpace

// A pinned head and a scrolling set ledger above a fixed rack. All loads remain kilograms.
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

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun LoggerScreen(
    store: TrainingStore,
    say: (String?) -> Unit,
    onFinish: () -> Unit,
    // The transient overlays the ledger without covering the rack.
    transient: SnackbarHostState? = null,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val telemetry = LocalTelemetry.current
    val weightKg = store.rack?.weightKg ?: store.prefill.weightKg
    val reps = store.rack?.reps ?: store.prefill.reps
    val pickerState = rememberMovementPickerState()
    var sheet by rememberSaveable(stateSaver = loggerSheetSaver) { mutableStateOf<LoggerSheet?>(null) }
    val rackOwner = store.accountKey
    val rackSession = store.session?.id
    val rackMovement = store.exerciseId
    var rackEditing by remember(rackOwner, rackSession, rackMovement) { mutableStateOf(false) }
    var fixBusy by remember { mutableStateOf(false) }
    var cancelFixEntry by remember { mutableStateOf<(() -> Unit)?>(null) }
    var goingTo by remember(rackOwner, rackSession) { mutableStateOf<String?>(null) }
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

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    fun close() {
        store.editWorkout(false)
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            sheet?.let { sheetStates.removeState(if (it is LoggerSheet.Fix) "fix:${it.setId}" else it.javaClass.simpleName) }
            sheet = null
        }
    }

    fun move(to: String): Boolean {
        if (goingTo != null) return false
        say(null)
        goingTo = to
        if (sheet != null) close()
        return true
    }

    LaunchedEffect(sheet, goingTo, rackOwner, rackSession) {
        if (sheet != null) return@LaunchedEffect
        val destination = goingTo ?: return@LaunchedEffect
        val previous = store.exerciseId
        try { store.choose(destination) }
        finally {
            if (store.accountKey == rackOwner && store.session?.id == rackSession && goingTo == destination) {
                if (previous != destination && store.exerciseId == destination) {
                    telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "movement_switch", "outcome" to "ok"))
                }
                goingTo = null
            }
        }
    }

    val pickerUp = store.exerciseId == null || sheet == LoggerSheet.Picker
    LaunchedEffect(pickerUp) {
        if (pickerUp) store.loadLastSets()
    }

    LaunchedEffect(sheet) {
        store.editWorkout(rackEditing || sheet is LoggerSheet.Fix)
    }

    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }

    val movement = store.exerciseId
    val order = store.order
    val at = order.indexOf(movement)
    val pagerOrder by rememberUpdatedState(order)
    val pager = rememberPagerState(initialPage = at.coerceAtLeast(0)) { pagerOrder.size }
    var alignedMovement by remember(store.accountKey, store.session?.id) { mutableStateOf<String?>(null) }
    var alignedOrder by remember(store.accountKey, store.session?.id) { mutableStateOf(emptyList<String>()) }
    val bodyDrag = remember { MutableInteractionSource() }
    var dragCancelled by remember(store.accountKey, store.session?.id) { mutableStateOf(false) }
    var dragStopped by remember(store.accountKey, store.session?.id) { mutableStateOf(false) }
    val onMove by rememberUpdatedState<(String) -> Boolean> { move(it) }
    val ready = !pager.isScrollInProgress && pager.currentPageOffsetFraction == 0f && !dragCancelled &&
        order.getOrNull(pager.settledPage) == movement && goingTo == null
    val fling = PagerDefaults.flingBehavior(state = pager)

    LaunchedEffect(store.accountKey, store.session?.id, movement, order) {
        if (alignedMovement == movement && alignedOrder == order) return@LaunchedEffect
        if (at >= 0) {
            with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(at) } }
        }
        alignedMovement = movement
        alignedOrder = order
    }
    LaunchedEffect(pager, store.accountKey, store.session?.id) {
        snapshotFlow {
            if (pager.isScrollInProgress || pager.currentPageOffsetFraction != 0f) null
            else Triple(pager.settledPage, dragCancelled, dragStopped)
        }.collect { settled ->
            val (page, cancelled, stopped) = settled ?: return@collect
            if (cancelled) {
                val current = store.order.indexOf(store.exerciseId)
                if (current >= 0 && page != current) {
                    with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(current) } }
                } else dragCancelled = false
                return@collect
            }
            if (!stopped) return@collect
            dragStopped = false
            if (alignedMovement != store.exerciseId || alignedOrder != store.order) return@collect
            val destination = store.order.getOrNull(page) ?: return@collect
            if (destination == store.exerciseId) return@collect
            if (!onMove(destination)) {
                val current = store.order.indexOf(store.exerciseId)
                if (current >= 0) pager.scrollToPage(current)
            }
        }
    }
    LaunchedEffect(bodyDrag, pager, store.accountKey, store.session?.id) {
        bodyDrag.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> { dragCancelled = false; dragStopped = false }
                is DragInteraction.Stop -> dragStopped = true
                is DragInteraction.Cancel -> {
                    dragStopped = false
                    dragCancelled = true
                    val current = store.order.indexOf(store.exerciseId)
                    if (current >= 0) {
                        with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(current) } }
                    }
                }
            }
        }
    }

    val title = store.session?.plan?.routine ?: Readout.noRoutine
    GymScreen(
        title = title,
        titleAlignment = TextAlign.Center,
        navigation = { TopAction("Finish", enabled = store.canFinish, onClick = onFinish) },
        actions = { Spacer(Modifier.size(48.dp)) },
    ) {
      BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
      val rackMaxHeight = maxHeight
      Column(Modifier.fillMaxSize()
          .scrollable(
              state = pager,
              orientation = Orientation.Horizontal,
              enabled = movement != null && order.size > 1 && sheet == null && goingTo == null && !rackEditing,
              reverseDirection = direction == LayoutDirection.Ltr,
              flingBehavior = fling,
              interactionSource = bodyDrag,
          )) {
        val clocks = store.session?.let { session ->
            WorkoutClocks(session, store.sets.filterNot { it.id in store.withheldIds || it.id in store.deletedSets }, nowMs)
        }
        if (movement == null) {
            Column(Modifier.fillMaxSize().padding(horizontal = GymLayout.gutter)) {
                clocks?.let { WorkoutClockRow(it) }
                Column(
                    Modifier.fillMaxWidth().padding(top = GymLayout.contentTop),
                    verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                ) {
                    StrandedBand(store.strandedCount, store.strandedBy)
                    Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
                }
                // The running session is already drawn twice above — the title and Finish exist only
                // while one runs — so a free session's picker carries no subtitle.
                MovementPicker(
                    catalog = store.catalog,
                    taken = store.order,
                    lastSets = store.lastSets,
                    nowMs = nowMs,
                    sessions = store.recent,
                    title = "What are you lifting?",
                    subtitle = if (store.session?.plan == null) null else "nothing in this plan is left to walk",
                    onPick = { picked -> scope.launch { store.choose(picked) } },
                    onCreate = { name, equipment, id -> store.create(name, equipment, id) },
                    state = pickerState,
                    modifier = Modifier.weight(1f),
                )
            }
            return@Column
        }

        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val pageHeight = maxHeight
            HorizontalPager(
                state = pager,
                key = { pagerOrder[it] },
                beyondViewportPageCount = 1,
                userScrollEnabled = false,
                modifier = Modifier.fillMaxSize().testTag("Movement pager"),
            ) { page ->
                val pageOrder = pagerOrder
                val pageMovement = pageOrder[page]
                val active = pageMovement == movement
                val visible = kotlin.math.abs(pager.currentPage - page + pager.currentPageOffsetFraction) < 1f
                val enabled = active && ready
                val today = store.sets.filter {
                    it.exerciseId == pageMovement && it.id !in store.withheldIds && it.id !in store.deletedSets
                }
                val exercise = store.catalog.firstOrNull { it.id == pageMovement }
                val unit = works.windmill.gym.domain.sync.Readout.loadUnit(exercise?.equipment, exercise?.loadCount ?: 1)
                val slots = LiveLines.slots(today, store.session?.plan?.entry(pageMovement), store.stalled, unit)
                var ledgerBottom by remember(pageMovement) { mutableStateOf(0.dp) }
                val density = LocalDensity.current
                val pageSemantics = if (!visible) Modifier.clearAndSetSemantics {}
                    else Modifier.semantics { if (!active) hideFromAccessibility() }
                // The head stands still and only the ledger scrolls, so a vertical stroke reads the sets
                // and a horizontal one walks.
                Column(
                    Modifier.fillMaxSize().then(pageSemantics).padding(horizontal = GymLayout.gutter),
                ) {
                    MovementHead(
                        name = Readout.movement(pageMovement, store.catalog),
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
                    StrandedBand(store.strandedCount, store.strandedBy)
                    Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
                    Ledger(
                        slots = slots,
                        inHand = active,
                        enabled = enabled,
                        onFix = { sheet = LoggerSheet.Fix(it) },
                        coveredBelow = (transientHeight - (pageHeight - ledgerBottom)).coerceAtLeast(0.dp),
                        modifier = Modifier.heightIn(max = 144.dp).onPlaced {
                            ledgerBottom = with(density) { (it.positionInParent().y + it.size.height).toDp() }
                        },
                    )
                }
            }
            val density = LocalDensity.current
            transient?.let { GymSnackbarHost(it, Modifier.align(Alignment.BottomCenter).testTag("Transient")
                .onSizeChanged { size -> transientHeight = with(density) { size.height.toDp() } }) }
        }
        Rack(
            draftKey = "${store.accountKey}:${store.session?.id}:$movement",
            modifier = Modifier.heightIn(max = rackMaxHeight),
            weightKg = weightKg,
            unit = store.catalog.firstOrNull { it.id == movement }.let {
                works.windmill.gym.domain.sync.Readout.loadUnit(it?.equipment, it?.loadCount ?: 1)
            },
            reps = reps,
            finishing = store.isFinishing || store.workoutFailure != null,
            failure = store.workoutFailure,
            enabled = ready,
            onChange = store::editRack,
            onEdit = { active ->
                if (store.accountKey == rackOwner && store.session?.id == rackSession && store.exerciseId == rackMovement &&
                    rackEditing != active) {
                    rackEditing = active
                    store.editWorkout(active || sheet is LoggerSheet.Fix)
                }
            },
            onLog = {
                val offer = store.notification.value?.offer
                if (offer == null) say(store.workoutFailure ?: "Check the weight and reps before logging.")
                else when (val accepted = store.acceptSet(works.windmill.gym.domain.LogSetCommand(offer.key, offer.id))) {
                    is works.windmill.gym.domain.LogSetAcceptance.Unavailable -> say(accepted.reason)
                    works.windmill.gym.domain.LogSetAcceptance.Stale -> say("The workout changed. Check the current set.")
                    is works.windmill.gym.domain.LogSetAcceptance.Accepted -> say(null)
                }
            },
        )
      }
      }
    }

    // A fix for a set that has since left the ledger has nothing to stand on.
    val fixing = (sheet as? LoggerSheet.Fix)?.let { fix -> store.todaySets.firstOrNull { it.id == fix.setId } }
    val open = sheet?.takeUnless { it is LoggerSheet.Fix && fixing == null }
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { if (!fixBusy) cancelFixEntry?.invoke() ?: close() },
            sheetState = sheetState,
            properties = ModalBottomSheetProperties(shouldDismissOnBackPress = open !is LoggerSheet.Fix),
            containerColor = skin.surface,
            scrimColor = skin.scrim,
        ) {
            WindmillSheetWindow()
            sheetStates.SaveableStateProvider(if (open is LoggerSheet.Fix) "fix:${open.setId}" else open.javaClass.simpleName) {
            when (open) {
                LoggerSheet.Assembly -> AssemblySheet(
                    rows = LiveLines.assemblyRows(store.order, store.sets.filterNot { it.id in store.withheldIds || it.id in store.deletedSets }, store.session?.plan,
                                                  store.catalog, store.exerciseId, store.stalled),
                    routine = store.session?.plan?.routine,
                    onJump = { move(it) },
                    onReorder = { from, to -> store.reorder(from, to) },
                    onDrop = { store.drop(it) },
                    onAdd = { sheet = LoggerSheet.Picker },
                )
                LoggerSheet.Picker -> MovementPicker(
                    catalog = store.catalog,
                    taken = store.order,
                    lastSets = store.lastSets,
                    nowMs = nowMs,
                    sessions = store.recent,
                    title = "Add movement",
                    onPick = { move(it) },
                    onCreate = { name, equipment, id -> store.create(name, equipment, id) },
                    state = pickerState,
                    modifier = Modifier
                        .heightIn(max = pickerMaxHeight())
                        .background(skin.surface)
                        .padding(horizontal = GymLayout.gutter)
                        .padding(bottom = GymLayout.sheetBottom),
                    onClose = { close() },
                )
                is LoggerSheet.Fix -> {
                    val set = fixing!!
                    val sessionId = store.session?.id
                    WindmillSheetBack(onDismiss = { if (!fixBusy) cancelFixEntry?.invoke() ?: close() }) {
                        FixSheet(
                            set = set,
                            exercise = store.catalog.firstOrNull { it.id == set.exerciseId },
                            origin = FixOrigin.Workout,
                            movement = Readout.movement(set.exerciseId, store.catalog),
                            setNumber = set.setNumber ?: (store.todaySets.indexOfFirst { it.id == set.id } + 1),
                            routine = store.session?.plan?.routine,
                            onSave = { fix ->
                                if (sessionId == null) {
                                    telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "fix", "outcome" to "refused"))
                                    FixOutcome.Gone("that workout is no longer open")
                                }
                                else store.fixSet(sessionId, set.id, fix, FixOrigin.Workout)
                            },
                            onSaved = { close(); say(null) },
                            onGone = { close(); say(it) },
                            onBusy = { fixBusy = it },
                            onEntryCancel = { cancelFixEntry = it },
                            onDelete = {
                                close()
                                say(null)
                                if (sessionId != null) scope.launch { say(store.delete(Deletion.Set(sessionId, set))?.line("that set is still on the log")) }
                            },
                        )
                    }
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
        Icon(cloudOffGlyph, contentDescription = null, tint = skin.unsyncedInk,
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
    val coveredPx = with(density) { coveredBelow.roundToPx() }
    LaunchedEffect(landed, inHand, coveredPx, reading.viewportSize) {
        if (!inHand) return@LaunchedEffect
        withFrameNanos {}
        val row = current ?: return@LaunchedEffect
        val window = (reading.viewportSize - coveredPx).coerceAtLeast(0)
        when {
            row.last > reading.value + window -> reading.animateScrollTo(row.last - window)
            row.first < reading.value -> reading.animateScrollTo(row.first)
        }
    }
    Column(modifier.fillMaxWidth().testTag("Set ledger").verticalScroll(reading).padding(bottom = coveredBelow)) {
        slots.forEach { slot ->
            key(if (slot is LiveLines.Slot.Landed) slot.row.id else slot) {
                val active = slot is LiveLines.Slot.Current
                val index = when (slot) {
                    is LiveLines.Slot.Landed -> slot.row.index
                    is LiveLines.Slot.Current -> slot.index.toString()
                    is LiveLines.Slot.Planned -> slot.index.toString()
                }
                val row = (slot as? LiveLines.Slot.Landed)?.row
                Row(
                    Modifier.fillMaxWidth().heightIn(min = GymTap.minimum).clip(RoundedCornerShape(12.dp))
                        .then(if (active) Modifier.background(skin.accentSoft)
                            .drawBehind { drawRect(skin.accent, size = Size(3.dp.toPx(), size.height)) }
                            .onPlaced { current = it.positionInParent().y.toInt().let { top -> top..(top + it.size.height) } }
                        else Modifier)
                        .then(if (row != null) Modifier.clickable(enabled = enabled, role = Role.Button, onClickLabel = "fix this set") { onFix(row.id) } else Modifier)
                        .semantics(mergeDescendants = true) { contentDescription = slot.spoken }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(Modifier.width(indexWidth), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Set $index", style = if (active) WindmillFont.body(16, FontWeight.Bold) else GymType.numeral(16),
                            color = if (active) skin.targetInk else skin.ink)
                        if (row != null) Text("✓", style = WindmillFont.body(16), color = skin.setDone)
                    }
                    slot.line?.let { Text(it, style = GymType.numeral(16), color = if (active) skin.inkDim else skin.ink, modifier = Modifier.weight(1f)) }
                    if (row?.isOnThisDevice == true) Icon(cloudOffGlyph, contentDescription = null, tint = skin.unsyncedInk, modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

@Composable
private fun Rack(
    draftKey: String,
    weightKg: Double,
    unit: String,
    reps: Int,
    finishing: Boolean,
    failure: String?,
    enabled: Boolean,
    onChange: (Double, Int) -> WorkoutChange,
    onEdit: (Boolean) -> Unit,
    onLog: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val skin = LocalGymColors.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val load = rememberNumberDraft(draftKey, NumberEntry.Field.Load, weightKg)
    val count = rememberNumberDraft(draftKey, NumberEntry.Field.Reps, reps.toDouble())
    val loadFeedback = rememberNumberStepperFeedback()
    val panel = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val edge = with(LocalDensity.current) { Brush.verticalGradient(listOf(skin.accent, Color.Transparent), endY = 24.dp.toPx()) }
    DisposableEffect(draftKey) { onDispose { if (load.focused || count.focused) onEdit(false) } }

    fun save(loadValue: Double, repsValue: Int, field: NumberDraft): NumberEditResult {
        if (!enabled || finishing) return NumberEditResult.Refused
        if (loadValue == load.committed && repsValue.toDouble() == count.committed) {
            load.accept(loadValue)
            count.accept(repsValue.toDouble())
            return NumberEditResult.Unchanged
        }
        return when (val result = onChange(loadValue, repsValue)) {
            WorkoutChange.Saved -> {
                val changed = load.accept(loadValue) == NumberEditResult.Changed
                val repsChanged = count.accept(repsValue.toDouble()) == NumberEditResult.Changed
                if (changed || repsChanged) NumberEditResult.Changed else NumberEditResult.Unchanged
            }
            WorkoutChange.Stale -> field.refuse("The workout changed. Check the current set.")
            is WorkoutChange.Unavailable -> field.refuse(result.reason)
        }
    }
    fun commit(field: NumberDraft): NumberEditResult {
        val loadValue = load.read() ?: return NumberEditResult.Refused
        val repsValue = count.read() ?: return NumberEditResult.Refused
        return save(loadValue, repsValue.toInt(), field)
    }
    fun stepLoad(step: NumberStep, big: Boolean): NumberEditResult {
        val loadValue = load.read() ?: return NumberEditResult.Refused
        val repsValue = count.read() ?: return NumberEditResult.Refused
        return save(Ladder.bump(loadValue, if (step == NumberStep.Increase) 1 else -1, big), repsValue.toInt(), load)
    }
    Column(modifier.fillMaxWidth().clip(panel).background(skin.surface).border(1.dp, edge, panel)
        .testTag("Numeric rack").verticalScroll(rememberScrollState())
        .padding(horizontal = GymLayout.gutter, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        NumberStepper(load.text, load::edit, "Load", unit,
            onStep = { stepLoad(it, false) }, onCommit = { commit(load) },
            size = NumberStepperSize.Display, input = NumberStepperInput.SignedDecimal,
            refusal = load.refusal ?: failure, enabled = enabled && !finishing, feedback = loadFeedback,
            onFocusChange = { load.focus(it); onEdit(load.focused || count.focused) })
        LadderRow(load.reading.value ?: load.committed, onDial = { step, big -> loadFeedback.accept(stepLoad(step, big), step) },
            enabled = enabled && !finishing)
        NumberStepper(count.text, count::edit, "Reps", "reps",
            onStep = { step ->
                val loadValue = load.read()
                val repsValue = count.read()
                if (loadValue == null || repsValue == null) NumberEditResult.Refused
                else save(loadValue, Ladder.bumpReps(repsValue.toInt(), if (step == NumberStep.Increase) 1 else -1)
                    .coerceAtMost(LoggedSetLimits.maxReps), count)
            }, onCommit = { commit(count) }, refusal = count.refusal, enabled = enabled && !finishing,
            decreaseEnabled = count.reading.value != 1.0, increaseEnabled = count.reading.value != LoggedSetLimits.maxReps.toDouble(),
            onFocusChange = { count.focus(it); onEdit(load.focused || count.focused) })
        LogButton(finishing, enabled) {
            if (commit(if (count.focused) count else load) != NumberEditResult.Refused) {
                focus.clearFocus()
                keyboard?.hide()
                onEdit(false)
                onLog()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LadderRow(weightKg: Double, onDial: (NumberStep, Boolean) -> Unit, enabled: Boolean = true) {
    val skin = LocalGymColors.current
    CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(color = skin.ink,
        rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.12f, hoveredAlpha = 0.08f, pressedAlpha = 0.12f))) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Ladder.labels(weightKg).forEachIndexed { index, label ->
                FilledTonalButton(
                    onClick = { onDial(if (index < 2) NumberStep.Decrease else NumberStep.Increase, index == 0 || index == 3) },
                    enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                    contentPadding = PaddingValues(0.dp), shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = skin.raised, contentColor = skin.ink),
                ) { Text(label, style = WindmillFont.body(16, FontWeight.Bold), maxLines = 1) }
            }
        }
    }
}

// The store refuses a set once Finish is in flight, so the button says so before the tap. The two
// numerals stand directly above it, so it echoes neither.
@Composable
private fun LogButton(finishing: Boolean, enabled: Boolean, onLog: () -> Unit) {
    val skin = LocalGymColors.current
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.logSet)
            .clip(RoundedCornerShape(16.dp))
            .background(if (finishing) skin.raised else skin.accent)
            .clickable(enabled = enabled && !finishing, role = Role.Button, onClick = onLog),
        contentAlignment = Alignment.Center,
    ) {
        Text("Log set", style = GymType.primary, color = if (finishing) skin.inkDim else skin.onAccent)
    }
}

// Material paths for the two glyphs outside the core icon artifact.
private fun glyph(name: String, path: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp,
                        viewportWidth = 24f, viewportHeight = 24f)
        .addPath(pathData = PathParser().parsePathString(path).toNodes(), fill = SolidColor(Color.Black))
        .build()

private val cloudOffGlyph = glyph(
    "Outlined.CloudOff",
    "M24 15c0-2.64-2.05-4.78-4.65-4.96C18.67 6.59 15.64 4 12 4c-1.33 0-2.57.36-3.65.97l1.49 1.49C10.51 " +
        "6.17 11.23 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45" +
        "C22.93 18.17 24 16.71 24 15zM4.41 3.86L3 5.27l2.77 2.77h-.42C2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6" +
        "h11.73l2 2 1.41-1.41L4.41 3.86zM6 18c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73l8 8H6z",
)
