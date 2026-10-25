package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetTarget
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
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
import works.windmill.gym.domain.TrainingSet
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Receipt totals come from committed sets; optional review adds comparisons.
object Finish {
    // The one act, said the same way at both of its doors — the log row's long press and the
    // session review screen. Read from here by each of them so two spellings of one act cannot
    // drift apart. The receipt draws no discard: being finished with it is the sheet coming down.
    const val discard = "Discard session"

    data class Row(val id: String, val movement: String, val detail: String)

    data class Comparison(val title: String, val rows: List<Row>)

    // A kind this build has never heard of draws NOTHING; the slot is allowed to be empty.
    fun recordSentence(record: PersonalRecord?, catalog: List<Exercise>): String? {
        if (record == null) return null
        val previous = record.previous ?: return null
        val previousAt = record.previousAtMs ?: return null
        val movement = Readout.movement(record.exerciseId, catalog)
        val past = "past ${Readout.weight(previous)} from ${Readout.day(previousAt)}"
        return when (record.kind) {
            "e1rm" -> "$movement e1RM ${Readout.weight(record.value)} kg — $past."
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

    // The plan reads in the readout formula and the effort — the top set and how many of them — in the
    // same shape. The top set stands against the plan's own top set, and `now.sets` counts only the
    // sets at the TOP LOAD, so short is read on reps alone, at a load that did not go up. An open line
    // is nothing to measure against, so the row falls through to last time. review.js `detailOf`'s
    // rule.
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

    // `{sets} × {reps} · {load}`, the scheme's own formula. Zero is the absence of a load, not a load,
    // so a bodyweight effort leaves the column out; a band-assisted −20 still reads its own.
    private fun effort(effort: Effort): String {
        val count = "${effort.sets} × ${effort.reps}"
        if (effort.weightKg == 0.0) return count
        return "$count · ${Readout.weight(effort.weightKg)}"
    }
}

// The receipt's one primary and the line under it. The question is the whole of what is sent: no
// session id rides with it, because Coach reads the log newest first and finds the workout itself.
object FinishCoach {
    const val action = "Share with Coach"
    const val caption = "Sends Coach one line — “Check my last session.” — and opens the answer."
    const val question = "Check my last session."
}

// The sets travel with it because the log has let go of them by now.
@Serializable
data class FinishedSession(
    val session: Session,
    val sets: List<TrainingSet>,
    val review: Review?,
    val reviewRead: Boolean = true,
) {
    val routine: String? get() = session.plan?.routine
    val slight: Boolean get() = sets.size < Review.slightSets
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
            .padding(GymLayout.cardInset),
    ) {
        Text("Personal record", style = GymType.numeral(11), color = skin.ink)
        Text(
            sentence,
            style = WindmillFont.body(16).copy(lineHeight = 23.sp),
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

// The receipt scrolls independently and offers Coach only when the account can reach it.
@Composable
fun FinishScreen(
    finished: FinishedSession,
    catalog: List<Exercise>,
    onShareWithCoach: (() -> Unit)? = null,
) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = GymLayout.gutter)
            .padding(bottom = GymLayout.sheetBottom),
    ) {
        // The title lives in the content and not in a bar above it: `Ended early.` is the whole of
        // what a slight session has to say, and a sheet has no top bar to say it from.
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text(if (finished.slight) "Ended early." else "Well done.",
                style = WindmillFont.display(40, FontWeight.Bold).copy(lineHeight = 52.sp), color = skin.ink)
            Text("${finished.routine ?: Readout.noRoutine} · Workout saved", style = WindmillFont.body(16), color = skin.inkDim)
        }

        val summary = SessionSummary(finished.session, finished.sets, catalog)
        val facts = listOf(summary.setCount.toString() to "Sets",
            Readout.weight(summary.tonnageKg ?: 0.0) to "kg lifted",
            summary.exercises.size.toString() to "Movements")
        val largeText = LocalDensity.current.fontScale > 1.3f
        BoxWithConstraints(Modifier.fillMaxWidth().background(skin.raised, RoundedCornerShape(16.dp)).padding(12.dp)) {
            if (largeText || maxWidth < 270.dp) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    facts.forEach { (value, label) -> ReceiptFact(value, label, Modifier.fillMaxWidth()) }
                }
            } else {
                Row(Modifier.fillMaxWidth().heightIn(min = 60.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    facts.forEach { (value, label) -> ReceiptFact(value, label, Modifier.weight(1f)) }
                }
            }
        }
        summary.exercises.forEach { id ->
            val sets = finished.sets.filter { it.exerciseId == id }
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("✓", style = WindmillFont.body(20), color = skin.setDone)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(Readout.movement(id, catalog), style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                    Text(Readout.targetWithUnit(sets.map { SetTarget(it.reps, it.weightKg) }), style = GymType.numeral(13), color = skin.inkDim)
                }
            }
        }
        if (finished.reviewRead) ReviewRemarks(finished.review, catalog)

        // Drawn on the slight branch too: a short session is exactly the one worth a second opinion.
        onShareWithCoach?.let { ShareWithCoach(it) }
    }
}

// The one full-strength button on the receipt, and one sentence under it saying exactly what the
// tap sends. The link card is NOT here: two share verbs on one receipt are two meanings, and the
// link keeps its doors on the session page and the log row.
@Composable
private fun ReceiptFact(value: String, label: String, modifier: Modifier) {
    val skin = LocalGymColors.current
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(value, maxLines = 1, autoSize = TextAutoSize.StepBased(minFontSize = 18.sp, maxFontSize = 28.sp),
            style = WindmillFont.display(28, FontWeight.Bold).copy(color = skin.ink))
        Text(label, style = WindmillFont.body(12), color = skin.inkDim, maxLines = 1,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
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

@Composable
private fun ShareWithCoach(onShareWithCoach: () -> Unit) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .background(skin.accent, RoundedCornerShape(16.dp))
                .clickable(role = Role.Button, onClick = onShareWithCoach),
        ) {
            Text(FinishCoach.action, style = WindmillFont.body(16, FontWeight.Bold), color = skin.onAccent)
        }
        Text(
            FinishCoach.caption,
            style = WindmillFont.body(14).copy(lineHeight = 18.sp),
            color = skin.inkDim,
        )
    }
}
