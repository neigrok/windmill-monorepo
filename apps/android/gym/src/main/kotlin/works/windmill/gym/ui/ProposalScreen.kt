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

// Nothing is applied until the tap, and Apply is atomic against the base the diff was written on.
@Composable
fun ProposalScreen(
    proposalId: String,
    routineId: String,
    store: TrainingStore,
    backLabel: String,
    onBack: () -> Unit,
    // Null where Ask is not offered. Nothing on the wire says whether a deployment has Ask, so the
    // room learns it from the first bare 404 and takes both doors down for the life of the room.
    onAsk: ((String) -> Unit)? = null,
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
                    is ProposalOutcome.Decided -> proposal = outcome.proposal
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
    proposal.drawn.forEach { change -> ChangeRow(proposal, change, catalog) }
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

// `Later` is not a decision and never sends one; the routine still carries the proposal.
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
