package works.windmill.gym.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
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
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.progressSeries
import works.windmill.gym.domain.LogReadout
import works.windmill.gym.domain.DatedGeometry
import works.windmill.gym.domain.LogEntry
import works.windmill.gym.domain.logTimeline
import works.windmill.gym.domain.MovementProgress
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.Older
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogScreen(
    store: TrainingStore,
    seat: String,
    onOpenSession: (SessionSummary) -> Unit,
    onOpenBodyweight: () -> Unit,
    onShareSession: (String) -> Unit,
    onDiscardSession: (String) -> Unit,
    onOpenMovement: (String) -> Unit = {},
    now: () -> Long = System::currentTimeMillis,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val nowMs = now()
    val zone = ZoneId.systemDefault()
    val onThisDevice = store.shelved.map { it.id }.toSet()
    val progress = store.progress.takeIf { store.progressFailure == null }
    val oldestDay = if (store.older == Older.End) null else {
        store.allSessions.minOfOrNull { it.startedAtMs }
            ?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
            ?: Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    }
    val timeline = logTimeline(store.recent, progress, store.bodyweight, nowMs, zone, oldestDay)
    val months = LogReadout.months(timeline, nowMs, zone)
    val logHolds = store.allSessions.any { !it.session.isOpen }
    val load: () -> Unit = { scope.launch { store.loadOlder() } }
    var weighingIn by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var refused by rememberSaveable { mutableStateOf<String?>(null) }
    val formState = rememberSaveableStateHolder()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !saving })
    val listState = rememberLazyListState()
    var openMoment by rememberSaveable(store.accountKey) { mutableStateOf<String?>(null) }
    LaunchedEffect(store.accountKey) { store.loadProgress() }
    fun close() {
        if (saving || closing) return
        closing = true
        scope.launch {
            try { sheetState.hide(); weighingIn = false; refused = null; formState.removeState("weigh-in") }
            finally { closing = false }
        }
    }
    GymScreen(title = "Log", actions = { YouSeat(seat) }) {
        Column(Modifier.fillMaxSize()) {
            LazyColumn(state = listState, modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (store.progressFailure != null) item("progress-failed") {
                    Column {
                        Text("Progress unavailable", style = WindmillFont.body(16), color = skin.ink)
                        Text(store.progressFailure!!.line("Your progress could not be read."), style = WindmillFont.body(14), color = skin.inkDim)
                        TextButton(onClick = { scope.launch { store.loadProgress(force = true) } }) { Text("Try again") }
                    }
                } else if (store.progressLoading && store.progress == null) item("progress-reading") {
                    Text("Reading progress…", style = WindmillFont.body(14), color = skin.inkDim)
                }
                if (timeline.isEmpty()) {
                    when {
                        store.older == Older.End && !logHolds -> item("empty") {
                            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                                Text("No sessions yet", style = WindmillFont.body(28, FontWeight.Bold).copy(lineHeight = 39.sp), color = skin.ink)
                                Text("Your training will land here.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                            }
                        }
                    }
                } else {
                    months.forEach { month ->
                        item("header:month:${month.month}") {
                            Text(month.label, style = WindmillFont.body(14, FontWeight.Bold), color = skin.inkDim)
                        }
                        items(month.entries, key = { "entry:${it.key}" }) { entry ->
                            when (entry) {
                                is LogEntry.Workout -> {
                                    val row = LogReadout.row(entry.summary, entry.summary.id in onThisDevice,
                                        progress, store.catalog, nowMs, zone)
                                    SessionRow(row, { onOpenSession(row.summary) }, { onShareSession(row.summary.id) }, { onDiscardSession(row.summary.id) })
                                }
                                is LogEntry.Moment -> {
                                    val movement = (entry as? LogEntry.Moment.Best)?.let { progress?.movement(it.exerciseId)?.window(entry.atMs, zone) }
                                    MomentRow(entry, LogReadout.moment(entry, store.catalog, store.bodyweight, nowMs, zone),
                                        movement, openMoment == entry.key, nowMs, zone,
                                        onToggle = {
                                            if (entry is LogEntry.Moment.Weight) onOpenBodyweight()
                                            else openMoment = entry.key.takeUnless { openMoment == it }
                                        }, onOpenRecord = { if (entry is LogEntry.Moment.Best) onOpenMovement(entry.exerciseId) })
                                }
                            }
                        }
                    }
                }
                if (store.older != Older.End || logHolds || timeline.isNotEmpty()) {
                    item("foot") { LogFoot(store.older, store.allSessions.lastOrNull { !it.session.isOpen }, load) }
                }
            }
            Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 12.dp)) {
                WeighInChip { weighingIn = true }
            }
        }
    }
    if (weighingIn) ModalBottomSheet(onDismissRequest = { close() }, sheetState = sheetState,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false), containerColor = skin.surface, scrimColor = skin.scrim) {
        WindmillSheetWindow()
        formState.SaveableStateProvider("weigh-in") {
            WindmillSheetBack(onDismiss = { close() }) {
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
}

@Composable
private fun MomentRow(moment: LogEntry.Moment, readout: LogReadout.Moment, movement: MovementProgress?,
    expanded: Boolean, nowMs: Long, zone: ZoneId, onToggle: () -> Unit, onOpenRecord: () -> Unit) {
    val skin = LocalGymColors.current
    val dot = when (moment) {
        is LogEntry.Moment.Best -> skin.prInk
        is LogEntry.Moment.Month -> skin.setDone
        is LogEntry.Moment.Weight -> skin.accent
    }
    val shape = RoundedCornerShape(if (expanded) 16.dp else 12.dp)
    val shell = if (expanded) Modifier.background(skin.surface, shape) else Modifier.border(1.dp, skin.lineStrong, shape)
    val largeText = LocalDensity.current.fontScale >= 1.5f
    Column(Modifier.fillMaxWidth().testTag(moment.key)
        .animateContentSize(tween(220, easing = FastOutSlowInEasing)).then(shell).clip(shape)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClickLabel = if (moment is LogEntry.Moment.Weight) "Open bodyweight" else if (expanded) "Collapse moment" else "Expand moment", onClick = onToggle)
            .semantics { if (moment !is LogEntry.Moment.Weight) stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .padding(horizontal = 14.dp, vertical = if (expanded) 14.dp else 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(dot, CircleShape))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(readout.title, style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.ink)
                Text(readout.detail, style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
            }
            if (!expanded && !largeText && movement?.hasChart(zone) == true) {
                val series = progressSeries(movement, moment.atMs, zone)
                Canvas(Modifier.size(72.dp, 24.dp)) {
                    val inset = 3.dp.toPx()
                    val geometry = DatedGeometry(series, size.width - inset * 2, size.height - inset * 2)
                    geometry.segments.forEach { (before, after) ->
                        drawLine(skin.accent, Offset(before.x + inset, before.y + inset), Offset(after.x + inset, after.y + inset), 1.5.dp.toPx())
                    }
                    geometry.points.forEach { point ->
                        drawCircle(if (point.fact.id == movement.best?.id) skin.prInk else skin.accent,
                            2.5.dp.toPx(), Offset(point.x + inset, point.y + inset))
                    }
                }
            }
        }
        if (expanded) Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp).padding(bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (movement != null) {
                if (movement.hasChart(zone)) DatedPlot(progressSeries(movement, moment.atMs, zone),
                    modifier = Modifier.testTag("moment-plot:${moment.key}"), standingBestId = movement.best?.id)
                Text("Last 12 weeks · ${Readout.sessionCount(movement.sessions.size)}", style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
                movement.best?.let { Text("Best e1RM ${Readout.estimatedWeight(it.fact.estimate!!.e1rm)} kg · ${Readout.briefDay(it.startedAt, nowMs)}",
                    style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.prInk) }
                movement.heaviest?.let { Text("Heaviest ${Readout.effort(it.fact.heaviest.weightKg, it.fact.heaviest.reps)} · ${Readout.briefDay(it.startedAt, nowMs)}",
                    style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim) }
                Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClick = onOpenRecord), contentAlignment = Alignment.CenterStart) {
                    Text("Open record ›", style = WindmillFont.body(14, FontWeight.Bold), color = skin.accent)
                }
            } else if (moment is LogEntry.Moment.Month) {
                Text("A finished workout with working sets in every calendar week.",
                    style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            }
        }
    }
}

@Composable
private fun SessionRow(row: LogReadout.Row, onOpen: () -> Unit, onShare: () -> Unit, onDiscard: () -> Unit) {
    val skin = LocalGymColors.current
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberGymHaptics()
    val fontScale = LocalDensity.current.fontScale
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val dateBelowTitle = maxWidth < 320.dp || fontScale >= 1.5f
        Row(Modifier.fillMaxWidth().heightIn(min = 74.dp).background(skin.surface, RoundedCornerShape(16.dp))
            .combinedClickable(role = Role.Button, onClickLabel = "Open session", onLongClickLabel = "Workout actions",
                onClick = onOpen, onLongClick = { haptics.revealed(); menu = true })
            .semantics { customActions = listOf(CustomAccessibilityAction("Share this workout") { onShare(); true },
                CustomAccessibilityAction(Finish.discard) { onDiscard(); true }) }.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(row.title, style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp), color = skin.ink)
                if (dateBelowTitle) Text(row.date, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                Text(row.facts, modifier = Modifier.fillMaxWidth(), style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = if (row.record) skin.prInk else skin.inkDim)
                if (row.onThisDeviceOnly) Text("On this device", style = WindmillFont.body(14), color = skin.inkDim)
            }
            if (!dateBelowTitle) Text(row.date, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            DropdownMenu(menu, { menu = false }, containerColor = skin.raised) {
                DropdownMenuItem(text = { Text("Share this workout") }, onClick = { menu = false; onShare() })
                DropdownMenuItem(text = { Text(Finish.discard) }, onClick = { menu = false; onDiscard() })
            }
        }
    }
}

@Composable
private fun LogFoot(older: Older, first: SessionSummary?, onLoad: () -> Unit) {
    val skin = LocalGymColors.current
    if (older == Older.End) {
        if (first != null) Text("First session · ${Readout.date(first.startedAtMs)}", style = WindmillFont.body(14), color = skin.inkDim)
        return
    }
    Button(onClick = onLoad, enabled = older != Older.Loading, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = skin.raised, contentColor = skin.ink)) {
        Text(when (older) { Older.Failed -> "Retry"; Older.Loading -> "Loading"; else -> "Load older" })
    }
    if (older == Older.Failed) Text("That read failed.", style = WindmillFont.body(14), color = skin.inkDim)
}
