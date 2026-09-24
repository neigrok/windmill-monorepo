package works.windmill.gym

import works.windmill.platform.design.WindmillSheetWindow
import android.app.Activity
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.outlined.List
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import works.windmill.platform.net.WindmillJson
import works.windmill.gym.domain.SessionDetail
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.annotation.DrawableRes
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.Coach
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.domain.ConnectedLog
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
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.gym.ui.AskAbsentStance
import works.windmill.gym.ui.AskScreen
import works.windmill.gym.ui.AskSignedOutStance
import works.windmill.gym.ui.BodyweightScreen
import works.windmill.gym.ui.ConnectedLogScreen
import works.windmill.gym.ui.FinishCoach
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.ui.LocalGymColors
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
import works.windmill.gym.notification.WorkoutNotifications
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import android.Manifest
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import works.windmill.gym.ui.routineDraftSaver
import works.windmill.platform.you.YouDestination
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.AccountActions
import works.windmill.platform.ProductModule
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

// Gym's one seam into the superapp.
class GymModule(private val store: TrainingStore, private val notifications: WorkoutNotifications? = null) : ProductModule {
    override val id = "gym"
    override val label = "Gym"

    @Composable
    override fun Skin(content: @Composable () -> Unit) {
        GymMaterial(content)
    }

    @Composable
    override fun Room(account: Account) {
        GymRoom(account, store, notifications)
    }
}

internal enum class Tab(val title: String) {
    Routines("Routines"),
    Log("Log"),
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
    // The logger's gear pushes settings over the workout; back pops that and the workout is still
    // there underneath.
    live && away == 0 -> BackMeans.StayInTheWorkout
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
@Serializable
private sealed interface Away {
    @Serializable
    data class Session(val summary: SessionSummary, val detail: SessionDetail? = null) : Away
    @Serializable
    data class Movement(val exerciseId: String) : Away
    @Serializable
    data class Program(val routineId: String) : Away
    @Serializable
    data class Coach(val seed: String = "") : Away
    @Serializable
    data object Threads : Away
    @Serializable
    data class Thread(val threadId: String) : Away
    @Serializable
    data object Settings : Away
    @Serializable
    data object Connections : Away
    @Serializable
    data object Notes : Away
    @Serializable
    data class NoteEditor(val note: Note?, val seedTitle: String) : Away
    @Serializable
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
// The application owns the store; this room owns only navigation and transient UI state.

private fun awaySaver(telemetry: Telemetry) = Saver<List<Away>, String>(
    save = { WindmillJson.encodeToString(ListSerializer(Away.serializer()), it) },
    restore = { runCatching { WindmillJson.decodeFromString(ListSerializer(Away.serializer()), it) }
        .onFailure { telemetry.failure("gym.restoreNavigation", it) }.getOrDefault(emptyList()) },
)

private fun finishedSaver(telemetry: Telemetry) = Saver<FinishedSession?, String>(
    save = { it?.let { value -> WindmillJson.encodeToString(FinishedSession.serializer(), value) } ?: "" },
    restore = { raw -> raw.takeIf { it.isNotEmpty() }?.let {
        runCatching { WindmillJson.decodeFromString(FinishedSession.serializer(), it) }
            .onFailure { telemetry.failure("gym.restoreFinishedSession", it) }.getOrNull()
    } },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymRoom(account: Account, store: TrainingStore, notifications: WorkoutNotifications? = null) {
    val telemetry = LocalTelemetry.current
    val skin = LocalGymColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val shell = LocalShellActions.current
    val notificationPrefs = remember(context) { context.getSharedPreferences("workout-notifications", 0) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notifications?.refreshCapabilities()
    }

    // The committed detail survives process replacement after the queue closes.
    var finished by rememberSaveable(stateSaver = remember(telemetry) { finishedSaver(telemetry) }) { mutableStateOf<FinishedSession?>(null) }
    val currentAccount by rememberUpdatedState(account)
    var finishFailure by remember { mutableStateOf<String?>(null) }
    val finishStates = rememberSaveableStateHolder()
    var keepingRoutine by remember { mutableStateOf(false) }
    val finishSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { !keepingRoutine })
    // Whether the receipt is on its way down, so a second tap during the descent is one tap.
    var closingFinish by remember { mutableStateOf(false) }
    var away by rememberSaveable(stateSaver = remember(telemetry) { awaySaver(telemetry) }) { mutableStateOf<List<Away>>(emptyList()) }
    var keptRoutine by rememberSaveable { mutableStateOf<String?>(null) }
    var starting by remember { mutableStateOf(false) }
    var savingRoutine by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    // Which tab was open exists nowhere but here, so it is saved through `tabSaver`.
    var tab by rememberSaveable(stateSaver = tabSaver) { mutableStateOf(Tab.Routines) }
    // The review open over the room. NOT saved: it reads the log on the way in, and a recreation
    // mid-review lands back on the card, which decides nothing either.
    var reviewing by remember { mutableStateOf<Reviewing?>(null) }
    var reviewBusy by remember { mutableStateOf(false) }
    val reviewSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !reviewBusy })
    // Reviews opened and closed with nothing decided: their cards read `still waiting`. Saved as the
    // string it is, ids joined by a space.
    var lookedAt by rememberSaveable { mutableStateOf("") }
    // Receipts by the door they landed in. NOT saved and not stored anywhere: a receipt is derived
    // from the server's apply reply and vanishes with the screen, and nothing pretends otherwise.
    var receipts by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    // Lives here rather than on the screen that draws it: the ask outlives the screen. The log keeps
    // the turns and receipts; unanswered submissions also live in the account’s local journal.
    var conversation by rememberSaveable(stateSaver = remember(telemetry) { askThreadSaver(telemetry) }) {
        mutableStateOf(emptyList<AskExchange>())
    }
    // A half-typed routine exists nowhere but in memory, so the draft is saved and the builder is
    // drawn off it.
    var building by rememberSaveable(stateSaver = remember(telemetry) { routineDraftSaver(telemetry) }) {
        mutableStateOf<RoutineDraft?>(null)
    }
    // Which conversation the next question lands in; minted by this phone, empty until somebody asks.
    var conversationId by rememberSaveable { mutableStateOf("") }
    var conversationSeed by rememberSaveable { mutableStateOf("") }
    // Outlives the screen, because the request does.
    var asking by remember { mutableStateOf(false) }
    // Which seat the thread above belongs to; empty is the anonymous one. Saved with the thread.
    var seat by rememberSaveable { mutableStateOf(account.user?.id ?: "") }
    // Whether this room has met the lifter. NOT saved: `account.user` is null until /v1/me answers,
    // so the first frame of every launch looks like nobody signed in.
    var seatRead by remember { mutableStateOf(account.user != null) }
    val sessionStates = key(seat) { rememberSaveableStateHolder() }
    // This deployment has no Coach: a bare 404 from the route. Not remembered past the room's life.
    var askAbsent by rememberSaveable { mutableStateOf(false) }
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
        if (store.session != null) { note = "Finish this session"; return }
        reviewing = Reviewing(proposalId, routineId, door)
    }

    fun closeReview() {
        if (reviewBusy) return
        scope.launch { reviewSheet.hide() }.invokeOnCompletion { reviewing = null }
    }

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    // Whatever the door does next waits for the sheet to be off, or the room's own chrome redraws
    // itself under a sheet that is still coming down. ONE descent at a time, and the continuation
    // only on a descent that finished: a second `hide()` cancels the first through the sheet's own
    // mutex, and a cancelled job completes too — so without both guards a double tap would run the
    // door's continuation twice, the second wiping what the first had just begun.
    fun closeFinish(then: () -> Unit = {}) {
        if (closingFinish || keepingRoutine) return
        closingFinish = true
        scope.launch { finishSheet.hide() }.invokeOnCompletion { cause ->
            closingFinish = false
            if (cause != null) return@invokeOnCompletion
            finished?.let { finishStates.removeState(it.routineCreationId) }
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
    val screen = when {
        reviewing != null -> "proposal"
        finished != null -> "finish"
        building != null -> "routine_editor"
        away.isNotEmpty() -> when (away.last()) {
            is Away.Session -> "session"
            is Away.Movement -> "movement"
            is Away.Program -> "routine"
            is Away.Coach -> "coach"
            Away.Threads -> "threads"
            is Away.Thread -> "thread"
            Away.Settings -> "settings"
            Away.Connections -> "connections"
            Away.Notes -> "notes"
            is Away.NoteEditor -> "note_editor"
            Away.Bodyweight -> "bodyweight"
        }
        live -> "workout"
        else -> tab.name.lowercase()
    }
    LaunchedEffect(screen) { telemetry.event("gym_screen_viewed", mapOf("screen" to screen)) }

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
    val openDestination by rememberUpdatedState<(Away) -> Unit> { look(it) }
    val accountActions = remember(shell, store) {
        AccountActions(
            listOf(YouDestination("settings", "Gym settings") { openDestination(Away.Settings) },
                YouDestination("connections", "Connected log") { openDestination(Away.Connections) }),
            beforeSignIn = { user, flow -> store.approveSignIn(user.id, flow) },
            cancelSignIn = store::cancelClaimSignIn,
        )
    }
    SideEffect { shell.present(accountActions) }

    LaunchedEffect(store.workoutOpenRequest) {
        if (store.workoutOpenRequest > 0 && store.session != null) {
            away = emptyList()
            tab = Tab.Routines
        }
    }

    LaunchedEffect(account.user?.id, account.verified, account.resolved, account.identityRevision) {
        if (!account.resolved) return@LaunchedEffect
        // A conversation belongs to the seat it was had on. A bare `standing != seat` would be
        // wrong: this effect runs first at composition, when `account.user` is null for everybody.
        val standing = account.user?.id
        if (Ask.handedOver(seat, standing, seatRead) || (standing == null && seat.isNotEmpty())) {
            conversation = emptyList()
            conversationSeed = ""
            asking = false
            cap = null
            // The id goes with the words, or the next lifter's question lands in somebody else's
            // conversation.
            conversationId = ""
            seat = standing ?: ""
            receipts = emptyMap()
            finished = null
            building = null
            reviewing = null
            finishFailure = null
            note = null
            away = emptyList()
        }
        if (standing != null) seatRead = true
        // The thread is saved and the request is not, so a recreation mid-answer restores a question
        // with nothing coming.
        conversation = Ask.settled(conversation)
        store.connect(account)
        if (conversationId.isEmpty() && standing != null) {
            try {
                store.pendingQuestions().lastOrNull()?.let { pending ->
                    conversationId = pending.thread
                    val read = store.thread(pending.thread)
                    conversation = if (read is GymResult.Ok) read.value.exchanges() else emptyList()
                    if (read !is GymResult.Ok || read.value.generation?.requestId != pending.requestId) {
                        conversation = conversation + store.pendingExchange(pending)
                    }
                    conversation = Ask.settled(conversation)
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (failure: Exception) { telemetry.failure("gym.restoreConversation", failure) }
        }
    }

    // LEAVING KEEPS THE WINDOW. The transient is the room's and follows the lifter through every pop,
    // tab change and sheet; the clock that closes a window is the store's own, one per delete, so a
    // screen going away settles nothing.
    //
    // Said for as long as a way back is open and never a moment longer: the span is the store's
    // `undoWindowMs` and never a snackbar default, and the store says how much is left — the room
    // reads no clock of its own. The key is everything that could change what is offered, so the
    // instant a settle commits a delete to the wire, or a second delete joins the window, this effect
    // is cancelled and the transient is redrawn for what is left. An Undo offered over a delete
    // already sent is a lie.
    val takeable = store.holding
    LaunchedEffect(takeable?.subjectId, store.withheld.size) {
        val said = Withheld.line(store.withheld) ?: return@LaunchedEffect
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

    // ON_STOP is the second net behind ON_PAUSE: owed sets go out and held deletes, which are the
    // room's alone, are let go.
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
                if (notifications != null && Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                    !notificationPrefs.getBoolean("requested", false)) {
                    notificationPrefs.edit().putBoolean("requested", true).apply()
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                val movement = LiveOrder.resume(store.order, store.sets) ?: return@launch
                store.choose(movement)
            } finally {
                starting = false
            }
        }
    }

    fun close() {
        scope.launch {
            val owner = currentAccount.user?.id
            note = null
            when (val ended = store.finish()) {
                is FinishOutcome.Closed -> {
                    if (owner != currentAccount.user?.id) return@launch
                    haptics.finished()
                    keptRoutine = null
                    finishFailure = null
                    away = listOf(Away.Session(SessionSummary(ended.detail.session, ended.detail.sets), ended.detail))
                    pruneReceipts()
                    finished = FinishedSession(ended.detail.session, ended.detail.sets, review = null,
                        isFirst = store.allSessions.size <= 1, routinePosition = store.allRoutines.size, reviewRead = false)
                }
                is FinishOutcome.Stranded ->
                    note = "${Readout.setCount(ended.count)} still on this device — the session stays open until they land"
                is FinishOutcome.Failed ->
                    note = ended.why.line("the session is still open")
            }
        }
    }

    val receipt = finished?.let { store.retainedSession(SessionDetail(it.session, it.sets)) }
    LaunchedEffect(receipt, account.resolved) {
        if (!account.resolved || account.user?.id.orEmpty() != seat) return@LaunchedEffect
        val detail = receipt ?: return@LaunchedEffect
        finished = finished?.copy(session = detail.session, sets = detail.sets)
        if (away.isEmpty()) away = listOf(Away.Session(SessionSummary(detail.session, detail.sets), detail))
        val owner = currentAccount.user?.id
        val review = store.review(detail.session.id)
        if (owner == currentAccount.user?.id && receipt?.session?.id == detail.session.id) {
            finished = finished?.copy(review = review, reviewRead = true)
        }
    }

    // THE act, behind both of its doors: the log row's long press and the session review screen. A
    // withheld delete and not a dialog — Law 2 gives a destructive act an undo, never a
    // confirmation. Nothing is told for nine seconds, so the screen leaves at once and the row is
    // off the log while the window is open. A review screen for a session the room no longer has
    // cannot stand, so it goes with it.
    fun discard(sessionId: String) {
        note = null
        store.withhold(Deletion.Session(sessionId))
        if ((away.lastOrNull() as? Away.Session)?.summary?.id == sessionId) back()
    }

    // Asked from the room, not from the screen that draws it, so the coroutine and the answer outlive
    // a lifter walking away mid-wait. The door closes on the way IN, or two taps are two spends.
    var coachJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    var coachUpload by remember { mutableStateOf<Float?>(null) }
    var stopPending by remember { mutableStateOf(false) }
    fun ask(from: List<AskExchange>, question: String, requestId: String = Ids.thread(), photo: CoachAttachment? = null) {
        if (asking || Ask.needsNew(from) || (!Ask.sendable(question) && (photo == null || question.toByteArray().size > Ask.maxTurnBytes))) return
        val askingOwner = currentAccount.user?.id
        val asked = question.trim()
        // Minted before the send and kept whatever comes back, so a retry continues the same
        // conversation. Each question also retains its own request ID for retries.
        val into = conversationId.ifEmpty { Ids.thread().also { conversationId = it } }
        val previous = conversation.lastOrNull()?.takeIf { it.requestId == requestId }
        val attachments = previous?.attachments.orEmpty().ifEmpty { listOfNotNull(photo) }
        val pending = AskExchange(question = asked, requestId = requestId, generation = previous?.generation, attachments = attachments)
        try {
            store.saveCoachDraft(into, CoachDraft(asked, attachments.firstOrNull()))
            store.saveCoachDraft("new", CoachDraft())
        } catch (_: Exception) { note = "Your message couldn’t be saved. Try again."; return }
        cap = null
        asking = true
        coachUpload = if (attachments.isNotEmpty() && previous?.generation == null) 0f else null
        conversation = from + pending
        coachJob = scope.launch {
            try {
                val outcome = store.ask(into, asked, requestId, attachments.firstOrNull(), stream = true,
                    onSnapshot = { snapshot ->
                        if (askingOwner == currentAccount.user?.id && conversationId == into) {
                            conversation = from + snapshot.exchange().copy(attachments = snapshot.attachments.ifEmpty { attachments })
                            store.saveCoachDraft(into, CoachDraft())
                        }
                    }, onUpload = { coachUpload = it })
                if (askingOwner != currentAccount.user?.id || conversationId != into) return@launch
                conversation = from + outcome.exchange(pending)
                if (outcome is AskOutcome.Capped) cap = outcome.cap
                if (outcome is AskOutcome.Absent) askAbsent = true
                if (outcome is AskOutcome.Answered) store.saveCoachDraft(into, CoachDraft())
            } finally {
                if (askingOwner == currentAccount.user?.id && conversationId == into) { asking = false; coachUpload = null; stopPending = false }
            }
        }
    }

    fun stopCoach() {
        if (stopPending) return
        val last = conversation.lastOrNull() ?: return
        if (coachUpload != null) {
            coachJob?.cancel()
            conversation = conversation.dropLast(1) + last.copy(trouble = "Upload cancelled. Retry to send this photo.", again = true)
            return
        }
        val into = conversationId
        val askingOwner = currentAccount.user?.id
        stopPending = true
        scope.launch {
            try {
                val snapshot = store.stopAsk(into, last.requestId)
                if (askingOwner == currentAccount.user?.id && conversationId == into) {
                    conversation = conversation.dropLast(1) + snapshot.exchange()
                    if (snapshot.terminal) { store.saveCoachDraft(into, CoachDraft()); coachJob?.cancel(); asking = false }
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { note = "The stop request didn’t reach Coach. Try again." }
            finally { stopPending = false }
        }
    }

    LaunchedEffect(conversationId, conversation.lastOrNull()?.generation?.id) {
        val last = conversation.lastOrNull()
        if (!asking && last?.generation?.status == "running") {
            ask(conversation.dropLast(1), last.question, last.requestId, last.attachments.firstOrNull())
        }
    }

    // The live thread and its id are let go of; what was asked is on the log.
    fun askSomethingNew(draft: String = "") {
        if (asking) return
        try { store.abandonCoach(conversationId.ifEmpty { "new" }) }
        catch (_: Exception) { note = "Your draft couldn’t be cleared. Try again."; return }
        conversationSeed = draft
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
        if (savingRoutine) return
        val prepared = if (draft.id == null && draft.creationId == null) draft.copy(creationId = Ids.routine()) else draft
        building = prepared
        savingRoutine = true
        scope.launch {
            try {
                note = null
                when (val written = store.saveRoutine(prepared)) {
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
    fun keep(sets: List<TrainingSet>, name: String, creationId: String, position: Int) {
        if (keepingRoutine) return
        keepingRoutine = true
        scope.launch {
            val owner = currentAccount.user?.id
            try {
                finishFailure = null
                val kept = store.keep(sets, name, creationId, position)
                if (owner != currentAccount.user?.id) return@launch
                if (kept is GymResult.Failed) {
                    val why = kept.why.line("the routine wasn’t kept")
                    if (finished != null) finishFailure = why else note = why
                    return@launch
                }
                haptics.saved()
                keptRoutine = (kept as GymResult.Ok).value.name
            } finally {
                keepingRoutine = false
            }
        }
    }

    key(seat) {
        if (account.resolved && account.user?.id.orEmpty() == seat) {
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
                        if (reviewBusy) return@ModalBottomSheet
                        reviewing = null
                        if (open.proposalId !in lookedAtIds) lookedAt = (lookedAtIds + open.proposalId).joinToString(" ")
                    },
                    sheetState = reviewSheet,
                    properties = androidx.compose.material3.ModalBottomSheetProperties(shouldDismissOnBackPress = !reviewBusy),
                    containerColor = skin.surface,
                    scrimColor = skin.scrim,
                ) {
                    WindmillSheetWindow()
                    ReviewSheet(
                        onBusy = { reviewBusy = it },
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
            finished?.let { original ->
                val canonical = store.retainedSession(SessionDetail(original.session, original.sets))
                val ended = original.copy(session = canonical.session,
                    sets = canonical.sets.filterNot { it.id in store.withheldIds || it.id in store.deletedSets })
                ModalBottomSheet(
                    onDismissRequest = {
                        if (keepingRoutine) return@ModalBottomSheet
                        finishStates.removeState(original.routineCreationId)
                        finished = null
                        finishFailure = null
                    },
                    sheetState = finishSheet,
                    containerColor = skin.surface,
                    scrimColor = skin.scrim,
                ) {
                    WindmillSheetWindow()
                    finishStates.SaveableStateProvider(original.routineCreationId) {
                    FinishScreen(
                        finished = ended,
                        catalog = store.catalog,
                        keptName = keptRoutine,
                        onKeepRoutine = { name -> keep(ended.sets, name, original.routineCreationId, original.routinePosition) },
                        pending = keepingRoutine,
                        // Offered only where Coach itself is: an account, and a deployment that has one.
                        // Behind the sheet's own exit, because the tab switch redraws the rail and it would
                        // come back up through a sheet still descending. Then a FRESH conversation, and the
                        // one line through the same send a typed question takes — so the thread is titled
                        // by it, the ceilings count it, and every refusal is drawn by the exchange itself.
                        // Behind an ask still in flight nothing is reset and nothing is sent: `ask` would
                        // drop the line on the floor, so the tap lands on the Coach tab where the stalled
                        // exchange is already drawn waiting.
                        onShareWithCoach = if (account.isSignedIn && !askAbsent) {
                            {
                                closeFinish {
                                    if (asking) {
                                        away = emptyList()
                                        tab = Tab.Coach
                                        return@closeFinish
                                    }
                                    askSomethingNew()
                                    ask(from = emptyList(), question = FinishCoach.question)
                                }
                            }
                        } else {
                            null
                        },
                        failure = finishFailure ?: store.retainedSessionFailure(canonical)?.line("the log couldn’t keep this workout"),
                    )
                    }
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
                Away.Settings -> "Gym settings"
                Away.Connections -> ConnectedLog.title
                Away.Notes -> Notes.title
                is Away.NoteEditor -> Notes.title
                Away.Bodyweight -> Bodyweight.title
                null -> if (live) store.session?.plan?.routine ?: Readout.noRoutine else tab.title
            }
            val railUp = railStands(live, building != null, away.size)
            val youInitial = account.user?.email?.take(1) ?: ""
            val loggerTransient = live && standing == null

            Scaffold(
                modifier = Modifier.fillMaxSize(),
                containerColor = skin.canvas,
                bottomBar = {
                    val line = note
                    if (railUp || line != null || !loggerTransient) {
                        Column(Modifier.fillMaxWidth().background(skin.canvas)) {
                            // Reserve the transient's measured height below screen-owned actions.
                            if (!loggerTransient) SnackbarHost(transient)
                            line?.let {
                                Text(
                                    it,
                                    style = GymType.numeral(12),
                                    color = skin.inkDim,
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
                        // A screen pushed from the logger's gear stands over the workout; the logger is what
                        // stands while nothing is pushed.
                        live && standing == null -> LoggerScreen(
                            store = store,
                            isSignedIn = account.isSignedIn,
                            say = { note = it },
                            onFinish = { close() },
                            // The shell's door: gym draws no sign-in of its own.
                            onSignIn = { shell.openSignIn(null) },
                            onSettings = { look(Away.Settings) },
                            transient = transient,
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
                            notifications = notifications,
                            store = store,
                            isSignedIn = account.isSignedIn,
                            backTo = beneath,
                            onBack = { back() },
                            onNotes = { look(Away.Notes) },
                            onConnectedLog = { look(Away.Connections) },
                            accountEmail = account.user?.email,
                            onAccount = shell.openYou,
                            onClaimSignIn = shell.openSignIn,
                            say = { note = it },
                        )
                        standing is Away.Connections -> ConnectedLogScreen(
                            store = store,
                            isSignedIn = account.isSignedIn,
                            origin = origin,
                            backTo = beneath,
                            onBack = { back() },
                            onSignIn = { shell.openSignIn(null) },
                        )
                        standing is Away.Notes -> NotesScreen(
                            store = store,
                            isSignedIn = account.isSignedIn,
                            backTo = beneath,
                            onBack = { back() },
                            onEdit = { held, seedTitle -> look(Away.NoteEditor(held, seedTitle)) },
                            onSignIn = { shell.openSignIn(null) },
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
                        standing is Away.Session -> sessionStates.SaveableStateProvider(standing.summary.id) {
                        SessionScreen(
                            summary = standing.summary,
                            seed = standing.detail,
                            store = store,
                            coach = coach,
                            backTo = beneath,
                            onBack = { back() },
                            say = { note = it },
                            onOpenMovement = { look(Away.Movement(it)) },
                            onDiscard = { discard(it) },
                        )
                        }
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
                            conversationId = conversationId,
                            onOpenRoutine = { look(Away.Program(it)) },
                            receipts = receipts[Reviewing.coach].orEmpty(),
                            lookedAt = lookedAtIds,
                            asking = asking,
                            cap = cap,
                            onAsk = { asked -> ask(conversation, asked) },
                            onPhotoAsk = { asked, photo -> ask(conversation, asked, photo = photo) },
                            onStop = ::stopCoach, upload = coachUpload,
                            // Only the newest question is ever asked again: a retry further up would drop
                            // everything asked since.
                            onRetry = {
                                conversation.lastOrNull()?.let { ask(conversation.dropLast(1), it.question, it.requestId.ifEmpty { Ids.thread() }, it.attachments.firstOrNull()) }
                            },
                            onAskNew = { askSomethingNew() },
                            seed = conversationSeed.ifEmpty { standing.seed },
                            onNewDraft = { askSomethingNew(it) },
                            onThreads = { look(Away.Threads) },
                            onConnections = { look(Away.Connections) },
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
                            onAskNew = { askSomethingNew() },
                            store = store,
                            origin = origin,
                            onThreads = { look(Away.Threads) },
                            onNotes = { look(Away.Notes) },
                            onConnections = { look(Away.Connections) },
                            onOpenRoutine = { look(Away.Program(it)) },
                            receipts = receipts[Reviewing.thread(standing.threadId)].orEmpty(),
                            lookedAt = lookedAtIds,
                            backTo = beneath,
                            onBack = { back() },
                            onReview = { review(it.id, it.routineId, Reviewing.thread(standing.threadId)) },
                            say = { note = it },
                        )
                        tab == Tab.Log -> sessionStates.SaveableStateProvider("log") { LogScreen(
                            store = store,
                            seat = youInitial,
                            onOpenSession = { look(Away.Session(it)) },
                            onOpenBodyweight = { look(Away.Bodyweight) },
                            onOpenMovement = { look(Away.Movement(it)) },
                            onShareSession = { shareWorkout(it) },
                            onDiscardSession = { discard(it) },
                        ) }
                        // A tab cannot be absent the way a door can, so signed out and no-Coach each draw a
                        // designed stance rather than a 401.
                        tab == Tab.Coach && !account.isSignedIn ->
                            AskSignedOutStance(seat = youInitial, onSignIn = { shell.openSignIn(null) })
                        tab == Tab.Coach && askAbsent -> AskAbsentStance(seat = youInitial, onNotes = { look(Away.Notes) }, onConnections = { look(Away.Connections) })
                        tab == Tab.Coach -> AskScreen(
                            store = store,
                            thread = conversation,
                            conversationId = conversationId,
                            onOpenRoutine = { look(Away.Program(it)) },
                            receipts = receipts[Reviewing.coach].orEmpty(),
                            lookedAt = lookedAtIds,
                            asking = asking,
                            cap = cap,
                            onAsk = { asked -> ask(conversation, asked) },
                            onPhotoAsk = { asked, photo -> ask(conversation, asked, photo = photo) },
                            onStop = ::stopCoach, upload = coachUpload,
                            onRetry = {
                                conversation.lastOrNull()?.let { ask(conversation.dropLast(1), it.question, it.requestId.ifEmpty { Ids.thread() }, it.attachments.firstOrNull()) }
                            },
                            onAskNew = { askSomethingNew() },
                            seed = conversationSeed,
                            onNewDraft = { askSomethingNew(it) },
                            onThreads = { look(Away.Threads) },
                            onConnections = { look(Away.Connections) },
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
                            onSignIn = { shell.openSignIn(null) },
                        )
                    }
                }
            }
        } else {
            Box(Modifier.fillMaxSize().background(skin.canvas))
        }
    }
}

@Composable
private fun TabRail(current: Tab, onPick: (Tab) -> Unit) {
    val skin = LocalGymColors.current
    Column(Modifier.fillMaxWidth().background(skin.surface)) {
        NavigationBar(
            containerColor = skin.surface,
            tonalElevation = 0.dp,
            windowInsets = WindowInsets(0, 0, 0, 0),
            modifier = Modifier.height(80.dp).padding(horizontal = 12.dp),
        ) {
            Tab.entries.forEach { entry ->
                NavigationBarItem(
                    selected = entry == current,
                    onClick = { onPick(entry) },
                    icon = { Icon(painterResource(railIcon(entry)), contentDescription = null, modifier = Modifier.size(24.dp)) },
                    label = { Text(entry.title, maxLines = 1, style = WindmillFont.body(12, FontWeight.Bold)) },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = skin.accent,
                        selectedTextColor = skin.ink,
                        indicatorColor = skin.raised,
                        unselectedIconColor = skin.inkDim,
                        unselectedTextColor = skin.inkDim,
                    ),
                )
            }
        }
        Box(Modifier.fillMaxWidth().background(skin.canvas).navigationBarsPadding())
    }
}

@DrawableRes
internal fun railIcon(tab: Tab): Int = when (tab) {
    Tab.Routines -> R.drawable.gym_nav_routines
    Tab.Log -> R.drawable.gym_nav_log
    Tab.Coach -> R.drawable.gym_nav_coach
}
