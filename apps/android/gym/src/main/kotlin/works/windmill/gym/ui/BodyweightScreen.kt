package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.key
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.launch
import works.windmill.gym.presentation.Bodyweight
import works.windmill.gym.presentation.ChartWindow
import works.windmill.gym.presentation.DatedPoint
import works.windmill.gym.presentation.DatedSeries
import works.windmill.gym.presentation.ParsedWeight
import works.windmill.gym.presentation.WeighIn
import works.windmill.gym.store.BodyweightStore
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeletionsStore
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.design.WindmillFont

// What the bodyweight page draws: the drawn series, the series a held delete still stands on, and whether it is read.
@Stable
interface BodyweightState {
    val weighIns: List<WeighIn>
    val allWeighIns: List<WeighIn>
    val bodyweightRead: Boolean
}

// What the bodyweight page asks of the stores.
interface BodyweightEvents {
    suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure?
    fun withhold(deletion: Deletion.Bodyweight)
}

// The bodyweight page over the room's stores.
class BodyweightBinding(private val bodyweight: BodyweightStore, private val deletions: DeletionsStore) : BodyweightState, BodyweightEvents {
    constructor(store: TrainingStore) : this(store.bodyweight, store.deletions)

    override val weighIns: List<WeighIn> get() = bodyweight.drawn
    override val allWeighIns: List<WeighIn> get() = bodyweight.allWeighIns
    override val bodyweightRead: Boolean get() = bodyweight.bodyweightRead

    override suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? = bodyweight.weighIn(dateLocal, weightKg)
    override fun withhold(deletion: Deletion.Bodyweight) = deletions.withhold(deletion)
}

@Composable
internal fun WeighInHandle() {
    Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(32.dp, 4.dp).background(LocalGymColors.current.inkDim, RoundedCornerShape(100.dp)))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WeighInSheet(
    initial: WeighIn?,
    fixedDate: LocalDate?,
    nowMs: Long,
    saving: Boolean,
    refused: String?,
    onSave: (String, Double) -> Unit,
    onDelete: (() -> Unit)?,
    draftKey: String = fixedDate?.toString() ?: "new",
) {
    val skin = LocalGymColors.current
    val telemetry = LocalTelemetry.current
    val today = Bodyweight.today(nowMs)
    var typed by rememberSaveable(draftKey) { mutableStateOf(initial?.let { Bodyweight.kilograms(it.weightKg) } ?: "") }
    var dateLocal by rememberSaveable(draftKey) { mutableStateOf((fixedDate ?: initial?.date ?: today).toString()) }
    var edited by rememberSaveable(draftKey) { mutableStateOf(false) }
    var pickingDate by rememberSaveable(draftKey) { mutableStateOf(false) }
    var submitted by remember(draftKey) { mutableStateOf(false) }
    val date = fixedDate ?: LocalDate.parse(dateLocal)
    val parsed = Bodyweight.parse(typed)
    val weightFailure = (parsed as? ParsedWeight.Refused)?.said?.takeIf { edited }
    val dateFailure = Bodyweight.dated(date, today)
    val otherFailure = if (weightFailure == null) dateFailure ?: refused else null
    val busy = saving || submitted
    val correction = fixedDate != null
    val gap = if (correction) 10.dp else 8.dp
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    BackHandler(enabled = busy) {}
    LaunchedEffect(submitted, saving, refused) { if (!saving && refused != null) submitted = false }
    LaunchedEffect(draftKey) {
        if (!pickingDate) {
            focus.requestFocus()
            keyboard?.show()
        }
    }

    fun save() {
        if (busy) return
        edited = true
        if (parsed !is ParsedWeight.Ok || dateFailure != null) return
        submitted = true
        onSave(date.toString(), parsed.weightKg)
    }
    fun cancelDate() {
        if (!pickingDate) return
        pickingDate = false
        telemetry.event("gym_action", mapOf("screen" to "bodyweight", "action" to "calendar_cancel", "outcome" to "ok"))
    }

    if (pickingDate) {
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                    !LocalDate.ofEpochDay(Math.floorDiv(utcTimeMillis, 86_400_000)).isAfter(today)
                override fun isSelectableYear(year: Int): Boolean = year <= today.year
            },
        )
        val staged = picker.selectedDateMillis?.let { LocalDate.ofEpochDay(Math.floorDiv(it, 86_400_000)) }
        val usable = staged != null && Bodyweight.dated(staged, today) == null
        DatePickerDialog(onDismissRequest = ::cancelDate,
            confirmButton = {
                TextButton(onClick = {
                    if (staged != null && usable) {
                        dateLocal = staged.toString()
                        pickingDate = false
                        telemetry.event("gym_action", mapOf("screen" to "bodyweight", "action" to "calendar_confirm", "outcome" to "ok"))
                    }
                }, enabled = usable) { Text("Use date") }
            },
            dismissButton = { TextButton(onClick = ::cancelDate) { Text("Cancel") } },
        ) { DatePicker(state = picker, modifier = Modifier.testTag("weigh-in-calendar")) }
    }

    Column(Modifier.fillMaxWidth().testTag("weigh-in-form").background(skin.surface).imePadding().navigationBarsPadding()) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp).padding(top = gap, bottom = if (correction) 24.dp else 8.dp),
            verticalArrangement = Arrangement.spacedBy(gap)) {
            Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.CenterStart) {
                Text(Bodyweight.chip, style = WindmillFont.body(22, FontWeight.ExtraBold).copy(lineHeight = 30.sp), color = skin.ink)
            }
            Text("Weight", style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = skin.inkDim)
            OutlinedTextField(value = typed, onValueChange = { typed = it; edited = true },
                singleLine = true, enabled = !busy, isError = weightFailure != null,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Default, lineHeight = 24.sp),
                suffix = { Text(Bodyweight.unit, style = WindmillFont.body(16).copy(lineHeight = 24.sp), color = skin.inkDim) },
                supportingText = weightFailure?.let { line -> { Text(line, modifier = Modifier.padding(bottom = 6.dp).semantics { liveRegion = LiveRegionMode.Polite }) } },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { save() }),
                shape = RoundedCornerShape(4.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent, errorContainerColor = Color.Transparent,
                    focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, disabledTextColor = skin.inkDim,
                    errorTextColor = skin.ink, cursorColor = skin.accent,
                    focusedBorderColor = skin.accent, unfocusedBorderColor = skin.lineStrong,
                    disabledBorderColor = skin.lineStrong, errorBorderColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).focusRequester(focus)
                    .semantics { contentDescription = weightField; weightFailure?.let { error(it) } },
            )
            if (correction) Text("Date", style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = skin.inkDim)
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val stacked = maxWidth < 320.dp || GymTextScale.stacked
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(12.dp))
                    .background(skin.canvas)
                    .then(if (!correction) Modifier.clickable(enabled = !busy, role = Role.Button,
                        onClickLabel = "Choose date") {
                        focusManager.clearFocus()
                        keyboard?.hide()
                        pickingDate = true
                        telemetry.event("gym_action", mapOf("screen" to "bodyweight", "action" to "calendar_open", "outcome" to "ok"))
                    } else Modifier)
                    .semantics(mergeDescendants = true) {
                        contentDescription = "Date, ${Bodyweight.fullDay(date)}"
                        dateFailure?.let { error(it) }
                    }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (stacked) Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (!correction) Text("Date", style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = skin.inkDim)
                        Text(Bodyweight.fullDay(date), style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = if (correction) skin.inkDim else skin.ink)
                    } else {
                        if (!correction) Text("Date", style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = skin.inkDim)
                        Text(Bodyweight.fullDay(date), modifier = Modifier.weight(1f), textAlign = if (correction) TextAlign.Start else TextAlign.Center, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = if (correction) skin.inkDim else skin.ink)
                    }
                    if (!correction) Icon(Icons.Default.DateRange, null, Modifier.size(24.dp), tint = skin.ink)
                }
            }
            otherFailure?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 20.sp), color = MaterialTheme.colorScheme.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = if (correction) 10.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(gap)) {
            Button(onClick = ::save, enabled = !busy && parsed is ParsedWeight.Ok && dateFailure == null,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = skin.accent, contentColor = skin.onAccent)) {
                Text(if (busy) "Saving…" else Bodyweight.save, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp))
            }
            onDelete?.let { GymErrorTextButton(Bodyweight.deleteRow, it, Modifier.fillMaxWidth(), enabled = !busy) }
        }
    }
}

const val weightField = "weight in kilograms"

private val weighInSaver = listSaver<WeighIn?, Any?>(
    save = { it?.let { entry -> listOf(entry.dateLocal, entry.weightKg, entry.recordedAt) } ?: emptyList() },
    restore = { if (it.isEmpty()) null else WeighIn(it[0] as String, it[1] as Double, it[2] as Long?) },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BodyweightScreen(state: BodyweightState, events: BodyweightEvents, backTo: String, onBack: () -> Unit, say: (String?) -> Unit,
    onDraftOpen: (Boolean) -> Unit = {}) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    val today = Bodyweight.today(nowMs)
    var window by rememberSaveable { mutableStateOf(ChartWindow.Ninety) }
    var repairing by rememberSaveable(stateSaver = weighInSaver) { mutableStateOf<WeighIn?>(null) }
    val currentDraftOpen by rememberUpdatedState(onDraftOpen)
    DisposableEffect(repairing) {
        currentDraftOpen(repairing != null)
        onDispose { currentDraftOpen(false) }
    }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var refused by rememberSaveable { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !saving })
    val sheetStates = rememberSaveableStateHolder()
    val rows = Bodyweight.windowed(state.weighIns, ChartWindow.All, today)
    val standing = Bodyweight.windowed(state.allWeighIns, ChartWindow.All, today)
    val shown = Bodyweight.windowed(rows, window, today)

    fun close(after: () -> Unit = {}) {
        if (saving || closing) return
        closing = true
        scope.launch {
            try {
                sheetState.hide()
                repairing?.let { sheetStates.removeState(it.dateLocal) }
                repairing = null
                refused = null
                after()
            } finally { closing = false }
        }
    }

    GymScreen(title = Bodyweight.title, onBack = onBack, backTo = backTo) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!state.bodyweightRead) {
                Text("Reading your weigh-ins…", style = WindmillFont.body(16), color = skin.inkDim)
            }
            if (standing.isEmpty()) {
                if (state.bodyweightRead) {
                    Text(Bodyweight.nothingYet, style = WindmillFont.body(16), color = skin.inkDim)
                }
            } else {
                if (state.bodyweightRead) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(skin.surface).padding(horizontal = 16.dp).padding(top = 12.dp, bottom = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            ChartWindow.entries.forEachIndexed { index, option ->
                                SegmentedButton(selected = window == option, onClick = { window = option },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                    shape = SegmentedButtonDefaults.itemShape(index, ChartWindow.entries.size),
                                    label = { Text(option.label, style = MaterialTheme.typography.labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp)) })
                            }
                        }
                        if (shown.isNotEmpty()) {
                            val zone = ZoneId.systemDefault()
                            val from = if (window == ChartWindow.Ninety) today.minusDays(89) else shown.first().date
                            val series = DatedSeries(shown.map { entry ->
                                DatedPoint(entry.dateLocal, entry.date.atStartOfDay(zone).toInstant().toEpochMilli(), entry.weightKg,
                                    "${Bodyweight.kilograms(entry.weightKg)} kg · ${Bodyweight.listDay(entry.date)}")
                            }, from.atStartOfDay(zone).toInstant().toEpochMilli(), today.atStartOfDay(zone).toInstant().toEpochMilli(),
                                zone, Bodyweight.maxGapDays)
                            DatedPlot(series, interaction = PlotInteraction.Select, valueLabel = Bodyweight::kilograms,
                                gapLabel = { before, after ->
                                    val first = LocalDate.parse(before.id)
                                    val last = LocalDate.parse(after.id)
                                    if (first.year == last.year) "no weigh-in · ${Bodyweight.shortDay(first)} – ${Bodyweight.shortDay(last)}"
                                    else "no weigh-in · ${Bodyweight.listDay(first)} – ${Bodyweight.listDay(last)}"
                                },
                                onSelect = { point -> repairing = rows.firstOrNull { it.dateLocal == point.id } })
                        } else if (window == ChartWindow.Ninety && Bodyweight.windowed(standing, window, today).isEmpty()) {
                            Text(Bodyweight.noneInWindow, style = WindmillFont.body(16), color = skin.inkDim)
                        }
                        Text(Bodyweight.windowLine(window, shown.size), style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                    }
                }
                if (rows.isNotEmpty()) {
                    Text("Every weigh-in", style = WindmillFont.body(18, FontWeight.ExtraBold).copy(lineHeight = 24.sp), color = skin.ink)
                    rows.asReversed().forEach { entry ->
                        key(entry.dateLocal) {
                            DeleteSwipeRow(Bodyweight.deleteRow, onDelete = {
                                say(null)
                                events.withhold(Deletion.Bodyweight(entry.dateLocal))
                                false
                            }) {
                                Row(Modifier.fillMaxWidth().heightIn(min = 70.dp).background(skin.canvas)
                                    .clickable(role = Role.Button, onClickLabel = "Correct weigh-in") { repairing = entry }
                                    .padding(start = 12.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text("${Bodyweight.kilograms(entry.weightKg)} kg", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
                                        Text(Bodyweight.listDay(entry.date), style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                                    }
                                    Chevron()
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    repairing?.let { open ->
        WindmillSheet(onDismissRequest = { close() }, onBack = { close() }, sheetState = sheetState,
            containerColor = skin.surface, scrimColor = skin.scrim,
            dragHandle = { WeighInHandle() }, contentWindowInsets = { WindowInsets(0, 0, 0, 0) }) {
            sheetStates.SaveableStateProvider(open.dateLocal) {
                WeighInSheet(initial = open, fixedDate = open.date, nowMs = nowMs,
                    saving = saving || closing, refused = refused, draftKey = open.dateLocal,
                    onSave = { dateLocal, weightKg ->
                        if (!saving && !closing) {
                            saving = true
                            refused = null
                            scope.launch {
                                try {
                                    val failed = events.weighIn(dateLocal, weightKg)
                                    if (failed != null) refused = failed.line("that weigh-in wasn’t saved")
                                    saving = false
                                    if (failed == null) close()
                                } finally { saving = false }
                            }
                        }
                    },
                    onDelete = { close { say(null); events.withhold(Deletion.Bodyweight(open.dateLocal)) } },
                )
            }
        }
    }
}

private data class BodyweightPreviewState(override val weighIns: List<WeighIn>) : BodyweightState {
    override val allWeighIns: List<WeighIn> get() = weighIns
    override val bodyweightRead: Boolean = true
}

private object BodyweightPreviewEvents : BodyweightEvents {
    override suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? = null
    override fun withhold(deletion: Deletion.Bodyweight) = Unit
}

@Composable
private fun BodyweightPreview(state: BodyweightState) {
    GymPreview { BodyweightScreen(state, BodyweightPreviewEvents, backTo = "The log", onBack = {}, say = {}) }
}

@DarkAndDaylight
@Composable
private fun BodyweightSeriesPreview() {
    val today = LocalDate.now()
    BodyweightPreview(BodyweightPreviewState(listOf(83.4, 83.1, 82.9, 83.0, 82.6, 82.4).mapIndexed { index, kg ->
        WeighIn(today.minusDays(50L - index * 10L).toString(), kg)
    }))
}

@DarkAndDaylight
@Composable
private fun BodyweightEmptyPreview() = BodyweightPreview(BodyweightPreviewState(emptyList()))
