package works.windmill.gym

import android.app.Activity
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.LiveOrder
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.DeviceCatalog
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.GymSkin
import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.GymType
import works.windmill.gym.ui.LogScreen
import works.windmill.gym.ui.LoggerScreen
import works.windmill.gym.ui.RoutinesScreen
import works.windmill.gym.ui.SessionScreen
import works.windmill.gym.ui.StatisticsScreen
import works.windmill.gym.ui.TodayScreen
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ProductModule
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Gym's one seam into the superapp. Everything the product is sits behind this; the shell knows
// only that a room exists and what to call it.
class GymModule : ProductModule {
    override val id = "gym"
    override val label = "Gym"

    @Composable
    override fun Room(account: Account) {
        GymRoom(account)
    }
}

// THE THREE TABS, which are the room's whole navigation — §F, decided 2026-08-12. Today, the log,
// the routines, in one pill rail past which sits the shell's own seat.
//
// WHAT THE OLD SHAPE GOT RIGHT AND WHAT IT DID NOT. This room refused a tab bar outright, reasoning
// that any bar "invites a third and a fourth tab, which is the fourth Insights tab gym's canon
// refused". The refusal of a fourth INSIGHTS tab is canon and stands — there is no dashboard in
// this product and there will not be one. "Therefore no tab bar" was this room's own inference, and
// §F contradicts it: gym is three tabs plus the seat. What the old reasoning was actually right
// about survives in one line below — the rail is not drawn over the logger, because a workout owns
// the screen it is being logged on.
private enum class Tab(val title: String) {
    Today("Today"),
    Log("The log"),
    Routines("Routines"),
}

// What a tab can push on top of itself, and both are read-only: the long window over every finished
// session, and one past session with its sets. The session travels as the ROW the list already
// holds rather than as an id, because that row carries facts no other read gives back — the working
// set count, the tonnage, and whether the four-hour rule closed it rather than a tap.
private sealed interface Away {
    data object Statistics : Away
    data class Session(val summary: SessionSummary) : Away
}

// THE ROOM — gym's whole surface: the three tabs a lifter stands on at rest, the session they are
// in the middle of, the screen a session ends on, and the two screens a tab can push. It draws no
// capsule, no theme control and nothing about billing: the shell owns all three, and a room that
// drew one of them would be a second copy of a decision the shell already made. No top-right
// anything, for the same reason.
//
// A LIVE SESSION TAKES THE WHOLE SCREEN, rail included. Every other screen in this product can wait;
// the one a lifter is under a bar for cannot, and a second destination drawn across it is an offer
// to leave mid-set. A pushed screen covers the rail too — it came from a tab and the way back is the
// row at its head, which names where it goes.
//
// A ROOM'S STATE DIES WHEN YOU LEAVE IT — the store and everything it scheduled go with the
// subtree. That is why the queue is on disk after every tap and why leaving flushes: gym would pay
// for a lost flush with a set that is refused forever once the session closes.
@Composable
fun GymRoom(account: Account) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember {
        TrainingStore(
            SetQueue(File(context.filesDir, SetQueue.fileName)),
            DeviceCatalog(File(context.filesDir, DeviceCatalog.fileName)),
            LocalLog(File(context.filesDir, LocalLog.fileName)),
            scope,
        )
    }

    var finished by remember { mutableStateOf<FinishedSession?>(null) }
    var away by remember { mutableStateOf<Away?>(null) }
    var keptRoutine by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    // Saveable, and it is the one piece of this room's state that has to be: everything else is
    // rebuilt from disk when the activity is recreated, but which tab was open exists nowhere but
    // here — and a rotation that dropped a lifter back on Today would be the room forgetting where
    // they were standing.
    var tab by rememberSaveable { mutableStateOf(Tab.Today) }

    // Every door in and out of a retrospective screen goes through here for one reason: the note
    // above the rail is what the room has to say about the door that did not open ON THE SCREEN YOU
    // ARE ON, and a refusal from Today carried under a chart is a sentence about something that is
    // no longer in front of the lifter. Every move between destinations clears it — this one, the
    // rail's own tap, and the back gesture.
    fun look(at: Away?) {
        note = null
        away = at
    }

    // What the system back gesture means here, decided rather than inherited: a pushed screen pops
    // to the tab it came from, and a tab that is not Today falls back to Today — the Android
    // convention, and the one the rail already agrees with. On the finish screen back is CLAIMED
    // AND INERT: its once-only offers (the review, keep-as-routine) leave through Done or Discard,
    // and a reflex gesture that silently dropped them would cost a routine nobody chose to decline.
    // MID-WORKOUT IT IS THE PLATFORM'S AGAIN and backgrounds the app — the logger owns the whole
    // screen, so there is nothing under it to pop, and moving a tab nobody can see would be a
    // gesture that did something invisible. The logger survives it; the queue is on disk after
    // every tap.
    val live = store.session != null
    BackHandler(enabled = finished != null || (!live && (away != null || tab != Tab.Today))) {
        if (finished != null) return@BackHandler
        if (away != null) {
            look(null)
            return@BackHandler
        }
        // The note goes with the tab it was said on, exactly as it does through `look` and the
        // rail: a start the Routines tab refused is a sentence about a row that is no longer on
        // screen, and Today is not the place to read it.
        note = null
        tab = Tab.Today
    }

    // Re-runs whenever who is signed in changes. `connect` drains what the device is still holding
    // BEFORE it reads the log, because reading the log settles a stale open session and a set that
    // arrives after that close is refused forever; and landing back inside a workout that never
    // stopped stands where the lifter was, not in the picker over a session of sets.
    LaunchedEffect(account.user?.id) {
        store.connect(account)
        // Deviates from iOS, where the ROOM resumes after connect: here connect() owns the resume, so a boot cannot race it.
    }

    // The background flush and the parting one. ON_PAUSE is the nearest edge to iOS's
    // scenePhase != .active, and ON_STOP is the second net behind it — a flush on an empty queue
    // costs nothing. The dispose flush is launched unstructured — the composition scope dies with
    // the room, and the drain it owes the log may not die with it (the iOS `Task {}` on
    // disappear). Leaving the room ENDS the undo window as well: the gesture the window was
    // protecting is off screen.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val watcher = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
                scope.launch { store.flushPendingSets() }
            }
        }
        lifecycleOwner.lifecycle.addObserver(watcher)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(watcher)
            CoroutineScope(Dispatchers.Main.immediate).launch { store.flushPendingSets(force = true) }
        }
    }

    // A phone on a bench times out mid-rest; a lifter mid-workout keeps their screen. Off the
    // moment the session is over, because the flag outlasting the workout would burn the battery
    // the product exists beside.
    val window = (context as? Activity)?.window
    val running = store.session != null
    DisposableEffect(window, running) {
        if (running) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    // Start. A double tap is a second session, so the door closes while the first one is in flight
    // — the log would JOIN the two, but the phone would have asked twice for one workout. A refusal
    // is repeated in the LOG'S OWN WORDS: "no such routine" and "the log didn't answer" are
    // different facts, and reporting the first as the second points the lifter at their signal
    // instead of at the routine that is gone.
    fun open(routineId: String?) {
        scope.launch {
            if (starting) return@launch
            starting = true
            try {
                note = null
                val opened = store.start(routineId)
                if (opened is GymResult.Failed) {
                    note = opened.why.line("a session starts there")
                    return@launch
                }
                // Whatever screen was open is over: the workout is what this phone is for, and Done
                // on the finish screen must land on Today rather than back on a chart or a list.
                away = null
                tab = Tab.Today
                // A start JOINS whatever session is already open, so what came back may be a workout
                // with sets in it — stand where that workout is, not at the head of the routine.
                val movement = LiveOrder.resume(store.order, store.sets) ?: return@launch
                store.choose(movement)
            } finally {
                starting = false
            }
        }
    }

    // Finish. The sets are taken BEFORE the close, because the queue lets go of a delivered row the
    // moment its session ends — and "Keep this as a routine" is composed from exactly those sets.
    // The two outcomes that are not a close leave the session OPEN and say so: a Finish that
    // silently did nothing is the same screen as a Finish that worked.
    fun close() {
        scope.launch {
            val live = store.session ?: return@launch
            val performed = store.sets
            note = null
            when (val ended = store.finish()) {
                is FinishOutcome.Closed -> {
                    keptRoutine = false
                    finished = FinishedSession(
                        session = ended.session,
                        sets = performed,
                        review = store.review(live.id),
                        isFirst = store.recent.size <= 1,
                    )
                }
                is FinishOutcome.Stranded ->
                    note = "${Readout.setCount(ended.count)} still on this device — the session stays open until they land"
                FinishOutcome.NoAnswer ->
                    note = "the log didn’t answer — the session is still open"
            }
        }
    }

    // The one destructive action in the product, and a delete that did not happen is the one it may
    // not draw as if it had: the screen only leaves once the log says the session is gone.
    fun discard(sessionId: String) {
        scope.launch {
            note = null
            if (!store.discard(sessionId)) {
                note = "the log didn’t answer — the session is still there"
                return@launch
            }
            finished = null
        }
    }

    // Nothing is created until the tap, and nothing is CLAIMED until the log says it was: a screen
    // that hid the offer on the tap would tell the lifter their program had changed on the strength
    // of a request that may never have landed.
    fun keep(sets: List<TrainingSet>, name: String) {
        scope.launch {
            note = null
            if (store.keep(sets, name) == null) {
                note = "the log didn’t answer — the routine wasn’t kept"
                return@launch
            }
            keptRoutine = true
        }
    }

    // The share's doors, bound to the store once. The origin comes from the account's own client,
    // so a debug build pointed at a local server hands over a link to that server and never to
    // windmill.works.
    val origin = account.api.baseUrl.toString()
    val coach = remember(origin) { CoachDoors(origin, store::share, store::revokeShare) }

    Column(
        Modifier
            .fillMaxSize()
            .background(GymSkin.canvas)
            .systemBarsPadding(),
    ) {
        val ended = finished
        val standing = away

        // The way back out of a pushed screen, at its head and naming where it goes — §G17 puts it
        // there rather than at the foot, because "‹ The log" is a destination and a bare chevron in
        // a bar is not.
        if (ended == null && !live && standing != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .padding(horizontal = WindmillSpace.x5)
                    .clickable { look(null) },
            ) {
                Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
                Text(tab.title, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
            }
        }

        // A LIVE SESSION OUTRANKS EVERY OTHER SCREEN. A pushed screen is only reachable at rest —
        // but a workout that opens while one is up (a start on this phone, a session joined from
        // another device) puts the lifter back where the sets are, because that is the one screen in
        // this product that is time-critical.
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            when {
                ended != null -> FinishScreen(
                    finished = ended,
                    catalog = store.catalog,
                    kept = keptRoutine,
                    coach = coach,
                    onKeepRoutine = { name -> keep(ended.sets, name) },
                    onDiscard = { discard(ended.session.id) },
                    onDone = { finished = null },
                )
                live -> LoggerScreen(
                    store = store,
                    say = { note = it },
                    onFinish = { close() },
                )
                standing is Away.Statistics -> StatisticsScreen(store)
                standing is Away.Session -> SessionScreen(
                    summary = standing.summary,
                    store = store,
                    coach = coach,
                )
                tab == Tab.Log -> LogScreen(store, onOpenSession = { look(Away.Session(it)) })
                tab == Tab.Routines -> RoutinesScreen(store, onStart = { routineId -> open(routineId) })
                else -> TodayScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    onStart = { routineId -> open(routineId) },
                    onStatistics = { look(Away.Statistics) },
                    onOpenSession = { look(Away.Session(it)) },
                    onSignIn = LocalShellActions.current.openYou,
                )
            }
        }

        // In one place on every screen, whatever the room has to say about a door that did not open:
        // mono, quiet, and never a toast, a spinner or an alert. It sits above the rail rather than
        // inside it because the logger has no rail and is the screen that says the most.
        note?.let {
            Text(
                it,
                style = GymType.numeral(12),
                color = GymSkin.inkDim,
                maxLines = 2,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = WindmillSpace.x5)
                    .padding(bottom = WindmillSpace.x2),
            )
        }

        // The rail belongs to the three tabs and to nothing else: the logger, the finish and a
        // pushed screen each own their whole surface, and the shell's seat goes with the rail
        // because it lives past the rail's own hairline.
        if (ended == null && !live && standing == null) {
            TabRail(
                current = tab,
                onPick = { picked ->
                    note = null
                    tab = picked
                },
                initial = account.user?.email?.take(1) ?: "",
            )
        }
    }
}

// THE RAIL — three tabs 14dp off each edge, then a hairline, then the shell's seat. The seat reads
// as the shell's because of the hairline and not because of a different colour, and the room draws
// nothing else in this band: no account button of its own, no hamburger, no theme toggle.
// Appearance is chosen once, in You, and this room only answers it.
//
// A tab's pill is 40 tall and its TARGET is the rail's full 50, which clears the room's own floor
// of 46 — the design's 44 is the platform's habit, and this product's rule is a chalked hand.
@Composable
private fun TabRail(current: Tab, onPick: (Tab) -> Unit, initial: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp)
            .padding(bottom = WindmillSpace.x2)
            .height(50.dp)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.full))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.full))
            .padding(horizontal = 5.dp),
    ) {
        Tab.entries.forEach { entry ->
            val selected = entry == current
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clickable { onPick(entry) },
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(40.dp)
                        .clip(RoundedCornerShape(WindmillRadius.full))
                        .background(if (selected) GymSkin.accentSoft else Color.Transparent),
                ) {
                    Text(
                        entry.title,
                        style = WindmillFont.body(13, if (selected) FontWeight.Bold else FontWeight.SemiBold),
                        color = if (selected) GymSkin.accent else GymSkin.inkFaint,
                    )
                }
            }
        }
        YouSeat(initial = initial)
    }
}

// The shared account seat, past a hairline so it reads as the shell's and not the room's. The
// platform owns the sheet it opens; the drawing lives here only until a second room needs it too.
@Composable
private fun YouSeat(initial: String) {
    val shell = LocalShellActions.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Box(
            Modifier
                .width(1.dp)
                .height(22.dp)
                .background(Color.White.copy(alpha = 0.14f)),
        )
        Box(
            Modifier
                .size(GymTap.minimum)
                .clickable { shell.openYou() },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .background(GymSkin.raised),
                contentAlignment = Alignment.Center,
            ) {
                if (initial.isEmpty()) {
                    // The ghost seat: nobody signed in yet, and a door does not pretend otherwise.
                    Box(
                        Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(GymSkin.inkFaint),
                    )
                } else {
                    Text(
                        initial.uppercase(),
                        style = WindmillFont.display(13),
                        color = GymSkin.ink,
                    )
                }
            }
        }
    }
}
