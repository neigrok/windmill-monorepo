package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SheetValue
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.graphicsLayer
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
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.DeviationOffer
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.Readout
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillMotion
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A pinned head and a scrolling set ledger above a fixed rack. All loads remain kilograms.
private sealed class LoggerSheet {
    data object Weight : LoggerSheet()
    data object Reps : LoggerSheet()
    data object Assembly : LoggerSheet()
    data object Picker : LoggerSheet()
    data class Deviation(val offer: DeviationOffer, val movement: String) : LoggerSheet()
    data class Fix(val setId: String, val draftKey: String = setId) : LoggerSheet()
}

private val loggerSheetSaver = Saver<LoggerSheet?, String>(
    save = { when (it) {
        LoggerSheet.Weight -> "weight"
        LoggerSheet.Reps -> "reps"
        LoggerSheet.Assembly -> "assembly"
        LoggerSheet.Picker -> "picker"
        is LoggerSheet.Fix -> "fix:${it.setId}:${it.draftKey}"
        else -> ""
    } },
    restore = { when {
        it == "weight" -> LoggerSheet.Weight
        it == "reps" -> LoggerSheet.Reps
        it == "assembly" -> LoggerSheet.Assembly
        it == "picker" -> LoggerSheet.Picker
        it.startsWith("fix:") -> it.removePrefix("fix:").split(':').let { parts -> LoggerSheet.Fix(parts[0], parts.getOrElse(1) { parts[0] }) }
        else -> null
    } },
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun LoggerScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    say: (String?) -> Unit,
    onFinish: () -> Unit,
    onSignIn: () -> Unit,
    onSettings: () -> Unit,
    // The transient overlays the ledger without covering the rack.
    transient: SnackbarHostState? = null,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val weightKg = store.rack?.weightKg ?: store.prefill.weightKg
    val reps = store.rack?.reps ?: store.prefill.reps
    val pickerState = rememberMovementPickerState()
    var sheet by rememberSaveable(stateSaver = loggerSheetSaver) { mutableStateOf<LoggerSheet?>(null) }
    var fixBusy by remember { mutableStateOf(false) }
    var cancelFixEntry by remember { mutableStateOf<(() -> Unit)?>(null) }
    var goingTo by remember { mutableStateOf<String?>(null) }
    var pendingDeviation by remember { mutableStateOf<DeviationOffer?>(null) }
    var asked by remember { mutableStateOf(setOf<String>()) }
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
            sheet?.let { sheetStates.removeState(if (it is LoggerSheet.Fix) "fix:${it.draftKey}" else it.javaClass.simpleName) }
            sheet = null
        }
    }

    // `hide()` on a sheet never shown has no anchor to animate to, so it is closed only if one stands.
    //
    // A swipe arrives faster than a sheet can rise, so a second walk while an offer is still pending
    // is REFUSED rather than overwriting it: the guard below was written for taps, and overwriting
    // would drop the first movement's deviation silently. The refusal is SAID and names the movement
    // whose question is open — a stroke that quietly did nothing reads as a broken stroke.
    fun move(to: String): Boolean {
        val open = pendingDeviation?.let { Readout.movement(it.exerciseId, store.catalog) }
            ?: (sheet as? LoggerSheet.Deviation)?.movement
        if (open != null) {
            say(LiveLines.oneAtATime(open))
            return false
        }
        if (goingTo != null) return false
        say(null)
        val leaving = store.exerciseId
        if (leaving != null && leaving != to) {
            DeviationOffer.leaving(leaving, store.session, store.sets, asked)?.let { offer ->
                asked = asked + leaving
                pendingDeviation = offer
            }
        }
        goingTo = to
        if (sheet != null) close()
        return true
    }

    // Dismiss-then-present: ModalBottomSheet only shows itself on entering composition, so presenting
    // in the frame the old sheet left raises it under the scrim.
    LaunchedEffect(sheet, goingTo) {
        if (sheet != null) return@LaunchedEffect
        goingTo?.let { movement ->
            goingTo = null
            scope.launch { store.choose(movement) }
        }
        val offer = pendingDeviation ?: return@LaunchedEffect
        pendingDeviation = null
        sheet = LoggerSheet.Deviation(offer, Readout.movement(offer.exerciseId, store.catalog))
    }

    val pickerUp = store.exerciseId == null || sheet == LoggerSheet.Picker
    LaunchedEffect(pickerUp) {
        if (pickerUp) store.loadLastSets()
    }

    LaunchedEffect(sheet) {
        store.editWorkout(sheet == LoggerSheet.Weight || sheet == LoggerSheet.Reps || sheet is LoggerSheet.Fix)
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
            else pager.settledPage to dragCancelled
        }.collect { settled ->
            val (page, cancelled) = settled ?: return@collect
            if (cancelled) {
                val current = store.order.indexOf(store.exerciseId)
                if (current >= 0 && page != current) {
                    with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(current) } }
                } else dragCancelled = false
                return@collect
            }
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
                is DragInteraction.Start -> dragCancelled = false
                is DragInteraction.Cancel -> {
                    dragCancelled = true
                    val current = store.order.indexOf(store.exerciseId)
                    if (current >= 0) {
                        with(pager) { scroll(MutatePriority.PreventUserInput) { updateCurrentPage(current) } }
                    }
                }
            }
        }
    }

    val title = store.session?.plan?.routine ?: "Free session"
    // Finish rides the top bar: the band below holds one primary and it is Log set, pressed forty
    // times to Finish's once. The gear is a door to a planning screen, which is what a top corner
    // may hold.
    GymScreen(
        title = title,
        sessionBar = true,
        navigation = { TopAction("Finish", enabled = !store.isFinishing, onClick = onFinish) },
        actions = {
            IconButton(onClick = onSettings) {
                Icon(painterResource(R.drawable.gym_settings), contentDescription = "Gym settings", tint = skin.inkDim, modifier = Modifier.size(24.dp))
            }
        },
    ) {
      Column(Modifier.fillMaxSize()
          .scrollable(
              state = pager,
              orientation = Orientation.Horizontal,
              enabled = movement != null && order.size > 1 && sheet == null && goingTo == null && pendingDeviation == null,
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
                    title = if (store.firstSession) "What are you starting with?" else "What are you lifting?",
                    subtitle = if (store.session?.plan == null) null else "nothing in this plan is left to walk",
                    firstSession = store.firstSession,
                    signedIn = isSignedIn,
                    catalogUnread = store.catalogUnread,
                    onPick = { picked -> scope.launch { store.choose(picked) } },
                    onCreate = { name, equipment, id -> store.create(name, equipment, id) },
                    state = pickerState,
                    onBuildRoutine = onSignIn,
                    modifier = Modifier.weight(1f),
                )
            }
            return@Column
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
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
                val slots = LiveLines.slots(today, store.session?.plan?.entry(pageMovement), store.stalled)
                val pageSemantics = if (!visible) Modifier.clearAndSetSemantics {}
                    else Modifier.semantics { if (!active) hideFromAccessibility() }
                // The head stands still and only the ledger scrolls, so a vertical stroke reads the sets
                // and a horizontal one walks.
                Column(
                    Modifier.fillMaxSize().then(pageSemantics).padding(horizontal = GymLayout.gutter),
                    verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                ) {
                    MovementHead(
                        name = Readout.movement(pageMovement, store.catalog),
                        place = LiveLines.place(pageOrder, pageMovement),
                        enabled = enabled,
                        previous = pageOrder.getOrNull(page - 1),
                        next = pageOrder.getOrNull(page + 1),
                        onMove = { move(it) },
                        onOpenSession = { sheet = LoggerSheet.Assembly },
                    )
                    clocks?.let { WorkoutClockRow(it) }
                    StrandedBand(store.strandedCount, store.strandedBy)
                    Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
                    Ledger(
                        slots = slots,
                        inHand = active,
                        enabled = enabled,
                        onFix = { sheet = LoggerSheet.Fix(it) },
                        onAdd = { sheet = LoggerSheet.Picker },
                        coveredBelow = transientHeight,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            val density = LocalDensity.current
            transient?.let { SnackbarHost(it, Modifier.align(Alignment.BottomCenter).testTag("Transient")
                .onSizeChanged { size -> transientHeight = with(density) { size.height.toDp() } }) }
        }
        Rack(
            weightKg = weightKg,
            reps = reps,
            finishing = store.isFinishing || store.workoutFailure != null,
            enabled = ready,
            onWeight = { store.editRack(it, reps) },
            onReps = { store.editRack(weightKg, it) },
            onTypeWeight = { store.editWorkout(true); sheet = LoggerSheet.Weight },
            onTypeReps = { store.editWorkout(true); sheet = LoggerSheet.Reps },
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

    // A fix for a set that has since left the ledger has nothing to stand on.
    val fixing = (sheet as? LoggerSheet.Fix)?.let { fix -> store.todaySets.firstOrNull { it.id == store.canonicalSetId(fix.setId) } }
    LaunchedEffect(fixing?.id) {
        val target = sheet as? LoggerSheet.Fix
        if (target != null && fixing != null) sheet = target.copy(setId = fixing.id)
    }
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
            sheetStates.SaveableStateProvider(if (open is LoggerSheet.Fix) "fix:${open.draftKey}" else open.javaClass.simpleName) {
            when (open) {
                LoggerSheet.Weight -> KeypadSheet(
                    KeypadEntry.Mode.Weight, weightKg,
                    onCommit = { if (store.editRack(it, reps) is works.windmill.gym.domain.WorkoutChange.Saved) close() },
                )
                LoggerSheet.Reps -> KeypadSheet(
                    KeypadEntry.Mode.Reps, reps.toDouble(),
                    onCommit = { if (store.editRack(weightKg, it.toInt()) is works.windmill.gym.domain.WorkoutChange.Saved) close() },
                )
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
                    catalogUnread = store.catalogUnread,
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
                is LoggerSheet.Deviation -> DeviationSheet(
                    deviation = open.offer,
                    movement = open.movement,
                    onSave = {
                        close()
                        say(null)
                        scope.launch {
                            val why = store.save(open.offer.proposed, toRoutine = open.offer.routineId,
                                                 atPosition = open.offer.position,
                                                 forExercise = open.offer.exerciseId)
                            if (why != null) say(why.line("${open.offer.routine} wasn’t changed"))
                        }
                    },
                    onToday = { close() },
                )
                is LoggerSheet.Fix -> {
                    val set = fixing!!
                    val sessionId = store.session?.id
                    WindmillSheetBack(onDismiss = { if (!fixBusy) cancelFixEntry?.invoke() ?: close() }) {
                        FixSheet(
                            set = set,
                            draftKey = open.draftKey,
                            movement = Readout.movement(set.exerciseId, store.catalog),
                            setNumber = set.setNumber ?: (store.todaySets.indexOfFirst { it.id == set.id } + 1),
                            routine = store.session?.plan?.routine,
                            onSave = { fix ->
                                if (sessionId == null) FixOutcome.Gone("that workout is no longer open")
                                else store.fixSet(sessionId, set.id, fix)
                            },
                            onSaved = { close(); say(null) },
                            onGone = { close(); say(it) },
                            onBusy = { fixBusy = it },
                            onEntryCancel = { cancelFixEntry = it },
                            // The row comes off the ledger and the window opens on the room's transient;
                            // nothing is sent until it closes.
                            onDelete = {
                                close()
                                say(null)
                                if (sessionId != null) store.withhold(Deletion.Set(sessionId, set))
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

// The name opens the session; ‹ and › step the walk, and the name declares both steps to TalkBack
// as well, so a lifter who never sees the glyphs can still leave the first movement.
@Composable
private fun MovementHead(
    name: String,
    place: LiveLines.Place?,
    enabled: Boolean,
    previous: String?,
    next: String?,
    onMove: (String) -> Unit,
    onOpenSession: () -> Unit,
) {
    val skin = LocalGymColors.current
    val steps = remember(previous, next, onMove, enabled) {
        if (!enabled) emptyList() else buildList {
            previous?.let { add(CustomAccessibilityAction("Previous movement") { onMove(it); true }) }
            next?.let { add(CustomAccessibilityAction("Next movement") { onMove(it); true }) }
        }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Step("‹", "Previous movement", previous, enabled, onMove)
        Column(
            Modifier.weight(1f)
                .heightIn(min = GymTap.minimum)
                .clickable(enabled = enabled, role = Role.Button, onClickLabel = "open this session", onClick = onOpenSession)
                .semantics { customActions = steps },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            BasicText(
                name,
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 20.sp, maxFontSize = 28.sp),
                style = WindmillFont.body(28, FontWeight.Bold).copy(color = skin.ink, textAlign = TextAlign.Center),
                modifier = Modifier.fillMaxWidth(),
            )
            place?.let {
                Text(it.shown, style = GymType.numeral(12), color = skin.inkDim,
                    modifier = Modifier.semantics { contentDescription = it.spoken })
            }
        }
        Step("›", "Next movement", next, enabled, onMove)
    }
}

// Drawn at the walk's ends too, dimmed and inert, so the name never shifts sideways between pages.
@Composable
private fun Step(glyph: String, said: String, to: String?, enabled: Boolean, onMove: (String) -> Unit) {
    val skin = LocalGymColors.current
    val live = enabled && to != null
    Box(
        Modifier
            .size(GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.lg))
            .then(if (to == null) Modifier.clearAndSetSemantics {} else Modifier.clickable(enabled = live, role = Role.Button) { onMove(to) }
                .semantics { contentDescription = said }),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, style = WindmillFont.body(22, FontWeight.Bold),
            color = if (to == null) skin.inkFaint.copy(alpha = 0.35f) else skin.ink)
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

// The quiet ledger: every set of this movement in one column, the thing read right after a set
// lands. Logged rows recede and are the door to the fix; the set in hand is the one accented row,
// docked to the rack that edits it; planned rows wait in plain ink. The column labels stand still
// and only the rows scroll. `coveredBelow` is whatever overlays its foot, a transient: the rows gain
// that much room at the end so none has to stay under it.
@Composable
private fun Ledger(
    slots: List<LiveLines.Slot>,
    inHand: Boolean,
    enabled: Boolean,
    onFix: (String) -> Unit,
    onAdd: () -> Unit,
    coveredBelow: Dp,
    modifier: Modifier = Modifier,
) {
    val skin = LocalGymColors.current
    val reading = rememberScrollState()
    val columns = LedgerColumns.measured()
    var current by remember { mutableStateOf<IntRange?>(null) }
    var foot by remember { mutableStateOf<IntRange?>(null) }
    val landed = slots.count { it is LiveLines.Slot.Landed }
    val nothingPlannedAfter = slots.lastOrNull() is LiveLines.Slot.Current
    val coveredPx = with(LocalDensity.current) { coveredBelow.roundToPx() }
    // A landed set, the page becoming the one in hand, and a transient rising over the foot bring the
    // set in hand into view by the least scroll that shows it whole above whatever covers the foot —
    // so it docks just above the rack and the sets already lifted stay above it. With no planned set
    // after it, Add movement is the next thing a lifter may want, so it comes into view with the row
    // whenever both fit.
    LaunchedEffect(landed, inHand, coveredPx) {
        if (!inHand) return@LaunchedEffect
        withFrameNanos {}
        val row = current ?: return@LaunchedEffect
        val window = reading.viewportSize - coveredPx
        val withAdd = foot?.takeIf { nothingPlannedAfter }?.let { row.first..it.last }
        val span = withAdd?.takeIf { it.last - it.first <= window } ?: row
        val bottom = reading.value + window
        when {
            span.last > bottom -> reading.animateScrollTo(span.last - window)
            span.first < reading.value -> reading.animateScrollTo(span.first)
        }
    }
    Column(modifier.fillMaxWidth()) {
        LedgerLine(columns, Modifier.padding(bottom = 4.dp).clearAndSetSemantics {},
            set = { Text("Set", style = WindmillFont.body(12), color = skin.inkDim) },
            weight = { Text("kg", style = WindmillFont.body(12), color = skin.inkDim) },
            reps = { Text("Reps", style = WindmillFont.body(12), color = skin.inkDim) })
        Column(
            Modifier.fillMaxWidth().weight(1f).verticalScroll(reading).padding(bottom = coveredBelow),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            slots.forEach { slot ->
                when (slot) {
                    is LiveLines.Slot.Landed -> key(slot.row.id) { LandedRow(slot, columns, enabled, onFix) }
                    is LiveLines.Slot.Current -> CurrentRow(slot, Modifier.onPlaced {
                        val top = it.positionInParent().y.toInt()
                        current = top..(top + it.size.height)
                    })
                    is LiveLines.Slot.Planned -> PlannedRow(slot, columns)
                }
            }
            Box(Modifier.fillMaxWidth()
                .onPlaced {
                    val top = it.positionInParent().y.toInt()
                    foot = top..(top + it.size.height)
                }
                .padding(vertical = WindmillSpace.x2), contentAlignment = Alignment.Center) {
                TopAction("Add movement", enabled = enabled, onClick = onAdd)
            }
        }
    }
}

// The three columns every ledger line shares, so kg and Reps stand in one line down the ledger. The
// set column is MEASURED off the widest thing it holds, a two-digit index and its ✓, because type
// grows non-linearly with the lifter's scale and a width in sp would not grow with it.
private data class LedgerColumns(val set: Dp, val weight: Dp, val reps: Dp) {
    companion object {
        val tickGap = 4.dp
        val indexStyle = GymType.numeral(15)
        val tickStyle = WindmillFont.body(12, FontWeight.Bold)

        @Composable
        fun measured(): LedgerColumns {
            val density = LocalDensity.current
            val measurer = rememberTextMeasurer()
            return remember(density, measurer) {
                with(density) {
                    // Summed in whole pixels, the unit the row lays its three pieces out in.
                    val index = measurer.measure("88", indexStyle, maxLines = 1).size.width
                    val tick = measurer.measure("✓", tickStyle, maxLines = 1).size.width
                    LedgerColumns(set = (index + tickGap.roundToPx() + tick).toDp(), weight = 90.sp.toDp(), reps = 60.sp.toDp())
                }
            }
        }
    }
}

@Composable
private fun LedgerLine(
    columns: LedgerColumns,
    modifier: Modifier = Modifier,
    set: @Composable () -> Unit,
    weight: @Composable () -> Unit,
    reps: @Composable () -> Unit,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(modifier.fillMaxWidth().padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(columns.set)) { set() }
        Box(Modifier.width(columns.weight)) { weight() }
        Box(Modifier.width(columns.reps)) { reps() }
        trailing()
    }
}

// Every landed row is a door to the fix, which `TrainingStore.fixSet` sends wherever the set lives.
// The cloud marks the exception, a set a walk could not land: a synced row needs no glyph.
@Composable
private fun LandedRow(slot: LiveLines.Slot.Landed, columns: LedgerColumns, enabled: Boolean, onFix: (String) -> Unit) {
    val skin = LocalGymColors.current
    val row = slot.row
    val ink = if (row.isWarmup) skin.inkFaint else skin.inkDim
    LedgerLine(
        columns,
        Modifier.heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "fix this set") { onFix(row.id) }
            .semantics(mergeDescendants = true) { contentDescription = slot.spoken },
        set = {
            Row(horizontalArrangement = Arrangement.spacedBy(LedgerColumns.tickGap), verticalAlignment = Alignment.CenterVertically) {
                Text(row.index, style = LedgerColumns.indexStyle,
                    color = if (row.isWarmup) skin.warmupInk.copy(alpha = 0.7f) else ink, maxLines = 1)
                Text("✓", style = LedgerColumns.tickStyle, color = ink, maxLines = 1)
            }
        },
        weight = { Text(row.weight, style = GymType.numeral(15), color = ink, maxLines = 1) },
        reps = { Text(row.reps.toString(), style = GymType.numeral(15), color = ink, maxLines = 1) },
        trailing = {
            if (row.isOnThisDevice) Icon(cloudOffGlyph, contentDescription = null, tint = skin.unsyncedInk,
                modifier = Modifier.size(14.dp))
        },
    )
}

// The set in hand. The rack below is its editor, so the row names the set and the plan's target and
// repeats none of the draft's numbers; the arrow points at the rack.
@Composable
private fun CurrentRow(slot: LiveLines.Slot.Current, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Row(
        modifier.fillMaxWidth()
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(skin.accentSoft)
            .drawBehind { drawRect(skin.accent, size = Size(3.dp.toPx(), size.height)) }
            .semantics(mergeDescendants = true) { contentDescription = slot.spoken }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Set ${slot.index}", style = WindmillFont.body(15, FontWeight.Bold), color = skin.targetInk, maxLines = 1)
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            slot.targetLine?.let {
                Text("·", style = WindmillFont.body(15, FontWeight.Bold), color = skin.inkFaint)
                Text(it, style = GymType.numeral(14), color = skin.inkDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Text("↓", style = WindmillFont.body(16, FontWeight.Bold), color = skin.targetInk)
    }
}

// No door: there is nothing to fix yet.
@Composable
private fun PlannedRow(slot: LiveLines.Slot.Planned, columns: LedgerColumns) {
    val skin = LocalGymColors.current
    LedgerLine(
        columns,
        Modifier.heightIn(min = GymTap.minimum).semantics(mergeDescendants = true) { contentDescription = slot.spoken },
        set = { Text(slot.index.toString(), style = GymType.numeral(15), color = skin.ink, maxLines = 1) },
        weight = { Text(slot.weight, style = GymType.numeral(15), color = skin.ink, maxLines = 1) },
        reps = { Text(slot.reps, style = GymType.numeral(15), color = skin.ink, maxLines = 1) },
    )
}

// The reach band: what is pressed forty times and its dials, and nothing else. It never scrolls and
// never shrinks.
@Composable
private fun Rack(
    weightKg: Double,
    reps: Int,
    finishing: Boolean,
    enabled: Boolean,
    onWeight: (Double) -> Unit,
    onReps: (Int) -> Unit,
    onTypeWeight: () -> Unit,
    onTypeReps: () -> Unit,
    onLog: () -> Unit,
) {
    val skin = LocalGymColors.current
    val panel = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    // A raised panel whose teal top edge fades down the corners: the rack is where the set in hand is
    // edited, and the ledger's current row points down at it.
    val edge = with(LocalDensity.current) { Brush.verticalGradient(listOf(skin.accent, Color.Transparent), endY = 24.dp.toPx()) }
    Column(Modifier.fillMaxWidth()
        .clip(panel)
        .background(skin.surface)
        .border(1.dp, edge, panel)
        .padding(horizontal = GymLayout.gutter, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.heightIn(min = 112.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center) {
            Text("Weight", style = WindmillFont.body(14), color = skin.inkDim,
                modifier = Modifier.clearAndSetSemantics {})
            WeightReadout(weightKg, enabled, onTypeWeight)
        }
        LadderRow(weightKg, onDial = onWeight, enabled = enabled && !finishing)
        RepsRow(reps, enabled, onDial = onReps, onType = onTypeReps)
        LogButton(finishing, enabled, onLog)
    }
}

// −102.5 is the widest this readout holds, and it shrinks rather than truncating. The numeral and
// its unit are one node: the tap raises the rack's own keypad, never the system keyboard.
@Composable
private fun WeightReadout(weightKg: Double, enabled: Boolean, onType: () -> Unit) {
    val skin = LocalGymColors.current
    Row(
        Modifier
            .clip(RoundedCornerShape(WindmillRadius.md))
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = "type a weight", onClick = onType)
            .semantics(mergeDescendants = true) { contentDescription = "Weight ${Readout.weight(weightKg)} kg" }
            .padding(horizontal = WindmillSpace.x2),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.Bottom,
    ) {
        BasicText(
            Readout.weight(weightKg),
            maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = 40.sp, maxFontSize = 96.sp),
            style = GymType.weight.copy(fontSize = 96.sp, lineHeight = 92.sp, color = skin.weightInk),
            modifier = Modifier.weight(1f, fill = false).lineBox(92.sp).alignByBaseline(),
        )
        Text("kg", style = WindmillFont.body(18, FontWeight.Bold), color = skin.inkDim,
             modifier = Modifier.alignByBaseline())
    }
}

// Four EQUAL pills whose labels are the golden's, by weight band — never a fixed ±1/±5.
@Composable
internal fun LadderRow(weightKg: Double, onDial: (Double) -> Unit, enabled: Boolean = true) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Ladder.labels(weightKg).forEachIndexed { index, label ->
            val big = index == 0 || index == 3
            val interaction = remember { MutableInteractionSource() }
            val shape = RoundedCornerShape(16.dp)
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 56.dp)
                    .pressed(interaction)
                    .clip(shape)
                    .background(skin.raised)
                    .clickable(
                        enabled = enabled,
                        interactionSource = interaction,
                        indication = LocalIndication.current,
                        role = Role.Button,
                        onClickLabel = "change the weight by $label",
                    ) {
                        onDial(Ladder.bump(weightKg, direction = if (index < 2) -1 else 1, big = big))
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = WindmillFont.body(16, FontWeight.Bold), color = if (enabled) skin.ink else skin.inkDim, maxLines = 1)
            }
        }
    }
}

// The number and both adjustments retain separate native touch targets.
@Composable
private fun RepsRow(reps: Int, enabled: Boolean, onDial: (Int) -> Unit, onType: () -> Unit) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Reps", style = WindmillFont.body(14), color = skin.inkDim, modifier = Modifier.weight(1f))
        RepCircle(removeGlyph, "one rep fewer", enabled) { onDial(Ladder.bumpReps(reps, direction = -1)) }
        Box(
            Modifier
                .widthIn(min = 72.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .clickable(enabled = enabled, role = Role.Button, onClickLabel = "type the reps", onClick = onType)
                .semantics(mergeDescendants = true) { contentDescription = "Reps $reps" },
            contentAlignment = Alignment.Center,
        ) {
            AnimatedContent(
                targetState = reps,
                transitionSpec = { fadeIn(tween(WindmillMotion.fastMs)) togetherWith fadeOut(tween(WindmillMotion.fastMs)) },
                label = "reps",
            ) { count ->
                Text(count.toString(), style = GymType.numeral(36, FontWeight.Bold), color = skin.ink, maxLines = 1,
                     modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        RepCircle(Icons.Filled.Add, "one rep more", enabled) { onDial(Ladder.bumpReps(reps, direction = 1)) }
    }
}

@Composable
private fun RepCircle(glyph: ImageVector, said: String, enabled: Boolean, onTap: () -> Unit) {
    val skin = LocalGymColors.current
    val interaction = remember { MutableInteractionSource() }
    FilledIconButton(
        onClick = onTap,
        enabled = enabled,
        interactionSource = interaction,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.size(GymTap.primary).pressed(interaction),
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = skin.raised,
            contentColor = skin.ink,
        ),
    ) {
        Icon(glyph, contentDescription = said, modifier = Modifier.size(28.dp))
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

// A display numeral stands in exactly the line box its style names — 72 sp for the weight, 60 for
// the reps — so the rack's height is arithmetic. The text engine will not do this itself: a
// `lineHeight` under the face's own 1.17 em is measured at the face's height whatever
// `LineHeightStyle` asks, so the box is laid out here and the glyphs sit centred in it. Digits have
// no descenders and the face's headroom is wider than what is cut, so nothing is clipped; the
// baseline still rides through for `kg`.
private fun Modifier.lineBox(height: TextUnit): Modifier = layout { measurable, constraints ->
    val text = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
    val box = height.roundToPx()
    layout(text.width, box) { text.placeRelative(0, (box - text.height) / 2) }
}

// A pressed control settles to 0.96 and back; nothing bounces.
@Composable
private fun Modifier.pressed(interaction: MutableInteractionSource): Modifier {
    val down by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        if (down) 0.96f else 1f,
        tween(WindmillMotion.fastMs, easing = WindmillMotion.easeSoft),
        label = "press",
    )
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

// Material paths for the two glyphs outside the core icon artifact.
private fun glyph(name: String, path: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp,
                        viewportWidth = 24f, viewportHeight = 24f)
        .addPath(pathData = PathParser().parsePathString(path).toNodes(), fill = SolidColor(Color.Black))
        .build()

private val removeGlyph = glyph("Filled.Remove", "M19 13H5v-2h14v2z")

private val cloudOffGlyph = glyph(
    "Outlined.CloudOff",
    "M24 15c0-2.64-2.05-4.78-4.65-4.96C18.67 6.59 15.64 4 12 4c-1.33 0-2.57.36-3.65.97l1.49 1.49C10.51 " +
        "6.17 11.23 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45" +
        "C22.93 18.17 24 16.71 24 15zM4.41 3.86L3 5.27l2.77 2.77h-.42C2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6" +
        "h11.73l2 2 1.41-1.41L4.41 3.86zM6 18c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73l8 8H6z",
)
