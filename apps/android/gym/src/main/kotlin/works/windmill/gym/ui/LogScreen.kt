package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.ZoneId
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.progressReading
import works.windmill.gym.domain.progressSeries
import works.windmill.gym.domain.LogReadout
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
    val weeks = LogReadout.weeks(store.recent, onThisDevice, nowMs, store.progress)
    val logHolds = store.allSessions.any { !it.session.isOpen }
    val load: () -> Unit = { scope.launch { store.loadOlder() } }
    var weighingIn by rememberSaveable { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var refused by rememberSaveable { mutableStateOf<String?>(null) }
    val formState = rememberSaveableStateHolder()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !saving })
    val listState = rememberLazyListState()
    val cardState = rememberLazyListState()
    val cards = store.progress?.recentMovements(nowMs, zone).orEmpty()
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
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp)) {
                item("head") {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        LogReadout.head(weeks, store.older == Older.More || store.older == Older.Loading, logHolds)?.let {
                            Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                        }
                        store.progress?.consistencyWeeks(nowMs, zone)?.let {
                            Text("Trained $it of the last 4 weeks", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.ink)
                        }
                    }
                }
                if (store.latestWeighIn != null) item("bodyweight") {
                    BodyweightReading(store.latestWeighIn, nowMs, onOpenBodyweight)
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
                if (cards.isNotEmpty()) item("progress") {
                    BoxWithConstraints(Modifier.fillMaxWidth()) {
                        val width = if (LocalDensity.current.fontScale >= 1.5f) maxWidth else minOf(280.dp, maxWidth)
                        LazyRow(state = cardState, flingBehavior = rememberSnapFlingBehavior(cardState), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            items(cards, key = { it.exerciseId }) { card ->
                                ProgressCard(card, Readout.movement(card.exerciseId, store.catalog), nowMs, zone,
                                    Modifier.width(width), store.progress?.movement(card.exerciseId)?.best?.id) { onOpenMovement(card.exerciseId) }
                            }
                        }
                    }
                }
                if (weeks.isEmpty()) {
                    when {
                        store.older == Older.End && !logHolds -> item("empty") {
                            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                                Text("No sessions yet", style = WindmillFont.body(28, FontWeight.Bold).copy(lineHeight = 39.sp), color = skin.ink)
                                Text("Your training will land here.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                            }
                        }
                        store.older == Older.Failed -> item("failed") { LogFoot(Older.Failed, null, load) }
                    }
                } else {
                    weeks.forEach { week ->
                        item("week:${week.startMs}") {
                            Text(week.label.replaceFirstChar { it.titlecase() }, style = WindmillFont.body(14, FontWeight.Bold), color = skin.inkDim)
                        }
                        items(week.rows, key = { it.summary.id }) { row ->
                            SessionRow(row, { onOpenSession(row.summary) }, { onShareSession(row.summary.id) }, { onDiscardSession(row.summary.id) })
                        }
                    }
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
private fun ProgressCard(card: MovementProgress, name: String, nowMs: Long, zone: ZoneId, modifier: Modifier,
    standingBestId: String?, onOpen: () -> Unit) {
    val skin = LocalGymColors.current
    Column(modifier.background(skin.surface, RoundedCornerShape(20.dp)).clickable(role = Role.Button, onClickLabel = "Open movement record", onClick = onOpen).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("$name ›", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp), color = skin.ink)
        if (card.hasChart(zone)) DatedPlot(progressSeries(card, nowMs, zone), standingBestId = standingBestId)
        Text("Last 12 weeks · ${Readout.sessionCount(card.sessions.size)}", style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
        val latest = card.latest
        val best = card.best
        if (latest != null && latest.id != best?.id) Text("Latest ${progressReading(latest, nowMs)}", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        best?.let { Text("Best e1RM ${Readout.estimatedWeight(it.fact.estimate!!.e1rm)} kg · ${Readout.briefDay(it.startedAt, nowMs)}",
            style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = if (it.id == standingBestId) skin.prInk else skin.ink) }
        card.heaviest?.let { Text("Heaviest ${Readout.effort(it.fact.heaviest.weightKg, it.fact.heaviest.reps)} · ${Readout.briefDay(it.startedAt, nowMs)}",
            style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim) }
    }
}

@Composable
private fun SessionRow(row: LogReadout.Row, onOpen: () -> Unit, onShare: () -> Unit, onDiscard: () -> Unit) {
    val skin = LocalGymColors.current
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberGymHaptics()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 80.dp).background(skin.surface, RoundedCornerShape(16.dp))
            .combinedClickable(role = Role.Button, onClickLabel = "Open session", onLongClickLabel = "Workout actions",
                onClick = onOpen, onLongClick = { haptics.revealed(); menu = true })
            .semantics { customActions = listOf(CustomAccessibilityAction("Share this workout") { onShare(); true },
                CustomAccessibilityAction(Finish.discard) { onDiscard(); true }) }.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(row.title, style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp), color = skin.ink)
                Text(row.facts, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                if (row.onThisDeviceOnly) Text("On this device", style = WindmillFont.body(14), color = skin.inkDim)
                if (row.record) Text("Record set", style = WindmillFont.body(14), color = skin.inkDim)
            }
            Text("›", style = WindmillFont.body(24), color = skin.inkDim)
            DropdownMenu(menu, { menu = false }, containerColor = skin.raised) {
                DropdownMenuItem(text = { Text("Share this workout") }, onClick = { menu = false; onShare() })
                DropdownMenuItem(text = { Text(Finish.discard) }, onClick = { menu = false; onDiscard() })
            }
        }
        row.caption?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim) }
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
