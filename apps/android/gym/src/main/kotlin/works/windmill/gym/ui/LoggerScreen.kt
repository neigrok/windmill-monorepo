package works.windmill.gym.ui

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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
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
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
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
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Rest
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.FixOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillMotion
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// The live training screen. Two regions: the READING region (name, set line, history, clocks, the
// logged strip, the walk's dots) is the one elastic part and scrolls only when the largest text
// leaves it no room; the RACK (Weight, the ladder, Reps, Log set) is pinned to the bottom and never
// moves, because it is what a hand with a bar in it presses forty times.
//
// Every weight and rep tap goes through `Ladder`, and every weight is kilograms in and out. The
// domain's bytes — `set 2 of 4`, `movement 1 of 3`, `resting · target 1:30 · from the routine` —
// are capitalised or spoken at the draw site and never rewritten.

private sealed class LoggerSheet {
    data object Weight : LoggerSheet()
    data object Reps : LoggerSheet()
    data object Assembly : LoggerSheet()
    data object Picker : LoggerSheet()
    data class Deviation(val offer: DeviationOffer, val movement: String) : LoggerSheet()
    data class Fix(val setId: String) : LoggerSheet()
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
    // The room's transient, hosted HERE while the logger stands: it lands over the reading region
    // with its foot on the hairline, so no control of the rack is ever under it. `null` hosts none.
    transient: SnackbarHostState? = null,
) {
    val scope = rememberCoroutineScope()
    val preferences = store.preferences
    val confirm = rememberGymConfirm(preferences)
    var weightKg by remember { mutableDoubleStateOf(store.prefill.weightKg) }
    var reps by remember { mutableIntStateOf(store.prefill.reps) }
    // The one piece of dial state that is saved: the weight and reps are re-seeded from the prefill.
    var kind by rememberSaveable { mutableStateOf(SetKind.Working) }
    var restStartedAtMs by remember { mutableStateOf<Long?>(null) }
    var sheet by remember { mutableStateOf<LoggerSheet?>(null) }
    var goingTo by remember { mutableStateOf<String?>(null) }
    var pendingDeviation by remember { mutableStateOf<DeviationOffer?>(null) }
    var asked by remember { mutableStateOf(setOf<String>()) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val strip = rememberLazyListState()
    val reading = rememberScrollState()

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { sheet = null }
    }

    fun mint(name: String, equipment: String) {
        say(null)
        scope.launch {
            when (val made = store.create(name, equipment)) {
                is GymResult.Ok -> store.choose(made.value.id)
                is GymResult.Failed -> say(made.why.line("“$name” wasn’t created"))
            }
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
            restStartedAtMs = null
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

    LaunchedEffect(store.prefill) {
        weightKg = store.prefill.weightKg
        reps = store.prefill.reps
    }

    LaunchedEffect(Unit) {
        restStartedAtMs = store.todaySets.lastOrNull()?.completedAtMs
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }

    // Scheduled against the instant the set landed, and it is the app's own sleep, not an alarm.
    val restTarget = Rest.target(store.planEntry, preferences)
    LaunchedEffect(restStartedAtMs, restTarget, preferences.restSound) {
        val started = restStartedAtMs ?: return@LaunchedEffect
        val target = restTarget?.seconds ?: return@LaunchedEffect
        val waited = (System.currentTimeMillis() - started) / 1000
        if (waited >= target) return@LaunchedEffect
        delay((target - waited) * 1000)
        confirm.restLanded()
    }

    val title = store.session?.plan?.routine ?: Readout.noRoutine
    // Finish rides the top bar: the band below holds one primary and it is Log set, pressed forty
    // times to Finish's once. The gear is a door to a planning screen, which is what a top corner
    // may hold.
    GymScreen(
        title = title,
        centred = true,
        navigation = { TopAction("Finish", enabled = !store.isFinishing, onClick = onFinish) },
        actions = {
            IconButton(onClick = onSettings) {
                Icon(Icons.Outlined.Settings, contentDescription = "Gym settings", tint = GymSkin.inkDim)
            }
        },
    ) {
      Column(Modifier.fillMaxSize().padding(horizontal = WindmillSpace.x4)) {
        val movement = store.exerciseId
        if (movement == null) {
            Column(
                Modifier.fillMaxWidth().padding(top = WindmillSpace.x3),
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
                onCreate = { name, equipment -> mint(name, equipment) },
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
        val rows = LiveLines.rows(today, store.stalled)
        val history = store.lastTime
        val historyCard = LiveLines.prefillCard(
            history, routine = store.session?.plan?.routine,
            readFailed = store.lastTimeFailed, now = nowMs,
        )
        val rest = restStartedAtMs?.let { Rest.Line(restTarget, it, nowMs) }

        // The reading region: centred while it is short, scrolling only once the largest text
        // leaves it no room. The walk's dots and the `+` sit UNDER the scroller, pinned above the
        // hairline: a landed set's clocks and strip may push the head up, never the walk off. The
        // whole region is one box so the transient can stand on its floor, over it and never over
        // the rack; the rack below grows no inset for it, so nothing there moves.
        Box(Modifier.weight(1f).fillMaxWidth()) {
          Column(Modifier.fillMaxSize()) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val viewport = maxHeight
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = viewport)
                        .verticalScroll(reading),
                    // 8 dp between rows: on a 411 × 731 phone the head, the set line, the clocks and
                    // the strip have 196 dp between the bar and the dots, and the spec's gaps cost 24
                    // of it that the strip does not have.
                    verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    MovementHead(
                        name = name,
                        setLine = setLine(counter, store.planEntry),
                        kind = kind,
                        onKind = { kind = it },
                        previous = if (at < 0) null else store.order.getOrNull(at - 1),
                        next = if (at < 0) null else store.order.getOrNull(at + 1),
                        onMove = { move(it) },
                        onOpenSession = { sheet = LoggerSheet.Assembly },
                    )
                    val shown = history?.sets?.let { LiveLines.lastTimeSet(it, workingToday) }
                    // A last time with no set in it is no history: no chip, no row, no reserved height.
                    if (history?.session != null && historyCard != null && shown != null) {
                        LastTimeChip(
                            history = history,
                            card = historyCard,
                            shown = shown,
                            onDial = { weightKg = it.weightKg; reps = it.reps },
                        )
                    } else if (history == null && historyCard != null) {
                        // A read that missed draws a chip; no history draws none. Never the same shape.
                        ChipRow { AssistChip(
                            onClick = {},
                            enabled = false,
                            label = { Text("didn’t load", style = MaterialTheme.typography.labelLarge) },
                            leadingIcon = { Icon(historyGlyph, contentDescription = null, Modifier.size(18.dp)) },
                            border = null,
                            colors = AssistChipDefaults.assistChipColors(
                                disabledContainerColor = GymSkin.raised,
                                disabledLabelColor = GymSkin.inkFaint,
                                disabledLeadingIconContentColor = GymSkin.inkFaint,
                            ),
                            modifier = Modifier.semantics {
                                contentDescription = "${historyCard.title}: ${historyCard.body}"
                            },
                        ) }
                    }
                    if (rest != null) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                        ) {
                            Clocks(
                                rest = rest,
                                targetSeconds = restTarget?.seconds,
                                onClear = { restStartedAtMs = null },
                            )
                            if (restTarget?.fromRoutine == true) {
                                // The merged clocks node already says ` · from the routine`; this is the
                                // drawn half of the same fact, once.
                                Text(
                                    "from the routine",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = GymSkin.inkFaint,
                                    modifier = Modifier.clearAndSetSemantics {},
                                )
                            }
                        }
                    }
                    StrandedBand(store.strandedCount, store.strandedBy)
                    Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
                    if (rows.isNotEmpty()) {
                        LoggedStrip(rows, strip, onFix = { sheet = LoggerSheet.Fix(it) })
                    }
                }
                // The strip is the scroller's last row: where the largest text overflows the region, a
                // landed set brings its own pill into view rather than leaving it under the dots. The
                // frame is waited for so the reach is the one this set's layout produced.
                LaunchedEffect(rows.size) {
                    withFrameNanos {}
                    reading.animateScrollTo(reading.maxValue)
                }
            }
            Walk(
                place = LiveLines.place(store.order, movement),
                walk = store.order.size,
                standing = at,
                onAdd = { sheet = LoggerSheet.Picker },
            )
            HorizontalDivider(thickness = 1.dp, color = GymSkin.line)
          }
          transient?.let { SnackbarHost(it, Modifier.align(Alignment.BottomCenter)) }
        }
        Rack(
            weightKg = weightKg,
            reps = reps,
            finishing = store.isFinishing,
            onWeight = { weightKg = it },
            onReps = { reps = it },
            onTypeWeight = { sheet = LoggerSheet.Weight },
            onTypeReps = { sheet = LoggerSheet.Reps },
            onLog = {
                val logging = kind
                confirm.setLogged()
                restStartedAtMs = System.currentTimeMillis()
                // Disarmed on the tap and never on the reply: a warmup is a single set, not a mode.
                kind = SetKind.Working
                scope.launch { store.logSet(weightKg, reps, logging) }
            },
        )
      }
    }

    // A fix for a set that has since left the strip has nothing to stand on.
    val fixing = (sheet as? LoggerSheet.Fix)?.let { fix -> store.todaySets.firstOrNull { it.id == fix.setId } }
    val open = sheet?.takeUnless { it is LoggerSheet.Fix && fixing == null }
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
        ) {
            when (open) {
                LoggerSheet.Weight -> KeypadSheet(
                    KeypadEntry.Mode.Weight, weightKg,
                    onCommit = { weightKg = it; close() },
                )
                LoggerSheet.Reps -> KeypadSheet(
                    KeypadEntry.Mode.Reps, reps.toDouble(),
                    onCommit = { reps = it.toInt(); close() },
                )
                LoggerSheet.Assembly -> AssemblySheet(
                    rows = LiveLines.assemblyRows(store.order, store.sets, store.session?.plan,
                                                  store.catalog, store.exerciseId, store.stalled),
                    elapsedMs = nowMs - (store.session?.startedAtMs ?: nowMs),
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
                    onCreate = { name, equipment ->
                        close()
                        mint(name, equipment)
                    },
                    modifier = Modifier
                        .heightIn(max = pickerMaxHeight())
                        .background(GymSkin.surface)
                        .padding(WindmillSpace.x5),
                    onClose = { close() },
                )
                is LoggerSheet.Deviation -> DeviationSheet(
                    deviation = open.offer,
                    movement = open.movement,
                    onSave = {
                        close()
                        say(null)
                        scope.launch {
                            val why = store.save(open.offer.liftedKg, toRoutine = open.offer.routineId,
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
                    FixSheet(
                        set = set,
                        movement = Readout.movement(set.exerciseId, store.catalog),
                        setNumber = store.todaySets.indexOfFirst { it.id == set.id } + 1,
                        routine = store.session?.plan?.routine,
                        onSave = { fix ->
                            close()
                            say(null)
                            if (sessionId == null) return@FixSheet
                            scope.launch {
                                when (val ended = store.fixSet(sessionId, set.id, fix)) {
                                    is FixOutcome.Corrected -> Unit
                                    is FixOutcome.Gone -> say(ended.said)
                                    is FixOutcome.Failed -> say(ended.why.line("that set wasn’t changed"))
                                }
                            }
                        },
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

// `Set 2 of 4` — the domain's `set 2 of 4`, capitalised here — and, when the plan line carries a rep
// or load target, ` · target 5 @ 82.5` in the target ink. A plan with no target draws no tail: the
// absence says it.
private fun setLine(count: String, planEntry: PlanEntry?) = buildAnnotatedString {
    append(count.replaceFirstChar { it.uppercase() })
    val load = planEntry?.weightKg?.takeIf { it != 0.0 }
    if (planEntry == null || (planEntry.reps == null && load == null)) return@buildAnnotatedString
    withStyle(SpanStyle(color = GymSkin.targetInk)) {
        append(" · target ${Readout.repTarget(planEntry.reps)}")
        load?.let { append(" @ ${Readout.weight(it)}") }
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
    setLine: AnnotatedString,
    kind: SetKind,
    onKind: (SetKind) -> Unit,
    previous: String?,
    next: String?,
    onMove: (String) -> Unit,
    onOpenSession: () -> Unit,
) {
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
            autoSize = TextAutoSize.StepBased(minFontSize = 20.sp, maxFontSize = 26.sp),
            style = MaterialTheme.typography.headlineMedium
                .copy(color = GymSkin.ink, textAlign = TextAlign.Center),
            modifier = Modifier
                .fillMaxWidth()
                .lineBox(32.sp)
                .clickable(role = Role.Button, onClickLabel = "open this session", onClick = onOpenSession)
                .semantics { customActions = steps },
        )
        // At the largest text the set line and the chip do not share a line; the chip wraps under.
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        ) {
            Box(Modifier.heightIn(min = 32.dp), contentAlignment = Alignment.Center) {
                Text(setLine, style = MaterialTheme.typography.bodyMedium, color = GymSkin.inkDim)
            }
            KindChip(kind, onKind)
        }
    }
}

// Four kinds one tap away on the set being logged: the kind is a property of the rep you are about
// to do, and choosing it must not cost a trip. It disarms itself when a set lands.
@Composable
private fun KindChip(kind: SetKind, onPick: (SetKind) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ChipRow { Box {
        AssistChip(
            onClick = { open = true },
            label = { Text(kind.wire, style = MaterialTheme.typography.labelMedium) },
            trailingIcon = {
                Icon(Icons.Filled.ArrowDropDown, contentDescription = null, Modifier.size(18.dp))
            },
            border = null,
            colors = AssistChipDefaults.assistChipColors(
                containerColor = GymSkin.accentSoft,
                labelColor = GymSkin.accent,
                trailingIconContentColor = GymSkin.accent,
            ),
            modifier = Modifier.semantics {
                contentDescription = "Set kind"
                stateDescription = kind.wire
            },
        )
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = GymSkin.surface,
        ) {
            SetKind.entries.forEach { option ->
                val picked = option == kind
                DropdownMenuItem(
                    text = { Text(option.wire, style = MaterialTheme.typography.bodyMedium, color = GymSkin.ink) },
                    leadingIcon = if (!picked) null else ({
                        Icon(Icons.Filled.Check, contentDescription = null, tint = GymSkin.accent,
                             modifier = Modifier.size(18.dp))
                    }),
                    onClick = {
                        onPick(option)
                        open = false
                    },
                    modifier = Modifier.semantics { selected = picked },
                )
            }
        }
    }
} }

// One set from last time, on the chip; the whole card — the day, how long ago, the other routine,
// every set — is what the chip SAYS, and the menu under it dials any of those sets.
@Composable
private fun LastTimeChip(
    history: LastTime,
    card: LiveLines.Card,
    shown: TrainingSet,
    onDial: (TrainingSet) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    ChipRow { Box {
        AssistChip(
            onClick = { open = true },
            label = {
                Text("${Readout.weight(shown.weightKg)} kg × ${shown.reps}",
                     style = MaterialTheme.typography.labelLarge)
            },
            leadingIcon = { Icon(historyGlyph, contentDescription = null, Modifier.size(18.dp)) },
            border = null,
            colors = AssistChipDefaults.assistChipColors(
                containerColor = GymSkin.accentSoft,
                labelColor = GymSkin.accent,
                leadingIconContentColor = GymSkin.accent,
            ),
            modifier = Modifier.semantics { contentDescription = "${card.title}: ${card.body}" },
        )
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = GymSkin.surface,
        ) {
            DropdownMenuItem(
                text = { Text(card.title, style = MaterialTheme.typography.bodySmall, color = GymSkin.inkFaint) },
                onClick = {},
                enabled = false,
            )
            history.sets.forEach { set ->
                DropdownMenuItem(
                    text = {
                        Text(Readout.effort(set.weightKg, set.reps),
                             style = MaterialTheme.typography.bodyMedium, color = GymSkin.ink)
                    },
                    onClick = {
                        onDial(set)
                        open = false
                    },
                )
            }
        }
    }
} }

// A chip row is the 32 dp the chip draws, not the 48 Material reserves around it: the reading
// region on a 411 × 731 phone has no 16 dp to spare per chip, and a chip is a door opened once a
// set, beside a set line that is not a target at all.
@Composable
private fun ChipRow(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 32.dp, content = content)
}

// The clock counts UP — time since the last set — and keeps the ring against the target. The row is
// ONE node and it SAYS what the old label drew: `resting · target 1:30 · from the routine  ·  0:03`.
@Composable
private fun Clocks(rest: Rest.Line, targetSeconds: Int?, onClear: () -> Unit) {
    val sweep by animateFloatAsState(
        rest.fraction ?: 0f,
        tween(WindmillMotion.fastMs, easing = WindmillMotion.easeSoft),
        label = "rest",
    )
    Row(
        Modifier
            .heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .clickable(role = Role.Button, onClickLabel = "clear the rest", onClick = onClear)
            .semantics(mergeDescendants = true) { contentDescription = "${rest.label}  ·  ${rest.time}" }
            .padding(horizontal = WindmillSpace.x2),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x6),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(timerGlyph, contentDescription = null, tint = GymSkin.inkFaint, modifier = Modifier.size(18.dp))
            Text(rest.time, style = MaterialTheme.typography.titleLarge,
                 color = if (rest.overrun) GymSkin.accent else GymSkin.inkDim)
        }
        if (rest.fraction != null && targetSeconds != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(
                    progress = { sweep },
                    modifier = Modifier.size(22.dp),
                    color = GymSkin.accent,
                    strokeWidth = 3.dp,
                    trackColor = GymSkin.line,
                )
                if (rest.overrun) {
                    Icon(Icons.Filled.Check, contentDescription = null, tint = GymSkin.accent,
                         modifier = Modifier.size(18.dp))
                } else {
                    Text(Readout.clock(targetSeconds * 1000L), style = MaterialTheme.typography.bodyMedium,
                         color = GymSkin.inkFaint)
                }
            }
        }
    }
}

// The one caption that survives: a disclosure at the moment of consequence — your data is not on
// the server — and it exists only while something is wrong.
@Composable
private fun StrandedBand(count: Int, by: Blocker?) {
    val line = LiveLines.onThisDeviceLine(count, by) ?: return
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(cloudOffGlyph, contentDescription = null, tint = GymSkin.unsyncedInk,
             modifier = Modifier.size(16.dp).padding(top = 1.dp))
        Text(line, style = MaterialTheme.typography.bodySmall, color = GymSkin.unsyncedInk,
             lineHeight = 17.sp, modifier = Modifier.weight(1f))
    }
}

// One fixed 32dp of pills that scrolls sideways, next to the clock you look at right after the set
// landed. A pill is the drawn, named door to the fix (Law 1); a pill without the cloud is synced,
// and the cloud says the exception — an absence needs no glyph.
@Composable
private fun LoggedStrip(rows: List<LiveLines.Row>, state: LazyListState, onFix: (String) -> Unit) {
    LaunchedEffect(rows.size) { state.animateScrollToItem(rows.size - 1) }
    LazyRow(
        state = state,
        modifier = Modifier.fillMaxWidth().height(32.dp),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
    ) {
        items(rows, key = { it.id }) { row ->
            SetPill(
                row, onFix,
                Modifier.animateItem(
                    fadeInSpec = tween(WindmillMotion.baseMs, easing = WindmillMotion.easeSoft),
                    placementSpec = tween(WindmillMotion.baseMs, easing = WindmillMotion.easeSoft),
                    fadeOutSpec = tween(WindmillMotion.fastMs),
                ),
            )
        }
    }
}

// Every pill is a door: a set still on this device is fixed in the queue it waits in, so the
// corrected body is what lands.
@Composable
private fun SetPill(row: LiveLines.Row, onFix: (String) -> Unit, modifier: Modifier = Modifier) {
    val said = (if (row.isWarmup) "Warmup set" else "Set ${row.index}") + ", ${row.value}"
    val shape = RoundedCornerShape(WindmillRadius.full)
    Row(
        modifier
            .height(32.dp)
            .clip(shape)
            .background(GymSkin.surface)
            .border(1.dp, GymSkin.line, shape)
            .clickable(role = Role.Button, onClickLabel = "fix this set") { onFix(row.id) }
            .semantics(mergeDescendants = true) { contentDescription = said }
            .padding(horizontal = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(row.index, style = MaterialTheme.typography.labelMedium,
             color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.inkFaint)
        Text(row.value, style = MaterialTheme.typography.labelMedium,
             color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.ink)
        if (row.isOnThisDevice) {
            Icon(cloudOffGlyph, contentDescription = LiveLines.onThisDevice, tint = GymSkin.unsyncedInk,
                 modifier = Modifier.size(14.dp))
        }
    }
}

// The dots are the position readout the swipe needs, and they SAY it — `Movement 1 of 3`, the
// domain's `movement 1 of 3` capitalised. The `+` is the free session's only way to a next movement.
@Composable
private fun Walk(place: String?, walk: Int, standing: Int, onAdd: () -> Unit) {
    // No padding of its own: on a 411 × 731 phone a landed set fills the reading region to the
    // dp, and the 46 dp button already holds the dots clear of the strip.
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
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
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(if (step <= standing) GymSkin.accent else GymSkin.lineStrong),
                    )
                }
            }
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onAdd, modifier = Modifier.size(GymTap.minimum)) {
            Icon(Icons.Filled.Add, contentDescription = "Add movement", tint = GymSkin.inkDim,
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
    Column(
        Modifier.fillMaxWidth().padding(top = WindmillSpace.x4, bottom = WindmillSpace.x3),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Weight", style = MaterialTheme.typography.bodySmall, color = GymSkin.inkFaint,
             modifier = Modifier.clearAndSetSemantics {})
        Spacer(Modifier.height(WindmillSpace.x1))
        WeightReadout(weightKg, onTypeWeight)
        Spacer(Modifier.height(WindmillSpace.x3))
        LadderRow(weightKg, onDial = onWeight)
        Spacer(Modifier.height(WindmillSpace.x5))
        Text("Reps", style = MaterialTheme.typography.bodySmall, color = GymSkin.inkFaint,
             modifier = Modifier.clearAndSetSemantics {})
        Spacer(Modifier.height(WindmillSpace.x1))
        RepsRow(reps, onDial = onReps, onType = onTypeReps)
        Spacer(Modifier.height(WindmillSpace.x5))
        LogButton(finishing, onLog)
    }
}

// −102.5 is the widest this readout holds, and it shrinks rather than truncating. The numeral and
// its unit are one node: the tap raises the rack's own keypad, never the system keyboard.
@Composable
private fun WeightReadout(weightKg: Double, onType: () -> Unit) {
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
            autoSize = TextAutoSize.StepBased(minFontSize = 44.sp, maxFontSize = 80.sp),
            style = GymType.weight.copy(lineHeight = 72.sp, color = GymSkin.weightInk),
            modifier = Modifier.lineBox(72.sp).alignByBaseline(),
        )
        Text("kg", style = MaterialTheme.typography.displaySmall, color = GymSkin.inkDim,
             modifier = Modifier.alignByBaseline())
    }
}

// Four EQUAL pills whose labels are the golden's, by weight band — never a fixed ±1/±5.
@Composable
internal fun LadderRow(weightKg: Double, onDial: (Double) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Ladder.labels(weightKg).forEachIndexed { index, label ->
            val big = index == 0 || index == 3
            val interaction = remember { MutableInteractionSource() }
            val shape = RoundedCornerShape(WindmillRadius.md)
            Box(
                Modifier
                    .weight(1f)
                    .height(52.dp)
                    .pressed(interaction)
                    .clip(shape)
                    .background(GymSkin.raised)
                    .border(1.dp, GymSkin.lineStrong, shape)
                    .clickable(
                        interactionSource = interaction,
                        indication = LocalIndication.current,
                        role = Role.Button,
                        onClickLabel = "change the weight by $label",
                    ) {
                        onDial(Ladder.bump(weightKg, direction = if (index < 2) -1 else 1, big = big))
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = MaterialTheme.typography.titleMedium, color = GymSkin.ink, maxLines = 1)
            }
        }
    }
}

// Two accent circles either side of the numeral. The words are the circles' names, not glyphs.
@Composable
private fun RepsRow(reps: Int, onDial: (Int) -> Unit, onType: () -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x6),
        verticalAlignment = Alignment.CenterVertically,
    ) {
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
                Text(count.toString(), style = GymType.reps, color = GymSkin.ink, maxLines = 1,
                     modifier = Modifier.lineBox(60.sp))
            }
        }
        RepCircle(Icons.Filled.Add, "one rep more") { onDial(Ladder.bumpReps(reps, direction = 1)) }
    }
}

@Composable
private fun RepCircle(glyph: ImageVector, said: String, onTap: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    FilledIconButton(
        onClick = onTap,
        interactionSource = interaction,
        modifier = Modifier.size(GymTap.primary).pressed(interaction),
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = GymSkin.accent,
            contentColor = GymSkin.onAccent,
        ),
    ) {
        Icon(glyph, contentDescription = said, modifier = Modifier.size(28.dp))
    }
}

// The store refuses a set once Finish is in flight, so the button says so before the tap. The two
// numerals stand directly above it, so it echoes neither.
@Composable
private fun LogButton(finishing: Boolean, onLog: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.primary)
            .clip(RoundedCornerShape(WindmillRadius.lg))
            .background(if (finishing) GymSkin.raised else GymSkin.accent)
            .clickable(enabled = !finishing, role = Role.Button, onClick = onLog),
        contentAlignment = Alignment.Center,
    ) {
        Text("Log set", style = GymType.primary, color = if (finishing) GymSkin.inkFaint else GymSkin.onAccent)
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

// Four glyphs from Material's extended set, drawn from their paths: the room depends on the core
// set alone, and four glyphs are not a reason to pull the whole extended artifact in.
private fun glyph(name: String, path: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp,
                        viewportWidth = 24f, viewportHeight = 24f)
        .addPath(pathData = PathParser().parsePathString(path).toNodes(), fill = SolidColor(Color.Black))
        .build()

private val removeGlyph = glyph("Filled.Remove", "M19 13H5v-2h14v2z")

private val timerGlyph = glyph(
    "Outlined.Timer",
    "M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42C16.07 4.74 " +
        "14.12 4 12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61zM12 20c-3.87 0-7-3.13" +
        "-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z",
)

private val historyGlyph = glyph(
    "Outlined.History",
    "M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0" +
        "-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 " +
        "2.54.72-1.21-3.5-2.08V8H12z",
)

private val cloudOffGlyph = glyph(
    "Outlined.CloudOff",
    "M24 15c0-2.64-2.05-4.78-4.65-4.96C18.67 6.59 15.64 4 12 4c-1.33 0-2.57.36-3.65.97l1.49 1.49C10.51 " +
        "6.17 11.23 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45" +
        "C22.93 18.17 24 16.71 24 15zM4.41 3.86L3 5.27l2.77 2.77h-.42C2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6" +
        "h11.73l2 2 1.41-1.41L4.41 3.86zM6 18c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73l8 8H6z",
)
