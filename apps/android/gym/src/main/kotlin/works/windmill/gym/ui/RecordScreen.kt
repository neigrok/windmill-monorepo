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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.text.font.FontWeight
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

// It RENDERS what `Record.page` decided; the one piece of arithmetic is where the bars STAND, in
// `BarRow` rather than in the canvas. A rename moves a NAME and never an id.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordScreen(exerciseId: String, store: TrainingStore, backLabel: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    var record by remember(exerciseId) { mutableStateOf<MovementRecord?>(null) }
    var failure by remember(exerciseId) { mutableStateOf<WriteFailure?>(null) }
    var asked by remember(exerciseId) { mutableIntStateOf(0) }
    // Saveable: a half-typed name exists nowhere but here.
    var renaming by rememberSaveable(exerciseId) { mutableStateOf(false) }
    var draft by rememberSaveable(exerciseId) { mutableStateOf("") }
    var refused by remember(exerciseId) { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Compose fires no dismiss callback on a programmatic close, so nothing here waits for one.
    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { renaming = false }
    }

    LaunchedEffect(exerciseId, asked) {
        failure = null
        when (val read = store.record(exerciseId)) {
            is GymResult.Ok -> record = read.value
            is GymResult.Failed -> failure = read.why
        }
    }

    Column(Modifier.fillMaxSize()) {
        Head(
            backLabel = backLabel,
            renameable = record != null,
            onBack = onBack,
            onRename = {
                refused = null
                draft = record?.exercise?.name.orEmpty()
                renaming = true
            },
        )

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
                read != null -> Body(Record.page(read, nowMs))
                silent != null -> Silence(silent.line("this movement isn’t drawn"), retry = { asked += 1 })
                else -> Silence("reading your log…", retry = null)
            }
        }
    }

    val read = record
    if (renaming && read != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
            dragHandle = null,
        ) {
            RenameSheet(
                title = "Rename this movement",
                from = read.exercise.name,
                value = draft,
                proof = Record.proof(read, aliased = store.renameKeepsAnAlias(exerciseId)),
                refused = refused,
                onValue = { draft = it },
                onCancel = {
                    refused = null
                    close()
                },
                onRename = {
                    scope.launch {
                        when (val written = store.rename(exerciseId, draft)) {
                            is GymResult.Failed -> refused = written.why.line("that movement kept its name")
                            is GymResult.Ok -> {
                                close()
                                // The movement THE LOG CONFIRMED goes onto the page at once and the
                                // page is re-read behind it, in that order.
                                record = record?.copy(exercise = written.value)
                                asked += 1
                            }
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun Head(
    backLabel: String,
    renameable: Boolean,
    onBack: () -> Unit,
    onRename: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .padding(horizontal = WindmillSpace.x4),
    ) {
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
private fun Body(page: Record.Page) {
    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Text(page.name, style = WindmillFont.display(30), color = GymSkin.ink)
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

    // Said only where a number really is missing rather than undefined.
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
        Row(
            horizontalArrangement = if (chart.to == null) Arrangement.Center else Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(chart.from, style = GymType.numeral(10), color = GymSkin.inkFaint)
            chart.to?.let { Text(it, style = GymType.numeral(10), color = GymSkin.inkFaint) }
        }
    }
}

// A bar has a width it may not exceed and one it may not fall under, at which point THE GAP GIVES
// WAY; between the two the gap is exactly 6dp and the pitch is exactly slot + gap.
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

// Gold on exactly one bar — the session holding the standing best, when it is inside the window.
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
