package works.windmill.gym.ui

import androidx.activity.compose.BackHandler

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Ids
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
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.ReviewStats
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SetKind
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

    // What the receipt says once the log has taken the routine. The form is gone by then, so this is
    // the whole of the answer.
    fun keptAs(name: String) = "Kept as ${name.trim()}."

    data class Head(val title: String, val subtitle: String, val at: String)

    data class Tile(val value: String, val label: String)

    data class Row(val id: String, val movement: String, val detail: String)

    data class Comparison(val title: String, val rows: List<Row>)

    fun head(startedAtMs: Long, finishedAtMs: Long, routine: String?, slight: Boolean, first: Boolean): Head =
        Head(
            // A congratulation on two sets would be a small lie, so a slight session keeps its
            // plain title.
            title = if (slight) "Ended early." else "Well done.",
            subtitle = routine ?: if (first) "Your first session" else "No routine",
            at = "${Readout.day(startedAtMs)} · ${Readout.time(startedAtMs)} – ${Readout.time(finishedAtMs)}",
        )

    // A session with no LOADED working set has no honest one-rep estimate, so the tile says nothing
    // with a dash rather than printing a zero nobody lifted.
    fun tiles(stats: ReviewStats): List<Tile> = listOf(
        Tile(Readout.duration(stats.durationMs), "Duration"),
        Tile(stats.workingSets.toString(), "Working sets"),
        Tile(stats.topE1rm?.let(Readout::weight) ?: "—", "Top e1RM"),
    )

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
    // rule, and iOS's.
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
    val isFirst: Boolean,
    val routineCreationId: String = Ids.routine(),
    val routinePosition: Int = 0,
    val reviewRead: Boolean = true,
) {
    val routine: String? get() = session.plan?.routine
    val summary: SessionSummary get() = SessionSummary(session, sets)
    val slight: Boolean get() = (summary.workingSetCount ?: 0) < 4

    // Offered only for a session that had nothing written down for it, and never over a slight one.
    val offersRoutine: Boolean
        get() = !slight && session.routineId == null && sets.any { it.kind == SetKind.Working }
}

@Composable
fun ReviewReadout(review: Review?, catalog: List<Exercise>) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier.fillMaxWidth(),
    ) {
        review?.let { Tiles(Finish.tiles(it.stats)) }
        ReviewRemarks(review, catalog)
    }
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
private fun Tiles(tiles: List<Finish.Tile>) {
    val skin = LocalGymColors.current
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(skin.surface, RoundedCornerShape(WindmillRadius.lg))
            .padding(GymLayout.cardInset),
    ) {
        tiles.forEach { tile ->
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    tile.value,
                    style = GymType.numeral(26, FontWeight.SemiBold),
                    color = skin.ink,
                    maxLines = 1,
                )
                Text(tile.label, style = GymType.numeral(11), color = skin.inkDim)
            }
        }
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

// The body of the sheet the room presents over the session it just closed (16-the-workout). It owns
// its own scroll, because a sheet that cannot scroll cannot be finished, and its own refusal line,
// because a sheet covers the room's bottom bar. `failure` defaults to nothing so a caller that has
// no refusal to draw names none. `onShareWithCoach` is null where Coach cannot be reached — signed
// out, or a deployment without one — and then nothing stands in the primary's place. Every way out
// of the receipt is the sheet coming down: back, the scrim, or the handle.
@Composable
fun FinishScreen(
    finished: FinishedSession,
    catalog: List<Exercise>,
    keptName: String?,
    onKeepRoutine: (String) -> Unit,
    onShareWithCoach: (() -> Unit)? = null,
    failure: String? = null,
    pending: Boolean = false,
) {
    val skin = LocalGymColors.current
    BackHandler(enabled = pending) {}
    val head = Finish.head(
        startedAtMs = finished.session.startedAtMs,
        finishedAtMs = finished.session.finishedAtMs ?: finished.session.startedAtMs,
        routine = finished.routine,
        slight = finished.slight,
        first = finished.isFirst,
    )
    var routineName by rememberSaveable(finished.routineCreationId) {
        mutableStateOf(Readout.weekday(finished.session.startedAtMs))
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = GymLayout.gutter)
            .padding(bottom = GymLayout.sheetBottom),
    ) {
        // The title lives in the content and not in a bar above it: `Ended early.` is the whole of
        // what a slight session has to say, and a sheet has no top bar to say it from.
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text(head.title, style = WindmillFont.display(40, FontWeight.Bold).copy(lineHeight = 52.sp), color = skin.ink)
            Text("${finished.routine ?: "Free session"} · Workout saved", style = WindmillFont.body(16), color = skin.inkDim)
        }

        val summary = finished.summary
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
        onShareWithCoach?.let { ShareWithCoach(it, enabled = !pending) }

        if (!finished.offersRoutine) failure?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
        if (finished.offersRoutine) {
            // The keep is the one thing this receipt does that writes, so it is the one thing the
            // receipt owes an answer for. The form it stood in is gone by then and the room's own
            // line is behind the sheet, which leaves one sentence where the form was.
            if (keptName != null) {
                Text(
                    Finish.keptAs(keptName),
                    style = WindmillFont.body(16),
                    color = skin.inkDim,
                )
            } else {
                KeepAsRoutine(finished, catalog, routineName, { routineName = it }, onKeepRoutine, failure, pending)
            }
        }
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
private fun ShareWithCoach(onShareWithCoach: () -> Unit, enabled: Boolean) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.fillMaxWidth(),
    ) {
        PrimaryButton(FinishCoach.action, height = 64, enabled = enabled, onClick = onShareWithCoach)
        Text(
            FinishCoach.caption,
            style = WindmillFont.body(14).copy(lineHeight = 18.sp),
            color = skin.inkDim,
        )
    }
}

@Composable
private fun KeepAsRoutine(
    finished: FinishedSession,
    catalog: List<Exercise>,
    name: String,
    onName: (String) -> Unit,
    onKeepRoutine: (String) -> Unit,
    failure: String?,
    pending: Boolean,
) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth(),
    ) {
        Text("Save a routine", style = WindmillFont.display(22), color = skin.ink)

        PlanningNameField(name, onName, "Routine name", "Routine name", enabled = !pending)

        val entries = RoutineWrite.from(name, SessionDetail(finished.session, finished.sets))?.entries
        entries.orEmpty().forEach { entry ->
            ReceiptLine(Readout.movement(entry.exerciseId, catalog), Readout.targetWithUnit(entry.sets), skin.inkDim, skin.targetInk)
        }

        Text(
            "Today’s weights become next week’s targets.",
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = skin.inkDim,
        )

        val named = Program.nameProblem(name) == null
        PrimaryButton(if (pending) "Saving…" else "Save routine", enabled = named && !pending, tonal = true) { onKeepRoutine(name) }

        // ONE sentence under one grey button, drawn here because a sheet covers the room's bottom
        // bar, where every other refusal lands. An empty name is what holds the button NOW, so it
        // outranks what the log said about a keep the lifter has already read and moved on from.
        val missing = Program.nameProblem(name)
        (missing ?: failure)?.let {
            Text(
                it,
                style = GymType.numeral(12).copy(lineHeight = 18.sp),
                // The alarm ink is for a write that failed. An empty name is neither destructive nor
                // invalid — nothing was sent — so the unfinished form takes the faint ink.
                color = if (missing != null) skin.inkDim else skin.alarmInk,
            )
        }
    }
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean = true, height: Int = 56, tonal: Boolean = false, onClick: () -> Unit) {
    val skin = LocalGymColors.current
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = height.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .background(if (tonal) skin.raised else skin.accent, RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    ) {
        Text(label, style = WindmillFont.body(16, FontWeight.Bold), color = if (tonal) skin.ink else skin.onAccent)
    }
}
