package works.windmill.gym.ui

import works.windmill.platform.R as PlatformR
import works.windmill.platform.design.WindmillType
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.serialization.Serializable
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.SetTarget
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import works.windmill.gym.R
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.testTag
import works.windmill.gym.presentation.Against
import works.windmill.gym.presentation.AgainstMovement
import works.windmill.gym.presentation.Effort
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.PersonalRecord
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Review
import works.windmill.gym.presentation.Session
import works.windmill.gym.domain.sync.SessionReview
import works.windmill.gym.presentation.TrainingSet
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text

// Receipt totals come from committed sets; optional review adds the personal record.
object Finish {
    fun day(atMs: Long): String = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.ENGLISH)
        .format(Instant.ofEpochMilli(atMs).atZone(ZoneId.systemDefault()))

    fun volume(value: Double?): String {
        if (value == null || !value.isFinite()) return "—"
        val compact = Readout.weight(value)
        if (compact.contains('e', ignoreCase = true)) return compact
        return DecimalFormat("#,##0.##", DecimalFormatSymbols(Locale.ENGLISH)).format(value)
    }

    data class Row(val id: String, val movement: String, val said: Words)

    data class Comparison(val named: Words, val rows: List<Row>)

    // A kind this build has never heard of draws NOTHING; the slot is allowed to be empty.
    fun recordWords(record: PersonalRecord?, catalog: List<Exercise>): Words? {
        if (record == null) return null
        val movement = Readout.movement(record.exerciseId, catalog)
        val priorValue = if (record.kind == "e1rm") Readout.estimatedWeight(record.previous) else Readout.weight(record.previous)
        val past = Readout.day(record.previousAtMs)
        return when (record.kind) {
            "e1rm" -> Words.Message(R.string.gym_finish_record_e1rm, listOf(movement, Readout.estimatedWeight(record.value), priorValue, past))
            "heaviest" -> Words.Message(R.string.gym_finish_record_heaviest, listOf(movement, Readout.weight(record.value), record.reps.toString(), priorValue, past))
            "reps-at-weight" -> Words.Message(R.string.gym_finish_record_reps_at_weight, listOf(movement, record.reps.toString(), Readout.weight(record.weightKg), priorValue, past))
            else -> null
        }
    }

    fun comparison(against: Against?, catalog: List<Exercise>): Comparison? {
        if (against == null) return null
        val sources = against.movements.map { movement ->
            when {
                movement.planned?.top != null -> R.string.gym_finish_source_plan
                movement.before != null -> R.string.gym_finish_source_last_time
                else -> R.string.gym_finish_performed
            }
        }
        val mixed = sources.distinct().size > 1
        val named = when (sources.distinct().singleOrNull()) {
            R.string.gym_finish_source_plan -> Words.Message(R.string.gym_finish_against_plan)
            R.string.gym_finish_source_last_time -> against.routine?.let { Words.Message(R.string.gym_finish_against_last, listOf(it)) }
                ?: Words.Message(R.string.gym_finish_against_last_time)
            R.string.gym_finish_performed -> Words.Message(R.string.gym_finish_performed)
            else -> Words.Message(R.string.gym_finish_comparison)
        }
        return Comparison(
            named = named,
            rows = against.movements.mapIndexed { index, movement ->
                Row(
                    id = movement.exerciseId,
                    movement = Readout.movement(movement.exerciseId, catalog),
                    said = if (mixed) Words.Message(R.string.gym_finish_sourced, listOf(Words.Message(sources[index]), compared(movement))) else compared(movement),
                )
            },
        )
    }

    // The top set determines the comparison; the performed summary includes every set.
    private fun compared(movement: AgainstMovement): Words {
        val planned = movement.planned
        val top = planned?.top
        if (planned != null && top != null) {
            val short = top.reps != null && movement.now.reps < top.reps &&
                (top.weightKg == null || movement.now.weightKg <= top.weightKg)
            if (short) return Words.Message(R.string.gym_finish_planned_short, listOf(Readout.scheme(planned.sets), effort(movement.now)))
            return Words.Message(R.string.gym_finish_moved, listOf(Readout.scheme(planned.sets), effort(movement.now)))
        }
        val before = movement.before ?: return Words.Plain(effort(movement.now))
        return Words.Message(R.string.gym_finish_moved, listOf(effort(before), effort(movement.now)))
    }

    // `{sets} × {reps} · {load}`: zero added load reads as bodyweight; a band-assisted −20 keeps its load.
    private fun effort(effort: Effort): String {
        val reps = if (effort.minReps == effort.maxReps) "${effort.minReps}" else "${effort.minReps}–${effort.maxReps}"
        val count = "${effort.sets} × $reps"
        if (effort.minWeightKg == 0.0 && effort.weightKg == 0.0) return count
        val load = if (effort.minWeightKg == effort.weightKg) Readout.weight(effort.weightKg)
            else "${Readout.weight(effort.minWeightKg)}–${Readout.weight(effort.weightKg)}"
        return "$count · $load"
    }
}

// The sets travel with it because the log has let go of them by now.
@Serializable
data class FinishedSession(
    val session: Session,
    val sets: List<TrainingSet>,
    val review: Review?,
    val reviewRead: Boolean = true,
    val suggestsKeep: Boolean = false,
) {
    val routine: String? get() = session.plan?.routine
    val slight: Boolean get() = sets.size < SessionReview.slightSets
}

@Composable
fun ReviewRemarks(review: Review?, catalog: List<Exercise>) {
    val colors = MaterialTheme.colorScheme
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (review == null) {
            Text(
                stringResource(R.string.gym_finish_review_no_answer),
                style = GymType.numeral,
                color = colors.onSurfaceVariant,
            )
            return@Column
        }
        Finish.recordWords(review.record, catalog)?.let { RecordLine(it.text()) }
        Finish.comparison(review.against, catalog)?.let { AgainstBlock(it) }
    }
}

@Composable
private fun RecordLine(sentence: String) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(gymColors.prSoft, MaterialTheme.shapes.large)
            .border(1.dp, gymColors.prInk.copy(alpha = 0.35f), MaterialTheme.shapes.large)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text(stringResource(R.string.gym_finish_personal_record), style = GymType.numeralDetail, color = gymColors.prInk)
        Text(
            sentence,
            style = GymType.finishSentence,
            color = colors.onSurface,
        )
    }
}

@Composable
private fun AgainstBlock(comparison: Finish.Comparison) {
    val colors = MaterialTheme.colorScheme
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(comparison.named.text(), style = GymType.numeralTiny, color = colors.onSurfaceVariant)
        comparison.rows.forEach { row ->
            ReceiptLine(row.movement, row.said.text())
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FinishScreen(
    finished: FinishedSession,
    catalog: List<Exercise>,
    onShareWithCoach: (() -> Unit)? = null,
    onDone: () -> Unit = {},
    onDiscard: (() -> Unit)? = null,
    onKeep: (() -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    if (finished.sets.isEmpty()) {
        val bottomPadding = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding().coerceAtLeast(24.dp)
        Column(Modifier.fillMaxWidth().heightIn(min = 344.dp)
            .padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = bottomPadding),
            verticalArrangement = Arrangement.SpaceBetween) {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(stringResource(R.string.gym_finish_no_sets), style = WindmillType.outcomeTitle, color = colors.onSurface)
                Text(stringResource(R.string.gym_finish_ended), style = GymType.emptyFinishLine, color = colors.onSurfaceVariant)
            }
            ReceiptAction(stringResource(PlatformR.string.platform_done), onDone)
        }
        return
    }
    // At large text the receipt opens the whole sheet; otherwise it stands at its board height and grows to hold every
    // fact. Either way the body scrolls under the pinned actions.
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val largeText = GymTextScale.large
        val floor = if (largeText) maxHeight else (if (finished.slight) 465.dp else 815.dp).coerceAtMost(maxHeight)
        Column(Modifier.fillMaxWidth().heightIn(min = floor, max = maxHeight).navigationBarsPadding().testTag("Finish receipt"),
            verticalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(if (finished.slight) R.string.gym_finish_ended_early else R.string.gym_finish_well_done),
                            style = GymType.finishHeadline,
                            color = colors.onSurface, modifier = Modifier.weight(1f))
                        onDiscard?.let { discard ->
                            var expanded by rememberSaveable { mutableStateOf(false) }
                            Box {
                                IconButton(onClick = { expanded = true }, modifier = Modifier.size(48.dp)) {
                                    Icon(painterResource(R.drawable.gym_more), contentDescription = stringResource(PlatformR.string.platform_more), tint = colors.onSurface)
                                }
                                DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
                                    DropdownMenuItem(text = { Text(stringResource(PlatformR.string.platform_discard)) }, onClick = { expanded = false; discard() })
                                }
                            }
                        }
                    }
                    Text(Words.Message(R.string.gym_finish_subhead, listOf(finished.routine?.let(Words::Plain) ?: Readout.freeWorkout, Finish.day(finished.session.startedAtMs))).text(),
                        style = GymType.finishSubhead, color = colors.onSurfaceVariant)
                }
                val summary = SessionSummary(finished.session, finished.sets, catalog)
                val duration = ((finished.session.finishedAtMs ?: finished.session.startedAtMs) - finished.session.startedAtMs).coerceAtLeast(0)
                // The three facts share one row, or wrap two to a row where large text or a narrow sheet leaves no room.
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val facts: @Composable (Modifier) -> Unit = { modifier ->
                        ReceiptFact(Readout.lasted(duration).text(), stringResource(R.string.gym_finish_duration), modifier)
                        ReceiptFact(summary.setCount.toString(), stringResource(R.string.gym_finish_sets), modifier)
                        val volume = Finish.volume(summary.tonnageKg)
                        ReceiptFact(volume, stringResource(R.string.gym_finish_volume), modifier, stringResource(R.string.gym_finish_volume_unit).takeUnless { volume == "—" })
                    }
                    val tiles = Modifier.fillMaxWidth().background(colors.surfaceContainerHighest, MaterialTheme.shapes.large)
                    if (largeText || maxWidth < 270.dp) {
                        FlowRow(tiles.padding(vertical = 16.dp), maxItemsInEachRow = 2,
                            verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            facts(Modifier.fillMaxWidth(0.5f))
                        }
                    } else {
                        Row(tiles) { facts(Modifier.weight(1f).padding(vertical = 16.dp)) }
                    }
                }
                onKeep?.let { keep ->
                    val keepIt = stringResource(PlatformR.string.platform_keep_it)
                    val onlyHere = stringResource(R.string.gym_finish_only_on_this_phone, keepIt)
                    Text(buildAnnotatedString {
                        append(onlyHere)
                        val at = onlyHere.lastIndexOf(keepIt)
                        if (at >= 0) addStyle(SpanStyle(color = colors.primary, fontWeight = FontWeight.Bold), at, at + keepIt.length)
                    }, style = WindmillType.paragraphSmall, color = colors.onSurfaceVariant,
                        modifier = Modifier.heightIn(min = 48.dp).fillMaxWidth().clickable(role = Role.Button, onClick = keep))
                }
                if (onKeep == null && finished.reviewRead) {
                    Finish.recordWords(finished.review?.record, catalog)?.let { RecordLine(it.text()) }
                }
                Text(stringResource(R.string.gym_finish_performed), style = GymType.numeralDetail, color = colors.onSurfaceVariant,
                    modifier = Modifier.semantics { heading() })
                summary.exercises.forEach { id ->
                    val sets = finished.sets.filter { it.exerciseId == id }
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Check, contentDescription = null, tint = colors.tertiary, modifier = Modifier.size(24.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(Readout.movement(id, catalog), style = GymType.heading, color = colors.onSurface)
                            Text(Readout.scheme(sets.map { SetTarget(it.reps, it.weightKg) }, catalog.find { it.id == id }).text(),
                                style = GymType.numeralReadout, color = colors.onSurfaceVariant)
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                onShareWithCoach?.let { ReceiptAction(stringResource(R.string.gym_finish_share_with_coach), it, tonal = true, crown = true) }
                ReceiptAction(stringResource(PlatformR.string.platform_done), onDone)
            }
        }
    }
}

// The value keeps one line, shrinking where a half-width tile at large text cannot hold it. A value too wide even at
// the 16 sp floor stays at the floor and wraps at the space before its unit, so the number itself keeps one line
// wherever one line can hold it.
@Composable
private fun ReceiptFact(value: String, label: String, modifier: Modifier, unit: String? = null) {
    val colors = MaterialTheme.colorScheme
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val text = buildAnnotatedString {
            append(value)
            unit?.let { withStyle(GymType.finishStatUnit) { append(" $it") } }
        }
        val style = GymType.finishStat.copy(color = colors.onSurface)
        val floor = GymType.finishStatFloor.copy(color = colors.onSurface)
        val measurer = rememberTextMeasurer()
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val oneLine = !measurer.measure(text, floor, maxLines = 1,
                constraints = Constraints(maxWidth = constraints.maxWidth)).hasVisualOverflow
            if (oneLine) BasicText(text, Modifier.fillMaxWidth(), style, maxLines = 1,
                autoSize = GymType.finishStatFit)
            else BasicText(text, Modifier.fillMaxWidth(), floor)
        }
        Text(label, style = GymType.supportingTight, color = colors.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

// 03.36: the label keeps one line, centred, and at large text may run into the side padding rather than wrap.
@Composable
private fun ReceiptAction(label: String, onClick: () -> Unit, tonal: Boolean = false, crown: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    val modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.primary)
    val padding = PaddingValues(horizontal = 24.dp, vertical = 12.dp)
    val content: @Composable RowScope.() -> Unit = {
        Row(Modifier.wrapContentWidth(unbounded = true), verticalAlignment = Alignment.CenterVertically) {
            if (crown) {
                Image(painterResource(R.drawable.gym_coach_crown), contentDescription = null,
                    contentScale = ContentScale.Fit, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(ButtonDefaults.IconSpacing))
            }
            Text(label, style = GymType.actionLabel)
        }
    }
    if (tonal) FilledTonalButton(onClick, modifier, contentPadding = padding, content = content,
        colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface))
    else Button(onClick, modifier, contentPadding = padding, content = content,
        colors = ButtonDefaults.buttonColors(containerColor = colors.primary, contentColor = colors.onPrimary))
}

@Composable
private fun ReceiptLine(name: String, detail: String) {
    val colors = MaterialTheme.colorScheme
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (GymTextScale.large || maxWidth < 360.dp || name.length > 22 || detail.length > 24) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(name, style = GymType.performedName, color = colors.onSurface, modifier = Modifier.fillMaxWidth())
                Text(detail, style = GymType.numeral, color = colors.onSurfaceVariant, modifier = Modifier.fillMaxWidth())
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = GymType.performedName, color = colors.onSurface, modifier = Modifier.weight(1f))
                Text(detail, style = GymType.numeral, color = colors.onSurfaceVariant)
            }
        }
    }
}
