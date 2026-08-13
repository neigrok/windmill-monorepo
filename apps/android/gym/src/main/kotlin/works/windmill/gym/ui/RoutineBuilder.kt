package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.net.WindmillJson

// BUILDING A DAY BEFORE YOU GO (§M, screens 28 and 29) — the third door onto a routine, and the one
// a lifter with a program in a notebook reaches for first. The other two already stand: a routine
// falls out of the session you just did (the finish screen names it), or an agent proposes one.
//
// NAME FIRST, AND THE NAME IS A REAL QUESTION ASKED ONCE. A routine built on purpose deserves the
// word you call it, not "Workout 3" — so the first screen is a field with the keyboard already up,
// and the suggestions under it fill the field rather than deciding anything.
//
// THEN MOVEMENTS, THEN TARGETS IN A SHEET OVER THE LIST, so the shape of the day stays visible while
// numbers are typed into it. The sheet is where the two rules of this wave live: there is no history
// behind a routine built at home, so it SAYS SO instead of prefilling a guess, and `Leave it open`
// is a first-class answer rather than a failure to fill something in.
//
// NO WIZARD, NO STEP COUNTER, NO TEMPLATE GALLERY, NO WEEK. Two screens, and the second one is
// savable from the moment it holds a movement: a routine is a list with a name, and a week is a
// thing lifters keep in their head and we would only get wrong.

// A HALF-TYPED ROUTINE EXISTS NOWHERE BUT IN MEMORY — not on the log, not on the shelf, not in the
// queue — so it is saved the way the room saves a conversation, and for the same reason: an activity
// reclaimed mid-build would otherwise take an evening at the kitchen table with it. A draft that
// cannot be written answers null, which drops it rather than crashing the room; the loss is the same
// one the lifter would have had without any of this.
val routineDraftSaver: Saver<RoutineDraft?, String> = Saver(
    save = { draft -> draft?.let { runCatching { WindmillJson.encodeToString(RoutineDraft.serializer(), it) }.getOrNull() } ?: "" },
    restore = { written ->
        if (written.isEmpty()) null
        else runCatching { WindmillJson.decodeFromString(RoutineDraft.serializer(), written) }.getOrNull()
    },
)

// The three numbers standing on the target sheet, carried by the sheet stack rather than held
// inside the sheet — because typing a weight LEAVES that sheet for the pad and comes back, and a
// dial that lived only in the sheet would answer the trip by forgetting the sets and reps the
// lifter had just dialled. Absent on the way in, where the row's own targets seed it.
private data class Dial(val sets: Int, val reps: Int, val weightKg: Double)

private sealed interface BuilderSheet {
    data class Target(val exerciseId: String, val dialled: Dial? = null) : BuilderSheet
    data class Weight(val exerciseId: String, val dialled: Dial) : BuilderSheet
    data object Picker : BuilderSheet
    data class Create(val name: String) : BuilderSheet
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineBuilder(
    draft: RoutineDraft,
    store: TrainingStore,
    backLabel: String,
    saving: Boolean,
    onDraft: (RoutineDraft) -> Unit,
    // THE SAVE IS THE ROOM'S AND NOT THIS SCREEN'S, for the reason every write in this product is
    // owned by something that outlives the surface it was made on: this composition dies the moment
    // the draft is let go of, and a back gesture inside the round trip would cancel a routine
    // half-way onto the log with nothing left standing to say so.
    onSave: () -> Unit,
    onClose: () -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    // Which of the two screens is up. A draft that already has a name arrives on the second — an
    // edit, and a process death that restored one mid-build — and everything else starts at the
    // question. It is saveable so a rotation does not walk a lifter back to a name they just typed.
    var naming by rememberSaveable(draft.id) { mutableStateOf(Program.named(draft.name) == null) }
    var sheet by remember { mutableStateOf<BuilderSheet?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Every programmatic close falls through the sheet's own hide animation, exactly as the
    // logger's does: Compose fires no dismiss callback on one, so nothing waits for it.
    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { sheet = null }
    }

    Column(Modifier.fillMaxSize()) {
        if (naming) {
            NameStep(
                draft = draft,
                backLabel = backLabel,
                onDraft = onDraft,
                onNext = { naming = false },
                onBack = onClose,
            )
            return@Column
        }
        BuildStep(
            draft = draft,
            store = store,
            saving = saving,
            onBack = { naming = true },
            onOpenTarget = { sheet = BuilderSheet.Target(it) },
            onRemove = { onDraft(draft.removing(it)) },
            onAdd = { sheet = BuilderSheet.Picker },
            onSave = onSave,
        )
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
                is BuilderSheet.Target -> TargetSheet(
                    draft = draft,
                    exerciseId = open.exerciseId,
                    dialled = open.dialled,
                    store = store,
                    onType = { sheet = BuilderSheet.Weight(open.exerciseId, it) },
                    onSet = {
                        onDraft(draft.targeting(open.exerciseId, it.sets, it.reps, it.weightKg))
                        close()
                    },
                    onOpen = {
                        onDraft(draft.opening(open.exerciseId))
                        close()
                    },
                )
                // The same pad the rack types on, over the same sheet stack: the ladder reaches
                // every weight in the product and 140 from an empty bar is fourteen taps of it.
                // Both ways out carry the dial back, so a trip to the pad costs nothing typed —
                // Cancel keeps the number that was there and Set brings the typed one home.
                is BuilderSheet.Weight -> KeypadSheet(
                    mode = KeypadEntry.Mode.Weight,
                    current = open.dialled.weightKg,
                    onCommit = { typed ->
                        sheet = BuilderSheet.Target(open.exerciseId, open.dialled.copy(weightKg = typed))
                    },
                    onCancel = { sheet = BuilderSheet.Target(open.exerciseId, open.dialled) },
                )
                BuilderSheet.Picker -> MovementPicker(
                    catalog = store.catalog,
                    taken = draft.entries.map { it.exerciseId },
                    // The picker's meta is what a lifter last did with a movement, and it is
                    // deliberately not asked for here: this screen is not aiming a set, it is
                    // writing down a day, and a `last 82.5 × 5` beside every row would be the
                    // prefill this wave refuses arriving through the side door.
                    lastSets = null,
                    nowMs = 0,
                    title = "Add a movement",
                    catalogUnread = store.catalogUnread,
                    onPick = {
                        onDraft(draft.adding(it))
                        close()
                    },
                    onCreate = { sheet = BuilderSheet.Create(it) },
                    modifier = Modifier
                        .fillMaxHeight(0.92f)
                        .background(GymSkin.surface)
                        .padding(WindmillSpace.x5),
                    onClose = { close() },
                )
                // §N's own screen, reached from the door the picker has always had: a movement the
                // catalog has never heard of is minted with the name that was typed and the loading
                // the lifter picks, and lands in the day it was created for.
                is BuilderSheet.Create -> CreateMovementSheet(
                    name = open.name,
                    onCancel = { sheet = BuilderSheet.Picker },
                    onCreate = { name, equipment ->
                        say(null)
                        close()
                        scope.launch {
                            when (val made = store.create(name, equipment)) {
                                is GymResult.Ok -> onDraft(draft.adding(made.value.id))
                                is GymResult.Failed -> say(made.why.line("“$name” wasn’t created"))
                            }
                        }
                    },
                )
            }
        }
    }
}

// SCREEN 28 — the name, asked first and asked once. The keyboard is up on arrival because there is
// exactly one thing to do here, and a screen that made a lifter tap the field first would be asking
// them to find the question.
//
// THE SUGGESTIONS ARE SUGGESTIONS. Tapping one fills the field and typing over it is the expected
// case; nothing here is a category, nothing is remembered, and a routine named none of the three is
// the ordinary outcome.
@Composable
private fun NameStep(
    draft: RoutineDraft,
    backLabel: String,
    onDraft: (RoutineDraft) -> Unit,
    onNext: () -> Unit,
    onBack: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val named = Program.named(draft.name) != null

    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxSize()
            .imePadding()
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x5),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
        ) {
            Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text(backLabel, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text("What do you call this one?", style = WindmillFont.display(30), color = GymSkin.ink)
            Text(
                "Whatever you already call it.",
                style = WindmillFont.body(16),
                color = GymSkin.inkDim,
            )
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = draft.name,
                onValueChange = { onDraft(draft.named(it)) },
                singleLine = true,
                textStyle = WindmillFont.display(26).copy(color = GymSkin.ink),
                cursorBrush = SolidColor(GymSkin.accent),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Words,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { if (named) onNext() }),
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum + 8.dp)
                    .focusRequester(focus),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (draft.name.isEmpty()) {
                            Text("Heavy Thursday", style = WindmillFont.display(26), color = GymSkin.inkFaint)
                        }
                        inner()
                    }
                },
            )
            Text(
                Program.counter(draft.name),
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(GymSkin.lineStrong))

        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Program.suggestions.forEach { suggestion ->
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .heightIn(min = GymTap.minimum - 8.dp)
                        .clip(RoundedCornerShape(WindmillRadius.full))
                        .background(GymSkin.raised)
                        .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.full))
                        .clickable { onDraft(draft.named(suggestion)) }
                        .padding(horizontal = WindmillSpace.x4),
                ) {
                    Text(suggestion, style = WindmillFont.body(14), color = GymSkin.inkDim)
                }
            }
        }

        Spacer(Modifier.weight(1f))

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (named) GymSkin.accent else GymSkin.raised)
                .clickable(enabled = named, onClick = onNext),
        ) {
            Text(
                "Next · add movements",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = if (named) GymSkin.onAccent else GymSkin.inkFaint,
            )
        }
    }
}

// SCREEN 29's LIST — the shape of the day, with the targets typed so far beside each movement and
// `open` beside each one that has none. It stays on screen under the target sheet, which is the
// whole reason the targets are asked for in a sheet at all.
//
// A MOVEMENT LEAVES BY THE SAME GESTURE IT LEAVES A SESSION BY — a sideways flick, the assembly
// list's own (§A2), at the same thumb's width of travel. Nothing here has been logged, so every row
// can go; the list is a draft, and a movement added by mistake must have a way out that is not
// abandoning the evening.
@Composable
private fun BuildStep(
    draft: RoutineDraft,
    store: TrainingStore,
    saving: Boolean,
    onBack: () -> Unit,
    onOpenTarget: (String) -> Unit,
    onRemove: (String) -> Unit,
    onAdd: () -> Unit,
    onSave: () -> Unit,
) {
    val dropAt = with(LocalDensity.current) { 108.dp.toPx() }
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x8),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
        ) {
            Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text(draft.name, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
        }

        if (draft.entries.isEmpty()) {
            Text("Nothing in this day yet.", style = WindmillFont.body(16), color = GymSkin.inkDim)
        }

        draft.entries.sortedBy { it.position }.forEach { entry ->
            var swipe by remember(entry.exerciseId) { mutableFloatStateOf(0f) }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .graphicsLayer {
                        translationX = swipe
                        alpha = 1f - (abs(swipe) / (dropAt * 2f)).coerceAtMost(0.6f)
                    }
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.surface)
                    .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                    .pointerInput(entry.exerciseId) {
                        detectHorizontalDragGestures(
                            onDragEnd = {
                                if (abs(swipe) >= dropAt) onRemove(entry.exerciseId) else swipe = 0f
                            },
                            onDragCancel = { swipe = 0f },
                            onHorizontalDrag = { change, amount ->
                                change.consume()
                                swipe += amount
                            },
                        )
                    }
                    .clickable { onOpenTarget(entry.exerciseId) }
                    .padding(horizontal = WindmillSpace.x4),
            ) {
                Text(
                    Readout.movement(entry.exerciseId, store.catalog),
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.ink,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
                    style = GymType.numeral(13),
                    color = if (entry.targetSets == null) GymSkin.inkFaint else GymSkin.targetInk,
                )
            }
        }

        // Appending is the same dashed slot the assembly list uses, and it means the same thing
        // here: a place waiting to be filled. It goes at the ceiling the log itself refuses past.
        if (!draft.full) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .dashedEdge(GymSkin.lineStrong, WindmillRadius.md)
                    .clickable(onClick = onAdd),
            ) {
                Text("+ Add a movement", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }

        Spacer(Modifier.height(WindmillSpace.x2))

        // SAVABLE WHILE INCOMPLETE, and never while empty: a day with no movements in it is not a
        // day. Rows with no targets go out open, which is the point.
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (draft.savable && !saving) GymSkin.accent else GymSkin.raised)
                .clickable(enabled = draft.savable && !saving, onClick = onSave),
        ) {
            Text(
                "Save ${draft.name}",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = if (draft.savable && !saving) GymSkin.onAccent else GymSkin.inkFaint,
                maxLines = 1,
            )
        }
    }
}

// SCREEN 29's SHEET — one movement's targets, over the list so the shape of the day stays visible
// while numbers are typed into it.
//
// `Never logged — these are your numbers.` IS A FACT ABOUT THIS ROUTINE and not about the movement:
// a day built at the kitchen table has never been run, so there is no last time to dial to and the
// sheet says so rather than prefilling a guess and attributing it to the lifter. It is withheld from
// an edit of a day that HAS run, where it would simply be false.
//
// THE LADDER IS THE ONE THE RACK USES — `LadderRow`, the same function, over the same `Ladder` band
// table. There is no second stepper in this product: a kitchen table that rounded differently from
// the rack would be two answers to what a target weight is.
@Composable
private fun TargetSheet(
    draft: RoutineDraft,
    exerciseId: String,
    dialled: Dial?,
    store: TrainingStore,
    onType: (Dial) -> Unit,
    onSet: (Dial) -> Unit,
    onOpen: () -> Unit,
) {
    val entry = draft.entry(exerciseId)
    // The dial the sheet opens on: what came back from the pad, then what the row already asks for,
    // then the product's own starting point — three sets of five at the empty bar, which is a
    // constant precisely BECAUSE nothing here reaches for this lifter's history.
    var sets by remember(exerciseId, dialled) {
        mutableIntStateOf(dialled?.sets ?: entry?.targetSets ?: RoutineDraft.startingSets)
    }
    var reps by remember(exerciseId, dialled) {
        mutableIntStateOf(dialled?.reps ?: entry?.targetReps ?: RoutineDraft.startingReps)
    }
    var weightKg by remember(exerciseId, dialled) {
        mutableDoubleStateOf(dialled?.weightKg ?: entry?.targetWeightKg ?: Prefill.EMPTY_BAR_KG)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            Text(
                Readout.movement(exerciseId, store.catalog),
                style = WindmillFont.display(22),
                color = GymSkin.ink,
                maxLines = 1,
                modifier = Modifier.weight(1f, fill = false),
            )
            draft.placeOf(exerciseId)?.let { place ->
                Text(
                    "$place of ${draft.entries.size} · ${draft.name}",
                    style = GymType.numeral(12),
                    color = GymSkin.inkFaint,
                    maxLines = 1,
                )
            }
        }

        if (!draft.trained) {
            Text(
                "Never logged — these are your numbers.",
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            Counted("Sets", sets, Modifier.weight(1f)) {
                sets = (sets + it).coerceIn(1, Program.maxSets)
            }
            Counted("Reps", reps, Modifier.weight(1f)) {
                reps = Ladder.bumpReps(reps, it).coerceAtMost(Program.maxReps)
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text("Target weight", style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                verticalAlignment = Alignment.Bottom,
            ) {
                // The numeral is the door onto the pad, exactly as it is at the rack.
                BasicText(
                    Readout.weight(weightKg),
                    maxLines = 1,
                    autoSize = TextAutoSize.StepBased(minFontSize = 28.sp, maxFontSize = 48.sp),
                    style = GymType.weight.copy(fontSize = 48.sp, lineHeight = 48.sp, color = GymSkin.weightInk),
                    modifier = Modifier.clickable { onType(Dial(sets, reps, weightKg)) },
                )
                Text("kg", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.inkFaint)
                Spacer(Modifier.weight(1f))
            }
        }

        LadderRow(weightKg, onDial = { weightKg = it })

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable { onSet(Dial(sets, reps, weightKg)) },
        ) {
            Text(
                "Set  ·  ${Readout.target(sets, reps, weightKg)}",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }

        // A FIRST-CLASS ANSWER AND NOT A CANCEL. It clears the whole row — the log refuses reps or a
        // weight on a line with no sets — and the day is savable with it, because a row that decides
        // at the rack is a row a written program is allowed to have.
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum + 6.dp)
                .clickable(onClick = onOpen)
                .padding(top = WindmillSpace.x1),
        ) {
            Text("Leave it open", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text("decide at the rack", style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
    }
}

// One counted target and its two steps — sets and reps, side by side, each the number it changes
// with a step either side of it. The steps are `Step`, the rack's own.
@Composable
private fun Counted(label: String, value: Int, modifier: Modifier, onStep: (Int) -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Text(label, style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Step("−") { onStep(-1) }
            Box(
                Modifier.weight(1f).sizeIn(minHeight = GymTap.minimum),
                contentAlignment = Alignment.Center,
            ) {
                Text(value.toString(), style = GymType.numeral(20, FontWeight.Bold), color = GymSkin.ink)
            }
            Step("+") { onStep(1) }
        }
    }
}
