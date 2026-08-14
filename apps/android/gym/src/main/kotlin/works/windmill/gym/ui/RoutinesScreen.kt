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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

// ROUTINES — HOME (§A/§B, the 13 Aug routine-first shape): the plans a lifter keeps, sitting still,
// and the only tab they act FROM. A row opens the routine's own page — the plan, and the one button
// that starts it — because a start is a deliberate act made on the day it starts, never a mis-tap
// on a list. The free-form door is "Just start logging" (R4), the second path now rather than the
// front door.
//
// HOME IS ALSO WHERE AN AGENT'S PROPOSAL WAITS, and where the rest of the retired Today tab's cargo
// rehomed: the boot-claim refusals banner and the signed-out claim offer stand above the list in
// the top band, and the settings door keeps its row at the foot. A change to a routine mints a card
// rather than a write, and the card lives here and on the routine it touches until the lifter
// applies or dismisses it — no push, no badge, no unread count and nothing that gets louder.
//
// "NOTHING RUNNING" IS STRUCTURAL: a live session takes the whole screen, so this list is only ever
// drawn while no clock is going, and the sub-line under the title says so as a fact.
//
// AND IT IS WHERE THE CONNECTED LOG IS OFFERED (§D screen 12). This is the tab about the PROGRAM,
// which is the thing a connected agent writes proposals against, so the offer stands at the foot of
// the days it would change. Signed out it is absent — a grant is granted against an ACCOUNT — and
// it sits under the list, which a lifter with nothing written down never reaches.
@Composable
fun RoutinesScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    origin: String,
    putOff: String?,
    onJustStart: () -> Unit,
    onBuild: (RoutineDraft) -> Unit,
    onOpenRoutine: (String) -> Unit,
    onReview: (Proposal) -> Unit,
    onLater: (Proposal) -> Unit,
    onOpenSettings: () -> Unit,
    onSignIn: () -> Unit,
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
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text("Routines", style = WindmillFont.display(32), color = GymSkin.ink)
            if (store.routines.isNotEmpty()) {
                Text(
                    "${Readout.routineCount(store.routines.size)} · nothing running",
                    style = GymType.numeral(13),
                    color = GymSkin.inkFaint,
                )
            }
        }

        // A loss said during a boot claim has no logger standing to show it, so the banner stands
        // here instead — the logger's own component, the logger's own words — until dismissed.
        Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })

        // THE CARD IS THE NOTIFICATION, and home is where it waits. The newest waiting one, and one
        // at a time — a stack of cards over the program somebody came here to read would be a room
        // asking for attention rather than answering a question. The others keep their dot on their
        // routine's row until this one is decided. Signed out this is empty by construction.
        store.pendingProposals.firstOrNull { it.id != putOff }?.let { waiting ->
            val about = store.routine(waiting.routineId)
            ProposalCard(
                proposal = waiting,
                routineName = about?.name ?: waiting.routineName,
                nowMs = nowMs,
                onReview = { onReview(waiting) },
                onLater = { onLater(waiting) },
            )
        }

        // The claim offer, and never a wall: the room already works, so this card only names what
        // signing in adds. It gates nothing and apologises for nothing.
        if (!isSignedIn) ClaimCard(onSignIn)

        if (store.routines.isEmpty()) {
            EmptyRoutines(
                onBuild = { onBuild(RoutineDraft(position = 0)) },
                onJustStart = onJustStart,
            )
        } else {
            store.routines
                .sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
                .forEach { routine ->
                    RoutineRow(routine, nowMs, onOpenRoutine, onReview)
                }

            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary - 8.dp)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable { onBuild(RoutineDraft(position = store.routines.size)) },
            ) {
                Text(
                    "New routine",
                    style = WindmillFont.body(16, FontWeight.Bold),
                    color = GymSkin.onAccent,
                )
            }
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clickable(onClick = onJustStart),
            ) {
                Text(
                    "Just start logging",
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.inkDim,
                )
            }

            if (isSignedIn) ConnectInvitation(origin)
        }

        SettingsDoor(onOpenSettings)
    }
}

// SCREEN 1 — empty, and it says what to do. Two verbs, both explicit: Build a routine, and Just
// start logging for the day you turn up without a plan. Free-form logging still assembles itself as
// you go and still offers to become a routine at the end — it is the second path now, not the front
// door. No wizard, no tour, no sample program, and no silent auto-creation: a routine exists
// because you named it.
@Composable
private fun EmptyRoutines(onBuild: () -> Unit, onJustStart: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x6),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(62.dp)
                .dashedEdge(GymSkin.lineStrong, WindmillRadius.lg),
        ) {
            Text("+", style = WindmillFont.display(26), color = GymSkin.inkFaint)
        }
        Text("No routines yet", style = WindmillFont.display(20), color = GymSkin.ink)
        Text(
            "A routine is one training day written down — the movements, in order, with your targets.",
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.inkDim,
            textAlign = TextAlign.Center,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable(onClick = onBuild),
        ) {
            Text(
                "Build a routine",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 10.dp)
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                .clickable(onClick = onJustStart),
        ) {
            Text(
                "Just start logging",
                style = WindmillFont.body(16, FontWeight.SemiBold),
                color = GymSkin.accent,
            )
        }
    }
}

// One plan on the shelf (screen 4): the name, `untested` while nobody has run it, what it holds and
// when it last ran. THE WHOLE ROW OPENS THE ROUTINE — a start lives on the page this leads to,
// where the plan is in front of the lifter, because the cost of the old shape was asymmetric: a tap
// meant for the chevron used to start a workout nobody asked for.
//
// A ROUTINE AN AGENT HAS PROPOSED SOMETHING ABOUT WEARS A DOT AND A COUNT, and the chip is its own
// target onto the diff — the card is the notification, and this is its second home. The border goes
// to the accent with it, because a routine waiting on a decision is the one row in this list with
// something to say.
@Composable
private fun RoutineRow(
    routine: Routine,
    nowMs: Long,
    onOpenRoutine: (String) -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val waiting = routine.pendingProposal
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 12.dp)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(
                1.dp,
                if (waiting == null) GymSkin.line else GymSkin.accent,
                RoundedCornerShape(WindmillRadius.lg),
            )
            .clickable { onOpenRoutine(routine.id) }
            .padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x3),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            ) {
                Text(
                    routine.name,
                    style = WindmillFont.body(17, FontWeight.Bold),
                    color = GymSkin.ink,
                    maxLines = 1,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (routine.untested) UntestedChip()
                waiting?.let { ProposalChip { onReview(it) } }
            }
            Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        Text(
            "›",
            style = WindmillFont.body(17, FontWeight.SemiBold),
            color = GymSkin.inkFaint,
            modifier = Modifier.padding(start = WindmillSpace.x3),
        )
    }
}

// `untested` marks a hand-built routine before its first session, on the home card and on the
// routine's own page (R2) — derived, never stored: the day the first session starts the word goes.
@Composable
private fun UntestedChip() {
    Box(
        Modifier
            .background(GymSkin.accentSoft, RoundedCornerShape(WindmillRadius.full))
            .padding(horizontal = WindmillSpace.x2, vertical = 2.dp),
    ) {
        Text("untested", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.accent)
    }
}

// The claim offer, rehomed from the retired Today tab with its stance unchanged: the room already
// works signed out, so this card only names what signing in adds — the account, and the web mirror.
@Composable
private fun ClaimCard(onSignIn: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.lg))
            .clickable(onClick = onSignIn)
            .padding(WindmillSpace.x4),
    ) {
        Text(
            "Your log is saved on this device.",
            style = WindmillFont.body(15, FontWeight.SemiBold),
            color = GymSkin.ink,
        )
        Text(
            "Sign in to claim it to your account — and open it on the web.",
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = GymSkin.inkFaint,
        )
    }
}

// THE DOOR §I DOES NOT DRAW, and it is here on loan. Gym's settings are a SECTION the shell's You
// sheet is meant to list and walk you into; this surface's product seam hands the shell a room and
// nothing else, and You is the platform's file. So the section keeps a door of its own at the foot
// of the one home — the quietest row on the quietest screen. It goes the day the seam grows a
// settings slot.
@Composable
private fun SettingsDoor(onOpenSettings: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clickable(onClick = onOpenSettings),
    ) {
        Text("Gym settings", style = GymType.numeral(13), color = GymSkin.inkFaint)
        Spacer(Modifier.weight(1f))
        Text("›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
    }
}

// One written line of a day: what it asks for, and a door onto that movement's record. The name is
// the target rather than the glyphs alone, so a thumb has the whole row to find.
//
// A ROW WITH NO TARGET READS `open` AND IS DRAWN QUIETLY — it is not an unfilled field and it is not
// an error: the day says decide at the rack. `· yours` marks a movement this lifter created (R5 —
// one word everywhere, the picker's), meaning only that they can recognise their own.
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
                " · yours",
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


// SCREEN 5 / R2 — ONE ROUTINE: the plan, read-only, and the one button that starts it. The name,
// `untested` beside when it was built, the lines with their targets or `open`, the one fact an open
// line creates, **Start workout** — literal, never name-substituted (R1) — and the History of how
// the day came to exist below it.
//
// THE HEADER IS BACK + EDIT. The standalone Rename sheet retired with the two-step editor: renaming
// is editing the inline name, on the same whole-document PUT, with the same consequence for a
// pending proposal. Duplicate and Delete moved into the editor's edit mode (R3).
//
// `untested` IS DERIVED AND NOT STORED. A routine with no last-trained instant has never been run —
// so there is no flag to keep true, and the day the first session starts the word simply goes. It
// marks the routine so THE FIRST SESSION IS ALLOWED TO DISAGREE WITH IT: what was typed at a
// kitchen table is a plan, and the log is what happened.
//
// HISTORY IS ONE READ AND IT HOLDS BOTH KINDS: the day being created — by the lifter's own hand, or
// by an agent — and every proposal made about it since, applied, dismissed or superseded. Nothing
// here is a toast that disappeared.
//
// SIGNED OUT THERE IS NOTHING TO DRAW AND NOTHING IS ASKED FOR. A routine the shelf holds has no
// history at all, and proposals need an account for an agent to have been granted anything against.
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
) {
    val nowMs = System.currentTimeMillis()
    val routine = store.routine(routineId)
    var history by remember(routineId) { mutableStateOf<List<RoutineEvent>>(emptyList()) }
    var unread by remember(routineId) { mutableStateOf(false) }

    // Re-read whenever the routine itself moves or its card is settled — an apply bumps the
    // revision, a dismissal empties the slot, an edit moves it too, and either way the row that
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
        // The way back and `Edit` share one row, exactly as the record page's do: a screen that
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
                        .clickable { onBuild(RoutineDraft.of(routine)) }
                        .padding(horizontal = WindmillSpace.x2),
                ) {
                    Text("Edit", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.accent)
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

        // R1: the routine's name is the screen title, so the verb is locked — literally
        // "Start workout", never "Start Push A".
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable { onStart(routine.id) },
        ) {
            Text(
                "Start workout",
                style = WindmillFont.body(16, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }

        History(history, unread, nowMs, onReview, onOpenThread)
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
