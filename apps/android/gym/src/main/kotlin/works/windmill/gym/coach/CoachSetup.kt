package works.windmill.gym.coach

import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import works.windmill.gym.ui.gymColors
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.fromHtml
import androidx.compose.ui.unit.dp
import works.windmill.gym.R

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CoachGreeting(signedIn: Boolean, enabled: Boolean, onScreenshot: () -> Unit, onBuild: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val introduction = stringResource(R.string.gym_coach_greeting)
    val lines = listOf(R.string.gym_coach_greeting_build, R.string.gym_coach_greeting_goals) +
        if (signedIn) listOf(R.string.gym_coach_greeting_notes, R.string.gym_coach_greeting_changes) else listOf(R.string.gym_coach_greeting_account)
    val marked = lines.map { stringResource(it) }
    val capabilities = remember(marked) {
        buildAnnotatedString {
            marked.forEachIndexed { index, line ->
                if (index > 0) append('\n')
                append(AnnotatedString.fromHtml(line))
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        CoachBubble(group = CoachGroup.First, copyText = { introduction }) {
            Text(introduction, style = GymType.coachParagraph, color = colors.onSurface)
        }
        CoachBubble(group = CoachGroup.Last, copyText = { capabilities.text }) {
            Text(capabilities, style = GymType.coachParagraph, color = colors.onSurface)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
            listOf(Triple(R.string.gym_coach_add_screenshot, R.drawable.gym_coach_image, onScreenshot),
                Triple(R.string.gym_coach_build_my_own, R.drawable.gym_native_add, onBuild)).forEach { (label, icon, action) ->
                FilledTonalButton(onClick = action, enabled = enabled,
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
                    Icon(painterResource(icon), null, Modifier.size(20.dp))
                    Text(stringResource(label), style = GymType.coachAction,
                        modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@Composable
internal fun CoachKeptDraft(draft: CoachDraft, enabled: Boolean, onContinue: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val shape = MaterialTheme.shapes.large
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, shape).border(1.dp, colors.outlineVariant, shape)
        .padding(horizontal = 16.dp).padding(top = 16.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.gym_coach_draft_kept), style = GymType.coachNote, color = colors.onSurfaceVariant)
        if (draft.text.isNotEmpty()) Text(draft.text, style = GymType.coachDraft, color = colors.onSurface)
        TextButton(onClick = onContinue, enabled = enabled, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
            Text(stringResource(R.string.gym_coach_continue_draft), style = GymType.coachAction,
                color = if (enabled) colors.primary else gymColors.inkFaint)
        }
    }
}
