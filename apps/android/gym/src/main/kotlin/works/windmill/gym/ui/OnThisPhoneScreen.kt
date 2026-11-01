package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.PlanEntry
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TheSix
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.*
import works.windmill.platform.LocalClientUpdateDestination
import works.windmill.platform.open
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.telemetry.LocalTelemetry

// What the recovery journal draws: a copy kept on this phone, inspected and fixed.
@Stable
interface RecoveryState {
    val busy: Boolean
    val fixDraft: RecoveryDraft?
    val catalog: List<Exercise>
}

// What the recovery journal asks of the stores.
interface RecoveryEvents {
    fun beginFix(read: RecoveryRead, row: ImportRecovery): Boolean
    fun changeFix(opening: RecoveryDraft, copy: SavedWorkout, markFinished: Boolean)
    fun closeFix()
    suspend fun fixRefusal(draft: RecoveryDraft): String?
    suspend fun recover(read: RecoveryRead, row: ImportRecovery, action: RecoveryAction, draft: RecoveryDraft?,
        currentOwner: () -> Boolean): RecoveryResult?
}

// The recovery journal over the room's stores.
class RecoveryBinding(private val recovery: RecoveryStore, private val routines: RoutinesStore) : RecoveryState, RecoveryEvents {
    constructor(store: TrainingStore) : this(store.recovery, store.routines)

    override val busy: Boolean get() = recovery.busy
    override val fixDraft: RecoveryDraft? get() = recovery.fixDraft
    override val catalog: List<Exercise> get() = routines.catalog
    override fun beginFix(read: RecoveryRead, row: ImportRecovery): Boolean = recovery.beginFix(read, row)
    override fun changeFix(opening: RecoveryDraft, copy: SavedWorkout, markFinished: Boolean) =
        recovery.changeFix(opening, copy, markFinished)
    override fun closeFix() = recovery.closeFix()
    override suspend fun fixRefusal(draft: RecoveryDraft): String? = recovery.fixRefusal(draft)
    override suspend fun recover(read: RecoveryRead, row: ImportRecovery, action: RecoveryAction, draft: RecoveryDraft?,
        currentOwner: () -> Boolean): RecoveryResult? = recovery.recover(read, row, action, draft, currentOwner)
}

class PhoneSignInCopy(decisions: Map<String, Map<String, Int>>) {
    private val items = buildList {
        val gym = decisions["gym"].orEmpty()
        for ((type, noun) in listOf("session" to "workout", "routine" to "routine", "weighin" to "weigh-in", "exercise" to "movement", "note" to "note")) {
            val count = gym[type] ?: 0
            if (count > 0) add(count to "$count $noun${if (count == 1) "" else "s"}")
        }
        val pages = decisions["journal"]?.get("page") ?: 0
        if (pages > 0) add(pages to "$pages journal page${if (pages == 1) "" else "s"}")
    }
    val phrase: String = when (items.size) {
        0 -> "training"
        1 -> items.single().second
        2 -> items.joinToString(" and ") { it.second }
        else -> items.dropLast(1).joinToString(", ") { it.second } + " and " + items.last().second
    }
    private val single = items.sumOf { it.first.toLong() } <= 1
    val question = "This phone has $phrase from before you signed in. Your account already has training. Add ${if (single) "it" else "them"}, or discard ${if (single) "it" else "them"} from this phone."
    val discardTitle = if (items.isEmpty()) "Discard this phone’s training?" else if (items.size < 3) "Discard $phrase?" else "Discard all of it?"
    val discardBody = if (items.size >= 3) "$phrase ${if (single) "is" else "are"} deleted from this phone. You can’t undo this."
        else "${if (single) "It is" else "They are"} deleted from this phone. You can’t undo this."
}

object PhoneRecovery {
    fun needsYou(rows: List<ImportRecovery>): Int = rows.count { !it.adding }
    fun title(row: ImportRecovery): String = row.workout?.session?.plan?.routine
        ?: if (row.workout != null) Readout.noRoutine else "Saved training"
    fun sets(row: ImportRecovery): List<TrainingSet> = row.workout?.let { copy -> copy.sets.filterNot { it.id in copy.deleted } }
        ?: row.refusals.flatMap { it.sets }.distinctBy { it.id }
    fun canFix(row: ImportRecovery): Boolean = !row.adding && !row.operationsOnly && row.workout != null &&
        row.refusals.none { it.code in setOf("session-id-taken", "id-taken", "id-spent", "source-unreadable", "source-needs-update", "source-numbering", "source-auto-closed") }
    fun canDiscard(row: ImportRecovery): Boolean = !row.adding && !row.operationsOnly && row.workout != null && row.refusals.none { it.code in setOf("source-unreadable", "source-needs-update") }
    fun primary(row: ImportRecovery): RecoveryAction? {
        if (row.adding) return null
        val codes = row.refusals.map { it.code }
        if (row.workout?.session?.isOpen == true && codes.any { it in setOf("session-open", "session-already-open") }) return RecoveryAction.Keep
        if (canFix(row) && codes.any { it in setOf("session-overlap", "bad-instant", "clock-skew", "too-many-sets", "too-large", "frozen-plan-changed", "routine-missing", "stale", "invalid-set", "source-needs-correction") }) return RecoveryAction.Fix
        if (codes.all { it in setOf("session-open", "session-already-open", "unknown-exercise", "parent-dead", "session-finished", "recovery-session-open", "recovery-stale", "recovery-retry", "unsent") }) return RecoveryAction.Retry
        return null
    }
    fun label(action: RecoveryAction): String = when (action) {
        RecoveryAction.Keep -> "Keep as finished"
        RecoveryAction.Retry -> "Retry"
        RecoveryAction.Fix -> "Fix workout"
        RecoveryAction.Discard -> "Discard workout"
    }
    fun reason(row: ImportRecovery): String = if (row.adding) "Adding…" else reason(row.refusals.first().code, row.refusals.first().reason)
    fun reason(code: String, fallback: String = WorkoutImports.reason(code)): String = when (code) {
        "session-open", "session-already-open" -> "Your account has an open workout — keep this one as finished."
        "session-overlap" -> "Overlaps another workout — fix its times."
        "bad-instant", "clock-skew" -> "A time is invalid — fix its times."
        else -> fallback
    }
}

@Composable
fun OnThisPhoneSection(read: RecoveryRead?, onList: () -> Unit, onInspect: (String) -> Unit) {
    val rows = read?.workouts.orEmpty()
    if (rows.isEmpty()) return
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        RecoveryHeading("On this phone")
        if (rows.size == 1) RecoveryRow(rows.single()) { onInspect(rows.single().id) }
        else Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(skin.surface)
            .clickable(role = Role.Button, onClick = onList).padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                val counted = rows.all { it.workout != null }
                Text(if (counted) "${rows.size} workouts" else "Saved training", style = WindmillFont.body(18, FontWeight.Bold).copy(lineHeight = 25.sp), color = skin.ink)
                val needs = PhoneRecovery.needsYou(rows)
                Text(if (needs == 0) "Adding…" else if (counted) "$needs need you" else "Needs you", style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
            }
            RecoveryChevron()
        }
    }
}

@Composable
fun OnThisPhoneScreen(read: RecoveryRead, onBack: () -> Unit, onInspect: (String) -> Unit) {
    LaunchedEffect(read.workouts.isEmpty()) { if (read.workouts.isEmpty()) onBack() }
    GymScreen("On this phone", onBack = onBack, backTo = "The log") {
        LazyColumn(Modifier.fillMaxSize().testTag("on-this-phone"), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for ((adding, title) in listOf(false to "Needs you", true to "Adding")) {
                val rows = read.workouts.filter { it.adding == adding }
                if (rows.isNotEmpty()) {
                    item("heading:$adding") { RecoveryHeading(title) }
                    items(rows, key = { it.id }) { row -> RecoveryRow(row) { onInspect(row.id) } }
                }
            }
        }
    }
}

@Composable
private fun RecoveryHeading(text: String) {
    Text(text, style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = LocalGymColors.current.inkDim,
        modifier = Modifier.padding(horizontal = 4.dp))
}

@Composable
private fun RecoveryChevron() {
    Icon(painterResource(R.drawable.gym_chevron), null, Modifier.size(20.dp), tint = LocalGymColors.current.inkDim)
}

@Composable
private fun RecoveryRow(row: ImportRecovery, onInspect: () -> Unit) {
    val skin = LocalGymColors.current
    val date = row.workout?.session?.startedAtMs?.let { ms ->
        val today = LocalDate.now()
        if (Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate() == today) "Today"
        else Readout.date(ms).substringBeforeLast(" ")
    }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(skin.surface)
        .clickable(role = Role.Button, onClick = onInspect).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val facts = listOfNotNull(PhoneRecovery.title(row), date, row.workout?.let { Readout.setCount(PhoneRecovery.sets(row).size) })
            Text(facts.joinToString(" · "), style = WindmillFont.body(15, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            Text(PhoneRecovery.reason(row), style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        }
        if (row.adding) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        else RecoveryChevron()
    }
}

@Composable
fun WorkoutInspectScreen(state: RecoveryState, events: RecoveryEvents, read: RecoveryRead, row: ImportRecovery,
    onBack: () -> Unit, currentOwner: () -> Boolean) {
    val skin = LocalGymColors.current
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    var submitted by remember(row.sourceKey) { mutableStateOf(false) }
    val busy = state.busy || submitted
    var menu by rememberSaveable(row.id) { mutableStateOf(false) }
    var discardSource by rememberSaveable { mutableStateOf<String?>(null) }
    var message by rememberSaveable(row.sourceKey) { mutableStateOf<String?>(null) }
    val primary = PhoneRecovery.primary(row)
    fun fix() {
        menu = false
        if (events.beginFix(read, row)) telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "opened"))
    }
    fun act(action: RecoveryAction) {
        if (busy) return
        if (action == RecoveryAction.Fix) { fix(); return }
        submitted = true; message = null
        telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "state" to "started"))
        scope.launch {
            try { when (val result = events.recover(read, row, action, draft = null, currentOwner = currentOwner)) {
                RecoveryResult.Accepted -> { discardSource = null; if (action == RecoveryAction.Discard) onBack() }
                is RecoveryResult.Refused -> { discardSource = null; message = result.line }
                RecoveryResult.Failed -> { discardSource = null; message = "The original workout is still saved on this phone. ${PhoneRecovery.label(action)} could not be completed." }
                null -> Unit
            } } finally { submitted = false }
        }
    }
    LaunchedEffect(row.id) { telemetry.event("gym_import_recovery", mapOf("action" to "inspect", "state" to "opened")) }
    GymScreen(PhoneRecovery.title(row), onBack = onBack, backTo = "On this phone", actions = {
        if (PhoneRecovery.canDiscard(row) || PhoneRecovery.canFix(row)) Box {
            IconButton(onClick = { menu = true }, enabled = !busy) { Icon(Icons.Default.MoreVert, "More") }
            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                if (PhoneRecovery.canFix(row) && primary != RecoveryAction.Fix) DropdownMenuItem(text = { Text("Fix workout") }, onClick = ::fix)
                if (PhoneRecovery.canDiscard(row)) DropdownMenuItem(text = { Text("Discard workout", color = skin.error) }, onClick = {
                    menu = false; discardSource = row.sourceKey
                    telemetry.event("gym_import_recovery", mapOf("action" to "discard", "state" to "shown"))
                })
            }
        }
    }, bottomBar = {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            message?.let { RecoveryBand(it, failed = true) }
            if (primary != null) Button(onClick = { act(primary) }, enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(16.dp)) {
                Text(PhoneRecovery.label(primary), style = WindmillFont.body(15, FontWeight.Bold))
            }
        }
    }) {
        LazyColumn(Modifier.fillMaxSize().testTag("recovery-inspect"), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 0.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            row.workout?.let { copy ->
                item("date") { Text(Readout.day(copy.session.startedAtMs), style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim, modifier = Modifier.padding(horizontal = 4.dp)) }
                item("facts") { RecoveryFacts(row, state.catalog) }
            }
            item("reason") { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(PhoneRecovery.reason(row), style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.inkDim, modifier = Modifier.padding(horizontal = 16.dp))
                if (row.refusals.any { it.code in setOf("source-needs-update", "source-unreadable") }) RecoveryUpdate()
            } }
            if (!row.operationsOnly) row.workout?.let { copy -> item("times") { RecoveryTimes(copy.session) } }
            recoveryMovements(PhoneRecovery.sets(row), state.catalog, times = false)
        }
    }
    if (discardSource == row.sourceKey && PhoneRecovery.canDiscard(row)) WorkoutDiscardDialog(PhoneRecovery.sets(row).size, onDiscard = { act(RecoveryAction.Discard) },
        onCancel = {
            if (!busy) {
                discardSource = null
                telemetry.event("gym_import_recovery", mapOf("action" to "discard", "outcome" to "cancelled"))
            }
        }, busy = busy)
}

@Composable
private fun RecoveryUpdate() {
    val update = LocalClientUpdateDestination.current
    val uri = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    var failure by rememberSaveable { mutableStateOf<String?>(null) }
    TextButton(onClick = { failure = update.open(uri::openUri, telemetry) }) { Text(update.label) }
    failure?.let { RecoveryBand(it, failed = true) }
}

@Composable
private fun RecoveryFacts(row: ImportRecovery, catalog: List<Exercise>) {
    val skin = LocalGymColors.current
    val copy = requireNotNull(row.workout)
    val sets = PhoneRecovery.sets(row)
    val summary = SessionSummary(copy.session, sets, catalog)
    val duration = if (row.operationsOnly) "—" else copy.session.finishedAtMs?.let { finish -> runCatching { Math.subtractExact(finish, copy.session.startedAtMs) }.getOrNull()?.takeIf { it >= 0 }?.let(Readout::duration) } ?: "—"
    val volume = summary.tonnageKg?.takeIf { it.isFinite() }?.let { "${Readout.weight(it)} kg" } ?: "—"
    Row(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(16.dp)).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((value, caption) in listOf(duration to "Duration", sets.size.toString() to "Sets", volume to "Volume")) Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(value, style = WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 30.sp), color = skin.ink)
            Text(caption, style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
        }
    }
}

@Composable
private fun RecoveryBand(line: String, failed: Boolean = false) {
    val skin = LocalGymColors.current
    Text(line, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = if (failed) skin.error else skin.inkDim,
        modifier = Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(12.dp)).padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite; if (failed) error(line) })
}

private fun androidx.compose.foundation.lazy.LazyListScope.recoveryMovements(sets: List<TrainingSet>, catalog: List<Exercise>,
    times: Boolean, onSet: ((TrainingSet) -> Unit)? = null) {
    val movements = Performed.movements(sets, catalog)
    movements.forEach { movement ->
        item("movement:${movement.id}") { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RecoveryHeading(movement.movement)
            val skin = LocalGymColors.current
            Column(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp)) {
                movement.rows.forEachIndexed { index, row ->
                    Row(Modifier.fillMaxWidth().testTag("recovery-set:${row.id}").then(if (onSet == null) Modifier else Modifier.clickable(role = Role.Button) { onSet(row.set) })
                        .heightIn(min = if (times) 59.dp else 42.dp).padding(vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(row.savedNumber.toString(), style = GymType.numeral(14), color = skin.inkDim)
                        Column(Modifier.weight(1f)) {
                            Text(row.effort, style = GymType.numeral(14), color = skin.ink)
                            if (times) Text(Readout.time(row.set.completedAtMs), style = WindmillFont.body(12).copy(lineHeight = 17.sp), color = skin.inkDim)
                        }
                    }
                    if (index < movement.rows.lastIndex) HorizontalDivider(color = skin.inkDim.copy(alpha = .12f))
                }
            }
        } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecoveryTimes(session: Session, onPick: ((String) -> Unit)? = null, markFinished: (() -> Unit)? = null) {
    val skin = LocalGymColors.current
    val largeText = GymTextScale.large
    Column(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp)) {
        for ((index, field) in listOf("Started" to session.startedAtMs, "Finished" to session.finishedAtMs).withIndex()) {
            if (index > 0) HorizontalDivider(color = skin.inkDim.copy(alpha = .12f))
            val values: @Composable () -> Unit = {
                val instant = field.second
                if (instant == null) {
                    Text("Not finished", style = WindmillFont.body(14), color = skin.inkDim)
                    if (markFinished != null) TextButton(onClick = markFinished) { Text("Mark finished") }
                } else if (onPick == null) {
                    val otherDay = Instant.ofEpochMilli(instant).atZone(ZoneId.systemDefault()).toLocalDate() !=
                        Instant.ofEpochMilli(session.startedAtMs).atZone(ZoneId.systemDefault()).toLocalDate()
                    Text(if (otherDay) "${Readout.date(instant)} · ${Readout.time(instant)}" else Readout.time(instant),
                        style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
                } else {
                    AssistChip(onClick = { onPick("${field.first}:date") }, label = { Text(Readout.date(instant)) })
                    AssistChip(onClick = { onPick("${field.first}:time") }, label = { Text(Readout.time(instant)) })
                }
            }
            if (largeText) Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(field.first, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.ink)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { values() }
            } else Row(Modifier.fillMaxWidth().heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(field.first, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.ink, modifier = Modifier.weight(1f))
                values()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkoutFixScreen(state: RecoveryState, events: RecoveryEvents, currentOwner: () -> Boolean) {
    val draft = state.fixDraft ?: return
    val skin = LocalGymColors.current
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    var picking by rememberSaveable(draft.row.sourceKey) { mutableStateOf<String?>(null) }
    var editing by rememberSaveable(draft.row.sourceKey) { mutableStateOf<String?>(null) }
    var failure by rememberSaveable(draft.row.sourceKey) { mutableStateOf<String?>(null) }
    var held by remember(draft.row.sourceKey) { mutableStateOf<String?>(null) }
    var checking by remember(draft.row.sourceKey) { mutableStateOf(true) }
    var submitted by remember(draft.row.sourceKey) { mutableStateOf(false) }
    val busy = state.busy || submitted
    LaunchedEffect(draft) {
        checking = true
        held = events.fixRefusal(draft)
        checking = false
    }
    fun close() {
        if (busy) return
        telemetry.event("gym_import_recovery", mapOf("action" to "fix", "outcome" to "cancelled"))
        events.closeFix()
    }
    fun change(copy: SavedWorkout, markFinished: Boolean = draft.markFinished) {
        if (busy) return
        failure = null; checking = true
        events.changeFix(draft, copy, markFinished)
    }
    Dialog(onDismissRequest = ::close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(skin.canvas).systemBarsPadding()) {
            BackHandler { close() }
            GymScreen("Fix workout", navigation = {
                IconButton(onClick = ::close, enabled = !busy) { Icon(Icons.Default.Close, "Close") }
            }, actions = {
                TextButton(enabled = !busy && !checking && held == null, onClick = {
                    if (busy || checking || held != null) return@TextButton
                    submitted = true; failure = null
                    telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "started"))
                    scope.launch {
                        try {
                            when (val result = events.recover(draft.read, draft.row, RecoveryAction.Fix, draft, currentOwner)) {
                                RecoveryResult.Accepted -> Unit
                                is RecoveryResult.Refused -> failure = result.line
                                RecoveryResult.Failed -> failure = "The original workout is still saved on this phone. Fix workout could not be completed."
                                null -> Unit
                            }
                        } finally { submitted = false }
                    }
                }) { Text("Save and retry") }
            }, bottomBar = {
                val line = failure ?: held?.let { PhoneRecovery.reason(it) }
                if (line != null) Box(Modifier.padding(horizontal = 20.dp).padding(bottom = 16.dp)) { RecoveryBand(line, failed = failure != null) }
            }) {
                LazyColumn(Modifier.fillMaxSize().testTag("recovery-fix"), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    item("times") { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        RecoveryHeading("Times")
                        RecoveryTimes(draft.copy.session, onPick = { if (!busy) {
                            picking = it
                            telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to if (it.endsWith(":date")) "date_opened" else "time_opened"))
                        } }, markFinished = {
                            val finish = maxOf(draft.copy.session.startedAtMs, draft.copy.sets.maxOfOrNull { it.completedAtMs } ?: draft.copy.session.startedAtMs)
                            change(draft.copy.copy(session = draft.copy.session.copy(finishedAtMs = finish)), markFinished = true)
                            telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "marked_finished"))
                        })
                    } }
                    draft.row.workout?.session?.plan?.let { plan -> item("link") {
                        Row(Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Linked to ${plan.routine}", style = WindmillFont.body(14), color = skin.ink, modifier = Modifier.weight(1f))
                            Switch(checked = draft.copy.session.routineId != null, enabled = !busy, onCheckedChange = { linked ->
                                val original = requireNotNull(draft.row.workout).session
                                change(draft.copy.copy(session = draft.copy.session.copy(routineId = original.routineId.takeIf { linked }, plan = original.plan.takeIf { linked })))
                                telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "link_changed"))
                            })
                        }
                    } }
                    recoveryMovements(draft.copy.sets, state.catalog, times = true, onSet = { if (!busy) { editing = it.id
                        telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "set_opened")) } })
                }
            }
        }
        val target = picking
        if (target != null) {
            val started = target.startsWith("Started:")
            val at = if (started) draft.copy.session.startedAtMs else draft.copy.session.finishedAtMs
            if (at != null) key(target) {
                val local = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault())
                fun use(next: Long) {
                    val session = if (started) draft.copy.session.copy(startedAtMs = next) else draft.copy.session.copy(finishedAtMs = next)
                    change(draft.copy.copy(session = session)); picking = null
                    telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to if (target.endsWith(":date")) "date_confirmed" else "time_confirmed"))
                }
                fun cancel() {
                    picking = null
                    telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to if (target.endsWith(":date")) "date_cancelled" else "time_cancelled"))
                }
                if (target.endsWith(":date")) {
                    val picker = rememberDatePickerState(initialSelectedDateMillis = local.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
                    DatePickerDialog(onDismissRequest = ::cancel, confirmButton = {
                        TextButton(enabled = picker.selectedDateMillis != null, onClick = {
                            picker.selectedDateMillis?.let { selected ->
                                val date = Instant.ofEpochMilli(selected).atZone(ZoneOffset.UTC).toLocalDate()
                                use(date.atTime(local.toLocalTime()).atZone(local.zone).toInstant().toEpochMilli())
                            }
                        }) { Text("Use date") }
                    }, dismissButton = { TextButton(onClick = ::cancel) { Text("Cancel") } }) { DatePicker(picker) }
                } else {
                    val picker = rememberTimePickerState(local.hour, local.minute, is24Hour = true)
                    AlertDialog(onDismissRequest = ::cancel, title = { Text(fieldTitle(target)) }, text = { TimePicker(picker) },
                        confirmButton = { TextButton(onClick = { use(local.withHour(picker.hour).withMinute(picker.minute).toInstant().toEpochMilli()) }) { Text("Use time") } },
                        dismissButton = { TextButton(onClick = ::cancel) { Text("Cancel") } })
                }
            }
        }
        val set = draft.copy.sets.firstOrNull { it.id == editing }
        if (set != null) {
            val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            WindmillSheet(onDismissRequest = { editing = null }, sheetState = sheet, containerColor = skin.canvas) {
                FixSheet(set, Readout.movement(set.exerciseId, state.catalog),
                    Performed.movements(draft.copy.sets, state.catalog).flatMap { it.rows }.first { it.id == set.id }.savedNumber,
                    draft.copy.session.plan?.routine,
                    onSave = { fix ->
                        val changed = set.copy(weightKg = fix.weightKg ?: set.weightKg, reps = fix.reps ?: set.reps,
                            note = fix.note ?: set.note, rpe = if (fix.rpeNamed) fix.rpe else set.rpe)
                        change(draft.copy.copy(sets = draft.copy.sets.map { if (it.id == set.id) changed else it }))
                        telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "set_staged"))
                        FixOutcome.Corrected(changed)
                    }, onDelete = {
                        change(draft.copy.copy(sets = draft.copy.sets.filterNot { it.id == set.id }, deleted = (draft.copy.deleted + set.id).distinct()))
                        editing = null
                        telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "set_removed"))
                    }, onSaved = { editing = null }, draftKey = "recovery:${draft.row.sourceKey}:${set.id}",
                    exercise = state.catalog.firstOrNull { it.id == set.exerciseId })
            }
        }
    }
}

private fun fieldTitle(target: String): String = "${target.substringBefore(':')} time"

private data class PreviewRecoveryState(
    override val busy: Boolean = false,
    override val fixDraft: RecoveryDraft? = null,
    override val catalog: List<Exercise> = TheSix.movements,
) : RecoveryState

// Nothing is refused while fixing and no recovery answers.
private object PreviewRecoveryEvents : RecoveryEvents {
    override fun beginFix(read: RecoveryRead, row: ImportRecovery): Boolean = false
    override fun changeFix(opening: RecoveryDraft, copy: SavedWorkout, markFinished: Boolean) = Unit
    override fun closeFix() = Unit
    override suspend fun fixRefusal(draft: RecoveryDraft): String? = null
    override suspend fun recover(read: RecoveryRead, row: ImportRecovery, action: RecoveryAction, draft: RecoveryDraft?,
        currentOwner: () -> Boolean): RecoveryResult? = awaitCancellation()
}

// A workout this phone kept that overlaps one already on the account.
@Composable
private fun OverlappingWorkoutPreview(dark: Boolean, fixing: Boolean) {
    val started = 1_761_984_000_000L
    val copy = SavedWorkout(
        Session("session-phone", started, started + 48 * 60_000L, "routine-push",
            PlanSnapshot("Push Day", listOf(PlanEntry("bench-press", List(3) { SetTarget(8, 75.0) })))),
        listOf(
            TrainingSet("set-1", "bench-press", 1, 75.0, 8, completedAtMs = started + 8 * 60_000L),
            TrainingSet("set-2", "bench-press", 2, 75.0, 8, completedAtMs = started + 12 * 60_000L),
            TrainingSet("set-3", "bench-press", 3, 75.0, 7, completedAtMs = started + 16 * 60_000L),
        ),
    )
    val row = ImportRecovery("import-phone", copy,
        listOf(ImportRefusal("refusal-phone", copy.session, copy.sets, emptyList(), "session-overlap", "Overlaps another workout.")),
        listOf(ImportOpening("import-phone", "replica-phone", anonymous = true, sources = mapOf("session-phone" to "phone"))))
    val read = RecoveryRead("https://windmill.works", "user-preview", 1, "replica-phone", listOf(row))
    val state = PreviewRecoveryState(fixDraft = if (fixing) RecoveryDraft(read, row, copy) else null)
    CompositionLocalProvider(LocalWindmillDark provides dark) {
        GymMaterial {
            if (fixing) WorkoutFixScreen(state, PreviewRecoveryEvents, currentOwner = { true })
            else WorkoutInspectScreen(state, PreviewRecoveryEvents, read, row, onBack = {}, currentOwner = { true })
        }
    }
}

@Preview(name = "Inspect · Dark")
@Composable
private fun InspectDarkPreview() = OverlappingWorkoutPreview(dark = true, fixing = false)

@Preview(name = "Inspect · Daylight")
@Composable
private fun InspectDaylightPreview() = OverlappingWorkoutPreview(dark = false, fixing = false)

@Preview(name = "Fix · Dark")
@Composable
private fun FixDarkPreview() = OverlappingWorkoutPreview(dark = true, fixing = true)

@Preview(name = "Fix · Daylight")
@Composable
private fun FixDaylightPreview() = OverlappingWorkoutPreview(dark = false, fixing = true)
