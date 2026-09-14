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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.DocumentRow
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.FieldMove
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
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
    onBusy: (Boolean) -> Unit = {},
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    var proposal by remember(proposalId) { mutableStateOf<Proposal?>(null) }
    var failure by remember(proposalId) { mutableStateOf<WriteFailure?>(null) }
    var gone by remember(proposalId) { mutableStateOf(false) }
    var asked by remember(proposalId) { mutableIntStateOf(0) }
    var deciding by remember(proposalId) { mutableStateOf(false) }
    var said by remember(proposalId) { mutableStateOf<String?>(null) }
    // The latch stops a copy read on the way in from offering a decision the log has refused; only a
    // read that ANSWERED drops it.
    var overtaken by remember(proposalId) { mutableStateOf(false) }
    val scroll = rememberScrollState()
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    val scale = LocalDensity.current.fontScale
    val extent = scroll.maxValue
    val document = listOf(proposal, extent, viewport, scale)
    var seenDocument by remember(proposalId) { mutableStateOf<List<Any?>?>(null) }
    val atEnd = !scroll.canScrollForward
    LaunchedEffect(atEnd, document) {
        if (atEnd && proposal != null && viewport.height > 0 && extent != Int.MAX_VALUE) seenDocument = document
    }
    val seen = seenDocument == document

    LaunchedEffect(proposalId, asked) {
        failure = null
        gone = false
        proposal = null
        when (val read = store.proposal(proposalId)) {
            is ProposalRead.Found -> {
                proposal = read.proposal
                overtaken = false
            }
            ProposalRead.Gone -> gone = true
            is ProposalRead.Failed -> failure = read.why
        }
    }

    // A routine that has moved PAST the revision this diff was written against has superseded it, and
    // the log will refuse the tap. Read off the PROGRAM and never the drawn list: a window taking the
    // row off the routines home would answer `not superseded` for want of a routine to compare, and
    // this sheet would offer an Apply the log is about to refuse.
    val held = store.allRoutines.firstOrNull { it.id == routineId }
    val standing = proposal
    val superseded = standing?.supersededBy(held) == true
    val decidable = standing != null && standing.isPending && !superseded && !overtaken && store.session == null

    fun decide(apply: Boolean) {
        val open = proposal ?: return
        if (deciding || !decidable || (apply && !seen)) return
        deciding = true
        onBusy(true)
        scope.launch {
            try {
                said = null
                val outcome = if (apply) store.applyProposal(open.id) else store.dismissProposal(open.id)
                when (outcome) {
                    is ProposalOutcome.Decided -> {
                        proposal = outcome.proposal
                        deciding = false
                        onBusy(false)
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
                        gone = true
                    }
                    is ProposalOutcome.Failed ->
                        said = outcome.why.line(if (apply) "nothing was applied" else "it is still waiting")
                }
            } finally {
                deciding = false
                onBusy(false)
            }
        }
    }

    Column(Modifier.fillMaxWidth()) {
        Head(standing)
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .weight(1f, fill = false)
                .fillMaxWidth()
                .onSizeChanged { viewport = it }
                .verticalScroll(scroll)
                .padding(horizontal = WindmillSpace.x5)
                .padding(bottom = WindmillSpace.x4),
        ) {
            failure?.let { why ->
                Text(
                    why.line("that proposal could not be read"),
                    style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                    color = skin.inkDim,
                )
            }
            if (failure != null) CoachAction("Try again", { asked++ })
            if (gone) Text(ProposalRead.Gone.line, style = WindmillFont.body(15).copy(lineHeight = 22.sp), color = skin.inkDim)
            if (store.session != null) Text("Finish this session", style = WindmillFont.body(20, FontWeight.Bold), color = skin.ink)
            if (store.session == null) standing?.let { Body(it, store.catalog, superseded) }
            standing?.let { proposal ->
                onAsk?.let { ask ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable(enabled = !deciding, role = Role.Button) { ask(proposal.routineName) },
                    ) {
                        Text("Ask Coach", style = WindmillFont.body(16, FontWeight.Bold), color = skin.accent)
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = skin.accent,
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
private fun Head(proposal: Proposal?) {
    val skin = LocalGymColors.current
    Text(proposal?.let { "Proposal · ${it.routineName}" } ?: "Proposal",
        style = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = skin.ink,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 16.dp))
}

@Composable
private fun Body(
    proposal: Proposal,
    catalog: List<Exercise>,
    superseded: Boolean,
) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (proposal.summary.isNotBlank()) Text(proposal.kicker, style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.inkDim)
        Text(proposal.summaryLine(proposal.routineName), style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.ink)
    }
    if (proposal.intent == ProposalIntent.Remove) {
        ChangeCard() {
            Text("Remove ${proposal.routineName}", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            Text("The whole routine is removed from your program. Every set you logged against it stays in the log.",
                style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
    } else {
        proposal.document.forEach { row ->
            when (row) {
                is DocumentRow.Changed -> ChangeRow(proposal, row.change, catalog)
                is DocumentRow.Unchanged -> KeptRun(row, catalog)
            }
        }
        if (proposal.renames) ChangeCard() {
            Text("Routine name", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            MoveLine("", proposal.baseName, proposal.name)
        }
    }
    val note = if (superseded && proposal.isPending) supersededLine else null
    note?.let {
        Text(
            it,
            style = WindmillFont.body(13).copy(lineHeight = 20.sp),
            color = skin.inkDim,
            modifier = Modifier
                .fillMaxWidth()
                .background(skin.raised, RoundedCornerShape(WindmillRadius.md))
                .padding(GymLayout.cardInset),
        )
    }
}

private const val supersededLine =
    "This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands."

// A run of kept rows, collapsed to its count where it stands and expanded in place: the position is
// the document.
@Composable
private fun KeptRun(row: DocumentRow.Unchanged, catalog: List<Exercise>) {
    val skin = LocalGymColors.current
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
                .padding(horizontal = GymLayout.rowInset),
        ) {
            Text(row.label, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            Icon(
                if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = skin.inkFaint,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) {
            row.kept.forEach { change ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = GymLayout.rowInset),
                ) {
                    Text(
                        Readout.movement(change.exerciseId, catalog),
                        style = WindmillFont.body(16).copy(lineHeight = 22.sp),
                        color = skin.inkDim,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        (change.after ?: change.before)?.let { Readout.targetWithUnit(it.sets) } ?: Readout.openTarget,
                        style = WindmillFont.body(14).copy(lineHeight = 20.sp),
                        color = skin.inkDim,
                    )
                }
            }
        }
    }
}

@Composable
private fun ChangeRow(proposal: Proposal, change: ProposalChange, catalog: List<Exercise>) {
    val skin = LocalGymColors.current
    val name = Readout.movement(change.exerciseId, catalog)
    ChangeCard() {
        val title = when (change.kind) {
            ChangeKind.Added -> "Add $name"
            ChangeKind.Removed -> "Remove $name"
            else -> name
        }
        Text(title, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
        when (change.kind) {
            ChangeKind.Added -> {
                val target = change.after?.let { Readout.targetWithUnit(it.sets) } ?: Readout.openTarget
                val after = proposal.landsAfter(change)?.let { "after ${Readout.movement(it, catalog)}" } ?: "first in the routine"
                Text("$target · $after", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            }
            ChangeKind.Removed -> Text(change.removedLine, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            else -> {
                val before = change.before
                val after = change.after
                val moved = if (before == null || after == null) emptyList() else Proposal.moves(before, after)
                if (moved.isEmpty()) Text((after ?: before)?.let { Readout.targetWithUnit(it.sets) } ?: "No targets",
                    style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                moved.forEach { move ->
                    if (move.label == Proposal.setsLabel && before != null && after != null) {
                        SchemeMove(move.copy(before = Readout.targetWithUnit(before.sets), after = Readout.targetWithUnit(after.sets)), before.sets, after.sets, change)
                    } else MoveLine(move.label, move.before, move.after)
                }
            }
        }
    }
}

// A scheme that changed shape prints both schemes in the readout formula and unfolds on tap to the
// two ladders, set by set in the deviation sheet's own shape — what stands, the arrow, what is
// proposed, `—` on a side that has no such set — because a lifter deciding on a ramp has to see the
// ramp against what it replaces. Folded again per change, where it stands.
@Composable
private fun SchemeMove(move: FieldMove, standing: List<SetTarget>, proposed: List<SetTarget>, change: ProposalChange) {
    var unfolded by remember(change) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        MoveLine(
            move.label, move.before, move.after,
            Modifier
                .fillMaxWidth()
                .semantics { stateDescription = if (unfolded) "expanded" else "collapsed" }
                .clickable(role = Role.Button, onClickLabel = if (unfolded) "hide the sets" else "show the sets") {
                    unfolded = !unfolded
                },
        )
        if (unfolded) {
            repeat(maxOf(standing.size, proposed.size)) { at ->
                MoveLine(
                    label = "set ${at + 1}",
                    before = standing.getOrNull(at)?.let(Readout::setTarget) ?: "—",
                    after = proposed.getOrNull(at)?.let(Readout::setTarget) ?: "—",
                    modifier = Modifier.padding(start = WindmillSpace.x3),
                )
            }
        }
    }
}

// One moved field, in the shape every diff on this surface shares: the label, what stood, the arrow,
// what is proposed. The deviation sheet draws its ladder in the same shape.
@Composable
internal fun MoveLine(label: String, before: String, after: String, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Text((if (label.isBlank() || label == Proposal.setsLabel) "" else "$label · ") + "$before → $after",
        style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim,
        modifier = modifier.semantics(mergeDescendants = true) {})
}

@Composable
private fun ChangeCard(content: @Composable () -> Unit) {
    val skin = LocalGymColors.current
    Column(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().heightIn(min = 70.dp).padding(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        Box(Modifier.fillMaxWidth().heightIn(min = 1.dp).background(skin.line))
    }
}

@Composable
private fun Foot(
    proposal: Proposal,
    decidable: Boolean,
    deciding: Boolean,
    seen: Boolean,
    said: String?,
    onDecide: (Boolean) -> Unit,
) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = WindmillSpace.x5)
            .padding(vertical = 12.dp),
    ) {
        said?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim) }
        if (!decidable) {
            proposal.receipt?.let { Text(it, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.accent) }
            return@Column
        }
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
                .heightIn(min = GymTap.secondary)
                .alpha(if (ready) 1f else 0.4f)
                .background(skin.accent, RoundedCornerShape(WindmillRadius.lg))
                // TalkBack announced `disabled` and nothing else; the reason belongs on the control
                // that is refusing, not only in the row beneath it.
                .semantics { if (!seen) stateDescription = Proposal.applyHint }
                .clickable(enabled = ready, role = Role.Button) { onDecide(true) },
        ) {
            Text(
                proposal.applyLabel,
                style = WindmillFont.body(16, FontWeight.Bold),
                color = skin.onAccent,
            )
        }
        // Laid out in BOTH states so the band's height never changes, and off the SEMANTICS tree in
        // BOTH: the reason Apply is refusing belongs to Apply, which says it above, and a reader
        // walking the shut band would otherwise meet one fact twice in a row. The pixels carry the
        // sighted reader; `ReviewSheetTests` counts the nodes that carry the screen reader.
        Text(
            Proposal.applyHint,
            style = GymType.numeral(12),
            color = skin.inkDim,
            modifier = Modifier
                .fillMaxWidth()
                .alpha(if (seen) 0f else 1f)
                .clearAndSetSemantics { },
        )
        Text(
            proposal.atomicLine,
            style = WindmillFont.body(12).copy(lineHeight = 17.sp),
            color = skin.inkDim,
            modifier = Modifier.fillMaxWidth(),
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .clickable(enabled = !deciding, role = Role.Button) { turningDown = true },
        ) {
            Text(Proposal.turnDownVerb, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
        }
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
    CoachProposalCard(routineName, proposal.summaryLine(routineName),
        proposal.counted + if (stillWaiting && proposal.isPending) " · ${Proposal.stillWaiting}" else "", onReview)
}

@Composable
fun ProposalChip(onReview: () -> Unit) {
    val skin = LocalGymColors.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clickable(role = Role.Button, onClick = onReview)
            .padding(horizontal = WindmillSpace.x1),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(skin.accent))
        Text("1 proposal", style = WindmillFont.body(12, FontWeight.SemiBold), color = skin.accent)
    }
}
