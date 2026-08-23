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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.TheSix
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// A movement is a stable identity and never a typed string, so the only way to lift something the
// catalog has never heard of is to MINT it here. The last-done read is SPARSE, so `never logged` is
// drawn from an absence.
object PickerOptions {
    const val shown = 7

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

    fun matching(
        query: String,
        catalog: List<Exercise>,
        taken: List<String>,
        lastSets: Map<String, LastSet>? = null,
        nowMs: Long = 0,
        pinTheSix: Boolean = false,
        catalogUnread: Boolean = false,
    ): Result {
        val term = query.trim()
        val available = catalog.filter { it.id !in taken }
        val six = if (!pinTheSix || term.isNotEmpty()) emptyList()
            else TheSix.movements
                .mapNotNull { pinned -> available.firstOrNull { it.id == pinned.id } }
                .map { Row(it, lastSets, nowMs) }
        // The filter reads names AND aliases, one pass over the list already in hand.
        val wanted = term.lowercase()
        val matches = available
            .filter { movement -> six.none { it.id == movement.id } }
            .mapNotNull { movement ->
                if (term.isEmpty()) return@mapNotNull Row(movement, lastSets, nowMs)
                if (movement.name.lowercase().contains(wanted)) return@mapNotNull Row(movement, lastSets, nowMs)
                val alias = movement.aliases.firstOrNull { it.lowercase().contains(wanted) }
                    ?: return@mapNotNull null
                Row(movement, lastSets, nowMs, alias = alias)
            }
            .take(shown)

        val unread = if (!catalogUnread && catalog.isNotEmpty()) null
            else "Your catalog didn’t load — the rest of it comes back when you have signal."
        val result = Result(six, matches, unread, empty = null, create = null)
        if (result.hasRows) return result
        if (unread != null) return result
        if (term.isEmpty()) {
            return result.copy(empty = "Every movement in the catalog is already in this session.")
        }
        return result.copy(empty = "No movement by that name.", create = "Create “$term”")
    }
}

// `onClose` is nullable because the FIRST movement has nothing behind it to cancel back to.
@Composable
fun MovementPicker(
    catalog: List<Exercise>,
    taken: List<String>,
    lastSets: Map<String, LastSet>?,
    nowMs: Long,
    title: String,
    onPick: (String) -> Unit,
    onCreate: (String) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    firstSession: Boolean = false,
    signedIn: Boolean = false,
    catalogUnread: Boolean = false,
    onClose: (() -> Unit)? = null,
    onBuildRoutine: () -> Unit = {},
) {
    var query by remember { mutableStateOf("") }
    val options = PickerOptions.matching(query, catalog, taken, lastSets, nowMs,
                                         pinTheSix = firstSession, catalogUnread = catalogUnread)

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
                        Modifier.heightIn(min = GymTap.minimum).clickable(onClick = close),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("Cancel", style = WindmillFont.body(16), color = GymSkin.inkDim)
                    }
                }
            }
            subtitle?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkFaint) }
        }

        BasicTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            textStyle = WindmillFont.body(17).copy(color = GymSkin.ink),
            cursorBrush = SolidColor(GymSkin.accent),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Words,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(GymTap.minimum + 4.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .background(GymSkin.raised),
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (query.isEmpty()) {
                        Text("Search ${catalog.size} movements", style = WindmillFont.body(17), color = GymSkin.inkFaint)
                    }
                    inner()
                }
            },
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
                        .clickable { onCreate(query.trim()) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(create, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.onAccent)
                }
            }

            if (firstSession && !signedIn) BuildMyRoutine(onBuildRoutine)
        }
    }
}

@Composable
fun CreateMovementSheet(name: String, onCancel: () -> Unit, onCreate: (String, String) -> Unit) {
    var typed by rememberSaveable(name) { mutableStateOf(Program.capped(name)) }
    var equipment by rememberSaveable(name) { mutableStateOf(Exercise.loadings.first()) }
    val named = Program.named(typed) != null

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
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onCancel),
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
                BasicTextField(
                    value = typed,
                    onValueChange = { typed = Program.capped(it) },
                    singleLine = true,
                    textStyle = WindmillFont.body(19).copy(color = GymSkin.ink),
                    cursorBrush = SolidColor(GymSkin.accent),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum)
                        .clip(RoundedCornerShape(WindmillRadius.md))
                        .background(GymSkin.raised)
                        .padding(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
                )
                Text(
                    Program.counter(typed),
                    style = GymType.numeral(12),
                    color = GymSkin.inkFaint,
                    modifier = Modifier.padding(start = WindmillSpace.x3),
                )
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
                            .clickable { equipment = loading },
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
                .clickable(enabled = named) { onCreate(typed.trim(), equipment) },
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
            .clickable(onClick = onBuildRoutine)
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
            .clickable { onPick(row.id) }
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
        Text("+", style = WindmillFont.body(20), color = GymSkin.inkDim)
    }
}
