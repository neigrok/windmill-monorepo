package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
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
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import works.windmill.gym.presentation.*
import works.windmill.gym.presentation.Record
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont

// What a movement's record page draws: the account's progress, the catalogue it names movements from, and whose seat it is.
@Stable
interface RecordState {
    val accountKey: String
    val replica: String?
    val progress: StatsProgress?
    val progressFailure: WriteFailure?
    val catalog: List<Exercise>
}

// What a movement's record page asks of the stores.
interface RecordEvents {
    suspend fun loadProgress(force: Boolean): GymResult<StatsProgress>
    suspend fun record(exerciseId: String): GymResult<MovementRecord>
    suspend fun edit(exerciseId: String, name: String, equipment: String?, loadCount: Int?, base: Exercise?,
        expectedAccountKey: String, expectedReplica: String?): GymResult<Exercise>
}

// A movement's record page over the room's stores.
class RecordBinding(private val seat: TrainingSeat, private val history: HistoryReads, private val routines: RoutinesStore) :
    RecordState, RecordEvents {
    constructor(store: TrainingStore) : this(store.seat, store.history, store.routines)

    override val accountKey: String get() = seat.accountKey
    override val replica: String? get() = seat.replica
    override val progress: StatsProgress? get() = history.progress
    override val progressFailure: WriteFailure? get() = history.progressFailure
    override val catalog: List<Exercise> get() = routines.catalog

    override suspend fun loadProgress(force: Boolean): GymResult<StatsProgress> = history.loadProgress(force)
    override suspend fun record(exerciseId: String): GymResult<MovementRecord> = history.record(exerciseId)
    override suspend fun edit(exerciseId: String, name: String, equipment: String?, loadCount: Int?, base: Exercise?,
        expectedAccountKey: String, expectedReplica: String?): GymResult<Exercise> =
        history.edit(exerciseId, name, equipment, loadCount, base, expectedAccountKey, expectedReplica)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordScreen(state: RecordState, events: RecordEvents, exerciseId: String, backTo: String, onBack: () -> Unit,
    onDraftOpen: (Boolean) -> Unit = {}, focusSessionId: String? = null, now: () -> Long = System::currentTimeMillis) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val nowMs = remember(exerciseId, state.progress?.asOf) { now() }
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
            val data = async { events.loadProgress(force = asked > 0) }
            when (val read = events.record(exerciseId)) {
                is GymResult.Ok -> record = read.value
                is GymResult.Failed -> failure = read.why
            }
            when (val read = data.await()) {
                is GymResult.Ok -> Unit
                is GymResult.Failed -> failure = read.why
            }
        }
    }
    val progress = state.progress?.movement(exerciseId)
    val ready = record != null && progress != null && failure == null && state.progressFailure == null
    GymScreen(title = record?.exercise?.name ?: Readout.movement(exerciseId, state.catalog),
        onBack = onBack, backTo = backTo,
        actions = { if (ready) Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, contentDescription = "More") }
            GymMenu(menu, { menu = false }) {
                GymMenuItem("Edit movement", rememberVectorPainter(Icons.Outlined.Edit), onClick = {
                    menu = false
                    val exercise = record!!.exercise
                    draft = exercise.name; equipment = exercise.equipment; loadCount = exercise.loadCount
                    openedName = exercise.name; openedEquipment = exercise.equipment; openedCount = exercise.loadCount
                    openedAccount = state.accountKey; openedReplica = state.replica
                    refused = null; renaming = true
                }, modifier = Modifier.widthIn(min = 208.dp))
            }
        } }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)
            .padding(top = 4.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            when {
                failure != null || state.progressFailure != null -> {
                    Text("Record unavailable", style = WindmillFont.body(24, FontWeight.Bold), color = colors.onSurface)
                    Text((failure ?: state.progressFailure)!!.line("Your record could not be read."), style = WindmillFont.body(16), color = colors.onSurfaceVariant)
                    TextButton(onClick = { asked += 1 }) { Text("Try again") }
                }
                ready -> RecordBody(Record.page(record!!, nowMs, progress!!), record!!.exercise.equipment, progress, nowMs, zone, focusSessionId)
                else -> Text("Reading your log…", style = WindmillFont.body(16), color = colors.onSurfaceVariant)
            }
        }
    }
    val read = record
    if (renaming && read != null) {
        WindmillSheet(onDismissRequest = { close() }, onBack = { close() }, sheetState = sheetState,
            containerColor = colors.surfaceContainer, scrimColor = colors.scrim,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            dragHandle = {
                Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(32.dp).height(4.dp).background(colors.onSurfaceVariant, RoundedCornerShape(2.dp)))
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
                                when (val result = events.edit(exerciseId, draft, equipment, loadCount, base, openedAccount, openedReplica)) {
                                    is GymResult.Failed -> refused = result.why.line("that movement was not changed.")
                                    is GymResult.Ok -> {
                                        if (state.accountKey == openedAccount && state.replica == openedReplica) {
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
    val colors = MaterialTheme.colorScheme
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        EquipmentIcon(equipment, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
        Text(page.subhead, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
    }
    page.nothingYet?.let { Text(it, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = colors.onSurfaceVariant); return }
    if (page.tiles.isNotEmpty()) {
        if (GymTextScale.stacked) Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.fillMaxWidth()) }
        } else Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.weight(1f)) }
        }
    }
    if (page.strength) StrengthChart(progress, nowMs, zone, focusSessionId)
    page.noEstimate?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = colors.onSurfaceVariant) }
    if (page.records.isNotEmpty()) {
        Text("Earlier records", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = colors.onSurface)
        page.records.forEach { mark ->
            Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, RoundedCornerShape(16.dp))
                .padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("${mark.effort} · ${mark.estimate}", style = WindmillFont.body(15, FontWeight.Bold).copy(lineHeight = 22.sp), color = colors.onSurface)
                Text(mark.day, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
            }
        }
    }
    if (page.days.isNotEmpty()) {
        Text("Recent sets", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp), color = colors.onSurface)
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            page.days.forEach { day -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(day.day.replaceFirstChar { it.titlecase() }, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = colors.onSurfaceVariant)
                Text(day.sets, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = colors.onSurface)
            } }
        }
    }
}

@Composable
private fun RecordMetric(tile: Record.Tile, modifier: Modifier) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    Column(modifier.background(colors.surfaceContainer, RoundedCornerShape(20.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(tile.label, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
        Text(tile.value, style = WindmillFont.body(30, FontWeight.ExtraBold).copy(lineHeight = 36.sp), color = if (tile.loud) gymColors.prInk else colors.onSurface)
        Text(tile.caption, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StrengthChart(progress: MovementProgress, nowMs: Long, zone: ZoneId, focusSessionId: String?) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
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
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, RoundedCornerShape(20.dp)).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Estimated strength", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = colors.onSurface)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(false to "12 weeks", true to "All").forEach { (value, label) ->
                SegmentedButton(selected = all == value, onClick = { all = value },
                    shape = SegmentedButtonDefaults.itemShape(if (value) 1 else 0, 2),
                    border = androidx.compose.foundation.BorderStroke(1.dp, colors.outlineVariant),
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = colors.surfaceContainerHighest, activeContentColor = colors.onSurface,
                        inactiveContainerColor = androidx.compose.ui.graphics.Color.Transparent, inactiveContentColor = colors.onSurface),
                    label = { Text(label, style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 14.sp,
                        lineHeight = 20.sp, letterSpacing = .1.sp, fontWeight = FontWeight.Medium)) })
            }
        }
        point?.let {
            Text(progressReading(it, nowMs), style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp),
                color = if (it.id == progress.best?.id) gymColors.prInk else colors.onSurface)
        }
        if (window.hasChart(zone)) DatedPlot(series, minHeight = 168.dp,
            labelStyle = WindmillFont.body(11).copy(lineHeight = 14.sp), initialPointId = initial?.id,
            interaction = PlotInteraction.Inspect, standingBestId = progress.best?.id,
            onInspect = { inspected = it }, gapLabel = { a, b -> "No workout · ${Readout.date(a.atMs)} – ${Readout.date(b.atMs)}" })
        Text("${if (all) "All" else "Last 12 weeks"} · ${Readout.sessionCount(window.sessions.size)}",
            style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
        if (window.estimatesComplete && window.estimates.isEmpty()) Text("No eligible estimate in this window.", style = WindmillFont.body(14), color = colors.onSurfaceVariant)
    }
}

private val recordPreviewNow = LocalDateTime.of(2026, 10, 28, 19, 30).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

private val recordPreviewBench = Exercise("bench-press", "Bench Press")

private val recordPreviewLog = listOf(70.0, 72.5, 75.0, 75.0, 77.5, 80.0).mapIndexed { index, kg ->
    val started = recordPreviewNow - (5 - index) * 7L * 86_400_000 - 3_600_000
    SessionDetail(Session("push-$index", started, started + 3_300_000, plan = PlanSnapshot("Push A")),
        (1..3).map { set -> TrainingSet("push-$index-$set", "bench-press", set, kg, 5, completedAtMs = started + set * 300_000L) })
}

private data class RecordPreviewState(override val progress: StatsProgress?) : RecordState {
    override val accountKey: String = "preview"
    override val replica: String? = "preview"
    override val progressFailure: WriteFailure? = null
    override val catalog: List<Exercise> = listOf(recordPreviewBench)
}

// Answers the page's reads from the preview log; writes change nothing.
private object RecordPreviewEvents : RecordEvents {
    override suspend fun loadProgress(force: Boolean): GymResult<StatsProgress> =
        GymResult.Ok(StatsProgress.of(recordPreviewLog, recordPreviewNow))
    override suspend fun record(exerciseId: String): GymResult<MovementRecord> =
        GymResult.Ok(MovementRecord.of(recordPreviewBench, recordPreviewLog, recordPreviewNow))
    override suspend fun edit(exerciseId: String, name: String, equipment: String?, loadCount: Int?, base: Exercise?,
        expectedAccountKey: String, expectedReplica: String?): GymResult<Exercise> = GymResult.Ok(recordPreviewBench)
}

@DarkAndDaylight
@Composable
private fun RecordWithBestPreview() {
    GymPreview {
        RecordScreen(RecordPreviewState(StatsProgress.of(recordPreviewLog, recordPreviewNow)), RecordPreviewEvents, "bench-press",
            backTo = "The log", onBack = {}, now = { recordPreviewNow })
    }
}
