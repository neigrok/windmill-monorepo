package works.windmill.gym.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ChartRun
import works.windmill.gym.domain.ChartWindow
import works.windmill.gym.domain.ParsedWeight
import works.windmill.gym.domain.Units
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// The reading at the head of the log: the last weigh-in and its age, or NOTHING — never a dash, never
// a zero, never a field asking for one. Tapping it opens the chart, a destination.
@Composable
fun BodyweightReading(latest: WeighIn?, nowMs: Long, onOpen: () -> Unit) {
    val reading = Bodyweight.reading(latest, nowMs) ?: return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clickable(onClick = onOpen),
    ) {
        Text(reading, style = GymType.numeral(13), color = GymSkin.inkDim)
        Text("›", style = WindmillFont.body(13, FontWeight.SemiBold), color = GymSkin.inkFaint)
    }
}

// The one door to entering a weigh-in. Pinned by the caller in the reach band; a scroll item would be
// out of reach at exactly the length of log that earns one.
@Composable
fun WeighInChip(onOpen: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .heightIn(min = GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.full))
            .background(GymSkin.accentSoft)
            .border(1.dp, GymSkin.accent, RoundedCornerShape(WindmillRadius.full))
            .clickable(onClick = onOpen)
            .padding(horizontal = WindmillSpace.x5),
    ) {
        Text(Bodyweight.chip, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.accent)
    }
}

// One sheet for the three verbs: enter, correct, delete. A plain decimal field — no ladder and no
// keypad, because a bodyweight has no plate physics and is not stepped to — and a date that defaults
// to today and moves, unless the sheet was opened on a dot, where the date IS the dot.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WeighInSheet(
    initial: WeighIn?,
    fixedDate: LocalDate?,
    nowMs: Long,
    units: Units,
    saving: Boolean,
    refused: String?,
    onSave: (String, Double) -> Unit,
    onDelete: (() -> Unit)?,
) {
    val today = Bodyweight.today(nowMs)
    var typed by remember { mutableStateOf(initial?.let { Bodyweight.kilograms(it.weightKg) } ?: "") }
    var date by remember { mutableStateOf(fixedDate ?: initial?.date ?: today) }
    var said by remember { mutableStateOf<String?>(null) }
    var pickingDate by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }

    // The refusals are read in order — the number, then the date — and only the first is said; a
    // save the log refused says the log's sentence in the same slot.
    fun save() {
        when (val parsed = Bodyweight.parse(typed)) {
            is ParsedWeight.Refused -> said = parsed.said
            is ParsedWeight.Ok -> {
                said = Bodyweight.dated(date, today)
                if (said == null) onSave(date.toString(), parsed.weightKg)
            }
        }
    }

    if (pickingDate) {
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
            // A weigh-in is a fact that happened: nothing here dates one into the future.
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                    !LocalDate.ofEpochDay(utcTimeMillis / 86_400_000).isAfter(today)
            },
        )
        DatePickerDialog(
            onDismissRequest = { pickingDate = false },
            confirmButton = {
                TextButton(onClick = {
                    picker.selectedDateMillis?.let { date = LocalDate.ofEpochDay(it / 86_400_000) }
                    pickingDate = false
                }) { Text("Use this day") }
            },
            dismissButton = {
                TextButton(onClick = { pickingDate = false }) { Text("Keep it") }
            },
        ) {
            DatePicker(state = picker)
        }
    }

    if (confirmingDelete && onDelete != null) {
        ConfirmDialog(
            title = Bodyweight.deleteAsk,
            body = null,
            confirm = Bodyweight.delete,
            destructive = true,
            onConfirm = {
                confirmingDelete = false
                onDelete()
            },
            onKeep = { confirmingDelete = false },
        )
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .imePadding()
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x6),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Text(Bodyweight.sheetTitle(fixedDate), style = WindmillFont.display(22), color = GymSkin.ink)

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            BasicTextField(
                value = typed,
                onValueChange = { typed = it.take(8) },
                singleLine = true,
                enabled = !saving,
                textStyle = GymType.numeral(28, FontWeight.Bold).copy(color = GymSkin.ink),
                cursorBrush = SolidColor(GymSkin.accent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, autoCorrectEnabled = false),
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.primary)
                    .clip(RoundedCornerShape(WindmillRadius.lg))
                    .background(GymSkin.raised)
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                    .focusRequester(focus)
                    .semantics { contentDescription = weightField },
                decorationBox = { inner ->
                    Box(
                        Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x3),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        inner()
                    }
                },
            )
            Text(Bodyweight.unit, style = WindmillFont.body(18, FontWeight.Bold), color = GymSkin.inkFaint)
        }
        Text(Bodyweight.fieldHint, style = GymType.numeral(12), color = GymSkin.inkFaint)
        if (units == Units.Pounds) {
            Text(Bodyweight.kilogramsOnly, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.inkFaint)
        }
        (said ?: refused)?.let {
            Text(it, style = WindmillFont.body(14).copy(lineHeight = 21.sp), color = GymSkin.alarmInk)
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .then(if (fixedDate == null) Modifier.clickable { pickingDate = true } else Modifier)
                .padding(horizontal = WindmillSpace.x1),
        ) {
            Text("Date", style = WindmillFont.body(14), color = GymSkin.inkDim)
            Spacer(Modifier.weight(1f))
            Text(
                Bodyweight.dayLine(date, today),
                style = GymType.numeral(13, FontWeight.Bold),
                color = if (fixedDate == null) GymSkin.accent else GymSkin.inkDim,
            )
            if (fixedDate == null) {
                Text("  ›", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
            }
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .alpha(if (saving) 0.4f else 1f)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable(enabled = !saving) { save() },
        ) {
            Text(Bodyweight.save, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
        }

        onDelete?.let {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clickable(enabled = !saving) { confirmingDelete = true },
            ) {
                Text(Bodyweight.deleteRow, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.alarmInk)
            }
        }
    }
}

// The one name the field answers to in the semantics tree; the Robolectric suite types into it.
const val weightField = "weight in kilograms"

// A dot per measurement on a truncated, labelled y-axis; a segment only across an ordinary gap; a
// longer one left empty and named. No goal line, no projection, no trend, no BMI, no scrubbing.
// Tapping a dot is the repair path: the SAME sheet, the date fixed to that day, with a delete row.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BodyweightScreen(
    store: TrainingStore,
    backLabel: String,
    onBack: () -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    val today = Bodyweight.today(nowMs)
    var window by remember { mutableStateOf(ChartWindow.Ninety) }
    var repairing by remember { mutableStateOf<WeighIn?>(null) }
    var saving by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            repairing = null
            refused = null
        }
    }

    val shown = Bodyweight.windowed(store.bodyweight, window, today)
    val runs = Bodyweight.runs(shown)

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(bottom = WindmillSpace.x8),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
            modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
        ) {
            Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
            Text(backLabel, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
        Text(Bodyweight.title, style = WindmillFont.display(30), color = GymSkin.ink)

        if (Bodyweight.windowed(store.bodyweight, ChartWindow.All, today).isEmpty()) {
            Text(Bodyweight.nothingYet, style = WindmillFont.body(15), color = GymSkin.inkDim)
            return@Column
        }

        WindowControl(window, onPick = { window = it })
        Text(Bodyweight.windowLine(window, shown.size), style = GymType.numeral(12), color = GymSkin.inkFaint)

        if (shown.isEmpty()) {
            Text(Bodyweight.noneInWindow, style = WindmillFont.body(15), color = GymSkin.inkDim)
        } else {
            DotChart(shown, runs, window, today, onDot = { repairing = it })
        }
        Text(Bodyweight.gapRule, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.inkFaint)
        if (store.preferences.units == Units.Pounds) {
            Text(Bodyweight.kilogramsOnly, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.inkFaint)
        }
    }

    val open = repairing
    if (open != null) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
        ) {
            WeighInSheet(
                initial = open,
                fixedDate = open.date,
                nowMs = nowMs,
                units = store.preferences.units,
                saving = saving,
                refused = refused,
                onSave = { dateLocal, weightKg ->
                    scope.launch {
                        if (saving) return@launch
                        saving = true
                        try {
                            refused = null
                            val failed = store.weighIn(dateLocal, weightKg)
                            if (failed != null) {
                                refused = failed.line("that weigh-in stayed on this device")
                                return@launch
                            }
                            close()
                        } finally {
                            saving = false
                        }
                    }
                },
                onDelete = {
                    scope.launch {
                        say(null)
                        store.deleteWeighIn(open.dateLocal)
                        close()
                    }
                },
            )
        }
    }
}

// Two values, hand-drawn in the units row's own shape and read as one radio group: the picked one
// says so in the semantics tree as well as in colour. The active one is printed beneath the row.
@Composable
private fun WindowControl(window: ChartWindow, onPick: (ChartWindow) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .clip(RoundedCornerShape(WindmillRadius.full))
            .background(GymSkin.surface)
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.full))
            .padding(WindmillSpace.x1)
            .selectableGroup(),
    ) {
        ChartWindow.entries.forEach { entry ->
            val picked = entry == window
            Box(
                Modifier
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.full))
                    .background(if (picked) GymSkin.accent else Color.Transparent)
                    .selectable(selected = picked, role = Role.RadioButton) { onPick(entry) }
                    .padding(horizontal = WindmillSpace.x4),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    entry.label,
                    style = GymType.numeral(13, FontWeight.Bold),
                    color = if (picked) GymSkin.onAccent else GymSkin.inkDim,
                )
            }
        }
    }
}

private val chartHeight = 220.dp
private val plotInset = 14.dp
private val axisWidth = 48.dp

// The x-axis is the window: its last 90 days, or the whole series' first day to today. The y-axis is
// the series' own floor and ceiling. Every dot is also a target that names itself, 46 dp tall and as
// wide as the plot lets it be: the targets share the width at the midpoints between neighbours, so
// the nearest dot takes the tap and no two targets overlap. Dots a day apart at the 90-day scale are
// 3 dp apart, and a 46 dp circle on each would hand a tap to whichever neighbour was drawn last.
@Composable
private fun DotChart(
    entries: List<WeighIn>,
    runs: List<ChartRun>,
    window: ChartWindow,
    today: LocalDate,
    onDot: (WeighIn) -> Unit,
) {
    val axis = Bodyweight.axis(entries) ?: return
    val start = if (window == ChartWindow.Ninety) today.minusDays(89) else entries.first().date
    val span = maxOf(1L, ChronoUnit.DAYS.between(start, today))
    fun xFraction(date: LocalDate): Float =
        if (span == 1L && start == today) 0.5f
        else (ChronoUnit.DAYS.between(start, date).toFloat() / span).coerceIn(0f, 1f)

    Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
        Row(Modifier.fillMaxWidth().height(chartHeight)) {
            Column(Modifier.width(axisWidth).height(chartHeight), verticalArrangement = Arrangement.SpaceBetween) {
                Text(Bodyweight.axisLabel(axis.ceilingKg), style = GymType.numeral(11), color = GymSkin.inkFaint)
                Text(Bodyweight.axisLabel(axis.floorKg), style = GymType.numeral(11), color = GymSkin.inkFaint)
            }
            BoxWithConstraints(Modifier.weight(1f).height(chartHeight)) {
                val width = maxWidth
                fun xDp(date: LocalDate): Dp = plotInset + (width - plotInset * 2) * xFraction(date)
                fun yDp(kg: Double): Dp = plotInset + (chartHeight - plotInset * 2) * (1f - axis.fraction(kg))
                Canvas(Modifier.fillMaxSize()) {
                    val top = plotInset.toPx()
                    val bottom = size.height - plotInset.toPx()
                    drawLine(GymSkin.line, Offset(0f, top), Offset(size.width, top), strokeWidth = 1.dp.toPx())
                    drawLine(GymSkin.line, Offset(0f, bottom), Offset(size.width, bottom), strokeWidth = 1.dp.toPx())
                    val dashed = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))
                    runs.forEach { run ->
                        when (run) {
                            is ChartRun.Segment -> drawLine(
                                GymSkin.accent,
                                Offset(xDp(run.from.date).toPx(), yDp(run.from.weightKg).toPx()),
                                Offset(xDp(run.to.date).toPx(), yDp(run.to.weightKg).toPx()),
                                strokeWidth = 2.dp.toPx(),
                            )
                            // The gap is marked where it is, not joined: a short dashed run along
                            // the baseline from the last dot before it to the first dot after.
                            is ChartRun.Gap -> drawLine(
                                GymSkin.inkFaint,
                                Offset(xDp(run.from.date).toPx(), bottom),
                                Offset(xDp(run.to.date).toPx(), bottom),
                                strokeWidth = 1.5.dp.toPx(),
                                pathEffect = dashed,
                            )
                        }
                    }
                    entries.forEach { dot ->
                        drawCircle(GymSkin.ink, radius = 4.dp.toPx(),
                            center = Offset(xDp(dot.date).toPx(), yDp(dot.weightKg).toPx()))
                    }
                }
                val xs = entries.map { xDp(it.date) }
                entries.forEachIndexed { index, dot ->
                    val x = xs[index]
                    val left = maxOf(x - GymTap.minimum / 2, xs.getOrNull(index - 1)?.let { (it + x) / 2 } ?: 0.dp)
                    val right = minOf(x + GymTap.minimum / 2, xs.getOrNull(index + 1)?.let { (x + it) / 2 } ?: width)
                    val top = yDp(dot.weightKg) - GymTap.minimum / 2
                    val label = "${Bodyweight.kilograms(dot.weightKg)} ${Bodyweight.unit} · ${Bodyweight.shortDay(dot.date)}"
                    Box(
                        Modifier
                            .offset { IntOffset(left.roundToPx(), top.roundToPx()) }
                            .size(width = right - left, height = GymTap.minimum)
                            .semantics { contentDescription = label }
                            .clickable(onClickLabel = "fix this weigh-in") { onDot(dot) },
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = axisWidth)) {
            Text(Bodyweight.shortDay(start), style = GymType.numeral(11), color = GymSkin.inkFaint)
            Spacer(Modifier.weight(1f))
            Text(Bodyweight.shortDay(today), style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        val gaps = runs.filterIsInstance<ChartRun.Gap>()
        if (gaps.isNotEmpty()) {
            GapLabels(
                gaps = gaps,
                midpoint = { gap ->
                    (xFraction(gap.from.date) + xFraction(gap.to.date)) / 2
                },
                modifier = Modifier.fillMaxWidth().padding(start = axisWidth),
            )
        }
    }
}

// One label per gap, centred under the gap's midpoint on the plot's own x scale and kept inside the
// plot's width. A label that would sit on top of an earlier one drops to the next line.
@Composable
private fun GapLabels(
    gaps: List<ChartRun.Gap>,
    midpoint: (ChartRun.Gap) -> Float,
    modifier: Modifier = Modifier,
) {
    Layout(
        content = {
            gaps.forEach { gap ->
                Text(gap.label, style = GymType.numeral(12), color = GymSkin.inkFaint, maxLines = 1)
            }
        },
        modifier = modifier,
    ) { measurables, constraints ->
        val width = constraints.maxWidth
        val inset = plotInset.roundToPx()
        val plotWidth = width - inset * 2
        val placeables = measurables.map { it.measure(Constraints(maxWidth = width)) }
        val lineHeight = placeables.maxOfOrNull { it.height } ?: 0
        val gapPx = 8.dp.roundToPx()
        val lines = mutableListOf<Int>()   // the right edge each line has been filled to
        val placed = placeables.mapIndexed { index, label ->
            val centre = inset + (plotWidth * midpoint(gaps[index])).toInt()
            val x = (centre - label.width / 2).coerceIn(0, maxOf(0, width - label.width))
            val line = lines.indexOfFirst { filledTo -> x >= filledTo + gapPx }
                .takeIf { it >= 0 } ?: lines.size.also { lines += Int.MIN_VALUE }
            lines[line] = x + label.width
            Triple(label, x, line * lineHeight)
        }
        layout(width, lineHeight * lines.size) {
            placed.forEach { (label, x, y) -> label.placeRelative(x, y) }
        }
    }
}
