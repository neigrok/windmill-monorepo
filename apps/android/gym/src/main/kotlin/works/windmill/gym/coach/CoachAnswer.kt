package works.windmill.gym.coach

import works.windmill.gym.ui.GymColors
import works.windmill.gym.ui.LocalGymColors
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont

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
    routineDrafts: List<CoachRoutineDraft> = emptyList(),
    onConfirmRoutine: (suspend (CoachRoutineDraft) -> DraftOutcome)? = null,
    hasProposals: Boolean = false,
    onOpenWorkout: ((String) -> Unit)? = null,
    copyText: String = text,
    receiptInset: Dp = 0.dp,
    onSourcesTop: (Int?) -> Unit = {},
) {
    val skin = LocalGymColors.current
    val copyMenu = remember { CoachCopyMenu() }
    val evidence = receipt?.takeIf { it.supported }
    val readOnly = CoachSources.readOnly(evidence?.steps ?: legacySteps,
        hasProposals || evidence?.proposals.orEmpty().isNotEmpty(), results.isNotEmpty(), routineDrafts.isNotEmpty())
    Column(verticalArrangement = Arrangement.spacedBy(if (readOnly) 2.dp else 24.dp), modifier = Modifier.fillMaxWidth()) {
        CoachText(text, copyText, copyMenu)
        routineDrafts.filter { it.state == "pending" }.forEach { draft ->
            key(draft.operationId) {
                val scope = rememberCoroutineScope()
                var busy by remember { mutableStateOf(false) }
                var note by remember { mutableStateOf<String?>(null) }
                var closed by remember { mutableStateOf(false) }
                Column(verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = receiptInset).background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp)) {
                    Text("Review routine", style = WindmillFont.body(14), color = skin.inkDim)
                    Text(draft.name, style = WindmillFont.body(20, FontWeight.Bold), color = skin.ink)
                    draft.entries.forEach { entry ->
                        val exercise = catalog.firstOrNull { it.id == entry.exerciseId }
                        val equipment = when (exercise?.equipment) {
                            "bodyweight" -> "Bodyweight"
                            "dumbbell" -> if (exercise.loadCount == 1) "One dumbbell" else "Two dumbbells"
                            null -> "Equipment not available"
                            else -> exercise.equipment.replaceFirstChar { it.uppercase() }
                        }
                        val basis = when (exercise?.equipment) {
                            "dumbbell" -> if (exercise.loadCount == 1) "" else " each"
                            "bodyweight" -> if (entry.sets.any { (it.weightKg ?: 0.0) < 0 }) " assisted" else " added"
                            "barbell" -> " total"
                            else -> ""
                        }
                        val scheme = Readout.target(entry.sets) + if (entry.sets.any { it.weightKg != null }) " kg$basis" else ""
                        val rest = entry.restSeconds?.let { " · ${it}s rest" }.orEmpty()
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(Readout.movement(entry.exerciseId, catalog), style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                            Text("$scheme · $equipment$rest", style = WindmillFont.body(14), color = skin.inkDim)
                        }
                    }
                    note?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim) }
                    if (!closed) CoachAction(if (busy) "Saving…" else "Save routine", primary = true, enabled = !busy && onConfirmRoutine != null, onClick = {
                        if (!busy && onConfirmRoutine != null) {
                            busy = true
                            note = null
                            scope.launch {
                                try {
                                    when (val saved = onConfirmRoutine(draft)) {
                                        is DraftOutcome.Saved -> Unit
                                        is DraftOutcome.Closed -> { note = saved.said; closed = true }
                                        is DraftOutcome.Failed -> note = saved.said
                                    }
                                } finally { busy = false }
                            }
                        }
                    })
                }
            }
        }
        results.filter { it.kind == "routine-created" }.distinctBy { it.operationId }.forEach { result ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = receiptInset).background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp)) {
                Text("Routine created", style = WindmillFont.body(14), color = skin.inkDim)
                Text(result.routineName, style = WindmillFont.body(18, FontWeight.Bold), color = skin.ink)
                onOpenRoutine?.let { open -> CoachAction("Open routine", { open(result.routineId) }) }
            }
        }
        if (readOnly) {
            (evidence?.read ?: legacyRead)?.let { tally ->
                Box(Modifier.fillMaxWidth().padding(horizontal = receiptInset)) {
                    CoachReadSources(tally, evidence, evidence?.steps ?: legacySteps, onOpenWorkout, onSourcesTop)
                }
            }
        } else {
            val focus = evidence?.workouts?.singleOrNull()
            if (focus != null) Text("From your log", style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.inkDim, modifier = Modifier.padding(horizontal = receiptInset))
            listOfNotNull(focus).forEach { observation ->
                val workout = requireNotNull(observation.workout)
                Column(
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = receiptInset).background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp),
                ) {
                    Text(
                        "${observation.routine?.takeIf { it.isNotBlank() } ?: Readout.noRoutine} · ${Readout.shortDate(observation.startedAtMs, nowMs)}",
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
                val phrases = Ask.steps(evidence?.steps ?: legacySteps, drafted = routineDrafts.isNotEmpty())
                val observations = evidence?.observed.orEmpty()
                val expandable = phrases.isNotEmpty() || observations.isNotEmpty()
                var expanded by rememberSaveable { mutableStateOf(false) }
                Column(Modifier.padding(horizontal = receiptInset), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                            val about = fact.routine?.takeIf { it.isNotBlank() } ?: Readout.noRoutine
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
}

// One text node per block: a settled block keeps its node and its layout while the tail block alone
// grows with the stream.
@Composable
private fun CoachText(text: String, copyText: String, copyMenu: CoachCopyMenu) {
    val blocks = remember(text) { CoachMarkdown.parse(text) }
    if (blocks.isEmpty()) {
        if (copyMenu.selected != null) CoachBubble(fullWidth = true, copyText = { CoachMarkdown.plain(copyText) }, copyMenu = copyMenu) { }
        return
    }
    val skin = LocalGymColors.current
    if (blocks.any { it !is CoachBlock.Paragraph }) {
        CoachBubble(fullWidth = true, copyText = { CoachMarkdown.plain(copyText) }, copyMenu = copyMenu) { CoachProse(blocks) }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        blocks.filterIsInstance<CoachBlock.Paragraph>().forEachIndexed { index, block ->
            val group = when {
                blocks.size == 1 -> CoachGroup.Single
                index == 0 -> CoachGroup.First
                index == blocks.lastIndex -> CoachGroup.Last
                else -> CoachGroup.Middle
            }
            CoachBubble(group = group, copyText = { CoachMarkdown.plain(copyText) }, copyMenu = copyMenu, copyIndex = index, copyLastIndex = blocks.lastIndex) {
                Text(block.spans.styled(skin), style = AnswerType.paragraph, color = skin.ink)
            }
        }
    }
}

@Composable
private fun CoachProse(blocks: List<CoachBlock>) {
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
                        block is CoachBlock.ListItem && above is CoachBlock.ListItem -> 4.dp
                        else -> 8.dp
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
                softWrap = false, overflow = TextOverflow.Visible, modifier = Modifier.width(if (block.ordinal == null) 8.dp else 24.dp),
            )
            Text(block.spans.styled(skin), style = AnswerType.paragraph, color = skin.ink, modifier = Modifier.weight(1f))
        }
        is CoachBlock.Table -> BoxWithConstraints(slot) {
            val columns = block.header.cells.size
            val widths = List(columns) { index -> if (index == 0) 150.dp else if (columns == 3 && index == 1) 56.dp else 80.dp }
            val needed = widths.fold(24.dp) { sum, width -> sum + width }
            val tableWidth = maxOf(maxWidth, needed)
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, skin.line, RoundedCornerShape(12.dp))
                .horizontalScroll(rememberScrollState())) {
                Column(Modifier.width(tableWidth)) {
                    (listOf(block.header) + block.rows).forEachIndexed { rowIndex, row ->
                        Row(Modifier.fillMaxWidth().then(if (rowIndex == 0) Modifier.background(skin.raised) else Modifier)
                            .padding(horizontal = 12.dp, vertical = 8.dp)) {
                            row.cells.forEachIndexed { column, cell ->
                                Text(cell.styled(skin), style = CoachType.body(14, if (rowIndex == 0) FontWeight.Bold else FontWeight.Normal).copy(lineHeight = 20.sp),
                                    color = if (rowIndex == 0) skin.inkDim else skin.ink, modifier = Modifier.width(widths[column]))
                            }
                        }
                    }
                }
            }
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
            fontSize = if (span.code) 15.sp else TextUnit.Unspecified,
            background = if (span.code) skin.raised else Color.Unspecified,
        )
        withStyle(style) { append(span.text) }
    }
}

private object AnswerType {
    val paragraph = CoachType.body(16).copy(lineHeight = 22.sp)
    val marker = paragraph.copy(fontFeatureSettings = "tnum")
    val code = WindmillFont.mono(15)

    fun heading(level: Int): TextStyle = CoachType.body(if (level <= 2) 17 else 16, FontWeight.Bold).copy(lineHeight = 24.sp)
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
