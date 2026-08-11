package works.windmill.gym.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Readout
import works.windmill.gym.store.RefusedClaim
import works.windmill.gym.store.RefusedSet
import works.windmill.gym.store.RefusedWrite
import works.windmill.platform.design.WindmillSpace

// The last copy of a write that will never land — a set with its movement and numbers, or a
// claim's refused document under its name. It is SAID because a queue that dropped it quietly
// would count the loss as intended — and this is the one place in gym allowed to use alarm ink.
// One component for both screens that say it: the logger mid-session, and Today when a boot
// claim lost something with no logger standing. One voice, one copy, dismissed as one.

// The words, apart from the drawing so a test can hold them still. A claim-level loss is said by
// NAME — the cross-platform sentence all three surfaces share — and a lost set carries its
// numbers, because "never reached the log" is unloggable again without knowing of what.
internal fun refusalHeadline(refused: RefusedWrite, catalog: List<Exercise>): String = when (refused) {
    is RefusedSet ->
        "${Readout.movement(refused.exerciseId, catalog)} " +
            "${Readout.effort(refused.weightKg, refused.reps)} never reached the log"
    is RefusedClaim -> "“${refused.name}” couldn’t be claimed"
}

@Composable
internal fun Refusals(refusals: List<RefusedWrite>, catalog: List<Exercise>, onDismiss: () -> Unit) {
    refusals.forEach { refused ->
        Refusal(headline = refusalHeadline(refused, catalog), reason = refused.reason, onDismiss = onDismiss)
    }
}

@Composable
private fun Refusal(headline: String, reason: String, onDismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                headline,
                style = GymType.numeral(12),
                color = GymSkin.alarmInk,
            )
            Text(reason, style = GymType.numeral(12), color = GymSkin.inkDim)
        }
        Box(
            Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Text("Dismiss", style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
    }
}
