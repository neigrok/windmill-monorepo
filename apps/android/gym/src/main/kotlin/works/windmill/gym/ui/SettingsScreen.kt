package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
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
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Units
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Every row writes on the tap: no Save button and no dirty state.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    origin: String,
    backTo: String,
    onBack: () -> Unit,
    onNotes: () -> Unit,
    say: (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val preferences = store.preferences

    fun write(document: GymPreferences) {
        scope.launch {
            say(null)
            store.savePreferences(document)?.let { say(it.line("that setting stayed on this device")) }
        }
    }

    GymScreen(title = "Gym", onBack = onBack, backTo = backTo) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = WindmillSpace.x4)
                .padding(bottom = WindmillSpace.x8),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text("how this room behaves at the rack", style = GymType.numeral(12), color = GymSkin.inkFaint)
            Spacer(Modifier.height(WindmillSpace.x1))

            UnitsRow(preferences.units) { write(preferences.copy(units = it)) }
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
            // One caption for the three dials: it answers the question a lifter asks here, looking at them.
            Caption(Notes.settingsLine)
            NotesRow(onNotes)
            ConnectedLogRow(isSignedIn, origin)
            UnattributedRow(store, isSignedIn, say)
            ClosingNote()
        }
    }
}

// A display transform only: storage is kilograms and nothing this toggle does reaches a write.
@Composable
private fun UnitsRow(units: Units, onPick: (Units) -> Unit) {
    SettingCard {
        Text("Units", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
        GymSegmented(
            options = Units.entries.map { it to it.wire },
            picked = units,
            onPick = onPick,
        )
        Caption("Display only — nothing stored changes.")
        // Drawn only under the answer it is about: on kg it would be a sentence about nothing.
        if (units == Units.Pounds) Caption(Bodyweight.kilogramsOnly)
    }
}

// Off is not a missing value: the clock still counts the gap between two sets, upward, and silently.
@Composable
private fun RestRow(preferences: GymPreferences, onPick: (Int?) -> Unit, onToggleSound: () -> Unit) {
    SettingCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Rest timer", style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Text(restLabel(preferences.restSeconds), style = GymType.numeral(13), color = GymSkin.inkDim)
        }
        GymSegmented(
            options = GymPreferences.restChoices.map { it to restLabel(it) },
            picked = preferences.restSeconds,
            onPick = onPick,
        )
        ToggleLine("Sound when it ends", preferences.restSound, onToggleSound)
        // ONE caption, and it is the override: this is the only place on the phone that a routine's
        // own rest beating this dial is said, and it is the one fact here with a dial behind it.
        Caption("A routine can carry its own rest for a movement. That one wins over this dial, off included — and only a change to that routine can move it.")
    }
}

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
        // The switch can be on and the phone still silent: Compose's haptics go through Android's
        // own touch-feedback setting.
        Caption("Android’s touch-feedback setting can silence the haptic with this still on.")
    }
}

// The secondary door to the notes; the front door is a row in Coach's own room.
@Composable
private fun NotesRow(onNotes: () -> Unit) {
    SettingCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clickable(role = Role.Button, onClick = onNotes),
        ) {
            Text(Notes.title, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Chevron()
        }
    }
}

// The door goes to the CONNECTIONS LIST and not the setup page: that list is the shell's, in account
// settings, since a grant belongs to the account rather than to one product.
@Composable
private fun ConnectedLogRow(isSignedIn: Boolean, origin: String) {
    val web = LocalUriHandler.current
    SettingCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clickable(role = Role.Button, onClickLabel = "open your connections") {
                    runCatching { web.openUri(ConnectedLog.connectionsUrl(origin)) }
                },
        ) {
            Text(ConnectedLog.title, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Text("your connections", style = GymType.numeral(13), color = GymSkin.accent)
            Chevron()
        }
        // The offer says who it is for BEFORE it is made: the one line on this card that rules a
        // lifter OUT rather than in, and the only precondition the door states. It also carries the
        // price, which is none.
        Text(
            ConnectedLog.precondition,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.canvas, RoundedCornerShape(WindmillRadius.md))
                .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                .padding(WindmillSpace.x3),
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum + 6.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                .clickable(role = Role.Button) {
                    runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                },
        ) {
            Text(ConnectedLog.connect, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.accent)
        }
        Caption(ConnectedLog.onTheWeb)
        if (!isSignedIn) Caption(ConnectedLog.deviceOnly)
        Column(
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.canvas, RoundedCornerShape(WindmillRadius.md))
                .padding(WindmillSpace.x3),
        ) {
            Text(
                ConnectedLog.canDoHead,
                style = GymType.numeral(10, FontWeight.Bold),
                color = GymSkin.setDone,
            )
            Text(
                ConnectedLog.canDo,
                style = WindmillFont.body(13).copy(lineHeight = 20.sp),
                color = GymSkin.inkDim,
            )
            Text(
                ConnectedLog.cannotDoHead,
                style = GymType.numeral(10, FontWeight.Bold),
                color = GymSkin.alarmInk,
                modifier = Modifier.padding(top = WindmillSpace.x2),
            )
            Text(
                ConnectedLog.cannotDo,
                style = WindmillFont.body(13).copy(lineHeight = 20.sp),
                color = GymSkin.inkDim,
            )
        }
        Caption(ConnectedLog.deleteLevel)
        Caption(ConnectedLog.notNamedHere)
    }
}

// What this phone is holding for nobody: a shelf with no name on it, neither handed over nor deleted.
//
// The WHOLE row goes while a discard is held: the store keeps the shelf for the length of the window,
// so a row left drawing would leave `These are mine` tappable over training a pending discard wipes
// nine seconds later.
@Composable
private fun UnattributedRow(store: TrainingStore, isSignedIn: Boolean, say: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    if (Deletion.Unattributed.subjectId in store.withheldIds) return
    val held = store.unattributed ?: return
    val live = store.unattributedIsLive
    if (held.sessions == 0 && held.routines == 0 && held.movements == 0 && !live) return

    SettingCard {
        Text("Saved on this phone, unclaimed", style = WindmillFont.body(15, FontWeight.Bold),
            color = GymSkin.ink)
        Caption("This phone was holding training that was never signed in to any account, from " +
            "before this version. It is nobody’s until you say it is yours — it has not been " +
            "added to any log and it will not be, on its own.")
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(heldLine(held, live), style = GymType.numeral(13), color = GymSkin.inkDim)
            held.days.take(4).forEach {
                Text(Readout.date(it), style = GymType.numeral(12), color = GymSkin.inkFaint)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(if (isSignedIn) GymSkin.accent else GymSkin.canvas)
                    .clickable(role = Role.Button) {
                        scope.launch {
                            say(null)
                            store.releaseUnattributed()?.let { say(it) }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("These are mine", style = GymType.numeral(13, FontWeight.Bold),
                    color = if (isSignedIn) GymSkin.onAccent else GymSkin.inkFaint)
            }
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                    // One tap, nothing sent, and nine seconds of Undo on the room's transient. The
                    // arm-and-relabel it replaces had no cancel and no timeout: once armed, the only
                    // resets were leaving the screen or tapping the button that CLAIMS the shelf.
                    .clickable(role = Role.Button) {
                        say(null)
                        store.withhold(Deletion.Unattributed)
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Not mine",
                    style = GymType.numeral(13, FontWeight.Bold),
                    color = GymSkin.inkDim,
                )
            }
        }
        Caption(
            if (isSignedIn) "Claiming adds it to the account you are signed in as."
            else "Sign in first to claim it. Nobody signed in can say whose training this is, " +
                "and it will not be handed to the next account on its own.")
    }
}

private fun heldLine(held: LocalLog.Unattributed, live: Boolean): String {
    val parts = buildList {
        if (live) add("a workout that was still open")
        if (held.sessions > 0) add(count(held.sessions, "finished workout"))
        if (held.routines > 0) add(count(held.routines, "routine"))
        if (held.movements > 0) add(count(held.movements, "movement"))
    }
    return parts.joinToString(" · ")
}

private fun count(n: Int, noun: String): String = if (n == 1) "1 $noun" else "$n ${noun}s"

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
            "Account, appearance, plan, sessions, devices and delete live in You.",
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
        )
        // The export is a web page: this app's one API client reads JSON and that route answers CSV.
        Text(
            "Your CSV export is on the web — this phone has no screen for it yet.",
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

// The platform's switch, so TalkBack reads a switch with a state rather than a coloured box.
@Composable
private fun ToggleLine(label: String, on: Boolean, onToggle: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .toggleable(value = on, role = Role.Switch, onValueChange = { onToggle() }),
    ) {
        Text(label, style = WindmillFont.body(14), color = GymSkin.inkDim)
        Spacer(Modifier.weight(1f))
        Switch(
            checked = on,
            // The row owns the tap, so the switch is drawn rather than separately reachable.
            onCheckedChange = null,
            colors = SwitchDefaults.colors(
                checkedThumbColor = GymSkin.onAccent,
                checkedTrackColor = GymSkin.accent,
                checkedBorderColor = GymSkin.accent,
                uncheckedThumbColor = GymSkin.inkFaint,
                uncheckedTrackColor = GymSkin.canvas,
                uncheckedBorderColor = GymSkin.lineStrong,
            ),
        )
    }
}

private fun restLabel(seconds: Int?): String {
    if (seconds == null) return "off"
    return Readout.clock(seconds * 1000L)
}
