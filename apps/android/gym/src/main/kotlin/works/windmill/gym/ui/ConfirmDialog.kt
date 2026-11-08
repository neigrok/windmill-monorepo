package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import works.windmill.gym.R
import works.windmill.platform.i18n.pluralString

@Composable
fun ConfirmDialog(
    title: String,
    body: String?,
    confirm: String,
    keep: String = stringResource(R.string.gym_action_keep_it),
    destructive: Boolean,
    onConfirm: () -> Unit,
    onKeep: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    AlertDialog(
        onDismissRequest = onKeep,
        containerColor = colors.surfaceContainer,
        titleContentColor = colors.onSurface,
        textContentColor = colors.onSurfaceVariant,
        title = { Text(title, style = GymType.confirmTitle) },
        text = body?.let { { Text(it, style = GymType.quietParagraph) } },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (destructive) gymColors.alarmInk else colors.primary,
                ),
            ) {
                Text(confirm, style = GymType.strongAction)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onKeep,
                colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurfaceVariant),
            ) {
                Text(keep, style = GymType.quietAction)
            }
        },
    )
}

data class WorkoutDiscardPrompt(
    val summary: works.windmill.gym.presentation.SessionSummary,
    val detail: works.windmill.gym.presentation.SessionDetail?,
    val screen: String,
    val replica: String?,
    val anonymous: Boolean,
)

@Composable
fun WorkoutDiscardDialog(setCount: Int, onDiscard: () -> Unit, onCancel: () -> Unit, busy: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        containerColor = colors.surfaceContainer,
        title = { Text(stringResource(R.string.gym_logger_discard_workout_title), style = GymType.discardWorkoutTitle.overContainer(), color = colors.onSurface) },
        text = { Text(pluralString(R.plurals.gym_logger_discard_workout_body, setCount, setCount.toString()),
            style = GymType.discardText.overContainer(), color = colors.onSurfaceVariant) },
        confirmButton = {
            TextButton(onClick = onDiscard, enabled = !busy,
                colors = ButtonDefaults.textButtonColors(contentColor = colors.error)) {
                Text(stringResource(R.string.gym_action_discard), style = GymType.discardAction.overContainer())
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, enabled = !busy,
                colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurfaceVariant)) {
                Text(stringResource(R.string.gym_action_cancel), style = GymType.discardAction.overContainer())
            }
        },
    )
}
