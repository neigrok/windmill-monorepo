package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.gym.domain.DeviationOffer
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Rest
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.RefusedClaim
import works.windmill.gym.store.RefusedSet
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THE SET LOGGER — one value at a time, at arm's length, in a room where you cannot hear the tone and
// your hands are chalked. Only the today list is elastic: the big weight, the ladder, the reps and
// the 64dp primary action never move as sets accumulate, so the thumb learns one geometry and keeps
// it for the whole session.
//
// EVERY WEIGHT AND REP TAP GOES THROUGH `Ladder`. Step sizes are not re-derived here, on the web, or
// anywhere else — one module per language, both answering packages/api-contract/gym-ladder.json, and
// the labels re-render as the load climbs because the band under it changed.
//
// The screen never congratulates and never warns. An overrun rest counts up in the accent, "set 4 of 3"
// is drawn in the same ink as "set 3 of 5", and the only alarm ink in the product belongs to a write
// that actually failed.

private sealed class LoggerSheet {
    data object Weight : LoggerSheet()
    data object Reps : LoggerSheet()
    data object Jump : LoggerSheet()
    data object Picker : LoggerSheet()
    data class Deviation(val offer: DeviationOffer, val movement: String) : LoggerSheet()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoggerScreen(store: TrainingStore, say: (String?) -> Unit, onFinish: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var weightKg by remember { mutableDoubleStateOf(store.prefill.weightKg) }
    var reps by remember { mutableIntStateOf(store.prefill.reps) }
    var warmup by remember { mutableStateOf(false) }
    var restStartedAtMs by remember { mutableStateOf<Long?>(null) }
    var sheet by remember { mutableStateOf<LoggerSheet?>(null) }
    var goingTo by remember { mutableStateOf<String?>(null) }
    var pendingDeviation by remember { mutableStateOf<DeviationOffer?>(null) }
    var asked by remember { mutableStateOf(setOf<String>()) }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Every programmatic close falls through the sheet's own hide animation rather than cutting to
    // black. Compose fires no dismiss callback on a programmatic close, so every close routes
    // through here rather than waiting on one; what the close leaves owed is settled by the effect
    // below, once the sheet has actually left.
    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { sheet = null }
    }

    fun move(to: String) {
        val leaving = store.exerciseId
        if (leaving != null && leaving != to) {
            DeviationOffer.leaving(leaving, store.session, store.sets, asked)?.let { offer ->
                asked = asked + leaving
                pendingDeviation = offer
            }
        }
        goingTo = to
        close()
    }

    // Leaving a movement is the one boundary the change offer is raised at, and the sheet that
    // raised it cannot be the one still on screen — dismiss-then-present, the iOS `onDismiss:
    // settleTheMove`. The settle rides an effect keyed on `sheet` because that is the one place
    // guaranteed to run only after the fallen sheet has LEFT the composition: with one hoisted
    // sheetState, ModalBottomSheet only shows itself on entering composition, so presenting the
    // offer in the same frame the old sheet left would raise it under the scrim, hidden.
    LaunchedEffect(sheet) {
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

    // The dial follows the prefill, and the prefill only moves when the movement does or when a
    // set lands on it — so a number the lifter dialled and did not log is never taken from under
    // them mid-exercise.
    LaunchedEffect(store.prefill) {
        weightKg = store.prefill.weightKg
        reps = store.prefill.reps
    }

    // Walking back into a workout that never stopped is a lifter who is resting RIGHT NOW, and the
    // device knows exactly since when — the last set's own instant. The timer is computed from that
    // rather than restored from a counter, so it needs nothing persisted.
    LaunchedEffect(Unit) {
        restStartedAtMs = store.todaySets.lastOrNull()?.completedAtMs
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }

    // The chime is scheduled against the instant the set landed rather than watched for while
    // rendering: a phone in a pocket draws nothing, and the one confirmation a gym leaves us
    // must not depend on the screen being awake.
    LaunchedEffect(restStartedAtMs) {
        val started = restStartedAtMs ?: return@LaunchedEffect
        val movement = store.exerciseId ?: return@LaunchedEffect
        val target = Rest.target(movement, store.planEntry)
        val waited = (System.currentTimeMillis() - started) / 1000
        if (waited >= target) return@LaunchedEffect
        delay((target - waited) * 1000)
        GymSound.restLanded(context)
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
        // x3, not the x4 the eye might want: nine gaps ride this screen, and on a 731dp phone the
        // extra 36dp is the difference between the today list breathing and it being squeezed flat.
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Header(
            routine = store.session?.plan?.routine ?: "Ad-hoc session",
            elapsedMs = nowMs - (store.session?.startedAtMs ?: 0L),
            onFinish = onFinish,
        )
        LiveLines.onThisDeviceLine(store.strandedCount)?.let { line ->
            Text(
                line,
                style = GymType.numeral(12),
                color = GymSkin.unsyncedInk,
                lineHeight = 17.sp,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        store.refusals.forEach { refused ->
            when (refused) {
                is RefusedSet -> Refusal(
                    headline = "${Readout.movement(refused.exerciseId, store.catalog)} " +
                        "${Readout.effort(refused.weightKg, refused.reps)} never reached the log",
                    reason = refused.reason,
                    onDismiss = { store.clearRefusals() })
                is RefusedClaim -> Refusal(
                    headline = "“${refused.name}” couldn’t be claimed",
                    reason = refused.reason,
                    onDismiss = { store.clearRefusals() })
            }
        }

        val movement = store.exerciseId
        if (movement == null) {
            Assembling(
                title = store.session?.plan?.routine ?: "Ad-hoc session",
                line = if (store.session?.plan == null)
                    "No routine, no plan snapshot. Pick what you are about to lift."
                else
                    "Nothing in this plan to walk yet. Pick what you are about to lift.",
                onChoose = { sheet = LoggerSheet.Picker },
            )
        } else {
            MovementHead(
                name = Readout.movement(movement, store.catalog),
                counter = LiveLines.counter(LiveLines.workingCount(store.todaySets), store.planEntry),
                onJump = { sheet = LoggerSheet.Jump },
            )
            PrefillCard(
                card = LiveLines.prefillCard(store.lastTime, store.planEntry,
                                             routine = store.session?.plan?.routine,
                                             readFailed = store.lastTimeFailed,
                                             now = System.currentTimeMillis()),
                onOpen = { sheet = LoggerSheet.Weight },
            )
            // The one elastic region. Android phones run shorter than the iPhones this layout was
            // drawn for, so the rule is enforced structurally: everything below this box is the
            // pinned tail, and appearing rows (rest line, undo) compress the LIST — they can never
            // push the 64dp action out of the thumb zone or off the screen.
            Box(Modifier.weight(1f).fillMaxWidth()) {
                TodayList(LiveLines.rows(store.todaySets, store.stalled))
            }
            WeightBlock(weightKg, onType = { sheet = LoggerSheet.Weight }, onDial = { weightKg = it })
            RepsRow(
                reps = reps,
                warmup = warmup,
                onDial = { reps = it },
                onType = { sheet = LoggerSheet.Reps },
                onToggleWarmup = { warmup = !warmup },
            )
            // No rest line until a set lands: the timer times the gap between two sets, and one
            // drawn before the first would be counting from the moment the screen opened.
            restStartedAtMs?.let { started ->
                RestLine(
                    line = Rest.Line(Rest.target(movement, store.planEntry), started, nowMs),
                    onReset = { restStartedAtMs = null },
                )
            }
            UndoRow(
                undoable = remember(nowMs, store.sets) { store.undoable },
                onUndo = { store.undoLast() },
            )
            LogButton(
                label = "Log set  ·  ${Readout.effort(weightKg, reps)}",
                finishing = store.isFinishing,
                onLog = {
                    val kind = if (warmup) SetKind.Warmup else SetKind.Working
                    GymSound.setLogged(context)
                    restStartedAtMs = System.currentTimeMillis()
                    // Disarmed on the tap and not on the reply: the set is the lifter's the instant
                    // they press, and the toggle is about the set that just went, never the network.
                    warmup = false
                    scope.launch { store.logSet(weightKg, reps, kind) }
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
                LoggerSheet.Jump -> JumpSheet(
                    rows = LiveLines.jumpRows(store.order, store.sets, store.session?.plan,
                                              store.catalog, store.exerciseId),
                    onJump = { move(it) },
                    onAdd = { sheet = LoggerSheet.Picker },
                    onClose = { close() },
                )
                LoggerSheet.Picker -> MovementPicker(
                    catalog = store.catalog,
                    taken = store.order,
                    onPick = { move(it) },
                    onCreate = { name ->
                        close()
                        say(null)
                        scope.launch {
                            // A picker that closed on a movement that was never minted is a lifter
                            // left holding nothing, with nothing said about it.
                            when (val made = store.create(name)) {
                                is GymResult.Ok -> store.choose(made.value.id)
                                is GymResult.Failed -> say(made.why.line("“$name” wasn’t created"))
                            }
                        }
                    },
                    onClose = { close() },
                )
                is LoggerSheet.Deviation -> DeviationSheet(
                    deviation = open.offer,
                    movement = open.movement,
                    onSave = {
                        close()
                        say(null)
                        scope.launch {
                            // The write that moves next week's target. Said when it does not land,
                            // or the lifter believes their program changed.
                            val why = store.save(open.offer.liftedKg, toRoutine = open.offer.routineId,
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
private fun Header(routine: String, elapsedMs: Long, onFinish: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(GymSkin.accent))
        Text(routine, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.ink)
        Text(Readout.clock(elapsedMs), style = GymType.numeral(14), color = GymSkin.inkDim)
        Spacer(Modifier.weight(1f))
        Box(
            Modifier.sizeIn(minWidth = 70.dp, minHeight = GymTap.minimum).clickable(onClick = onFinish),
            contentAlignment = Alignment.Center,
        ) {
            Text("Finish", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.accent)
        }
    }
}

// The last copy of a write that will never land — a set with its movement and numbers, or a
// claim's refused document under its name. It is SAID because a queue that dropped it quietly
// would count the loss as intended — and this is the one place in gym allowed to use alarm ink.
@Composable
private fun Refusal(headline: String, reason: String, onDismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                headline,
                style = GymType.numeral(12),
                color = GymSkin.alarmInk,
            )
            Text(reason, style = GymType.numeral(12), color = GymSkin.inkDim)
        }
        Box(
            Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Text("Dismiss", style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
    }
}

// No routine, no plan snapshot, and nothing to log into yet. The one way forward is to name what
// is about to be lifted — this list IS the routine that gets offered at the end.
@Composable
private fun Assembling(title: String, line: String, onChoose: () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4)) {
        Spacer(Modifier.height(WindmillSpace.x8))
        Text(title, style = WindmillFont.display(26), color = GymSkin.ink)
        Text(line, style = WindmillFont.body(16), color = GymSkin.inkDim, lineHeight = 24.sp)
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable(onClick = onChoose),
            contentAlignment = Alignment.Center,
        ) {
            Text("Choose a movement", style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
        }
    }
}

@Composable
private fun MovementHead(name: String, counter: LiveLines.Counter, onJump: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            BasicText(
                name,
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 20.sp, maxFontSize = 28.sp),
                style = GymType.movementHead.copy(color = GymSkin.ink),
            )
            Row {
                Text(counter.count, style = GymType.numeral(12), color = GymSkin.inkDim)
                Text(counter.tail, style = GymType.numeral(12), color = GymSkin.targetInk)
            }
        }
        Box(
            Modifier.size(GymTap.minimum).clickable(onClick = onJump),
            contentAlignment = Alignment.Center,
        ) {
            Text("›", style = WindmillFont.body(22, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
    }
}

@Composable
private fun PrefillCard(card: LiveLines.Card, onOpen: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.surface)
            .clickable(onClick = onOpen)
            .padding(WindmillSpace.x3),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(card.title, style = GymType.numeral(11), color = GymSkin.inkFaint)
        Text(card.body, style = GymType.numeral(14), color = GymSkin.ink)
    }
}

// ONLY THIS LIST IS ELASTIC, and only up to here. Past the cap it scrolls inside itself, so the
// weight, the ladder, the reps and the 64dp action do not move as sets accumulate — the thumb
// learns one geometry on the first set and keeps it for the whole session.
@Composable
private fun TodayList(rows: List<LiveLines.Row>) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 190.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (rows.isEmpty()) {
            Text("Nothing logged for this movement yet.", style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        rows.forEach { row ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    row.index,
                    style = GymType.numeral(12),
                    color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.setDone,
                    modifier = Modifier.width(16.dp),
                )
                Text(
                    row.value,
                    style = GymType.numeral(15),
                    color = if (row.isWarmup) GymSkin.warmupInk else GymSkin.ink,
                )
                Text(
                    row.note,
                    style = GymType.numeral(11),
                    color = if (row.isOnThisDevice) GymSkin.unsyncedInk else GymSkin.inkFaint,
                )
                Spacer(Modifier.weight(1f))
                Text(row.time, style = GymType.numeral(12), color = GymSkin.inkFaint)
            }
        }
    }
}

@Composable
private fun WeightBlock(weightKg: Double, onType: () -> Unit, onDial: (Double) -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onType),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            verticalAlignment = Alignment.Bottom,
        ) {
            // A −102.5 is the widest thing this readout ever holds. It shrinks rather than
            // truncating: half a weight is worse than a small one.
            BasicText(
                Readout.weight(weightKg),
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 57.sp, maxFontSize = 104.sp),
                style = GymType.weight.copy(color = GymSkin.weightInk),
                modifier = Modifier.alignByBaseline(),
            )
            Text(
                "kg",
                style = GymType.numeral(15),
                color = GymSkin.inkFaint,
                modifier = Modifier.alignByBaseline(),
            )
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Ladder.labels(weightKg).forEachIndexed { index, label ->
                Box(
                    Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum + 6.dp)
                        .clip(RoundedCornerShape(WindmillRadius.md))
                        .background(GymSkin.raised)
                        .clickable {
                            onDial(Ladder.bump(weightKg, direction = if (index < 2) -1 else 1,
                                               big = index == 0 || index == 3))
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, style = GymType.numeral(17, FontWeight.SemiBold), color = GymSkin.ink)
                }
            }
        }
    }
}

@Composable
private fun RepsRow(reps: Int, warmup: Boolean, onDial: (Int) -> Unit, onType: () -> Unit,
                    onToggleWarmup: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(GymTap.minimum + 12.dp)
                .height(GymTap.minimum + 6.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .background(GymSkin.raised)
                .clickable { onDial(Ladder.bumpReps(reps, direction = -1)) },
            contentAlignment = Alignment.Center,
        ) {
            Text("−", style = WindmillFont.display(24, FontWeight.SemiBold), color = GymSkin.ink)
        }

        Row(
            Modifier.weight(1f).clickable(onClick = onType),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text(reps.toString(), style = GymType.reps, color = GymSkin.ink,
                 modifier = Modifier.alignByBaseline())
            Text("reps", style = GymType.numeral(13), color = GymSkin.inkFaint,
                 modifier = Modifier.alignByBaseline())
        }

        Box(
            Modifier
                .width(GymTap.minimum + 12.dp)
                .height(GymTap.minimum + 6.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .background(GymSkin.raised)
                .clickable { onDial(Ladder.bumpReps(reps, direction = 1)) },
            contentAlignment = Alignment.Center,
        ) {
            Text("+", style = WindmillFont.display(24, FontWeight.SemiBold), color = GymSkin.ink)
        }

        // THE ONE PLACE A SET'S KIND IS DECIDED. It arms the next Log set and disarms itself the
        // moment that set lands, because a warmup is a single set and not a mode you can be left
        // in — a toggle that stayed on would file the working sets after it as ramp-ups. A warmup
        // counts toward NOTHING: it does not advance the plan counter, it is not carried forward
        // as the sticky weight, no record rule reads it, and "Keep this as a routine" leaves it
        // out. It sits IN the reps row rather than on a line of its own: the row's height and the
        // 64dp action below it are what the thumb learns on the first set, and neither may move.
        Box(
            Modifier
                .width(74.dp)
                .height(GymTap.minimum + 6.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .background(if (warmup) GymSkin.raised else Color.Transparent)
                .border(1.dp, if (warmup) GymSkin.lineStrong else GymSkin.line,
                        RoundedCornerShape(WindmillRadius.md))
                .clickable(onClick = onToggleWarmup),
            contentAlignment = Alignment.Center,
        ) {
            Text("warmup", style = GymType.numeral(12),
                 color = if (warmup) GymSkin.warmupInk else GymSkin.inkFaint)
        }
    }
}

@Composable
private fun RestLine(line: Rest.Line, onReset: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(line.label, style = GymType.numeral(12), color = GymSkin.inkFaint)
        // Being over the target is not an error and must never look like one: the overrun counts
        // UP, in the accent — never alarm ink.
        Text(line.time, style = GymType.numeral(15),
             color = if (line.overrun) GymSkin.accent else GymSkin.ink)
        Spacer(Modifier.weight(1f))
        Box(
            Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onReset),
            contentAlignment = Alignment.Center,
        ) {
            Text("reset", style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
    }
}

// The confirmation is visual and it is this: the row above, and the sentence here saying what
// was taken. Undo is offered exactly while the set can still be taken back — the log has no
// route that deletes one, so a button that outlived the window would have to apologise.
@Composable
private fun UndoRow(undoable: TrainingSet?, onUndo: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(26.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (undoable != null) {
            Text(
                "Logged ${Readout.effort(undoable.weightKg, undoable.reps)}",
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
            )
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.sizeIn(minWidth = 60.dp, minHeight = GymTap.minimum - 8.dp).clickable(onClick = onUndo),
                contentAlignment = Alignment.Center,
            ) {
                Text("Undo", style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }
    }
}

@Composable
private fun LogButton(label: String, finishing: Boolean, onLog: () -> Unit) {
    // Finish is a round trip and the store refuses a set once it is in flight. The button has to
    // say so BEFORE the tap, or the surface looks live and answers with a refusal nobody earned.
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
