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
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.TheSix
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THE PICKER — type to filter, live, and a door out at the bottom of every empty result. A movement
// is a stable identity and never a typed string, so the only way to lift something the catalog has
// never heard of is to MINT it here; that is what keeps twelve weeks of "Bench Press" one movement
// instead of four spellings of one.
//
// Every row carries what this lifter last did with that movement — `last 82.5 × 5 · 3 days ago` —
// or `never logged`, WHICH IS DRAWN FROM AN ABSENCE. The read is sparse by contract: a movement the
// lifter has never trained has no row at all, so there is no zero and no sentinel to tell apart
// from a real one. A load of zero and a load nobody has lifted are different facts and this is the
// screen where confusing them would move the number under a thumb.
//
// The empty state is three different silences and they must not share a sentence. A lifter who typed
// a letter the catalog does not hold was once told their signal was out — the app reporting a failure
// that had not happened, and pointing them at the wrong thing to fix. Only a catalog that did not
// LOAD may mention signal, and on this surface that is no longer the same test as an empty one: the
// six ride with every seat, so a signed-in lifter whose read missed has a short list rather than an
// empty one, and the store answers which it is (`TrainingStore.catalogUnread`).
// The native twin of web/src/products/gym/logger/movements.js.
object PickerOptions {
    const val shown = 7

    // One row as the picker draws it. The meta is composed HERE rather than in the drawing, because
    // it is the one line on this screen that is a claim about the lifter's own history: `never
    // logged` is only ever said where an ANSWER carried no row for that movement.
    data class Row(val id: String, val name: String, val yours: Boolean, val meta: String?) {
        constructor(movement: Exercise, lastSets: Map<String, LastSet>?, nowMs: Long) : this(
            id = movement.id,
            name = movement.name,
            yours = movement.custom,
            // THE SILENCE UNDER A NAME IS NOT `never logged`. A map that has not landed says
            // nothing at all: telling a lifter of ten years they have never squatted, because a
            // phone was in a basement, is the product lying in the pixel this line exists for.
            meta = lastSets?.let { answered ->
                val last = answered[movement.id] ?: return@let "never logged"
                "last ${Readout.effort(last.weightKg, last.reps)} · ${Readout.ago(last.atMs, nowMs)}"
            },
        )
    }

    // The door out belongs to exactly one of the three silences: the one a NAME can answer. A
    // catalog that never loaded comes back with signal — and takes the door away with it, because
    // minting a movement the missing rows may already hold is the duplicate the stable-identity
    // rule exists to prevent, and signed in the create itself would fail on the same dead
    // connection. A catalog already entirely in the session is answered by the assembly list.
    //
    // `unread` is the one line that is said with rows on screen as well as without them: six
    // movements where sixty-four belong is a shorter list, not an empty one, and a picker that drew
    // it without a word would be the app quietly losing a lifter's catalog.
    data class Result(
        val six: List<Row>,
        val matches: List<Row>,
        val unread: String?,
        val empty: String?,
        val create: String?,
    ) {
        val hasRows: Boolean get() = six.isNotEmpty() || matches.isNotEmpty()
    }

    // `pinTheSix` is asked for by the FIRST SESSION and by nothing else (§J22): six barbell
    // movements above an untouched field, because this product is for a lifter on a written barbell
    // program and those are what the program is made of. They are a client constant and not a server
    // concept — the server ranks nothing and knows nothing about them.
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
        // Typing dissolves the section: once a lifter has named what they want, a pinned list of
        // six they did not ask for is a second answer competing with theirs.
        val six = if (!pinTheSix || term.isNotEmpty()) emptyList()
            else TheSix.movements
                .mapNotNull { pinned -> available.firstOrNull { it.id == pinned.id } }
                .map { Row(it, lastSets, nowMs) }
        val matches = available
            .filter { movement -> six.none { it.id == movement.id } }
            .filter { term.isEmpty() || it.name.lowercase().contains(term.lowercase()) }
            .take(shown)
            .map { Row(it, lastSets, nowMs) }

        // A list with nothing in it is one the read never filled, whatever the store thinks: this
        // stays a pure function and answers honestly for any input, and the web's catalog really
        // does come over the wire.
        val unread = if (!catalogUnread && catalog.isNotEmpty()) null
            else "Your catalog didn’t load — the rest of it comes back when you have signal."
        val result = Result(six, matches, unread, empty = null, create = null)
        if (result.hasRows) return result
        // The silence a NAME cannot answer, and it has already been said one field up.
        if (unread != null) return result
        // AN EMPTY QUERY IS WHAT MAKES THIS ONE TRUE, and it used to be an empty available list —
        // which was the same test only while the catalog was the log's sixty-four. It is six for an
        // anonymous room now (`TheSix`), so a lifter with all six in the session and a seventh
        // movement in mind was being told there was nothing left to lift and offered no way to say
        // otherwise. A typed name always has a door.
        if (term.isEmpty()) {
            return result.copy(empty = "Every movement in the catalog is already in this session.")
        }
        return result.copy(empty = "No movement by that name.", create = "Create “$term”")
    }
}

// The picker draws no background and no padding of its own: it is the body of a sheet on one screen
// and the whole of the first screen on another, and those two want different chrome. What it does
// own is the keyboard inset — a search field that its own keyboard covers is not a search field.
//
// `onClose` is nullable because the FIRST movement has nothing behind it to cancel back to: the
// session is already running, and a Cancel there would be a door onto an empty room.
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
            // Above the rows, because it is about the rows: a lifter reads why the list is short
            // before they scan it and decide their movement is gone.
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

            // THE CARD IS THE ACCOUNT VERB, so it goes when there is an account. A first session is
            // no longer a signed-out-only thing — the room asks whether the reads LANDED, and a
            // brand new account arrives here too — and "that one needs an account" said to somebody
            // who has one is the copy lying. What that lifter needs next is the MCP grant, which
            // this surface deliberately draws no door for (SettingsScreen says so in as many
            // words): it is a web page, and a button onto a screen this app does not have is the
            // defect this room refuses everywhere else.
            if (firstSession && !signedIn) BuildMyRoutine(onBuildRoutine)
        }
    }
}

// THE ACCOUNT VERB A LIFTER MID-SESSION CAN REACH (§J22), and it is an offer rather than a wall:
// everything on this screen already works, so the card says what the account is FOR — an agent
// reading a written program. That the rest of the room needs no account was a SENTENCE under it
// until W9; it is now simply true of the screen behind it, where every movement is already tappable.
// The door itself is the shell's (screen 23), and it comes back here, mid-session, with the session
// still running. The room has three doors onto it (Today's card, the rail's seat and this one); a
// live session covers the other two, which is exactly when this card is on screen.
//
// Nothing counts how many times this is walked past. There is no counter here, on the device or on
// the wire, and a prompt that got louder with each decline is the dark pattern this room refuses.
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
                // A movement the lifter minted behaves identically to a seeded one and is tagged
                // only so they can recognise their own.
                if (row.yours) {
                    Text(
                        "YOURS",
                        style = GymType.numeral(10).copy(letterSpacing = 0.07.em),
                        color = GymSkin.accent,
                    )
                }
            }
            // No line at all until the read has landed — an empty one would draw a gap that reads
            // as a fact about the movement rather than about the read.
            row.meta?.let { Text(it, style = GymType.numeral(11), color = GymSkin.inkFaint) }
        }
        Text("+", style = WindmillFont.body(20), color = GymSkin.inkDim)
    }
}
