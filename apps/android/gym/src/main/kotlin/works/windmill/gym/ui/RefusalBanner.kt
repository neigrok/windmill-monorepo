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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import works.windmill.gym.R
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Readout
import works.windmill.gym.store.RefusedChange
import works.windmill.gym.store.RefusedSet
import works.windmill.gym.store.RefusedWrite
import works.windmill.gym.store.RefusedWorkout
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text

internal fun refusalWords(refused: RefusedWrite, catalog: List<Exercise>): Words = when (refused) {
    is RefusedSet -> Words.Message(R.string.gym_refusal_set,
        listOf(Readout.movement(refused.exerciseId, catalog), Readout.effort(refused.weightKg, refused.reps)))
    is RefusedWorkout -> refused.startedAtMs?.let { Words.Message(R.string.gym_refusal_workout_on, listOf(Readout.date(it))) }
        ?: Words.Message(R.string.gym_refusal_workout)
    is RefusedChange -> refused.named?.let { Words.Message(R.string.gym_refusal_change, listOf(it)) } ?: Words.Message(R.string.gym_store_change_unsaved)
}

@Composable
internal fun Refusals(refusals: List<RefusedWrite>, catalog: List<Exercise>, onDismiss: () -> Unit) {
    refusals.forEach { refused ->
        key(refused.id) {
            Refusal(refusalWords(refused, catalog).text(), refused.why.text(), onDismiss)
        }
    }
}

// Swipe it away, either direction: it discards a notice and not data, so there is nothing to undo
// and no ground to draw under it. The `Dismiss` button is gone with it — and because a drag is all
// TalkBack would see, the same act is declared BY HAND as this row's own custom action (Law 1).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Refusal(headline: String, reason: String, onDismiss: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val haptics = rememberGymHaptics()
    val dismiss = stringResource(R.string.gym_action_dismiss)
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
            customActions = listOf(CustomAccessibilityAction(dismiss) { onDismiss(); true })
        },
    ) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = GymTap.minimum).background(colors.surface),
            verticalArrangement = Arrangement.spacedBy(GymLayout.pair, Alignment.CenterVertically),
        ) {
            Text(headline, style = MaterialTheme.typography.bodySmall, color = gymColors.alarmInk)
            Text(reason, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        }
    }
}

@Composable
private fun DismissGround() {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().heightIn(min = GymTap.minimum).padding(horizontal = WindmillSpace.x1),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box { Text(stringResource(R.string.gym_action_dismiss), style = GymType.dismiss, color = colors.onSurfaceVariant) }
        Box { Text(stringResource(R.string.gym_action_dismiss), style = GymType.dismiss, color = colors.onSurfaceVariant) }
    }
}
