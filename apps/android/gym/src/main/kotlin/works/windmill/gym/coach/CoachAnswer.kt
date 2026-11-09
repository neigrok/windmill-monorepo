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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import works.windmill.platform.i18n.text
import works.windmill.platform.i18n.pluralString
import androidx.compose.ui.semantics.Role
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
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Readout
import works.windmill.gym.ui.GymType
import works.windmill.platform.design.WindmillType
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.telemetry.coachAction
import androidx.compose.foundation.shape.CircleShape

// An answer: its words as they stand, the step line while it works, what it wrote, how the turn ended when it ended short, and what it read. `onSignIn` is the door under an answer a call needed the account for; `onKeep` the one under the routines a signed-out turn created. A retained answer says what it read only where `saysWhatItRead`. `withDetails` fills What Coach read's rows when its sheet opens.
@Composable
internal fun CoachAnswer(
    text: String,
    reply: CoachReply,
    catalog: List<Exercise>,
    onOpenRoutine: ((String) -> Unit)? = null,
    routineDrafts: List<CoachRoutineDraft> = emptyList(),
    onSaveDrafts: (suspend () -> DraftOutcome)? = null,
    onSignIn: (() -> Unit)? = null,
    onKeep: (() -> Unit)? = null,
    saysWhatItRead: Boolean = true,
    withDetails: suspend (List<CoachCall>) -> List<CoachCall> = { it },
    onSourcesTop: (Int?) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val copyMenu = remember { CoachCopyMenu() }
    val ended = reply.state.isTerminal
    val ending = Ask.ending(reply.state, reply.truncated, wordsArrived = reply.text.isNotBlank())
    val seatDoor = onSignIn.takeIf { ended && reply.calls.any { it.seatRefused } }
    val readLine = reply.readLine.takeIf { ended && saysWhatItRead }
    val wrote = routineDrafts.isNotEmpty() || reply.routines.isNotEmpty() || reply.savedNotes.isNotEmpty() || reply.madeMovements.isNotEmpty()
    // With nothing between them, what it read stands right under its words.
    val readUnderWords = readLine.takeIf { ending == null && !wrote && seatDoor == null }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        if (!ended || text.isNotEmpty() || reply.text.isNotEmpty() || readUnderWords != null) Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.fillMaxWidth()) {
            if (!ended && !reply.elsewhere && text.isEmpty()) CoachTyping()
            CoachText(text, reply.text, copyMenu)
            if (reply.elsewhere) AnsweringElsewhere()
            else if (!ended) reply.stepLine?.let { CoachLine(it, "coach-step-line") }
            readUnderWords?.let { CoachReadSources(it.text(), reply.readRows, withDetails, onSourcesTop) }
        }
        seatDoor?.let { CoachAction(stringResource(R.string.gym_coach_sign_in), it, primary = true) }
        if (routineDrafts.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(24.dp), modifier = Modifier.padding(top = 12.dp).fillMaxWidth()) {
            routineDrafts.forEachIndexed { index, draft ->
                key(draft.operationId) {
                    val scope = rememberCoroutineScope()
                    var busy by remember { mutableStateOf(false) }
                    var note by remember { mutableStateOf<Int?>(null) }
                    var closed by remember { mutableStateOf(false) }
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp).background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(16.dp)) {
                        Text(stringResource(R.string.gym_coach_review_routine), style = WindmillType.supporting, color = colors.onSurfaceVariant)
                        Text(draft.name, style = GymType.cardTitle, color = colors.onSurface)
                        draft.entries.forEach { entry ->
                            val exercise = catalog.firstOrNull { it.id == entry.exerciseId }
                            val equipment = when (exercise?.equipment) {
                                "bodyweight" -> stringResource(R.string.gym_coach_draft_bodyweight)
                                "dumbbell" -> stringResource(if (exercise.loadCount == 1) R.string.gym_coach_draft_one_dumbbell else R.string.gym_coach_draft_two_dumbbells)
                                "barbell" -> stringResource(R.string.gym_coach_draft_barbell)
                                "machine" -> stringResource(R.string.gym_coach_draft_machine)
                                "other" -> stringResource(R.string.gym_coach_draft_other)
                                null -> stringResource(R.string.gym_coach_draft_no_equipment)
                                else -> exercise.equipment.replaceFirstChar { it.uppercase() }
                            }
                            val loads = when (exercise?.equipment) {
                                "dumbbell" -> if (exercise.loadCount == 1) R.string.gym_coach_draft_kg else R.string.gym_coach_draft_kg_each
                                "bodyweight" -> if (entry.sets.any { (it.weightKg ?: 0.0) < 0 }) R.string.gym_coach_draft_kg_assisted else R.string.gym_coach_draft_kg_added
                                "barbell" -> R.string.gym_coach_draft_kg_total
                                else -> R.string.gym_coach_draft_kg
                            }
                            val scheme = if (entry.sets.any { it.weightKg != null }) stringResource(loads, Readout.scheme(entry.sets).text()) else Readout.scheme(entry.sets).text()
                            val line = entry.restSeconds?.let { stringResource(R.string.gym_coach_draft_line_rest, scheme, equipment, it.toString()) }
                                ?: stringResource(R.string.gym_coach_draft_line, scheme, equipment)
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(Readout.movement(entry.exerciseId, catalog), style = WindmillType.label, color = colors.onSurface)
                                Text(line, style = WindmillType.supporting, color = colors.onSurfaceVariant)
                            }
                        }
                        note?.let { Text(stringResource(it), style = WindmillType.supporting, color = colors.onSurfaceVariant) }
                        // One answer's drafts are one save: the door stands under the last of them.
                        if (!closed && index == routineDrafts.lastIndex) CoachAction(stringResource(if (busy) R.string.gym_coach_saving else R.string.gym_coach_save_routine), primary = true, enabled = !busy && onSaveDrafts != null, onClick = {
                            if (!busy && onSaveDrafts != null) {
                                busy = true
                                note = null
                                scope.launch {
                                    try {
                                        when (val saved = onSaveDrafts()) {
                                            DraftOutcome.Saved -> Unit
                                            is DraftOutcome.Closed -> { note = saved.sentence; closed = true }
                                            is DraftOutcome.Failed -> note = saved.sentence
                                        }
                                    } finally { busy = false }
                                }
                            }
                        })
                    }
                }
            }
        }
        if (reply.routines.isNotEmpty()) {
            CreatedRoutines(reply.routines, onOpenRoutine)
            onKeep?.let { KeepRoutines(it) }
        }
        reply.savedNotes.forEach { note -> key(note.id) { SavedNoteCard(note) } }
        reply.madeMovements.forEach { movement -> key(movement.id) { MadeMovementCard(movement) } }
        if (readUnderWords == null && (ending != null || readLine != null)) Column(Modifier.fillMaxWidth()) {
            ending?.let { CoachLine(stringResource(it), "coach-ending") }
            readLine?.let { CoachReadSources(it.text(), reply.readRows, withDetails, onSourcesTop) }
        }
    }
}

// A line under an answer, on the receipt's margin: the step line and how the turn ended. It stands over the receipt, whose touch reaches up across it and would hide it from the accessibility tree.
@Composable
private fun CoachLine(said: String, tag: String) {
    Text(said, style = GymType.coachSourceLine, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.zIndex(1f).padding(start = 12.dp, top = 4.dp).testTag(tag))
}

// A running answer another device writes (Coach §4.5).
@Composable
private fun AnsweringElsewhere() {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    LaunchedEffect(Unit) { telemetry.coachAction("answering_elsewhere") }
    Row(Modifier.fillMaxWidth().testTag("coach-answering-elsewhere"), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(R.drawable.gym_coach_phone), null, Modifier.size(18.dp), tint = colors.onSurfaceVariant)
        Text(stringResource(R.string.gym_coach_answering_elsewhere), style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
    }
}

// One receipt per routine a turn created, each a door to its summary.
@Composable
private fun CreatedRoutines(routines: List<CreatedRoutine>, onOpen: ((String) -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(vertical = 8.dp)) {
        routines.forEach { routine ->
            key(routine.id) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)
                        .clickable(enabled = onOpen != null, role = Role.Button, onClickLabel = stringResource(R.string.gym_coach_open_routine)) { onOpen?.invoke(routine.id) }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Icon(painterResource(R.drawable.gym_coach_check), null, Modifier.size(20.dp), tint = colors.primary)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(routine.name, style = GymType.coachReceiptTitle, color = colors.onSurface)
                        Text(pluralString(R.plurals.gym_coach_routine_created, routine.movements, routine.movements.toString()), style = GymType.coachDetail, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun KeepRoutines(onKeep: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.gym_coach_only_on_this_phone), style = GymType.coachSupporting, color = colors.onSurfaceVariant)
        TextButton(onClick = onKeep, modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
            Text(stringResource(R.string.gym_coach_keep_it), style = GymType.coachAction, color = colors.primary)
        }
    }
}

// What Coach wrote besides answering: what it did, a hairline, and the record it wrote. `outlined` draws the card's edge.
@Composable
private fun WriteCard(did: String, outlined: Boolean, record: @Composable () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.large
    Column(verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().background(colors.surfaceContainer, shape).then(if (outlined) Modifier.border(1.dp, colors.outline, shape) else Modifier).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Icon(painterResource(R.drawable.gym_coach_check), null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
            Text(did, style = GymType.coachSourceTitle, color = colors.onSurfaceVariant)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.outlineVariant))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) { record() }
    }
}

@Composable
private fun WriteBadge(icon: Int, said: String) {
    val colors = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(painterResource(icon), null, Modifier.size(18.dp), tint = colors.primary)
        Text(said, style = GymType.coachStrong, color = colors.primary)
    }
}

@Composable
private fun SavedNoteCard(note: SavedNote) {
    WriteCard(stringResource(R.string.gym_coach_saved_note), outlined = false) {
        WriteBadge(R.drawable.gym_coach_note, stringResource(R.string.gym_coach_note))
        Text(note.text, style = GymType.coachParagraph, color = MaterialTheme.colorScheme.onSurface)
    }
}

// A movement Coach made: the movement as one Added change, every value new.
@Composable
private fun MadeMovementCard(movement: MadeMovement) {
    WriteCard(stringResource(R.string.gym_coach_made_movement), outlined = true) {
        WriteBadge(R.drawable.gym_native_add, stringResource(R.string.gym_coach_added))
        Text(movement.name, style = GymType.coachHeading, color = MaterialTheme.colorScheme.onSurface)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            MadeField(stringResource(R.string.gym_coach_movement_name), movement.name)
            MadeField(stringResource(R.string.gym_coach_movement_equipment), movement.equipment.text())
            MadeField(stringResource(R.string.gym_coach_movement_step), stringResource(R.string.gym_coach_movement_step_kg, Readout.weight(movement.stepKg)))
        }
    }
}

@Composable
private fun MadeField(label: String, value: String) {
    val colors = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = GymType.coachParagraph, color = colors.onSurfaceVariant, modifier = Modifier.widthIn(min = 72.dp))
        Text(value, style = GymType.button, color = colors.onSurface)
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
            Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).border(1.dp, colors.outlineVariant, MaterialTheme.shapes.medium)
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
            modifier = slot.background(colors.surfaceContainer, MaterialTheme.shapes.medium).padding(12.dp),
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
        telemetry.coachAction("open_link", outcome)
    }
}

@Composable
internal fun CoachAction(label: String, onClick: () -> Unit, primary: Boolean = false, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp)
            .clip(CircleShape).background(if (primary) colors.primary else colors.surfaceContainerHighest)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(label, style = WindmillType.label, color = if (primary) colors.onPrimary else colors.onSurface)
    }
}
