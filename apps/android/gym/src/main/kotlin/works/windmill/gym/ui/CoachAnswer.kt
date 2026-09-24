package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.AnswerReceipt
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskStep
import works.windmill.gym.domain.CoachBlock
import works.windmill.gym.domain.CoachMarkdown
import works.windmill.gym.domain.CoachResult
import works.windmill.gym.domain.CoachSpan
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

@Composable
internal fun CoachQuestion(question: String) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        CoachMessage({ question }, Modifier.fillMaxWidth(0.9f).background(skin.raised, RoundedCornerShape(20.dp))) {
            Text(question, style = WindmillFont.body(17).copy(lineHeight = 24.sp), color = skin.ink, modifier = Modifier.padding(16.dp))
        }
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
        if (text.isNotEmpty()) CoachMessage({ CoachMarkdown.plain(text) }) { CoachProse(text) }
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
            var expanded by rememberSaveable { mutableStateOf(false) }
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

// Both speakers' actions: a tap or a long press opens the menu, Copy is also an accessibility action,
// and the menu state rides with the message so a delta never closes it.
@Composable
private fun CoachMessage(copyText: () -> String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val skin = LocalGymColors.current
    var menu by rememberSaveable { mutableStateOf(false) }
    val copy = { clipboard.setText(AnnotatedString(copyText())); menu = false }
    Box(modifier) {
        Box(
            Modifier.fillMaxWidth()
                .combinedClickable(
                    interactionSource = null,
                    indication = null,
                    onClickLabel = "Message actions",
                    onClick = { menu = true },
                    onLongClickLabel = "Message actions",
                    onLongClick = { menu = true },
                )
                .semantics { customActions = listOf(CustomAccessibilityAction("Copy") { copy(); true }) },
        ) { content() }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = skin.raised) {
            DropdownMenuItem(text = { Text("Copy") }, onClick = copy)
        }
    }
}

// One text node per block: a settled block keeps its node and its layout while the tail block alone
// grows with the stream.
@Composable
private fun CoachProse(text: String) {
    val blocks = remember(text) { CoachMarkdown.parse(text) }
    Column(Modifier.fillMaxWidth()) {
        blocks.forEachIndexed { index, block ->
            val above = blocks.getOrNull(index - 1)
            key(index) {
                // Strong skipping compares this unstable parameter by identity: the earlier instance
                // stays while the block reads the same, so a settled block is skipped each revision.
                CoachBlockView(
                    block = remember(block) { block },
                    gapAbove = when {
                        above == null -> 0.dp
                        block is CoachBlock.ListItem && above is CoachBlock.ListItem -> 6.dp
                        else -> WindmillSpace.x3
                    },
                )
            }
        }
    }
}

@Composable
private fun CoachBlockView(block: CoachBlock, gapAbove: Dp) {
    val skin = LocalGymColors.current
    val slot = Modifier.fillMaxWidth().padding(top = gapAbove)
    when (block) {
        is CoachBlock.Paragraph -> Text(block.spans.styled(skin), style = AnswerType.paragraph, color = skin.ink, modifier = slot)
        is CoachBlock.Heading -> Text(block.spans.styled(skin), style = AnswerType.heading(block.level), color = skin.ink, modifier = slot)
        is CoachBlock.ListItem -> Row(
            modifier = slot.padding(start = 20.dp * block.depth),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                block.ordinal?.let { "$it." } ?: "•",
                style = AnswerType.marker, color = skin.inkDim,
                softWrap = false, overflow = TextOverflow.Visible, modifier = Modifier.width(24.dp),
            )
            Text(block.spans.styled(skin), style = AnswerType.paragraph, color = skin.ink, modifier = Modifier.weight(1f))
        }
        is CoachBlock.Code -> Text(
            block.text, style = AnswerType.code, color = skin.ink,
            modifier = slot.background(skin.surface, RoundedCornerShape(12.dp)).padding(12.dp),
        )
        CoachBlock.Rule -> Box(slot.height(1.dp).background(skin.line))
    }
}

private fun List<CoachSpan>.styled(skin: GymColors): AnnotatedString = buildAnnotatedString {
    for (span in this@styled) {
        if (!span.bold && !span.italic && !span.code) {
            append(span.text)
            continue
        }
        val style = SpanStyle(
            fontWeight = FontWeight.Bold.takeIf { span.bold },
            fontStyle = FontStyle.Italic.takeIf { span.italic },
            fontFamily = FontFamily.Monospace.takeIf { span.code },
            fontSize = if (span.code) 17.sp else TextUnit.Unspecified,
            background = if (span.code) skin.raised else Color.Unspecified,
        )
        withStyle(style) { append(span.text) }
    }
}

private object AnswerType {
    val paragraph = WindmillFont.body(19).copy(lineHeight = 27.sp)
    val marker = paragraph.copy(fontFeatureSettings = "tnum")
    val code = WindmillFont.mono(15)

    fun heading(level: Int): TextStyle = when (level) {
        1 -> WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 28.sp)
        2 -> WindmillFont.body(20, FontWeight.Bold).copy(lineHeight = 27.sp)
        else -> WindmillFont.body(19, FontWeight.Bold).copy(lineHeight = 27.sp)
    }
}

@Composable
internal fun CoachAction(label: String, onClick: () -> Unit, primary: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Box(
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
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = onReview).padding(12.dp),
        ) { Text("Review", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink) }
    }
}
