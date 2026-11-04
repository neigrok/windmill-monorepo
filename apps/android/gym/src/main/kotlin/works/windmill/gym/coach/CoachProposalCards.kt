package works.windmill.gym.coach

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import works.windmill.gym.R
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.ui.GymType
import works.windmill.gym.ui.ProposalCard
import works.windmill.platform.design.WindmillType

// The proposals one answer carries: the change to this workout first, then the routine's (08.56), each with how it settled, and the promise once under them while one still waits. Over the workout they stand on the thread's own edge (08.55).
@Composable
internal fun AnswerProposals(
    answer: CoachReply,
    routines: Map<String, Proposal>,
    state: AskState,
    nowMs: Long,
    lookedAt: Set<String>,
    overWorkout: Boolean,
    onReview: (Proposal) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val minted = answer.proposals.mapNotNull { routines[it] }
    if (answer.workoutProposals.isEmpty() && minted.isEmpty()) return
    val workouts = answer.workoutProposals.mapNotNull { state.workoutProposals[it] }
    Column(
        verticalArrangement = Arrangement.spacedBy(if (overWorkout) 12.dp else 20.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = if (overWorkout) 0.dp else 4.dp),
    ) {
        answer.workoutProposals.filter { it !in state.workoutProposals }.forEach { key(it) { ArrivingProposal() } }
        (workouts + minted).forEach { proposal ->
            key(proposal.id) {
                ProposalCard(proposal, proposal.routineName, nowMs, stillWaiting = proposal.id in lookedAt, nextTime = state.workoutOpen) { onReview(proposal) }
                proposal.receipt?.let { ReceiptLine(it) }
            }
        }
        if ((workouts + minted).any { it.isPending && it.outOfDate == null }) Text(Ask.promise, style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
    }
}

// A change to this workout the phone does not hold yet: Coach can answer on another phone before its proposal reaches this one. It is read again every time the replica changes, and past the wait a miss says so.
@Composable
private fun ArrivingProposal() {
    var gone by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(AnsweredProposals.settleMs)
        gone = true
    }
    Text(if (gone) ProposalRead.Gone.line else "Reading proposal…", style = WindmillType.supporting, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

// The card: what it is about, the summary, the counted changes, why it can no longer be applied, and one affordance. Nothing on it decides anything.
@Composable
internal fun CoachProposalCard(kicker: String, summary: String, count: String, reason: String?, onReview: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier.fillMaxWidth().background(colors.surfaceContainer, RoundedCornerShape(20.dp)).padding(16.dp),
    ) {
        Text(kicker, style = GymType.coachStrong, color = colors.onSurfaceVariant)
        Text(summary, style = GymType.coachProposalSummary, color = colors.onSurface)
        Text(count, style = GymType.coachSupporting, color = colors.onSurfaceVariant)
        reason?.let { Text(it, style = GymType.coachSupporting, color = colors.onSurface) }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = onReview).padding(12.dp),
        ) { Text(Proposal.review, style = GymType.button, color = colors.onSurface) }
    }
}

private val freshChatHeight = 456.dp

// Coach over the workout (08.54, 08.55): the room under a sheet's own head. A fresh chat asks for the height the board draws, lifted over the keyboard; a conversation takes all the sheet is given.
@Composable
internal fun CoachSheetFrame(fresh: Boolean, onThreads: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    val colors = MaterialTheme.colorScheme
    val keyboard = WindowInsets.ime.asPaddingValues().calculateBottomPadding()
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth()
            .then(if (fresh) Modifier.height(freshChatHeight + keyboard) else Modifier.fillMaxHeight())
            .padding(vertical = 12.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxWidth().height(36.dp).padding(start = 20.dp, end = 8.dp),
        ) {
            Text(Ask.title, style = GymType.coachSheetTitle, color = colors.onSurface, modifier = Modifier.weight(1f).semantics { heading() })
            IconButton(onClick = onThreads, modifier = Modifier.requiredSize(48.dp)) {
                Icon(painterResource(R.drawable.gym_coach_history), "History", tint = colors.onSurface, modifier = Modifier.size(24.dp))
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth(), content = content)
    }
}
