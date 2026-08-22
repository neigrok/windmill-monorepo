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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Units
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// §I — GYM'S SETTINGS SECTION. Everything in it changes how the room behaves AT THE RACK: what a
// weight is read in, how long the rest is, how a logged set confirms itself. It
// restates no account screen — there is no appearance control, no notification row for pushes this
// product does not send, no plan and no account row of any kind. Appearance is chosen once, in You,
// and this room only answers it.
//
// EVERY ROW WRITES ON THE TAP. There is no Save button and no dirty state: the document is held on
// the device before the log is consulted, so the logger's rest clock obeys the new value on the
// next frame whether or not there is an account behind it. What the log refuses is
// SAID through the room's own note; what the log never answers is kept and carried by the claim.
//
// ONE OF §I'S ROWS IS STILL NOT HERE, and it is absent rather than faked: `Export` needs a route
// that answers CSV rather than JSON, which this app's one API client cannot read. A row that opened
// nothing would be the exact dishonest control this section was written to refuse, so the closing
// note says where it lives instead.
//
// `CONNECTED LOG` IS HERE NOW (W8), and what it draws is the honest half of §D screen 13: what a
// connected tool may do to this log, what it may not, and a door onto the account's own list of
// connections, which is where Disconnect lives. What it does NOT draw is the design's named clients
// each wearing
// `connected · read 2h ago` — those connections belong to the ACCOUNT, gym does not read them, and a
// row inventing a freshness it never observed is the same defect as a receipt counting rows it never
// served. The row says it names none, which is the true version of the same sentence.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    origin: String,
    backLabel: String,
    onBack: () -> Unit,
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
        ConnectedLogRow(isSignedIn, origin)
        UnattributedRow(store, isSignedIn, say)
        ClosingNote()
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
        Caption("Display only — nothing stored changes.")
        Caption("This phone still draws every weight in kilograms — nothing on this screen converts one. The choice is kept with your gym settings and goes with you when you sign in.")
    }
}

// ROW 2 — the dial the whole product's rest clock reads, and its first position is off. Off is not
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
        // for a lifter to discover mid-set. A routine may carry its own rest against a movement,
        // and that line outranks this dial, `off` included. It arrives written into a routine an
        // agent created, or through a proposal the lifter applied — never from an agent reaching
        // into a routine that already stands. Nothing on this screen edits it, so the honest move
        // is to name it.
        Caption("A routine can carry its own rest for a movement. That one wins over this dial, off included — and only a change to that routine can move it.")
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

// ROW 5 — THE CONNECTED LOG, and the only row in this section that changes nothing at the rack. It
// is here because §I puts it here and because this is where a lifter comes looking for it: both
// verbs the design hangs on it, connecting and disconnecting, happen on the web, so the row is what
// gym has to say about a grant it does not own, plus the door.
//
// THE DOOR GOES TO THE CONNECTIONS LIST AND NOT TO THE SETUP PAGE, because that is where the two
// things a lifter opens this row for actually are: what is connected right now, and Disconnect. §D
// sends them to "Settings → Gym → Connected log" for that, and no such control exists on any
// surface — the list is the SHELL's, in account settings, since a grant belongs to the account
// rather than to one product. Setting a NEW one up is the invitation's door (ConnectInvitation), and
// the page this one opens carries its own way there.
//
// NOTHING ON IT IS SOLD. There is no price, no tier, no lock and no checkout behind the chevron —
// no entitlement gates a tool, a screen or a tap in this product (the plan is read once, under Ask,
// and only to size a ceiling — ConnectedLog says where), so a row implying one would advertise
// something the code does not do. `ConnectedLog` holds every sentence and says which line of the
// server's tool catalog each one was read off.
//
// SIGNED OUT IT IS STILL DRAWN, and it gains one line rather than losing the rest. What a connected
// tool can and cannot do is a fact about this product either way; what changes is that there is no
// account log to reach yet, and this room is anonymous-first, so that is said plainly instead of
// left for a lifter to discover on a page that asks them to sign in.
@Composable
private fun ConnectedLogRow(isSignedIn: Boolean, origin: String) {
    // Told to fail QUIETLY, as every other door onto the web in this room is: a phone with no
    // browser is the only way this misses, and everything the row says is still true without it.
    val web = LocalUriHandler.current
    SettingCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .clickable { runCatching { web.openUri(ConnectedLog.connectionsUrl(origin)) } },
        ) {
            Text(ConnectedLog.title, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Text("your connections  ›", style = GymType.numeral(13), color = GymSkin.accent)
        }
        Text(
            ConnectedLog.free,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkDim,
        )
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
        Caption(ConnectedLog.whereItLives)
        Caption(ConnectedLog.notNamedHere)
    }
}

// THE ROW THAT IS USUALLY NOT THERE — what this phone is holding for nobody. A build from before
// gym filed its shelf under a seat wrote one shelf with no name on it, and nothing on disk says
// whether it was this phone's owner or the person who held it before them. So it is not handed to
// whoever opens the app, and it is not deleted behind their back either: it waits here for a human
// to answer the only question that can settle it.
//
// IT NAMES NOTHING IT HOLDS. The count and the days, and no movement, no routine and no numbers —
// whoever is reading this screen may not be who lifted them, and a row that listed `Front Squat
// 102.5` would be the leak it exists to close.
@Composable
private fun UnattributedRow(store: TrainingStore, isSignedIn: Boolean, say: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    val held = store.unattributed ?: return
    val live = store.unattributedIsLive
    if (held.sessions == 0 && held.routines == 0 && held.movements == 0 && !live) return
    var confirmingDiscard by remember { mutableStateOf(false) }

    SettingCard {
        Text("Saved on this phone, unclaimed", style = WindmillFont.body(15, FontWeight.Bold),
            color = GymSkin.ink)
        Caption("This phone was holding training that was never signed in to any account, from " +
            "before this version. It is nobody's until you say it is yours — it has not been " +
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
                    .clickable {
                        scope.launch {
                            say(null)
                            confirmingDiscard = false
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
                    .clickable {
                        // Two taps, because nothing here has landed on any log: this is the last
                        // copy of somebody's training, and one mistap would be the whole of it.
                        if (!confirmingDiscard) {
                            confirmingDiscard = true
                            return@clickable
                        }
                        scope.launch {
                            say(null)
                            confirmingDiscard = false
                            store.discardUnattributed()
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (confirmingDiscard) "Delete for good?" else "Not mine",
                    style = GymType.numeral(13, FontWeight.Bold),
                    color = if (confirmingDiscard) GymSkin.alarmInk else GymSkin.inkDim,
                )
            }
        }
        Caption(
            if (isSignedIn) "Claiming adds it to the account you are signed in as."
            // Not a hurdle for its own sake: only the person whose account it is can say this is
            // theirs, and letting a signed-out phone say it would hand the training to whoever
            // signs in next — which is exactly what quarantining it refuses to do.
            else "Sign in first to claim it. Nobody signed in can say whose training this is, " +
                "and it will not be handed to the next account on its own.")
    }
}

// Counts, in the product's own words and never a bare number with a noun after it: a phone holding
// one workout and nothing else must not read "1 workouts · 0 routines · 0 movements".
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

// WHERE THE THINGS THIS SECTION DOES NOT HOLD ACTUALLY ARE — two facts of wayfinding, and no longer
// the paragraph around them. That gym does not restate the account screens and owns no theme switch
// is an argument for how this section is built; a lifter hunting for Delete needs the address.
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
        // THE CONNECTED LOG CAME OUT OF THIS SENTENCE IN W8 and into a row of its own, so what is
        // left is the export — still a web page, because this app's one API client reads JSON and
        // the export route answers CSV. It is named rather than drawn as a door that opens nothing.
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
