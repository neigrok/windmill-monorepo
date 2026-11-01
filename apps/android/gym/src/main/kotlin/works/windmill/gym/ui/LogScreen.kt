package works.windmill.gym.ui

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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.LogReadout
import works.windmill.gym.domain.LogEntry
import works.windmill.gym.domain.logTimeline
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.Older
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.RecoveryRead
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.telemetry.LocalTelemetry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogScreen(
    store: TrainingStore,
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
    val skin = LocalGymColors.current
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    val nowMs = now()
    val zone = ZoneId.systemDefault()
    val progress = store.progress.takeIf { store.progressFailure == null }
    val oldestDay = if (store.older == Older.End) null else {
        store.allSessions.minOfOrNull { it.startedAtMs }
            ?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
            ?: Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    }
    val timeline = logTimeline(store.recent, progress, store.bodyweight, nowMs, zone, oldestDay)
    val days = LogReadout.days(timeline, nowMs, zone)
    val marked = timeline.filterIsInstance<LogEntry.Moment.Best>().mapTo(mutableSetOf()) { it.best.sessionId }
    val logHolds = store.allSessions.any { !it.session.isOpen }
    val load: () -> Unit = { scope.launch { store.loadOlder() } }
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
    LaunchedEffect(store.accountKey) { store.loadProgress() }
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
                if (store.progressFailure != null) item("progress-failed") {
                    Column {
                        Text("Progress unavailable", style = WindmillFont.body(16), color = skin.ink)
                        Text(store.progressFailure!!.line("Your progress could not be read."), style = WindmillFont.body(14), color = skin.inkDim)
                        TextButton(onClick = { scope.launch { store.loadProgress(force = true) } }) { Text("Try again") }
                    }
                } else if (store.progressLoading && store.progress == null) item("progress-reading") {
                    Text("Reading progress…", style = WindmillFont.body(14), color = skin.inkDim)
                }
                if (timeline.isEmpty() && store.older == Older.End && !logHolds) item("empty") {
                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        Text("No workouts yet", style = WindmillFont.body(28, FontWeight.Bold).copy(lineHeight = 39.sp), color = skin.ink)
                        Text("Your training will land here.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                    }
                }
                days.forEach { day ->
                    item("header:day:${day.date}") {
                        Text(day.label, style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = skin.inkDim)
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
                                store.withhold(Deletion.Bodyweight(entry.entry.dateLocal))
                                false
                            }) {
                                WeightRow(entry, LogReadout.weight(entry, store.bodyweight, zone)) {
                                    telemetry.event("gym_action", mapOf("screen" to "log", "action" to "open_bodyweight", "outcome" to "ok"))
                                    onOpenBodyweight()
                                }
                            }
                            is LogEntry.Moment -> MomentRow(entry, LogReadout.moment(entry, store.catalog, zone)) {
                                if (entry is LogEntry.Moment.Best) {
                                    telemetry.event("gym_action", mapOf("screen" to "log", "action" to "open_record", "outcome" to "ok"))
                                    onOpenMovement(entry.best.exerciseId, entry.best.sessionId)
                                }
                            }
                        }
                    }
                }
                if (store.older != Older.End || logHolds || timeline.isNotEmpty()) {
                    item("foot") { LogFoot(store.older, store.allSessions.lastOrNull { !it.session.isOpen }, load) }
                }
            }
        }
    }
    if (weighingIn) WindmillSheet(onDismissRequest = { close() }, onBack = { close() }, sheetState = sheetState,
        containerColor = skin.surface, scrimColor = skin.scrim,
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
                                val failure = store.weighIn(date, kg)
                                if (failure != null) refused = failure.line("That weigh-in could not be saved.")
                                else { saving = false; close() }
                            } finally { saving = false }
                        }
                    }
                }, onDelete = null, draftKey = "${store.accountKey}:new")
        }
    }
}

@Composable
private fun MomentRow(moment: LogEntry.Moment, readout: LogReadout.Moment, onOpenRecord: () -> Unit) {
    val skin = LocalGymColors.current
    if (moment is LogEntry.Moment.Month) {
        Column(Modifier.fillMaxWidth().testTag(moment.key).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(readout.title, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim)
            Text(readout.detail, style = WindmillFont.body(12).copy(lineHeight = 16.sp), color = skin.inkDim)
        }
        return
    }
    Row(Modifier.fillMaxWidth().testTag(moment.key).heightIn(min = 56.dp)
        .clickable(role = Role.Button, onClickLabel = "Open record", onClick = onOpenRecord)
        .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(3.dp, 38.dp).background(skin.prInk, RoundedCornerShape(1.5.dp)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(readout.title, style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.ink)
            Text(readout.detail, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        }
        LogChevron()
    }
}

@Composable
private fun WeightRow(weight: LogEntry.Weight, readout: LogReadout.Weight, onOpen: () -> Unit) {
    val skin = LocalGymColors.current
    val stacked = GymTextScale.stacked
    Column(Modifier.fillMaxWidth().background(skin.canvas)) {
        HorizontalDivider(color = skin.line)
        Row(Modifier.fillMaxWidth().testTag(weight.key).heightIn(min = 72.dp)
            .clickable(role = Role.Button, onClickLabel = "Open bodyweight", onClick = onOpen)
            .padding(horizontal = 12.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.gym_native_monitor_weight), null, Modifier.size(20.dp), tint = skin.inkDim)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(readout.title, style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.ink)
                readout.detail?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim) }
                if (stacked) readout.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim) }
            }
            if (!stacked) readout.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim) }
            LogChevron()
        }
        HorizontalDivider(color = skin.line)
    }
}

@Composable
private fun LogChevron() {
    Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
        Icon(painterResource(R.drawable.gym_chevron), null, Modifier.size(10.1771.dp, 15.5052.dp), tint = LocalGymColors.current.inkDim)
    }
}

@Composable
private fun SessionRow(row: LogReadout.Row, onOpen: () -> Unit, onShare: () -> Unit, onDiscard: () -> Unit) {
    val skin = LocalGymColors.current
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberGymHaptics()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val timeBelowTitle = maxWidth < 320.dp || GymTextScale.stacked
        Row(Modifier.fillMaxWidth().testTag("session:${row.summary.id}").heightIn(min = 72.dp)
            .clip(RoundedCornerShape(16.dp)).background(skin.surface)
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
                        style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.ink)
                    if (row.record) Box(Modifier.size(8.dp).background(skin.prInk, CircleShape))
                }
                Text(row.facts, modifier = Modifier.fillMaxWidth(), style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
                if (timeBelowTitle) row.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim) }
            }
            if (!timeBelowTitle) row.time?.let { Text(it, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim) }
            DropdownMenu(menu, { menu = false }, containerColor = skin.raised) {
                DropdownMenuItem(text = { Text("Share this workout") }, onClick = { menu = false; onShare() })
                DropdownMenuItem(text = { Text("Discard workout") }, onClick = { menu = false; onDiscard() })
            }
        }
    }
}

@Composable
private fun LogFoot(older: Older, first: SessionSummary?, onLoad: () -> Unit) {
    val skin = LocalGymColors.current
    if (older == Older.End) {
        if (first != null) Text("First workout · ${Readout.date(first.startedAtMs)}", style = WindmillFont.body(14), color = skin.inkDim)
        return
    }
    Button(onClick = onLoad, enabled = older != Older.Loading, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = skin.raised, contentColor = skin.ink)) {
        Text(when (older) { Older.Failed -> "Retry"; Older.Loading -> "Loading"; else -> "Load older" })
    }
    if (older == Older.Failed) Text("That read failed.", style = WindmillFont.body(14), color = skin.inkDim)
}
