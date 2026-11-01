package works.windmill.gym.coach

import works.windmill.gym.ui.overContainer
import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import works.windmill.gym.ui.gymColors
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.TextButton
import androidx.compose.ui.graphics.Color
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
import works.windmill.gym.R

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CoachGreeting(signedIn: Boolean, enabled: Boolean, onScreenshot: () -> Unit, onBuild: () -> Unit) {
    val colors = MaterialTheme.colorScheme
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
            Text(introduction, style = GymType.coachParagraph, color = colors.onSurface)
        }
        CoachBubble(group = CoachGroup.Last, copyText = { capabilities.text }) {
            Text(capabilities, style = GymType.coachParagraph, color = colors.onSurface)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
            listOf(Triple("Add screenshot", R.drawable.gym_coach_image, onScreenshot),
                Triple("Build my own", R.drawable.gym_native_add, onBuild)).forEach { (label, icon, action) ->
                FilledTonalButton(onClick = action, enabled = enabled,
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
                    Icon(painterResource(icon), null, Modifier.size(20.dp))
                    Text(label, style = GymType.coachAction,
                        modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CoachChoices(clarification: CoachClarification, selected: Map<String, List<String>>, enabled: Boolean,
    onChoose: (String, String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        clarification.groups.forEach { group ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(group.label, style = GymType.coachGroupLabel, color = colors.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    group.options.forEach { option ->
                        val chosen = option.id in selected[group.id].orEmpty()
                        FilterChip(selected = chosen, enabled = enabled, onClick = { onChoose(group.id, option.id) },
                            label = { Text(option.label, Modifier.padding(vertical = 6.dp), style = GymType.coachChoice.overContainer()) },
                            leadingIcon = if (chosen) { { Icon(painterResource(R.drawable.gym_coach_selected), null, Modifier.size(18.dp)) } } else null,
                            border = BorderStroke(1.dp, if (chosen) colors.primary else colors.outlineVariant),
                            colors = FilterChipDefaults.filterChipColors(containerColor = Color.Transparent, labelColor = colors.onSurface,
                                selectedContainerColor = colors.primaryContainer, selectedLabelColor = colors.primary, selectedLeadingIconColor = colors.primary))
                    }
                }
            }
        }
    }
}

@Composable
internal fun CoachKeptDraft(draft: CoachDraft, enabled: Boolean, onContinue: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val shape = RoundedCornerShape(20.dp)
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, shape).border(1.dp, colors.outlineVariant, shape)
        .padding(horizontal = 16.dp).padding(top = 16.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Draft kept on this phone", style = GymType.coachNote, color = colors.onSurfaceVariant)
        if (draft.text.isNotEmpty()) Text(draft.text, style = GymType.coachDraft, color = colors.onSurface)
        TextButton(onClick = onContinue, enabled = enabled, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
            Text("Continue saved draft", style = GymType.coachAction,
                color = if (enabled) colors.primary else gymColors.inkFaint)
        }
    }
}
