package works.windmill.gym.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import works.windmill.platform.design.WindmillFont

@Composable
fun ConfirmDialog(
    title: String,
    body: String?,
    confirm: String,
    keep: String = "Keep it",
    destructive: Boolean,
    onConfirm: () -> Unit,
    onKeep: () -> Unit,
) {
    val skin = LocalGymColors.current
    AlertDialog(
        onDismissRequest = onKeep,
        containerColor = skin.surface,
        titleContentColor = skin.ink,
        textContentColor = skin.inkDim,
        title = { Text(title, style = WindmillFont.display(19)) },
        text = body?.let { { Text(it, style = WindmillFont.body(14).copy(lineHeight = 21.sp)) } },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (destructive) skin.alarmInk else skin.accent,
                ),
            ) {
                Text(confirm, style = WindmillFont.body(15, FontWeight.Bold))
            }
        },
        dismissButton = {
            TextButton(
                onClick = onKeep,
                colors = ButtonDefaults.textButtonColors(contentColor = skin.inkDim),
            ) {
                Text(keep, style = WindmillFont.body(15, FontWeight.SemiBold))
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
    val skin = LocalGymColors.current
    val native = androidx.compose.ui.text.font.FontFamily.Default
    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        containerColor = skin.surface,
        title = { Text("Discard this workout?", fontFamily = native, fontSize = 24.sp, lineHeight = 32.sp, color = skin.ink) },
        text = { Text("This deletes the workout and its $setCount ${if (setCount == 1) "set" else "sets"}. You can’t undo this.",
            fontFamily = native, fontSize = 14.sp, lineHeight = 20.sp, color = skin.inkDim) },
        confirmButton = {
            TextButton(onClick = onDiscard, enabled = !busy,
                colors = ButtonDefaults.textButtonColors(contentColor = skin.error)) {
                Text("Discard", fontFamily = native, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, enabled = !busy,
                colors = ButtonDefaults.textButtonColors(contentColor = skin.inkDim)) {
                Text("Cancel", fontFamily = native, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
            }
        },
    )
}
