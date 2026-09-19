package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.AnswerReceipt
import works.windmill.gym.domain.CoachResult
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskStep
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont

@Composable
internal fun CoachQuestion(question: String) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        CoachMessageText(
            question,
            style = WindmillFont.body(17).copy(lineHeight = 24.sp),
            color = skin.ink,
            modifier = Modifier.fillMaxWidth(0.9f)
                .background(skin.raised, RoundedCornerShape(20.dp)).padding(16.dp),
        )
    }
}

@Composable
internal fun CoachAnswer(
    text: String,
    receipt: AnswerReceipt?,
    catalog: List<Exercise>,
    nowMs: Long,
    legacyRead: ReadTally? = null,
    legacySteps: List<AskStep> = emptyList(),
    results: List<CoachResult> = emptyList(),
    onOpenRoutine: ((String) -> Unit)? = null,
) {
    val skin = LocalGymColors.current
    val evidence = receipt?.takeIf { it.supported }
    Column(verticalArrangement = Arrangement.spacedBy(24.dp), modifier = Modifier.fillMaxWidth()) {
        if (text.isNotEmpty()) CoachMessageText(text, style = WindmillFont.body(19).copy(lineHeight = 27.sp), color = skin.ink)
        results.filter { it.kind == "routine-created" }.distinctBy { it.operationId }.forEach { result ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp)) {
                Text("Routine created", style = WindmillFont.body(14), color = skin.inkDim)
                Text(result.routineName, style = WindmillFont.body(18, FontWeight.Bold), color = skin.ink)
                onOpenRoutine?.let { open -> CoachAction("Open routine", { open(result.routineId) }) }
            }
        }
        val focus = evidence?.workouts?.singleOrNull()
        if (focus != null) Text("From your log", style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.inkDim)
        listOfNotNull(focus).forEach { observation ->
            val workout = requireNotNull(observation.workout)
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp),
            ) {
                Text(
                    "${observation.routine?.takeIf { it.isNotBlank() } ?: "Free session"} · ${Readout.shortDate(observation.startedAtMs, nowMs)}",
                    style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.inkDim,
                )
                val facts = listOfNotNull(
                    "Working sets" to workout.workingSetCount.toString(),
                    "Volume" to "${Readout.weight(workout.tonnageKg)} kg",
                    workout.durationMs?.let { "Duration" to if (it < 60_000) "<1 min" else "${it / 60_000} min" },
                )
                facts.forEach { (label, value) ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
                        Text(label, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim, modifier = Modifier.weight(1f))
                        Text(value, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
                    }
                }
            }
        }
        val tally = evidence?.read ?: legacyRead
        if (tally != null) {
            val phrases = Ask.steps(evidence?.steps ?: legacySteps)
            val observations = evidence?.observed.orEmpty()
            val expandable = phrases.isNotEmpty() || observations.isNotEmpty()
            var expanded by rememberSaveable(text) { mutableStateOf(false) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).then(
                        if (!expandable) Modifier else Modifier.semantics {
                            stateDescription = if (expanded) "expanded" else "collapsed"
                        }.clickable(role = Role.Button) { expanded = !expanded },
                    ),
                ) {
                    Text(Ask.receipt(tally).replaceFirstChar { it.uppercase() }, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim, modifier = Modifier.weight(1f))
                    if (expandable) Text(if (expanded) "−" else "+", color = skin.inkDim)
                }
                if (expanded) {
                    observations.forEach { fact ->
                        val about = fact.routine?.takeIf { it.isNotBlank() } ?: "Free session"
                        val scope = when (fact.coverage) {
                            "movement" -> "${Readout.movement(requireNotNull(fact.exerciseId), catalog)} · ${Readout.setCount(fact.setsRead)} read"
                            "session" -> "Workout · ${Readout.setCount(fact.setsRead)} read"
                            else -> "Workout summary"
                        }
                        val totals = fact.workout?.takeIf { fact.wholeWorkout }?.let { " · ${Readout.setCount(it.workingSetCount)} working · ${Readout.weight(it.tonnageKg)}kg" }.orEmpty()
                        Text("$about · ${Readout.shortDate(fact.startedAtMs, nowMs)}\n$scope$totals", style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
                    }
                    phrases.forEach { phrase ->
                        Text(phrase.replaceFirstChar { it.uppercase() }, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
                    }
                }
            }
        }
    }
}

@Composable
private fun CoachMessageText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    val skin = LocalGymColors.current
    var menu by rememberSaveable(text) { mutableStateOf(false) }
    val copy = { clipboard.setText(AnnotatedString(text)); menu = false }
    Box {
        Text(text, style = style, color = color, modifier = modifier.then(
            if (text.isEmpty()) Modifier else Modifier.combinedClickable(
                onClickLabel = "Message actions",
                onClick = { menu = true },
                onLongClickLabel = "Message actions",
                onLongClick = { menu = true },
            ).semantics {
                customActions = listOf(CustomAccessibilityAction("Copy") { copy(); true })
            },
        ))
        DropdownMenu(expanded = menu && text.isNotEmpty(), onDismissRequest = { menu = false }, containerColor = skin.raised) {
            DropdownMenuItem(text = { Text("Copy") }, onClick = copy)
        }
    }
}

@Composable
internal fun CoachAction(label: String, onClick: () -> Unit, primary: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    androidx.compose.foundation.layout.Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp)
            .background(if (primary) skin.accent else skin.raised, RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(label, style = WindmillFont.body(16, FontWeight.Bold), color = if (primary) skin.onAccent else skin.ink)
    }
}

@Composable
internal fun CoachProposalCard(routine: String, summary: String, count: String, onReview: () -> Unit) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp),
    ) {
        Text("Proposal · $routine", style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.inkDim)
        Text(summary, style = WindmillFont.body(20, FontWeight.Bold).copy(lineHeight = 28.sp), color = skin.ink)
        Text(count, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        androidx.compose.foundation.layout.Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = onReview).padding(12.dp),
        ) { Text("Review", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink) }
    }
}
