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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// ROUTINES — the written-down days of the program, and the third of the room's three tabs (§F). It
// is a list and two ways in: a routine, what it asks for, a tap that starts the one you are looking
// at, and a chevron onto the routine itself.
//
// IT DRAWS NO EDITOR, NO `New` AND NO DUPLICATE, and that is a fact about this surface rather than a
// gap in this screen. Canon screen 5 gives all three a row action, and every one of them WRITES a
// routine — which is the web's half of the split (gym ARCHITECTURE.md §11: the phone owns the open
// session, the web owns the desk work). A control that opened nothing would be the defect this room
// refuses everywhere else. The two ways a routine is written from a phone both already exist, and
// both are at the moment they make sense: "Keep this as a routine" at the finish, and the change
// offer mid-session.
//
// WHAT THE CHEVRON NOW OPENS is screen 6 with its editing half absent: the routine as it stands, and
// the History section this wave gave it — every proposal an agent has ever made about this day,
// applied, dismissed or superseded, each a dated record rather than a toast that disappeared. It
// reads and it does not write, so the split above is untouched.
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
        Text("Routines", style = WindmillFont.display(32), color = GymSkin.ink)

        // The same sentence Today's empty state makes, because it is the same fact: this lifter
        // already has a program, and the app's job is to CATCH it rather than to make them type it
        // in first.
        if (store.routines.isEmpty()) {
            Text(
                "Nothing written down yet. Log a session and name it at the end — that is how a routine gets made here.",
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
@Composable
private fun EntryRow(entry: RoutineEntry, store: TrainingStore, onOpenMovement: (String) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clickable { onOpenMovement(entry.exerciseId) },
    ) {
        Text(
            Readout.movement(entry.exerciseId, store.catalog),
            style = WindmillFont.body(14),
            color = GymSkin.inkDim,
        )
        Spacer(Modifier.weight(1f))
        Text(
            Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
            style = GymType.numeral(12),
            color = GymSkin.targetInk,
        )
    }
}

// ONE ROUTINE, READ (screen 6 with its editing half absent) — what the day asks for, the proposal
// waiting on it, and the History this wave gave it. Nothing on this screen writes a routine: the
// grab rails, `+ Add exercise` and `Done` are the desk's, for the reason the list above states, and
// a control that opened nothing would be the defect this room refuses everywhere else.
//
// HISTORY IS THE POINT OF THE PAGE. Applied or dismissed, a proposal becomes a dated record here —
// an agent's suggestion is part of the program's history, and a lifter who dismissed one in a hurry
// can still read what it said. A superseded one is here too rather than gone: nothing piles up and
// nothing disappears.
//
// SIGNED OUT THERE IS NOTHING TO DRAW AND NOTHING IS ASKED FOR. Proposals need an account for an
// agent to have been granted anything against, so a signed-out lifter sees the routine and its
// lines and no trace of any of this — not an empty section, not an explanation, and not an offer.
@Composable
fun RoutineScreen(
    routineId: String,
    store: TrainingStore,
    isSignedIn: Boolean,
    backLabel: String,
    onBack: () -> Unit,
    onStart: (String) -> Unit,
    onOpenMovement: (String) -> Unit,
    onReview: (Proposal) -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    val routine = store.routine(routineId)
    var history by remember(routineId) { mutableStateOf<List<Proposal>>(emptyList()) }
    var unread by remember(routineId) { mutableStateOf(false) }

    // Re-read whenever the routine itself moves or its card is settled — an apply bumps the
    // revision, a dismissal empties the slot, and either way the row that just moved belongs in the
    // list below. There is nothing held between visits: a history is short and a stale one would be
    // the screen disagreeing with the diff the lifter just came back from.
    LaunchedEffect(routineId, isSignedIn, routine?.revision, routine?.pendingProposal?.id) {
        if (!isSignedIn) return@LaunchedEffect
        when (val read = store.proposalHistory(routineId)) {
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
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
        ) {
            Text("‹", style = WindmillFont.body(20, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text(backLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.inkDim)
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

        Text(routine.name, style = WindmillFont.display(30), color = GymSkin.ink)
        Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(12), color = GymSkin.inkFaint)

        routine.pendingProposal?.let { waiting ->
            ProposalCard(waiting, routine.name, nowMs, onReview = { onReview(waiting) })
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            routine.entries.sortedBy { it.position }.forEach { entry ->
                EntryRow(entry, store, onOpenMovement)
            }
        }

        History(history.filterNot { it.isPending }, unread, nowMs, onReview)

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
    }
}

// `2 Aug · applied 3 changes from Claude` — one row per decision, newest first, each a door back
// onto the diff it settled. A routine nobody has ever proposed anything about draws NO section at
// all: a head over an empty list is the same defect as a chevron that goes nowhere.
//
// A HISTORY THAT COULD NOT BE READ IS NOT AN EMPTY ONE, and the two never collapse into one silence
// — a routine with four decisions on it would otherwise read as one nobody has ever touched, which
// is exactly the false claim this room refuses to make about a log.
@Composable
private fun History(settled: List<Proposal>, unread: Boolean, nowMs: Long, onReview: (Proposal) -> Unit) {
    if (settled.isEmpty() && !unread) return
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
        settled.forEach { proposal ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.md))
                    .clickable { onReview(proposal) }
                    .padding(horizontal = WindmillSpace.x3),
            ) {
                Text(
                    proposal.historyLine(nowMs),
                    style = GymType.numeral(12).copy(lineHeight = 18.sp),
                    color = GymSkin.inkDim,
                    modifier = Modifier.weight(1f),
                )
                Text("›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
            }
        }
    }
}
