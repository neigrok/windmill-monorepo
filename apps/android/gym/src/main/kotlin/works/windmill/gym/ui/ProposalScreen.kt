package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.Readout
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THE PROPOSAL (§D screen 14) — a typed, field-level diff, and two buttons. It is the only screen
// in this product where an agent's work reaches a lifter's program, and the whole of what it does
// is show what would change and wait.
//
// NOTHING HERE IS APPLIED UNTIL THE TAP, and the screen says so under the button rather than
// leaving the word "all" to imply it. Apply is atomic against the base the diff was written on: the
// routine ends up as every row describes it or exactly as it stands, and there is no half, no merge
// and no per-row checkbox. A routine that MOVED first — the lifter's own mid-session save, a PUT
// from the web, another proposal applied — supersedes this one, and the screen says that instead of
// writing next week from a routine that no longer stands.
//
// A SETTLED PROPOSAL STAYS AND SAYS SO, with the instant the decision was taken. Applied or
// dismissed, it is a dated record on the routine — the program's history, not a toast that
// disappears — and this screen is where that record is read.
//
// THE CARD BELOW IS THE SAME OBJECT ONE SIZE SMALLER, and it lives here beside the diff because
// they are one feature: home draws it, the routine rows draw its chip, and all three read the
// head the routine already carries. There is no push, no badge and no unread count anywhere in
// this product — the card waits where the lifter will see it, which is why it does not need one.
@Composable
fun ProposalScreen(
    proposalId: String,
    routineId: String,
    store: TrainingStore,
    backLabel: String,
    onBack: () -> Unit,
    // §L'S SECOND DOOR ONTO ASK, and it carries the subject with it: the diff is on screen, so the
    // question is about this diff. Null where Ask is not offered — nobody signed in, or a
    // deployment already known to have no model — because a door onto a 404 is worse than no door.
    //
    // KNOWN IS THE HONEST WORD AND NOT ADVERTISED: nothing on the wire says whether this deployment
    // has Ask. The route simply is not mounted without a vendor key, so the room learns it from the
    // first bare 404 and takes both doors down for the life of the room — which means the first
    // question asked against a keyless server is answered by "Ask isn't part of this Windmill"
    // rather than by a door that was never there. A signal on the wire would close that one gap and
    // it is the server's to send.
    onAsk: ((String) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var proposal by remember(proposalId) { mutableStateOf<Proposal?>(null) }
    var failure by remember(proposalId) { mutableStateOf<WriteFailure?>(null) }
    var asked by remember(proposalId) { mutableIntStateOf(0) }
    var deciding by remember(proposalId) { mutableStateOf(false) }
    // What the log said about a decision that did not happen, or happened somewhere else. It sits
    // on this screen rather than in the room's note because the sentence is about the object the
    // lifter is looking at — and it is cleared by every re-read, so a stale refusal never stands
    // beside a fresh answer.
    var said by remember(proposalId) { mutableStateOf<String?>(null) }
    // THE LOG HAVING ALREADY REFUSED THE TAP, FOR GOOD. A decision taken elsewhere and a routine
    // that moved first are both terminal, and both are read again — but a re-read that cannot reach
    // the log leaves this screen holding the copy it read on the way in, which still says pending.
    // The latch is what stops that copy from offering a decision the log has refused: an offline
    // phone can say what happened, and must not also draw an Apply under it. Only a read that
    // ANSWERED drops it, because only the log can say the object is open again.
    var overtaken by remember(proposalId) { mutableStateOf(false) }

    // Read on the way in, and again after a decision that told us the log had moved. There is no
    // cache to go stale: a proposal changes state the moment anybody decides anything about it, and
    // a second visit is worth a second read.
    LaunchedEffect(proposalId, asked) {
        failure = null
        when (val read = store.proposal(proposalId)) {
            is GymResult.Ok -> {
                proposal = read.value
                overtaken = false
            }
            is GymResult.Failed -> failure = read.why
        }
    }

    // THE BASE, AS THIS ROOM HOLDS IT. A routine that has moved past the revision this diff was
    // written against has already superseded it, and the log will refuse the tap — so the screen
    // does not offer one it knows would be refused. Behind the base is NOT the same fact and is not
    // acted on: this phone is merely one read stale, and the log is what decides.
    val held = store.routine(routineId)
    val standing = proposal
    val superseded = standing?.supersededBy(held) == true
    val decidable = standing != null && standing.isPending && !superseded && !overtaken

    fun decide(apply: Boolean) {
        val open = proposal ?: return
        scope.launch {
            if (deciding) return@launch
            deciding = true
            try {
                said = null
                val outcome = if (apply) store.applyProposal(open.id) else store.dismissProposal(open.id)
                when (outcome) {
                    // The log's own settled copy, drawn straight back: the state chip, the dated
                    // note and the disappearance of the buttons are all one answer arriving.
                    is ProposalOutcome.Decided -> proposal = outcome.proposal
                    // Terminal, both of them — and both mean this room is holding a stale object,
                    // so it is latched shut and re-read rather than argued with. The store has
                    // already redrawn the program either way: a supersede moved it, and a decision
                    // taken on another surface may have applied it.
                    is ProposalOutcome.Moved -> {
                        said = outcome.said
                        overtaken = true
                        asked += 1
                    }
                    is ProposalOutcome.Settled -> {
                        said = outcome.said
                        overtaken = true
                        asked += 1
                    }
                    // NOTHING LEFT TO DRAW, so nothing is drawn: the diff goes and the sentence
                    // stands in its place. This is also what a REMOVAL that already landed looks
                    // like on a second tap — the proposal cascaded away with the routine it removed
                    // — and the room has re-read the program either way, so the screen underneath
                    // is already telling the truth about it.
                    is ProposalOutcome.Gone -> {
                        proposal = null
                        failure = WriteFailure.Refused(outcome.said)
                    }
                    is ProposalOutcome.Failed ->
                        said = outcome.why.line(if (apply) "nothing was applied" else "it is still waiting")
                }
            } finally {
                deciding = false
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Head(standing, backLabel, nowMs, onBack)
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WindmillSpace.x5)
                .padding(bottom = WindmillSpace.x4),
        ) {
            failure?.let { why ->
                Text(
                    why.line("that proposal could not be read"),
                    style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                    color = GymSkin.inkDim,
                )
            }
            standing?.let { Body(it, store.catalog, nowMs, superseded) }
            // Under the diff and never beside the two taps: this is a question about a decision,
            // and it may not be mistaken for one. It reads the routine's name off the proposal
            // itself, so what Ask is asked about is the routine this diff was written against.
            standing?.let { proposal ->
                onAsk?.let { ask ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable { ask(proposal.routineName) },
                    ) {
                        Text("Ask about this", style = GymType.numeral(12), color = GymSkin.accent)
                        Text("›", style = WindmillFont.body(13, FontWeight.SemiBold), color = GymSkin.accent)
                    }
                }
            }
        }
        standing?.let { Foot(it, decidable, deciding, said, onDecide = ::decide) }
    }
}

// The way back, what this is about, and the state — one row, exactly as the record page's is, and
// the reason this screen draws its own head: a screen that owns something in the back row owns the
// row. The byline is the whole point of the chip beside it — which agent, through which door, at
// what time — because "a change appeared in my Tuesday and I cannot tell where it came from" is the
// failure this object exists to prevent.
@Composable
private fun Head(proposal: Proposal?, backLabel: String, nowMs: Long, onBack: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .padding(horizontal = WindmillSpace.x5),
    ) {
        Text(
            "‹",
            style = WindmillFont.body(20, FontWeight.SemiBold),
            color = GymSkin.inkDim,
            modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                proposal?.let { "Proposal · ${it.routineName}" } ?: "Proposal",
                style = WindmillFont.display(19),
                color = GymSkin.ink,
                maxLines = 1,
            )
            proposal?.let {
                Text(it.byline(nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint, maxLines = 1)
            }
        }
        proposal?.let { StateChip(it.state) }
    }
}

@Composable
private fun StateChip(state: ProposalState) {
    val ink = when (state) {
        ProposalState.Pending -> GymSkin.accent
        ProposalState.Applied -> GymSkin.setDone
        ProposalState.Dismissed, ProposalState.Superseded -> GymSkin.inkFaint
    }
    val label = when (state) {
        ProposalState.Pending -> "Pending"
        ProposalState.Applied -> "Applied"
        ProposalState.Dismissed -> "Dismissed"
        // "Set aside" rather than the wire's own word: it is the only outcome on this screen the
        // lifter did not choose, and `superseded` is a thing that happened to a row in a table.
        ProposalState.Superseded -> "Set aside"
    }
    Text(
        label,
        style = GymType.numeral(10, FontWeight.Bold),
        color = ink,
        modifier = Modifier
            .background(
                if (state == ProposalState.Pending) GymSkin.accentSoft else GymSkin.raised,
                RoundedCornerShape(WindmillRadius.full),
            )
            .padding(horizontal = 9.dp, vertical = 4.dp),
    )
}

@Composable
private fun Body(proposal: Proposal, catalog: List<Exercise>, nowMs: Long, superseded: Boolean) {
    Text(
        proposal.summaryLine(proposal.routineName),
        style = WindmillFont.body(15).copy(lineHeight = 23.sp),
        color = GymSkin.ink,
    )
    // A REMOVAL IS ITS OWN SENTENCE and never a list of rows a lifter has to add up: the whole
    // routine goes, and what it takes with it — and what it does not — is said in one line, because
    // "removed" reads as "deleted" to anybody who has ever lost a log.
    if (proposal.intent == ProposalIntent.Remove) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.md))
                .border(1.dp, GymSkin.alarmInk, RoundedCornerShape(WindmillRadius.md))
                .padding(WindmillSpace.x4),
        ) {
            Text(
                "− ${proposal.routineName}",
                style = WindmillFont.body(15, FontWeight.Bold),
                color = GymSkin.ink,
            )
            Text(
                "the whole routine is removed from your program · every set you logged against it stays in the log",
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                color = GymSkin.inkDim,
            )
        }
    }
    // The rename is a change with no row of its own on the wire, and the log counts it — so it is
    // drawn, or the button would promise one more change than the screen shows.
    if (proposal.renames) {
        ChangeCard(GymSkin.line) {
            Text("Name", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            MoveLine("routine", proposal.baseName, proposal.name)
        }
    }
    proposal.drawn.forEach { change -> ChangeRow(proposal, change, catalog) }
    // WHAT WAS DECIDED, AND WHEN — kept on the routine as a dated record rather than announced and
    // then lost. A supersede this room worked out for itself says the same thing in the same place:
    // the log has already settled it, and this phone is looking at a diff whose base is gone.
    val note = proposal.settledNote(nowMs)
        ?: if (superseded && proposal.isPending) supersededLine else null
    note?.let {
        Text(
            it,
            style = WindmillFont.body(13).copy(lineHeight = 20.sp),
            color = GymSkin.inkDim,
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.md))
                .padding(WindmillSpace.x4),
        )
    }
}

private const val supersededLine =
    "This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands."

// ONE LINE OF THE DIFF, drawn by what it does to the program: a retarget shows its fields before
// and after, an addition shows what it asks for and where it lands, a removal names how many logged
// sets it keeps. Nothing here is a grade — no green, no red — and the two tinted cards are the two
// facts that are not simply numbers moving.
@Composable
private fun ChangeRow(proposal: Proposal, change: ProposalChange, catalog: List<Exercise>) {
    val name = Readout.movement(change.exerciseId, catalog)
    when (change.kind) {
        ChangeKind.Added -> ChangeCard(GymSkin.setDone) {
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                Text("+", style = GymType.numeral(14, FontWeight.Bold), color = GymSkin.setDone)
                Text(name, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            }
            Text(
                change.addedLine(follows = proposal.landsAfter(change)?.let { Readout.movement(it, catalog) }),
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                color = GymSkin.inkDim,
            )
        }
        ChangeKind.Removed -> ChangeCard(GymSkin.alarmInk) {
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                Text("−", style = GymType.numeral(14, FontWeight.Bold), color = GymSkin.alarmInk)
                Text(name, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            }
            // The logged sets are the promise this line has to make out loud — a proposal never
            // touches one — and the domain spells it, because the same sentence is drawn on three
            // surfaces of one product.
            Text(
                change.removedLine,
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                color = GymSkin.inkDim,
            )
        }
        // A RETARGET, and everything this build cannot name: both read the same way, off which of
        // the two sides actually arrived. A row the log counted as a change with no field this
        // build can tell apart is still a row the lifter is about to apply, so it prints what the
        // line would end up asking for rather than drawing an empty card over it.
        else -> ChangeCard(GymSkin.line) {
            Text(name, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            val moved = change.before?.let { before ->
                change.after?.let { after -> Proposal.moves(before, after) }
            }.orEmpty()
            if (moved.isEmpty()) {
                Text(
                    (change.after ?: change.before)?.let { Proposal.asks(it) } ?: "no targets",
                    style = GymType.numeral(12),
                    color = GymSkin.targetInk,
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x4)) {
                moved.forEach { MoveLine(it.label, it.before, it.after) }
            }
        }
    }
}

// `sets 5 × 5 → 5 × 3` — the old value struck through, the arrow, the new one in the accent the
// whole product spells a TARGET in. One field per line-item, because a card that merged them into
// a sentence would be a paragraph a lifter has to diff by eye.
@Composable
private fun MoveLine(label: String, before: String, after: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = GymType.numeral(12), color = GymSkin.inkFaint)
        Text(
            before,
            style = GymType.numeral(12).copy(textDecoration = TextDecoration.LineThrough),
            color = GymSkin.inkDim,
        )
        Text("→", style = GymType.numeral(12), color = GymSkin.inkFaint)
        Text(after, style = GymType.numeral(12, FontWeight.Bold), color = GymSkin.targetInk)
    }
}

@Composable
private fun ChangeCard(edge: Color, content: @Composable () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.md))
            .border(1.dp, edge, RoundedCornerShape(WindmillRadius.md))
            .padding(WindmillSpace.x4),
    ) {
        content()
    }
}

// THE TWO TAPS, and the sentence under them. Dismiss is as reachable as Apply and asks for no
// reason; Apply is the wide one because it is the thing a lifter came here to decide. A settled
// proposal draws neither — there is nothing left to decide and a disabled button would be an offer
// that is not one.
@Composable
private fun Foot(
    proposal: Proposal,
    decidable: Boolean,
    deciding: Boolean,
    said: String?,
    onDecide: (Boolean) -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x4),
    ) {
        said?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim, maxLines = 2) }
        // A proposal this room can no longer act on draws no buttons at all. What happened to it is
        // already said in the body — the dated note on a settled one, the superseded line on a diff
        // whose base has moved — and a disabled button under either would be an offer that is not
        // one.
        if (!decidable) return@Column
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2), modifier = Modifier.fillMaxWidth()) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .heightIn(min = GymTap.primary - 8.dp)
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(enabled = !deciding) { onDecide(false) }
                    .padding(horizontal = WindmillSpace.x5),
            ) {
                Text("Dismiss", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
            }
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.primary - 8.dp)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(enabled = !deciding) { onDecide(true) },
            ) {
                Text(proposal.applyLabel, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
            }
        }
        Text(
            proposal.atomicLine,
            style = GymType.numeral(12),
            color = GymSkin.inkFaint,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// THE CARD — the same object one size smaller, and the reason this product has no notifications:
// it waits on the Routines home and on the routine it touches until the lifter applies or
// dismisses it. Nothing counts how long it waits and nothing gets louder.
//
// `Later` is not a decision and never sends one: it puts the card away on home for now, and the
// routine it belongs to still carries it — so a proposal cannot be lost by a thumb reaching for the
// quiet button.
@Composable
fun ProposalCard(
    proposal: Proposal,
    routineName: String,
    nowMs: Long,
    onReview: () -> Unit,
    onLater: (() -> Unit)? = null,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.accentSoft, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(GymSkin.accent))
            Spacer(Modifier.size(WindmillSpace.x2))
            Text(
                "Proposal · ${proposal.source.name}",
                style = GymType.numeral(11, FontWeight.Bold),
                color = GymSkin.accent,
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            Text(
                Readout.whenLogged(proposal.createdAtMs, nowMs),
                style = GymType.numeral(11),
                color = GymSkin.inkFaint,
                maxLines = 1,
            )
        }
        // The agent's own sentence, or — when it wrote none — a count and the routine's name rather
        // than a sentence this room invented for it. The mono line under a summary names the routine
        // and the count itself: home holds several routines, and an agent's prose is under no
        // obligation to say which one it is about.
        Text(
            proposal.summaryLine(routineName),
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.ink,
        )
        if (proposal.summary.isNotBlank()) {
            Text(
                "$routineName · ${proposal.counted}",
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2), modifier = Modifier.fillMaxWidth()) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum)
                    .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.md))
                    .clickable(onClick = onReview),
            ) {
                Text(proposal.reviewLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.onAccent)
            }
            onLater?.let { later ->
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .heightIn(min = GymTap.minimum)
                        .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                        .clickable(onClick = later)
                        .padding(horizontal = WindmillSpace.x4),
                ) {
                    Text("Later", style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.inkDim)
                }
            }
        }
    }
}

// The chip on a routine that has one (§B screen 5): a dot, a count, and a tap onto the diff. It is
// its own target inside a tile whose tap starts a session — the inner one wins where it is drawn,
// which is the rule every movement name in this room already follows.
@Composable
fun ProposalChip(onReview: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clickable(onClick = onReview)
            .padding(horizontal = WindmillSpace.x1),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(GymSkin.accent))
        Text("1 proposal", style = WindmillFont.body(12, FontWeight.SemiBold), color = GymSkin.accent)
    }
}
