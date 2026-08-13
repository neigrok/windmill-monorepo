package works.windmill.gym

import android.app.Activity
import android.content.Context
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
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LiveOrder
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.Threads
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.AskOutcome
import works.windmill.gym.store.DeviceCatalog
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.AskScreen
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.GymSkin
import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.GymType
import works.windmill.gym.ui.LogScreen
import works.windmill.gym.ui.LoggerScreen
import works.windmill.gym.ui.ProposalScreen
import works.windmill.gym.ui.RecordScreen
import works.windmill.gym.ui.RoutineBuilder
import works.windmill.gym.ui.RoutineScreen
import works.windmill.gym.ui.RoutinesScreen
import works.windmill.gym.ui.SessionScreen
import works.windmill.gym.ui.SettingsScreen
import works.windmill.gym.ui.ThreadScreen
import works.windmill.gym.ui.ThreadsScreen
import works.windmill.gym.ui.TodayScreen
import works.windmill.gym.ui.askThreadSaver
import works.windmill.gym.ui.routineDraftSaver
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

// What a tab can push on top of itself: one past session with its sets, and one movement's whole
// record. Neither is read-only any more — the session pushes §G18 over itself and the record page
// renames the movement — but each holds exactly one write and each says out loud when it does not
// land. The session travels as the ROW the list already holds rather than as
// an id, because that row carries facts no other read gives back — the working set count, the
// tonnage, and whether the four-hour rule closed it rather than a tap. A movement travels as its ID
// and nothing else, which is the point of the page it opens: the name is the only thing about a
// movement that can change, and a destination holding a copy of one would be the second place in
// this room deciding what a movement is called.
//
// STATISTICS IS GONE FROM HERE, retired in W1c the wave the record page replaced it. That was a UI
// deletion and not an engine one: `GET /v1/gym/stats` and the `get_stats` tool both stand, because
// an agent asking "how has my squat moved" is the product's own thesis. What went is a room a
// lifter visits when they are not training, and the weekly session and working-set bars went with
// it — the design gives them no home.
//
// SETTINGS IS THE THIRD, AND IT IS PUSHED FROM HERE ONLY BECAUSE THE SHELL CANNOT PUSH IT YET. §I
// draws gym's settings as a SECTION the shell's You sheet lists and walks you into, and that is
// where it belongs — but this surface's `ProductModule` seam exposes exactly one thing, a room, and
// `YouSheet` is the platform's file and not gym's to edit. So the section is a self-contained
// screen with its own way back, reached from a row at the foot of Today, and the day the seam grows
// a settings slot the row goes and the screen moves across unchanged. The row says "‹ Today"
// rather than the design's "‹ You" for the reason everything else in this room says what it means:
// it really did come from Today.
// A ROUTINE AND A PROPOSAL ARE THE TWO THIS WAVE ADDED, and both travel as IDs for the reason a
// movement does: what they say changes under them. A routine's revision moves when a proposal is
// applied and its card goes when one is decided, so a screen holding a copy would be drawing the
// program as it was when it was opened. The proposal carries the routine it is about beside it —
// the base it was written against is what decides whether it can still be applied, and the diff
// read alone cannot say what this room is holding.
//
// ASK IS PUSHED AND IS NOT A TAB (§L). The rail is the app's three tabs and a chat is not a place
// anybody lives — so it arrives the way a record and a proposal do, over the screen that sent for
// it, and leaves the same way. What it carries is a DRAFT and not a conversation: the thread itself
// is hoisted into the room below, because it has to outlive this stack. A proposal's door seeds the
// composer with a question about that diff; Today's seeds nothing.
private sealed interface Away {
    data class Session(val summary: SessionSummary) : Away
    data class Movement(val exerciseId: String) : Away
    data class Program(val routineId: String) : Away
    data class Proposal(val proposalId: String, val routineId: String) : Away
    data class Ask(val seed: String = "") : Away
    // §O'S PAST: the list of conversations, and one conversation read back. The list carries nothing
    // at all — it reads its own rows, because an outcome is derived from proposals that move the
    // moment anybody decides anything — and a thread travels as its ID for the same reason a routine
    // does: what it says about itself changes under it.
    data object Threads : Away
    data class Thread(val threadId: String) : Away
    data object Settings : Away
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

// The key §J22's arrival is remembered under, spelled once — the twin of the iOS AppStorage key.
private const val firstSessionOpened = "firstSessionOpened"

@Composable
fun GymRoom(account: Account) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // THE ONE THING THIS ROOM REMEMBERS ABOUT ITSELF, and it is about the room rather than about
    // the lifter: whether §J22's arrival has already opened its session on this install. It lives
    // beside the platform's own preferences file rather than in the store's three JSON files,
    // because none of those is a record of what the ROOM did — they are the log, the queue and the
    // rack, and a flag filed in one of them would be a fourth kind of fact in a file with one job.
    val arrivals = remember {
        context.getSharedPreferences("works.windmill.gym", Context.MODE_PRIVATE)
    }
    val store = remember {
        TrainingStore(
            SetQueue(File(context.filesDir, SetQueue.fileName)),
            DeviceCatalog(File(context.filesDir, DeviceCatalog.fileName)),
            LocalLog(File(context.filesDir, LocalLog.fileName)),
            LocalPreferences(File(context.filesDir, LocalPreferences.fileName)),
            scope,
        )
    }

    var finished by remember { mutableStateOf<FinishedSession?>(null) }
    // A STACK AND NOT A SLOT, because §H's premise makes one pushed screen reach another: an
    // exercise name inside a past session lands on that movement's record, and a way back that
    // named the tab from there would be a chevron skipping the screen it was standing on.
    //
    // IT IS NOT SAVED, and that is the room's oldest decision rather than an oversight this wave
    // left standing: a recreation puts the lifter back on their tab, not back inside a pushed
    // screen. What that costs is one tap on the way back in, and what it buys is that no screen here
    // is ever drawn over a store that has not read the disk yet — a restored proposal, record or
    // session would spend its first frames saying the log has no such thing. The activity survives
    // rotation and every other configuration change on its own (`configChanges` in the manifest), so
    // "recreated" here means the process was reclaimed. What must outlive that is saved below.
    var away by remember { mutableStateOf<List<Away>>(emptyList()) }
    var keptRoutine by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var savingRoutine by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    // Saveable, and the first of the few that have to be: the log, the queue and the rack are all
    // read back off disk when the activity is recreated, but which tab was open exists nowhere but
    // here — and a recreation that dropped a lifter back on Today would be the room forgetting where
    // they were standing. (The put-off card below is the second, and the conversation with the seat
    // it belongs to is the third.)
    var tab by rememberSaveable { mutableStateOf(Tab.Today) }
    // The one proposal Today has been asked not to draw for now. Saveable for the reason the tab is
    // — an activity recreation must not put back a card the lifter just put down — and empty rather
    // than null so it saves as the String it is. It is NOT a decision and never reaches the log:
    // the routine still carries the card, and the room forgetting this on a relaunch is the
    // direction it is allowed to fail in.
    var putOff by rememberSaveable { mutableStateOf("") }
    // THE CONVERSATION IN PROGRESS, AND IT LIVES HERE RATHER THAN ON THE SCREEN THAT DRAWS IT: the
    // ask outlives the screen, and the answer has to land somewhere whether or not anybody is
    // looking at it. The LOG keeps the turns now (§O), which is why the threads list can exist at
    // all — but it does not keep the receipt under an answer, the tools it was steered by, or a
    // question that failed with no reply, so the evening in progress is still saved here and a
    // lifter thrown out by an activity recreation finds it standing when they open the door again.
    var conversation by rememberSaveable(stateSaver = askThreadSaver) {
        mutableStateOf(emptyList<AskExchange>())
    }
    // THE DAY BEING BUILT (§M), AND IT LIVES HERE FOR THE REASON THE CONVERSATION DOES: a half-typed
    // routine exists nowhere but in memory. It is not on the log, not on the shelf and not in the
    // queue, so an activity reclaimed mid-build would take an evening at the kitchen table with it —
    // and unlike a pushed screen, there is nothing to re-read on the way back that could stand in for
    // it. The draft is therefore saved AND the builder is drawn off it, which is what puts the lifter
    // back in front of what they typed rather than back on a tab with their work quietly gone.
    var building by rememberSaveable(stateSaver = routineDraftSaver) {
        mutableStateOf<RoutineDraft?>(null)
    }
    // WHICH CONVERSATION THE NEXT QUESTION LANDS IN — minted by this phone, empty until somebody
    // asks, and saved beside the thread it belongs to. §O reverses W7 here: the log keeps the turns
    // now, so this id is the whole of what makes tonight's second question a reply to the first
    // rather than a new evening. It is let go of when the seat changes, when the log says the
    // conversation is full or is somebody else's, and when the lifter asks for a new one.
    var conversationId by rememberSaveable { mutableStateOf("") }
    // Whether a question is out. It belongs beside the thread and not on the screen for the same
    // reason the ask itself does: the request outlives the screen, so the flag that closes the door
    // on a second one has to outlive it too.
    var asking by remember { mutableStateOf(false) }
    // Which seat the thread above belongs to — the empty string for the anonymous one, which can
    // never hold a conversation anyway. Saved with the thread, because a thread restored without the
    // seat it belongs to could only be read as somebody else's. Saving it is HALF the rule; the
    // other half is the flag below, and neither works alone.
    var seat by rememberSaveable { mutableStateOf(account.user?.id ?: "") }
    // WHETHER THIS ROOM HAS ACTUALLY MET THE LIFTER, and it is deliberately NOT saved. `account.user`
    // is null until `/v1/me` answers, so the first frame of every launch — including the one after a
    // recreation, where the saved thread is already restored — looks exactly like nobody being signed
    // in. Saved, this flag would come back true and hand that first frame the authority to empty a
    // conversation that belongs to the lifter about to be handed back. `Ask.handedOver` is where the
    // rule is written and where it is tested.
    var seatRead by remember { mutableStateOf(account.user != null) }
    // THIS DEPLOYMENT HAS NO ASK — a bare 404 from the route, which means the feature is absent
    // rather than that something failed. The door goes for the life of the room and is deliberately
    // NOT remembered past it: whether a server has a model configured is the server's fact, and a
    // phone that wrote it down would keep hiding a door the day it was switched on.
    var askAbsent by remember { mutableStateOf(false) }

    // Every door in and out of a retrospective screen goes through these two for one reason: the
    // note above the rail is what the room has to say about the door that did not open ON THE
    // SCREEN YOU ARE ON, and a refusal from Today carried under a record page is a sentence about
    // something that is no longer in front of the lifter. Every move between destinations clears it
    // — these, the rail's own tap, and the back gesture.
    fun look(at: Away) {
        note = null
        away = away + at
    }

    fun back() {
        note = null
        away = away.dropLast(1)
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
    // A DRAFT IS ONLY THE BUILDER'S TO DROP WHILE THE BUILDER IS ON SCREEN, which is why the draft
    // sits inside the `!live` clause with the rest of them: a workout outranks the builder, so a
    // session that opened underneath one (a claim replay, a session joined from another device) puts
    // the logger over it — and a back gesture there would have thrown away an evening of typing
    // nobody could see, on the one screen where this room hands the gesture back to the platform.
    val live = store.session != null
    BackHandler(
        enabled = finished != null ||
            (!live && (building != null || away.isNotEmpty() || tab != Tab.Today)),
    ) {
        if (finished != null) return@BackHandler
        // The builder's own back is the step chevron — the targets go back to the name, the name
        // goes back to Routines — so the gesture leaves the whole draft rather than one step of it.
        // What that costs is a draft nobody saved, which is the same thing Cancel costs and the same
        // thing the lifter asked for by making the gesture.
        if (building != null) {
            building = null
            return@BackHandler
        }
        if (away.isNotEmpty()) {
            back()
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
        // A CONVERSATION BELONGS TO THE LOG IT WAS ABOUT, and this is where it changes hands: every
        // question and every answer in a thread is somebody's own training, so a phone that changed
        // seats would be showing one lifter's numbers to the next person holding it.
        //
        // THE GHOST SEAT IS NOT A CHANGE OF LIFTER. This effect runs first at composition, when
        // `/v1/me` has not answered and `account.user` is null for everybody — signed in, signed out
        // and never-signed-in alike — so a bare `standing != seat` would empty the thread on the way
        // back from every recreation and take the saver, the interrupted question and its retry with
        // it. The rule and its two failures live in `Ask.handedOver`, where a test can stand.
        val standing = account.user?.id
        if (Ask.handedOver(seat, standing, seatRead)) {
            conversation = emptyList()
            // The id goes with the words. A thread id kept across a seat would send the next
            // lifter's question into a conversation the log holds for somebody else, and the log
            // would rightly refuse it — but the room would have tried.
            conversationId = ""
            seat = standing ?: ""
        }
        if (standing != null) seatRead = true
        // A QUESTION THE ACTIVITY WENT DOWN UNDER, settled on the way back in. The thread is saved
        // and the request is not, so a recreation mid-answer restores a question with nothing under
        // it and nothing coming — left alone it would sit there un-retryable for the life of the
        // install, which is the one way this room could lose something a lifter typed. Nothing
        // shorter than the activity can strand one: the ask below is the room's, so leaving Ask for
        // Today lets the answer land in a thread nobody is looking at.
        conversation = Ask.settled(conversation)
        store.connect(account)
        // Deviates from iOS, where the ROOM resumes after connect: here connect() owns the resume, so a boot cannot race it.

        // ARRIVING STARTED IT — §J22, and it is the whole of gym's onboarding. Not a tour, not a
        // splash, not a question about goals: the real surface with its first move already made, so
        // that the first thing a lifter sees is the picker over a session that is already running.
        // The room asks nothing first, and the door it does hold out (`Build my routine`) is an
        // offer inside that surface rather than a gate in front of it.
        //
        // ONCE PER INSTALL, on a room that is KNOWN to hold nothing — `store.firstRun` asks whether
        // the reads that could say otherwise actually landed, and this asks whether the arrival has
        // already happened here. Both are needed and neither is the other: without the flag, a
        // lifter who SIGNS OUT is a room with an empty page and no way to see why, and the arrival
        // would open a workout nobody started over a log that is merely out of reach — then claim
        // that empty workout onto them when they signed back in. It is also what makes "once" true
        // after a first session is DISCARDED: without it, arriving at an emptied room would keep
        // opening the session the lifter just deleted, forever.
        //
        // It is not a decline counter and not a "have they seen this": it counts nothing, holds no
        // id and no date, and records one thing the ROOM did — the same shape as the iOS
        // `windmill.gym.firstSessionOpened`, which this is the twin of.
        if (!arrivals.getBoolean(firstSessionOpened, false) && store.firstRun) {
            store.start(null)
            // NOBODY ASKED FOR THIS ONE, so nobody is owed a sentence about it not opening: the
            // note above the rail speaks for a door the lifter reached for, and Today's own Start
            // button is where a lifter who DID ask is told, in the log's own words. The flag
            // follows the session and not the attempt, so a start that never opened is tried again
            // on the next arrival.
            if (store.session != null) arrivals.edit().putBoolean(firstSessionOpened, true).apply()
        }
    }

    // A WITHHELD DELETE BELONGS TO THE SCREEN THE GESTURE WAS MADE ON. Leaving that screen ends its
    // window exactly as leaving the room does: the row is off the screen it was taken from, so there
    // is nothing left to take it back from and the delete goes. Keyed on which session is standing
    // rather than hung off each door, because a start, a back gesture, a chevron and a push are four
    // ways out of one screen and a settle wired to three of them is the one that loses a write.
    val standingSession = (away.lastOrNull() as? Away.Session)?.summary?.id
    LaunchedEffect(standingSession) {
        if (store.withheld?.sessionId == standingSession) return@LaunchedEffect
        store.settleWithheld()?.let { note = it.line("that set is still on the log") }
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
            CoroutineScope(Dispatchers.Main.immediate).launch {
                // The owed sets first and the withheld delete second, and the order is the stakes:
                // a set that never landed is refused forever once its session closes, while a
                // delete has no deadline at all. A §G18 delete still inside its window goes on the
                // way out for the same reason an owed set does — the row it took is off the screen
                // the gesture belonged to, so there is nothing left to take it back from.
                //
                // ITS FAILURE IS THE ONE THIS ROOM DOES NOT SAY, and that is a decision rather than
                // an oversight: the sibling settle above answers into `note`, but this composition
                // and the store remembered in it are both already gone, so there is no surface left
                // to put a sentence on and no next reader to carry it to. It fails in the surviving
                // direction — the set stands on the log, and the session it belongs to still draws
                // it the next time the room opens.
                store.flushPendingSets(force = true)
                store.settleWithheld()
            }
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
                // on the finish screen must land on Today rather than back on a record or a list.
                away = emptyList()
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

    // A whole workout destroyed, and a delete that did not happen is the one thing this may not draw
    // as if it had: the screen only leaves once the log says the session is gone. (§G18 takes a
    // single set and lives on the session read back, behind its own window.)
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

    // ONE QUESTION, ASKED FROM THE ROOM AND NOT FROM THE SCREEN THAT DRAWS IT. Ask is the one door
    // in this product that COSTS something per use — the day's questions are counted at the edge the
    // moment the request lands, before a token is spent — so an answer must not be thrown away by a
    // lifter walking back to Today mid-wait. The thread lives here, the coroutine lives here, and
    // the answer lands in it whether or not anybody is standing on the screen.
    //
    // It also carries the two things that outlive the conversation: a proposal the answer minted is
    // read back into the program by the store (the card on Today IS this product's notification
    // design), and a deployment with no Ask at all takes its own door down.
    //
    // The door closes on the way IN rather than inside the coroutine: two taps on one question would
    // be two round trips, two spends and two answers against one bubble.
    fun ask(from: List<AskExchange>, question: String) {
        if (asking || !Ask.sendable(question)) return
        val asked = question.trim()
        // THE THREAD THIS QUESTION LANDS IN, minted here on the first question of a conversation and
        // reused for every one after it. It is minted BEFORE the send and kept whatever comes back,
        // so a retry continues the same conversation instead of scattering one evening across two.
        //
        // IT IS NOT THE IDEMPOTENCY EVERY OTHER WRITE IN THIS ROOM HAS, and the difference is worth
        // saying: a set carries a client-minted id for the ROW, so a replay is the same row; here
        // the id names the CONVERSATION and the question carries no id of its own. The log discards
        // a thread whose question it never answered, so the retry after a 502 costs nothing twice —
        // but a reply lost in transit AFTER the log answered leaves a stored turn this room never
        // saw, and asking again spends a second call and stores a second turn. That is exactly why
        // nothing is ever re-sent on its own: this door spends money, so the retry is a tap.
        val into = conversationId.ifEmpty { Ids.thread().also { conversationId = it } }
        asking = true
        conversation = from + AskExchange(question = asked)
        scope.launch {
            try {
                // ONE QUESTION GOES OUT. The log holds the turns and assembles the prompt from them
                // (§O reverses W7's stateless Ask), so the conversation a lifter reads back on the
                // threads screen is the one the model actually saw.
                when (val outcome = store.ask(into, asked)) {
                    is AskOutcome.Answered ->
                        conversation = from + AskExchange(question = asked, answer = outcome.answer)
                    is AskOutcome.Refused ->
                        conversation = from + AskExchange(question = asked, trouble = outcome.said)
                    is AskOutcome.Failed ->
                        conversation = from + AskExchange(
                            question = asked, trouble = outcome.said, again = true)
                    // THE CONVERSATION IS OVER AND THE QUESTION IS FINE: eight turns is a full
                    // thread, and an id another account holds is not this lifter's to write into.
                    // The room lets go of the id, says the log's own sentence, and offers the tap —
                    // which opens a NEW conversation with the same question in it. Nothing is
                    // re-sent on its own, because this is the one door that spends money.
                    is AskOutcome.Fresh -> {
                        conversationId = ""
                        conversation = from + AskExchange(
                            question = asked, trouble = outcome.said, again = true)
                    }
                    AskOutcome.Absent -> {
                        conversation = from + AskExchange(question = asked, trouble = Ask.notHere)
                        askAbsent = true
                    }
                }
            } finally {
                asking = false
            }
        }
    }

    // A NEW CONVERSATION, opened from the foot of the threads list. The live thread on screen is let
    // go of along with its id — what was asked is on the log and readable in the list behind this
    // door, so nothing is lost by clearing it, and a fresh question under an old title would be
    // filed under an evening nobody had tonight.
    fun askSomethingNew() {
        conversation = emptyList()
        conversationId = ""
        away = listOf(Away.Ask())
    }

    // §M'S SAVE, and it lives here rather than on the builder for the reason every write in this
    // room does: the builder's composition dies the moment the draft is let go of, and a back
    // gesture inside the round trip would cancel a routine half-way onto the log with nothing left
    // standing to say so. The door closes while one is in flight, exactly as Start's does — two
    // taps on one Save would be two routines.
    //
    // A SAVED DAY LANDS ON ITS OWN PAGE, which is where §M's third door ends: screen 30, with
    // `untested` on it and the movements as they were just written down. An edit lands back on the
    // same page it was opened from, which is the same statement.
    fun write(draft: RoutineDraft) {
        scope.launch {
            if (savingRoutine) return@launch
            savingRoutine = true
            try {
                note = null
                when (val written = store.saveRoutine(draft)) {
                    is GymResult.Failed -> note = written.why.line("${draft.name} wasn’t saved")
                    is GymResult.Ok -> {
                        building = null
                        away = listOf(Away.Program(written.value.id))
                        tab = Tab.Routines
                    }
                }
            } finally {
                savingRoutine = false
            }
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
        val standing = away.lastOrNull()
        // What the way back LEADS TO, which after a second push is the screen underneath and not
        // the tab. A movement is named off the catalog rather than carried, so a rename on the
        // record page renames the row that leads back to it too.
        val beneath = when (val under = away.getOrNull(away.size - 2)) {
            is Away.Session -> under.summary.plan?.routine ?: Readout.noRoutine
            is Away.Movement -> Readout.movement(under.exerciseId, store.catalog)
            // Named off the store rather than carried, exactly as a movement is: a routine an
            // applied proposal renamed leads back under its new name, and one an applied removal
            // took with it says so rather than naming a program that is gone.
            is Away.Program -> store.routine(under.routineId)?.name ?: "Routines"
            is Away.Proposal -> "Proposal"
            is Away.Ask -> "Ask"
            Away.Threads -> Threads.title
            // The way out of a proposal minted in a conversation lands back ON that conversation,
            // so the chevron says what it returns to. It says the NOUN and not the thread's title:
            // a title is the lifter's first message verbatim, at whatever length they typed it, and
            // a paragraph in a back row is a back row that has stopped being a way back.
            is Away.Thread -> Threads.conversation
            Away.Settings -> "Gym"
            null -> tab.title
        }

        // The way back out of a pushed screen, at its head and naming where it goes — §G17 puts it
        // there rather than at the foot, because "‹ The log" is a destination and a bare chevron in
        // a bar is not. The record page draws its own instead: §H hangs `Rename` off the right of
        // this row, and a screen that owns an action in the row owns the row.
        if (ended == null && !live && building == null && standing is Away.Session) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
                modifier = Modifier
                    .heightIn(min = GymTap.minimum)
                    .padding(horizontal = WindmillSpace.x5)
                    .clickable { back() },
            ) {
                Text("‹", style = WindmillFont.body(19, FontWeight.SemiBold), color = GymSkin.inkDim)
                Text(beneath, style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkDim)
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
                    isSignedIn = account.isSignedIn,
                    say = { note = it },
                    onFinish = { close() },
                    // The room's one account verb (§J22), and it is the shell's door: gym does not
                    // draw a sign-in of its own, and screen 23's promise — that signing in claims
                    // the session you already started and lands you back here, mid-set — is kept by
                    // the claim replay rather than by anything on this screen.
                    onSignIn = LocalShellActions.current.openYou,
                )
                // A DAY BEING BUILT OUTRANKS A TAB AND NOTHING ELSE, which is why it stands below
                // the workout and below the finish in this list: a lifter under a bar cannot wait,
                // and a draft can — it is saved, and it is still there afterwards. It covers the
                // rail, because it is a thing being written rather than a place to stand.
                building != null -> RoutineBuilder(
                    draft = building!!,
                    store = store,
                    // Where the name step's chevron actually goes, which is not always the tab: a
                    // routine opened from its own page (Edit, Duplicate) goes back to that page.
                    backLabel = when (val under = away.lastOrNull()) {
                        is Away.Program -> store.routine(under.routineId)?.name ?: Tab.Routines.title
                        else -> tab.title
                    },
                    saving = savingRoutine,
                    onDraft = { building = it },
                    onSave = { write(building!!) },
                    onClose = { building = null },
                    say = { note = it },
                )
                standing is Away.Movement -> RecordScreen(
                    exerciseId = standing.exerciseId,
                    store = store,
                    backLabel = beneath,
                    onBack = { back() },
                )
                standing is Away.Settings -> SettingsScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    // The same origin the share link and Ask's free door are spelled off, and for
                    // the same reason: the connected log's grant is a page on the server this build
                    // talks to.
                    origin = origin,
                    backLabel = beneath,
                    onBack = { back() },
                    say = { note = it },
                )
                standing is Away.Session -> SessionScreen(
                    summary = standing.summary,
                    store = store,
                    coach = coach,
                    say = { note = it },
                    onOpenMovement = { look(Away.Movement(it)) },
                )
                standing is Away.Program -> RoutineScreen(
                    routineId = standing.routineId,
                    store = store,
                    isSignedIn = account.isSignedIn,
                    backLabel = beneath,
                    onBack = { back() },
                    onStart = { routineId -> open(routineId) },
                    // Edit and Duplicate are the same door: a document handed to the builder. The
                    // page stays underneath, so saving lands back on the routine it came from.
                    onBuild = { building = it },
                    onOpenMovement = { look(Away.Movement(it)) },
                    onReview = { look(Away.Proposal(it.id, it.routineId)) },
                    // §O'S OTHER DOOR: a history row that came out of a conversation opens it. It
                    // is drawn only where the log carries a thread id — the trail survives the
                    // conversation's deletion, so the row stands either way and only the door goes.
                    onOpenThread = { look(Away.Thread(it)) },
                    say = { note = it },
                )
                standing is Away.Proposal -> ProposalScreen(
                    proposalId = standing.proposalId,
                    routineId = standing.routineId,
                    store = store,
                    backLabel = beneath,
                    onBack = { back() },
                    // §L's second door onto Ask, and the only one that arrives carrying a subject:
                    // the diff is on screen, so the question is about this diff. It is offered only
                    // where Ask itself is — an account, and a deployment that has one.
                    onAsk = if (account.isSignedIn && !askAbsent) {
                        { about -> look(Away.Ask("What would this change to $about do?")) }
                    } else {
                        null
                    },
                )
                // NEVER OFFERED MID-SESSION, and on this phone that is structure rather than a
                // check: a live session takes the whole screen above, so neither door that reaches
                // here is drawn while a workout is open. The server refuses one anyway — three
                // clients each remembering a rule is three chances to forget it.
                standing is Away.Ask -> AskScreen(
                    store = store,
                    thread = conversation,
                    asking = asking,
                    onAsk = { asked -> ask(conversation, asked) },
                    // ONLY THE NEWEST QUESTION IS EVER ASKED AGAIN — the screen offers the retry
                    // nowhere else, because a retry further up would have to send the thread as it
                    // stood then, dropping everything asked since. So the room does not need to be
                    // told which one: it is the last, and it replaces itself.
                    onRetry = {
                        conversation.lastOrNull()?.let { ask(conversation.dropLast(1), it.question) }
                    },
                    seed = standing.seed,
                    // §O'S DOOR, and it is in Ask's own header because that is where somebody
                    // standing in a conversation goes looking for the ones before it. It is not a
                    // badge and it counts nothing — the list says how many there are once it has
                    // read them.
                    onThreads = { look(Away.Threads) },
                    // The same origin the share link is spelled off, and for the same reason: the
                    // free door Ask points at is a page on the server this build talks to.
                    origin = origin,
                    backLabel = beneath,
                    onBack = { back() },
                    onReview = { look(Away.Proposal(it.id, it.routineId)) },
                )
                standing is Away.Threads -> ThreadsScreen(
                    store = store,
                    backLabel = beneath,
                    onBack = { back() },
                    onOpen = { look(Away.Thread(it)) },
                    onAskNew = { askSomethingNew() },
                )
                standing is Away.Thread -> ThreadScreen(
                    threadId = standing.threadId,
                    store = store,
                    backLabel = beneath,
                    onBack = { back() },
                    // The list is what the lifter lands back on, and it reads itself again — the
                    // conversation that was deleted is gone from it because the log says so, and
                    // never because this room crossed a row out on the strength of its own tap.
                    onDeleted = { back() },
                    onReview = { look(Away.Proposal(it.id, it.routineId)) },
                    say = { note = it },
                )
                tab == Tab.Log -> LogScreen(store, onOpenSession = { look(Away.Session(it)) })
                tab == Tab.Routines -> RoutinesScreen(
                    store = store,
                    // §D'S INVITATION LIVES ON THIS TAB, and both of these decide whether it is
                    // drawn rather than how: a grant is granted against an account, and the page it
                    // is approved on is served by whichever backend this build talks to.
                    isSignedIn = account.isSignedIn,
                    origin = origin,
                    onStart = { routineId -> open(routineId) },
                    // §M'S THIRD DOOR, and the tab about the program is where it belongs.
                    onBuild = { building = it },
                    onOpenRoutine = { look(Away.Program(it)) },
                    onOpenMovement = { look(Away.Movement(it)) },
                    onReview = { look(Away.Proposal(it.id, it.routineId)) },
                )
                else -> TodayScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    putOff = putOff.ifEmpty { null },
                    onStart = { routineId -> open(routineId) },
                    onOpenSession = { look(Away.Session(it)) },
                    onOpenMovement = { look(Away.Movement(it)) },
                    onOpenSettings = { look(Away.Settings) },
                    // ASK'S OWN DOOR, in Today's bottom band and nowhere else on this screen. It is
                    // withheld from a signed-out room for the reason the proposal card is: Ask reads
                    // the ACCOUNT's log, and a door onto a 401 is a door onto nothing. It goes too
                    // on a deployment that has no Ask at all.
                    onOpenAsk = if (account.isSignedIn && !askAbsent) {
                        { look(Away.Ask()) }
                    } else {
                        null
                    },
                    onReview = { look(Away.Proposal(it.id, it.routineId)) },
                    // LATER IS NOT A DECISION AND NOTHING IS SENT. It puts this card away on Today
                    // for as long as the room stands — the routine it belongs to still carries it,
                    // dot and all, so nothing is hidden and nothing was decided by a thumb reaching
                    // for the quiet button. Saveable, so a rotation does not bring back a card the
                    // lifter just put down; one slot, because Today draws one card.
                    onLater = { putOff = it.id },
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
        if (ended == null && !live && building == null && away.isEmpty()) {
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
