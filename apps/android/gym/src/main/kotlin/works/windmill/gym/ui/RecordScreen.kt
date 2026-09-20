package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.ZoneId
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import works.windmill.gym.domain.*
import works.windmill.gym.domain.Record
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordScreen(exerciseId: String, store: TrainingStore, backTo: String, onBack: () -> Unit) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val nowMs = remember(exerciseId, store.progress?.asOf) { System.currentTimeMillis() }
    val zone = ZoneId.systemDefault()
    var record by remember(exerciseId) { mutableStateOf<MovementRecord?>(null) }
    var failure by remember(exerciseId) { mutableStateOf<WriteFailure?>(null) }
    var asked by remember(exerciseId) { mutableIntStateOf(0) }
    var renaming by rememberSaveable(exerciseId) { mutableStateOf(false) }
    var draft by rememberSaveable(exerciseId) { mutableStateOf("") }
    var refused by rememberSaveable(exerciseId) { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
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
            val data = async { store.loadProgress(force = asked > 0) }
            when (val read = store.record(exerciseId)) {
                is GymResult.Ok -> record = read.value
                is GymResult.Failed -> failure = read.why
            }
            when (val read = data.await()) {
                is GymResult.Ok -> Unit
                is GymResult.Failed -> failure = read.why
            }
        }
    }
    val progress = store.progress?.movement(exerciseId)
    val ready = record != null && progress != null && failure == null && store.progressFailure == null
    GymScreen(title = record?.exercise?.name ?: Readout.movement(exerciseId, store.catalog),
        onBack = onBack, backTo = backTo,
        actions = { if (ready) TopAction("Rename") { draft = record!!.exercise.name; refused = null; renaming = true } }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)
            .padding(top = 12.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            when {
                failure != null || store.progressFailure != null -> {
                    Text("Record unavailable", style = WindmillFont.body(24, FontWeight.Bold), color = skin.ink)
                    Text((failure ?: store.progressFailure)!!.line("Your record could not be read."), style = WindmillFont.body(16), color = skin.inkDim)
                    TextButton(onClick = { asked += 1 }) { Text("Try again") }
                }
                ready -> RecordBody(Record.page(record!!, nowMs, progress!!), progress, nowMs, zone)
                else -> Text("Reading your log…", style = WindmillFont.body(16), color = skin.inkDim)
            }
        }
    }
    val read = record
    if (renaming && read != null) {
        ModalBottomSheet(onDismissRequest = { close() }, sheetState = sheetState,
            properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
            containerColor = skin.surface, scrimColor = skin.scrim) {
            WindmillSheetWindow()
            WindmillSheetBack(onDismiss = { close() }) {
                BackHandler(saving || closing) {}
                RenameSheet("Rename movement", read.exercise.name, draft,
                    store.renameKeepsAnAlias(exerciseId), refused,
                    onValue = { if (!saving && !closing) { draft = it; refused = null } },
                    onRename = {
                        if (!saving && !closing) {
                            saving = true
                            scope.launch {
                                try {
                                    when (val result = store.rename(exerciseId, draft)) {
                                        is GymResult.Failed -> refused = result.why.line("That movement kept its name.")
                                        is GymResult.Ok -> {
                                            record = read.copy(exercise = result.value)
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
}

@Composable
private fun RecordBody(page: Record.Page, progress: MovementProgress, nowMs: Long, zone: ZoneId) {
    val skin = LocalGymColors.current
    Text(page.subhead, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
    page.nothingYet?.let { Text(it, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim); return }
    if (page.tiles.isNotEmpty()) {
        if (LocalDensity.current.fontScale >= 1.5f) Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.fillMaxWidth()) }
        } else Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.weight(1f)) }
        }
    }
    if (progress.estimates.isNotEmpty()) StrengthChart(progress, nowMs, zone)
    page.noEstimate?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim) }
    if (page.records.size > 1) {
        Text("Personal records", style = WindmillFont.body(18, FontWeight.Bold), color = skin.ink)
        page.records.forEach { mark ->
            Column(Modifier.fillMaxWidth().background(if (mark.standing) skin.prSoft else skin.surface,
                RoundedCornerShape(12.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("${mark.effort} · ${mark.estimate}", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                Text(mark.day, style = WindmillFont.body(14), color = skin.inkDim)
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
    Column(modifier.heightIn(min = 136.dp).background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(tile.label, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        Text(tile.value, style = WindmillFont.display(40).copy(lineHeight = 56.sp), color = if (tile.loud) skin.prInk else skin.ink)
        Text(tile.caption, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StrengthChart(progress: MovementProgress, nowMs: Long, zone: ZoneId) {
    val skin = LocalGymColors.current
    var all by rememberSaveable(progress.exerciseId) { mutableStateOf(false) }
    val window = if (all) progress else progress.window(nowMs, zone)
    var inspected by remember(window) { mutableStateOf<DatedPoint?>(null) }
    val point = window.estimates.firstOrNull { it.id == inspected?.id } ?: window.latest
    Column(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(20.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Estimated strength", style = WindmillFont.body(18, FontWeight.Bold), color = skin.ink)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(false to "12 weeks", true to "All").forEach { (value, label) ->
                SegmentedButton(selected = all == value, onClick = { all = value },
                    shape = RoundedCornerShape(24.dp), icon = {}, border = androidx.compose.foundation.BorderStroke(0.dp, androidx.compose.ui.graphics.Color.Transparent),
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = skin.raised, activeContentColor = skin.ink,
                        inactiveContainerColor = androidx.compose.ui.graphics.Color.Transparent, inactiveContentColor = skin.ink),
                    label = { Text(label, style = WindmillFont.body(14, FontWeight.Bold)) })
            }
        }
        point?.let {
            Text(progressReading(it, nowMs), style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp),
                color = if (it.id == progress.best?.id) skin.prInk else skin.ink)
        }
        if (window.hasChart(zone)) DatedPlot(progressSeries(window, nowMs, zone, all),
            interaction = PlotInteraction.Inspect, standingBestId = progress.best?.id,
            onInspect = { inspected = it }, gapLabel = { a, b -> "No session · ${Readout.date(a.atMs)} – ${Readout.date(b.atMs)}" })
        Text("${if (all) "All" else "Last 12 weeks"} · ${Readout.sessionCount(window.sessions.size)}",
            style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        if (window.estimates.isEmpty()) Text("No eligible estimate in this window.", style = WindmillFont.body(14), color = skin.inkDim)
    }
}
