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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// TODAY — the home, and the only surface in gym that ever asks for attention, because this product
// has no notifications. It answers one question: what am I doing right now.
//
// AND IT IS WHERE AN AGENT'S PROPOSAL WAITS. A change to a routine mints a card rather than a
// write, and the card lives here and on the routine it touches until the lifter applies or
// dismisses it — no push, no badge, no unread count and nothing that gets louder. That is the whole
// notification design: the one screen opened before training is the one screen it needs to be on.
//
// No tour, no sample program, no questions about goals or experience. This lifter already has a
// program; the app's job is to CATCH it, not to write it — which is why the empty state's one door
// is an empty session, and the routine is the thing you name on the way out.
//
// Looking BACK is the frame's job now — the log is a tab under every screen (§F, GymRoom) — so what
// is left at the foot of this one is the single door a tab cannot be: the last session, a shortcut
// into the log rather than a second copy of it. It appears only once the log holds a finished
// session, because a door onto an empty screen is the same defect as a chevron that goes nowhere.
// The Statistics door that stood beside it was retired in W1c, the wave its replacement was built:
// a movement's record, reached by tapping a movement's NAME — which is why every name in the
// routine card below is a door of its own.
//
// SIGNED OUT, TODAY IS THE SAME SCREEN. The room works before there is an account — a session
// starts from a local routine or empty, and the log it writes is saved on this device — so every
// Start stands whoever is standing here. The only signed-out difference is one quiet card under
// the starts: the claim offer, which says what signing in ADDS and gates nothing.
@Composable
fun TodayScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    putOff: String?,
    onStart: (String?) -> Unit,
    onOpenSession: (SessionSummary) -> Unit,
    onOpenMovement: (String) -> Unit,
    onOpenSettings: () -> Unit,
    // NULL IS THE DOOR NOT BEING THERE, and it is two facts with one drawing: nobody is signed in,
    // so there is no log for Ask to read; or this deployment has already answered a question with
    // the bare 404 that means it has no Ask at all. Neither is worth a sentence on Today — an offer
    // that cannot be taken is not made — so the row is simply absent. The second fact is LEARNED
    // rather than advertised: nothing on the wire carries it, so on a server with no vendor key the
    // first question is what finds out, and the door goes down behind it.
    onOpenAsk: (() -> Unit)?,
    onReview: (Proposal) -> Unit,
    onLater: (Proposal) -> Unit,
    onSignIn: () -> Unit,
) {
    val nowMs = System.currentTimeMillis()
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x8),
    ) {
        TodayHead(nothingLogged = store.recent.isEmpty(), nowMs = nowMs)
        // A loss said during a boot claim has no logger standing to show it, so the banner stands
        // here instead — the logger's own component, the logger's own words — until dismissed.
        Refusals(store.refusals, store.catalog, onDismiss = { store.clearRefusals() })
        // THE CARD IS THE NOTIFICATION, and Today is where it waits: this product sends no push,
        // draws no badge and counts nothing unread, because the one screen a lifter opens before
        // training is the one screen a proposal needs to be on. The newest waiting one, and one at
        // a time — a stack of cards over the routine somebody came here to start would be a room
        // asking for attention rather than answering a question. The others keep their dot in the
        // routines list until this one is decided.
        //
        // Signed out this is empty by construction: no account, no agent, no proposal, and nothing
        // said about any of it.
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
        when {
            store.routines.isEmpty() -> EmptyStart(onStart)
            else -> {
                store.routines.forEachIndexed { index, routine ->
                    if (index == 0) {
                        RoutineCard(routine, store, nowMs, onStart, onOpenMovement)
                    } else {
                        RoutineRow(routine, nowMs, onStart)
                    }
                }
                LogWithoutARoutine(onStart)
            }
        }
        if (!isSignedIn) ClaimCard(onSignIn)
        LastSession(store.recent, onOpenSession)
        onOpenAsk?.let { AskDoor(it) }
        SettingsDoor(onOpenSettings)
    }
}

// ASK'S ONE DOOR (§L) — in Today's bottom band, under the workout a lifter came here to start and
// over the settings row. It is not a tab and it is not a button: the bar belongs to the three tabs,
// and a chat is not a place anybody lives.
//
// IT IS NOT DRAWN MID-SESSION, and that costs no check here: a live session takes the whole screen,
// so this one is not on it. It is the same rule the server enforces from the other side — a lifter
// between sets is training, and the log is the thing in front of them.
//
// The line under it is what Ask is rather than a pitch for it, and there is nothing to buy: no
// price, no lock, no upgrade, and no count of how many times it was walked past.
@Composable
private fun AskDoor(onOpenAsk: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 8.dp)
            .clickable(onClick = onOpenAsk),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Ask", style = WindmillFont.body(17), color = GymSkin.ink)
            Text(Ask.subtitle, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        Spacer(Modifier.weight(1f))
        Text("›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
    }
}

// THE DOOR §I DOES NOT DRAW, and it is here on loan. Gym's settings are a SECTION the shell's You
// sheet is meant to list and walk you into; this surface's product seam hands the shell a room and
// nothing else, and You is the platform's file. Rather than reach into the shell or leave four
// working rows unreachable, the section keeps a door of its own at the foot of the one home — the
// quietest row on the quietest screen, below everything a lifter came here to do. It goes the day
// the seam grows a settings slot.
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

@Composable
private fun TodayHead(nothingLogged: Boolean, nowMs: Long) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text("Today", style = WindmillFont.display(32), color = GymSkin.ink)
        Text(
            if (nothingLogged) "nothing logged yet" else "${Readout.day(nowMs)} · nothing running",
            style = GymType.numeral(13),
            color = GymSkin.inkFaint,
        )
    }
}

// Screen 1. One way in, and the sentence that says what the empty session is FOR — a lifter who is
// told a routine gets written at the end does not go looking for an editor first.
//
// THE DESIGN'S SECOND BUTTON, `Type out a routine first`, IS DELIBERATELY NOT DRAWN. It lands in a
// routine editor, and this surface has none — RoutinesScreen states why: every door that WRITES a
// routine belongs to the desk (gym ARCHITECTURE.md §11), and the two a phone owns already exist at
// the moments they make sense, at the finish and mid-session. A button onto a screen that does not
// exist is the one defect this room refuses everywhere else, and the empty state is not the place
// to make an exception for it.
@Composable
private fun EmptyStart(onStart: (String?) -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text(
            "Start empty and pick movements as you go. What you do today becomes your routine — you name it at the end.",
            style = WindmillFont.body(16).copy(lineHeight = 24.sp),
            color = GymSkin.inkDim,
        )
        StartButton("Start a session") { onStart(null) }
    }
}

// The routine trained most recently, opened out: what it holds, and one button that starts it. The
// plan snapshot is frozen off this routine's own row at start — by the server signed in, off the
// device's shelf signed out — so what is drawn here is a preview of the workout and never the
// thing the session is planned from.
@Composable
private fun RoutineCard(
    routine: Routine,
    store: TrainingStore,
    nowMs: Long,
    onStart: (String?) -> Unit,
    onOpenMovement: (String) -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(routine.name, style = WindmillFont.display(22), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Text(
                routine.lastTrainedAtMs?.let { Readout.ago(it, nowMs) } ?: "never trained",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }

        // AN EXERCISE NAME IS A DOOR, here and everywhere else this room is at rest (§H): it lands
        // on that movement's record. The row is the target rather than the glyphs alone, so a
        // thumb has the whole line to find — and the card itself is not clickable, so nothing here
        // is competing for the tap.
        routine.entries.sortedBy { it.position }.take(3).forEach { entry ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .clickable { onOpenMovement(entry.exerciseId) },
            ) {
                Text(
                    Readout.movement(entry.exerciseId, store.catalog),
                    style = WindmillFont.body(15),
                    color = GymSkin.inkDim,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
                    style = GymType.numeral(13),
                    color = GymSkin.targetInk,
                )
            }
        }
        if (routine.entries.size > 3) {
            Text(
                "+ ${routine.entries.size - 3} more",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }

        StartButton("Start ${routine.name}") { onStart(routine.id) }
    }
}

// Sorted by last trained and never by when they were made, because that is how a lifter picks one —
// and it is the same fact the row prints, so the list never has to explain its own order.
@Composable
private fun RoutineRow(routine: Routine, nowMs: Long, onStart: (String?) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 8.dp)
            .clickable { onStart(routine.id) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(routine.name, style = WindmillFont.body(17), color = GymSkin.ink)
            Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        Spacer(Modifier.weight(1f))
        Text("›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
    }
}

@Composable
private fun LogWithoutARoutine(onStart: (String?) -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.primary - 8.dp)
            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
            .clickable { onStart(null) },
    ) {
        Text(
            "Log without a routine",
            style = WindmillFont.body(16, FontWeight.SemiBold),
            color = GymSkin.accent,
        )
    }
}

// The claim offer, and never a wall: the room already works, so this card only names what signing
// in adds — the account, and the web mirror. It gates nothing and apologises for nothing.
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

// THE ONE RETROSPECTIVE DOOR, and it exists exactly when there is something behind it: a log with
// no finished session has no last session to open, and a door onto an empty screen is the same
// defect as a chevron that goes nowhere. What is on the other side of it can now change the log —
// §G18 fixes a set from there — but nothing on THIS card can, and the row it draws follows whatever
// the log says about that session afterwards.
@Composable
private fun LastSession(recent: List<SessionSummary>, onOpenSession: (SessionSummary) -> Unit) {
    val last = recent.firstOrNull { !it.session.isOpen } ?: return
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x2)
            .heightIn(min = GymTap.minimum)
            .clickable { onOpenSession(last) },
    ) {
        Text("Last session", style = GymType.numeral(11), color = GymSkin.inkFaint)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(
                last.plan?.routine ?: Readout.noRoutine,
                style = WindmillFont.body(16),
                color = GymSkin.ink,
            )
            Spacer(Modifier.weight(1f))
            Text(lastMeta(last), style = GymType.numeral(12), color = GymSkin.inkFaint)
            Text(
                " ›",
                style = WindmillFont.body(15, FontWeight.SemiBold),
                color = GymSkin.inkFaint,
            )
        }
    }
}

@Composable
private fun StartButton(label: String, onStart: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.primary)
            .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
            .clickable(onClick = onStart),
    ) {
        Text(label, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
    }
}

private fun lastMeta(summary: SessionSummary): String {
    val day = Readout.day(summary.startedAtMs)
    val finished = summary.finishedAtMs
        ?: return "$day · ${Readout.setCount(summary.setCount)}"
    return "$day · ${Readout.setCount(summary.setCount)} · ${Readout.duration(finished - summary.startedAtMs)}"
}
