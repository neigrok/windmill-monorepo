package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.TheSix
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
        val yours: Boolean,
        val meta: String?,
        val alias: String? = null,
    ) {
        constructor(movement: Exercise, lastSets: Map<String, LastSet>?, nowMs: Long,
                    alias: String? = null) : this(
            id = movement.id,
            name = movement.name,
            yours = movement.custom,
            alias = alias,
            // A map that has not landed says nothing at all, never `never logged`.
            meta = lastSets?.let { answered ->
                val last = answered[movement.id] ?: return@let "never logged"
                "last ${Readout.effort(last.weightKg, last.reps)} · ${Readout.ago(last.atMs, nowMs)}"
            },
        )
    }

    // The door out belongs to the one silence a NAME can answer; a catalog that never loaded takes it away.
    data class Result(
        val six: List<Row>,
        val matches: List<Row>,
        val unread: String?,
        val empty: String?,
        val create: String?,
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
        val available = catalog.filter { it.id !in taken }
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
        val result = Result(six, matches, unread, empty = null, create = null)
        if (result.hasRows) return result
        if (unread != null) return result
        if (term.isEmpty()) {
            return result.copy(empty = "Every movement in the catalog is already in this session.")
        }
        return result.copy(empty = "No movement by that name.", create = "Create “$term”")
    }
}

// The sheet grows with its rows and stops short of the top, leaving the drag handle its own room —
// a fixed fraction of the screen would have the handle eat the last row instead.
@Composable
fun pickerMaxHeight(): Dp = (LocalConfiguration.current.screenHeightDp.dp * 0.92f) - 44.dp

// `onClose` is nullable because the FIRST movement has nothing behind it to cancel back to.
//
// Creating a movement stays INSIDE the picker: the create step is a sheet of the picker's own over a
// picker that stays mounted, so Cancel hands back the query that was typed and the six that were
// frozen. `onCreate` is the mint itself and not a door to somewhere else — there is no second picker
// to come back to.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MovementPicker(
    catalog: List<Exercise>,
    taken: List<String>,
    lastSets: Map<String, LastSet>?,
    nowMs: Long,
    title: String,
    onPick: (String) -> Unit,
    onCreate: (name: String, equipment: String) -> Unit,
    modifier: Modifier = Modifier,
    // Newest first. What the six are ranked from, read once — on the first non-empty read; an empty
    // list still answers with the openers.
    sessions: List<SessionSummary> = emptyList(),
    subtitle: String? = null,
    firstSession: Boolean = false,
    signedIn: Boolean = false,
    catalogUnread: Boolean = false,
    onClose: (() -> Unit)? = null,
    onBuildRoutine: () -> Unit = {},
) {
    // The search, and the two answers the create step collects — saved, and all three HERE: state
    // written inside a `ModalBottomSheet` does not come back from a process reclaim, so the step's
    // own slots are held by the picker that raises it. `minting` is the name being typed, null when
    // the step is down; both it and the loading are seeded fresh each time the door is taken.
    var query by rememberSaveable { mutableStateOf("") }
    var minting by rememberSaveable { mutableStateOf<String?>(null) }
    var equipment by rememberSaveable { mutableStateOf(Exercise.loadings.first()) }
    val createSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // The window is read ONCE, on the first NON-EMPTY read: the log behind an open picker keeps
    // moving — a poll lands a finished session, a claim replays the shelf — and the six may not
    // reshuffle under a thumb already reaching for one of them. Freezing on the first FRAME instead
    // would leave a picker opened before the log answered holding the generic openers for its whole
    // life, so an empty window keeps re-seeding until one arrives, and that one is the window.
    val held = remember { mutableStateOf(emptyList<SessionSummary>()) }
    if (held.value.isEmpty()) held.value = sessions.take(PickerOptions.trainedWindow)
    val opened = held.value
    val options = PickerOptions.matching(query, catalog, taken, lastSets, nowMs,
                                         sessions = opened, catalogUnread = catalogUnread)
    val scope = rememberCoroutineScope()

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    fun closeCreate() {
        scope.launch { createSheet.hide() }.invokeOnCompletion { minting = null }
    }

    Column(
        modifier
            .fillMaxWidth()
            .imePadding(),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = WindmillFont.display(if (firstSession) 26 else 20), color = GymSkin.ink)
                Spacer(Modifier.weight(1f))
                onClose?.let { close ->
                    Box(
                        Modifier
                            .heightIn(min = GymTap.minimum)
                            .clickable(role = Role.Button, onClick = close),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("Cancel", style = WindmillFont.body(16), color = GymSkin.inkDim)
                    }
                }
            }
            subtitle?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkFaint) }
        }

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            textStyle = WindmillFont.body(17),
            placeholder = { Text("Search ${catalog.size} movements", style = WindmillFont.body(17)) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Words,
                autoCorrectEnabled = false,
            ),
            shape = RoundedCornerShape(WindmillRadius.md),
            colors = gymFieldColours(),
            modifier = Modifier.fillMaxWidth(),
        )

        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        ) {
            options.unread?.let { unread ->
                Text(unread, style = WindmillFont.body(14), color = GymSkin.inkDim, lineHeight = 20.sp)
            }
            // One section label and a gap: the catalog follows under no head of its own.
            if (options.six.isNotEmpty()) {
                Text(
                    "The six",
                    style = GymType.numeral(11).copy(letterSpacing = 0.07.em),
                    color = GymSkin.inkFaint,
                )
                options.six.forEach { MovementRow(it, onPick) }
            }
            options.matches.forEach { MovementRow(it, onPick) }

            options.empty?.let { empty ->
                Text(empty, style = WindmillFont.body(14), color = GymSkin.inkDim, lineHeight = 20.sp)
            }

            options.create?.let { create ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = GymTap.minimum + 6.dp)
                        .clip(RoundedCornerShape(WindmillRadius.md))
                        .background(GymSkin.accent)
                        .clickable(role = Role.Button) {
                            minting = Program.capped(query.trim())
                            equipment = Exercise.loadings.first()
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(create, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.onAccent)
                }
            }

            if (firstSession && !signedIn) BuildMyRoutine(onBuildRoutine)
        }
    }

    // Its own sheet and so its own frame: the create step's keyboard padding is measured against the
    // window and never against `pickerMaxHeight`, and the picker underneath keeps its query.
    minting?.let { typed ->
        ModalBottomSheet(
            onDismissRequest = { minting = null },
            sheetState = createSheet,
            containerColor = GymSkin.surface,
        ) {
            CreateMovementSheet(
                name = typed,
                onName = { minting = Program.capped(it) },
                equipment = equipment,
                onEquipment = { equipment = it },
                onCancel = { closeCreate() },
                // The step comes down before the mint is asked for: the caller closes the picker
                // and says any refusal on the surface it lands back on.
                onCreate = {
                    minting = null
                    onCreate(typed.trim(), equipment)
                },
            )
        }
    }
}

// Drawn state only: the two answers it collects are held by the picker above it, which survives a
// process reclaim where a sheet's own slots do not.
@Composable
private fun CreateMovementSheet(
    name: String,
    onName: (String) -> Unit,
    equipment: String,
    onEquipment: (String) -> Unit,
    onCancel: () -> Unit,
    onCreate: () -> Unit,
) {
    val named = Program.named(name) != null

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .imePadding()
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .heightIn(min = GymTap.minimum)
                    .clickable(role = Role.Button, onClick = onCancel),
                contentAlignment = Alignment.Center,
            ) {
                Text("Cancel", style = WindmillFont.body(16), color = GymSkin.inkDim)
            }
            Spacer(Modifier.weight(1f))
            Text("not in the library", style = GymType.numeral(12), color = GymSkin.inkFaint)
        }

        Text("Your movement", style = WindmillFont.display(22), color = GymSkin.ink)

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text("Name", style = GymType.numeral(11).copy(letterSpacing = 0.07.em), color = GymSkin.inkFaint)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { onName(it) },
                    singleLine = true,
                    textStyle = WindmillFont.body(19),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        autoCorrectEnabled = false,
                    ),
                    shape = RoundedCornerShape(WindmillRadius.md),
                    colors = gymFieldColours(),
                    modifier = Modifier.weight(1f).heightIn(min = GymTap.minimum),
                )
                Program.counter(name)?.let { counted ->
                    Text(
                        counted,
                        style = GymType.numeral(12),
                        color = GymSkin.inkFaint,
                        modifier = Modifier.padding(start = WindmillSpace.x3),
                    )
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text("How is it loaded?", style = GymType.numeral(11).copy(letterSpacing = 0.07.em),
                 color = GymSkin.inkFaint)
            // Four are offered; `cable` and `kettlebell` stay valid on every read.
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                Exercise.loadings.forEach { loading ->
                    val picked = loading == equipment
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = GymTap.minimum)
                            .clip(RoundedCornerShape(WindmillRadius.md))
                            .background(if (picked) GymSkin.accentSoft else GymSkin.raised)
                            .border(1.dp, if (picked) GymSkin.accent else GymSkin.line,
                                    RoundedCornerShape(WindmillRadius.md))
                            .selectable(selected = picked, role = Role.RadioButton) { onEquipment(loading) },
                    ) {
                        Text(
                            loading.replaceFirstChar { it.uppercase() },
                            style = WindmillFont.body(13, if (picked) FontWeight.Bold else FontWeight.Normal),
                            color = if (picked) GymSkin.accent else GymSkin.inkDim,
                            maxLines = 1,
                        )
                    }
                }
            }
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (named) GymSkin.accent else GymSkin.raised)
                .clickable(enabled = named, role = Role.Button, onClick = onCreate),
        ) {
            Text(
                "Create and add",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = if (named) GymSkin.onAccent else GymSkin.inkFaint,
            )
        }
    }
}

@Composable
private fun BuildMyRoutine(onBuildRoutine: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x3)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .dashedEdge(GymSkin.accent, WindmillRadius.lg)
            .clickable(role = Role.Button, onClick = onBuildRoutine)
            .padding(WindmillSpace.x4),
    ) {
        Text(
            "Following a written program? Your agent can build the routine from it — that one needs an account.",
            style = WindmillFont.body(14).copy(lineHeight = 21.sp),
            color = GymSkin.inkDim,
        )
        Text(
            "Build my routine →",
            style = WindmillFont.body(14, FontWeight.Bold),
            color = GymSkin.accent,
        )
    }
}

@Composable
private fun MovementRow(row: PickerOptions.Row, onPick: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 6.dp)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .background(GymSkin.surface)
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
            .clickable(role = Role.Button, onClickLabel = "add ${row.name}") { onPick(row.id) }
            .padding(horizontal = WindmillSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            ) {
                Text(row.name, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.ink)
                if (row.yours) {
                    Text(
                        "YOURS",
                        style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
                        color = GymSkin.accent,
                    )
                }
            }
            // Only where the query found this row by its OLD name.
            row.alias?.let {
                Text("was “$it”", style = GymType.numeral(11), color = GymSkin.inkFaint)
            }
            row.meta?.let { Text(it, style = GymType.numeral(11), color = GymSkin.inkFaint) }
        }
        Icon(Icons.Filled.Add, contentDescription = null, tint = GymSkin.inkDim)
    }
}
