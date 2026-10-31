package works.windmill.gym.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetTarget
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.buildAnnotatedString
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Against
import works.windmill.gym.domain.AgainstMovement
import works.windmill.gym.domain.Effort
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PersonalRecord
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.sync.SessionReview
import works.windmill.gym.domain.TrainingSet
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Receipt totals come from committed sets; optional review adds the personal record.
object Finish {
    const val discard = "Discard session"

    fun day(atMs: Long): String = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.ENGLISH)
        .format(Instant.ofEpochMilli(atMs).atZone(ZoneId.systemDefault()))

    fun volume(value: Double?): String {
        if (value == null || !value.isFinite()) return "—"
        val compact = Readout.weight(value)
        if (compact.contains('e', ignoreCase = true)) return compact
        return DecimalFormat("#,##0.##", DecimalFormatSymbols(Locale.ENGLISH)).format(value)
    }

    data class Row(val id: String, val movement: String, val detail: String)

    data class Comparison(val title: String, val rows: List<Row>)

    // A kind this build has never heard of draws NOTHING; the slot is allowed to be empty.
    fun recordSentence(record: PersonalRecord?, catalog: List<Exercise>): String? {
        if (record == null) return null
        val movement = Readout.movement(record.exerciseId, catalog)
        val priorValue = if (record.kind == "e1rm") Readout.estimatedWeight(record.previous) else Readout.weight(record.previous)
        val past = "past $priorValue from ${Readout.day(record.previousAtMs)}"
        return when (record.kind) {
            "e1rm" -> "$movement e1RM ${Readout.estimatedWeight(record.value)} kg — $past."
            "heaviest" -> "$movement ${Readout.weight(record.value)} kg × ${record.reps} — $past."
            "reps-at-weight" -> "$movement ${record.reps} reps at ${Readout.weight(record.weightKg)} kg — $past."
            else -> null
        }
    }

    fun comparison(against: Against?, catalog: List<Exercise>): Comparison? {
        if (against == null) return null
        val sources = against.movements.map { movement ->
            when {
                movement.planned?.top != null -> "Plan"
                movement.before != null -> "Last time"
                else -> "Performed"
            }
        }
        val mixed = sources.distinct().size > 1
        val title = when (sources.distinct().singleOrNull()) {
            "Plan" -> "Against plan"
            "Last time" -> "Against last ${against.routine ?: "time"}"
            "Performed" -> "Performed"
            else -> "Comparison"
        }
        return Comparison(
            title = title,
            rows = against.movements.mapIndexed { index, movement ->
                Row(
                    id = movement.exerciseId,
                    movement = Readout.movement(movement.exerciseId, catalog),
                    detail = (if (mixed) "${sources[index]}: " else "") + detail(movement),
                )
            },
        )
    }

    // The top set determines the comparison; the performed summary includes every set.
    private fun detail(movement: AgainstMovement): String {
        val planned = movement.planned
        val top = planned?.top
        if (planned != null && top != null) {
            val short = top.reps != null && movement.now.reps < top.reps &&
                (top.weightKg == null || movement.now.weightKg <= top.weightKg)
            if (short) return "planned ${Readout.target(planned.sets)} — did ${effort(movement.now)}"
            return "${Readout.target(planned.sets)} → ${effort(movement.now)}"
        }
        val before = movement.before ?: return effort(movement.now)
        return "${effort(before)} → ${effort(movement.now)}"
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

object FinishCoach {
    const val action = "Share with Coach"
    const val question = "Check my last workout."
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
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (review == null) {
            Text(
                "the log didn’t answer — the session is saved",
                style = GymType.numeral(13),
                color = skin.inkDim,
            )
            return@Column
        }
        Finish.recordSentence(review.record, catalog)?.let { RecordLine(it) }
        Finish.comparison(review.against, catalog)?.let { AgainstBlock(it) }
    }
}

@Composable
private fun RecordLine(sentence: String) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(skin.prSoft, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, skin.prInk.copy(alpha = 0.35f), RoundedCornerShape(WindmillRadius.lg))
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text("Personal record", style = GymType.numeral(13).copy(lineHeight = 18.sp), color = skin.prInk)
        Text(
            sentence,
            style = WindmillFont.body(17).copy(lineHeight = 24.sp),
            color = skin.ink,
        )
    }
}

@Composable
private fun AgainstBlock(comparison: Finish.Comparison) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(comparison.title, style = GymType.numeral(11), color = skin.inkDim)
        comparison.rows.forEach { row ->
            ReceiptLine(row.movement, row.detail, skin.ink, skin.inkDim)
        }
    }
}

@Composable
fun FinishScreen(
    finished: FinishedSession,
    catalog: List<Exercise>,
    onShareWithCoach: (() -> Unit)? = null,
    onDone: () -> Unit = {},
    onDiscard: (() -> Unit)? = null,
    onKeep: (() -> Unit)? = null,
) {
    val skin = LocalGymColors.current
    if (finished.sets.isEmpty()) {
        val bottomPadding = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding().coerceAtLeast(24.dp)
        Column(Modifier.fillMaxWidth().heightIn(min = 344.dp)
            .padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = bottomPadding),
            verticalArrangement = Arrangement.SpaceBetween) {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("No sets logged", style = WindmillFont.display(22, FontWeight.ExtraBold).copy(lineHeight = 28.sp), color = skin.ink)
                Text("This workout has ended.", style = WindmillFont.body(16).copy(lineHeight = 23.sp), color = skin.inkDim)
            }
            ReceiptAction("Done", onDone)
        }
        return
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val requestedHeight = if (finished.slight) 465.dp else 815.dp
        val receiptHeight = requestedHeight.coerceAtMost(maxHeight)
        Column(Modifier.fillMaxWidth().height(receiptHeight).navigationBarsPadding()) {
            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp).padding(bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (finished.slight) "Ended early." else "Well done.",
                            style = WindmillFont.display(44, FontWeight.ExtraBold).copy(lineHeight = 52.sp),
                            color = skin.ink, modifier = Modifier.weight(1f))
                        onDiscard?.let { discard ->
                            var expanded by rememberSaveable { mutableStateOf(false) }
                            Box {
                                IconButton(onClick = { expanded = true }, modifier = Modifier.size(48.dp)) {
                                    Icon(painterResource(R.drawable.gym_more), contentDescription = "More", tint = skin.ink)
                                }
                                DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
                                    DropdownMenuItem(text = { Text("Discard") }, onClick = { expanded = false; discard() })
                                }
                            }
                        }
                    }
                    Text("${finished.routine ?: Readout.noRoutine} · ${Finish.day(finished.session.startedAtMs)}",
                        style = WindmillFont.body(18).copy(lineHeight = 24.sp), color = skin.inkDim)
                }
                val summary = SessionSummary(finished.session, finished.sets, catalog)
                val duration = ((finished.session.finishedAtMs ?: finished.session.startedAtMs) - finished.session.startedAtMs).coerceAtLeast(0)
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val facts: @Composable (Modifier) -> Unit = { modifier ->
                        ReceiptFact(Readout.duration(duration), "Duration", modifier)
                        ReceiptFact(summary.setCount.toString(), "Sets", modifier)
                        val volume = Finish.volume(summary.tonnageKg)
                        ReceiptFact(volume, "Volume", modifier, "kg".takeUnless { volume == "—" })
                    }
                    if (LocalDensity.current.fontScale > 1.3f || maxWidth < 270.dp) {
                        Column(Modifier.fillMaxWidth().background(skin.raised, RoundedCornerShape(20.dp))) {
                            facts(Modifier.fillMaxWidth())
                        }
                    } else {
                        Row(Modifier.fillMaxWidth().background(skin.raised, RoundedCornerShape(20.dp))) {
                            facts(Modifier.weight(1f))
                        }
                    }
                }
                onKeep?.let { keep ->
                    Text(buildAnnotatedString {
                        append("Only on this phone · ")
                        withStyle(SpanStyle(color = skin.accent, fontWeight = FontWeight.Bold)) { append("Keep it") }
                    }, style = WindmillFont.body(15).copy(lineHeight = 22.sp), color = skin.inkDim,
                        modifier = Modifier.heightIn(min = 48.dp).fillMaxWidth().clickable(role = Role.Button, onClick = keep))
                }
                if (onKeep == null && finished.reviewRead) {
                    Finish.recordSentence(finished.review?.record, catalog)?.let { RecordLine(it) }
                }
                Text("Performed", style = GymType.numeral(13).copy(lineHeight = 18.sp), color = skin.inkDim)
                summary.exercises.forEach { id ->
                    val sets = finished.sets.filter { it.exerciseId == id }
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Check, contentDescription = null, tint = skin.setDone, modifier = Modifier.size(24.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(Readout.movement(id, catalog), style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
                            Text(Readout.targetWithUnit(sets.map { SetTarget(it.reps, it.weightKg) }, catalog.find { it.id == id }),
                                style = GymType.numeral(15).copy(lineHeight = 20.sp), color = skin.inkDim)
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                onShareWithCoach?.let { ReceiptAction(FinishCoach.action, it, tonal = true, crown = true) }
                ReceiptAction("Done", onDone)
            }
        }
    }
}

@Composable
private fun ReceiptFact(value: String, label: String, modifier: Modifier, unit: String? = null) {
    val skin = LocalGymColors.current
    Column(modifier.padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(buildAnnotatedString {
            append(value)
            unit?.let { withStyle(SpanStyle(fontSize = 16.sp, fontWeight = FontWeight.Normal)) { append(" $it") } }
        }, style = WindmillFont.display(32, FontWeight.ExtraBold).copy(lineHeight = 40.sp), color = skin.ink)
        Text(label, style = WindmillFont.body(14).copy(lineHeight = 18.sp), color = skin.inkDim,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun ReceiptAction(label: String, onClick: () -> Unit, tonal: Boolean = false, crown: Boolean = false) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).background(if (tonal) skin.raised else skin.accent, RoundedCornerShape(16.dp))
        .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        if (crown) Image(painterResource(R.drawable.gym_coach_crown), contentDescription = null,
            contentScale = ContentScale.Fit, modifier = Modifier.size(24.dp))
        Text(label, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = if (tonal) skin.ink else skin.onAccent)
    }
}

@Composable
private fun ReceiptLine(name: String, detail: String, nameColor: androidx.compose.ui.graphics.Color, detailColor: androidx.compose.ui.graphics.Color) {
    val largeText = LocalDensity.current.fontScale > 1.3f
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (largeText || maxWidth < 360.dp || name.length > 22 || detail.length > 24) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(name, style = WindmillFont.body(15), color = nameColor, modifier = Modifier.fillMaxWidth())
                Text(detail, style = GymType.numeral(13), color = detailColor, modifier = Modifier.fillMaxWidth())
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = WindmillFont.body(15), color = nameColor, modifier = Modifier.weight(1f))
                Text(detail, style = GymType.numeral(13), color = detailColor)
            }
        }
    }
}
