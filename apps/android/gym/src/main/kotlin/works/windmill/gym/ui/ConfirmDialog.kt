package works.windmill.gym.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import works.windmill.platform.design.WindmillFont

// The platform's confirmation, in the room's own ink: the Material scheme is the brand's gold on
// brown, and gold in this room means a personal record. Closing the dialog decides nothing.
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
    AlertDialog(
        onDismissRequest = onKeep,
        containerColor = GymSkin.surface,
        titleContentColor = GymSkin.ink,
        textContentColor = GymSkin.inkDim,
        title = { Text(title, style = WindmillFont.display(19)) },
        text = body?.let { { Text(it, style = WindmillFont.body(14).copy(lineHeight = 21.sp)) } },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (destructive) GymSkin.alarmInk else GymSkin.accent,
                ),
            ) {
                Text(confirm, style = WindmillFont.body(15, FontWeight.Bold))
            }
        },
        dismissButton = {
            TextButton(
                onClick = onKeep,
                colors = ButtonDefaults.textButtonColors(contentColor = GymSkin.inkDim),
            ) {
                Text(keep, style = WindmillFont.body(15, FontWeight.SemiBold))
            }
        },
    )
}
