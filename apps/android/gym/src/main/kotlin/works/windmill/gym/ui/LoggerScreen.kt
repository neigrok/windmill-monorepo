package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.DeviationOffer
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Rest
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Every weight and rep tap goes through `Ladder`, and every weight is kilograms in and out.

private sealed class LoggerSheet {
    data object Weight : LoggerSheet()
    data object Reps : LoggerSheet()
    data object Kind : LoggerSheet()
    data object Assembly : LoggerSheet()
    data object Picker : LoggerSheet()
    data class Create(val name: String) : LoggerSheet()
    data class Deviation(val offer: DeviationOffer, val movement: String) : LoggerSheet()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoggerScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    say: (String?) -> Unit,
    onFinish: () -> Unit,
    onSignIn: () -> Unit,
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
    fun move(to: String) {
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
        val target = restTarget ?: return@LaunchedEffect
        val waited = (System.currentTimeMillis() - started) / 1000
        if (waited >= target) return@LaunchedEffect
        delay((target - waited) * 1000)
        confirm.restLanded()
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = WindmillSpace.x4)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Header(
            routine = store.session?.plan?.routine ?: Readout.noRoutine,
            rest = restStartedAtMs?.let { Rest.Line(restTarget, it, nowMs) },
            onFinish = onFinish,
            onClearRest = { restStartedAtMs = null },
        )
        LiveLines.onThisDeviceLine(store.strandedCount, store.strandedBy)?.let { line ->
            Text(
                line,
                style = GymType.numeral(12),
                color = GymSkin.unsyncedInk,
                lineHeight = 17.sp,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })

        val movement = store.exerciseId
        if (movement == null) {
            MovementPicker(
                catalog = store.catalog,
                taken = store.order,
                lastSets = store.lastSets,
                nowMs = nowMs,
                title = if (store.firstSession) "What are you starting with?" else "What are you lifting?",
                subtitle = if (store.session?.plan == null) "the session is already running"
                    else "nothing in this plan is left to walk",
                firstSession = store.firstSession,
                signedIn = isSignedIn,
                catalogUnread = store.catalogUnread,
                onPick = { picked -> scope.launch { store.choose(picked) } },
                onCreate = { name -> sheet = LoggerSheet.Create(name) },
                onBuildRoutine = onSignIn,
                modifier = Modifier.weight(1f),
            )
        } else {
            val counter = LiveLines.counter(LiveLines.workingCount(store.todaySets), store.planEntry)
            val at = store.order.indexOf(movement)
            MovementTitle(
                name = Readout.movement(movement, store.catalog),
                plan = counter.plan,
                place = LiveLines.place(store.order, movement),
                walk = store.order.size,
                standing = at,
                previous = if (at < 0) null else store.order.getOrNull(at - 1),
                next = if (at < 0) null else store.order.getOrNull(at + 1),
                onMove = { move(it) },
                onOpenSession = { sheet = LoggerSheet.Assembly },
            )
            // One elastic region only, the history: sets can never push the 64dp action out of reach.
            Column(
                Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
            ) {
                Box(
                    Modifier.weight(1f).fillMaxWidth(),
                    contentAlignment = Alignment.BottomStart,
                ) {
                    History(
                        rows = LiveLines.rows(store.todaySets, store.stalled),
                        undoable = remember(nowMs, store.sets, movement) { store.undoable },
                        lastTime = LiveLines.prefillCard(
                            store.lastTime, store.planEntry,
                            routine = store.session?.plan?.routine,
                            readFailed = store.lastTimeFailed,
                            now = nowMs,
                        ),
                        onUndo = { store.undoLast() },
                    )
                }
                Value(
                    counter = counter.count,
                    weightKg = weightKg,
                    reps = reps,
                    onType = { sheet = LoggerSheet.Weight },
                )
            }
            KindPill(kind, onOpen = { sheet = LoggerSheet.Kind })
            LadderRow(weightKg, onDial = { weightKg = it })
            RepsRow(
                reps = reps,
                onDial = { reps = it },
                onType = { sheet = LoggerSheet.Reps },
            )
            LogButton(
                label = "Log set  ·  ${Readout.effort(weightKg, reps)}",
                finishing = store.isFinishing,
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

    val open = sheet
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
            dragHandle = null,
        ) {
            when (open) {
                LoggerSheet.Weight -> KeypadSheet(
                    KeypadEntry.Mode.Weight, weightKg,
                    onCommit = { weightKg = it; close() },
                    onCancel = { close() },
                )
                LoggerSheet.Reps -> KeypadSheet(
                    KeypadEntry.Mode.Reps, reps.toDouble(),
                    onCommit = { reps = it.toInt(); close() },
                    onCancel = { close() },
                )
                LoggerSheet.Kind -> KindSheet(
                    kind = kind,
                    onPick = { kind = it; close() },
                )
                LoggerSheet.Assembly -> AssemblySheet(
                    rows = LiveLines.assemblyRows(store.order, store.sets, store.session?.plan,
                                                  store.catalog, store.exerciseId, store.stalled),
                    elapsedMs = nowMs - (store.session?.startedAtMs ?: nowMs),
                    onJump = { move(it) },
                    onReorder = { from, to -> store.reorder(from, to) },
                    onDrop = { store.drop(it) },
                    onAdd = { sheet = LoggerSheet.Picker },
                    onClose = { close() },
                )
                LoggerSheet.Picker -> MovementPicker(
                    catalog = store.catalog,
                    taken = store.order,
                    lastSets = store.lastSets,
                    nowMs = nowMs,
                    title = "Add movement",
                    catalogUnread = store.catalogUnread,
                    onPick = { move(it) },
                    onCreate = { name -> sheet = LoggerSheet.Create(name) },
                    modifier = Modifier
                        .fillMaxHeight(0.92f)
                        .background(GymSkin.surface)
                        .padding(WindmillSpace.x5),
                    onClose = { close() },
                )
                is LoggerSheet.Create -> CreateMovementSheet(
                    name = open.name,
                    onCancel = { sheet = LoggerSheet.Picker },
                    onCreate = { name, equipment ->
                        close()
                        mint(name, equipment)
                    },
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
            }
        }
    }
}

@Composable
private fun Header(routine: String, rest: Rest.Line?, onFinish: () -> Unit, onClearRest: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(GymSkin.accent))
            Text(routine, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            if (rest != null) {
                Box(
                    Modifier
                        .heightIn(min = GymTap.minimum)
                        .clickable(onClickLabel = "clear the rest", onClick = onClearRest)
                        .semantics(mergeDescendants = true) {
                            contentDescription = "${rest.label}  ·  ${rest.time}"
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(rest.time, style = GymType.numeral(14),
                         color = if (rest.overrun) GymSkin.accent else GymSkin.inkDim)
                }
            }
            Box(
                Modifier.sizeIn(minWidth = 70.dp, minHeight = GymTap.minimum).clickable(onClick = onFinish),
                contentAlignment = Alignment.Center,
            ) {
                Text("Finish", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }
        val filled = rest?.fraction
        if (filled != null) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(2.dp)
                    .clip(RoundedCornerShape(WindmillRadius.full))
                    .background(GymSkin.line),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(filled)
                        .height(2.dp)
                        .clip(RoundedCornerShape(WindmillRadius.full))
                        .background(GymSkin.accent),
                )
            }
        }
    }
}

@Composable
private fun MovementTitle(
    name: String,
    plan: String,
    place: String?,
    walk: Int,
    standing: Int,
    previous: String?,
    next: String?,
    onMove: (String) -> Unit,
    onOpenSession: () -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Arrow("‹", previous, onMove)
        Column(
            Modifier.weight(1f).clickable(onClick = onOpenSession),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            BasicText(
                name,
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 20.sp, maxFontSize = 26.sp),
                style = GymType.movementHead.copy(color = GymSkin.ink, textAlign = TextAlign.Center),
            )
            Text(plan, style = GymType.numeral(12), color = GymSkin.targetInk)
            place?.let {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    modifier = Modifier.clearAndSetSemantics { },
                ) {
                    repeat(walk) { step ->
                        Box(
                            Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(if (step <= standing) GymSkin.accent
                                            else GymSkin.lineStrong),
                        )
                    }
                }
                Text(
                    it.uppercase(),
                    style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
                    color = GymSkin.inkFaint,
                )
            }
        }
        Arrow("›", next, onMove)
    }
}

@Composable
private fun Arrow(glyph: String, to: String?, onMove: (String) -> Unit) {
    Box(
        Modifier
            .size(GymTap.minimum)
            .clickable(enabled = to != null) { to?.let(onMove) },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            glyph,
            style = WindmillFont.body(22, FontWeight.SemiBold),
            color = if (to == null) GymSkin.line else GymSkin.inkDim,
        )
    }
}

@Composable
private fun History(
    rows: List<LiveLines.Row>,
    undoable: TrainingSet?,
    lastTime: LiveLines.Card,
    onUndo: () -> Unit,
) {
    if (rows.isEmpty()) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(lastTime.title, style = GymType.numeral(11), color = GymSkin.inkFaint)
            Text(lastTime.body, style = GymType.numeral(13), color = GymSkin.inkDim)
        }
        return
    }
    val scroll = rememberScrollState()
    LaunchedEffect(rows.size) { scroll.animateScrollTo(scroll.maxValue) }
    Column(
        Modifier.fillMaxWidth().heightIn(max = 168.dp).verticalScroll(scroll),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        rows.forEach { row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.surface)
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                    .padding(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    row.index,
                    style = GymType.numeral(11),
                    color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.inkFaint,
                    modifier = Modifier.width(16.dp),
                )
                Text(
                    row.value,
                    style = GymType.numeral(14),
                    color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.ink,
                    modifier = Modifier.weight(1f),
                )
                if (row.id == undoable?.id) {
                    Box(
                        Modifier
                            .sizeIn(minWidth = 60.dp, minHeight = GymTap.minimum - 8.dp)
                            .clickable(onClick = onUndo),
                        contentAlignment = Alignment.CenterEnd,
                    ) {
                        Text("Undo", style = WindmillFont.body(14, FontWeight.SemiBold),
                             color = GymSkin.accent)
                    }
                } else if (row.isOnThisDevice) {
                    Text(LiveLines.onThisDevice, style = GymType.numeral(11),
                         color = GymSkin.unsyncedInk)
                } else {
                    Text("✓", style = GymType.numeral(13),
                         color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.setDone)
                }
            }
        }
    }
}

@Composable
private fun Value(
    counter: String,
    weightKg: Double,
    reps: Int,
    onType: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
    ) {
        Text(
            counter.uppercase(),
            style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
            color = GymSkin.inkFaint,
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.Bottom,
        ) {
            // −102.5 is the widest this readout holds; only the NUMERAL takes the tap.
            BasicText(
                Readout.weight(weightKg),
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 44.sp, maxFontSize = 88.sp),
                style = GymType.weight.copy(color = GymSkin.weightInk),
                modifier = Modifier
                    .alignByBaseline()
                    .clickable(onClick = onType)
                    .drawBehind {
                        val y = size.height + 3.dp.toPx()
                        drawLine(
                            color = GymSkin.lineStrong,
                            start = Offset(0f, y),
                            end = Offset(size.width, y),
                            strokeWidth = 2.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(3f, 5f)),
                        )
                    },
            )
            Text("kg", style = WindmillFont.body(18, FontWeight.Bold), color = GymSkin.inkFaint,
                 modifier = Modifier.alignByBaseline())
            Text("× $reps", style = WindmillFont.display(28, FontWeight.ExtraBold),
                 color = GymSkin.inkDim, modifier = Modifier.alignByBaseline())
        }
    }
}

@Composable
private fun KindPill(kind: SetKind, onOpen: () -> Unit) {
    Row(
        Modifier
            .heightIn(min = GymTap.minimum - 10.dp)
            .clip(RoundedCornerShape(WindmillRadius.full))
            .background(if (kind == SetKind.Working) GymSkin.surface else GymSkin.raised)
            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.full))
            .clickable(onClick = onOpen)
            .padding(horizontal = WindmillSpace.x3),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(kind.wire, style = GymType.numeral(12, FontWeight.Bold),
             color = if (kind == SetKind.Working) GymSkin.inkDim else GymSkin.warmupInk)
        Text("▾", style = GymType.numeral(10), color = GymSkin.inkFaint)
    }
}

// A warmup counts toward NOTHING — not the plan counter, not the sticky weight, no record rule.
@Composable
private fun KindSheet(kind: SetKind, onPick: (SetKind) -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(GymSkin.surface).padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
    ) {
        Text("This set", style = WindmillFont.display(20), color = GymSkin.ink)
        listOf(SetKind.Working, SetKind.Warmup).forEach { offered ->
            val picked = offered == kind
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(if (picked) GymSkin.raised else Color.Transparent)
                    .border(1.dp, if (picked) GymSkin.lineStrong else GymSkin.line,
                            RoundedCornerShape(WindmillRadius.md))
                    .clickable { onPick(offered) }
                    .padding(horizontal = WindmillSpace.x4),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(offered.wire, style = WindmillFont.body(16, FontWeight.SemiBold),
                     color = if (picked) GymSkin.ink else GymSkin.inkDim)
                Spacer(Modifier.weight(1f))
                if (picked) Text("✓", style = GymType.numeral(13), color = GymSkin.accent)
            }
        }
    }
}

@Composable
internal fun LadderRow(weightKg: Double, onDial: (Double) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Ladder.labels(weightKg).forEachIndexed { index, label ->
            val plate = index == 0 || index == 3
            Box(
                (if (plate) Modifier.width(GymTap.minimum + 4.dp) else Modifier.weight(1f))
                    .height(GymTap.minimum + 14.dp)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(if (plate) GymSkin.surface else GymSkin.raised)
                    .border(1.dp, if (plate) GymSkin.line else GymSkin.lineStrong,
                            RoundedCornerShape(WindmillRadius.md))
                    .clickable {
                        onDial(Ladder.bump(weightKg, direction = if (index < 2) -1 else 1, big = plate))
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    style = if (plate) GymType.numeral(13) else GymType.numeral(18, FontWeight.Bold),
                    color = if (plate) GymSkin.inkFaint else GymSkin.ink,
                )
            }
        }
    }
}

@Composable
private fun RepsRow(reps: Int, onDial: (Int) -> Unit, onType: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("reps", style = GymType.numeral(13), color = GymSkin.inkFaint)
        Spacer(Modifier.weight(1f))
        Step("−") { onDial(Ladder.bumpReps(reps, direction = -1)) }
        Box(
            Modifier.sizeIn(minWidth = 40.dp, minHeight = GymTap.minimum).clickable(onClick = onType),
            contentAlignment = Alignment.Center,
        ) {
            Text(reps.toString(), style = GymType.numeral(20, FontWeight.Bold), color = GymSkin.ink)
        }
        Step("+") { onDial(Ladder.bumpReps(reps, direction = 1)) }
    }
}

@Composable
internal fun Step(glyph: String, onTap: () -> Unit) {
    Box(
        Modifier
            .size(GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.surface)
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
            .clickable(onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, style = WindmillFont.display(20, FontWeight.SemiBold), color = GymSkin.inkDim)
    }
}

@Composable
private fun LogButton(label: String, finishing: Boolean, onLog: () -> Unit) {
    // The store refuses a set once Finish is in flight, so the button says so before the tap.
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.primary)
            .clip(RoundedCornerShape(WindmillRadius.lg))
            .background(if (finishing) GymSkin.raised else GymSkin.accent)
            .clickable(enabled = !finishing, onClick = onLog),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = WindmillFont.body(19, FontWeight.Bold),
             color = if (finishing) GymSkin.inkFaint else GymSkin.onAccent)
    }
}
