package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Bodyweight
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.LogReadout
import works.windmill.gym.presentation.LogEntry
import works.windmill.gym.presentation.logTimeline
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.StatsProgress
import works.windmill.gym.presentation.TopSet
import works.windmill.gym.presentation.WeighIn
import works.windmill.gym.store.BodyweightStore
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeletionsStore
import works.windmill.gym.store.HistoryReads
import works.windmill.gym.store.Older
import works.windmill.gym.store.RoutinesStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.RecoveryRead
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.telemetry.LocalTelemetry

// What the log draws: the account's workouts, weigh-ins and progress, and how far back the log is read.
@Stable
interface LogState {
    val accountKey: String
    val older: Older
    val readingShown: Boolean
    val allSessions: List<SessionSummary>
    val progress: StatsProgress?
    val progressFailure: WriteFailure?
    val progressLoading: Boolean
    val historyRead: Boolean
    val weighIns: List<WeighIn>
    val catalog: List<Exercise>
}

// What the log asks of the stores.
interface LogEvents {
    suspend fun loadProgress(force: Boolean = false)
    fun showReading()
    suspend fun loadOlder()
    suspend fun retryLog()
    fun withhold(deletion: Deletion.Bodyweight)
    suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure?
}

// The log over the room's stores.
class LogBinding(
    private val seat: TrainingSeat,
    private val history: HistoryReads,
    private val bodyweight: BodyweightStore,
    private val routines: RoutinesStore,
    private val deletions: DeletionsStore,
) : LogState, LogEvents {
    constructor(store: TrainingStore) : this(store.seat, store.history, store.bodyweight, store.routines, store.deletions)

    override val accountKey: String get() = seat.accountKey
    override val older: Older get() = history.older
    override val readingShown: Boolean get() = history.readingShown
    override val allSessions: List<SessionSummary> get() = history.allSessions
    override val progress: StatsProgress? get() = history.progress
    override val progressFailure: WriteFailure? get() = history.progressFailure
    override val progressLoading: Boolean get() = history.progressLoading
    override val historyRead: Boolean get() = history.historyRead
    override val weighIns: List<WeighIn> get() = bodyweight.drawn
    override val catalog: List<Exercise> get() = routines.catalog

    override suspend fun loadProgress(force: Boolean) { history.loadProgress(force) }
    override fun showReading() = history.showReading()
    override suspend fun loadOlder() = history.loadOlder()
    override suspend fun retryLog() = history.retryLog()
    override fun withhold(deletion: Deletion.Bodyweight) = deletions.withhold(deletion)
    override suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? = bodyweight.weighIn(dateLocal, weightKg)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogScreen(
    state: LogState,
    events: LogEvents,
    seat: String,
    onOpenSession: (SessionSummary) -> Unit,
    onOpenBodyweight: () -> Unit,
    onShareSession: (String) -> Unit,
    onDiscardSession: (String) -> Unit,
    onOpenMovement: (String, String) -> Unit = { _, _ -> },
    onOpenRecovery: (String?) -> Unit = {},
    recovery: RecoveryRead? = null,
    now: () -> Long = System::currentTimeMillis,
    transient: SnackbarHostState? = null,
) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    val nowMs = now()
    val zone = ZoneId.systemDefault()
    val progress = state.progress.takeIf { state.progressFailure == null }
    val historyRead = state.historyRead
    val oldestDay = if (state.older == Older.End) null else {
        state.allSessions.minOfOrNull { it.startedAtMs }
            ?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
            ?: Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    }
    val timeline = logTimeline(state.allSessions, progress, state.weighIns, nowMs, zone, oldestDay)
    val days = LogReadout.days(timeline, nowMs, zone)
    val marked = timeline.filterIsInstance<LogEntry.Moment.Best>().mapTo(mutableSetOf()) { it.best.sessionId }
    val logHolds = state.allSessions.any { !it.session.isOpen }
    var weighingIn by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var refused by rememberSaveable { mutableStateOf<String?>(null) }
    val formState = rememberSaveableStateHolder()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !saving })
    val listState = rememberLazyListState()
    // Undo can bring a day back above the first one drawn. A log read from its top stays at its top,
    // so the lifter sees the row come back; one scrolled down keeps its place.
    val pinned = remember { object { var top = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0 } }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.filter { !it }.collect {
            pinned.top = listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
        }
    }
    val firstDay = days.firstOrNull()?.date
    LaunchedEffect(firstDay) { if (pinned.top) listState.scrollToItem(0) }
    LaunchedEffect(state.accountKey) { events.loadProgress() }
    // The reading foot shows once its wait passes 400 ms, timed here rather than in the list so scrolling keeps it.
    val reading = state.older == Older.Reading
    LaunchedEffect(reading) { if (reading) { delay(400); events.showReading() } }
    fun close() {
        if (saving || closing) return
        closing = true
        scope.launch {
            try { sheetState.hide(); weighingIn = false; refused = null; formState.removeState("weigh-in") }
            finally { closing = false }
        }
    }
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    GymScreen(title = "The log", actions = { YouSeat(seat) }, transient = transient, floatingActionButton = {
        GymExtendedFab(Bodyweight.chip, onClick = { weighingIn = true }, painterResource(R.drawable.gym_native_monitor_weight),
            expanded = atTop)
    }) {
        Box(Modifier.fillMaxSize()) {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 88.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)) {
                if (recovery?.workouts?.isNotEmpty() == true) item("on-this-phone") {
                    OnThisPhoneSection(recovery, onList = { onOpenRecovery(null) }, onInspect = { onOpenRecovery(it) })
                }
                if (state.progressFailure != null) item("progress-failed") {
                    Column {
                        Text("Progress unavailable", style = WindmillFont.body(16), color = colors.onSurface)
                        Text(state.progressFailure!!.line("Your progress could not be read."), style = WindmillFont.body(14), color = colors.onSurfaceVariant)
                        TextButton(onClick = { scope.launch { events.loadProgress(force = true) } }) { Text("Try again") }
                    }
                } else if (state.progressLoading && state.progress == null) item("progress-reading") {
                    Text("Reading progress…", style = WindmillFont.body(14), color = colors.onSurfaceVariant)
                }
                if (timeline.isEmpty() && state.older == Older.End && !logHolds) item("empty") {
                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        Text("No workouts yet", style = WindmillFont.body(28, FontWeight.Bold).copy(lineHeight = 39.sp), color = colors.onSurface)
                        Text("Your training will land here.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = colors.onSurfaceVariant)
                    }
                }
                days.forEach { day ->
                    item("header:day:${day.date}") {
                        Text(day.label, style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
                    }
                    items(day.entries, key = { "entry:${it.key}" }) { entry ->
                        when (entry) {
                            is LogEntry.Workout -> {
                                val row = LogReadout.row(entry.summary, progress, nowMs, zone, entry.summary.id in marked)
                                DeleteSwipeRow("Discard workout", onDelete = { onDiscardSession(row.summary.id); false }) {
                                    SessionRow(row,
                                        onOpen = {
                                            telemetry.event("gym_action", mapOf("screen" to "log", "action" to "open_workout", "outcome" to "ok"))
                                            onOpenSession(row.summary)
                                        }, onShare = { onShareSession(row.summary.id) }, onDiscard = { onDiscardSession(row.summary.id) })
                                }
                            }
                            is LogEntry.Weight -> DeleteSwipeRow("Delete weigh-in", onDelete = {
                                events.withhold(Deletion.Bodyweight(entry.entry.dateLocal))
                                false
                            }) {
                                WeightRow(entry, LogReadout.weight(entry, state.weighIns, zone, historyRead)) {
                                    telemetry.event("gym_action", mapOf("screen" to "log", "action" to "open_bodyweight", "outcome" to "ok"))
                                    onOpenBodyweight()
                                }
                            }
                            is LogEntry.Moment -> MomentRow(entry, LogReadout.moment(entry, state.catalog, zone)) {
                                if (entry is LogEntry.Moment.Best) {
                                    telemetry.event("gym_action", mapOf("screen" to "log", "action" to "open_record", "outcome" to "ok"))
                                    onOpenMovement(entry.best.exerciseId, entry.best.sessionId)
                                }
                            }
                        }
                    }
                }
                if (state.older != Older.End || logHolds || timeline.isNotEmpty()) {
                    item("foot") { LogFoot(state.older, state.readingShown, state.allSessions.lastOrNull { !it.session.isOpen },
                        onLoad = { scope.launch { events.loadOlder() } }, onRetry = { scope.launch { events.retryLog() } }) }
                }
            }
        }
    }
    if (weighingIn) WindmillSheet(onDismissRequest = { close() }, onBack = { close() }, sheetState = sheetState,
        containerColor = colors.surfaceContainer, scrimColor = colors.scrim,
        dragHandle = { WeighInHandle() }, contentWindowInsets = { WindowInsets(0, 0, 0, 0) }) {
        formState.SaveableStateProvider("weigh-in") {
            BackHandler(saving || closing) {}
            WeighInSheet(null, null, now(), saving || closing, refused,
                onSave = { date, kg ->
                    if (!saving && !closing) {
                        saving = true
                        refused = null
                        scope.launch {
                            try {
                                val failure = events.weighIn(date, kg)
                                if (failure != null) refused = failure.line("That weigh-in could not be saved.")
                                else { saving = false; close() }
                            } finally { saving = false }
                        }
                    }
                }, onDelete = null, draftKey = "${state.accountKey}:new")
        }
    }
}

@Composable
private fun MomentRow(moment: LogEntry.Moment, readout: LogReadout.Moment, onOpenRecord: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    if (moment is LogEntry.Moment.Month) {
        Column(Modifier.fillMaxWidth().testTag(moment.key).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(readout.title, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = colors.onSurfaceVariant)
            Text(readout.detail, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = colors.onSurfaceVariant)
        }
        return
    }
    Row(Modifier.fillMaxWidth().testTag(moment.key).heightIn(min = 56.dp)
        .clickable(role = Role.Button, onClickLabel = "Open record", onClick = onOpenRecord)
        .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(3.dp, 38.dp).background(gymColors.prInk, RoundedCornerShape(1.5.dp)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(readout.title, style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = colors.onSurface)
            Text(readout.detail, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
        }
        LogChevron()
    }
}

@Composable
private fun WeightRow(weight: LogEntry.Weight, readout: LogReadout.Weight, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val stacked = GymTextScale.stacked
    Column(Modifier.fillMaxWidth().background(colors.surface)) {
        HorizontalDivider(color = colors.outlineVariant)
        Row(Modifier.fillMaxWidth().testTag(weight.key).heightIn(min = 72.dp)
            .clickable(role = Role.Button, onClickLabel = "Open bodyweight", onClick = onOpen)
            .padding(horizontal = 12.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.gym_native_monitor_weight), null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(readout.title, style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = colors.onSurface)
                readout.detail?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant) }
                if (stacked) readout.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant) }
            }
            if (!stacked) readout.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant) }
            LogChevron()
        }
        HorizontalDivider(color = colors.outlineVariant)
    }
}

@Composable
private fun LogChevron() {
    Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
        Icon(painterResource(R.drawable.gym_chevron), null, Modifier.size(10.1771.dp, 15.5052.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SessionRow(row: LogReadout.Row, onOpen: () -> Unit, onShare: () -> Unit, onDiscard: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberGymHaptics()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val timeBelowTitle = maxWidth < 320.dp || GymTextScale.stacked
        Row(Modifier.fillMaxWidth().testTag("session:${row.summary.id}").heightIn(min = 72.dp)
            .clip(RoundedCornerShape(16.dp)).background(colors.surfaceContainer)
            .combinedClickable(role = Role.Button, onClickLabel = "Open workout", onLongClickLabel = "Workout actions",
                onClick = onOpen, onLongClick = { haptics.revealed(); menu = true })
            .semantics {
                if (row.record) stateDescription = "New best"
                customActions = listOf(CustomAccessibilityAction("Share this workout") { onShare(); true },
                    CustomAccessibilityAction("Discard workout") { onDiscard(); true })
            }.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(row.title, modifier = Modifier.weight(1f, fill = false),
                        style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = colors.onSurface)
                    if (row.record) Box(Modifier.size(8.dp).background(gymColors.prInk, CircleShape))
                }
                Text(row.facts, modifier = Modifier.fillMaxWidth(), style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
                if (timeBelowTitle) row.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant) }
            }
            if (!timeBelowTitle) row.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant) }
            DropdownMenu(menu, { menu = false }, containerColor = colors.surfaceContainerHighest) {
                DropdownMenuItem(text = { Text("Share this workout") }, onClick = { menu = false; onShare() })
                DropdownMenuItem(text = { Text("Discard workout") }, onClick = { menu = false; onDiscard() })
            }
        }
    }
}

@Composable
private fun LogFoot(older: Older, readingShown: Boolean, first: SessionSummary?, onLoad: () -> Unit, onRetry: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    if (older == Older.End) {
        if (first != null) Text("First workout · ${Readout.date(first.startedAtMs)}", style = WindmillFont.body(14), color = colors.onSurfaceVariant)
        return
    }
    if (older == Older.Reading) {
        if (readingShown) Column(Modifier.fillMaxWidth().padding(start = 16.dp, top = 4.dp, end = 16.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite; progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate },
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            LinearProgressIndicator(Modifier.fillMaxWidth().clearAndSetSemantics {}, color = colors.primary, trackColor = colors.primaryContainer)
            Text("Reading your log…", style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = colors.onSurfaceVariant)
        }
        return
    }
    Button(onClick = if (older == Older.Failed) onRetry else onLoad, enabled = older != Older.Loading, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface)) {
        Text(when (older) { Older.Failed -> "Retry"; Older.Loading -> "Loading"; else -> "Load older" })
    }
    if (older == Older.Failed) Text("That read failed.", Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        style = WindmillFont.body(14), color = colors.onSurfaceVariant)
}

private data class LogPreviewState(
    override val older: Older = Older.End,
    override val readingShown: Boolean = false,
    override val allSessions: List<SessionSummary> = emptyList(),
    override val progress: StatsProgress? = null,
    override val historyRead: Boolean = true,
    override val weighIns: List<WeighIn> = emptyList(),
) : LogState {
    override val accountKey: String = "preview"
    override val progressFailure: WriteFailure? = null
    override val progressLoading: Boolean = false
    override val catalog: List<Exercise> = listOf(Exercise("bench-press", "Bench Press"), Exercise("overhead-press", "Overhead Press"),
        Exercise("back-squat", "Back Squat"), Exercise("deadlift", "Deadlift"))
}

private object LogPreviewEvents : LogEvents {
    override suspend fun loadProgress(force: Boolean) = Unit
    override fun showReading() = Unit
    override suspend fun loadOlder() = Unit
    override suspend fun retryLog() = Unit
    override fun withhold(deletion: Deletion.Bodyweight) = Unit
    override suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? = null
}

private val logPreviewNow = LocalDateTime.of(2026, 10, 28, 19, 30).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

private fun logPreviewWorkout(id: String, routine: String, daysAgo: Long, sets: Int, tonnageKg: Double, top: TopSet, exercises: List<String>): SessionSummary {
    val started = logPreviewNow - daysAgo * 86_400_000 - 3_600_000
    return SessionSummary(id, started, started + 3_300_000, plan = PlanSnapshot(routine), setCount = sets,
        workingSetCount = sets, tonnageKg = tonnageKg, exercises = exercises, topSet = top)
}

@Composable
private fun LogPreview(state: LogState) {
    GymPreview {
        LogScreen(state, LogPreviewEvents, seat = "V", onOpenSession = {}, onOpenBodyweight = {}, onShareSession = {},
            onDiscardSession = {}, now = { logPreviewNow })
    }
}

@DarkAndDaylight
@Composable
private fun LogWithWorkoutsPreview() = LogPreview(LogPreviewState(
    allSessions = listOf(
        logPreviewWorkout("push-b", "Push B", 0, 16, 5_120.0, TopSet(82.5, 5), listOf("bench-press", "overhead-press")),
        logPreviewWorkout("legs-a", "Legs A", 2, 14, 7_860.0, TopSet(120.0, 5), listOf("back-squat", "deadlift")),
        logPreviewWorkout("push-a", "Push A", 4, 15, 4_880.0, TopSet(80.0, 5), listOf("bench-press", "overhead-press")),
    ),
    weighIns = listOf(WeighIn("2026-10-24", 82.6), WeighIn("2026-10-28", 82.3)),
))

@DarkAndDaylight
@Composable
private fun LogEmptyPreview() = LogPreview(LogPreviewState())

@DarkAndDaylight
@Composable
private fun LogReadingPreview() = LogPreview(LogPreviewState(older = Older.Reading, readingShown = true, historyRead = false,
    allSessions = listOf(logPreviewWorkout("push-a", "Push A", 1, 15, 4_880.0, TopSet(80.0, 5), listOf("bench-press", "overhead-press")))))
