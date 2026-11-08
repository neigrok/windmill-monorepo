package works.windmill.gym.ui

import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import works.windmill.gym.coach.CoachProposalCard
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.ChangeKind
import works.windmill.gym.presentation.DocumentRow
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.FieldMove
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.ProposalChange
import works.windmill.gym.presentation.ProposalIntent
import works.windmill.gym.presentation.ProposalSource
import works.windmill.gym.presentation.ProposalTarget
import works.windmill.gym.presentation.ProposalTargets
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TheSix
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.Seat
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WorkoutProposalsStore
import works.windmill.platform.design.WindmillSpace

// What the review draws.
@Stable
interface ReviewState {
    val catalog: List<Exercise>
    val settledProposals: Map<String, Proposal>
    // Why this proposal can no longer be applied, said on the sheet; absent while it can.
    fun outOfDateLine(id: String): String?
    val accountKey: String
    // Signed out a proposal can be read, and deciding it asks an account.
    val signedOut: Boolean get() = accountKey == Seat.anonymous
}

// What the review asks of the stores.
interface ReviewEvents {
    suspend fun proposal(id: String): ProposalRead
    suspend fun applyProposal(id: String): ProposalOutcome
    suspend fun dismissProposal(id: String): ProposalOutcome
    fun removalPending(id: String): Boolean
    fun proposalReceiptShown(proposal: Proposal, seatKey: String)
}

// One proposal's review over the room's stores.
interface ProposalReview : ReviewState, ReviewEvents

// A routine's proposal, over the routines' store.
class ReviewBinding(
    private val seat: TrainingSeat,
    private val routines: RoutinesStore,
) : ProposalReview {
    constructor(store: TrainingStore) : this(store.seat, store.routines)

    override val catalog: List<Exercise> get() = routines.catalog
    override val settledProposals: Map<String, Proposal> get() = routines.settledProposals
    override fun outOfDateLine(id: String): String? = supersededLine.takeIf { id in routines.outOfDateProposals }
    override val accountKey: String get() = seat.accountKey
    override suspend fun proposal(id: String): ProposalRead = routines.proposal(id)
    override suspend fun applyProposal(id: String): ProposalOutcome = routines.applyProposal(id)
    override suspend fun dismissProposal(id: String): ProposalOutcome = routines.dismissProposal(id)
    override fun removalPending(id: String): Boolean = routines.removalPending(id)
    override fun proposalReceiptShown(proposal: Proposal, seatKey: String) = routines.proposalReceiptShown(proposal, seatKey)
}

// A change to the open workout, over its own store.
class WorkoutReviewBinding(
    private val seat: TrainingSeat,
    private val routines: RoutinesStore,
    private val proposals: WorkoutProposalsStore,
) : ProposalReview {
    constructor(store: TrainingStore) : this(store.seat, store.routines, store.workoutProposals)

    override val catalog: List<Exercise> get() = routines.catalog
    override val settledProposals: Map<String, Proposal> get() = proposals.held
    override fun outOfDateLine(id: String): String? = proposals.held[id]?.outOfDate
    override val accountKey: String get() = seat.accountKey
    override suspend fun proposal(id: String): ProposalRead = proposals.proposal(id)
    override suspend fun applyProposal(id: String): ProposalOutcome = proposals.apply(id)
    override suspend fun dismissProposal(id: String): ProposalOutcome = proposals.dismiss(id)
    override fun removalPending(id: String): Boolean = false
    override fun proposalReceiptShown(proposal: Proposal, seatKey: String) = Unit
}

// The review, drawn INSIDE a modal bottom sheet over the conversation or the routines home — never a
// push, because a lifter deciding is coming back. Nothing is applied until the tap, Apply is atomic
// against the base the diff was written on, and Apply is unreachable until the diff has been seen to
// its end. Closing the sheet decides nothing; `onDecided` is the server's own reply.
@Composable
fun ReviewSheet(
    proposalId: String,
    state: ReviewState,
    events: ReviewEvents,
    // Null where Coach is not offered. Nothing on the wire says whether a deployment has Coach, so the
    // room learns it from the first bare 404 and takes both doors down for the life of the room.
    onAsk: ((String) -> Unit)?,
    onDecided: (Proposal) -> Unit,
    // A signed-out sheet's one door; the room closes the sheet first.
    onSignIn: () -> Unit,
    onBusy: (Boolean) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val removalStillWaiting = stringResource(R.string.gym_review_removal_still_waiting)
    var proposal by remember(proposalId) { mutableStateOf<Proposal?>(null) }
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

    LaunchedEffect(proposalId, asked, state.settledProposals[proposalId]) {
        gone = false
        proposal = null
        when (val read = events.proposal(proposalId)) {
            is ProposalRead.Found -> {
                proposal = read.proposal
                if (read.proposal.receipt != null) said = null
                overtaken = false
            }
            ProposalRead.Gone -> gone = true
        }
    }

    // Out of date is the domain's Apply rule, read off the engine and never this room's lists: the
    // routine moved on the log, was edited here and not yet confirmed, or left sight, and the log
    // will refuse the tap. A window taking the row off the routines home changes none of it.
    val standing = proposal
    val outOfDate = state.outOfDateLine(proposalId)
    val decidable = standing != null && standing.isPending && outOfDate == null && !overtaken

    fun decide(apply: Boolean) {
        val open = proposal ?: return
        if (deciding || !decidable || (apply && !seen)) return
        deciding = true
        onBusy(true)
        scope.launch {
            try {
                said = null
                val outcome = if (apply) events.applyProposal(open.id) else events.dismissProposal(open.id)
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
                    is ProposalOutcome.Refused -> {
                        said = outcome.said
                        overtaken = true
                        asked += 1
                    }
                    is ProposalOutcome.Gone -> {
                        proposal = null
                        gone = true
                    }
                    is ProposalOutcome.Failed -> said = if (apply && events.removalPending(open.id))
                        removalStillWaiting
                        else outcome.why.line(if (apply) "nothing was applied" else "it is still waiting")
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
            if (gone) Text(ProposalRead.Gone.line, style = WindmillType.paragraphSmall, color = colors.onSurfaceVariant)
            standing?.let { Body(it, state.catalog, outOfDate) }
            standing?.let { proposal ->
                onAsk?.let { ask ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                        modifier = Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable(enabled = !deciding, role = Role.Button) { ask(proposal.routineName) },
                    ) {
                        Text(stringResource(R.string.gym_review_ask_coach), style = WindmillType.label, color = colors.primary)
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = colors.primary,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
        standing?.let { proposal ->
            var receiptVisible by remember(proposal.id) { mutableStateOf(false) }
            val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
            val seat = state.accountKey
            LaunchedEffect(proposal, receiptVisible, lifecycle, seat) {
                if (receiptVisible && lifecycle == Lifecycle.State.RESUMED) events.proposalReceiptShown(proposal, seat)
            }
            Foot(proposal, decidable, state.signedOut, deciding, seen, said.takeUnless { it == outOfDate }, onDecide = ::decide, onSignIn = onSignIn,
                receiptModifier = Modifier.onGloballyPositioned { receiptVisible = !it.boundsInWindow().isEmpty })
        }
    }
}

// A change to this workout is reviewed in Coach's Nunito, as it was asked (08.55b); a routine's review keeps the reading sans it stands in.
private class ReviewType(val summary: TextStyle, val row: TextStyle, val rowLine: TextStyle, val kept: TextStyle, val action: TextStyle, val atomic: TextStyle) {
    companion object {
        val routine = ReviewType(WindmillType.paragraph, WindmillType.labelParagraph, WindmillType.supportingParagraph, WindmillType.paragraph, WindmillType.label, GymType.captionLoose)
        val workout = ReviewType(GymType.coachParagraph, GymType.button, GymType.coachSupporting, GymType.coachParagraph, GymType.button, GymType.coachCaption)
        fun of(proposal: Proposal) = if (proposal.target == ProposalTarget.Workout) workout else routine
    }
}

@Composable
private fun Head(proposal: Proposal?) {
    val colors = MaterialTheme.colorScheme
    val workout = proposal?.target == ProposalTarget.Workout
    Text(proposal?.let { "Proposal · ${it.subject}" } ?: "Proposal",
        style = if (workout) GymType.coachSourcesTitle else GymType.proposalTitle, color = colors.onSurface,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 12.dp, bottom = if (workout) 12.dp else 16.dp))
}

@Composable
private fun Body(
    proposal: Proposal,
    catalog: List<Exercise>,
    outOfDate: String?,
) {
    val colors = MaterialTheme.colorScheme
    val workout = proposal.target == ProposalTarget.Workout
    val type = ReviewType.of(proposal)
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (proposal.summary.isNotBlank()) Text(proposal.kicker, style = WindmillType.kicker, color = colors.onSurfaceVariant)
        Text(proposal.summaryLine(proposal.routineName), style = type.summary, color = colors.onSurface)
    }
    if (proposal.intent == ProposalIntent.Remove) {
        ChangeCard() {
            Text(stringResource(R.string.gym_review_remove_routine, proposal.routineName), style = WindmillType.labelParagraph, color = colors.onSurface)
            Text(stringResource(R.string.gym_review_remove_routine_body),
                style = WindmillType.supportingParagraph, color = colors.onSurfaceVariant)
        }
    } else {
        (if (workout) proposal.changesFirst else proposal.document).forEach { row ->
            when (row) {
                is DocumentRow.Changed -> ChangeRow(proposal, row.change, catalog)
                is DocumentRow.Unchanged -> KeptRun(row, catalog, if (workout) 0.dp else GymLayout.rowInset, type)
            }
        }
        if (proposal.renames) ChangeCard() {
            Text(stringResource(R.string.gym_review_routine_name), style = WindmillType.labelParagraph, color = colors.onSurface)
            MoveLine("", proposal.baseName, proposal.name)
        }
    }
    val note = outOfDate?.takeIf { proposal.isPending || workout }
    note?.let {
        Text(
            it,
            style = GymType.smallParagraph,
            color = colors.onSurfaceVariant,
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.surfaceContainerHighest, MaterialTheme.shapes.medium)
                .padding(GymLayout.cardInset),
        )
    }
}

private const val supersededLine =
    "This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands."

// A run of kept rows, collapsed to its count where it stands and expanded in place: the position is
// the document.
@Composable
private fun KeptRun(row: DocumentRow.Unchanged, catalog: List<Exercise>, inset: Dp, type: ReviewType) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    var open by remember(row) { mutableStateOf(false) }
    val openState = stringResource(if (open) R.string.gym_review_expanded else R.string.gym_review_collapsed)
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .semantics { stateDescription = openState }
                .clickable(role = Role.Button) { open = !open }
                .padding(horizontal = inset),
        ) {
            Text(row.label, style = type.rowLine, color = colors.onSurfaceVariant)
            Icon(
                if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = gymColors.inkFaint,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) {
            row.kept.forEach { change ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = inset),
                ) {
                    Text(
                        Readout.movement(change.exerciseId, catalog),
                        style = type.kept,
                        color = colors.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        (change.after ?: change.before)?.let { Readout.targetWithUnit(it.sets) } ?: Readout.openTarget,
                        style = type.rowLine,
                        color = colors.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun ChangeRow(proposal: Proposal, change: ProposalChange, catalog: List<Exercise>) {
    val colors = MaterialTheme.colorScheme
    val name = Readout.movement(change.exerciseId, catalog)
    val workout = proposal.target == ProposalTarget.Workout
    val type = ReviewType.of(proposal)
    ChangeCard(tight = workout) {
        val title = when (change.kind) {
            ChangeKind.Added -> stringResource(R.string.gym_review_add_named, name)
            ChangeKind.Removed -> stringResource(R.string.gym_review_remove_named, name)
            ChangeKind.Kept -> stringResource(R.string.gym_review_move_named, name)
            else -> name
        }
        Text(title, style = type.row, color = colors.onSurface)
        change.order?.let { MoveLine(it.label, it.before, it.after, type = type) }
        when (change.kind) {
            ChangeKind.Added -> {
                val target = change.after?.let { after ->
                    if (workout) Readout.targetWithUnit(after.sets, catalog.firstOrNull { it.id == change.exerciseId }) else Readout.targetWithUnit(after.sets)
                } ?: Readout.openTarget
                val after = proposal.landsAfter(change)?.let { "after ${Readout.movement(it, catalog)}" } ?: "first in ${proposal.within}"
                Text("$target · $after", style = type.rowLine, color = colors.onSurfaceVariant)
            }
            ChangeKind.Removed -> Text(change.removedLine(proposal.within), style = type.rowLine, color = colors.onSurfaceVariant)
            ChangeKind.Kept -> Unit
            else -> {
                val before = change.before
                val after = change.after
                val moved = if (before == null || after == null) emptyList() else Proposal.moves(before, after)
                if (moved.isEmpty()) Text((after ?: before)?.let { Readout.targetWithUnit(it.sets) } ?: "No targets",
                    style = type.rowLine, color = colors.onSurfaceVariant)
                moved.forEach { move ->
                    if (move.label == Proposal.setsLabel && before != null && after != null) {
                        SchemeMove(move.copy(before = Readout.targetWithUnit(before.sets), after = Readout.targetWithUnit(after.sets)), before.sets, after.sets, change, type)
                    } else MoveLine(move.label, move.before, move.after, type = type)
                }
            }
        }
    }
}

// Expand a changed scheme to compare every set, with a dash for a missing side.
@Composable
private fun SchemeMove(move: FieldMove, standing: List<SetTarget>, proposed: List<SetTarget>, change: ProposalChange, type: ReviewType) {
    var unfolded by remember(change) { mutableStateOf(false) }
    val unfoldedState = stringResource(if (unfolded) R.string.gym_review_expanded else R.string.gym_review_collapsed)
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        MoveLine(
            move.label, move.before, move.after, type,
            Modifier
                .fillMaxWidth()
                .semantics { stateDescription = unfoldedState }
                .clickable(role = Role.Button, onClickLabel = stringResource(if (unfolded) R.string.gym_review_hide_sets else R.string.gym_review_show_sets)) {
                    unfolded = !unfolded
                },
        )
        if (unfolded) {
            repeat(maxOf(standing.size, proposed.size)) { at ->
                MoveLine(
                    label = stringResource(R.string.gym_review_set_numbered, (at + 1).toString()),
                    before = standing.getOrNull(at)?.let(Readout::setTarget) ?: "—",
                    after = proposed.getOrNull(at)?.let(Readout::setTarget) ?: "—",
                    type = type,
                    modifier = Modifier.padding(start = WindmillSpace.x3),
                )
            }
        }
    }
}

@Composable
private fun MoveLine(label: String, before: String, after: String, type: ReviewType = ReviewType.routine, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Text((if (label.isBlank() || label == Proposal.setsLabel) "" else "$label · ") + "$before → $after",
        style = type.rowLine, color = colors.onSurfaceVariant,
        modifier = modifier.semantics(mergeDescendants = true) {})
}

// `tight` is a workout's row: the sheet's own gap stands above it (08.55b).
@Composable
private fun ChangeCard(tight: Boolean = false, content: @Composable () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().heightIn(min = if (tight) 0.dp else 70.dp).padding(top = if (tight) 0.dp else 12.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        Box(Modifier.fillMaxWidth().heightIn(min = 1.dp).background(colors.outlineVariant))
    }
}

@Composable
private fun Foot(
    proposal: Proposal,
    decidable: Boolean,
    signedOut: Boolean,
    deciding: Boolean,
    seen: Boolean,
    said: String?,
    onDecide: (Boolean) -> Unit,
    onSignIn: () -> Unit,
    receiptModifier: Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val type = ReviewType.of(proposal)
    val workout = proposal.target == ProposalTarget.Workout
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = if (workout) 4.dp else 12.dp, bottom = if (workout) 0.dp else 12.dp),
    ) {
        said?.let { Text(it, style = type.rowLine, color = colors.onSurfaceVariant) }
        if (!decidable) {
            proposal.receipt?.let { Text(it, style = type.row, color = colors.primary,
                modifier = receiptModifier) }
            return@Column
        }
        if (signedOut) {
            Text(Proposal.signInToReview, style = type.rowLine, color = colors.onSurfaceVariant)
            Button(
                onClick = onSignIn,
                modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.primary),
                colors = ButtonDefaults.buttonColors(containerColor = colors.primary, contentColor = colors.onPrimary),
            ) {
                Text(stringResource(R.string.gym_review_sign_in), style = type.action)
            }
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
        Button(
            onClick = { onDecide(true) },
            enabled = seen && !deciding,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                // TalkBack announced `disabled` and nothing else; the reason belongs on the control
                // that is refusing, not only in the row beneath it.
                .semantics { if (!seen) stateDescription = Proposal.applyHint },
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.primary,
                contentColor = colors.onPrimary,
                disabledContainerColor = colors.primary.copy(alpha = .4f),
                disabledContentColor = colors.onPrimary.copy(alpha = .4f),
            ),
        ) {
            Text(proposal.applyLabel, style = type.action)
        }
        // Laid out in BOTH states so the band's height never changes, and off the SEMANTICS tree in
        // BOTH: the reason Apply is refusing belongs to Apply, which says it above, and a reader
        // walking the shut band would otherwise meet one fact twice in a row. The pixels carry the
        // sighted reader; `ReviewSheetTests` counts the nodes that carry the screen reader.
        Text(
            Proposal.applyHint,
            style = GymType.numeralSmall,
            color = colors.onSurfaceVariant,
            modifier = Modifier
                .fillMaxWidth()
                .alpha(if (seen) 0f else 1f)
                .clearAndSetSemantics { },
        )
        Text(
            proposal.atomicLine,
            style = type.atomic,
            color = colors.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth(),
        )
        TextButton(
            onClick = { turningDown = true },
            enabled = !deciding,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
        ) {
            Text(Proposal.turnDownVerb, style = type.action)
        }
    }
}

// A proposal's card, addressed by what it changes. While a workout is open a routine's change reaches that routine's next workout, never this one (08.56).
@Composable
fun ProposalCard(
    proposal: Proposal,
    routineName: String,
    nowMs: Long,
    stillWaiting: Boolean,
    nextTime: Boolean = false,
    onReview: () -> Unit,
) {
    val waiting = proposal.isPending && proposal.outOfDate == null
    val kicker = listOfNotNull(
        if (proposal.target == ProposalTarget.Workout) proposal.subject else routineName,
        Proposal.nextTime.takeIf { nextTime && waiting && proposal.target == ProposalTarget.Routine },
        Proposal.outOfDateWord.takeIf { proposal.outOfDate != null },
    ).joinToString(" · ")
    CoachProposalCard("Proposal · $kicker", proposal.summaryLine(routineName),
        proposal.counted + if (stillWaiting && waiting) " · ${Proposal.stillWaiting}" else "", proposal.outOfDate, onReview)
}

@Composable
fun ProposalChip(onReview: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clickable(role = Role.Button, onClick = onReview)
            .padding(horizontal = WindmillSpace.x1),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(colors.primary))
        Text(stringResource(R.string.gym_review_one_proposal), style = GymType.proposalBadge, color = colors.primary)
    }
}

private data class PreviewReviewState(
    override val catalog: List<Exercise> = TheSix.movements,
    override val settledProposals: Map<String, Proposal> = emptyMap(),
    override val accountKey: String = "preview",
) : ReviewState {
    override fun outOfDateLine(id: String): String? = null
}

// Reads the one proposal it holds; no decision answers.
private class PreviewReviewEvents(private val pending: Proposal) : ReviewEvents {
    override suspend fun proposal(id: String): ProposalRead = ProposalRead.Found(pending)
    override suspend fun applyProposal(id: String): ProposalOutcome = awaitCancellation()
    override suspend fun dismissProposal(id: String): ProposalOutcome = awaitCancellation()
    override fun removalPending(id: String): Boolean = false
    override fun proposalReceiptShown(proposal: Proposal, seatKey: String) = Unit
}

@DarkAndDaylight
@Composable
private fun PendingProposalPreview() {
    val pending = Proposal(
        id = "proposal-push", routineId = "routine-push",
        summary = "Bench went up clean for three sessions, so it moves up 2.5 kg.",
        changeCount = 1, source = ProposalSource(door = ProposalSource.askDoor),
        baseRevision = 4, baseName = "Push Day", name = "Push Day",
        changes = listOf(
            ProposalChange(1, ChangeKind.Retargeted, "bench-press",
                ProposalTargets(List(3) { SetTarget(8, 75.0) }), ProposalTargets(List(3) { SetTarget(8, 77.5) })),
            ProposalChange(2, ChangeKind.Kept, "overhead-press",
                ProposalTargets(List(3) { SetTarget(6, 47.5) }), ProposalTargets(List(3) { SetTarget(6, 47.5) })),
        ),
    )
    GymPreview {
        Box(Modifier.background(MaterialTheme.colorScheme.surfaceContainer)) {
            ReviewSheet(pending.id, PreviewReviewState(), PreviewReviewEvents(pending), onAsk = {}, onDecided = {}, onSignIn = {})
        }
    }
}
