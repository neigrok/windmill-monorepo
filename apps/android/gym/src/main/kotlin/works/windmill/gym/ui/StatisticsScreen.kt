package works.windmill.gym.ui

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Stats
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// STATISTICS — the long window, and the second place a lifter can stand in this room at rest. It
// RENDERS what `Stats.board` decided and computes nothing itself: no e1RM, no normalisation, no
// sorting, no arithmetic in a drawing.
//
// A CHART ON A PHONE HAS NO SCRUB AND NO HOVER, so every number a mark would otherwise reveal on
// touch is printed beside it — each bar row carries its own peak, each movement line its two
// endpoints. A chart whose values can only be reached by a gesture the surface does not have is a
// decoration, and this product does not draw those.
//
// Nothing here is a grade. No score, no percentage, no green and no red: iris is the one accent
// and it reads as iron, exactly as it does on the weight the lifter is under. Matter-of-fact: no
// entry animation — this is an instrument, not a reveal.
@Composable
fun StatisticsScreen(store: TrainingStore) {
    var board by remember { mutableStateOf<Stats.Board?>(null) }
    var failure by remember { mutableStateOf<WriteFailure?>(null) }
    var asked by remember { mutableIntStateOf(0) }

    // Read on the way in and shaped once, outside a drawing. There is no cache to key on a
    // collection's length and get wrong: a second visit asks the log again, and a set logged in
    // between counts the next time this screen is opened.
    LaunchedEffect(asked) {
        failure = null
        when (val statistics = store.statistics()) {
            is GymResult.Ok -> board = Stats.board(statistics.value, store.catalog, now = System.currentTimeMillis())
            is GymResult.Failed -> failure = statistics.why
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            // Short at the top: this screen is PUSHED, and the frame's own back row sits above it.
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x8),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text("Statistics", style = WindmillFont.display(32), color = GymSkin.ink)
            Text(
                "every session you have finished",
                style = GymType.numeral(13),
                color = GymSkin.inkFaint,
            )
        }

        val drawn = board
        val silent = failure
        when {
            drawn != null -> {
                drawn.weeks?.let { WeeksCard(it) }
                drawn.lines.forEach { MovementCard(it) }
                if (drawn.isEmpty) NothingYet()
            }
            // In the log's own words when it sent any. A 500 that said "internal error" is not a
            // phone with no signal, and this screen may not report it as one.
            silent != null -> Silence(silent.line("these lines aren’t drawn"), retry = { asked += 1 })
            else -> Silence("reading your log…", retry = null)
        }
    }
}

// Two rows of bars, each measured against ITS OWN peak — sessions and working sets count different
// things, and one axis across both is the chart that made Lift's progress tab unreadable. A week
// with nothing in it draws no bar, so a gap in a program reads as a gap in the row rather than as a
// bar the eye has to measure.
@Composable
private fun WeeksCard(weeks: Stats.Weeks) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        SeriesRow(weeks.sets)
        SeriesRow(weeks.sessions)
        Text(weeks.span, style = GymType.numeral(11), color = GymSkin.inkFaint)
    }
}

// Bars are counts, measured FROM ZERO against the baseline rule under the row — the domain already
// normalised them that way, and this only spells heights as pixels.
@Composable
private fun SeriesRow(series: Stats.Series) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(series.label, style = GymType.numeral(11), color = GymSkin.inkDim)
            Spacer(Modifier.weight(1f))
            Text(series.peak, style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(44.dp),
        ) {
            val count = series.heights.size
            if (count == 0) return@Canvas
            val gap = 3.dp.toPx()
            val slot = (size.width - gap * (count - 1)) / count
            series.heights.forEachIndexed { index, height ->
                val tall = (height.coerceIn(0.0, 1.0) * size.height).toFloat()
                if (tall <= 0f) return@forEachIndexed
                drawRoundRect(
                    color = GymSkin.accent,
                    topLeft = Offset(index * (slot + gap), size.height - tall),
                    size = Size(slot, tall),
                    cornerRadius = CornerRadius(1.5.dp.toPx()),
                )
            }
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(GymSkin.line),
        )
    }
}

// One movement, and the only chart in the product that is a line: a load over sessions is a
// continuous thing and a count per week is not.
@Composable
private fun MovementCard(line: Stats.Line) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                line.movement,
                style = WindmillFont.body(17),
                color = GymSkin.ink,
                modifier = Modifier.alignByBaseline(),
            )
            Spacer(Modifier.weight(1f))
            Text(
                line.value,
                style = GymType.numeral(17, FontWeight.SemiBold),
                color = GymSkin.ink,
                modifier = Modifier.alignByBaseline(),
            )
            Text(
                line.unit,
                style = GymType.numeral(11),
                color = GymSkin.inkFaint,
                modifier = Modifier
                    .alignByBaseline()
                    .padding(start = WindmillSpace.x1),
            )
        }

        Text(line.lastTrained, style = GymType.numeral(11), color = GymSkin.inkFaint)

        Sparkline(line.heights)

        Text(line.span, style = GymType.numeral(12), color = GymSkin.inkDim)

        line.bests.forEach { best ->
            Text(best, style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
    }
}

// The line itself, and the whole of its drawing: a polyline through the normalised points with the
// newest one marked, because the last point is the one a lifter is looking for. A movement with one
// session is one dot — a chart of a single point is honest and an interpolation to nowhere is not.
//
// Inset by the dot's own radius on every side, so the newest point's mark and a line that runs
// along its own floor are both drawn INSIDE the frame rather than half over the card's edge.
@Composable
private fun Sparkline(heights: List<Double>) {
    Canvas(
        Modifier
            .fillMaxWidth()
            .padding(vertical = WindmillSpace.x1)
            .height(36.dp),
    ) {
        if (heights.isEmpty()) return@Canvas
        val inset = 3.dp.toPx()
        val room = size.height - inset * 2
        val points = if (heights.size == 1) {
            listOf(Offset(size.width / 2, inset + room * (1 - heights[0].toFloat())))
        } else {
            val step = (size.width - inset * 2) / (heights.size - 1)
            heights.mapIndexed { index, value ->
                Offset(inset + index * step, inset + room * (1 - value.toFloat()))
            }
        }
        val path = Path()
        points.forEachIndexed { index, point ->
            if (index == 0) path.moveTo(point.x, point.y) else path.lineTo(point.x, point.y)
        }
        drawPath(
            path,
            color = GymSkin.accent,
            style = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
        drawCircle(GymSkin.accent, radius = 2.5.dp.toPx(), center = points.last())
    }
}

// The honest empty: a log with no FINISHED session has nothing to draw, and the session running
// right now is deliberately not in here — a statistics read that moved under a lifter between two
// sets would be reporting on a workout in flight.
@Composable
private fun NothingYet() {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text("Nothing finished yet.", style = WindmillFont.body(16), color = GymSkin.inkDim)
        Text(
            "These lines are drawn from sessions you have closed. The one you are in the middle of is today’s screen.",
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = GymSkin.inkFaint,
        )
    }
}

// Mono, quiet, never a spinner and never an alert — the room's one voice for a door that did not
// open. The read is offered again rather than retried forever: this screen is somewhere a lifter
// chose to stand, and a poll behind it would spend a basement's signal on a chart.
@Composable
private fun Silence(line: String, retry: (() -> Unit)?) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
        Text(line, style = GymType.numeral(13), color = GymSkin.inkFaint)
        if (retry != null) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                    .clickable(onClick = retry),
            ) {
                Text(
                    "Try again",
                    style = WindmillFont.body(16, FontWeight.SemiBold),
                    color = GymSkin.accent,
                )
            }
        }
    }
}
