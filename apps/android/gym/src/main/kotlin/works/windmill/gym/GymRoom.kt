package works.windmill.gym

import android.app.Activity
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.Face
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.Coach
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LiveOrder
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.Threads
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.AskOutcome
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.gym.ui.AskAbsentStance
import works.windmill.gym.ui.AskScreen
import works.windmill.gym.ui.AskSignedOutStance
import works.windmill.gym.ui.BodyweightScreen
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.GymSkin
import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.GymType
import works.windmill.gym.ui.LogScreen
import works.windmill.gym.ui.LoggerScreen
import works.windmill.gym.ui.NoteEditorScreen
import works.windmill.gym.ui.NotesScreen
import works.windmill.gym.ui.RecordScreen
import works.windmill.gym.ui.ReviewSheet
import works.windmill.gym.ui.RoutineBuilder
import works.windmill.gym.ui.RoutineScreen
import works.windmill.gym.ui.RoutinesScreen
import works.windmill.gym.ui.rememberGymHaptics
import works.windmill.gym.ui.SessionScreen
import works.windmill.gym.ui.SettingsScreen
import works.windmill.gym.ui.ThreadScreen
import works.windmill.gym.ui.ThreadsScreen
import works.windmill.gym.ui.askThreadSaver
import works.windmill.gym.ui.routineDraftSaver
import works.windmill.platform.Account
import works.windmill.platform.auth.PrefsSessions
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ProductModule
import works.windmill.platform.design.WindmillSpace

// Gym's one seam into the superapp.
class GymModule : ProductModule {
    override val id = "gym"
    override val label = "Gym"

    @Composable
    override fun Room(account: Account) {
        GymRoom(account)
    }
}

internal enum class Tab(val title: String) {
    Routines("Routines"),
    Log("The log"),
    Coach("Coach"),
}

// Back has four meanings on this surface and two of them are not pops, which is why the room
// decides them itself rather than handing the stack to a navigator. The finish receipt is not among
// them: it is a sheet, and a sheet answers back by coming down.
internal enum class BackMeans {
    // Mid-workout: the logger stays standing. A stroke from the edge with a bar in your hands must
    // never put the app in the background.
    StayInTheWorkout,
    // The editor: back is Cancel and it leaves the whole draft.
    LeaveTheDraft,
    PopOnePushedScreen,
    ReturnToTheRoutinesTab,
    // The routines home has nothing behind it, so back is the platform's and leaves the app.
    LeaveTheApp,
}

internal fun backMeans(
    live: Boolean,
    building: Boolean,
    away: Int,
    tab: Tab,
): BackMeans = when {
    live -> BackMeans.StayInTheWorkout
    building -> BackMeans.LeaveTheDraft
    away > 0 -> BackMeans.PopOnePushedScreen
    tab != Tab.Routines -> BackMeans.ReturnToTheRoutinesTab
    else -> BackMeans.LeaveTheApp
}

// The rail belongs to the three tabs and to nothing else: a live session, a draft and any pushed
// screen each take the whole frame, and a bar drawn empty would reserve height for nothing. A finish
// needs no say here — the receipt is a sheet over the closed session, which is a pushed screen.
internal fun railStands(live: Boolean, building: Boolean, away: Int): Boolean =
    !live && !building && away == 0

// Saved as its NAME: a Bundle holding an entry this build does not have must land on home, not
// crash the restore.
internal fun restoredTab(saved: Any?): Tab =
    Tab.entries.firstOrNull { it.name == saved } ?: Tab.Routines

internal val tabSaver: Saver<Tab, Any> = Saver(save = { it.name }, restore = ::restoredTab)

// A session travels as the ROW the list already holds, which carries facts no other read gives back;
// so does a note, which the list just read and the editor edits whole. A movement, routine and
// thread travel as IDS, because what they say changes under them. `Coach` carries a DRAFT, never the
// thread — the thread is hoisted into the room below so it outlives this stack. A proposal review is
// not a destination at all: it is a sheet over whichever of these is standing.
private sealed interface Away {
    data class Session(val summary: SessionSummary) : Away
    data class Movement(val exerciseId: String) : Away
    data class Program(val routineId: String) : Away
    data class Coach(val seed: String = "") : Away
    data object Threads : Away
    data class Thread(val threadId: String) : Away
    data object Settings : Away
    data object Notes : Away
    data class NoteEditor(val note: Note?, val seedTitle: String) : Away
    data object Bodyweight : Away
}

// The review sheet and the door it opened from, which is where its receipt lands: the live
// conversation, a stored thread, or the routines home. The proposal carries the routine the diff was
// written against.
private data class Reviewing(val proposalId: String, val routineId: String, val door: String) {
    companion object {
        const val coach = "coach"
        const val routines = "routines"
        fun thread(id: String) = "thread:$id"
    }
}

// The three tabs, the live session, and the screens a tab can push — the finish receipt is a sheet
// over one of those, not an arm of this. The shell owns the theme control and billing; its account
// seat rides the trailing slot of each root's own top bar, because a native rail has no fourth seat.
//
// A live session takes the whole screen, rail included; a pushed screen covers the rail too.
//
// A room's state dies when you leave it, store included: the queue is on disk after every tap and
// leaving flushes, or a set is refused once the session closes.

// The store the room runs over, on this device's own files and in a scope that dies with the room.
// Its own factory because it is the room's one collaborator: a test stands the room over a store it
// can reach and a log it can refuse with, which is the only way the transient's own rules — a
// refusal is SAID, a way back is retired — can be pinned at all.
@Composable
internal fun rememberDeviceStore(): TrainingStore {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return remember {
        // Read off the session store, never off `account`: this room mounts before /v1/me resolves.
        val deviceOwner = PrefsSessions(context).user()?.id
        TrainingStore(
            SetQueue(File(context.filesDir, SetQueue.fileName), deviceOwner),
            DeviceCopy(File(context.filesDir, DeviceCopy.fileName)),
            LocalLog(File(context.filesDir, LocalLog.fileName), deviceOwner),
            LocalPreferences(File(context.filesDir, LocalPreferences.fileName)),
            LocalBodyweight(File(context.filesDir, LocalBodyweight.fileName), deviceOwner),
            scope,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymRoom(account: Account, store: TrainingStore = rememberDeviceStore()) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // The receipt for the session just closed, raised as a sheet over that session. NOT saved: it
    // carries the sets the queue has already let go of. Its refusal rides beside it, because a sheet
    // covers the room's bottom bar.
    var finished by remember { mutableStateOf<FinishedSession?>(null) }
    var finishFailure by remember { mutableStateOf<String?>(null) }
    val finishSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // A stack, not a slot: one pushed screen can reach another. NOT saved, so no screen is drawn
    // over a store that has not read the disk yet. The activity handles rotation itself
    // (`configChanges` in the manifest), so a recreation here means the process was reclaimed.
    var away by remember { mutableStateOf<List<Away>>(emptyList()) }
    var keptRoutine by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var savingRoutine by remember { mutableStateOf(false) }
    var keepingRoutine by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    // Which tab was open exists nowhere but here, so it is saved through `tabSaver`.
    var tab by rememberSaveable(stateSaver = tabSaver) { mutableStateOf(Tab.Routines) }
    // The review open over the room. NOT saved: it reads the log on the way in, and a recreation
    // mid-review lands back on the card, which decides nothing either.
    var reviewing by remember { mutableStateOf<Reviewing?>(null) }
    val reviewSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // Reviews opened and closed with nothing decided: their cards read `still waiting`. Saved as the
    // string it is, ids joined by a space.
    var lookedAt by rememberSaveable { mutableStateOf("") }
    // Receipts by the door they landed in. NOT saved and not stored anywhere: a receipt is derived
    // from the server's apply reply and vanishes with the screen, and nothing pretends otherwise.
    var receipts by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    // Lives here rather than on the screen that draws it: the ask outlives the screen. The log keeps
    // the turns but not the receipt, the tools or a question that failed with no reply.
    var conversation by rememberSaveable(stateSaver = askThreadSaver) {
        mutableStateOf(emptyList<AskExchange>())
    }
    // A half-typed routine exists nowhere but in memory, so the draft is saved and the builder is
    // drawn off it.
    var building by rememberSaveable(stateSaver = routineDraftSaver) {
        mutableStateOf<RoutineDraft?>(null)
    }
    // Which conversation the next question lands in; minted by this phone, empty until somebody asks.
    var conversationId by rememberSaveable { mutableStateOf("") }
    // Outlives the screen, because the request does.
    var asking by remember { mutableStateOf(false) }
    // Which seat the thread above belongs to; empty is the anonymous one. Saved with the thread.
    var seat by rememberSaveable { mutableStateOf(account.user?.id ?: "") }
    // Whether this room has met the lifter. NOT saved: `account.user` is null until /v1/me answers,
    // so the first frame of every launch looks like nobody signed in.
    var seatRead by remember { mutableStateOf(account.user != null) }
    // This deployment has no Coach: a bare 404 from the route. Not remembered past the room's life.
    var askAbsent by remember { mutableStateOf(false) }
    // An allowance ran out — the day's ten, or the account's 30-day ceiling: the composer is down
    // until the room is entered again, and the log is the one that says whether it is back. Which
    // ceiling it was decides what is said and which door leads. Saved: a recreation is not a
    // re-entry, so it must not hand the composer back mid-cap.
    var cap by rememberSaveable { mutableStateOf<AskCap?>(null) }
    // The room's one haptic vocabulary, used for the acts the room itself owns: a finish, and a save
    // the room performs on a screen's behalf.
    val haptics = rememberGymHaptics()
    // The transient's host. A message with an action and a window lives here; the `note` slot below
    // stays for what is about the screen you are on and dies when you leave it. The two are NOT
    // interchangeable: `note` clears on every navigation, which is exactly what a window must not do.
    val transient = remember { SnackbarHostState() }

    // A thread's receipts live exactly as long as that thread is on screen.
    fun pruneReceipts() {
        val standing = (away.lastOrNull() as? Away.Thread)?.let { Reviewing.thread(it.threadId) }
        receipts = receipts.filterKeys { it == Reviewing.coach || it == standing }
    }

    // The note is about the screen you are ON, so every move between destinations clears it.
    fun look(at: Away) {
        note = null
        away = away + at
        pruneReceipts()
    }

    fun back() {
        note = null
        away = away.dropLast(1)
        pruneReceipts()
    }

    // Opened over whatever is standing; the door is where the receipt will land.
    fun review(proposalId: String, routineId: String, door: String) {
        reviewing = Reviewing(proposalId, routineId, door)
    }

    fun closeReview() {
        scope.launch { reviewSheet.hide() }.invokeOnCompletion { reviewing = null }
    }

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    // Whatever the door does next waits for the sheet to be off, or the room's own chrome redraws
    // itself under a sheet that is still coming down.
    fun closeFinish(then: () -> Unit = {}) {
        scope.launch { finishSheet.hide() }.invokeOnCompletion {
            finished = null
            finishFailure = null
            then()
        }
    }

    // The server's reply, never the model's prose. From the routines home there is no thread to land
    // in, so the room's own line carries it until the next move.
    fun landReceipt(door: String, line: String) {
        if (door == Reviewing.routines) {
            note = line
            return
        }
        receipts = receipts + (door to receipts[door].orEmpty() + line)
    }

    val live = store.session != null
    val means = backMeans(live, building != null, away.size, tab)
    BackHandler(enabled = means != BackMeans.LeaveTheApp) {
        when (means) {
            BackMeans.StayInTheWorkout, BackMeans.LeaveTheApp -> Unit
            BackMeans.LeaveTheDraft -> building = null
            BackMeans.PopOnePushedScreen -> back()
            BackMeans.ReturnToTheRoutinesTab -> {
                note = null
                tab = Tab.Routines
            }
        }
    }

    // `connect` drains what the device is still holding BEFORE it reads the log: a read settles a
    // stale open session at its last activity, and past four hours from that close an owed set is
    // refused for good.
    LaunchedEffect(account.user?.id, account.verified) {
        // A conversation belongs to the seat it was had on. A bare `standing != seat` would be
        // wrong: this effect runs first at composition, when `account.user` is null for everybody.
        val standing = account.user?.id
        if (Ask.handedOver(seat, standing, seatRead)) {
            conversation = emptyList()
            // The id goes with the words, or the next lifter's question lands in somebody else's
            // conversation.
            conversationId = ""
            seat = standing ?: ""
            receipts = emptyMap()
        }
        if (standing != null) seatRead = true
        // The thread is saved and the request is not, so a recreation mid-answer restores a question
        // with nothing coming.
        conversation = Ask.settled(conversation)
        store.connect(account)
    }

    // LEAVING KEEPS THE WINDOW. The transient is the room's and follows the lifter through every pop,
    // tab change and sheet; the clock that closes a window is the store's own, one per act, so a
    // screen going away settles nothing. Only the room unmounting for good flushes early, below.
    //
    // ONE transient, ONE owner. Two different things can have a way back open at the same moment — a
    // delete being withheld, and a set just logged, which used to be a text button inside the logger's
    // set row and moved here because an inline button scrolls out of sight and can never say that the
    // window has CLOSED. Two effects racing one host would show the second late or not at all, so
    // they are said together: the count is over both, and it is `to take back` rather than `deleted`
    // the moment the append is among them.
    //
    // Said for as long as a way back is open and never a moment longer: the span is the queue's
    // `undoWindowMs` and never a snackbar default. The store stamped both windows and the store is
    // what says how much is left of them — the room reads no clock of its own, or the span would be
    // measured against an instant a different clock wrote. The key is
    // everything that could change what is offered — so the instant a settle commits a delete to the
    // wire, or a second act joins the window, or an older one leaves it, this effect is cancelled and
    // the transient is redrawn for what is left. An Undo offered over a delete already sent is a lie.
    //
    // `store.sets` is read for its own sake and not for its value: `undoable` is computed off the
    // queue and the queue's own clock, neither of which a composition observes, so without this read
    // the room never hears that a set landed and the offer would never be made.
    val takeable = store.holding
    val landed = store.sets.lastOrNull()?.id
    val owed = store.undoable
    LaunchedEffect(takeable?.subjectId, store.withheld.size, owed?.id, landed) {
        val said = Withheld.line(store.withheld, owed) ?: return@LaunchedEffect
        val left = store.wayBackLeftMs
        if (left <= 0) return@LaunchedEffect
        val decided = withTimeoutOrNull(left) {
            transient.showSnackbar(
                message = said,
                actionLabel = Withheld.undo,
                // No dismiss while a window runs: a transient that could be swept away would be a
                // way back that vanished without its clock closing.
                withDismissAction = false,
                duration = SnackbarDuration.Indefinite,
            )
        }
        if (decided == SnackbarResult.ActionPerformed) {
            // Newest first, whichever kind it is: the one whose clock closes last is the one the
            // lifter just did.
            if ((store.undoableUntilMs ?: 0L) > (takeable?.untilMs ?: 0L)) {
                store.undoLast()
                return@LaunchedEffect
            }
            // A tap that raced the send by a frame: the log has it, so say so rather than report a
            // keep that did not happen.
            if (store.keepWithheld() == null) {
                transient.showSnackbar(Withheld.alreadyGone, duration = SnackbarDuration.Short)
            }
            return@LaunchedEffect
        }
        transient.currentSnackbarData?.dismiss()
    }

    // The one thing the room says about a settle, and it is a failure: the window closed, the log was
    // asked and it said no. Nothing local was crossed out, so the row is back on the next read.
    LaunchedEffect(store.deleteRefused) {
        val refused = store.deleteRefused ?: return@LaunchedEffect
        // It takes the transient off whatever is standing there: a way back must never hide a
        // refusal, and another window's Undo is still offered when this one has been read.
        transient.currentSnackbarData?.dismiss()
        // SAID first, cleared afterwards, and the order is the whole of it: clearing it first
        // changes the key this effect is running under, and an effect that changes its own key
        // cancels itself — the sentence was never said, and a delete the log refused looked exactly
        // like one that worked. Cleared only once it HAS been said, so a room torn down mid-sentence
        // still owes it.
        transient.showSnackbar(refused, duration = SnackbarDuration.Long)
        store.clearDeleteRefused()
    }

    // ON_STOP is the second net behind ON_PAUSE. The dispose flush is launched UNSTRUCTURED: the
    // composition scope dies with the room and the drain it owes the log may not.
    //
    // THE WINDOW LIVES ONLY WHILE THE ROOM IS ON SCREEN. Leaving it — the app going to the
    // background, the room going away for good, or the process dying — abandons everything the room
    // was holding, a set's delete with the rest: the rows come back, nothing goes on the wire and
    // nothing is said on the next open, because nothing happened. Sending instead would make
    // `swipe · switch apps · come back` an unrecoverable delete reached by two ordinary actions,
    // which is the exact hazard the withheld window exists to prevent. Nothing is written to disk,
    // so a process death abandons on its own. What leaves this room unstructured is the QUEUE's
    // drain — sets already logged, on disk, retried — and no delete rides out with it.
    //
    // ON_STOP and not ON_PAUSE: a dialog or a permission sheet over the room is still the room on
    // screen, and a window that closed for those would be a way back lost to a system prompt.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val watcher = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
                scope.launch { store.flushPendingSets() }
            }
            // The transient goes down with what it was offering: an Undo left standing over an act
            // that was let go would offer a way back to something that never happened.
            if (event == Lifecycle.Event.ON_STOP && store.abandonWithheld()) {
                transient.currentSnackbarData?.dismiss()
            }
        }
        lifecycleOwner.lifecycle.addObserver(watcher)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(watcher)
            store.abandonWithheld()
            // The owed sets and nothing else: a set that never landed is refused forever once its
            // session closes, so its drain outlives the room on purpose. The window does not — it
            // was abandoned whole a line ago.
            CoroutineScope(Dispatchers.Main.immediate).launch { store.flushPendingSets(force = true) }
        }
    }

    // The screen stays on for a live session, and only for one.
    val window = (context as? Activity)?.window
    val running = store.session != null
    DisposableEffect(window, running) {
        if (running) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    // A double tap is a second session, so the door closes while the first is in flight. A log that
    // could not be reached is not a refusal: the store composes the workout on the device and the
    // claim lands it. A user-tapped start never silently joins.
    fun open(routineId: String?) {
        scope.launch {
            if (starting) return@launch
            starting = true
            try {
                note = null
                val opened = store.start(routineId)
                if (opened is GymResult.Failed) {
                    note = opened.why.line("nothing started")
                    return@launch
                }
                away = emptyList()
                tab = Tab.Routines
                val movement = LiveOrder.resume(store.order, store.sets) ?: return@launch
                store.choose(movement)
            } finally {
                starting = false
            }
        }
    }

    // Take the sets BEFORE the close: the queue lets go of a delivered row the moment its session
    // ends.
    //
    // The workout it closed is PUSHED before the receipt is raised, so dismissing the receipt leaves
    // the lifter in the workout they finished (16-the-workout) rather than back on the routines home.
    fun close() {
        scope.launch {
            val live = store.session ?: return@launch
            val performed = store.sets
            note = null
            when (val ended = store.finish()) {
                is FinishOutcome.Closed -> {
                    haptics.finished()
                    keptRoutine = false
                    finishFailure = null
                    away = listOf(Away.Session(SessionSummary(ended.session, performed)))
                    pruneReceipts()
                    finished = FinishedSession(
                        session = ended.session,
                        sets = performed,
                        review = store.review(live.id),
                        // The account's own count and never the drawn one: a session deleted a
                        // moment ago is still on the log while its window runs, and the workout just
                        // finished is not the first.
                        isFirst = store.allSessions.size <= 1,
                    )
                }
                is FinishOutcome.Stranded ->
                    note = "${Readout.setCount(ended.count)} still on this device — the session stays open until they land"
                is FinishOutcome.Failed ->
                    note = ended.why.line("the session is still open")
            }
        }
    }

    // THE act, behind all three of its doors: the finish receipt, the log row's long press and the
    // session review screen. A withheld delete and not a dialog — Law 2 gives a destructive act an
    // undo, never a confirmation. Nothing is told for nine seconds, so the screen leaves at once and
    // the row is off the log while the window is open. A review screen for a session the room no
    // longer has cannot stand, so it goes with it; the receipt is taken down by the door that
    // raised this, because a sheet comes down on its own animation.
    fun discard(sessionId: String) {
        note = null
        store.withhold(Deletion.Session(sessionId))
        if ((away.lastOrNull() as? Away.Session)?.summary?.id == sessionId) back()
    }

    // Asked from the room, not from the screen that draws it, so the coroutine and the answer outlive
    // a lifter walking away mid-wait. The door closes on the way IN, or two taps are two spends.
    fun ask(from: List<AskExchange>, question: String) {
        if (asking || !Ask.sendable(question)) return
        val asked = question.trim()
        // Minted before the send and kept whatever comes back, so a retry continues the same
        // conversation. It names the CONVERSATION and is not per-question idempotency, so nothing
        // here is ever re-sent on its own.
        val into = conversationId.ifEmpty { Ids.thread().also { conversationId = it } }
        asking = true
        conversation = from + AskExchange(question = asked)
        scope.launch {
            try {
                when (val outcome = store.ask(into, asked)) {
                    is AskOutcome.Answered ->
                        conversation = from + AskExchange(question = asked, answer = outcome.answer)
                    is AskOutcome.Refused ->
                        conversation = from + AskExchange(question = asked, trouble = outcome.said)
                    is AskOutcome.Capped -> {
                        conversation = from + AskExchange(question = asked, trouble = outcome.said)
                        cap = outcome.cap
                    }
                    is AskOutcome.Failed ->
                        conversation = from + AskExchange(
                            question = asked, trouble = outcome.said, again = true)
                    // The conversation is over and the question is fine: let go of the id and offer
                    // the tap, which opens a new conversation with the same question.
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

    // The live thread and its id are let go of; what was asked is on the log.
    fun askSomethingNew() {
        conversation = emptyList()
        conversationId = ""
        cap = null
        away = emptyList()
        receipts = emptyMap()
        tab = Tab.Coach
    }

    // The save lives here rather than on the builder: the builder's composition dies the moment the
    // draft is let go of. The door closes while one is in flight, or two taps are two routines.
    fun write(draft: RoutineDraft) {
        scope.launch {
            if (savingRoutine) return@launch
            savingRoutine = true
            try {
                note = null
                when (val written = store.saveRoutine(draft)) {
                    is GymResult.Failed -> note = written.why.line("${draft.name} wasn’t saved")
                    is GymResult.Ok -> {
                        haptics.saved()
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

    // Nothing is told for nine seconds, so the builder and the page beneath it leave at once and the
    // row is off the program while the window is open. The name is read BEFORE the withhold, because
    // the withhold is what takes the routine off every list this room reads.
    fun destroy(routineId: String) {
        val named = store.routine(routineId)?.name ?: return
        note = null
        store.withhold(Deletion.Routine(routineId, named))
        building = null
        away = emptyList()
        tab = Tab.Routines
    }

    // Nothing is claimed until the log says it was, and the door closes while one is in flight, or
    // two taps are two routines. The refusal is the RECEIPT's while the receipt still stands, drawn
    // under the Save that raised it because the sheet covers the bottom bar every other refusal in
    // the room lands in; once the receipt is gone that bar is the only place left to say it.
    fun keep(sets: List<TrainingSet>, name: String) {
        scope.launch {
            if (keepingRoutine) return@launch
            keepingRoutine = true
            try {
                finishFailure = null
                val kept = store.keep(sets, name)
                if (kept is GymResult.Failed) {
                    val why = kept.why.line("the routine wasn’t kept")
                    if (finished != null) finishFailure = why else note = why
                    return@launch
                }
                haptics.saved()
                keptRoutine = true
            } finally {
                keepingRoutine = false
            }
        }
    }

    // The origin comes from the account's own client.
    val origin = account.api.baseUrl.toString()
    val coach = remember(origin) { CoachDoors(origin, store::share, store::revokeShare) }
    val lookedAtIds = lookedAt.split(' ').filter { it.isNotEmpty() }.toSet()
    val clipboard = LocalClipboardManager.current

    // The log row's long press. The card inside the session mints the same link and says more about
    // it; from the row there is nothing to draw, so the transient carries the whole answer.
    fun shareWorkout(sessionId: String) {
        scope.launch {
            note = null
            when (val minted = store.share(sessionId)) {
                is GymResult.Ok -> {
                    clipboard.setText(AnnotatedString(Coach.link(minted.value, origin)))
                    transient.showSnackbar(
                        "Link copied — anyone who has it can read this workout",
                        duration = SnackbarDuration.Long,
                    )
                }
                is GymResult.Failed -> note = minted.why.line("the link wasn’t made")
            }
        }
    }

    // Over the conversation or the routines home, never a push. Closing it — swipe, scrim, back —
    // decides nothing: the proposal stays pending and its card reads `still waiting`.
    reviewing?.let { open ->
        ModalBottomSheet(
            onDismissRequest = {
                reviewing = null
                if (open.proposalId !in lookedAtIds) lookedAt = (lookedAtIds + open.proposalId).joinToString(" ")
            },
            sheetState = reviewSheet,
            containerColor = GymSkin.surface,
        ) {
            ReviewSheet(
                proposalId = open.proposalId,
                routineId = open.routineId,
                store = store,
                // Offered only where Coach itself is: an account, and a deployment that has one.
                onAsk = if (account.isSignedIn && !askAbsent) {
                    { about ->
                        closeReview()
                        look(Away.Coach("What would this change to $about do?"))
                    }
                } else {
                    null
                },
                onDecided = { settled ->
                    settled.receipt?.let { landReceipt(open.door, it) }
                    closeReview()
                },
            )
        }
    }

    // The receipt for the workout just closed, over the workout itself. Dismissing it — back, the
    // scrim, the handle — decides nothing and writes nothing: the session was closed and saved
    // before this rose, and what is underneath is its own detail page.
    finished?.let { ended ->
        ModalBottomSheet(
            onDismissRequest = {
                finished = null
                finishFailure = null
            },
            sheetState = finishSheet,
            containerColor = GymSkin.surface,
        ) {
            FinishScreen(
                finished = ended,
                catalog = store.catalog,
                kept = keptRoutine,
                coach = coach,
                onKeepRoutine = { name -> keep(ended.sets, name) },
                // Behind the sheet's own exit: the pop this runs takes the workout out from under
                // the receipt, and the rail would come back up through a sheet still descending.
                onDiscard = { closeFinish { discard(ended.session.id) } },
                onDone = { closeFinish() },
                failure = finishFailure,
            )
        }
    }

    val standing = away.lastOrNull()
    // What the way back leads to. Names are read off the store, so a rename moves this row too.
    val beneath = when (val under = away.getOrNull(away.size - 2)) {
        is Away.Session -> under.summary.plan?.routine ?: Readout.noRoutine
        is Away.Movement -> Readout.movement(under.exerciseId, store.catalog)
        is Away.Program -> store.routine(under.routineId)?.name ?: "Routines"
        is Away.Coach -> Ask.title
        Away.Threads -> Threads.title
        // The noun, not the thread's title: a title is the lifter's first message verbatim.
        is Away.Thread -> Threads.conversation
        Away.Settings -> "Settings"
        Away.Notes -> Notes.title
        is Away.NoteEditor -> Notes.title
        Away.Bodyweight -> Bodyweight.title
        null -> tab.title
    }
    val railUp = railStands(live, building != null, away.size)
    val youInitial = account.user?.email?.take(1) ?: ""

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = GymSkin.canvas,
        // The transient floats ABOVE the reach band rather than growing the bottom inset: the logger's
        // primary is pressed forty times a session, and a snackbar sitting on Log set would be a
        // nine-second lockout every time a set landed.
        snackbarHost = {
            SnackbarHost(
                transient,
                modifier = Modifier.padding(bottom = if (live) GymTap.primary + WindmillSpace.x4 else 0.dp),
            )
        },
        bottomBar = {
            val line = note
            // Nothing at all when there is neither: an empty bar would take the window inset away
            // from the content below it.
            if (railUp || line != null) {
                Column(Modifier.fillMaxWidth().background(GymSkin.canvas)) {
                    line?.let {
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
                    if (railUp) {
                        TabRail(
                            current = tab,
                            onPick = { picked ->
                                note = null
                                // Entering Coach again offers the composer; whether the allowance is
                                // back is the log's to say.
                                if (picked != tab) cap = null
                                tab = picked
                            },
                        )
                    } else {
                        Box(Modifier.fillMaxWidth().navigationBarsPadding())
                    }
                }
            }
        },
    ) { inner ->
        // Consumed as well as applied: a screen inside that pads itself for the keyboard would
        // otherwise count the navigation bar twice and leave a gap above the keys.
        Box(Modifier.fillMaxSize().padding(inner).consumeWindowInsets(inner)) {
            when {
                live -> LoggerScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    say = { note = it },
                    onFinish = { close() },
                    // The shell's door: gym draws no sign-in of its own.
                    onSignIn = LocalShellActions.current.openYou,
                )
                // A day being built outranks a tab and nothing else, and it covers the rail.
                building != null -> RoutineBuilder(
                    draft = building!!,
                    store = store,
                    saving = savingRoutine,
                    onDraft = { building = it },
                    onSave = { write(building!!) },
                    onClose = { building = null },
                    say = { note = it },
                )
                standing is Away.Movement -> RecordScreen(
                    exerciseId = standing.exerciseId,
                    store = store,
                    backTo = beneath,
                    onBack = { back() },
                )
                standing is Away.Settings -> SettingsScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    origin = origin,
                    backTo = beneath,
                    onBack = { back() },
                    onNotes = { look(Away.Notes) },
                    say = { note = it },
                )
                standing is Away.Notes -> NotesScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    backTo = beneath,
                    onBack = { back() },
                    onEdit = { held, seedTitle -> look(Away.NoteEditor(held, seedTitle)) },
                    onSignIn = LocalShellActions.current.openYou,
                    say = { note = it },
                )
                // The list beneath reads itself again on the way back: a saved note is on the list
                // because the log says so.
                standing is Away.NoteEditor -> NoteEditorScreen(
                    note = standing.note,
                    seedTitle = standing.seedTitle,
                    store = store,
                    backTo = beneath,
                    onBack = { back() },
                    onDone = { back() },
                )
                standing is Away.Session -> SessionScreen(
                    summary = standing.summary,
                    store = store,
                    coach = coach,
                    backTo = beneath,
                    onBack = { back() },
                    say = { note = it },
                    onOpenMovement = { look(Away.Movement(it)) },
                    onDiscard = { discard(standing.summary.id) },
                )
                standing is Away.Program -> RoutineScreen(
                    routineId = standing.routineId,
                    store = store,
                    isSignedIn = account.isSignedIn,
                    backTo = beneath,
                    onBack = { back() },
                    onStart = { routineId -> open(routineId) },
                    // The page stays underneath, so saving lands back on the routine it came from.
                    onBuild = { building = it },
                    onOpenMovement = { look(Away.Movement(it)) },
                    lookedAt = lookedAtIds,
                    onReview = { review(it.id, it.routineId, Reviewing.routines) },
                    // Drawn only where the log carries a thread id: the history row survives the
                    // conversation's deletion.
                    onOpenThread = { look(Away.Thread(it)) },
                )
                standing is Away.Bodyweight -> BodyweightScreen(
                    store = store,
                    backTo = beneath,
                    onBack = { back() },
                    say = { note = it },
                )
                standing is Away.Coach -> AskScreen(
                    store = store,
                    thread = conversation,
                    receipts = receipts[Reviewing.coach].orEmpty(),
                    lookedAt = lookedAtIds,
                    asking = asking,
                    cap = cap,
                    onAsk = { asked -> ask(conversation, asked) },
                    // Only the newest question is ever asked again: a retry further up would drop
                    // everything asked since.
                    onRetry = {
                        conversation.lastOrNull()?.let { ask(conversation.dropLast(1), it.question) }
                    },
                    onAskNew = { askSomethingNew() },
                    seed = standing.seed,
                    onThreads = { look(Away.Threads) },
                    onNotes = { look(Away.Notes) },
                    origin = origin,
                    backTo = beneath,
                    onBack = { back() },
                    onReview = { review(it.id, it.routineId, Reviewing.coach) },
                )
                standing is Away.Threads -> ThreadsScreen(
                    store = store,
                    backTo = beneath,
                    onBack = { back() },
                    onOpen = { look(Away.Thread(it)) },
                    onDelete = { store.withhold(Deletion.Thread(it)) },
                    onAskNew = { askSomethingNew() },
                )
                standing is Away.Thread -> ThreadScreen(
                    threadId = standing.threadId,
                    store = store,
                    receipts = receipts[Reviewing.thread(standing.threadId)].orEmpty(),
                    lookedAt = lookedAtIds,
                    backTo = beneath,
                    onBack = { back() },
                    onReview = { review(it.id, it.routineId, Reviewing.thread(standing.threadId)) },
                    say = { note = it },
                )
                tab == Tab.Log -> LogScreen(
                    store = store,
                    seat = youInitial,
                    onOpenSession = { look(Away.Session(it)) },
                    onOpenBodyweight = { look(Away.Bodyweight) },
                    onShareSession = { shareWorkout(it) },
                    onDiscardSession = { discard(it) },
                )
                // A tab cannot be absent the way a door can, so signed out and no-Coach each draw a
                // designed stance rather than a 401.
                tab == Tab.Coach && !account.isSignedIn ->
                    AskSignedOutStance(seat = youInitial, onSignIn = LocalShellActions.current.openYou)
                tab == Tab.Coach && askAbsent -> AskAbsentStance(seat = youInitial)
                tab == Tab.Coach -> AskScreen(
                    store = store,
                    thread = conversation,
                    receipts = receipts[Reviewing.coach].orEmpty(),
                    lookedAt = lookedAtIds,
                    asking = asking,
                    cap = cap,
                    onAsk = { asked -> ask(conversation, asked) },
                    onRetry = {
                        conversation.lastOrNull()?.let { ask(conversation.dropLast(1), it.question) }
                    },
                    onAskNew = { askSomethingNew() },
                    seed = "",
                    onThreads = { look(Away.Threads) },
                    onNotes = { look(Away.Notes) },
                    origin = origin,
                    backTo = null,
                    onBack = null,
                    seat = youInitial,
                    onReview = { review(it.id, it.routineId, Reviewing.coach) },
                )
                else -> RoutinesScreen(
                    store = store,
                    isSignedIn = account.isSignedIn,
                    lookedAt = lookedAtIds,
                    seat = youInitial,
                    // The only start home offers; a routine's own start lives on its detail page.
                    onJustStart = { open(null) },
                    onBuild = { building = it },
                    onOpenRoutine = { look(Away.Program(it)) },
                    onDeleteRoutine = { destroy(it) },
                    onReview = { review(it.id, it.routineId, Reviewing.routines) },
                    onOpenSettings = { look(Away.Settings) },
                    onSignIn = LocalShellActions.current.openYou,
                )
            }
        }
    }
}

// The platform's rail, three seats and no fourth: the account seat a hand-rolled rail could carry
// past a hairline now rides each root's top bar instead.
//
// Selection is carried on four channels, not on one colour (ledger `1v`). The tint is the room's
// BRIGHTEST ink, not its accent: iris `#9A90BE` against the faint ink `#8D8896` separates by 1.17:1
// and a lifter cannot tell which tab they are on, while `#EDEBF0` against the same faint ink is
// 2.91:1 — the same number iOS picked, so the two phones close `1v` on one token. Beneath that: a
// filled glyph selected against an outlined one, a bold label against a normal one, and the
// indicator on `lineStrong` (`#48444D` on the bar's `#262329`, 1.63:1 — the wash `accentSoft` was
// 1.06:1 and read as nothing).
@Composable
private fun TabRail(current: Tab, onPick: (Tab) -> Unit) {
    NavigationBar(containerColor = GymSkin.surface, tonalElevation = 0.dp) {
        Tab.entries.forEach { entry ->
            val here = entry == current
            NavigationBarItem(
                selected = here,
                onClick = { onPick(entry) },
                icon = { Icon(railIcon(entry, here), contentDescription = null) },
                label = {
                    Text(
                        entry.title,
                        maxLines = 1,
                        fontWeight = if (here) FontWeight.Bold else FontWeight.Normal,
                    )
                },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = GymSkin.ink,
                    selectedTextColor = GymSkin.ink,
                    indicatorColor = GymSkin.lineStrong,
                    unselectedIconColor = GymSkin.inkFaint,
                    unselectedTextColor = GymSkin.inkFaint,
                ),
            )
        }
    }
}

internal fun railIcon(tab: Tab, selected: Boolean): ImageVector = when (tab) {
    Tab.Routines -> if (selected) Icons.AutoMirrored.Filled.List else Icons.AutoMirrored.Outlined.List
    Tab.Log -> if (selected) Icons.Filled.DateRange else Icons.Outlined.DateRange
    Tab.Coach -> if (selected) Icons.Filled.Face else Icons.Outlined.Face
}
