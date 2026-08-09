package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A SESSION, REVISITED — the door Today's "Last session" row points at. A row that reads as a
// destination and goes nowhere is the same defect this room refuses everywhere else (a primary
// button that fails, a tab bar over a screen that does not exist), so it is either a door or it is
// not a row: it is a door.
//
// It is the finished session and nothing else: the review the DOMAIN computed, every set as it was
// performed, and the coach share. It draws no editing of any kind — the log is append-only, the
// phone owns the OPEN session, and a screen that offered to change a closed one would be promising
// a route the wire does not have.

// The sets of a session as they are read back: grouped by movement in the order the movements were
// first touched, and inside a movement in the order the sets were performed. That is the order the
// session was LIVED in, and the same one "Keep this as a routine" composes a program from.
object Performed {
    data class Row(val id: String, val number: String, val effort: String, val kind: SetKind)

    data class Movement(val id: String, val movement: String, val rows: List<Row>)

    // `setNumber` is the LOG's own count of this movement in this session, and it is what the row
    // prints when it is there. A session read back from the log always carries it; the fallback is
    // the position in this movement's own run, so a row is never numberless.
    fun movements(sets: List<TrainingSet>, catalog: List<Exercise>): List<Movement> {
        val performed = sets.sortedBy { it.completedAtMs }
        val order = mutableListOf<String>()
        for (set in performed) if (set.exerciseId !in order) order.add(set.exerciseId)

        return order.map { exerciseId ->
            val mine = performed.filter { it.exerciseId == exerciseId }
            Movement(
                id = exerciseId,
                movement = Readout.movement(exerciseId, catalog),
                rows = mine.mapIndexed { index, set ->
                    Row(
                        id = set.id,
                        number = (set.setNumber ?: index + 1).toString(),
                        effort = Readout.effort(set.weightKg, set.reps),
                        kind = set.kind,
                    )
                },
            )
        }
    }
}

// The store stays for the two reads a revisit is made of (the sets, the review); only the share
// half crosses through CoachDoors, because the mint and the revoke are the two writes this screen
// may reach.
@Composable
fun SessionScreen(summary: SessionSummary, store: TrainingStore, coach: CoachDoors) {
    var detail by remember(summary.id) { mutableStateOf<SessionDetail?>(null) }
    var setsFailure by remember(summary.id) { mutableStateOf<WriteFailure?>(null) }
    var review by remember(summary.id) { mutableStateOf<Review?>(null) }
    var read by remember(summary.id) { mutableStateOf(false) }

    // Two reads, and neither one blocks the other: the sets are the session and the review is what
    // the domain makes of it, so a screen missing one still says everything it can about the other.
    LaunchedEffect(summary.id) {
        when (val found = store.sessionDetail(summary.id)) {
            is GymResult.Ok -> detail = found.value
            is GymResult.Failed -> setsFailure = found.why
        }
        review = store.review(summary.id)
        read = true
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x8),
    ) {
        SessionHead(summary)
        // The review is the domain's opinion of the session and the sets are the session itself;
        // the readout is only drawn once the log has answered, because "the log didn't answer" is
        // its empty state and this screen has not asked yet on first frame.
        if (read) ReviewReadout(review, store.catalog)
        SetsBlock(detail, setsFailure, store.catalog)
        CoachShareCard(coach, summary.id)
    }
}

@Composable
private fun SessionHead(summary: SessionSummary) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text(
            summary.plan?.routine ?: "Ad-hoc",
            style = WindmillFont.display(30),
            color = GymSkin.ink,
        )
        Text(whenLine(summary), style = GymType.numeral(12), color = GymSkin.inkFaint)
        // The four-hour rule closed this one rather than a tap, which is a fact about the session a
        // lifter reading it back deserves — the duration on the tiles above is a phone left
        // running, not a workout that lasted that long.
        if (summary.closedItself) {
            Text(
                "closed on its own — no set for four hours",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }
    }
}

@Composable
private fun SetsBlock(detail: SessionDetail?, setsFailure: WriteFailure?, catalog: List<Exercise>) {
    if (detail != null) {
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
                .padding(WindmillSpace.x4),
        ) {
            Performed.movements(detail.sets, catalog).forEach { movement ->
                Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                    Text(
                        movement.movement,
                        style = WindmillFont.body(16, FontWeight.SemiBold),
                        color = GymSkin.ink,
                    )
                    movement.rows.forEach { performed -> SetRow(performed) }
                }
            }
        }
        return
    }
    if (setsFailure != null) {
        // The log's own sentence when it sent one — including the one the store writes for a
        // session that has been discarded from another surface since Today listed it, which is a
        // fact about the log and not about this phone's signal.
        Text(
            setsFailure.line("the sets are on your account"),
            style = GymType.numeral(13),
            color = GymSkin.inkFaint,
        )
    }
}

// A warmup counts toward nothing — not the records, not the prefill, not the comparison — so it is
// drawn in the ink that says so rather than beside a working set as though it were one.
@Composable
private fun SetRow(set: Performed.Row) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            set.number,
            style = GymType.numeral(12),
            color = GymSkin.inkFaint,
            textAlign = TextAlign.End,
            modifier = Modifier
                .width(18.dp)
                .alignByBaseline(),
        )
        Text(
            set.effort,
            style = GymType.numeral(15),
            color = if (set.kind == SetKind.Working) GymSkin.ink else GymSkin.warmupInk,
            modifier = Modifier.alignByBaseline(),
        )
        Spacer(Modifier.weight(1f))
        if (set.kind != SetKind.Working) {
            Text(
                set.kind.wire,
                style = GymType.numeral(11),
                color = GymSkin.warmupInk,
                modifier = Modifier.alignByBaseline(),
            )
        }
    }
}

private fun whenLine(summary: SessionSummary): String {
    val day = "${Readout.day(summary.startedAtMs)} · ${Readout.time(summary.startedAtMs)}"
    val finished = summary.finishedAtMs
        ?: return "$day · ${Readout.setCount(summary.setCount)}"
    return "$day – ${Readout.time(finished)} · ${Readout.setCount(summary.setCount)}"
}
