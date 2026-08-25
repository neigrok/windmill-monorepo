package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Against
import works.windmill.gym.domain.AgainstMovement
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Effort
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PersonalRecord
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.ReviewStats
import works.windmill.gym.domain.RoutineEntryWrite
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Everything here RENDERS the `Review` the domain computed and nothing here computes one.
object Finish {
    data class Head(val title: String, val subtitle: String, val at: String)

    data class Tile(val value: String, val label: String)

    data class Row(val id: String, val movement: String, val detail: String)

    data class Comparison(val title: String, val rows: List<Row>)

    fun head(startedAtMs: Long, finishedAtMs: Long, routine: String?, slight: Boolean, first: Boolean): Head =
        Head(
            title = if (slight) "Ended early" else "Session finished",
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
        return Comparison(
            title = "Against last ${against.routine ?: "time"}",
            rows = against.movements.map { movement ->
                Row(
                    id = movement.exerciseId,
                    movement = Readout.movement(movement.exerciseId, catalog),
                    detail = detail(movement),
                )
            },
        )
    }

    // Which reference the arrow points from: the PLAN when the session had one for that movement, and
    // last time when it did not. `now.sets` counts only the sets at the TOP LOAD, so reps are the only
    // axis this wire can be read short on.
    private fun detail(movement: AgainstMovement): String {
        val planned = movement.planned
        val sets = planned?.sets
        if (planned == null || sets == null) {
            val before = movement.before ?: return top(movement.now)
            return "${top(before)} → ${top(movement.now)}"
        }
        val target = planned.reps
        if (target != null && movement.now.reps < target &&
            (planned.weightKg == null || movement.now.weightKg <= planned.weightKg)
        ) {
            return "planned ${count(sets, target)} · did ${count(movement.now.sets, movement.now.reps)}"
        }
        return "${top(sets, planned.reps, planned.weightKg)} → ${top(movement.now)}"
    }

    private fun count(sets: Int, reps: Int?): String {
        if (reps == null) return "$sets × ${Readout.repTarget(null)}"
        return "$sets×$reps"
    }

    // Zero is not a load, it is the absence of one; a band-assisted −20 still reads its load.
    private fun top(sets: Int, reps: Int?, weightKg: Double?): String {
        if (weightKg == null || weightKg == 0.0) return count(sets, reps)
        return "${count(sets, reps)} @ ${Readout.weight(weightKg)}"
    }

    private fun top(effort: Effort): String = top(effort.sets, effort.reps, effort.weightKg)
}

// The sets travel with it because the log has let go of them by now.
data class FinishedSession(
    val session: Session,
    val sets: List<TrainingSet>,
    val review: Review?,
    val isFirst: Boolean,
) {
    val routine: String? get() = session.plan?.routine
    val slight: Boolean get() = review?.slight ?: false

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
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (review == null) {
            Text(
                "the log didn’t answer — the session is saved",
                style = GymType.numeral(13),
                color = GymSkin.inkFaint,
            )
            return@Column
        }
        Finish.recordSentence(review.record, catalog)?.let { RecordLine(it) }
        Finish.comparison(review.against, catalog)?.let { AgainstBlock(it) }
    }
}

@Composable
private fun Tiles(tiles: List<Finish.Tile>) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        tiles.forEach { tile ->
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    tile.value,
                    style = GymType.numeral(26, FontWeight.SemiBold),
                    color = GymSkin.ink,
                    maxLines = 1,
                )
                Text(tile.label, style = GymType.numeral(11), color = GymSkin.inkFaint)
            }
        }
    }
}

@Composable
private fun RecordLine(sentence: String) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.prSoft, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.prInk.copy(alpha = 0.35f), RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text("Personal record", style = GymType.numeral(11), color = GymSkin.prInk)
        Text(
            sentence,
            style = WindmillFont.body(16).copy(lineHeight = 23.sp),
            color = GymSkin.ink,
        )
    }
}

@Composable
private fun AgainstBlock(comparison: Finish.Comparison) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(comparison.title, style = GymType.numeral(11), color = GymSkin.inkFaint)
        comparison.rows.forEach { row ->
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    row.movement,
                    style = WindmillFont.body(15),
                    color = GymSkin.ink,
                    modifier = Modifier.alignByBaseline(),
                )
                Spacer(Modifier.weight(1f))
                Text(
                    row.detail,
                    style = GymType.numeral(13),
                    color = GymSkin.inkDim,
                    modifier = Modifier.alignByBaseline(),
                )
            }
        }
    }
}

@Composable
fun FinishScreen(
    finished: FinishedSession,
    catalog: List<Exercise>,
    kept: Boolean,
    coach: CoachDoors,
    onKeepRoutine: (String) -> Unit,
    onDiscard: () -> Unit,
    onDone: () -> Unit,
) {
    val head = Finish.head(
        startedAtMs = finished.session.startedAtMs,
        finishedAtMs = finished.session.finishedAtMs ?: finished.session.startedAtMs,
        routine = finished.routine,
        slight = finished.slight,
        first = finished.isFirst,
    )
    var routineName by remember(finished.session.id) {
        mutableStateOf(Readout.weekday(finished.session.startedAtMs))
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x12),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text(head.title, style = WindmillFont.display(30), color = GymSkin.ink)
            Text(head.subtitle, style = WindmillFont.body(17), color = GymSkin.inkDim)
            Text(head.at, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }

        ReviewReadout(finished.review, catalog)

        if (finished.offersRoutine && !kept) {
            KeepAsRoutine(finished, catalog, routineName, { routineName = it }, onKeepRoutine, onDone)
        }

        if (!finished.slight) {
            CoachShareCard(coach, finished.session.id)
        }

        Actions(finished, kept, onDiscard, onDone)
    }
}

@Composable
private fun KeepAsRoutine(
    finished: FinishedSession,
    catalog: List<Exercise>,
    name: String,
    onName: (String) -> Unit,
    onKeepRoutine: (String) -> Unit,
    onDone: () -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text("Keep this as a routine", style = WindmillFont.display(18), color = GymSkin.ink)

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum),
        ) {
            BasicTextField(
                value = name,
                onValueChange = onName,
                singleLine = true,
                textStyle = WindmillFont.body(17, FontWeight.SemiBold).copy(color = GymSkin.ink),
                cursorBrush = SolidColor(GymSkin.accent),
                modifier = Modifier.weight(1f),
            )
            Text("tap to rename", style = GymType.numeral(11), color = GymSkin.inkFaint)
        }

        val entries = RoutineWrite.from(name, SessionDetail(finished.session, finished.sets))?.entries
        entries.orEmpty().forEach { entry ->
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    Readout.movement(entry.exerciseId, catalog),
                    style = WindmillFont.body(15),
                    color = GymSkin.inkDim,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
                    style = GymType.numeral(13),
                    color = GymSkin.targetInk,
                )
            }
        }

        Text(
            "Today’s weights become next week’s targets.",
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = GymSkin.inkFaint,
        )

        PrimaryButton("Save routine", enabled = name.trim().isNotEmpty()) { onKeepRoutine(name) }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum + 6.dp)
                .clickable(onClick = onDone),
        ) {
            Text(
                "Just keep the session",
                style = WindmillFont.body(16, FontWeight.SemiBold),
                color = GymSkin.inkDim,
            )
        }
    }
}

// It deletes for good: nothing on this screen may suggest it can be got back, and the tap that does
// it is confirmed — there is no undo behind a discard.
@Composable
private fun Actions(finished: FinishedSession, kept: Boolean, onDiscard: () -> Unit, onDone: () -> Unit) {
    if (finished.slight) {
        var confirming by remember { mutableStateOf(false) }
        if (confirming) {
            ConfirmDialog(
                title = "Discard this session?",
                body = "Discarding deletes the session and its sets. There is no undoing it.",
                confirm = "Discard",
                destructive = true,
                onConfirm = {
                    confirming = false
                    onDiscard()
                },
                onKeep = { confirming = false },
            )
        }
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            PrimaryButton("Keep it", onClick = onDone)
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clickable { confirming = true },
            ) {
                Text(
                    "Discard session",
                    style = WindmillFont.body(16, FontWeight.SemiBold),
                    color = GymSkin.alarmInk,
                )
            }
        }
        return
    }
    if (!finished.offersRoutine || kept) {
        PrimaryButton("Done", onClick = onDone)
    }
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.primary)
            .alpha(if (enabled) 1f else 0.4f)
            .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
            .clickable(enabled = enabled, onClick = onClick),
    ) {
        Text(label, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
    }
}
