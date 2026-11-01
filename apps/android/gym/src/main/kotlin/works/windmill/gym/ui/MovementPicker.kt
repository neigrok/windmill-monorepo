package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheet
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.ExerciseWrite
import works.windmill.gym.presentation.RoutineMovement
import works.windmill.gym.presentation.Ids
import works.windmill.gym.presentation.LastSet
import works.windmill.gym.presentation.Program
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.TheSix
import works.windmill.gym.presentation.TargetEntry
import works.windmill.platform.net.WindmillJson
import works.windmill.gym.store.MovementCreateOutcome
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.telemetry.LocalTelemetry

// A movement is a stable identity and never a typed string, so the only way to lift something the
// catalog has never heard of is to MINT it here. The last-done read is SPARSE, so `never logged` is
// drawn from an absence.
object PickerOptions {
    // A TYPED query is capped: seven rows are a shortlist, and dumping the catalog under three letters
    // is not an answer. An EMPTY query is not capped at all — it opens on the six and then hands over
    // the whole catalog, because a picker that shows only six has removed the ability to find the
    // seventh.
    const val shown = 7
    const val featured = 6

    // The six are counted over a FIXED depth of the log and never over more, so a phone that has paged
    // further back does not rank differently from one that has not.
    const val trainedWindow = 50

    // The bytes web says for the same silence.
    const val catalogUnread = "The catalog didn’t load. It comes back when you have signal."

    // `never logged` is only ever said where an ANSWER carried no row for that movement.
    // `alias` is the word the MATCH came from and is drawn on no other row.
    data class Row(
        val id: String,
        val name: String,
        val meta: String?,
        val alias: String? = null,
        val equipment: String = "barbell",
        val selected: Boolean = false,
    ) {
        constructor(movement: Exercise, lastSets: Map<String, LastSet>?, nowMs: Long,
                    alias: String? = null) : this(
            id = movement.id,
            name = movement.name,
            equipment = movement.equipment,
            alias = alias,
            // A map that has not landed says nothing at all, never `never logged`.
            meta = lastSets?.let { answered ->
                val last = answered[movement.id] ?: return@let "never logged"
                "last ${Readout.effort(last.weightKg, last.reps)} · ${Readout.ago(last.atMs, nowMs)}"
            },
        )
    }

    data class Result(
        val six: List<Row>,
        val matches: List<Row>,
        val unread: String?,
        val empty: String?,
    ) {
        val hasRows: Boolean get() = six.isNotEmpty() || matches.isNotEmpty()
    }

    // Most-used, off the log THIS DEVICE holds: a session summary names every movement in it, so the
    // count is sessions that named it rather than sets — the wire ranks nothing by use and
    // this invents no read. A session the LOG served names its movements by name and one this device
    // wrote names them by id, so a movement is counted by either spelling of itself. What the log
    // cannot fill is filled from the openers, in their own order, so a fresh account still sees six.
    fun mostTrained(available: List<Exercise>, sessions: List<SessionSummary>): List<Exercise> {
        val counted = mutableMapOf<String, Int>()
        for (session in sessions.take(trainedWindow)) {
            for (named in session.exercises.distinct()) counted[named] = (counted[named] ?: 0) + 1
        }
        val timesTrained = { movement: Exercise ->
            (counted[movement.id] ?: 0) + (counted[movement.name] ?: 0)
        }
        // `sortedByDescending` is stable, so movements trained equally often keep catalog order.
        val ranked = available
            .filter { timesTrained(it) > 0 }
            .sortedByDescending(timesTrained)
            .take(featured)
        if (ranked.size >= featured) return ranked
        val openers = TheSix.movements
            .mapNotNull { opener -> available.firstOrNull { it.id == opener.id } }
            .filterNot { it in ranked }
        return (ranked + openers).take(featured)
    }

    fun matching(
        query: String,
        catalog: List<Exercise>,
        taken: List<String>,
        lastSets: Map<String, LastSet>? = null,
        nowMs: Long = 0,
        sessions: List<SessionSummary> = emptyList(),
    ): Result {
        val term = query.trim()
        val available = catalog
        val six = if (term.isNotEmpty()) emptyList()
            else mostTrained(available, sessions).map { Row(it, lastSets, nowMs) }
        // The filter reads names AND aliases, one pass over the list already in hand.
        val wanted = term.lowercase()
        val rest = available
            .filter { movement -> six.none { it.id == movement.id } }
            .mapNotNull { movement ->
                if (term.isEmpty()) return@mapNotNull Row(movement, lastSets, nowMs)
                if (movement.name.lowercase().contains(wanted)) return@mapNotNull Row(movement, lastSets, nowMs)
                val alias = movement.aliases.firstOrNull { it.lowercase().contains(wanted) }
                    ?: return@mapNotNull null
                Row(movement, lastSets, nowMs, alias = alias)
            }
        val matches = if (term.isEmpty()) rest else rest.take(shown)

        val unread = if (catalog.isNotEmpty()) null else PickerOptions.catalogUnread
        val result = Result(six.map { it.copy(selected = it.id in taken) },
            matches.map { it.copy(selected = it.id in taken) }, unread, empty = null)
        if (result.hasRows || unread != null) return result
        return result.copy(empty = "No movement by that name.")
    }
}

// The sheet grows with its rows and stops short of the top, leaving the drag handle its own room —
// a fixed fraction of the screen would have the handle eat the last row instead.
@Composable
fun pickerMaxHeight(): Dp = (LocalConfiguration.current.screenHeightDp.dp * 0.92f) - 44.dp

@Stable
class MovementPickerState(
    query: String = "",
    createName: String? = null,
    equipment: String = Exercise.loadings.first(),
    requestId: String = "",
    refusal: String? = null,
    createOpen: Boolean = false,
    scheme: TargetEntry.Draft = TargetEntry.Draft(),
    loadCount: Int = if (equipment == "dumbbell") 2 else 1,
    created: Exercise? = null,
    submitted: ExerciseWrite? = null,
) {
    var createOpen by mutableStateOf(createOpen)
    var query by mutableStateOf(query)
    var createName by mutableStateOf(createName)
    var equipment by mutableStateOf(equipment)
    var requestId by mutableStateOf(requestId)
    var refusal by mutableStateOf(refusal)
    var busy by mutableStateOf(false)
    var scheme by mutableStateOf(scheme)
    var loadCount by mutableStateOf(loadCount)
    var created by mutableStateOf(created)
    var submitted by mutableStateOf(submitted)

    companion object {
        val saver = listSaver<MovementPickerState, Any>(
            save = { listOf(it.query, it.createName.orEmpty(), it.createName != null,
                it.equipment, it.requestId, it.refusal.orEmpty(), it.createOpen,
                WindmillJson.encodeToString(TargetEntry.Draft.serializer(), it.scheme), it.loadCount,
                it.created?.let { value -> WindmillJson.encodeToString(Exercise.serializer(), value) }.orEmpty(),
                it.submitted?.let { value -> WindmillJson.encodeToString(ExerciseWrite.serializer(), value) }.orEmpty()) },
            restore = { MovementPickerState(it[0] as String,
                (it[1] as String).takeIf { _ -> it[2] as Boolean }, it[3] as String,
                it[4] as String, (it[5] as String).takeIf(String::isNotEmpty), it[6] as Boolean,
                it.getOrNull(7)?.let { raw -> WindmillJson.decodeFromString(TargetEntry.Draft.serializer(), raw as String) }
                    ?: TargetEntry.Draft(),
                (it.getOrNull(8) as? Int) ?: if (it[3] == "dumbbell") 2 else 1,
                (it.getOrNull(9) as? String)?.takeIf(String::isNotEmpty)?.let { raw -> WindmillJson.decodeFromString(Exercise.serializer(), raw) },
                (it.getOrNull(10) as? String)?.takeIf(String::isNotEmpty)?.let { raw -> WindmillJson.decodeFromString(ExerciseWrite.serializer(), raw) }) },
        )
    }
}

@Composable
fun rememberMovementPickerState(vararg inputs: Any?): MovementPickerState = rememberSaveable(*inputs, saver = MovementPickerState.saver) {
    MovementPickerState()
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MovementPicker(
    catalog: List<Exercise>,
    taken: List<String>,
    lastSets: Map<String, LastSet>?,
    nowMs: Long,
    title: String,
    onPick: (String) -> Unit,
    onCreate: (suspend (ExerciseWrite) -> MovementCreateOutcome)?,
    modifier: Modifier = Modifier,
    sessions: List<SessionSummary> = emptyList(),
    subtitle: String? = null,
    onClose: (() -> Unit)? = null,
    state: MovementPickerState = rememberMovementPickerState(),
    onCreateDraft: ((Exercise, TargetEntry.Draft) -> Unit)? = null,
    onAdded: () -> Unit = {},
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val telemetry = LocalTelemetry.current
    val imeVisible by rememberUpdatedState(WindowInsets.isImeVisible)
    var createReady by remember { mutableStateOf(false) }
    LaunchedEffect(state.createOpen) {
        createReady = false
        if (!state.createOpen) return@LaunchedEffect
        if (onCreateDraft != null) {
            state.createOpen = false
            onCreateDraft(Exercise(state.requestId.ifEmpty { Ids.exercise() }, state.createName.orEmpty(),
                pattern = Exercise.unclassified, equipment = state.equipment, custom = true, loadCount = state.loadCount), state.scheme)
            return@LaunchedEffect
        }
        focusManager.clearFocus(force = true)
        keyboard?.hide()
        snapshotFlow { imeVisible }.first { !it }
        withFrameNanos { }
        createReady = true
    }
    val held = remember { mutableStateOf(emptyList<SessionSummary>()) }
    if (held.value.isEmpty()) held.value = sessions.take(PickerOptions.trainedWindow)
    val options = PickerOptions.matching(state.query, catalog, taken, lastSets, nowMs,
        sessions = held.value)

    Column(modifier.fillMaxWidth().imePadding(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = WindmillFont.body(24, FontWeight.Bold), color = skin.ink,
                    modifier = Modifier.weight(1f))
                onClose?.let { TextButton(onClick = it, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") } }
            }
            subtitle?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim) }
        }
        OutlinedTextField(
            value = state.query, onValueChange = { state.query = it }, singleLine = true,
            textStyle = WindmillFont.body(16),
            placeholder = { Text("Search movements", style = WindmillFont.body(16)) },
            leadingIcon = { Icon(painterResource(R.drawable.gym_search), null, Modifier.size(24.dp)) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false),
            shape = RoundedCornerShape(28.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = skin.canvas, unfocusedContainerColor = skin.canvas,
                focusedBorderColor = skin.accent, unfocusedBorderColor = Color.Transparent,
                focusedTextColor = skin.ink, unfocusedTextColor = skin.ink,
                focusedLeadingIconColor = skin.inkDim, unfocusedLeadingIconColor = skin.inkDim,
                focusedPlaceholderColor = skin.inkDim, unfocusedPlaceholderColor = skin.inkDim,
                cursorColor = skin.accent),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        )
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
            options.unread?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim, lineHeight = 20.sp) }
            if (options.six.isNotEmpty()) {
                Text("The six", style = WindmillFont.body(14, FontWeight.Bold), color = skin.inkDim,
                    modifier = Modifier.padding(bottom = 8.dp))
                options.six.forEach { MovementRow(it, onPick) }
            }
            if (options.six.isNotEmpty() && options.matches.isNotEmpty()) {
                Text("All movements", style = WindmillFont.body(14, FontWeight.Bold), color = skin.inkDim,
                    modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
            }
            options.matches.forEach { MovementRow(it, onPick) }
            options.empty?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim, lineHeight = 20.sp) }
        }
        TextButton(
            onClick = {
                if (state.createName == null) {
                    state.createName = Program.capped(state.query.trim())
                    state.equipment = "barbell"
                    state.loadCount = 1
                    state.created = null
                    state.submitted = null
                    state.requestId = Ids.exercise()
                    state.refusal = null
                    state.scheme = TargetEntry.Draft()
                }
                if (onCreateDraft != null) {
                    onCreateDraft(Exercise(state.requestId, state.createName.orEmpty(), pattern = Exercise.unclassified,
                        equipment = state.equipment, custom = true, loadCount = state.loadCount), state.scheme)
                } else if (!state.createOpen) {
                    createReady = false
                    state.createOpen = true
                    telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "open", "outcome" to "ok"))
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text("Create movement", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink) }
    }
    if (state.createOpen && createReady) {
        val createSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true,
            confirmValueChange = { !state.busy })
        fun cancelCreate() {
            if (state.busy || !state.createOpen) return
            state.createOpen = false
            telemetry.event("gym_action", mapOf("screen" to "movement_form", "action" to "cancel", "outcome" to "ok"))
        }
        WindmillSheet(
            onDismissRequest = ::cancelCreate, onBack = ::cancelCreate, sheetState = createSheet,
            containerColor = skin.surface, scrimColor = skin.scrim,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            dragHandle = {
                Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(32.dp).height(4.dp).background(skin.inkDim, RoundedCornerShape(2.dp)))
                }
            },
        ) {
            val sheetKeyboard = LocalSoftwareKeyboardController.current
            BackHandler(enabled = WindowInsets.isImeVisible) { sheetKeyboard?.hide() }
            val submitted = state.submitted
            val movement = state.created ?: Exercise(state.requestId, submitted?.name ?: state.createName.orEmpty(),
                Exercise.unclassified, submitted?.equipment ?: state.equipment, custom = true,
                loadCount = submitted?.loadCount ?: state.loadCount)
            MovementForm(RoutineMovement(null, movement), scheme = null, title = "Create movement",
                commitLabel = if (state.busy) "Creating…" else "Create and add", creating = true,
                onMovement = {
                    state.createName = it.current.name
                    state.equipment = it.current.equipment
                    state.loadCount = it.current.loadCount
                    state.refusal = null
                }, onScheme = {}, onCancel = ::cancelCreate, busy = state.busy,
                movementEditable = submitted == null && state.created == null,
                refusal = state.refusal,
                onCommit = {
                    if (!state.busy) {
                        state.busy = true
                        val write = state.submitted ?: ExerciseWrite(state.requestId, movement.name.trim(),
                            Exercise.unclassified, movement.equipment, loadCount = movement.loadCount)
                        state.submitted = write
                        scope.launch {
                            try {
                                when (val result = requireNotNull(onCreate)(write)) {
                                    is MovementCreateOutcome.Added -> {
                                        state.createOpen = false
                                        state.createName = null
                                        state.created = null
                                        state.submitted = null
                                        state.refusal = null
                                        onAdded()
                                    }
                                    is MovementCreateOutcome.Failed -> {
                                        state.created = result.created
                                        if (result.created == null && result.why is WriteFailure.Refused) state.submitted = null
                                        state.refusal = result.why.line(if (result.created == null)
                                            "check this movement before retrying" else "the movement was created; retry adding it to this workout")
                                    }
                                }
                            } finally { state.busy = false }
                        }
                    }
                })
        }
    }
}

@Composable
private fun MovementRow(row: PickerOptions.Row, onPick: (String) -> Unit) {
    val skin = LocalGymColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp)
        .clickable(enabled = !row.selected, role = Role.Button, onClickLabel = "add ${row.name}") { onPick(row.id) }
        .semantics { selected = row.selected }.padding(8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
            Text(row.equipment.replaceFirstChar { it.uppercase() }, style = WindmillFont.body(13), color = skin.inkDim)
            row.alias?.let { Text("was “$it”", style = WindmillFont.body(13), color = skin.inkDim) }
            row.meta?.let { Text(it, style = WindmillFont.body(13), color = skin.inkDim) }
        }
        Icon(if (row.selected) Icons.Filled.Check else Icons.Filled.Add, null,
            tint = skin.inkDim, modifier = Modifier.size(24.dp))
    }
}
