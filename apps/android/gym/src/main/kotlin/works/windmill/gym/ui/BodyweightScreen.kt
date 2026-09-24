package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
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
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ChartWindow
import works.windmill.gym.domain.DatedPoint
import works.windmill.gym.domain.DatedSeries
import works.windmill.gym.domain.ParsedWeight
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow

@Composable
fun WeighInChip(onOpen: () -> Unit) {
    val skin = LocalGymColors.current
    Button(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = skin.raised, contentColor = skin.ink)) {
        Text(Bodyweight.chip, style = WindmillFont.body(16, FontWeight.Bold))
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
    val today = Bodyweight.today(nowMs)
    var typed by rememberSaveable(draftKey) { mutableStateOf(initial?.let { Bodyweight.kilograms(it.weightKg) } ?: "") }
    var dateLocal by rememberSaveable(draftKey) { mutableStateOf((fixedDate ?: initial?.date ?: today).toString()) }
    var said by rememberSaveable(draftKey) { mutableStateOf<String?>(null) }
    var pickingDate by rememberSaveable(draftKey) { mutableStateOf(false) }
    val date = fixedDate ?: LocalDate.parse(dateLocal)
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val failure = said ?: refused
    val dateFailure = failure?.takeIf { it == Bodyweight.notAForecast }
    val weightFailure = failure?.takeUnless { it == Bodyweight.notAForecast }
    BackHandler(enabled = saving) {}

    LaunchedEffect(draftKey) {
        if (!pickingDate) {
            focus.requestFocus()
            keyboard?.show()
        }
    }

    fun save() {
        if (saving) return
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
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                    !LocalDate.ofEpochDay(Math.floorDiv(utcTimeMillis, 86_400_000)).isAfter(today)
            },
        )
        DatePickerDialog(onDismissRequest = { pickingDate = false },
            confirmButton = {
                TextButton(onClick = {
                    picker.selectedDateMillis?.let { dateLocal = LocalDate.ofEpochDay(Math.floorDiv(it, 86_400_000)).toString() }
                    said = null
                    pickingDate = false
                }, enabled = picker.selectedDateMillis != null) { Text("Use this day") }
            },
            dismissButton = { TextButton(onClick = { pickingDate = false }) { Text("Keep it") } },
        ) { DatePicker(state = picker, modifier = Modifier.verticalScroll(rememberScrollState())) }
    }

    Column(Modifier.fillMaxWidth().background(skin.surface).imePadding()) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(Bodyweight.chip, style = WindmillFont.display(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = skin.ink)
            Text("Weight", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            OutlinedTextField(value = typed, onValueChange = { typed = it; said = null },
                singleLine = true, enabled = !saving, isError = weightFailure != null,
                textStyle = WindmillFont.body(18).copy(lineHeight = 24.sp),
                suffix = { Text(Bodyweight.unit, style = WindmillFont.body(18), color = skin.inkDim) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { save() }),
                shape = RoundedCornerShape(20.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = skin.raised, unfocusedContainerColor = skin.raised,
                    disabledContainerColor = skin.raised, errorContainerColor = skin.raised,
                    focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, disabledTextColor = skin.inkDim,
                    errorTextColor = skin.ink, cursorColor = skin.accent,
                    focusedBorderColor = skin.accent, unfocusedBorderColor = Color.Transparent,
                    disabledBorderColor = Color.Transparent, errorBorderColor = skin.alarmInk),
                modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp).focusRequester(focus)
                    .semantics { contentDescription = weightField; weightFailure?.let { error(it) } },
            )
            failure?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.alarmInk,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            Text("Date", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(RoundedCornerShape(20.dp))
                .background(skin.raised)
                .then(if (fixedDate == null) Modifier.clickable(enabled = !saving, role = Role.Button,
                    onClickLabel = "pick the day") {
                    focusManager.clearFocus()
                    keyboard?.hide()
                    pickingDate = true
                } else Modifier)
                .semantics(mergeDescendants = true) {
                    contentDescription = "Date, ${Bodyweight.fullDay(date)}"
                    dateFailure?.let { error(it) }
                }
                .padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(Bodyweight.fullDay(date), style = WindmillFont.body(18).copy(lineHeight = 24.sp), color = skin.ink)
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { save() }, enabled = !saving,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = skin.accent, contentColor = skin.onAccent)) {
                Text(if (saving) "Saving…" else Bodyweight.save, style = WindmillFont.body(16, FontWeight.Bold))
            }
            onDelete?.let {
                TextButton(onClick = it, enabled = !saving, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = skin.ink)) {
                    Text(Bodyweight.deleteRow, style = WindmillFont.body(16, FontWeight.Bold))
                }
            }
        }
    }
}

const val weightField = "weight in kilograms"

private val weighInSaver = listSaver<WeighIn?, Any>(
    save = { it?.let { entry -> listOf(entry.dateLocal, entry.weightKg, entry.recordedAt) } ?: emptyList() },
    restore = { if (it.isEmpty()) null else WeighIn(it[0] as String, it[1] as Double, it[2] as Long) },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BodyweightScreen(store: TrainingStore, backTo: String, onBack: () -> Unit, say: (String?) -> Unit) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    val today = Bodyweight.today(nowMs)
    var window by rememberSaveable { mutableStateOf(ChartWindow.Ninety) }
    var repairing by rememberSaveable(stateSaver = weighInSaver) { mutableStateOf<WeighIn?>(null) }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var refused by rememberSaveable { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !saving })
    val sheetStates = rememberSaveableStateHolder()
    val rows = Bodyweight.windowed(store.bodyweight, ChartWindow.All, today)
    val standing = Bodyweight.windowed(store.allWeighIns, ChartWindow.All, today)
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
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)) {
            if (store.bodyweightLoading || (!store.bodyweightRead && store.bodyweightFailure == null)) {
                Text("Reading your weigh-ins…", style = WindmillFont.body(16), color = skin.inkDim)
            }
            store.bodyweightFailure?.let { failure ->
                Text(failure.line("your weigh-ins didn’t load"), style = WindmillFont.body(16), color = skin.inkDim)
                TextButton(onClick = { scope.launch { store.loadBodyweight() } }, enabled = !store.bodyweightLoading) {
                    Text("Try again")
                }
            }
            if (standing.isEmpty()) {
                if (store.bodyweightRead && !store.bodyweightLoading && store.bodyweightFailure == null) {
                    Text(Bodyweight.nothingYet, style = WindmillFont.body(16), color = skin.inkDim)
                }
            } else {
                if (store.bodyweightRead) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(skin.surface).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth(), space = 8.dp) {
                            ChartWindow.entries.forEach { option ->
                                SegmentedButton(selected = window == option, onClick = { window = option },
                                    modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(16.dp),
                                    border = BorderStroke(0.dp, Color.Transparent), icon = {},
                                    colors = SegmentedButtonDefaults.colors(activeContainerColor = skin.raised,
                                        activeContentColor = skin.ink, inactiveContainerColor = Color.Transparent,
                                        inactiveContentColor = skin.ink),
                                    label = { Text(option.label, style = WindmillFont.body(16, FontWeight.Bold)) })
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
                        } else if (window == ChartWindow.Ninety && store.bodyweightRead && !store.bodyweightLoading &&
                            store.bodyweightFailure == null && Bodyweight.windowed(standing, window, today).isEmpty()) {
                            Text(Bodyweight.noneInWindow, style = WindmillFont.body(16), color = skin.inkDim)
                        }
                        Text(Bodyweight.windowLine(window, shown.size), style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                    }
                }
                if (rows.isNotEmpty()) {
                    Text("Every weigh-in", style = WindmillFont.body(20, FontWeight.Bold).copy(lineHeight = 28.sp), color = skin.ink)
                    rows.asReversed().forEach { entry ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 70.dp)
                            .clickable(role = Role.Button, onClickLabel = "correct this weigh-in") { repairing = entry }
                            .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
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

    repairing?.let { open ->
        ModalBottomSheet(onDismissRequest = { close() }, sheetState = sheetState,
            properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
            containerColor = skin.surface, scrimColor = skin.scrim) {
            WindmillSheetWindow()
            sheetStates.SaveableStateProvider(open.dateLocal) {
                WindmillSheetBack(onDismiss = { close() }) {
                    WeighInSheet(initial = open, fixedDate = open.date, nowMs = nowMs,
                        saving = saving || closing, refused = refused, draftKey = open.dateLocal,
                        onSave = { dateLocal, weightKg ->
                            if (!saving && !closing) {
                                saving = true
                                refused = null
                                scope.launch {
                                    try {
                                        val failed = store.weighIn(dateLocal, weightKg)
                                        if (failed != null) refused = failed.line("that weigh-in wasn’t saved")
                                        saving = false
                                        if (failed == null) close()
                                    } finally { saving = false }
                                }
                            }
                        },
                        onDelete = { close { say(null); store.withhold(Deletion.Bodyweight(open.dateLocal)) } },
                    )
                }
            }
        }
    }
}
