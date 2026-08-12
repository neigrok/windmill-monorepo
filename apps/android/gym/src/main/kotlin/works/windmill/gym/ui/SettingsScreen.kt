package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Units
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// §I — GYM'S SETTINGS SECTION. Everything in it changes how the room behaves AT THE RACK: what a
// weight is read in, what plates exist, how long the rest is, how a logged set confirms itself. It
// restates no account screen — there is no appearance control, no notification row for pushes this
// product does not send, no plan and no account row of any kind. Appearance is chosen once, in You,
// and this room only answers it.
//
// EVERY ROW WRITES ON THE TAP. There is no Save button and no dirty state: the document is held on
// the device before the log is consulted, so the logger's plate readout and rest clock obey the new
// value on the next frame whether or not there is an account behind it. What the log refuses is
// SAID through the room's own note; what the log never answers is kept and carried by the claim.
//
// TWO OF §I'S ROWS ARE NOT HERE, and they are absent rather than faked. `Export` needs a route that
// answers CSV rather than JSON, which this app's one API client cannot read; `Connected log` names
// an MCP grant state no native surface can read yet. A row that opened nothing would be the exact
// dishonest control this wave was written to refuse, so the closing note says where both live
// instead.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(store: TrainingStore, backLabel: String, onBack: () -> Unit, say: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    val preferences = store.preferences
    var typingBar by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    fun write(document: GymPreferences) {
        scope.launch {
            say(null)
            store.savePreferences(document)?.let { say(it.line("that setting stayed on this device")) }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x4)
            .padding(bottom = WindmillSpace.x8),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        BackRow(backLabel, onBack)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Gym", style = WindmillFont.display(30), color = GymSkin.ink)
            Text("how this room behaves at the rack", style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        Spacer(Modifier.height(WindmillSpace.x1))

        UnitsRow(preferences.units) { write(preferences.copy(units = it)) }
        PlateRow(
            preferences = preferences,
            onTypeBar = { typingBar = true },
            onTogglePlate = { write(preferences.togglingPlate(it)) },
        )
        RestRow(
            preferences = preferences,
            onPick = { write(preferences.copy(restSeconds = it)) },
            onToggleSound = { write(preferences.copy(restSound = !preferences.restSound)) },
        )
        ConfirmRow(
            preferences = preferences,
            onToggleHaptic = { write(preferences.copy(confirmHaptic = !preferences.confirmHaptic)) },
            onToggleSound = { write(preferences.copy(confirmSound = !preferences.confirmSound)) },
        )
        ClosingNote()
    }

    // The bar is typed rather than dialled, because it is a number a lifter reads off their own
    // equipment — 20, 15, 7, and 0 for a machine — and the room already owns a pad for exactly
    // that gesture. Out of band it is REFUSED with the log's own band said out loud rather than
    // clamped: a clamp would store a bar nobody chose and then lie about it in the readout.
    if (typingBar) {
        ModalBottomSheet(
            onDismissRequest = { typingBar = false },
            sheetState = sheetState,
            containerColor = GymSkin.surface,
            dragHandle = null,
        ) {
            KeypadSheet(
                KeypadEntry.Mode.Weight, preferences.barWeightKg,
                onCommit = { typed ->
                    scope.launch { sheetState.hide() }.invokeOnCompletion { typingBar = false }
                    if (typed < GymPreferences.minBarKg || typed > GymPreferences.maxBarKg) {
                        say("a bar weighs from 0 to 100 kg")
                        return@KeypadSheet
                    }
                    write(preferences.copy(barWeightKg = typed))
                },
                onCancel = {
                    scope.launch { sheetState.hide() }.invokeOnCompletion { typingBar = false }
                },
            )
        }
    }
}

@Composable
private fun BackRow(label: String, onBack: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onBack),
    ) {
        Text("‹", style = WindmillFont.body(20, FontWeight.SemiBold), color = GymSkin.inkDim)
        Text(label, style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.inkDim)
    }
}

// ROW 1 — the display transform, and the promise under it. Storage is kilograms and stays
// kilograms: nothing this toggle does reaches a write, and no history is rewritten by it. What the
// second line adds is this surface's own truth — the choice is kept and travels, and this phone
// does not yet draw it. It does not say "your account", because this room is anonymous-first and a
// lifter who has not signed in has none: the choice is on the device until a sign-in claims it.
@Composable
private fun UnitsRow(units: Units, onPick: (Units) -> Unit) {
    SettingCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Units", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier
                    .clip(RoundedCornerShape(WindmillRadius.full))
                    .background(GymSkin.canvas)
                    .padding(WindmillSpace.x1),
            ) {
                Units.entries.forEach { entry ->
                    val picked = entry == units
                    Box(
                        Modifier
                            .heightIn(min = 38.dp)
                            .clip(RoundedCornerShape(WindmillRadius.full))
                            .background(if (picked) GymSkin.accent else Color.Transparent)
                            .clickable { onPick(entry) }
                            .padding(horizontal = WindmillSpace.x4),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            entry.wire,
                            style = GymType.numeral(13, FontWeight.Bold),
                            color = if (picked) GymSkin.onAccent else GymSkin.inkDim,
                        )
                    }
                }
            }
        }
        Caption("Changes the display, never the stored value. History does not get rewritten.")
        Caption("This phone still draws every weight in kilograms — nothing on this screen converts one. The choice is kept with your gym settings and goes with you when you sign in.")
    }
}

// ROW 2 — what your gym actually owns. The chips are the plates the design draws plus anything the
// document already holds, so a rack set from another surface still has somewhere to be turned off.
// One side of the bar, always: the numbers here are what you slide on, not what the bar weighs.
@Composable
private fun PlateRow(
    preferences: GymPreferences,
    onTypeBar: () -> Unit,
    onTogglePlate: (Double) -> Unit,
) {
    SettingCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Plate math", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onTypeBar),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Text(
                    "bar ${Readout.weight(preferences.barWeightKg)} kg  ›",
                    style = GymType.numeral(13),
                    color = GymSkin.inkDim,
                )
            }
        }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            GymPreferences.offeredPlates(preferences.platesKg).forEach { plate ->
                val owned = plate in preferences.platesKg
                Box(
                    Modifier
                        .heightIn(min = GymTap.minimum)
                        .clip(RoundedCornerShape(WindmillRadius.full))
                        .background(if (owned) GymSkin.accentSoft else Color.Transparent)
                        .border(
                            1.dp,
                            if (owned) GymSkin.accent else GymSkin.lineStrong,
                            RoundedCornerShape(WindmillRadius.full),
                        )
                        .clickable { onTogglePlate(plate) }
                        .padding(horizontal = WindmillSpace.x4),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        Readout.weight(plate),
                        style = GymType.numeral(13, FontWeight.Bold),
                        color = if (owned) GymSkin.accent else GymSkin.inkFaint,
                    )
                }
            }
        }
        Caption("One side of the bar. The readout under the weight comes from this — and says so when these plates can’t make the number.")
    }
}

// ROW 3 — the dial the whole product's rest clock reads, and its first position is off. Off is not
// a missing value: the clock still counts the gap between two sets, it simply counts UP, against
// nothing, and makes no sound at all.
@Composable
private fun RestRow(preferences: GymPreferences, onPick: (Int?) -> Unit, onToggleSound: () -> Unit) {
    SettingCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Rest timer", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Text(restLabel(preferences.restSeconds), style = GymType.numeral(13), color = GymSkin.inkDim)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GymPreferences.restChoices.forEach { choice ->
                val picked = choice == preferences.restSeconds
                Box(
                    Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum)
                        .clip(RoundedCornerShape(WindmillRadius.md))
                        .background(if (picked) GymSkin.accentSoft else Color.Transparent)
                        .border(
                            1.dp,
                            if (picked) GymSkin.accent else GymSkin.line,
                            RoundedCornerShape(WindmillRadius.md),
                        )
                        .clickable { onPick(choice) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        restLabel(choice),
                        style = GymType.numeral(13, if (picked) FontWeight.Bold else FontWeight.Normal),
                        color = if (picked) GymSkin.accent else GymSkin.inkDim,
                    )
                }
            }
        }
        ToggleLine("Sound when it ends", preferences.restSound, onToggleSound)
        // THE ONE WAY TO BE COUNTED DOWN WITHOUT ASKING, said where the dial is rather than left
        // for a lifter to discover mid-set. A routine may carry its own rest against a movement —
        // only an agent writing the routine can set it — and that line outranks this dial, `off`
        // included. Nothing on this screen edits it, so the honest move is to name it.
        Caption("A routine can carry its own rest for a movement. That one wins over this dial, off included — and only the routine it was written into can change it.")
        // The honest half, and it says only what this build actually does. The room holds the
        // screen awake for the whole workout (GymRoom's FLAG_KEEP_SCREEN_ON), and the chime is a
        // sleep inside the app scheduled against the instant the set landed. NOTHING here books an
        // alarm with the system — no AlarmManager, no notification, no wake lock — so the app going
        // away takes the chime with it, and the row says that rather than promising otherwise.
        Caption("Windmill holds the screen awake while you train, and the chime is scheduled inside the app. It is not a system alarm — close Windmill and it goes with it.")
    }
}

// ROW 4 — how a logged set says so without being looked at. The design's own note is per-surface,
// so this one is written for the surface it is drawn on: this phone has a haptic, and the toggle
// under it is the tone the web falls back to.
@Composable
private fun ConfirmRow(
    preferences: GymPreferences,
    onToggleHaptic: () -> Unit,
    onToggleSound: () -> Unit,
) {
    SettingCard {
        Text("Set confirmation", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
        ToggleLine("Haptic", preferences.confirmHaptic, onToggleHaptic)
        ToggleLine("Sound", preferences.confirmSound, onToggleSound)
        Caption("This phone has a haptic and follows Android’s own touch-feedback setting — turn that off in system settings and this row goes quiet with it.")
    }
}

// The closing note §I ends on, saying where everything this section deliberately does not hold
// lives — plus the two of its own rows this surface has not built, named rather than drawn as
// doors that open nothing.
@Composable
private fun ClosingNote() {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x2)
            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x3),
    ) {
        Text(
            "Account, appearance, plan, sessions, devices and delete live in You. Gym does not restate them, and it has no theme switch of its own.",
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
        Text(
            "Your CSV export and the connected-log grant are on the web for now — neither is built on this phone yet, so neither is drawn here as a door.",
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
    }
}

@Composable
private fun SettingCard(content: @Composable () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        content()
    }
}

@Composable
private fun Caption(line: String) {
    Text(line, style = GymType.numeral(12).copy(lineHeight = 18.sp), color = GymSkin.inkFaint)
}

// The whole row is the target and not the switch alone — a 46dp pill beside a sentence is the one
// thing a chalked thumb will miss.
@Composable
private fun ToggleLine(label: String, on: Boolean, onToggle: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .clickable(onClick = onToggle),
    ) {
        Text(label, style = WindmillFont.body(14), color = GymSkin.inkDim)
        Spacer(Modifier.weight(1f))
        Box(
            Modifier
                .width(46.dp)
                .height(27.dp)
                .clip(RoundedCornerShape(WindmillRadius.full))
                .background(if (on) GymSkin.accent else GymSkin.canvas)
                .border(
                    1.dp,
                    if (on) GymSkin.accent else GymSkin.lineStrong,
                    RoundedCornerShape(WindmillRadius.full),
                )
                .padding(3.dp),
            contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
        ) {
            Box(
                Modifier
                    .size(21.dp)
                    .clip(CircleShape)
                    .background(if (on) GymSkin.onAccent else GymSkin.inkFaint),
            )
        }
    }
}

// The dial's own spelling, and the one place `off` is a word rather than a blank — a timer nobody
// set is a decision and must read like one.
private fun restLabel(seconds: Int?): String {
    if (seconds == null) return "off"
    return Readout.clock(seconds * 1000L)
}
