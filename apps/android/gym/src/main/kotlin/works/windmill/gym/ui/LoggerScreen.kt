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

// THE SET LOGGER — §K, rebuilt. Nine times in ten the next set is the same weight and the same reps,
// so that case is one tap with nothing to read. The first version put thirteen near-equal targets
// and three lines of instructions in front of a man holding a barbell; what is left is nine, and the
// rare things each cost one deliberate gesture away from the button pressed out of breath.
//
// ONE COMPOSITE VALUE, WEIGHT DOMINANT — `105 kg × 5`. Weight is the SETTING and reps is the
// OUTCOME, so they stop competing for the same size: the numeral is the loudest pixel in the
// product and the reps ride beside it as the smaller half of one reading.
//
// THE LABELS ARE THE NUMBERS. The fine button IS the program step and the plate button is a visibly
// smaller neighbour, which is what retired the tier caption — `over 50 kg · fine 2.5 · plate 10` was
// the buttons explaining themselves. Nothing on this glass explains the design: the dotted underline
// carries "type it", and the argument for the screen lives beside it on the board.
//
// EVERY WEIGHT AND REP TAP GOES THROUGH `Ladder`. Step sizes are not re-derived here, on the web, or
// anywhere else — one module per language, all three answering packages/api-contract/gym-ladder.json,
// and the labels re-render as the load climbs because the band under them changed.
//
// TWO THINGS ON THIS SCREEN OBEY §I'S SETTINGS, and neither is stored: the rest hairline's target
// (their dial, off by default) and what a logged set does in the hand. Every weight here is kilograms on the way in and on the way out — the settings document
// changes what is DRAWN and reaches no write.
//
// The screen never congratulates and never warns. An overrun rest counts up in the accent, "set 4 of
// 3" is drawn in the same ink as "set 3 of 5", and the only alarm ink in the product belongs to a
// write that actually failed.

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
    // THE ONE PIECE OF DIAL STATE THAT IS SAVED, and the numbers beside it are deliberately not.
    // A reclaimed process comes back to a weight and a rep count the LOG can still vouch for — the
    // prefill is re-read off disk and the effect below re-seeds them — but nothing on disk knows
    // that the next set was armed as a warmup, and a warmup silently landing as a working set would
    // file a ramp-up as training. So the kind rides in the bundle.
    var kind by rememberSaveable { mutableStateOf(SetKind.Working) }
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

    // A movement the catalog has never heard of, minted from §N's two questions — the name that was
    // typed into the picker, and how the thing is loaded. Shared by the sheet and by the inline
    // first-run picker, because a create that answered differently on the two would be two rules for
    // one gesture.
    fun mint(name: String, equipment: String) {
        say(null)
        scope.launch {
            // A picker that closed on a movement that was never minted is a lifter left holding
            // nothing, with nothing said about it.
            when (val made = store.create(name, equipment)) {
                is GymResult.Ok -> store.choose(made.value.id)
                is GymResult.Failed -> say(made.why.line("“$name” wasn’t created"))
            }
        }
    }

    // The one way between movements, wherever the gesture came from: the title's own chevrons, a
    // jump in the assembly list, or a movement picked to be added. The sheet is closed only if one
    // is standing — `hide()` on a sheet that was never shown has no anchor to animate to.
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

    // Leaving a movement is the one boundary the change offer is raised at, and the sheet that
    // raised it cannot be the one still on screen — dismiss-then-present, the iOS `onDismiss:
    // settleTheMove`. The settle rides an effect keyed on the move AND on the sheet because those
    // are the two ways it can become due: with one hoisted sheetState, ModalBottomSheet only shows
    // itself on entering composition, so presenting the offer in the same frame the old sheet left
    // would raise it under the scrim, hidden — and a move made from the title with no sheet open
    // would never come due at all if only the sheet were watched.
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

    // The picker's meta is read when the picker OPENS and never as the filter runs: the live filter
    // walks the list already in hand, and a request per keystroke would be the N+1 that one read
    // exists to refuse. Asked again on every open, because a set logged since is exactly what it
    // reports.
    val pickerUp = store.exerciseId == null || sheet == LoggerSheet.Picker
    LaunchedEffect(pickerUp) {
        if (pickerUp) store.loadLastSets()
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
    // must not depend on the frame loop. It is the app's own sleep and not a system alarm — nothing
    // is booked with AlarmManager — so whatever ends the app ends the chime, and the settings row
    // says exactly that rather than promising a background alarm.
    //
    // NO TARGET, NO CHIME, and that is the default: the dial's first position is off, and a timer
    // nobody asked for that starts beeping in a gym is the thing this product does not do. Keyed on
    // the target and the sound too, so a lifter who arms the dial mid-rest is answered by THIS rest
    // rather than by the next one.
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
        LiveLines.onThisDeviceLine(store.strandedCount)?.let { line ->
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
            // §J22 — THE PICKER IS ALREADY UP, and it is the surface itself rather than a sheet
            // over one: a session with no movement in it has nothing behind the picker to go back
            // to, and a Cancel there would be a door onto an empty room. On the first session it
            // carries the six and the one account verb this room has; on any later one it is the
            // plain catalog under the header that already names the workout.
            MovementPicker(
                catalog = store.catalog,
                taken = store.order,
                lastSets = store.lastSets,
                nowMs = nowMs,
                // A QUESTION AND NEVER THE ROUTINE'S NAME. The header one line up already says
                // which workout this is, and a screen that said it twice is the duplicate section
                // head the phone screenshots caught once already.
                title = if (store.firstSession) "What are you starting with?" else "What are you lifting?",
                subtitle = if (store.session?.plan == null) "the session is already running"
                    else "nothing in this plan is left to walk",
                firstSession = store.firstSession,
                signedIn = isSignedIn,
                catalogUnread = store.catalogUnread,
                // No change offer to raise: nothing is being LEFT, so this is the plain choice the
                // sheet's `move` wraps.
                onPick = { picked -> scope.launch { store.choose(picked) } },
                // §N's two questions, over the picker that asked the first one. The sheet host at
                // the foot of this screen draws it — the inline picker has no sheet of its own to
                // swap, and it does not need one.
                onCreate = { name -> sheet = LoggerSheet.Create(name) },
                onBuildRoutine = onSignIn,
                modifier = Modifier.weight(1f),
            )
        } else {
            val counter = LiveLines.counter(LiveLines.workingCount(store.todaySets), store.planEntry)
            // The walk is the assembly list's order, so the chevrons and the list agree about what
            // comes next by construction. At either end the arrow is inert rather than wrapping: a
            // lifter who taps past the last movement wanted the one after it, not the first one.
            val at = store.order.indexOf(movement)
            MovementTitle(
                name = Readout.movement(movement, store.catalog),
                plan = counter.plan,
                // §K's other half of "where am I": the movement's place in the walk, counted off
                // the merged order so an appended movement counts the moment it joins.
                place = LiveLines.place(store.order, movement),
                walk = store.order.size,
                standing = at,
                previous = if (at < 0) null else store.order.getOrNull(at - 1),
                next = if (at < 0) null else store.order.getOrNull(at + 1),
                onMove = { move(it) },
                onOpenSession = { sheet = LoggerSheet.Assembly },
            )
            // ONE ELASTIC REGION AND ONLY ONE, and it is the history. Android phones run shorter
            // than the iPhones this layout was drawn for, so the rule is enforced structurally: the
            // value is measured first and takes what it needs, the history takes the leftover and
            // scrolls inside it, and everything below is the pinned tail — sets accumulating can
            // never push the 64dp action out of the thumb zone or shrink the number being dialled.
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
                    // Disarmed on the tap and not on the reply: the set is the lifter's the instant
                    // they press, and the kind is about the set that just went, never the network.
                    // A warmup is a single set and not a mode you can be left in — left armed, it
                    // would file every working set after it as a ramp-up.
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
                    // The same swap the builder makes: one sheet stack, and Cancel comes back to
                    // the picker with the query still typed rather than to the workout.
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
                            // The write that moves next week's target. Said when it does not land,
                            // or the lifter believes their program changed.
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

// WHERE YOU ARE AND THE CLOCK — the frame's one context line (§F), and on this screen the clock is
// the REST. It is the number a lifter between sets actually reads, and the hairline under it is what
// the rest USED to be: a line of text saying "resting · target 2:00", now the width of a bar. With
// the dial off there is no bar at all, because a track drawn against nothing would be a countdown
// nobody asked for. The session's own elapsed time lives one gesture away, on the assembly list.
//
// THE SENTENCE THE BAR REPLACED IS CARRIED BY THE CLOCK, not by the bar: with the dial off there is
// no bar to hang it on, and hanging it there would have deleted the word `resting` outright for
// every lifter who never touched the dial — which is the default. So the clock is the labelled
// thing, always, and the hairline beside it is decoration TalkBack walks past. The tap is named too:
// a number that silently cancels a chime is not a button anybody can find by ear.
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
                    // Being over the target is not an error and must never look like one: the
                    // overrun counts UP, in the accent — never alarm ink.
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
        // Drawn only against a target, and carrying no reading of its own — the clock above says
        // what this is, at every dial position, so a bar that repeated it would be TalkBack reading
        // the rest twice.
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

// NAVIGATION BELONGS IN THE TITLE, which is where §K moved it: the chevrons walk the session and the
// name itself opens the list they walk. What the plan asks for sits under the name, in the target's
// own ink — a movement the plan never named says `no target` there rather than borrowing a number —
// and under THAT, where the walk holds more than one movement, the position: one dot per movement in
// the merged order, filled in the accent through the one being stood on, then `movement 3 of 6`, the
// mono uppercase twin of the set counter over the numeral. The dots and the line are one fact drawn
// twice, so they share one gate — a walk of one says neither.
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
                // Counted off the merged order, so a movement appended on the bench mid-rest gets
                // its dot the moment it joins. Silent to TalkBack on purpose: the dots say nothing
                // the line under them does not already say.
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

// "WHERE AM I" IS ANSWERED BY LOOKING — the sets already done, as a column. Before the first one
// there is nothing to look at, so the same slot says what this movement did last time instead;
// after it, today is the only thing worth the space. The column scrolls inside itself past its cap,
// so the ladder, the reps and the 64dp action do not move as sets accumulate — the thumb learns one
// geometry on the first set and keeps it for the whole session.
//
// THE UNDO LIVES ON THE ROW IT WOULD TAKE BACK. The confirmation was always the row appearing; the
// sentence under it that said so was the screen narrating itself. Undo is offered exactly while the
// set can still be taken back — the log has no route that deletes one, so a button that outlived the
// window would have to apologise.
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
    // The newest row is the one being asked about, so it is the one kept in view when the column
    // has more sets in it than the cap will draw.
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

// ONE READING, WEIGHT DOMINANT — `105 kg × 5`. The numeral carries a dotted underline instead of a
// sentence telling anybody to tap it.
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
            // A −102.5 is the widest thing this readout ever holds. It shrinks rather than
            // truncating: half a weight is worse than a small one.
            //
            // THE NUMERAL IS THE DOOR AND THE UNDERLINE SAYS SO — the reps beside it are the other
            // half of one reading and are not a target: the whole composite taking a tap would send
            // a thumb aimed at `× 5` to the weight pad. Reps are typed from the stepper below, on
            // the number they change.
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

// THE SET'S KIND, AS ONE PILL THAT STATES THE CURRENT VALUE. It used to be a row of tags sitting in
// the reach band, one thumb-width from Log set — a mis-tap there filed a set as something it was
// not. Now it says what the next set is and the alternatives cost one deliberate gesture.
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

// The kinds this surface can actually log, and no others: a sheet listing `drop` and `failed` would
// be offering two writes the logger has never made. A warmup counts toward NOTHING — not the plan
// counter, not the sticky weight, no record rule, and not "Keep this as a routine".
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

// THE LABELS ARE THE NUMBERS, and the shapes say which is which: the fine step is the program step
// and takes the width, the plate step is a visibly smaller neighbour. That is what the tier caption
// used to say in words, and it is why there is no caption.
//
// TWO SCREENS DRAW IT — the rack and the kitchen table (§M's target sheet) — and it is one function
// for the same reason `Ladder` is one module: a builder that rounded a weight differently from the
// logger would be two answers to what goes on the bar, and only one of them has a golden.
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

// The steppers sit next to the number they change, and the number itself is still the door onto the
// pad — a rep count typed is the same gesture it always was, one tap further from the ladder.
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

// The ±1 button, beside the number it changes — the reps stepper here and the sets and reps
// steppers in §M's target sheet, one shape so a thumb finds the same target on both.
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
