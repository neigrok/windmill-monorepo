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
import kotlinx.coroutines.withTimeoutOrNull
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.Bodyweight
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
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.AskAbsentStance
import works.windmill.gym.ui.AskScreen
import works.windmill.gym.ui.AskSignedOutStance
import works.windmill.gym.ui.BodyweightScreen
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.GymSkin
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

// Back has five meanings on this surface and three of them are not pops, which is why the room
// decides them itself rather than handing the stack to a navigator.
internal enum class BackMeans {
    // The finish screen: the session is closed and this screen is the receipt for it.
    Nothing,
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
    finished: Boolean,
    live: Boolean,
    building: Boolean,
    away: Int,
    tab: Tab,
): BackMeans = when {
    finished -> BackMeans.Nothing
    live -> BackMeans.StayInTheWorkout
    building -> BackMeans.LeaveTheDraft
    away > 0 -> BackMeans.PopOnePushedScreen
    tab != Tab.Routines -> BackMeans.ReturnToTheRoutinesTab
    else -> BackMeans.LeaveTheApp
}

// The rail belongs to the three tabs and to nothing else: a live session, a finish, a draft and any
// pushed screen each take the whole frame, and a bar drawn empty would reserve height for nothing.
internal fun railStands(finished: Boolean, live: Boolean, building: Boolean, away: Int): Boolean =
    !finished && !live && !building && away == 0

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

// The three tabs, the live session, the finish screen, and the screens a tab can push. The shell
// owns the theme control and billing; its account seat rides the trailing slot of each root's own
// top bar, because a native rail has no fourth seat.
//
// A live session takes the whole screen, rail included; a pushed screen covers the rail too.
//
// A room's state dies when you leave it, store included: the queue is on disk after every tap and
// leaving flushes, or a set is refused once the session closes.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymRoom(account: Account) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember {
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

    var finished by remember { mutableStateOf<FinishedSession?>(null) }
    // A stack, not a slot: one pushed screen can reach another. NOT saved, so no screen is drawn
    // over a store that has not read the disk yet. The activity handles rotation itself
    // (`configChanges` in the manifest), so a recreation here means the process was reclaimed.
    var away by remember { mutableStateOf<List<Away>>(emptyList()) }
    var keptRoutine by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var savingRoutine by remember { mutableStateOf(false) }
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
    // The daily allowance ran out: the composer is down until the room is entered again, and the
    // log is the one that says whether the bucket has refilled. Saved: a recreation is not a re-entry,
    // so it must not hand the composer back mid-cap.
    var capped by rememberSaveable { mutableStateOf(false) }
    // The transient's host. A message with an action and a window lives here; the `note` slot below
    // stays for what is about the screen you are on and dies when you leave it.
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
    val means = backMeans(finished != null, live, building != null, away.size, tab)
    BackHandler(enabled = means != BackMeans.LeaveTheApp) {
        when (means) {
            BackMeans.Nothing, BackMeans.StayInTheWorkout, BackMeans.LeaveTheApp -> Unit
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

    // A withheld delete belongs to the screen the gesture was made on, so leaving it ends the window.
    val standingSession = (away.lastOrNull() as? Away.Session)?.summary?.id
    LaunchedEffect(standingSession) {
        if (store.withheld?.sessionId == standingSession) return@LaunchedEffect
        store.settleWithheld()?.let { note = it.line("that set is still on the log") }
    }

    // The window's own state, said for as long as the window is open and never a moment longer: the
    // span is the queue's `undoWindowMs` and never a snackbar default. The key is the TAKEABLE row,
    // so the instant a settle commits the delete to the wire — the effect above, or the timeout
    // below — this effect is cancelled and the transient goes down with it. An Undo offered over a
    // delete already sent would be a lie.
    val takeable = store.withheld?.takeIf { it.takeable }
    LaunchedEffect(takeable?.set?.id) {
        val holding = takeable ?: return@LaunchedEffect
        val left = holding.untilMs - System.currentTimeMillis()
        if (left <= 0) return@LaunchedEffect
        val decided = withTimeoutOrNull(left) {
            transient.showSnackbar(
                message = "Deleted ${Readout.effort(holding.set.weightKg, holding.set.reps)}",
                actionLabel = "Undo",
                duration = SnackbarDuration.Indefinite,
            )
        }
        if (decided == SnackbarResult.ActionPerformed) {
            // A tap that raced the send by a frame: the log has it, so say so rather than report a
            // keep that did not happen.
            if (!store.keepWithheld()) note = "that delete had already gone through — the set is off the log"
            return@LaunchedEffect
        }
        transient.currentSnackbarData?.dismiss()
        // The send outlives this effect: settling marks the row sent, which is this effect's own key.
        scope.launch { store.settleWithheld()?.let { note = it.line("that set is still on the log") } }
    }

    // ON_STOP is the second net behind ON_PAUSE. The dispose flush is launched UNSTRUCTURED: the
    // composition scope dies with the room and the drain it owes the log may not.
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
                // Owed sets first, withheld delete second: a set that never landed is refused forever
                // once its session closes, while a delete has no deadline.
                store.flushPendingSets(force = true)
                store.settleWithheld()
            }
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
                is FinishOutcome.Failed ->
                    note = ended.why.line("the session is still open")
            }
        }
    }

    // The screen only leaves once the log says the session is gone.
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
                        capped = true
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
        capped = false
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

    // The builder and the page beneath it both leave only once the log says the routine is gone.
    fun destroy(routineId: String) {
        scope.launch {
            note = null
            val failed = store.dropRoutine(routineId)
            if (failed != null) {
                note = failed.line("that routine is still in your program")
                return@launch
            }
            building = null
            away = emptyList()
            tab = Tab.Routines
        }
    }

    // Nothing is claimed until the log says it was.
    fun keep(sets: List<TrainingSet>, name: String) {
        scope.launch {
            note = null
            val kept = store.keep(sets, name)
            if (kept is GymResult.Failed) {
                note = kept.why.line("the routine wasn’t kept")
                return@launch
            }
            keptRoutine = true
        }
    }

    // The origin comes from the account's own client.
    val origin = account.api.baseUrl.toString()
    val coach = remember(origin) { CoachDoors(origin, store::share, store::revokeShare) }
    val lookedAtIds = lookedAt.split(' ').filter { it.isNotEmpty() }.toSet()

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

    val ended = finished
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
        Away.Settings -> "Gym"
        Away.Notes -> Notes.title
        is Away.NoteEditor -> Notes.title
        Away.Bodyweight -> Bodyweight.title
        null -> tab.title
    }
    val railUp = railStands(ended != null, live, building != null, away.size)
    val youInitial = account.user?.email?.take(1) ?: ""

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = GymSkin.canvas,
        snackbarHost = { SnackbarHost(transient) },
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
                                if (picked != tab) capped = false
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
                    onDelete = { destroy(it) },
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
                    capped = capped,
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
                    onAskNew = { askSomethingNew() },
                )
                standing is Away.Thread -> ThreadScreen(
                    threadId = standing.threadId,
                    store = store,
                    receipts = receipts[Reviewing.thread(standing.threadId)].orEmpty(),
                    lookedAt = lookedAtIds,
                    backTo = beneath,
                    onBack = { back() },
                    // The list reads itself again: a deleted conversation is gone because the log says
                    // so, never because this room crossed a row out.
                    onDeleted = { back() },
                    onReview = { review(it.id, it.routineId, Reviewing.thread(standing.threadId)) },
                    say = { note = it },
                )
                tab == Tab.Log -> LogScreen(
                    store = store,
                    seat = youInitial,
                    onOpenSession = { look(Away.Session(it)) },
                    onOpenBodyweight = { look(Away.Bodyweight) },
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
                    capped = capped,
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
