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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlin.math.min
import kotlinx.coroutines.launch
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Record
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A MOVEMENT'S RECORD (§H) — one exercise, one page, twelve weeks of it, reached by tapping an
// exercise name anywhere the room is at rest. It RENDERS what `Record.page` decided and decides no
// number about training itself: no e1RM, no normalisation, nothing about a lift worked out inside a
// drawing. The one piece of arithmetic here is where the bars STAND, and it lives in `BarRow`
// rather than in the canvas, because a layout that can go blank is a layout a test has to run.
//
// It is also the page that makes stable exercise identity visible. Rename Back Squat here and the
// history stays whole, because the rename moves a NAME and never an id — every set, routine line
// and frozen plan snapshot still points at the same movement, and this is the one screen where a
// lifter can watch that happen.
//
// A CHART ON A PHONE HAS NO SCRUB AND NO HOVER, so the two things a mark would otherwise reveal on
// touch are printed: the number a full-height bar would be stands in the tile above the chart —
// the standing best, which is what the bars are measured against — and the days at the ends of the
// series stand under it. Nothing here is a grade — no score, no percentage, no green and no red.
// Gold is the one loud ink and it means a personal record, which is a kind of moment rather than
// a state.
//
// IT DRAWS NO EDITING OF A SET, and that is a decision rather than a gap now that §G18 exists. A
// set is fixed where it was performed — on the session it belongs to, beside the plan it was
// measured against — and this page groups one movement's sets across months, where "which of these
// forty is the typo" is a question the shape cannot answer. So nothing in the recent list says it
// can be tapped. And no merge affordance: §4's "looks like Bench Press — merge" belongs on this
// page and NOTHING IN THIS PRODUCT MERGES TWO MOVEMENTS YET — rewriting exercise identity across a
// lifter's whole history is an operation that wants its own wave on every surface at once, and a
// control that opened nothing would be the defect this room refuses everywhere else.
@Composable
fun RecordScreen(exerciseId: String, store: TrainingStore, backLabel: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var record by remember(exerciseId) { mutableStateOf<MovementRecord?>(null) }
    var failure by remember(exerciseId) { mutableStateOf<WriteFailure?>(null) }
    var asked by remember(exerciseId) { mutableIntStateOf(0) }
    // Saveable, and it is the only state on this screen that has to be: everything else is re-read
    // when the activity is recreated, but a half-typed name exists nowhere but here — and a
    // rotation that dropped it would be the room throwing away something the lifter typed.
    var renaming by rememberSaveable(exerciseId) { mutableStateOf(false) }
    var draft by rememberSaveable(exerciseId) { mutableStateOf("") }
    var refused by remember(exerciseId) { mutableStateOf<String?>(null) }

    // Read on the way in and shaped once, outside a drawing. There is no cache to key on a
    // collection's length and get wrong: a second visit asks the log again, and a set logged in
    // between counts the next time this page is opened.
    LaunchedEffect(exerciseId, asked) {
        failure = null
        when (val read = store.record(exerciseId)) {
            is GymResult.Ok -> record = read.value
            is GymResult.Failed -> failure = read.why
        }
    }

    Column(Modifier.fillMaxSize()) {
        // The way back and the rename sit on ONE row, which is why this screen draws its own head
        // rather than standing under the room's: §H hangs an action off the right of the back row,
        // and a screen that owns an action in that row owns the row. In rename mode both ends
        // change — leaving without saving has to be as reachable as saving.
        Head(
            backLabel = backLabel,
            renaming = renaming,
            // A door onto nothing is the same defect as a chevron that goes nowhere: until the read
            // lands there is no name to edit, and Save on an empty field would be a refusal the
            // lifter walked into.
            renameable = record != null,
            onBack = onBack,
            onRename = {
                refused = null
                draft = record?.exercise?.name.orEmpty()
                renaming = true
            },
            onCancel = {
                refused = null
                renaming = false
            },
            onSave = {
                scope.launch {
                    when (val written = store.rename(exerciseId, draft)) {
                        is GymResult.Failed -> refused = written.why.line("that movement kept its name")
                        is GymResult.Ok -> {
                            renaming = false
                            // The movement THE LOG CONFIRMED goes onto the page at once and the page
                            // is re-read behind it. Both, and in that order: the store answers Ok
                            // only where the write landed, and a refresh that then fails must not
                            // put the old name back over a rename that really happened.
                            record = record?.copy(exercise = written.value)
                            asked += 1
                        }
                    }
                }
            },
        )

        // A rename that did not land is said where the field is, not at the foot of a page that
        // may be scrolled past it — and in alarm ink, which fires on a write that failed and on
        // nothing else in this room.
        refused?.let {
            Text(
                it,
                style = GymType.numeral(12),
                color = GymSkin.alarmInk,
                modifier = Modifier.padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x1),
            )
        }

        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WindmillSpace.x4)
                .padding(bottom = WindmillSpace.x8),
        ) {
            val read = record
            val silent = failure
            when {
                read != null -> Body(Record.page(read, nowMs), renaming, draft) { draft = it }
                // In the log's own words when it sent any. A 500 that said "internal error" is not
                // a phone with no signal, and this page may not report it as one.
                silent != null -> Silence(silent.line("this movement isn’t drawn"), retry = { asked += 1 })
                else -> Silence("reading your log…", retry = null)
            }
        }
    }
}

@Composable
private fun Head(
    backLabel: String,
    renaming: Boolean,
    renameable: Boolean,
    onBack: () -> Unit,
    onRename: () -> Unit,
    onCancel: () -> Unit,
    onSave: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .padding(horizontal = WindmillSpace.x4),
    ) {
        if (renaming) {
            HeadAction("Cancel", GymSkin.inkDim, FontWeight.SemiBold, onCancel)
            Spacer(Modifier.weight(1f))
            HeadAction("Save", GymSkin.accent, FontWeight.Bold, onSave)
            return@Row
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier
                .heightIn(min = GymTap.minimum)
                .clickable(onClick = onBack),
        ) {
            Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text(backLabel, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
        Spacer(Modifier.weight(1f))
        if (renameable) HeadAction("Rename", GymSkin.accent, FontWeight.Bold, onRename)
    }
}

// A word in the head row is a control, so it gets the room's own floor rather than the height its
// glyphs happen to have — a chalked thumb finds the band, not the letters.
@Composable
private fun HeadAction(label: String, ink: Color, weight: FontWeight, onTap: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clickable(onClick = onTap)
            .padding(horizontal = WindmillSpace.x1),
    ) {
        Text(label, style = WindmillFont.body(15, weight), color = ink)
    }
}

@Composable
private fun Body(page: Record.Page, renaming: Boolean, draft: String, onDraft: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        if (renaming) {
            NameField(draft, onDraft)
        } else {
            Text(page.name, style = WindmillFont.display(30), color = GymSkin.ink)
        }
        Text(page.subhead, style = GymType.numeral(12), color = GymSkin.inkFaint)
    }

    page.nothingYet?.let {
        Text(
            it,
            style = WindmillFont.body(15).copy(lineHeight = 22.sp),
            color = GymSkin.inkDim,
            modifier = Modifier.padding(top = WindmillSpace.x2),
        )
        return
    }

    if (page.tiles.isNotEmpty()) {
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            page.tiles.forEach { tile -> MarkTile(tile, Modifier.weight(1f)) }
        }
    }

    page.chart?.let { ChartCard(it) }

    // Why the chart is not there, said only where a number really is missing rather than
    // undefined. A movement Epley has nothing to say about is silent on purpose — there is no
    // e1RM to be missing — and this is the other case: the log computes the estimate, and this
    // device is holding the sets alone.
    page.noEstimate?.let {
        Text(
            it,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
    }

    if (page.records.isNotEmpty()) {
        SectionHead("Personal records")
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            page.records.forEach { RecordRow(it) }
        }
    }

    if (page.days.isNotEmpty()) {
        SectionHead("Recent sets")
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            page.days.forEach { day ->
                Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
                    Text(
                        day.day,
                        style = GymType.numeral(13),
                        color = GymSkin.inkFaint,
                        modifier = Modifier.width(62.dp),
                    )
                    Text(day.sets, style = GymType.numeral(13), color = GymSkin.ink)
                }
            }
        }
    }
}

// The name, editable in place — no sheet and no dialog, because the thing being renamed is on the
// screen and a modal over it would hide the one fact that makes the rename safe: the page under it
// does not change.
@Composable
private fun NameField(draft: String, onDraft: (String) -> Unit) {
    BasicTextField(
        value = draft,
        onValueChange = onDraft,
        singleLine = true,
        textStyle = WindmillFont.display(30).copy(color = GymSkin.ink),
        cursorBrush = SolidColor(GymSkin.accent),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Words,
            autoCorrectEnabled = false,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.raised)
            .padding(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
    )
}

@Composable
private fun MarkTile(tile: Record.Tile, modifier: Modifier) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = modifier
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text(
            tile.label.uppercase(),
            style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
            color = GymSkin.inkFaint,
        )
        Text(
            tile.value,
            style = WindmillFont.display(34),
            color = if (tile.loud) GymSkin.prInk else GymSkin.ink,
        )
        Text(tile.caption, style = GymType.numeral(11), color = GymSkin.inkFaint)
    }
}

@Composable
private fun ChartCard(chart: Record.Chart) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                "e1RM per session".uppercase(),
                style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
                color = GymSkin.inkFaint,
            )
            Spacer(Modifier.weight(1f))
            Text(chart.window, style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        Bars(chart.bars)
        // Two ends, or one date where the two ends are the same day — a lone caption sits under the
        // lone bar rather than pinned to a corner of an axis that has no span.
        Row(
            horizontalArrangement = if (chart.to == null) Arrangement.Center else Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(chart.from, style = GymType.numeral(10), color = GymSkin.inkFaint)
            chart.to?.let { Text(it, style = GymType.numeral(10), color = GymSkin.inkFaint) }
        }
    }
}

// WHERE THE BARS STAND, and it is arithmetic rather than drawing, so it is decided here where a
// test can run it: one bar per session in twelve weeks is a count the log sets and nothing caps —
// a lifter squatting five times a week has sixty of them — and a chart that ran out of width would
// go blank under a card that still drew its title, its window and its dates. An axis with nothing
// on it is the defect this whole page is built to refuse.
//
// The two ends of the rule, in the order they bind:
//   · a bar has a WIDTH IT MAY NOT EXCEED, because three sessions divided across a card are three
//     walls rather than three bars, and the shape of a chart is what a chart is for;
//   · and a width it may not fall UNDER, at which point THE GAP GIVES WAY — a separation that
//     costs the thing it separates has stopped being one. Sixty sessions draw sixty hairlines
//     with almost no air between them, which is what sixty sessions in twelve weeks look like.
// Between the two the gap is exactly 6dp and the pitch is exactly slot + gap: the plain division,
// laid out as if neither line were here.
internal object BarRow {
    val gap = 6.dp
    val widest = 28.dp
    val narrowest = 1.5.dp

    data class Slot(val width: Float, val pitch: Float, val first: Float)

    fun layout(width: Float, count: Int, gap: Float, widest: Float, narrowest: Float): Slot {
        if (count <= 0 || width <= 0f) return Slot(0f, 0f, 0f)
        val air = ((width - narrowest * count) / (count - 1).coerceAtLeast(1)).coerceIn(0f, gap)
        val slot = min((width - air * (count - 1)) / count, widest)
        if (count == 1) return Slot(slot, 0f, (width - slot) / 2)
        return Slot(slot, (width - slot) / (count - 1), 0f)
    }
}

// The bars, and the whole of their drawing: one per session, heights already decided against the
// zero baseline by the domain, and the top corners rounded because the baseline they stand on is
// the axis and a bar that curved away from it would be a bar leaving its own zero.
//
// Gold on exactly one of them — the session holding the standing best, when it is inside the window
// at all — and iron on the rest. Two tiers rather than §H's three: a third would need a legend, and
// the Personal records list beneath this card already names every record with its date.
@Composable
private fun Bars(bars: List<Record.Bar>) {
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(122.dp),
    ) {
        if (bars.isEmpty()) return@Canvas
        val corner = CornerRadius(5.dp.toPx())
        val slot = BarRow.layout(
            width = size.width,
            count = bars.size,
            gap = BarRow.gap.toPx(),
            widest = BarRow.widest.toPx(),
            narrowest = BarRow.narrowest.toPx(),
        )
        bars.forEachIndexed { index, bar ->
            val tall = (bar.height.coerceIn(0.0, 1.0) * size.height).toFloat()
            if (tall <= 0f) return@forEachIndexed
            val standing = Offset(slot.first + index * slot.pitch, size.height - tall)
            drawPath(
                Path().apply {
                    addRoundRect(RoundRect(
                        rect = Rect(standing, Size(slot.width, tall)),
                        topLeft = corner, topRight = corner,
                        bottomRight = CornerRadius.Zero, bottomLeft = CornerRadius.Zero,
                    ))
                },
                color = if (bar.standingBest) GymSkin.prInk else GymSkin.raised,
            )
        }
    }
}

// The row that is still holding wears the gold: the mark every later session is measured against,
// and the only loud thing in this list.
@Composable
private fun RecordRow(best: Record.Best) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum - 6.dp)
            .background(
                if (best.standing) GymSkin.prSoft else GymSkin.surface,
                RoundedCornerShape(WindmillRadius.md),
            )
            .border(
                1.dp,
                if (best.standing) GymSkin.prInk else GymSkin.line,
                RoundedCornerShape(WindmillRadius.md),
            )
            .padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x2),
    ) {
        Text(best.effort, style = GymType.numeral(14, FontWeight.Bold), color = GymSkin.ink)
        Text(best.estimate, style = GymType.numeral(11), color = GymSkin.inkDim)
        Spacer(Modifier.weight(1f))
        Text(best.day, style = GymType.numeral(11), color = GymSkin.inkFaint)
    }
}

@Composable
private fun SectionHead(label: String) {
    Text(
        label.uppercase(),
        style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
        color = GymSkin.inkFaint,
        modifier = Modifier.padding(top = WindmillSpace.x2),
    )
}

// Mono, quiet, never a spinner and never an alert — the room's one voice for a door that did not
// open. The read is offered again rather than retried forever: this page is somewhere a lifter
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
                Text("Try again", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
            }
        }
    }
}
