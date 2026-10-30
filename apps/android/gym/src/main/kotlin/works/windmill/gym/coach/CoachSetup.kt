package works.windmill.gym.coach

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R
import works.windmill.gym.ui.LocalGymColors

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CoachGreeting(signedIn: Boolean, enabled: Boolean, onScreenshot: () -> Unit, onBuild: () -> Unit) {
    val skin = LocalGymColors.current
    val introduction = "Hi, I’m Coach. I can help you with:"
    val capabilities = buildAnnotatedString {
        val lines = listOf("Build" to "a program from a screenshot or your own words.",
            "Goals" to "tell me your goals, and I will plan for them.") + if (signedIn)
            listOf("Notes" to "I save important facts, like an old injury.", "Changes" to "ask me, and I suggest changes to your routines.")
        else listOf("Account" to "sign in, and I can also save notes and suggest changes to your routines.")
        lines.forEachIndexed { index, (anchor, text) ->
            if (index > 0) append('\n')
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(anchor) }
            append(" — $text")
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        CoachBubble(group = CoachGroup.First, copyText = { introduction }) {
            Text(introduction, style = CoachType.body(16).copy(lineHeight = 22.sp), color = skin.ink)
        }
        CoachBubble(group = CoachGroup.Last, copyText = { capabilities.text }) {
            Text(capabilities, style = CoachType.body(16).copy(lineHeight = 22.sp), color = skin.ink)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
            listOf(Triple("Add screenshot", R.drawable.gym_coach_image, onScreenshot),
                Triple("Build my own", R.drawable.gym_native_add, onBuild)).forEach { (label, icon, action) ->
                FilledTonalButton(onClick = action, enabled = enabled,
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = skin.raised, contentColor = skin.ink),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
                    Icon(painterResource(icon), null, Modifier.size(20.dp))
                    Text(label, style = CoachType.body(14, FontWeight.Bold).copy(lineHeight = 20.sp, letterSpacing = 0.1.sp),
                        modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}
