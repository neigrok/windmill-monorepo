package works.windmill.gym.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.DocumentRow
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

// The review, drawn INSIDE a modal bottom sheet over the conversation or the routines home — never a
// push, because a lifter deciding is coming back. Nothing is applied until the tap, Apply is atomic
// against the base the diff was written on, and Apply is unreachable until the diff has been seen to
// its end. Closing the sheet decides nothing; `onDecided` is the server's own reply.
@Composable
fun ReviewSheet(
    proposalId: String,
    routineId: String,
    store: TrainingStore,
    // Null where Coach is not offered. Nothing on the wire says whether a deployment has Coach, so the
    // room learns it from the first bare 404 and takes both doors down for the life of the room.
    onAsk: ((String) -> Unit)?,
    onDecided: (Proposal) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var proposal by remember(proposalId) { mutableStateOf<Proposal?>(null) }
    var failure by remember(proposalId) { mutableStateOf<WriteFailure?>(null) }
    var asked by remember(proposalId) { mutableIntStateOf(0) }
    var deciding by remember(proposalId) { mutableStateOf(false) }
    var said by remember(proposalId) { mutableStateOf<String?>(null) }
    // The latch stops a copy read on the way in from offering a decision the log has refused; only a
    // read that ANSWERED drops it.
    var overtaken by remember(proposalId) { mutableStateOf(false) }
    val scroll = rememberScrollState()
    // Seen to its end, or fits without scrolling — of THIS document: the extent the end was last
    // reached at. A diff arriving after the read, or a run of kept rows expanding, changes the extent,
    // and what grew has not been seen.
    var seenExtent by remember(proposalId) { mutableIntStateOf(-1) }
    val atEnd = !scroll.canScrollForward
    val extent = scroll.maxValue
    // The extent is the key's own value, read in the same snapshot as `atEnd`: by the time the effect
    // runs, a diff that arrived in this composition has already been measured and the live extent
    // would be the one nobody has seen.
    LaunchedEffect(atEnd, extent) { if (atEnd) seenExtent = extent }
    val seen = seenExtent == extent

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

    // A routine that has moved PAST the revision this diff was written against has superseded it, and
    // the log will refuse the tap.
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
                    is ProposalOutcome.Decided -> {
                        proposal = outcome.proposal
                        onDecided(outcome.proposal)
                    }
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

    Column(Modifier.fillMaxWidth()) {
        Head(standing, nowMs)
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .weight(1f, fill = false)
                .fillMaxWidth()
                .verticalScroll(scroll)
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
            standing?.let { proposal ->
                onAsk?.let { ask ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable(role = Role.Button) { ask(proposal.routineName) },
                    ) {
                        Text("Ask Coach about this", style = GymType.numeral(12), color = GymSkin.accent)
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = GymSkin.accent,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
        standing?.let { Foot(it, decidable, deciding, seen, said, onDecide = ::decide) }
    }
}

@Composable
private fun Head(proposal: Proposal?, nowMs: Long) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x2),
    ) {
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
        ProposalState.Dismissed -> "Turned down"
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

// The model's prose sits under its kicker, quoted, apart from the counted rows: two kinds of truth
// never share one block.
@Composable
private fun Body(
    proposal: Proposal,
    catalog: List<Exercise>,
    nowMs: Long,
    superseded: Boolean,
) {
    if (proposal.summary.isNotBlank()) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.md))
                .padding(WindmillSpace.x3),
        ) {
            Text(proposal.kicker, style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.accent)
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
                Box(Modifier.width(2.dp).heightIn(min = 20.dp).background(GymSkin.accent))
                Text(
                    proposal.summary,
                    style = WindmillFont.body(15).copy(lineHeight = 23.sp),
                    color = GymSkin.ink,
                )
            }
        }
    } else {
        Text(
            proposal.summaryLine(proposal.routineName),
            style = WindmillFont.body(15).copy(lineHeight = 23.sp),
            color = GymSkin.ink,
        )
    }
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
    // The rename is a change with no row of its own on the wire and the log counts it, so it is drawn.
    if (proposal.renames) {
        ChangeCard(GymSkin.line) {
            Text("Name", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            MoveLine("routine", proposal.baseName, proposal.name)
        }
    }
    proposal.document.forEach { row ->
        when (row) {
            is DocumentRow.Changed -> ChangeRow(proposal, row.change, catalog)
            is DocumentRow.Unchanged -> KeptRun(row, catalog)
        }
    }
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

// A run of kept rows, collapsed to its count where it stands and expanded in place: the position is
// the document.
@Composable
private fun KeptRun(row: DocumentRow.Unchanged, catalog: List<Exercise>) {
    var open by remember(row) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .semantics { stateDescription = if (open) "expanded" else "collapsed" }
                .clickable(role = Role.Button) { open = !open }
                .padding(horizontal = WindmillSpace.x2),
        ) {
            Text(row.label, style = GymType.numeral(12), color = GymSkin.inkFaint)
            Icon(
                if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = GymSkin.inkFaint,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) {
            row.kept.forEach { change ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x2),
                ) {
                    Text(
                        Readout.movement(change.exerciseId, catalog),
                        style = WindmillFont.body(14),
                        color = GymSkin.inkDim,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        (change.after ?: change.before)?.let { Proposal.asks(it) } ?: Readout.openTarget,
                        style = GymType.numeral(12),
                        color = GymSkin.inkFaint,
                    )
                }
            }
        }
    }
}

@Composable
private fun ChangeRow(proposal: Proposal, change: ProposalChange, catalog: List<Exercise>) {
    val name = Readout.movement(change.exerciseId, catalog)
    when (change.kind) {
        ChangeKind.Added -> ChangeCard(GymSkin.setDone) {
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                Icon(
                    Icons.Filled.Add,
                    contentDescription = null,
                    tint = GymSkin.setDone,
                    modifier = Modifier.size(16.dp),
                )
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
            Text(
                change.removedLine,
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                color = GymSkin.inkDim,
            )
        }
        // A retarget, and everything this build cannot name, read off whichever side arrived.
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

// The band holds one button, Apply, and its height never changes. Turning down is a text row beneath
// it, behind its confirmation — never the left half of a pair, where a hand expects Cancel.
@Composable
private fun Foot(
    proposal: Proposal,
    decidable: Boolean,
    deciding: Boolean,
    seen: Boolean,
    said: String?,
    onDecide: (Boolean) -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x6),
    ) {
        said?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim, maxLines = 2) }
        if (!decidable) return@Column
        var turningDown by remember { mutableStateOf(false) }
        if (turningDown) {
            ConfirmDialog(
                title = Proposal.turnDownAsk,
                body = Proposal.turnDownBody,
                confirm = Proposal.turnDown,
                destructive = true,
                onConfirm = {
                    turningDown = false
                    onDecide(false)
                },
                onKeep = { turningDown = false },
            )
        }
        val ready = seen && !deciding
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .alpha(if (ready) 1f else 0.4f)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable(enabled = ready, role = Role.Button) { onDecide(true) },
        ) {
            Text(
                if (proposal.intent == ProposalIntent.Remove) proposal.applyLabel else Proposal.apply,
                style = WindmillFont.body(17, FontWeight.Bold),
                color = GymSkin.onAccent,
            )
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clickable(enabled = !deciding, role = Role.Button) { turningDown = true },
        ) {
            Text(Proposal.turnDownVerb, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
        Text(
            proposal.atomicLine,
            style = GymType.numeral(12),
            color = GymSkin.inkFaint,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// The card: the summary, the counted changes, and one affordance. Nothing on it decides anything.
@Composable
fun ProposalCard(
    proposal: Proposal,
    routineName: String,
    nowMs: Long,
    stillWaiting: Boolean,
    onReview: () -> Unit,
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
        Text(
            proposal.summaryLine(routineName),
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.ink,
        )
        Text(
            proposal.cardLine(routineName, stillWaiting),
            style = GymType.numeral(12),
            color = GymSkin.inkDim,
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button, onClick = onReview),
        ) {
            Text(proposal.reviewLabel, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.onAccent)
        }
    }
}

@Composable
fun ProposalChip(onReview: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clickable(role = Role.Button, onClick = onReview)
            .padding(horizontal = WindmillSpace.x1),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(GymSkin.accent))
        Text("1 proposal", style = WindmillFont.body(12, FontWeight.SemiBold), color = GymSkin.accent)
    }
}
