package works.windmill.gym.ui

import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
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
import works.windmill.platform.opening
import works.windmill.platform.telemetry.LocalTelemetry
import android.text.format.DateFormat
import androidx.compose.ui.platform.LocalContext
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text
import works.windmill.platform.i18n.joined

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

// What the sign-in decision says about the training this phone holds: each kind counted, the kinds listed as a sentence lists them.
class PhoneSignInWords(decisions: Map<String, Map<String, Int>>) {
    private val items = buildList<Pair<Int, Words>> {
        val gym = decisions["gym"].orEmpty()
        for ((type, noun) in listOf("session" to R.plurals.gym_phone_held_workouts, "routine" to R.plurals.gym_phone_held_routines,
            "weighin" to R.plurals.gym_phone_held_weigh_ins, "exercise" to R.plurals.gym_phone_held_movements,
            "note" to R.plurals.gym_phone_held_notes, "thread" to R.plurals.gym_phone_held_conversations)) {
            val count = gym[type] ?: 0
            if (count > 0) add(count to Words.Counted(noun, count, listOf(count.toString())))
        }
        val pages = decisions["journal"]?.get("page") ?: 0
        if (pages > 0) add(pages to Words.Counted(R.plurals.gym_phone_held_journal_pages, pages, listOf(pages.toString())))
    }
    val phrase: Words = when (items.size) {
        0 -> Words.Message(R.string.gym_phone_held_training)
        1 -> items.single().second
        else -> Words.Message(R.string.gym_phone_list_last, listOf(
            items.dropLast(1).map { it.second }.reduce { listed, next -> Words.Message(R.string.gym_phone_list_next, listOf(listed, next)) },
            items.last().second))
    }
    private val single = items.sumOf { it.first.toLong() } <= 1
    val question: Words = Words.Message(if (single) R.string.gym_phone_sign_in_question_it else R.string.gym_phone_sign_in_question_them, listOf(phrase))
    val discardTitle: Words = when {
        items.isEmpty() -> Words.Message(R.string.gym_phone_discard_training_title)
        items.size < 3 -> Words.Message(R.string.gym_phone_discard_held_title, listOf(phrase))
        else -> Words.Message(R.string.gym_phone_discard_all_title)
    }
    val discardBody: Words = when {
        items.size >= 3 -> Words.Message(R.string.gym_phone_discard_held_body, listOf(phrase))
        single -> Words.Message(R.string.gym_phone_discard_it_body)
        else -> Words.Message(R.string.gym_phone_discard_them_body)
    }
}

object PhoneRecovery {
    fun needsYou(rows: List<ImportRecovery>): Int = rows.count { !it.adding }
    fun named(row: ImportRecovery): Words = row.workout?.session?.plan?.routine?.let(Words::Plain)
        ?: if (row.workout != null) Readout.freeWorkout else Words.Message(R.string.gym_phone_saved_training)
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
    @Composable
    fun label(action: RecoveryAction): String = stringResource(when (action) {
        RecoveryAction.Keep -> R.string.gym_phone_keep_as_finished
        RecoveryAction.Retry -> R.string.gym_action_retry
        RecoveryAction.Fix -> R.string.gym_phone_fix_workout
        RecoveryAction.Discard -> R.string.gym_phone_discard_workout
    })
    @StringRes
    fun failure(action: RecoveryAction): Int = when (action) {
        RecoveryAction.Keep -> R.string.gym_phone_keep_failed
        RecoveryAction.Retry -> R.string.gym_phone_retry_failed
        RecoveryAction.Fix -> R.string.gym_phone_fix_failed
        RecoveryAction.Discard -> R.string.gym_phone_discard_failed
    }
    @Composable
    fun reason(row: ImportRecovery): String =
        if (row.adding) stringResource(R.string.gym_phone_adding_progress) else reason(row.refusals.first().code, row.refusals.first().why)
    @Composable
    fun reason(code: String, fallback: Words = WorkoutImports.reasonFor(code)): String = when (code) {
        "session-open", "session-already-open" -> stringResource(R.string.gym_phone_reason_open_workout)
        "session-overlap" -> stringResource(R.string.gym_phone_reason_overlap)
        "bad-instant", "clock-skew" -> stringResource(R.string.gym_phone_reason_bad_time)
        else -> fallback.text()
    }
}

@Composable
fun OnThisPhoneSection(read: RecoveryRead?, onList: () -> Unit, onInspect: (String) -> Unit) {
    val rows = read?.workouts.orEmpty()
    if (rows.isEmpty()) return
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        RecoveryHeading(stringResource(R.string.gym_phone_title))
        if (rows.size == 1) RecoveryRow(rows.single()) { onInspect(rows.single().id) }
        else Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).background(colors.surfaceContainer)
            .clickable(role = Role.Button, onClick = onList).padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                val counted = rows.all { it.workout != null }
                Text(if (counted) stringResource(R.string.gym_phone_workouts_count, rows.size.toString())
                    else stringResource(R.string.gym_phone_saved_training), style = GymType.listHeading, color = colors.onSurface)
                val needs = PhoneRecovery.needsYou(rows)
                Text(if (needs == 0) stringResource(R.string.gym_phone_adding_progress)
                    else if (counted) stringResource(R.string.gym_phone_need_you_count, needs.toString())
                    else stringResource(R.string.gym_phone_needs_you_status), style = WindmillType.detail, color = colors.onSurfaceVariant)
            }
        }
    }
}

@Composable
fun OnThisPhoneScreen(read: RecoveryRead, onBack: () -> Unit, onInspect: (String) -> Unit) {
    LaunchedEffect(read.workouts.isEmpty()) { if (read.workouts.isEmpty()) onBack() }
    val needsYouHeading = stringResource(R.string.gym_phone_needs_you_heading)
    val addingHeading = stringResource(R.string.gym_phone_adding_heading)
    GymScreen(stringResource(R.string.gym_phone_title), onBack = onBack, backTo = stringResource(R.string.gym_log_title)) {
        LazyColumn(Modifier.fillMaxSize().testTag("on-this-phone"), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for ((adding, title) in listOf(false to needsYouHeading, true to addingHeading)) {
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
    Text(text, style = WindmillType.detailLabel, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 4.dp))
}

@Composable
private fun RecoveryRow(row: ImportRecovery, onInspect: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val date = row.workout?.session?.startedAtMs?.let { ms ->
        val day = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()
        if (day == LocalDate.now()) Words.Message(R.string.gym_phone_today) else Readout.dayMonth(day)
    }
    Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).background(colors.surfaceContainer)
        .clickable(role = Role.Button, onClick = onInspect).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val facts = listOfNotNull(PhoneRecovery.named(row), date, row.workout?.let { Readout.sets(PhoneRecovery.sets(row).size) })
            Text(checkNotNull(facts.joined()).text(), style = WindmillType.rowLabel, color = colors.onSurface)
            Text(PhoneRecovery.reason(row), style = WindmillType.detail, color = colors.onSurfaceVariant)
        }
        if (row.adding) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
    }
}

@Composable
fun WorkoutInspectScreen(state: RecoveryState, events: RecoveryEvents, read: RecoveryRead, row: ImportRecovery,
    onBack: () -> Unit, currentOwner: () -> Boolean) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    var submitted by remember(row.sourceKey) { mutableStateOf(false) }
    val busy = state.busy || submitted
    var menu by rememberSaveable(row.id) { mutableStateOf(false) }
    var discardSource by rememberSaveable { mutableStateOf<String?>(null) }
    var message by rememberSaveable(row.sourceKey) { mutableStateOf<Words?>(null) }
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
                is RecoveryResult.Refused -> { discardSource = null; message = result.words }
                RecoveryResult.Failed -> { discardSource = null; message = Words.Message(PhoneRecovery.failure(action)) }
                null -> Unit
            } } finally { submitted = false }
        }
    }
    LaunchedEffect(row.id) { telemetry.event("gym_import_recovery", mapOf("action" to "inspect", "state" to "opened")) }
    GymScreen(PhoneRecovery.named(row).text(), onBack = onBack, backTo = stringResource(R.string.gym_phone_title), actions = {
        if (PhoneRecovery.canDiscard(row) || PhoneRecovery.canFix(row)) Box {
            IconButton(onClick = { menu = true }, enabled = !busy) { Icon(Icons.Default.MoreVert, stringResource(R.string.gym_action_more)) }
            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                if (PhoneRecovery.canFix(row) && primary != RecoveryAction.Fix) DropdownMenuItem(text = { Text(stringResource(R.string.gym_phone_fix_workout)) }, onClick = ::fix)
                if (PhoneRecovery.canDiscard(row)) DropdownMenuItem(text = { Text(stringResource(R.string.gym_phone_discard_workout), color = colors.error) }, onClick = {
                    menu = false; discardSource = row.sourceKey
                    telemetry.event("gym_import_recovery", mapOf("action" to "discard", "state" to "shown"))
                })
            }
        }
    }, bottomBar = {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            message?.let { RecoveryBand(it.text(), failed = true) }
            if (primary != null) Button(onClick = { act(primary) }, enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text(PhoneRecovery.label(primary), style = GymType.strongAction)
            }
        }
    }) {
        LazyColumn(Modifier.fillMaxSize().testTag("recovery-inspect"), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 0.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            row.workout?.let { copy ->
                item("date") { Text(Readout.day(copy.session.startedAtMs).text(), style = WindmillType.detail, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 4.dp)) }
                item("facts") { RecoveryFacts(row, state.catalog) }
            }
            item("reason") { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(PhoneRecovery.reason(row), style = WindmillType.detail, color = colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
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
    var failure by rememberSaveable { mutableStateOf<Int?>(null) }
    TextButton(onClick = { failure = update.opening(uri::openUri, telemetry) }) { Text(stringResource(update.named)) }
    failure?.let { RecoveryBand(stringResource(it), failed = true) }
}

@Composable
private fun RecoveryFacts(row: ImportRecovery, catalog: List<Exercise>) {
    val colors = MaterialTheme.colorScheme
    val copy = requireNotNull(row.workout)
    val sets = PhoneRecovery.sets(row)
    val summary = SessionSummary(copy.session, sets, catalog)
    val duration = if (row.operationsOnly) "—" else copy.session.finishedAtMs?.let { finish -> runCatching { Math.subtractExact(finish, copy.session.startedAtMs) }.getOrNull()?.takeIf { it >= 0 }?.let { Readout.lasted(it).text() } } ?: "—"
    val volume = summary.tonnageKg?.takeIf { it.isFinite() }?.let { stringResource(R.string.gym_phone_volume_kg, Readout.weight(it)) } ?: "—"
    Row(Modifier.fillMaxWidth().background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((value, caption) in listOf(duration to stringResource(R.string.gym_phone_duration), sets.size.toString() to stringResource(R.string.gym_phone_sets),
            volume to stringResource(R.string.gym_phone_volume))) Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(value, style = GymType.statValue, color = colors.onSurface)
            Text(caption, style = GymType.captionLoose, color = colors.onSurfaceVariant)
        }
    }
}

@Composable
private fun RecoveryBand(line: String, failed: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Text(line, style = WindmillType.detail, color = if (failed) colors.error else colors.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().background(colors.surfaceContainer, MaterialTheme.shapes.medium).padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite; if (failed) error(line) })
}

private fun androidx.compose.foundation.lazy.LazyListScope.recoveryMovements(sets: List<TrainingSet>, catalog: List<Exercise>,
    times: Boolean, onSet: ((TrainingSet) -> Unit)? = null) {
    val movements = Performed.movements(sets, catalog)
    movements.forEach { movement ->
        item("movement:${movement.id}") { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RecoveryHeading(movement.movement)
            val colors = MaterialTheme.colorScheme
            Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(horizontal = 16.dp)) {
                movement.rows.forEachIndexed { index, row ->
                    Row(Modifier.fillMaxWidth().testTag("recovery-set:${row.id}").then(if (onSet == null) Modifier else Modifier.clickable(role = Role.Button) { onSet(row.set) })
                        .heightIn(min = if (times) 59.dp else 42.dp).padding(vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(row.savedNumber.toString(), style = GymType.numeralMedium, color = colors.onSurfaceVariant)
                        Column(Modifier.weight(1f)) {
                            Text(row.effort, style = GymType.numeralMedium, color = colors.onSurface)
                            if (times) Text(Readout.time(row.set.completedAtMs).text(), style = GymType.captionLoose, color = colors.onSurfaceVariant)
                        }
                    }
                    if (index < movement.rows.lastIndex) HorizontalDivider(color = colors.onSurfaceVariant.copy(alpha = .12f))
                }
            }
        } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecoveryTimes(session: Session, onPick: ((String) -> Unit)? = null, markFinished: (() -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    val largeText = GymTextScale.large
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(horizontal = 16.dp)) {
        for ((index, field) in listOf(Triple("Started", session.startedAtMs, R.string.gym_phone_started),
            Triple("Finished", session.finishedAtMs, R.string.gym_phone_finished)).withIndex()) {
            if (index > 0) HorizontalDivider(color = colors.onSurfaceVariant.copy(alpha = .12f))
            val values: @Composable () -> Unit = {
                val hours24 = DateFormat.is24HourFormat(LocalContext.current)
                val instant = field.second
                if (instant == null) {
                    Text(stringResource(R.string.gym_phone_not_finished), style = WindmillType.supporting, color = colors.onSurfaceVariant)
                    if (markFinished != null) TextButton(onClick = markFinished) { Text(stringResource(R.string.gym_phone_mark_finished)) }
                } else if (onPick == null) {
                    val otherDay = Instant.ofEpochMilli(instant).atZone(ZoneId.systemDefault()).toLocalDate() !=
                        Instant.ofEpochMilli(session.startedAtMs).atZone(ZoneId.systemDefault()).toLocalDate()
                    Text(if (otherDay) "${Readout.date(instant).text()} · ${Readout.time(instant, hours24).text()}" else Readout.time(instant, hours24).text(),
                        style = WindmillType.supportingParagraph, color = colors.onSurfaceVariant)
                } else {
                    AssistChip(onClick = { onPick("${field.first}:date") }, label = { Text(Readout.date(instant).text()) })
                    AssistChip(onClick = { onPick("${field.first}:time") }, label = { Text(Readout.time(instant, hours24).text()) })
                }
            }
            if (largeText) Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(field.third), style = WindmillType.supportingParagraph, color = colors.onSurface)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { values() }
            } else Row(Modifier.fillMaxWidth().heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(field.third), style = WindmillType.supportingParagraph, color = colors.onSurface, modifier = Modifier.weight(1f))
                values()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkoutFixScreen(state: RecoveryState, events: RecoveryEvents, currentOwner: () -> Boolean) {
    val draft = state.fixDraft ?: return
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    var picking by rememberSaveable(draft.row.sourceKey) { mutableStateOf<String?>(null) }
    var editing by rememberSaveable(draft.row.sourceKey) { mutableStateOf<String?>(null) }
    var failure by rememberSaveable(draft.row.sourceKey) { mutableStateOf<Words?>(null) }
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
        Box(Modifier.fillMaxSize().background(colors.surface).systemBarsPadding()) {
            BackHandler { close() }
            GymScreen(stringResource(R.string.gym_phone_fix_workout), navigation = {
                IconButton(onClick = ::close, enabled = !busy) { Icon(Icons.Default.Close, stringResource(R.string.gym_action_close)) }
            }, actions = {
                TextButton(enabled = !busy && !checking && held == null, onClick = {
                    if (busy || checking || held != null) return@TextButton
                    submitted = true; failure = null
                    telemetry.event("gym_import_recovery", mapOf("action" to "fix", "state" to "started"))
                    scope.launch {
                        try {
                            when (val result = events.recover(draft.read, draft.row, RecoveryAction.Fix, draft, currentOwner)) {
                                RecoveryResult.Accepted -> Unit
                                is RecoveryResult.Refused -> failure = result.words
                                RecoveryResult.Failed -> failure = Words.Message(PhoneRecovery.failure(RecoveryAction.Fix))
                                null -> Unit
                            }
                        } finally { submitted = false }
                    }
                }) { Text(stringResource(R.string.gym_phone_save_and_retry)) }
            }, bottomBar = {
                val line = failure?.text() ?: held?.let { PhoneRecovery.reason(it) }
                if (line != null) Box(Modifier.padding(horizontal = 20.dp).padding(bottom = 16.dp)) { RecoveryBand(line, failed = failure != null) }
            }) {
                LazyColumn(Modifier.fillMaxSize().testTag("recovery-fix"), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    item("times") { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        RecoveryHeading(stringResource(R.string.gym_phone_times))
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
                        Row(Modifier.fillMaxWidth().background(colors.surfaceContainer, MaterialTheme.shapes.large).padding(horizontal = 16.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.gym_phone_linked_to, plan.routine), style = WindmillType.supporting, color = colors.onSurface, modifier = Modifier.weight(1f))
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
                        }) { Text(stringResource(R.string.gym_phone_use_date)) }
                    }, dismissButton = { TextButton(onClick = ::cancel) { Text(stringResource(R.string.gym_action_cancel)) } }) { DatePicker(picker) }
                } else {
                    val picker = rememberTimePickerState(local.hour, local.minute, is24Hour = DateFormat.is24HourFormat(LocalContext.current))
                    AlertDialog(onDismissRequest = ::cancel, title = { Text(stringResource(if (started) R.string.gym_phone_started_time else R.string.gym_phone_finished_time)) }, text = { TimePicker(picker) },
                        confirmButton = { TextButton(onClick = { use(local.withHour(picker.hour).withMinute(picker.minute).toInstant().toEpochMilli()) }) { Text(stringResource(R.string.gym_phone_use_time)) } },
                        dismissButton = { TextButton(onClick = ::cancel) { Text(stringResource(R.string.gym_action_cancel)) } })
                }
            }
        }
        val set = draft.copy.sets.firstOrNull { it.id == editing }
        if (set != null) {
            val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            WindmillSheet(onDismissRequest = { editing = null }, sheetState = sheet, containerColor = colors.surface) {
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
                    }, onSaved = { editing = null }, onClose = { editing = null }, draftKey = "recovery:${draft.row.sourceKey}:${set.id}",
                    exercise = state.catalog.firstOrNull { it.id == set.exerciseId })
            }
        }
    }
}

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
private fun OverlappingWorkoutPreview(fixing: Boolean) {
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
        listOf(ImportRefusal("refusal-phone", copy.session, copy.sets, emptyList(), "session-overlap", WorkoutImports.reasonFor("session-overlap"))),
        listOf(ImportOpening("import-phone", "replica-phone", anonymous = true, sources = mapOf("session-phone" to "phone"))))
    val read = RecoveryRead("https://windmill.works", "user-preview", 1, "replica-phone", listOf(row))
    val state = PreviewRecoveryState(fixDraft = if (fixing) RecoveryDraft(read, row, copy) else null)
    GymPreview {
        if (fixing) WorkoutFixScreen(state, PreviewRecoveryEvents, currentOwner = { true })
        else WorkoutInspectScreen(state, PreviewRecoveryEvents, read, row, onBack = {}, currentOwner = { true })
    }
}

@DarkAndDaylight
@Composable
private fun InspectPreview() = OverlappingWorkoutPreview(fixing = false)

@DarkAndDaylight
@Composable
private fun FixPreview() = OverlappingWorkoutPreview(fixing = true)
