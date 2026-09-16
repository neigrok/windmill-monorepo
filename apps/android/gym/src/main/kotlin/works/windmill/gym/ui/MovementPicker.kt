package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheetWindow
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
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
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.TheSix
import works.windmill.gym.store.GymResult
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

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

    // The bytes web and iOS say for the same silence.
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
    // count is sessions that named it rather than working sets — the wire ranks nothing by use and
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
        catalogUnread: Boolean = false,
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

        val unread = if (!catalogUnread && catalog.isNotEmpty()) null else PickerOptions.catalogUnread
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
) {
    var createOpen by mutableStateOf(createOpen)
    var query by mutableStateOf(query)
    var createName by mutableStateOf(createName)
    var equipment by mutableStateOf(equipment)
    var requestId by mutableStateOf(requestId)
    var refusal by mutableStateOf(refusal)
    var busy by mutableStateOf(false)

    companion object {
        val saver = listSaver<MovementPickerState, Any>(
            save = { listOf(it.query, it.createName.orEmpty(), it.createName != null,
                it.equipment, it.requestId, it.refusal.orEmpty(), it.createOpen) },
            restore = { MovementPickerState(it[0] as String,
                (it[1] as String).takeIf { _ -> it[2] as Boolean }, it[3] as String,
                it[4] as String, (it[5] as String).takeIf(String::isNotEmpty), it[6] as Boolean) },
        )
    }
}

@Composable
fun rememberMovementPickerState(): MovementPickerState = rememberSaveable(saver = MovementPickerState.saver) {
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
    onCreate: suspend (name: String, equipment: String, id: String) -> GymResult<Exercise>,
    modifier: Modifier = Modifier,
    sessions: List<SessionSummary> = emptyList(),
    subtitle: String? = null,
    firstSession: Boolean = false,
    signedIn: Boolean = false,
    catalogUnread: Boolean = false,
    onClose: (() -> Unit)? = null,
    onBuildRoutine: () -> Unit = {},
    state: MovementPickerState = rememberMovementPickerState(),
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val imeVisible by rememberUpdatedState(WindowInsets.isImeVisible)
    var createReady by remember { mutableStateOf(false) }
    LaunchedEffect(state.createOpen) {
        createReady = false
        if (!state.createOpen) return@LaunchedEffect
        focusManager.clearFocus(force = true)
        keyboard?.hide()
        snapshotFlow { imeVisible }.first { !it }
        withFrameNanos { }
        createReady = true
    }
    val held = remember { mutableStateOf(emptyList<SessionSummary>()) }
    if (held.value.isEmpty()) held.value = sessions.take(PickerOptions.trainedWindow)
    val options = PickerOptions.matching(state.query, catalog, taken, lastSets, nowMs,
        sessions = held.value, catalogUnread = catalogUnread)

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
            if (firstSession && !signedIn) BuildMyRoutine(onBuildRoutine)
        }
        TextButton(
            onClick = {
                if (state.createName == null) {
                    state.createName = Program.capped(state.query.trim())
                    state.equipment = Exercise.loadings.first()
                    state.requestId = Ids.exercise()
                    state.refusal = null
                }
                createReady = false
                state.createOpen = true
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text("Create movement", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink) }
    }
    if (state.createOpen && createReady) {
        val name = state.createName.orEmpty()
        val createSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true,
            confirmValueChange = { !state.busy })
        ModalBottomSheet(
            onDismissRequest = { if (!state.busy) state.createOpen = false }, sheetState = createSheet,
            containerColor = skin.surface, scrimColor = skin.scrim,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        ) {
            WindmillSheetWindow()
            BackHandler(enabled = state.busy) {}
            CreateMovementSheet(
                name = name, onName = { state.createName = Program.capped(it); state.refusal = null },
                equipment = state.equipment, onEquipment = { state.equipment = it; state.refusal = null },
                busy = state.busy, refusal = state.refusal,
                onCancel = { state.createOpen = false },
                onCreate = {
                    if (!state.busy) {
                        state.busy = true
                        scope.launch {
                            try {
                                when (val result = onCreate(name.trim(), state.equipment, state.requestId)) {
                                    is GymResult.Ok -> {
                                        state.createOpen = false
                                        state.createName = null
                                        state.refusal = null
                                        onPick(result.value.id)
                                    }
                                    is GymResult.Failed -> state.refusal = result.why.line("“$name” wasn’t created")
                                }
                            } finally { state.busy = false }
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun CreateMovementSheet(
    name: String,
    onName: (String) -> Unit,
    equipment: String,
    onEquipment: (String) -> Unit,
    busy: Boolean,
    refusal: String?,
    onCancel: () -> Unit,
    onCreate: () -> Unit,
) {
    val skin = LocalGymColors.current
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val equipmentColumns = if (LocalDensity.current.fontScale > 1.3f || LocalConfiguration.current.screenWidthDp < 360) 1 else 2
    LaunchedEffect(Unit) { focus.requestFocus(); keyboard?.show() }
    Column(Modifier.fillMaxWidth().heightIn(max = pickerMaxHeight()).imePadding()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 20.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Create movement", style = WindmillFont.body(22, FontWeight.Bold), color = skin.ink,
                modifier = Modifier.weight(1f))
            TextButton(onClick = onCancel, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Cancel", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
            }
        }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            PlanningNameField(name, onName, "Movement name", "", enabled = !busy, container = skin.raised,
                modifier = Modifier.focusRequester(focus))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Equipment", style = WindmillFont.body(14), color = skin.inkDim)
                Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Exercise.loadings.chunked(equipmentColumns).forEach { pair ->
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            pair.forEach { loading ->
                                val selected = loading == equipment
                                Row(Modifier.weight(1f).heightIn(min = 56.dp)
                                    .clip(RoundedCornerShape(12.dp)).background(skin.raised)
                                    .border(1.dp, if (selected) skin.accent else Color.Transparent, RoundedCornerShape(12.dp))
                                    .selectable(selected, enabled = !busy, role = Role.RadioButton) { onEquipment(loading) }
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    RadioButton(selected, onClick = null, enabled = !busy, modifier = Modifier.size(20.dp))
                                    Text(loading.replaceFirstChar { it.uppercase() }, style = WindmillFont.body(16),
                                        color = skin.ink, modifier = Modifier.weight(1f))
                                }
                            }
                        }
                    }
                }
            }
            refusal?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
        }
        Button(onClick = onCreate, enabled = Program.named(name) != null && !busy,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp).heightIn(min = 56.dp)) {
            Text(if (busy) "Creating…" else "Create and add", style = WindmillFont.body(16, FontWeight.Bold))
        }
    }
}

@Composable
private fun BuildMyRoutine(onBuildRoutine: () -> Unit) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x2)
            .background(skin.surface, RoundedCornerShape(WindmillRadius.lg))
            .dashedEdge(skin.accent, WindmillRadius.lg)
            .clickable(role = Role.Button, onClick = onBuildRoutine)
            .padding(GymLayout.cardInset),
    ) {
        Text(
            "Have a written program? An agent can build it — sign in first.",
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = skin.inkDim,
        )
        Text(
            "Build my routine →",
            style = WindmillFont.body(14, FontWeight.Bold),
            color = skin.accent,
        )
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
