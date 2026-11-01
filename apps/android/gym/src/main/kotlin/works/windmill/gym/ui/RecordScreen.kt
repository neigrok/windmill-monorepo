package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.ZoneId
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import works.windmill.gym.presentation.*
import works.windmill.gym.presentation.Record
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordScreen(exerciseId: String, store: TrainingStore, backTo: String, onBack: () -> Unit,
    onDraftOpen: (Boolean) -> Unit = {}, focusSessionId: String? = null, now: () -> Long = System::currentTimeMillis) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val nowMs = remember(exerciseId, store.history.progress?.asOf) { now() }
    val zone = ZoneId.systemDefault()
    var record by remember(exerciseId) { mutableStateOf<MovementRecord?>(null) }
    var failure by remember(exerciseId) { mutableStateOf<WriteFailure?>(null) }
    var asked by remember(exerciseId) { mutableIntStateOf(0) }
    var menu by remember(exerciseId) { mutableStateOf(false) }
    var renaming by rememberSaveable(exerciseId) { mutableStateOf(false) }
    var draft by rememberSaveable(exerciseId) { mutableStateOf("") }
    var equipment by rememberSaveable(exerciseId) { mutableStateOf("") }
    var loadCount by rememberSaveable(exerciseId) { mutableIntStateOf(1) }
    var openedName by rememberSaveable(exerciseId) { mutableStateOf("") }
    var openedEquipment by rememberSaveable(exerciseId) { mutableStateOf("") }
    var openedCount by rememberSaveable(exerciseId) { mutableIntStateOf(1) }
    var openedAccount by rememberSaveable(exerciseId) { mutableStateOf("") }
    var openedReplica by rememberSaveable(exerciseId) { mutableStateOf<String?>(null) }
    var refused by rememberSaveable(exerciseId) { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    val currentDraftOpen by rememberUpdatedState(onDraftOpen)
    DisposableEffect(renaming) {
        currentDraftOpen(renaming)
        onDispose { currentDraftOpen(false) }
    }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !saving })
    fun close() {
        if (saving || closing) return
        closing = true
        scope.launch {
            try { sheetState.hide(); renaming = false; refused = null }
            finally { closing = false }
        }
    }
    LaunchedEffect(exerciseId, asked) {
        failure = null
        coroutineScope {
            val data = async { store.history.loadProgress(force = asked > 0) }
            when (val read = store.history.record(exerciseId)) {
                is GymResult.Ok -> record = read.value
                is GymResult.Failed -> failure = read.why
            }
            when (val read = data.await()) {
                is GymResult.Ok -> Unit
                is GymResult.Failed -> failure = read.why
            }
        }
    }
    val progress = store.history.progress?.movement(exerciseId)
    val ready = record != null && progress != null && failure == null && store.history.progressFailure == null
    GymScreen(title = record?.exercise?.name ?: Readout.movement(exerciseId, store.routines.catalog),
        onBack = onBack, backTo = backTo,
        actions = { if (ready) Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, contentDescription = "More") }
            GymMenu(menu, { menu = false }) {
                GymMenuItem("Edit movement", rememberVectorPainter(Icons.Outlined.Edit), onClick = {
                    menu = false
                    val exercise = record!!.exercise
                    draft = exercise.name; equipment = exercise.equipment; loadCount = exercise.loadCount
                    openedName = exercise.name; openedEquipment = exercise.equipment; openedCount = exercise.loadCount
                    openedAccount = store.seat.accountKey; openedReplica = store.seat.replica
                    refused = null; renaming = true
                }, modifier = Modifier.widthIn(min = 208.dp))
            }
        } }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)
            .padding(top = 4.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            when {
                failure != null || store.history.progressFailure != null -> {
                    Text("Record unavailable", style = WindmillFont.body(24, FontWeight.Bold), color = skin.ink)
                    Text((failure ?: store.history.progressFailure)!!.line("Your record could not be read."), style = WindmillFont.body(16), color = skin.inkDim)
                    TextButton(onClick = { asked += 1 }) { Text("Try again") }
                }
                ready -> RecordBody(Record.page(record!!, nowMs, progress!!), record!!.exercise.equipment, progress, nowMs, zone, focusSessionId)
                else -> Text("Reading your log…", style = WindmillFont.body(16), color = skin.inkDim)
            }
        }
    }
    val read = record
    if (renaming && read != null) {
        WindmillSheet(onDismissRequest = { close() }, onBack = { close() }, sheetState = sheetState,
            containerColor = skin.surface, scrimColor = skin.scrim,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            dragHandle = {
                Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(32.dp).height(4.dp).background(skin.inkDim, RoundedCornerShape(2.dp)))
                }
            }) {
            BackHandler(saving || closing) {}
            val base = read.exercise.copy(name = openedName, equipment = openedEquipment, loadCount = openedCount)
            EditMovementSheet(base, draft, equipment, loadCount, refused,
                onName = { if (!saving && !closing) { draft = it; refused = null } },
                onEquipment = { if (!saving && !closing) {
                    val original = works.windmill.gym.domain.sync.ExerciseRules.loadingChoice(openedEquipment, openedCount)
                    equipment = if (it == original) openedEquipment else it
                    loadCount = if (it == original) openedCount else if (it == "dumbbell") 2 else 1
                    refused = null
                } },
                onSave = {
                    if (!saving && !closing) {
                        saving = true
                        scope.launch {
                            try {
                                when (val result = store.history.edit(exerciseId, draft, equipment, loadCount, base, openedAccount, openedReplica)) {
                                    is GymResult.Failed -> refused = result.why.line("that movement was not changed.")
                                    is GymResult.Ok -> {
                                        if (store.seat.accountKey == openedAccount && store.seat.replica == openedReplica) {
                                            record = read.copy(exercise = result.value)
                                            asked += 1
                                        }
                                        saving = false
                                        close()
                                    }
                                }
                            } finally { saving = false }
                        }
                    }
                }, saving = saving || closing)
        }
    }
}

@Composable
private fun RecordBody(page: Record.Page, equipment: String, progress: MovementProgress, nowMs: Long, zone: ZoneId, focusSessionId: String?) {
    val skin = LocalGymColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        EquipmentIcon(equipment, Modifier.size(20.dp), tint = skin.inkDim)
        Text(page.subhead, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
    }
    page.nothingYet?.let { Text(it, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim); return }
    if (page.tiles.isNotEmpty()) {
        if (GymTextScale.stacked) Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.fillMaxWidth()) }
        } else Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.weight(1f)) }
        }
    }
    if (page.strength) StrengthChart(progress, nowMs, zone, focusSessionId)
    page.noEstimate?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim) }
    if (page.records.isNotEmpty()) {
        Text("Earlier records", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
        page.records.forEach { mark ->
            Column(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(16.dp))
                .padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("${mark.effort} · ${mark.estimate}", style = WindmillFont.body(15, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
                Text(mark.day, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
            }
        }
    }
    if (page.days.isNotEmpty()) {
        Text("Recent sets", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp), color = skin.ink)
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            page.days.forEach { day -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(day.day.replaceFirstChar { it.titlecase() }, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                Text(day.sets, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.ink)
            } }
        }
    }
}

@Composable
private fun RecordMetric(tile: Record.Tile, modifier: Modifier) {
    val skin = LocalGymColors.current
    Column(modifier.background(skin.surface, RoundedCornerShape(20.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(tile.label, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        Text(tile.value, style = WindmillFont.body(30, FontWeight.ExtraBold).copy(lineHeight = 36.sp), color = if (tile.loud) skin.prInk else skin.ink)
        Text(tile.caption, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StrengthChart(progress: MovementProgress, nowMs: Long, zone: ZoneId, focusSessionId: String?) {
    val skin = LocalGymColors.current
    val focus = progressSeries(progress, nowMs, zone, all = true).ordered.firstOrNull { it.id == focusSessionId }
    var all by rememberSaveable(progress.exerciseId, focusSessionId) {
        mutableStateOf(focus != null && progress.window(nowMs, zone).sessions.none { it.id == focus.id })
    }
    val window = if (all) progress else progress.window(nowMs, zone)
    val series = progressSeries(window, nowMs, zone, all)
    val initial = series.ordered.firstOrNull { it.id == focusSessionId }
    var inspected by remember(series, focusSessionId) { mutableStateOf(initial) }
    val shown = inspected ?: series.ordered.lastOrNull()
    val point = window.estimates.firstOrNull { it.id == shown?.id }
    Column(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(20.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Estimated strength", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(false to "12 weeks", true to "All").forEach { (value, label) ->
                SegmentedButton(selected = all == value, onClick = { all = value },
                    shape = SegmentedButtonDefaults.itemShape(if (value) 1 else 0, 2),
                    border = androidx.compose.foundation.BorderStroke(1.dp, skin.line),
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = skin.raised, activeContentColor = skin.ink,
                        inactiveContainerColor = androidx.compose.ui.graphics.Color.Transparent, inactiveContentColor = skin.ink),
                    label = { Text(label, style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 14.sp,
                        lineHeight = 20.sp, letterSpacing = .1.sp, fontWeight = FontWeight.Medium)) })
            }
        }
        point?.let {
            Text(progressReading(it, nowMs), style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp),
                color = if (it.id == progress.best?.id) skin.prInk else skin.ink)
        }
        if (window.hasChart(zone)) DatedPlot(series, minHeight = 168.dp,
            labelStyle = WindmillFont.body(11).copy(lineHeight = 14.sp), initialPointId = initial?.id,
            interaction = PlotInteraction.Inspect, standingBestId = progress.best?.id,
            onInspect = { inspected = it }, gapLabel = { a, b -> "No workout · ${Readout.date(a.atMs)} – ${Readout.date(b.atMs)}" })
        Text("${if (all) "All" else "Last 12 weeks"} · ${Readout.sessionCount(window.sessions.size)}",
            style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        if (window.estimatesComplete && window.estimates.isEmpty()) Text("No eligible estimate in this window.", style = WindmillFont.body(14), color = skin.inkDim)
    }
}
