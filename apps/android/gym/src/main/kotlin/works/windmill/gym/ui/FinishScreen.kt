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
import androidx.compose.ui.text.style.TextAlign
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

// THE END OF A SESSION — three facts, at most one line of meaning, and the movement-by-movement
// comparison under it. Everything here RENDERS the `Review` the domain computed and nothing here
// computes one: no e1RM, no record decision, no matching of one session against another. A second
// opinion drawn on the phone would be the product arguing with itself in its own loudest pixel.
//
// THE EMPTY SLOT IS A DECISION. On the ~190 sessions in 200 that earn nothing the record line is
// simply absent and nothing takes its place: no encouragement, no streak, no score. The comparison
// is a fact with a DIRECTION and never a grade, which is why nothing in it is a percentage and
// nothing in it is coloured.
//
// The one thing under the review is the coach share, and it is not a share SHEET: no social
// targets, no image, nothing discoverable. It mints one revocable, expiring link to this one
// workout. It is not drawn over a session that ended early — screen 11's question there is
// keep-or-discard, and a second offer beside a delete button competes with it.
//
// The native twin of web/src/products/gym/review.js.
object Finish {
    data class Head(val title: String, val subtitle: String, val at: String)

    data class Tile(val value: String, val label: String)

    data class Row(val id: String, val movement: String, val detail: String)

    data class Comparison(val title: String, val rows: List<Row>)

    // A short session is not a failure and is not congratulated either — it is asked about, and the
    // word above it is the only thing that changes. Whether one came before it is a question about
    // the LOG, not about this session, which is why `first` is handed in.
    fun head(startedAtMs: Long, finishedAtMs: Long, routine: String?, slight: Boolean, first: Boolean): Head =
        Head(
            title = if (slight) "Ended early" else "Session finished",
            subtitle = routine ?: if (first) "Your first session" else "No routine",
            at = "${Readout.day(startedAtMs)} · ${Readout.time(startedAtMs)} – ${Readout.time(finishedAtMs)}",
        )

    // A session with no LOADED working set has no honest one-rep estimate — a chin-up at zero and a
    // band-assisted pull-up at −20 have none — so the tile says nothing with a dash rather than
    // printing a zero nobody lifted.
    fun tiles(stats: ReviewStats): List<Tile> = listOf(
        Tile(Readout.duration(stats.durationMs), "Duration"),
        Tile(stats.workingSets.toString(), "Working sets"),
        Tile(stats.topE1rm?.let(Readout::weight) ?: "—", "Top e1RM"),
    )

    // The rare loud line. The mark that was passed is named beside the one that passed it, because
    // a record with nothing to compare against is a first entry, and a first entry is not a record.
    //
    // A kind this build has never heard of draws NOTHING. The slot is allowed to be empty, and a
    // sentence assembled out of a rule we do not know is the one thing it may not hold.
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

    // "Against last Legs" — the same routine, the last time it ran, in the order this session
    // performed its movements.
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

    // Which reference the arrow points from: the PLAN when the session had one for that movement,
    // and last time when it did not — the plan is what the lifter agreed to and the log is what
    // happened. The one row that is not an arrow is the one that fell short: "planned 3×12 · did
    // 3×10" says the thing an arrow cannot.
    //
    // WHAT MAY BE CALLED SHORT is narrow, and it is review.js `detailOf`'s predicate exactly.
    // `now.sets` is not what a reader assumes: it counts only the sets at the TOP LOAD, so a
    // session that ramped 100·105·110·110·110 through every one of five planned sets arrives as
    // `sets: 3`, and a set-count term told a lifter who finished the workout that they did not.
    // Reps are the only axis this wire can be read short on — and only when the bar did not go up,
    // because heavier for fewer is a different session rather than a smaller one.
    private fun detail(movement: AgainstMovement): String {
        val planned = movement.planned
        val target = planned?.reps
        if (planned != null && target != null && movement.now.reps < target &&
            (planned.weightKg == null || movement.now.weightKg <= planned.weightKg)
        ) {
            return "planned ${count(planned.sets, target)} · did ${count(movement.now.sets, movement.now.reps)}"
        }
        if (planned != null) {
            return "${top(planned.sets, planned.reps, planned.weightKg)} → ${top(movement.now)}"
        }
        val before = movement.before ?: return top(movement.now)
        return "${top(before)} → ${top(movement.now)}"
    }

    // Spaced when the target is absent and tight when it is named — `3 × max` beside `5×5` — which
    // is review.js `countLabel`'s own spelling, so one comparison row reads the same on both
    // surfaces. A movement taken to max never fell short of a rep target it does not have.
    private fun count(sets: Int, reps: Int?): String {
        if (reps == null) return "$sets × ${Readout.repTarget(null)}"
        return "$sets×$reps"
    }

    // Zero is not a load, it is the absence of one: a chin-up reads `3×8`, and a band-assisted
    // pull-up at −20 still reads its load, because that is a real point on the number line here.
    private fun top(sets: Int, reps: Int?, weightKg: Double?): String {
        if (weightKg == null || weightKg == 0.0) return count(sets, reps)
        return "${count(sets, reps)} @ ${Readout.weight(weightKg)}"
    }

    private fun top(effort: Effort): String = top(effort.sets, effort.reps, effort.weightKg)
}

// A session that has just closed, held by the room until the lifter is done reading it. The sets
// travel with it because the log has let go of them by now — the queue drops a delivered row the
// moment its session closes — and "Keep this as a routine" is composed from exactly those sets.
data class FinishedSession(
    val session: Session,
    val sets: List<TrainingSet>,
    val review: Review?,
    val isFirst: Boolean,
) {
    val routine: String? get() = session.plan?.routine
    val slight: Boolean get() = review?.slight ?: false

    // The offer belongs to a session that had nothing written down for it — a session started FROM
    // a routine already has one. Nothing is created until the tap, declining costs nothing, and the
    // offer comes back next session.
    //
    // NEVER OVER A SLIGHT SESSION. Screen 11 wins: a session too slight to say anything about is
    // too slight to be worth keeping as a routine, and drawing both would ask the lifter to name a
    // program and throw it away in the same scroll — two primary buttons and two different "keep"s.
    val offersRoutine: Boolean
        get() = !slight && session.routineId == null && sets.any { it.kind == SetKind.Working }
}

// ONE DRAWING OF A REVIEW, used by the screen a session ends on and by the screen it is revisited
// from. The three facts, the rare record line and the comparison are one readout, and two copies of
// it would be two chances for the product to say the same session two ways.
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

// The two things the domain says about a session that its three facts do not. Split out because a
// session read back later states those three facts in its own head (§G17), and a second copy of
// `58m` underneath would be two answers to one question.
@Composable
fun ReviewRemarks(review: Review?, catalog: List<Exercise>) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (review == null) {
            // The read did not come back, and nothing takes its place — drawing no record where a
            // record may have happened is why this sentence is here rather than a blank.
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

// The only loud thing in the product, and at most one per session. Gold is a KIND of moment here,
// never a state — nothing else on this screen is allowed to borrow it.
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
    // Whether the routine WAS kept, answered by the room after the log said so. Held outside this
    // screen on purpose: a screen that hid the offer on the tap would be telling the lifter their
    // program had changed on the strength of a request that may not have landed.
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

        // Not over a session that ended early: that screen is asking whether to keep the workout at
        // all, and offering to send it to somebody in the same breath is two questions where the
        // design allows one.
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
                Text(target(entry), style = GymType.numeral(13), color = GymSkin.targetInk)
            }
        }

        Text(
            "In the order you did them, with the weights you actually used as next week’s targets.",
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

// The one destructive action in the product, and it sits here because a three-set session is
// usually a phone left running rather than a workout. It deletes for good: nothing on this screen
// may suggest it can be got back.
@Composable
private fun Actions(finished: FinishedSession, kept: Boolean, onDiscard: () -> Unit, onDone: () -> Unit) {
    if (finished.slight) {
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
                    .clickable(onClick = onDiscard),
            ) {
                Text(
                    "Discard session",
                    style = WindmillFont.body(16, FontWeight.SemiBold),
                    color = GymSkin.alarmInk,
                )
            }
            Text(
                "Discarding deletes the session and its sets. There is no undoing it.",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
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

private fun target(entry: RoutineEntryWrite): String {
    val count = "${entry.targetSets} × ${Readout.repTarget(entry.targetReps)}"
    val weight = entry.targetWeightKg
    if (weight == null || weight == 0.0) return count
    return "$count · ${Readout.weight(weight)}"
}
