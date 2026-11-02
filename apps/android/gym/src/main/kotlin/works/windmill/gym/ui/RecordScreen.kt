package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.unit.dp
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.coroutines.launch
import works.windmill.gym.domain.sync.ExerciseRules
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.MovementProgress
import works.windmill.gym.presentation.MovementRead
import works.windmill.gym.presentation.MovementRecord
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Record
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.presentation.StatsProgress
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.progressReading
import works.windmill.gym.presentation.progressSeries
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.RecordRead
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillSheet
import works.windmill.platform.design.WindmillType

// Whose seat the record page reads, the engine revision it follows, and the catalogue it names movements from.
@Stable
interface RecordState {
    val accountKey: String
    val replica: String?
    val readRevision: Long
    val accountReady: Boolean
    val catalog: List<Exercise>
}

// What a movement's record page asks of the stores.
interface RecordEvents {
    suspend fun record(exerciseId: String): RecordRead
    suspend fun edit(exerciseId: String, name: String, equipment: String?, loadCount: Int?, base: Exercise?,
        expectedAccountKey: String, expectedReplica: String?): GymResult<Exercise>
}

// A movement's record page over the room's stores.
class RecordBinding(private val seat: TrainingSeat, private val history: HistoryReads, private val routines: RoutinesStore) :
    RecordState, RecordEvents {
    constructor(store: TrainingStore) : this(store.seat, store.history, store.routines)

    override val accountKey: String get() = seat.accountKey
    override val replica: String? get() = seat.replica
    override val readRevision: Long get() = seat.replicaReadRevision
    override val accountReady: Boolean get() = seat.accountReady
    override val catalog: List<Exercise> get() = routines.catalog

    override suspend fun record(exerciseId: String): RecordRead = history.record(exerciseId)
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
    val zone = ZoneId.systemDefault()
    var movementRead by remember(exerciseId, state.accountKey, state.replica) { mutableStateOf<MovementRead?>(null) }
    val read = movementRead
    val nowMs = remember(exerciseId, movementRead?.asOf) { now() }
    var failure by remember(exerciseId, state.accountKey, state.replica) { mutableStateOf<WriteFailure?>(null) }
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
    LaunchedEffect(exerciseId, asked, state.accountKey, state.replica, state.readRevision, state.accountReady) {
        failure = null
        when (val result = events.record(exerciseId)) {
            is RecordRead.Ready -> movementRead = result.value
            is RecordRead.Failed -> failure = result.why
            RecordRead.Superseded -> Unit
        }
    }
    val problem = failure
    GymScreen(title = read?.record?.exercise?.name ?: Readout.movement(exerciseId, state.catalog),
        onBack = onBack, backTo = backTo,
        actions = { if (read != null && problem == null) Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, contentDescription = "More") }
            GymMenu(menu, { menu = false }) {
                GymMenuItem("Edit movement", rememberVectorPainter(Icons.Outlined.Edit), onClick = {
                    menu = false
                    val exercise = read.record.exercise
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
                problem != null -> {
                    Text("Record unavailable", style = GymType.screenHeading, color = colors.onSurface)
                    Text(problem.line("Your record could not be read."), style = WindmillType.body, color = colors.onSurfaceVariant)
                    TextButton(onClick = { asked += 1 }) { Text("Try again") }
                }
                read != null -> RecordBody(Record.page(read, nowMs), read.record.exercise.equipment, read.progress, nowMs, zone, focusSessionId)
                else -> Text("Reading your log…", style = WindmillType.body, color = colors.onSurfaceVariant)
            }
        }
    }
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
            val base = read.record.exercise.copy(name = openedName, equipment = openedEquipment, loadCount = openedCount)
            EditMovementSheet(base, draft, equipment, loadCount, refused,
                onName = { if (!saving && !closing) { draft = it; refused = null } },
                onEquipment = { if (!saving && !closing) {
                    val original = ExerciseRules.loadingChoice(openedEquipment, openedCount)
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
                                            movementRead = read.copy(record = read.record.copy(exercise = result.value))
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
        Text(page.subhead, style = WindmillType.detail, color = colors.onSurfaceVariant)
    }
    page.nothingYet?.let { Text(it, style = WindmillType.paragraph, color = colors.onSurfaceVariant); return }
    if (page.tiles.isNotEmpty()) {
        if (GymTextScale.stacked) Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.fillMaxWidth()) }
        } else Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            page.tiles.forEach { RecordMetric(it, Modifier.weight(1f)) }
        }
    }
    if (page.strength) StrengthChart(progress, nowMs, zone, focusSessionId)
    page.noEstimate?.let { Text(it, style = WindmillType.supportingParagraph, color = colors.onSurfaceVariant) }
    if (page.records.isNotEmpty()) {
        Text("Earlier records", style = GymType.heading, color = colors.onSurface)
        page.records.forEach { mark ->
            Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, RoundedCornerShape(16.dp))
                .padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("${mark.effort} · ${mark.estimate}", style = WindmillType.rowLabel, color = colors.onSurface)
                Text(mark.day, style = WindmillType.detail, color = colors.onSurfaceVariant)
            }
        }
    }
    if (page.days.isNotEmpty()) {
        Text("Recent sets", style = GymType.listHeading, color = colors.onSurface)
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            page.days.forEach { day -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(day.day.replaceFirstChar { it.titlecase() }, style = WindmillType.supportingParagraph, color = colors.onSurfaceVariant)
                Text(day.sets, style = WindmillType.paragraph, color = colors.onSurface)
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
        Text(tile.label, style = WindmillType.detail, color = colors.onSurfaceVariant)
        Text(tile.value, style = GymType.recordTile, color = if (tile.loud) gymColors.prInk else colors.onSurface)
        Text(tile.caption, style = WindmillType.detail, color = colors.onSurfaceVariant)
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
        Text("Estimated strength", style = GymType.heading, color = colors.onSurface)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(false to "12 weeks", true to "All").forEach { (value, label) ->
                SegmentedButton(selected = all == value, onClick = { all = value },
                    shape = SegmentedButtonDefaults.itemShape(if (value) 1 else 0, 2),
                    border = BorderStroke(1.dp, colors.outlineVariant),
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = colors.surfaceContainerHighest, activeContentColor = colors.onSurface,
                        inactiveContainerColor = Color.Transparent, inactiveContentColor = colors.onSurface),
                    label = { Text(label, style = GymType.segmentLabel) })
            }
        }
        point?.let {
            Text(progressReading(it, nowMs), style = WindmillType.kicker,
                color = if (it.id == progress.best?.id) gymColors.prInk else colors.onSurface)
        }
        if (window.hasChart(zone)) DatedPlot(series, minHeight = 168.dp,
            labelStyle = GymType.chartAxis, initialPointId = initial?.id,
            interaction = PlotInteraction.Inspect, standingBestId = progress.best?.id,
            onInspect = { inspected = it }, gapLabel = { a, b -> "No workout · ${Readout.date(a.atMs)} – ${Readout.date(b.atMs)}" })
        Text("${if (all) "All" else "Last 12 weeks"} · ${Readout.sessionCount(window.sessions.size)}",
            style = WindmillType.detail, color = colors.onSurfaceVariant)
        if (window.estimatesComplete && window.estimates.isEmpty()) Text("No eligible estimate in this window.", style = WindmillType.supporting, color = colors.onSurfaceVariant)
    }
}

private val recordPreviewNow = LocalDateTime.of(2026, 10, 28, 19, 30).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

private val recordPreviewBench = Exercise("bench-press", "Bench Press")

private val recordPreviewLog = listOf(70.0, 72.5, 75.0, 75.0, 77.5, 80.0).mapIndexed { index, kg ->
    val started = recordPreviewNow - (5 - index) * 7L * 86_400_000 - 3_600_000
    SessionDetail(Session("push-$index", started, started + 3_300_000, plan = PlanSnapshot("Push A")),
        (1..3).map { set -> TrainingSet("push-$index-$set", "bench-press", set, kg, 5, completedAtMs = started + set * 300_000L) })
}

private object RecordPreviewState : RecordState {
    override val accountKey: String = "preview"
    override val replica: String? = "preview"
    override val readRevision: Long = 0
    override val accountReady: Boolean = true
    override val catalog: List<Exercise> = listOf(recordPreviewBench)
}

// Answers the page's reads from the preview log; writes change nothing.
private object RecordPreviewEvents : RecordEvents {
    override suspend fun record(exerciseId: String): RecordRead =
        RecordRead.Ready(MovementRead(MovementRecord.of(recordPreviewBench, recordPreviewLog, recordPreviewNow),
            StatsProgress.of(recordPreviewLog, recordPreviewNow).movement(exerciseId), recordPreviewNow))
    override suspend fun edit(exerciseId: String, name: String, equipment: String?, loadCount: Int?, base: Exercise?,
        expectedAccountKey: String, expectedReplica: String?): GymResult<Exercise> = GymResult.Ok(recordPreviewBench)
}

@DarkAndDaylight
@Composable
private fun RecordWithBestPreview() {
    GymPreview {
        RecordScreen(RecordPreviewState, RecordPreviewEvents, "bench-press",
            backTo = "The log", onBack = {}, now = { recordPreviewNow })
    }
}
