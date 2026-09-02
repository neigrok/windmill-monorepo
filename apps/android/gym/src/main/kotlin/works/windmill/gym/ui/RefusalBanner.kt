package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Readout
import works.windmill.gym.store.RefusedClaim
import works.windmill.gym.store.RefusedSet
import works.windmill.gym.store.RefusedWrite
import works.windmill.platform.design.WindmillSpace

internal fun refusalHeadline(refused: RefusedWrite, catalog: List<Exercise>): String = when (refused) {
    is RefusedSet ->
        "${Readout.movement(refused.exerciseId, catalog)} " +
            "${Readout.effort(refused.weightKg, refused.reps)} never reached the log"
    is RefusedClaim -> "“${refused.name}” couldn’t be claimed"
}

@Composable
internal fun Refusals(refusals: List<RefusedWrite>, catalog: List<Exercise>, onDismiss: () -> Unit) {
    refusals.forEach { refused ->
        key(refused.id) {
            Refusal(refusalHeadline(refused, catalog), refused.reason, onDismiss)
        }
    }
}

// Swipe it away, either direction: it discards a notice and not data, so there is nothing to undo
// and no ground to draw under it. The `Dismiss` button is gone with it — and because a drag is all
// TalkBack would see, the same act is declared BY HAND as this row's own custom action (Law 1).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Refusal(headline: String, reason: String, onDismiss: () -> Unit) {
    val haptics = rememberGymHaptics()
    val swipe = rememberRowDismiss(settling = { it != SwipeToDismissBoxValue.Settled }) {
        haptics.revealed()
        onDismiss()
    }
    SwipeToDismissBox(
        state = swipe,
        backgroundContent = { DismissGround() },
        // Merged: the headline and the reason are one notice, and the action belongs to the whole
        // of it rather than to whichever half a finger lands on.
        modifier = Modifier.semantics(mergeDescendants = true) {
            customActions = listOf(CustomAccessibilityAction("Dismiss") { onDismiss(); true })
        },
    ) {
        Column(
            Modifier.fillMaxWidth().background(GymSkin.canvas),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(headline, style = MaterialTheme.typography.bodySmall, color = GymSkin.alarmInk)
            Text(reason, style = MaterialTheme.typography.bodySmall, color = GymSkin.inkDim)
        }
    }
}

@Composable
private fun DismissGround() {
    Row(
        Modifier.fillMaxWidth().heightIn(min = GymTap.minimum).padding(horizontal = WindmillSpace.x1),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box { Text("Dismiss", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.inkFaint) }
        Box { Text("Dismiss", style = GymType.numeral(11, FontWeight.Bold), color = GymSkin.inkFaint) }
    }
}
