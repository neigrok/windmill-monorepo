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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// ROUTINES — the written-down days of the program, and the third of the room's three tabs (§F). It
// is a list and three ways in: a routine, what it asks for, a tap that starts the one you are looking
// at, a chevron onto the routine itself, and `New` — §M's third door.
//
// `New` ARRIVED IN W10 AND THIS TAB USED TO REFUSE IT. The refusal was real while it stood: every
// door that WRITES a routine was the desk's (gym ARCHITECTURE.md §11), and the two a phone owned
// arrived at the moments they make sense — "Keep this as a routine" at the finish, and the change
// offer mid-session. What §M established is that a lifter copying a program out of a notebook has
// neither of those moments, and that building a day at the kitchen table is not desk work borrowed
// from the web but the door that lifter reaches for first. The editor it opens is a name and a list
// (RoutineBuilder), which is the whole of what a routine is.
//
// WHAT THE CHEVRON OPENS is screen 30: the routine as it stands, whether it has ever been trained,
// the History of how it came to exist and every proposal made about it since — each a dated record
// rather than a toast that disappeared — and the three things you can do with a day.
//
// The order is the log's own — trained most recently first, the same order the server sends
// (`ORDER BY last_trained_ms DESC NULLS LAST`) — so the footer line is a statement about this list
// and never a wish. It is restated here because the device's own unclaimed routines arrive after
// the server's and would otherwise sit at the bottom whatever their last session was.
//
// AND IT IS WHERE THE CONNECTED LOG IS OFFERED (§D screen 12). This is the tab about the PROGRAM,
// which is the thing a connected agent writes proposals against, so the offer stands at the foot of
// the days it would change — one screen away from the diff it would produce. It is an invitation and
// not a gate: it wears no lock, names no tier and no price, and leads to no checkout.
//
// TWO CONDITIONS, AND BOTH ARE ABOUT THE OFFER BEING TAKEABLE rather than about selling it harder.
// Signed out it is absent, because a grant is granted against an ACCOUNT and this room's log is on
// the device until a sign-in claims it — the same rule that withholds Ask's door and the proposal
// card. And it sits under the LIST, which the empty state returns before ever reaching: the pitch is
// about training already logged, and a lifter with nothing written down is being shown an exchange
// that would come back empty.
@Composable
fun RoutinesScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    origin: String,
    onStart: (String) -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onOpenMovement: (String) -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x8),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Routines", style = WindmillFont.display(32), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            // The new day's position is the foot of the list, which is where a program's newest day
            // goes; the list itself is sorted by training and re-sorts itself the moment it runs.
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .clickable { onBuild(RoutineDraft(position = store.routines.size)) }
                    .padding(horizontal = WindmillSpace.x2),
            ) {
                Text("New", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.accent)
            }
        }

        // BOTH DOORS, NAMED. The first is still the one this product is built around — a lifter who
        // trains and names it at the end never types a program in — and the second is for the lifter
        // holding a notebook, who has nothing to name yet.
        if (store.routines.isEmpty()) {
            Text(
                "Nothing written down yet. Log a session and name it at the end, or write a day out now with New.",
                style = WindmillFont.body(16).copy(lineHeight = 24.sp),
                color = GymSkin.inkDim,
                modifier = Modifier.padding(top = WindmillSpace.x2),
            )
            return@Column
        }

        store.routines
            .sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
            .forEach { routine ->
                RoutineTile(routine, store, nowMs, onStart, onOpenRoutine, onOpenMovement, onReview)
            }

        if (isSignedIn) ConnectInvitation(origin)
    }
}

// The tile starts the routine, its chevron opens it, and each of its lines opens that movement's
// record (§H) — three meanings on one card, and the inner one wins where it is drawn, which is the
// whole line the movement's name sits on. The cost of confusing them is asymmetric and that is why
// they can share: a tap meant for Start that lands on a name opens a read-only page one chevron
// from here, where the reverse would be a workout somebody did not ask for.
//
// A ROUTINE AN AGENT HAS PROPOSED SOMETHING ABOUT WEARS A DOT AND A COUNT, and the chip is its own
// target onto the diff — the card is the notification, and this is its second home. The border goes
// to the accent with it, because a routine waiting on a decision is the one row in this list with
// something to say. Signed out no routine carries one, so nothing here is drawn and nothing is
// explained: a lifter with no account is not being sold a surface.
@Composable
private fun RoutineTile(
    routine: Routine,
    store: TrainingStore,
    nowMs: Long,
    onStart: (String) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onOpenMovement: (String) -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val waiting = routine.pendingProposal
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(
                1.dp,
                if (waiting == null) GymSkin.line else GymSkin.accent,
                RoundedCornerShape(WindmillRadius.lg),
            )
            .clickable { onStart(routine.id) }
            .padding(WindmillSpace.x4),
    ) {
        // The name and its chip on one line, what the day holds on the next — canon screen 5's own
        // stacking, and the reason it is stacked: a chip, a date and a chevron on one row is four
        // things competing for a 320dp phone, and the name is the one that would be truncated.
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                ) {
                    Text(
                        routine.name,
                        style = WindmillFont.body(17, FontWeight.Bold),
                        color = GymSkin.ink,
                        maxLines = 1,
                    )
                    waiting?.let { ProposalChip { onReview(it) } }
                }
                Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint)
            }
            Text(
                "›",
                style = WindmillFont.body(17, FontWeight.SemiBold),
                color = GymSkin.inkFaint,
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .clickable { onOpenRoutine(routine.id) }
                    .padding(horizontal = WindmillSpace.x3),
            )
        }
        routine.entries.sortedBy { it.position }.forEach { entry ->
            EntryRow(entry, store, onOpenMovement)
        }
    }
}

// One written line of a day: what it asks for, and a door onto that movement's record. The name is
// the target rather than the glyphs alone, so a thumb has the whole row to find.
//
// A ROW WITH NO TARGET READS `open` AND IS DRAWN QUIETLY — it is not an unfilled field and it is not
// an error: the day says decide at the rack. `· mine` marks a movement this lifter created, which is
// the same tag the picker uses and means the same thing: a movement that behaves exactly like a
// seeded one and is labelled only so they can recognise their own.
@Composable
private fun EntryRow(entry: RoutineEntry, store: TrainingStore, onOpenMovement: (String) -> Unit) {
    val movement = store.catalog.firstOrNull { it.id == entry.exerciseId }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clickable { onOpenMovement(entry.exerciseId) },
    ) {
        Text(
            movement?.name ?: entry.exerciseId,
            style = WindmillFont.body(14),
            color = GymSkin.inkDim,
        )
        if (movement?.custom == true) {
            Text(
                " · mine",
                style = GymType.numeral(11),
                color = GymSkin.inkFaint,
            )
        }
        Spacer(Modifier.weight(1f))
        Text(
            Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
            style = GymType.numeral(12),
            color = if (entry.targetSets == null) GymSkin.inkFaint else GymSkin.targetInk,
        )
    }
}


// SCREEN 30 — ONE ROUTINE, AND HONEST ABOUT WHETHER IT HAS EVER BEEN TRAINED. The name, `untested`
// beside when it was built, the lines with their targets or `open`, the one fact an open line
// creates, the History of how the day came to exist, and the three things you can do with it.
//
// `untested` IS DERIVED AND NOT STORED. A routine with no last-trained instant has never been run,
// which is exactly what the log's own aggregate says — so there is no flag to keep true, and the
// day the first session starts the word simply goes. It marks the routine so THE FIRST SESSION IS
// ALLOWED TO DISAGREE WITH IT: what was typed at a kitchen table is a plan, and the log is what
// happened.
//
// THE FACT UNDER THE LIST IS A FACT. `Barbell Row has no target — it will ask at the rack` tells the
// lifter what will happen to their training on Thursday. Why this product allows a row with no
// target is an argument for the board, and it is not on this glass.
//
// HISTORY IS ONE READ AND IT NOW HOLDS BOTH KINDS: the day being created — by the lifter's own hand,
// or by an agent, which is the absence of `by` and never a guess — and every proposal made about it
// since, applied, dismissed or superseded. A lifter who dismissed one in a hurry can still read what
// it said, and nothing here is a toast that disappeared.
//
// SIGNED OUT THERE IS NOTHING TO DRAW AND NOTHING IS ASKED FOR. A routine the shelf holds has no
// history at all — this device does not record the evening a local routine was typed, and inventing
// a date would be worse than the absence — and proposals need an account for an agent to have been
// granted anything against. So a signed-out lifter sees the routine, its lines and its word, and no
// empty section, no explanation and no offer.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutineScreen(
    routineId: String,
    store: TrainingStore,
    isSignedIn: Boolean,
    backLabel: String,
    onBack: () -> Unit,
    onStart: (String) -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    onOpenMovement: (String) -> Unit,
    onReview: (Proposal) -> Unit,
    onOpenThread: (String) -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    val routine = store.routine(routineId)
    var history by remember(routineId) { mutableStateOf<List<RoutineEvent>>(emptyList()) }
    var unread by remember(routineId) { mutableStateOf(false) }
    // Saveable for the reason every half-typed name in this room is: it exists nowhere else, and a
    // recreation that dropped it would be the room throwing away something the lifter typed.
    var renaming by rememberSaveable(routineId) { mutableStateOf(false) }
    var draft by rememberSaveable(routineId) { mutableStateOf("") }
    var refused by remember(routineId) { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { renaming = false }
    }

    // Re-read whenever the routine itself moves or its card is settled — an apply bumps the
    // revision, a dismissal empties the slot, a rename moves it too, and either way the row that
    // just moved belongs in the list below. There is nothing held between visits: a history is short
    // and a stale one would be the screen disagreeing with the diff the lifter just came back from.
    LaunchedEffect(routineId, isSignedIn, routine?.revision, routine?.pendingProposal?.id) {
        when (val read = store.routineHistory(routineId)) {
            is GymResult.Ok -> {
                history = read.value
                unread = false
            }
            is GymResult.Failed -> unread = true
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x8),
    ) {
        // The way back and `Rename` share one row, exactly as the record page's do: a screen that
        // owns an action in that row owns the row.
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
            ) {
                Text("‹", style = WindmillFont.body(20, FontWeight.SemiBold), color = GymSkin.inkDim)
                Text(backLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.inkDim)
            }
            Spacer(Modifier.weight(1f))
            if (routine != null) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .heightIn(min = GymTap.minimum)
                        .clickable {
                            refused = null
                            draft = routine.name
                            renaming = true
                        }
                        .padding(horizontal = WindmillSpace.x2),
                ) {
                    Text("Rename", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.accent)
                }
            }
        }

        // A routine that is no longer there — an applied removal, or a delete from another surface.
        // The page says so plainly rather than drawing an empty day.
        if (routine == null) {
            Text(
                "That routine is no longer in your program. Everything you logged against it is still in the log.",
                style = WindmillFont.body(16).copy(lineHeight = 24.sp),
                color = GymSkin.inkDim,
            )
            return@Column
        }

        // The history this screen read is what dates the head: the routine came off the LIST and
        // carries none of its own, so the built line arrives with the same read the section below
        // draws and the chip stands alone until it does.
        val head = Program.head(routine, history, nowMs)
        Text(routine.name, style = WindmillFont.display(30), color = GymSkin.ink)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        ) {
            if (head.untested) {
                Box(
                    Modifier
                        .background(GymSkin.accentSoft, RoundedCornerShape(WindmillRadius.full))
                        .padding(horizontal = WindmillSpace.x2, vertical = 2.dp),
                ) {
                    Text("untested", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.accent)
                }
            }
            Text(head.line, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }

        routine.pendingProposal?.let { waiting ->
            ProposalCard(waiting, routine.name, nowMs, onReview = { onReview(waiting) })
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            routine.entries.sortedBy { it.position }.forEach { entry ->
                EntryRow(entry, store, onOpenMovement)
            }
        }

        Program.openLine(
            routine.entries.sortedBy { it.position }
                .filter { it.targetSets == null }
                .map { Readout.movement(it.exerciseId, store.catalog) }
        )?.let {
            Text(it, style = WindmillFont.body(14).copy(lineHeight = 21.sp), color = GymSkin.inkDim)
        }

        History(history, unread, nowMs, onReview, onOpenThread)

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable { onStart(routine.id) },
        ) {
            Text(
                "Start ${routine.name}",
                style = WindmillFont.body(16, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }

        // Both open the same builder over the same document, which is why neither needs a screen of
        // its own: an edit carries the routine's id and lands as a whole-document PUT, and a
        // duplicate carries its movements and no name, because a copy is a new day and §M asks for
        // every day's name once and first.
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            SecondaryAction("Edit", Modifier.weight(1f)) { onBuild(RoutineDraft.of(routine)) }
            SecondaryAction("Duplicate", Modifier.weight(1f)) {
                onBuild(RoutineDraft.copying(routine, position = store.routines.size))
            }
        }
    }

    // §N's sheet, over the routine rather than over a movement — so it carries the field and no
    // proof block: the counts that block is made of are counts of TRAINING, and a routine renamed
    // has none of the kind to show. Inventing one would be the constant the block exists to refuse.
    //
    // THERE IS NO RENAME ROUTE, and there should not be: the write is the whole document, which is
    // what moves the revision and supersedes any pending proposal on this routine. A name change
    // really is a change to the day an agent wrote its diff against — which is exactly why the sheet
    // refuses a rename to the name already on the routine (`Program.renamed`): that write costs a
    // waiting proposal and buys nothing, and the price is only fair for a change somebody made.
    if (renaming && routine != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
            dragHandle = null,
        ) {
            RenameSheet(
                title = "Rename this routine",
                from = routine.name,
                value = draft,
                proof = emptyList(),
                refused = refused,
                onValue = { draft = it },
                onCancel = {
                    refused = null
                    close()
                },
                onRename = {
                    scope.launch {
                        val renamed = RoutineDraft.of(routine).named(draft)
                        when (val written = store.saveRoutine(renamed)) {
                            is GymResult.Failed ->
                                refused = written.why.line("that routine kept its name")
                            is GymResult.Ok -> {
                                say(null)
                                close()
                            }
                        }
                    }
                },
            )
        }
    }
}

// The two quiet doors under Start — a word in a bordered band, never an accent fill: this screen has
// one primary action and it is the workout.
@Composable
private fun SecondaryAction(label: String, modifier: Modifier, onTap: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .heightIn(min = GymTap.minimum)
            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
            .clickable(onClick = onTap),
    ) {
        Text(label, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
    }
}

// `9 Aug · created by you · 4 movements`, then `2 Aug · applied 3 changes from Claude` above it —
// one row per dated thing that happened to this day, newest first, and the creation row always last
// because it is the one thing that happened first. A proposal row is a door back onto the diff it
// settled; a creation row is not a door, because there is nothing behind it to open.
//
// A ROW THAT CAME OUT OF A CONVERSATION CARRIES A SECOND DOOR (§O), and it is the trail running the
// other way: the history says a change came from Ask, and `Ask ›` opens the evening it was asked
// for. It is drawn ONLY where the proposal's source actually carries a thread — the MCP door has no
// conversation, and a lifter who deleted theirs has none left — because a door onto an absence would
// promise a conversation and then answer that there is no such conversation. The row still says the
// change came from Ask either way: deleting the conversation does not delete the consequence.
//
// A ROW THIS BUILD CANNOT NAME IS NOT DRAWN. The event's own `line` answers null for a kind it has
// never heard of, and an empty row over a dated program is worse than a shorter list.
//
// A HISTORY THAT COULD NOT BE READ IS NOT AN EMPTY ONE, and the two never collapse into one silence
// — a routine with four decisions on it would otherwise read as one nobody has ever touched, which
// is exactly the false claim this room refuses to make about a log.
@Composable
private fun History(
    events: List<RoutineEvent>,
    unread: Boolean,
    nowMs: Long,
    onReview: (Proposal) -> Unit,
    onOpenThread: (String) -> Unit,
) {
    val drawn = events.filterNot { it.isPending }.mapNotNull { event ->
        event.line(nowMs)?.let { event to it }
    }
    if (drawn.isEmpty() && !unread) return
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
    ) {
        Text("History", style = GymType.numeral(11), color = GymSkin.inkFaint)
        if (unread) {
            Text(
                "the log didn’t answer — this routine's history is out of reach",
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
            )
        }
        drawn.forEach { (event, line) ->
            val diff = event.proposal
            val conversation = diff?.source?.conversation
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.md))
                    .padding(start = WindmillSpace.x3),
            ) {
                Text(
                    line,
                    style = GymType.numeral(12).copy(lineHeight = 18.sp),
                    color = GymSkin.inkDim,
                    modifier = Modifier
                        .weight(1f)
                        .then(if (diff == null) Modifier else Modifier.clickable { onReview(diff) }),
                )
                // Two doors on one row, and each is only ever the door it looks like: the line opens
                // the diff it describes, and this opens the conversation that wrote it.
                conversation?.let { threadId ->
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable { onOpenThread(threadId) }
                            .padding(horizontal = WindmillSpace.x2),
                    ) {
                        Text(
                            "Ask ›",
                            style = GymType.numeral(11, FontWeight.Bold),
                            color = GymSkin.accent,
                            maxLines = 1,
                        )
                    }
                }
                if (diff != null && conversation == null) {
                    Text(
                        "›",
                        style = WindmillFont.body(15, FontWeight.SemiBold),
                        color = GymSkin.inkFaint,
                        modifier = Modifier.padding(end = WindmillSpace.x3),
                    )
                }
            }
        }
    }
}
