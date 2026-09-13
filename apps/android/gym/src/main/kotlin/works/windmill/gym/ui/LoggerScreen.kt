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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import works.windmill.gym.R
import works.windmill.gym.domain.RestReading
import works.windmill.platform.design.WindmillFont
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.DeviationOffer
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.LoggerWalk
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillMotion
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Readings scroll above a fixed rack. All loads remain kilograms.
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

private data class RackDraft(
    val movement: String?,
    val setCount: Int,
    val weightKg: Double,
    val reps: Int,
    val edited: Boolean = false,
) {
    companion object {
        val saver = listSaver<RackDraft, Any>(
            save = { listOf(it.movement.orEmpty(), it.setCount, it.weightKg, it.reps, it.edited) },
            restore = { RackDraft((it[0] as String).ifEmpty { null }, it[1] as Int, it[2] as Double, it[3] as Int, it[4] as Boolean) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun LoggerScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    say: (String?) -> Unit,
    onFinish: () -> Unit,
    onSignIn: () -> Unit,
    onSettings: () -> Unit,
    // The transient overlays readings without covering the rack.
    transient: SnackbarHostState? = null,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    var rack by rememberSaveable(stateSaver = RackDraft.saver) {
        mutableStateOf(RackDraft(store.exerciseId, store.todaySets.size, store.prefill.weightKg, store.prefill.reps))
    }
    val weightKg = rack.weightKg
    val reps = rack.reps
    val pickerState = rememberMovementPickerState()
    var sheet by rememberSaveable(stateSaver = loggerSheetSaver) { mutableStateOf<LoggerSheet?>(null) }
    var fixBusy by remember { mutableStateOf(false) }
    var cancelFixEntry by remember { mutableStateOf<(() -> Unit)?>(null) }
    var goingTo by remember { mutableStateOf<String?>(null) }
    var pendingDeviation by remember { mutableStateOf<DeviationOffer?>(null) }
    var asked by remember { mutableStateOf(setOf<String>()) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
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
    val strip = rememberLazyListState()
    val reading = rememberScrollState()

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    fun close() {
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
    fun move(to: String) {
        val open = pendingDeviation?.let { Readout.movement(it.exerciseId, store.catalog) }
            ?: (sheet as? LoggerSheet.Deviation)?.movement
        if (open != null) {
            say(LoggerWalk.oneAtATime(open))
            return
        }
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

    LaunchedEffect(store.exerciseId, store.todaySets.size, store.prefill) {
        val movement = store.exerciseId ?: return@LaunchedEffect
        val count = store.todaySets.size
        val nextSet = rack.movement != movement || rack.setCount != count
        if (nextSet || !rack.edited) {
            rack = RackDraft(movement, count, store.prefill.weightKg, store.prefill.reps)
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
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
      Column(Modifier.fillMaxSize().padding(horizontal = GymLayout.gutter)) {
        val movement = store.exerciseId
        if (movement == null) {
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
            return@Column
        }

        // A set whose delete window is open is off the strip, and one this room deleted stays off it
        // whatever a read before the delete still holds.
        val today = store.todaySets.filterNot { it.id in store.withheldIds || it.id in store.deletedSets }
        val workingToday = LiveLines.workingCount(today)
        val counter = LiveLines.counter(workingToday, store.planEntry)
        val at = store.order.indexOf(movement)
        val name = Readout.movement(movement, store.catalog)
        val slots = LiveLines.slots(today, store.planEntry, store.stalled)
        val landed = slots.count { it is LiveLines.Slot.Landed }
        val history = store.lastTime
        val historyCard = LiveLines.prefillCard(
            history, routine = store.session?.plan?.routine,
            readFailed = store.lastTimeFailed, now = nowMs,
        )

        // Keep the readings and movement walk together above the rack.
        Box(Modifier.weight(1f).fillMaxWidth()) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val viewport = maxHeight
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = viewport)
                        .verticalScroll(reading),
                    verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    MovementHead(
                        name = name,
                        setLine = counter.replaceFirstChar { it.uppercase() },
                        previous = if (at < 0) null else store.order.getOrNull(at - 1),
                        next = if (at < 0) null else store.order.getOrNull(at + 1),
                        onMove = { move(it) },
                        onOpenSession = { sheet = LoggerSheet.Assembly },
                    )
                    val shown = history?.sets?.let { LiveLines.lastTimeSet(it, workingToday) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        LastTimeChip(history, historyCard, shown, reading = history == null && !store.lastTimeFailed,
                            onDial = { rack = rack.copy(weightKg = it.weightKg, reps = it.reps, edited = true) }, modifier = Modifier.weight(1f))
                        val rest = RestReading(store.restStartedAtMs, store.planEntry, store.preferences)
                        Column(Modifier.weight(1f).heightIn(min = 72.dp),
                            verticalArrangement = Arrangement.Center,
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(if (rest.startedAtMs == null) "Rest target" else "Rest", style = WindmillFont.body(12), color = skin.inkDim)
                            Text(rest.elapsedMs(nowMs)?.let(Readout::clock) ?: rest.target,
                                style = GymType.numeral(24, FontWeight.Bold), color = skin.ink)
                            if (rest.startedAtMs != null && rest.targetSeconds != null) {
                                Text("Target ${rest.target}", style = WindmillFont.body(12), color = skin.inkDim)
                            }
                        }
                    }
                    StrandedBand(store.strandedCount, store.strandedBy)
                    Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
                    if (slots.isNotEmpty()) {
                        SlotStrip(slots, landed, strip, onFix = { sheet = LoggerSheet.Fix(it) })
                    }
                    Spacer(Modifier.height(4.dp))
                    Walk(
                        place = LiveLines.place(store.order, movement),
                        walk = store.order.size,
                        standing = at,
                        onAdd = { sheet = LoggerSheet.Picker },
                    )
                }
                // Scroll after layout so the latest set and movement walk stay reachable.
                LaunchedEffect(landed) {
                    withFrameNanos {}
                    reading.animateScrollTo(reading.maxValue)
                }
            }
            transient?.let { SnackbarHost(it, Modifier.align(Alignment.BottomCenter)) }
        }
        Rack(
            weightKg = weightKg,
            reps = reps,
            finishing = store.isFinishing,
            onWeight = { rack = rack.copy(weightKg = it, edited = true) },
            onReps = { rack = rack.copy(reps = it, edited = true) },
            onTypeWeight = { sheet = LoggerSheet.Weight },
            onTypeReps = { sheet = LoggerSheet.Reps },
            onLog = {
                scope.launch { store.logSet(weightKg, reps) }
            },
        )
      }
    }

    // A fix for a set that has since left the strip has nothing to stand on.
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
                    onCommit = { rack = rack.copy(weightKg = it, edited = true); close() },
                )
                LoggerSheet.Reps -> KeypadSheet(
                    KeypadEntry.Mode.Reps, reps.toDouble(),
                    onCommit = { rack = rack.copy(reps = it.toInt(), edited = true); close() },
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
                            // The pill comes off the strip and the window opens on the room's transient;
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

// The walk is a horizontal stroke on the head, attached ABOVE the name, which is a full-width tap
// target; it claims a gesture only once `LoggerWalk` says the stroke is the walk's — the region
// beneath scrolls vertically and the strip at either edge belongs to the system.
//
// LAW 1, and this is the row where forgetting it would cost the most: TalkBack sees a drag, so the
// two verbs are declared again BY HAND, on the node that already has a label.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MovementHead(
    name: String,
    setLine: String,
    previous: String?,
    next: String?,
    onMove: (String) -> Unit,
    onOpenSession: () -> Unit,
) {
    val skin = LocalGymColors.current
    val density = LocalDensity.current
    val slopPx = with(density) { LoggerWalk.slopDp.dp.toPx() }
    val edgePx = with(density) { LoggerWalk.edgeDp.dp.toPx() }
    var width by remember { mutableFloatStateOf(0f) }
    val steps = remember(previous, next, onMove) {
        buildList {
            previous?.let { add(CustomAccessibilityAction("Previous movement") { onMove(it); true }) }
            next?.let { add(CustomAccessibilityAction("Next movement") { onMove(it); true }) }
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .onSizeChanged { width = it.width.toFloat() }
            .pointerInput(previous, next, slopPx, edgePx) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (LoggerWalk.startsInTheEdge(down.position.x, width, edgePx)) {
                        return@awaitEachGesture
                    }
                    var dx = 0f
                    var dy = 0f
                    var walking = false
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        dx += change.positionChange().x
                        dy += change.positionChange().y
                        if (!walking) walking = LoggerWalk.horizontal(dx, dy, slopPx)
                        // Claimed only once it is ours, so a vertical stroke still reaches the
                        // scroll beneath and a tap still reaches the name.
                        if (walking) change.consume()
                        if (!change.pressed) break
                    }
                    if (walking) LoggerWalk.to(dx, previous, next)?.let(onMove)
                }
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
    ) {
        BasicText(
            name,
            maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = 20.sp, maxFontSize = 30.sp),
            style = WindmillFont.body(30, FontWeight.Bold)
                .copy(color = skin.ink, textAlign = TextAlign.Center),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(role = Role.Button, onClickLabel = "open this session", onClick = onOpenSession)
                .semantics { customActions = steps },
        )
        Box(Modifier.heightIn(min = GymTap.minimum), contentAlignment = Alignment.Center) {
            Text(setLine, style = WindmillFont.body(16), color = skin.inkDim, modifier = Modifier.clickable(role = Role.Button, onClick = onOpenSession).padding(vertical = 12.dp))
        }
    }
}

// One set from last time, on the chip; the whole card — the day, how long ago, the other routine,
// every set — is what the chip SAYS, and the menu under it dials any of those sets.
@Composable
private fun LastTimeChip(
    history: LastTime?,
    card: LiveLines.Card?,
    shown: TrainingSet?,
    reading: Boolean,
    onDial: (TrainingSet) -> Unit,
    modifier: Modifier = Modifier,
) {
    val skin = LocalGymColors.current
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Column(Modifier.fillMaxWidth().heightIn(min = 72.dp)
            .clip(RoundedCornerShape(16.dp)).background(skin.surface)
            .clickable(enabled = shown != null, role = Role.Button) { open = true }
            .semantics(mergeDescendants = true) {
                contentDescription = if (reading) "Last time: Reading…" else card?.let { "${it.title}: ${it.body}" } ?: "Last time: no sets yet"
            }.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center) {
            Text("Last time", style = WindmillFont.body(12), color = skin.inkDim)
            if (shown == null) {
                Text(when {
                    reading -> "Reading…"
                    card != null -> "Didn’t load"
                    else -> "No sets yet"
                }, style = WindmillFont.body(14), color = skin.ink)
            } else {
                BasicText(Readout.effort(shown.weightKg, shown.reps), maxLines = 1,
                    autoSize = TextAutoSize.StepBased(minFontSize = 12.sp, maxFontSize = 18.sp),
                    style = GymType.numeral(18).copy(color = skin.ink, textAlign = TextAlign.Center),
                    modifier = Modifier.fillMaxWidth())
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = skin.surface) {
            card?.let { DropdownMenuItem(text = { Text(it.title, style = WindmillFont.body(13), color = skin.inkDim) },
                onClick = {}, enabled = false) }
            history?.sets.orEmpty().forEach { set ->
                DropdownMenuItem(text = { Text(Readout.effort(set.weightKg, set.reps), color = skin.ink) },
                    onClick = { onDial(set); open = false })
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

// One fixed 32dp of pills that scrolls sideways — the slot strip, the thing you look at right after
// the set landed: every set that landed, then the plan's slots still to come, the current one first.
// A landed pill is the drawn, named door to the fix (Law 1); a pill without the cloud is synced,
// and the cloud says the exception — an absence needs no glyph. A planned pill is no door: there is
// nothing to fix yet. A landed set brings the CURRENT slot into view — by the least scroll that
// shows it whole, never to the leading edge, so the sets already lifted stay on the strip beside it.
@Composable
private fun SlotStrip(slots: List<LiveLines.Slot>, landed: Int, state: LazyListState, onFix: (String) -> Unit) {
    LaunchedEffect(landed) {
        val current = slots.indexOfFirst { it is LiveLines.Slot.Planned && it.current }
        val wanted = if (current < 0) slots.lastIndex else current
        val info = state.layoutInfo
        val shown = info.visibleItemsInfo.firstOrNull { it.index == wanted }
        if (shown == null) {
            state.animateScrollToItem(wanted)
            return@LaunchedEffect
        }
        val past = shown.offset + shown.size - info.viewportEndOffset
        val before = info.viewportStartOffset - shown.offset
        if (past > 0) state.animateScrollBy(past.toFloat())
        else if (before > 0) state.animateScrollBy(-before.toFloat())
    }
    LazyRow(
        state = state,
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
    ) {
        items(
            slots,
            key = { slot ->
                when (slot) {
                    is LiveLines.Slot.Landed -> slot.row.id
                    is LiveLines.Slot.Planned -> "slot-${slot.index}"
                }
            },
        ) { slot ->
            val settling = Modifier.animateItem(
                fadeInSpec = tween(WindmillMotion.baseMs, easing = WindmillMotion.easeSoft),
                placementSpec = tween(WindmillMotion.baseMs, easing = WindmillMotion.easeSoft),
                fadeOutSpec = tween(WindmillMotion.fastMs),
            )
            when (slot) {
                is LiveLines.Slot.Landed -> SetPill(slot.row, onFix, settling)
                is LiveLines.Slot.Planned -> PlannedPill(slot, settling)
            }
        }
    }
}

// Every landed pill is a door: a set still on this device is fixed in the queue it waits in, so the
// corrected body is what lands.
@Composable
private fun SetPill(row: LiveLines.Row, onFix: (String) -> Unit, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Column(modifier.widthIn(min = 118.dp).heightIn(min = 56.dp)
        .clip(RoundedCornerShape(12.dp)).background(skin.setDoneSoft)
        .clickable(role = Role.Button, onClickLabel = "fix this set") { onFix(row.id) }
        .semantics(mergeDescendants = true) { contentDescription = "${if (row.isWarmup) "Warmup" else "Set ${row.index}"}, ${row.value}" }
        .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (row.isWarmup) "Warmup" else "Set ${row.index} ✓", style = WindmillFont.body(11), color = skin.inkDim)
            if (row.isOnThisDevice) Icon(cloudOffGlyph, contentDescription = LiveLines.onThisDevice,
                tint = skin.inkDim, modifier = Modifier.size(14.dp))
        }
        Text(row.value, style = GymType.numeral(15), color = skin.ink)
    }
}

@Composable
private fun PlannedPill(slot: LiveLines.Slot.Planned, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    val shape = RoundedCornerShape(12.dp)
    Column(modifier.widthIn(min = 118.dp).heightIn(min = 56.dp).clip(shape)
        .background(if (slot.current) skin.accentSoft else skin.surface)
        .border(1.dp, if (slot.current) skin.accent else skin.line, shape)
        .semantics(mergeDescendants = true) { contentDescription = slot.spoken }
        .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("Set ${slot.index}", style = WindmillFont.body(11), color = skin.inkDim)
        Text(slot.value, style = GymType.numeral(15), color = if (slot.current) skin.targetInk else skin.inkDim)
    }
}

// The dots are the position readout the swipe needs, and they SAY it — `Movement 1 of 3`, the
// domain's `movement 1 of 3` capitalised. The `+` is the free session's only way to a next movement.
@Composable
private fun Walk(place: String?, walk: Int, standing: Int, onAdd: () -> Unit) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center) {
        place?.let { said ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier.semantics(mergeDescendants = true) {
                    contentDescription = said.replaceFirstChar { it.uppercase() }
                },
            ) {
                repeat(walk) { step ->
                    Box(
                        Modifier
                            .size(width = if (step == standing) 16.dp else 6.dp, height = 6.dp)
                            .clip(CircleShape)
                            .background(if (step == standing) skin.accent else skin.lineStrong),
                    )
                }
            }
        }
        if (walk <= 1) TopAction("Add movement", onClick = onAdd)
        else IconButton(onClick = onAdd, modifier = Modifier.size(GymTap.minimum)) {
            Icon(Icons.Filled.Add, contentDescription = "Add movement", tint = skin.inkDim,
                modifier = Modifier.size(22.dp))
        }
    }
}

// The reach band: what is pressed forty times and its dials, and nothing else. It never scrolls and
// never shrinks.
@Composable
private fun Rack(
    weightKg: Double,
    reps: Int,
    finishing: Boolean,
    onWeight: (Double) -> Unit,
    onReps: (Int) -> Unit,
    onTypeWeight: () -> Unit,
    onTypeReps: () -> Unit,
    onLog: () -> Unit,
) {
    val skin = LocalGymColors.current
    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.heightIn(min = 112.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center) {
            Text("Weight", style = WindmillFont.body(14), color = skin.inkDim,
                modifier = Modifier.clearAndSetSemantics {})
            WeightReadout(weightKg, onTypeWeight)
        }
        LadderRow(weightKg, onDial = onWeight, enabled = !finishing)
        RepsRow(reps, onDial = onReps, onType = onTypeReps)
        LogButton(finishing, onLog)
    }
}

// −102.5 is the widest this readout holds, and it shrinks rather than truncating. The numeral and
// its unit are one node: the tap raises the rack's own keypad, never the system keyboard.
@Composable
private fun WeightReadout(weightKg: Double, onType: () -> Unit) {
    val skin = LocalGymColors.current
    Row(
        Modifier
            .clip(RoundedCornerShape(WindmillRadius.md))
            .clickable(role = Role.Button, onClickLabel = "type a weight", onClick = onType)
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
private fun RepsRow(reps: Int, onDial: (Int) -> Unit, onType: () -> Unit) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Reps", style = WindmillFont.body(14), color = skin.inkDim, modifier = Modifier.weight(1f))
        RepCircle(removeGlyph, "one rep fewer") { onDial(Ladder.bumpReps(reps, direction = -1)) }
        Box(
            Modifier
                .widthIn(min = 72.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button, onClickLabel = "type the reps", onClick = onType)
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
        RepCircle(Icons.Filled.Add, "one rep more") { onDial(Ladder.bumpReps(reps, direction = 1)) }
    }
}

@Composable
private fun RepCircle(glyph: ImageVector, said: String, onTap: () -> Unit) {
    val skin = LocalGymColors.current
    val interaction = remember { MutableInteractionSource() }
    FilledIconButton(
        onClick = onTap,
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
private fun LogButton(finishing: Boolean, onLog: () -> Unit) {
    val skin = LocalGymColors.current
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.logSet)
            .clip(RoundedCornerShape(16.dp))
            .background(if (finishing) skin.raised else skin.accent)
            .clickable(enabled = !finishing, role = Role.Button, onClick = onLog),
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
