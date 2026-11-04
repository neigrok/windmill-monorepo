package works.windmill.gym.coach

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.ui.GymType
import works.windmill.platform.design.WindmillType
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

// An answer: its words, the routines it created, the drafts a retained answer holds, and what it read once it ended.
@Composable
internal fun CoachAnswer(
    text: String,
    reply: CoachReply,
    catalog: List<Exercise>,
    workouts: (String) -> SessionSummary? = { null },
    onOpenRoutine: ((String) -> Unit)? = null,
    routineDrafts: List<CoachRoutineDraft> = emptyList(),
    onSaveDrafts: (suspend () -> DraftOutcome)? = null,
    onOpenWorkout: ((String) -> Unit)? = null,
    receiptInset: Dp = 0.dp,
    onSourcesTop: (Int?) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val copyMenu = remember { CoachCopyMenu() }
    val readOnly = CoachSources.readOnly(reply.calls, reply.proposals.isNotEmpty(), reply.routines.isNotEmpty(), routineDrafts.isNotEmpty())
    Column(verticalArrangement = Arrangement.spacedBy(if (readOnly) 2.dp else 24.dp), modifier = Modifier.fillMaxWidth()) {
        CoachText(text, reply.text, copyMenu)
        routineDrafts.forEachIndexed { index, draft ->
            key(draft.operationId) {
                val scope = rememberCoroutineScope()
                var busy by remember { mutableStateOf(false) }
                var note by remember { mutableStateOf<String?>(null) }
                var closed by remember { mutableStateOf(false) }
                Column(verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = receiptInset).background(colors.surfaceContainer, RoundedCornerShape(20.dp)).padding(16.dp)) {
                    Text("Review routine", style = WindmillType.supporting, color = colors.onSurfaceVariant)
                    Text(draft.name, style = GymType.cardTitle, color = colors.onSurface)
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
                            Text(Readout.movement(entry.exerciseId, catalog), style = WindmillType.label, color = colors.onSurface)
                            Text("$scheme · $equipment$rest", style = WindmillType.supporting, color = colors.onSurfaceVariant)
                        }
                    }
                    note?.let { Text(it, style = WindmillType.supporting, color = colors.onSurfaceVariant) }
                    // One answer's drafts are one save: the door stands under the last of them.
                    if (!closed && index == routineDrafts.lastIndex) CoachAction(if (busy) "Saving…" else "Save routine", primary = true, enabled = !busy && onSaveDrafts != null, onClick = {
                        if (!busy && onSaveDrafts != null) {
                            busy = true
                            note = null
                            scope.launch {
                                try {
                                    when (val saved = onSaveDrafts()) {
                                        DraftOutcome.Saved -> Unit
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
        reply.routines.forEach { routine ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = receiptInset).background(colors.surfaceContainer, RoundedCornerShape(20.dp)).padding(16.dp)) {
                Text("Routine created", style = WindmillType.supporting, color = colors.onSurfaceVariant)
                Text(routine.name, style = GymType.headingCompact, color = colors.onSurface)
                onOpenRoutine?.let { open -> CoachAction("Open routine", { open(routine.id) }) }
            }
        }
        if (reply.state.isTerminal) {
            val tally = reply.receipt.read
            if (readOnly) Box(Modifier.fillMaxWidth().padding(horizontal = receiptInset)) {
                CoachReadSources(tally, reply.workoutsRead.mapNotNull(workouts), reply.calls, onOpenWorkout, onSourcesTop)
            } else {
                val phrases = reply.steps.distinct()
                var expanded by rememberSaveable { mutableStateOf(false) }
                Column(Modifier.padding(horizontal = receiptInset), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).then(
                            if (phrases.isEmpty()) Modifier else Modifier.semantics {
                                stateDescription = if (expanded) "expanded" else "collapsed"
                            }.clickable(role = Role.Button) { expanded = !expanded },
                        ),
                    ) {
                        Text(Ask.receipt(tally).replaceFirstChar { it.uppercase() }, style = WindmillType.detail, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
                        if (phrases.isNotEmpty()) Text(if (expanded) "−" else "+", color = colors.onSurfaceVariant)
                    }
                    if (expanded) phrases.forEach { phrase ->
                        Text(phrase.replaceFirstChar { it.uppercase() }, style = WindmillType.detail, color = colors.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

// A settled block keeps its node and layout while only the tail grows.
@Composable
private fun CoachText(text: String, copyText: String, copyMenu: CoachCopyMenu) {
    val blocks = remember(text) { CoachMarkdown.parse(text) }
    val context = LocalContext.current
    val telemetry = LocalTelemetry.current
    val singleLink = remember(copyText) { CoachMarkdown.links(copyText).singleOrNull()?.url }
    if (blocks.isEmpty()) {
        if (copyMenu.selected != null) CoachBubble(fullWidth = true, copyText = { CoachMarkdown.copied(copyText) }, copyMenu = copyMenu, copyLink = singleLink) { }
        return
    }
    val colors = MaterialTheme.colorScheme
    if (blocks.any { it !is CoachBlock.Paragraph }) {
        val handler = remember(context, telemetry, copyMenu) { CoachLinkHandler(context, telemetry, copyMenu, 0) }
        CompositionLocalProvider(LocalUriHandler provides handler) {
            CoachBubble(fullWidth = true, copyText = { CoachMarkdown.copied(copyText) }, copyMenu = copyMenu, copyLink = singleLink) { CoachProse(blocks) }
        }
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
            val bubbleHandler = remember(context, telemetry, copyMenu, index) {
                CoachLinkHandler(context, telemetry, copyMenu, index)
            }
            CompositionLocalProvider(LocalUriHandler provides bubbleHandler) {
                CoachBubble(group = group, copyText = { CoachMarkdown.copied(copyText) }, copyMenu = copyMenu,
                    copyLink = singleLink, copyIndex = index, copyLastIndex = blocks.lastIndex) {
                    Text(block.spans.styled(colors), style = GymType.coachParagraph, color = colors.onSurface)
                }
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
                // Strong skipping compares unstable blocks by identity; retaining equal blocks skips settled revisions.
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
    val colors = MaterialTheme.colorScheme
    val slot = Modifier.fillMaxWidth().padding(top = gapAbove)
    when (block) {
        is CoachBlock.Paragraph -> Text(block.spans.styled(colors), style = GymType.coachParagraph, color = colors.onSurface, modifier = slot)
        is CoachBlock.Heading -> Text(block.spans.styled(colors), style = if (block.level <= 2) GymType.coachHeading else GymType.coachTitle, color = colors.onSurface, modifier = slot)
        is CoachBlock.ListItem -> Row(
            modifier = slot.padding(start = 20.dp * block.depth),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                block.ordinal?.let { "$it." } ?: "•",
                style = GymType.coachListMarker, color = colors.onSurfaceVariant,
                softWrap = false, overflow = TextOverflow.Visible, modifier = Modifier.width(if (block.ordinal == null) 8.dp else 24.dp),
            )
            Text(block.spans.styled(colors), style = GymType.coachParagraph, color = colors.onSurface, modifier = Modifier.weight(1f))
        }
        is CoachBlock.Table -> BoxWithConstraints(slot) {
            val columns = block.header.cells.size
            val widths = List(columns) { index -> if (index == 0) 150.dp else if (columns == 3 && index == 1) 56.dp else 80.dp }
            val needed = widths.fold(24.dp) { sum, width -> sum + width }
            val tableWidth = maxOf(maxWidth, needed)
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, colors.outlineVariant, RoundedCornerShape(12.dp))
                .horizontalScroll(rememberScrollState())) {
                Column(Modifier.width(tableWidth)) {
                    (listOf(block.header) + block.rows).forEachIndexed { rowIndex, row ->
                        Row(Modifier.fillMaxWidth().then(if (rowIndex == 0) Modifier.background(colors.surfaceContainerHighest) else Modifier)
                            .padding(horizontal = 12.dp, vertical = 8.dp)) {
                            row.cells.forEachIndexed { column, cell ->
                                Text(cell.styled(colors), style = if (rowIndex == 0) GymType.coachStrong else GymType.coachSupporting,
                                    color = if (rowIndex == 0) colors.onSurfaceVariant else colors.onSurface, modifier = Modifier.width(widths[column]))
                            }
                        }
                    }
                }
            }
        }
        is CoachBlock.Code -> Text(
            block.text, style = GymType.coachCode, color = colors.onSurface,
            modifier = slot.background(colors.surfaceContainer, RoundedCornerShape(12.dp)).padding(12.dp),
        )
        CoachBlock.Rule -> Box(slot.height(1.dp).background(colors.outlineVariant))
    }
}

private fun List<CoachSpan>.styled(colors: ColorScheme): AnnotatedString = buildAnnotatedString {
    for (span in this@styled) {
        if (!span.bold && !span.italic && !span.code && span.link == null) {
            append(span.text)
            continue
        }
        val style = SpanStyle(
            fontWeight = FontWeight.Bold.takeIf { span.bold },
            fontStyle = FontStyle.Italic.takeIf { span.italic },
            fontFamily = FontFamily.Monospace.takeIf { span.code },
            fontSize = if (span.code) GymType.coachCode.fontSize else TextUnit.Unspecified,
            background = if (span.code) colors.surfaceContainerHighest else Color.Unspecified,
        )
        withStyle(style) {
            val link = span.link
            if (link == null) append(span.text)
            else withLink(LinkAnnotation.Url(link.url, TextLinkStyles(SpanStyle(
                color = colors.primary, textDecoration = TextDecoration.Underline,
            )))) { append(span.text) }
        }
    }
}

internal class CoachLinkHandler(
    private val context: Context,
    private val telemetry: Telemetry,
    private val copyMenu: CoachCopyMenu,
    private val bubbleIndex: Int,
) : UriHandler {
    override fun openUri(uri: String) {
        val outcome = try {
            CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(uri).normalizeScheme())
            "ok"
        } catch (unavailable: ActivityNotFoundException) {
            copyMenu.selected = bubbleIndex
            "unavailable"
        } catch (failure: Exception) {
            telemetry.failure("gym.openLink", failure)
            copyMenu.selected = bubbleIndex
            "failed"
        }
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "open_link", "outcome" to outcome))
    }
}

@Composable
internal fun CoachAction(label: String, onClick: () -> Unit, primary: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp)
            .background(if (primary) colors.primary else colors.surfaceContainerHighest, RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(label, style = WindmillType.label, color = if (primary) colors.onPrimary else colors.onSurface)
    }
}

@Composable
internal fun CoachProposalCard(routine: String, summary: String, count: String, onReview: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier.fillMaxWidth().background(colors.surfaceContainer, RoundedCornerShape(20.dp)).padding(16.dp),
    ) {
        Text("Proposal · $routine", style = WindmillType.kicker, color = colors.onSurfaceVariant)
        Text(summary, style = GymType.proposalSummary, color = colors.onSurface)
        Text(count, style = WindmillType.supportingParagraph, color = colors.onSurfaceVariant)
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = onReview).padding(12.dp),
        ) { Text("Review", style = WindmillType.label, color = colors.onSurface) }
    }
}
