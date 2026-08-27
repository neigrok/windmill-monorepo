package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.Older
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Weeks are the CLIENT's fold and start Monday in the zone the lifter trained in, never in UTC.
object LogFold {
    data class Row(
        val summary: SessionSummary,
        val title: String,
        val at: String,
        val working: String?,
        val tonnage: String?,
        val estimate: String?,
        val onThisDeviceOnly: Boolean,
        val record: Boolean,
    )

    // `startMs` is the week's Monday and its identity: the label carries no year, so two Januaries
    // five years apart print the same words, and a list may not key two rows the same.
    data class Week(val startMs: Long, val label: String, val tonnage: String?, val rows: List<Row>)

    // `complete` is whether the log has been read to its bottom; only the oldest week may be partial.
    fun weeks(
        sessions: List<SessionSummary>,
        onThisDevice: Set<String>,
        complete: Boolean,
        nowMs: Long,
    ): List<Week> {
        val buckets = sessions
            .filter { !it.session.isOpen }
            .sortedByDescending { it.startedAtMs }
            .groupBy { monday(it.startedAtMs) }
        val oldest = buckets.keys.lastOrNull()
        return buckets.map { (start, sessionsInWeek) ->
            Week(
                startMs = start,
                label = Readout.weekOf(start),
                // One session with no tonnage takes the whole week's caption rather than a short total.
                tonnage = when {
                    start == oldest && !complete -> null
                    sessionsInWeek.any { it.tonnageKg == null } -> null
                    else -> Readout.tonnes(sessionsInWeek.sumOf { it.tonnageKg ?: 0.0 })
                },
                rows = sessionsInWeek.map { summary ->
                    Row(
                        summary = summary,
                        title = summary.plan?.routine ?: Readout.noRoutine,
                        at = Readout.whenLogged(summary.startedAtMs, nowMs),
                        working = summary.workingSetCount?.let(Readout::workingSets),
                        tonnage = summary.tonnageKg?.let(Readout::tonnes),
                        estimate = summary.topE1rm?.let(Readout::estimate),
                        onThisDeviceOnly = summary.id in onThisDevice,
                        record = summary.record,
                    )
                },
            )
        }
    }

    private fun monday(ms: Long): Long {
        val zone = ZoneId.systemDefault()
        val date = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val monday = date.minusDays(((date.dayOfWeek.value + 6) % 7).toLong())
        return monday.atStartOfDay(zone).toInstant().toEpochMilli()
    }
}

// The reading sits in the head with the title; the one input, the weigh-in chip, is PINNED under the
// list in the reach band — the head scrolls away exactly when a hand reaches for it.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogScreen(
    store: TrainingStore,
    seat: String,
    onOpenSession: (SessionSummary) -> Unit,
    onOpenBodyweight: () -> Unit,
    onShareSession: (String) -> Unit,
    onDiscardSession: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    val onThisDevice = store.shelved.map { it.id }.toSet()
    val weeks = LogFold.weeks(store.recent, onThisDevice, complete = store.older == Older.End, nowMs = nowMs)
    val load: () -> Unit = { scope.launch { store.loadOlder() } }
    var weighingIn by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            weighingIn = false
            refused = null
        }
    }

    GymScreen(title = "The log", actions = { YouSeat(seat) }) {
        Column(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(
                    start = WindmillSpace.x5,
                    end = WindmillSpace.x5,
                    bottom = WindmillSpace.x4,
                ),
            ) {
                item("head") {
                    Column {
                        headLine(weeks, store.older)?.let {
                            Text(it, style = GymType.numeral(13), color = GymSkin.inkFaint)
                        }
                        BodyweightReading(store.latestWeighIn, nowMs, onOpen = onOpenBodyweight)
                    }
                }

                // Three silences: the log said so · the read failed · the log has not answered yet.
                if (weeks.isEmpty()) {
                    when (store.older) {
                        Older.End -> item("empty") { Empty() }
                        Older.Failed -> item("failed") {
                            LogFoot(Older.Failed, first = null, onLoad = load)
                        }
                        else -> Unit
                    }
                    return@LazyColumn
                }

                weeks.forEach { week ->
                    item("week:${week.startMs}") { WeekDivider(week) }
                    items(week.rows, key = { it.summary.id }) { row ->
                        Box(Modifier.padding(bottom = WindmillSpace.x2)) {
                            SessionRow(
                                row = row,
                                onOpen = { onOpenSession(row.summary) },
                                onShare = { onShareSession(row.summary.id) },
                                onDiscard = { onDiscardSession(row.summary.id) },
                            )
                        }
                    }
                }

                item("foot") {
                    LogFoot(
                        older = store.older,
                        first = weeks.lastOrNull()?.rows?.lastOrNull()?.summary,
                        onLoad = load,
                    )
                }
            }
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = WindmillSpace.x5)
                    .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3),
            ) {
                WeighInChip(onOpen = { weighingIn = true })
            }
        }
    }

    if (weighingIn) {
        ModalBottomSheet(
            onDismissRequest = { close() },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
        ) {
            WeighInSheet(
                initial = null,
                fixedDate = null,
                nowMs = nowMs,
                units = store.preferences.units,
                saving = saving,
                refused = refused,
                onSave = { dateLocal, weightKg ->
                    scope.launch {
                        if (saving) return@launch
                        saving = true
                        try {
                            refused = null
                            val failed = store.weighIn(dateLocal, weightKg)
                            if (failed != null) {
                                refused = failed.line("that weigh-in stayed on this device")
                                return@launch
                            }
                            close()
                        } finally {
                            saving = false
                        }
                    }
                },
                onDelete = null,
            )
        }
    }
}

@Composable
private fun WeekDivider(week: LogFold.Week) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x4, bottom = WindmillSpace.x2),
    ) {
        Text(
            week.label.uppercase(),
            style = GymType.numeral(11).copy(letterSpacing = 0.07.em),
            color = GymSkin.inkFaint,
        )
        Box(
            Modifier
                .weight(1f)
                .height(1.dp)
                .background(GymSkin.line),
        )
        week.tonnage?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
    }
}

// `record` is one bool over three rules — best e1RM, most reps at a weight, heaviest load for any
// reps — and the wire does not say which was earned, so nothing here may colour a number gold.
//
// The long press draws nothing and carries BOTH acts — `Share this workout` and `Discard session`.
// 13-gestures kept Discard out of this menu only until the withheld delete existed; it does now, so
// discarding here withholds for nine seconds exactly as the review screen's Discard does, and the
// review screen is the drawn door Law 1 asks for. A `⋮` on every row to carry an act the menu can
// hold would be Law 4 backwards: a gesture earns its place by REMOVING a control.
@Composable
private fun SessionRow(
    row: LogFold.Row,
    onOpen: () -> Unit,
    onShare: () -> Unit,
    onDiscard: () -> Unit,
) {
    var menuUp by remember { mutableStateOf(false) }
    val haptics = rememberGymHaptics()
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .combinedClickable(
                role = Role.Button,
                onClickLabel = "open this session",
                onLongClickLabel = "what you can do with this workout",
                onLongClick = {
                    haptics.revealed()
                    menuUp = true
                },
                onClick = onOpen,
            )
            // A long press is not reachable by a screen reader, so both of its acts are declared
            // again — this row draws no button for either of them.
            .semantics {
                customActions = listOf(
                    CustomAccessibilityAction("Share this workout") { onShare(); true },
                    CustomAccessibilityAction(Finish.discard) { onDiscard(); true },
                )
            }
            .padding(start = WindmillSpace.x4, end = WindmillSpace.x4, top = WindmillSpace.x3,
                     bottom = WindmillSpace.x3),
    ) {
        DropdownMenu(
            expanded = menuUp,
            onDismissRequest = { menuUp = false },
            containerColor = GymSkin.raised,
        ) {
            DropdownMenuItem(
                text = { Text("Share this workout", color = GymSkin.ink) },
                onClick = {
                    menuUp = false
                    onShare()
                },
            )
            DropdownMenuItem(
                text = { Text(Finish.discard, color = GymSkin.alarmInk) },
                onClick = {
                    menuUp = false
                    onDiscard()
                },
            )
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(row.title, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            if (row.record) {
                Box(
                    Modifier
                        .size(7.dp)
                        .background(GymSkin.prInk, CircleShape)
                        .semantics { contentDescription = "a record was set" },
                )
            }
            if (row.onThisDeviceOnly) {
                Box(
                    Modifier
                        .size(7.dp)
                        .border(1.5.dp, GymSkin.unsyncedInk, CircleShape)
                        .semantics { contentDescription = "on this device only" },
                )
            }
            Spacer(Modifier.weight(1f))
            Text(row.at, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            row.working?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
            row.tonnage?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
            row.estimate?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
        }
    }
}

@Composable
private fun LogFoot(older: Older, first: SessionSummary?, onLoad: () -> Unit) {
    if (older == Older.End) {
        if (first == null) return
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .padding(top = WindmillSpace.x3),
        ) {
            Text(
                "first session · ${Readout.date(first.startedAtMs)}",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }
        return
    }
    if (older == Older.Failed) {
        FootBox("That read failed · retry", GymSkin.alarmInk, GymSkin.alarmInk, onLoad)
        return
    }
    if (older == Older.Loading) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .padding(top = WindmillSpace.x3)
                .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
                .padding(horizontal = WindmillSpace.x4),
        ) {
            Spacer(Modifier.weight(1f))
            CircularProgressIndicator(
                color = GymSkin.inkFaint,
                strokeWidth = 2.dp,
                modifier = Modifier.size(14.dp),
            )
            Text("Loading", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
            Spacer(Modifier.weight(1f))
        }
        return
    }
    FootBox("Load older", GymSkin.inkDim, GymSkin.lineStrong, onLoad)
}

@Composable
private fun FootBox(label: String, ink: Color, line: Color, onTap: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .padding(top = WindmillSpace.x3)
            .border(1.dp, line, RoundedCornerShape(WindmillRadius.lg))
            .clickable(role = Role.Button, onClick = onTap),
    ) {
        Text(label, style = WindmillFont.body(15, FontWeight.SemiBold), color = ink)
    }
}

@Composable
private fun Empty() {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier.padding(top = WindmillSpace.x6),
    ) {
        Text("No sessions yet.", style = WindmillFont.body(16), color = GymSkin.inkDim)
        Text(
            "The first one you log lands here, newest first.",
            style = WindmillFont.body(15),
            color = GymSkin.inkFaint,
        )
    }
}

// Both halves count what is IN HAND: the wire answers pages and there is no total to ask for.
private fun headLine(weeks: List<LogFold.Week>, older: Older): String? {
    if (weeks.isEmpty()) {
        if (older == Older.End || older == Older.Failed) return null
        return "opening the log…"
    }
    val sessions = Readout.sessionCount(weeks.sumOf { it.rows.size })
    if (weeks.size == 1) return "$sessions · 1 week loaded"
    return "$sessions · ${weeks.size} weeks loaded"
}
