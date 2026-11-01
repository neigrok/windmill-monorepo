package works.windmill.gym

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.view.accessibility.AccessibilityManager
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import kotlin.math.ceil
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
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
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import works.windmill.platform.design.WindmillSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import works.windmill.platform.net.WindmillJson
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.gym.ui.WorkoutBar
import works.windmill.gym.presentation.SessionDetail
import androidx.compose.runtime.rememberCoroutineScope
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.annotation.DrawableRes
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.withTimeoutOrNull
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.AskCap
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.coach.onboarding.AnonymousCoachAccess
import works.windmill.gym.sharing.WorkoutSharing
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.presentation.Ids
import works.windmill.gym.presentation.LiveOrder
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.Seat
import works.windmill.gym.store.FinishReceipts
import works.windmill.gym.ui.WorkoutDiscardDialog
import works.windmill.gym.ui.WorkoutDiscardPrompt
import works.windmill.gym.store.WriteFailure
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.gym.coach.AskAbsentStance
import works.windmill.gym.coach.AskScreen
import works.windmill.gym.coach.CoachAccessStance
import works.windmill.gym.ui.BodyweightScreen
import works.windmill.gym.ui.ConnectedLogScreen
import works.windmill.gym.ui.FinishCoach
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.ui.GymChrome
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.LocalGymColors
import works.windmill.gym.ui.GymSnackbarHost
import works.windmill.gym.ui.GymNativeType
import works.windmill.gym.ui.PhoneRecovery
import works.windmill.gym.ui.OnThisPhoneScreen
import works.windmill.gym.ui.WorkoutInspectScreen
import works.windmill.gym.ui.WorkoutFixScreen
import works.windmill.gym.ui.RecoveryBinding
import works.windmill.gym.ui.LogScreen
import works.windmill.gym.ui.LoggerScreen
import works.windmill.gym.ui.NoteEditorScreen
import works.windmill.gym.ui.NotesScreen
import works.windmill.gym.ui.RecordScreen
import works.windmill.gym.ui.ReviewBinding
import works.windmill.gym.ui.ReviewSheet
import works.windmill.gym.ui.RoutineBuilder
import works.windmill.gym.ui.RoutineBuilderBinding
import works.windmill.gym.ui.RoutineSheet
import works.windmill.gym.ui.RoutinesBinding
import works.windmill.gym.ui.RoutinesScreen
import works.windmill.gym.ui.rememberGymHaptics
import works.windmill.gym.ui.SessionBinding
import works.windmill.gym.ui.SessionScreen
import works.windmill.gym.coach.ThreadScreen
import works.windmill.gym.coach.ThreadsScreen
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
import works.windmill.platform.ProductModule
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

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

private fun finishedSaver(telemetry: Telemetry) = Saver<FinishedSession?, String>(
    save = { it?.let { value -> WindmillJson.encodeToString(FinishedSession.serializer(), value) } ?: "" },
    restore = { raw -> raw.takeIf { it.isNotEmpty() }?.let {
        runCatching { WindmillJson.decodeFromString(FinishedSession.serializer(), it) }
            .onFailure { telemetry.failure("gym.restoreFinishedSession", it) }.getOrNull()
    } },
)

// The three tabs, the live session, and the screens a tab can push — the finish receipt is a sheet
// over one of those, not an arm of this. The shell owns the theme control and billing; its account
// seat rides the trailing slot of each root's own top bar, because a native rail has no fourth seat.
//
// The visible logger takes the whole screen; hidden workouts leave the tab roots available.
//
// The application owns the store; this room owns its navigator, the frames `GymStage` moves between,
// and transient UI state.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymRoom(account: Account, store: TrainingStore, notifications: WorkoutNotifications? = null,
    routineSaveContext: CoroutineContext = EmptyCoroutineContext) {
    val telemetry = LocalTelemetry.current
    val skin = LocalGymColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val shell = LocalShellActions.current
    val finishReceipts = remember(context, telemetry) { FinishReceipts(context.getSharedPreferences("gym-receipts", 0), telemetry) }
    var queuedFinishShare by rememberSaveable { mutableStateOf<String?>(null) }
    var queuedFinishShareOwner by rememberSaveable { mutableStateOf<String?>(null) }
    var finishShareReady by rememberSaveable { mutableStateOf(false) }
    var discardPrompt by remember { mutableStateOf<WorkoutDiscardPrompt?>(null) }
    var discarding by remember { mutableStateOf(false) }
    val notificationPrefs = remember(context) { context.getSharedPreferences("workout-notifications", 0) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notifications?.refreshCapabilities()
    }

    // The committed detail survives process replacement after the workout closes.
    var finished by rememberSaveable(stateSaver = remember(telemetry) { finishedSaver(telemetry) }) { mutableStateOf<FinishedSession?>(null) }
    val currentAccount by rememberUpdatedState(account)
    val finishStates = rememberSaveableStateHolder()
    val finishSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // Whether the receipt is on its way down, so a second tap during the descent is one tap.
    var closingFinish by remember { mutableStateOf(false) }
    val navigator = rememberGymNavigator(telemetry)
    var selectedRoutineId by rememberSaveable { mutableStateOf<String?>(null) }
    var starting by remember { mutableStateOf(false) }
    var savingRoutine by remember { mutableStateOf(false) }
    var routineSaveAttempt by remember { mutableStateOf<Any?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var initialTabChosen by rememberSaveable { mutableStateOf(false) }
    fun chooseTab(next: Tab) {
        initialTabChosen = true
        navigator.choose(next)
    }
    var pushedDraftOpen by remember { mutableStateOf(false) }
    // The review open over the room. NOT saved: it reads the log on the way in, and a recreation
    // mid-review lands back on the card, which decides nothing either.
    var reviewing by remember { mutableStateOf<Reviewing?>(null) }
    var reviewBusy by remember { mutableStateOf(false) }
    val reviewSheet = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !reviewBusy })
    // Reviews opened and closed with nothing decided: their cards read `still waiting`. Saved as the
    // string it is, ids joined by a space.
    var lookedAt by rememberSaveable { mutableStateOf("") }
    // The room keeps shown receipts with their doors; unseen removal receipts live in the replica.
    var receipts by remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    val conversationId = store.coach.selectedChatId.orEmpty()
    val selectedChat = store.coach.chat(conversationId)
    val conversation = selectedChat?.exchanges.orEmpty()
    val asking = store.coach.isAsking(conversationId)
    val coachUpload = store.coach.upload(conversationId)
    val cap = AskCap.entries.firstOrNull { it.name == selectedChat?.cap }
    val anonymousCoachAccess = store.coach.anonymousAccess
    LaunchedEffect(account.identityRevision, store.coach.accountKey, navigator.tab, navigator.away.lastOrNull()) {
        if (account.isSignedIn || !initialTabChosen || navigator.tab == Tab.Coach || navigator.away.lastOrNull() is Away.Coach || navigator.away.lastOrNull() is Away.Thread)
            store.coach.refreshAnonymousAccess()
    }
    // A half-typed routine exists nowhere but in memory, so the draft is saved and the builder is
    // drawn off it.
    var building by rememberSaveable(stateSaver = remember(telemetry) { routineDraftSaver(telemetry) }) {
        mutableStateOf<RoutineDraft?>(null)
    }
    // Which seat the thread above belongs to; empty is the anonymous one. Saved with the thread.
    var seat by rememberSaveable { mutableStateOf(account.user?.id ?: "") }
    // Whether this room has met the lifter. NOT saved: `account.user` is null until /v1/me answers,
    // so the first frame of every launch looks like nobody signed in.
    var seatRead by remember { mutableStateOf(account.user != null) }
    val sessionStates = key(seat) { rememberSaveableStateHolder() }
    val askAbsent = selectedChat?.absent == true
    // The room's one haptic vocabulary, used for the acts the room itself owns: a finish, and a save
    // the room performs on a screen's behalf.
    val haptics = rememberGymHaptics()
    // The transient's host. A message with an action and a window lives here; the `note` slot below
    // stays for what is about the screen you are on and dies when you leave it. The two are NOT
    // interchangeable: `note` clears on every navigation, which is exactly what a window must not do.
    val transient = remember { SnackbarHostState() }

    // A thread's receipts live exactly as long as that thread is on screen.
    fun pruneReceipts() {
        val standing = (navigator.away.lastOrNull() as? Away.Thread)?.let { Reviewing.thread(it.threadId) }
        receipts = receipts.filterKeys { it == Reviewing.coach || it == standing }
    }

    // The note is about the screen you are ON, so every move between destinations clears it.
    fun look(at: Away) {
        note = null
        if (at is Away.Coach) {
            try { store.coach.freshChat(at.seed) }
            catch (_: Exception) { note = "Your draft couldn’t be saved. Try again."; return }
        }
        navigator.push(at)
        pruneReceipts()
    }

    fun back() {
        note = null
        navigator.pop()
        pruneReceipts()
    }

    // Opened over whatever is standing; the door is where the receipt will land.
    fun review(proposalId: String, routineId: String, door: String) {
        if (store.workout.session != null) { note = "Finish this session"; return }
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
        if (closingFinish || queuedFinishShare != null) return
        if (finished == null) { then(); return }
        closingFinish = true
        scope.launch { finishSheet.hide() }.invokeOnCompletion { cause ->
            closingFinish = false
            if (cause != null) return@invokeOnCompletion
            finished?.let { finishStates.removeState(it.session.id) }
            finished = null
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

    val workout = store.workout.notification.collectAsState().value
    val liveSession = store.workout.session
    val live = liveSession != null
    val loggerShown = live && !store.workout.loggerHidden
    fun hideWorkout() {
        val result = workout?.key?.let { store.workout.setLoggerHidden(it, true) }
            ?: WorkoutChange.Unavailable(store.workout.workoutFailure ?: "The workout is not ready.")
        telemetry.event("gym_action", mapOf("screen" to "workout", "action" to "hide",
            "outcome" to if (result == WorkoutChange.Saved) "ok" else "refused"))
        if (result is WorkoutChange.Unavailable) note = result.reason
    }
    val screen = when {
        store.recovery.fixDraft != null -> "workout_fix"
        reviewing != null -> "proposal"
        finished != null -> "finish"
        building != null -> "routine_editor"
        selectedRoutineId != null -> "routine"
        navigator.away.isNotEmpty() -> navigator.away.last().screen
        loggerShown -> "workout"
        else -> navigator.tab.name.lowercase()
    }
    LaunchedEffect(screen) { telemetry.event("gym_screen_viewed", mapOf("screen" to screen)) }

    fun goBack(means: BackMeans) {
        when (means) {
            BackMeans.HideTheWorkout -> hideWorkout()
            BackMeans.LeaveTheApp -> Unit
            BackMeans.LeaveTheDraft -> building = null
            BackMeans.PopOnePushedScreen -> back()
            BackMeans.ReturnToTheRoutinesTab -> {
                note = null
                chooseTab(Tab.Routines)
            }
        }
    }

    // `connect` drains what the device is still holding BEFORE it reads the log: a read settles a
    // stale open session at its last activity, and past four hours from that close an owed set is
    // refused for good.
    val openDestination by rememberUpdatedState<(Away) -> Unit> { look(it) }
    val destinations = remember(shell, store) {
        listOf(YouDestination("notes", "Notes") { openDestination(Away.Notes) },
            YouDestination("connections", "Connected log") { openDestination(Away.Connections) })
    }
    SideEffect { shell.present(destinations) }

    LaunchedEffect(store.workout.workoutOpenRequest, workout?.key, store.seat.accountReady) {
        if (store.workout.workoutOpenRequest <= 0) return@LaunchedEffect
        val requested = store.workout.workoutOpenKey ?: return@LaunchedEffect
        if (store.seat.accountReady && workout?.key != requested) {
            store.workout.acknowledgeWorkoutRequest()
            return@LaunchedEffect
        }
        if (workout?.key == requested && store.workout.setLoggerHidden(requested, false) == WorkoutChange.Saved) {
            navigator.reset()
            selectedRoutineId = null
            store.workout.acknowledgeWorkoutRequest()
        }
    }

    LaunchedEffect(store.workout.routinesOpenRequest) {
        if (store.workout.routinesOpenRequest > 0) {
            note = null
            chooseTab(Tab.Routines)
            if (building == null && !savingRoutine && !pushedDraftOpen && reviewing == null && navigator.away.none { it is Away.NoteEditor }) {
                navigator.reset()
                selectedRoutineId = null
                pruneReceipts()
            }
            store.workout.acknowledgeRoutinesRequest()
        }
    }

    LaunchedEffect(account.user?.id, account.verified, account.resolved, account.identityRevision) {
        if (!account.resolved) return@LaunchedEffect
        // A conversation belongs to the seat it was had on. A bare `standing != seat` would be
        // wrong: this effect runs first at composition, when `account.user` is null for everybody.
        val standing = account.user?.id
        if (Ask.handedOver(seat, standing, seatRead) || (standing == null && seat.isNotEmpty())) {
            seat = standing ?: ""
            receipts = emptyMap()
            finished = null
            discardPrompt = null
            building = null
            routineSaveAttempt = null
            savingRoutine = false
            selectedRoutineId = null
            reviewing = null
            note = null
            navigator.reset()
        }
        if (standing != null) seatRead = true
        store.connect(account)
        try {
            store.coach.resumeChats()
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (failure: Exception) { telemetry.failure("gym.restoreConversation", failure) }

    }

    LaunchedEffect(account.user?.id, account.resolved, store.seat.accountReady) {
        if (account.resolved && store.seat.accountReady) account.user?.id?.let { store.coach.adoptPhoneDraft(it) }
    }

    // A phone draft moving into the account chooses its chat first; a fresh chat waits for it.
    LaunchedEffect(store.initialGymEmpty, account.resolved, store.coach.accountKey, store.coach.adoptingDraft, navigator.tab, navigator.away, building,
        selectedRoutineId, anonymousCoachAccess) {
        if (!account.resolved || store.coach.adoptingDraft) return@LaunchedEffect
        val empty = store.initialGymEmpty
        if (empty != null && store.coach.selectedChatId == null && (navigator.tab == Tab.Coach || navigator.away.lastOrNull() is Away.Coach)) {
            try { store.coach.freshChat(setup = empty) }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { note = "Your conversation couldn’t be saved. Try again." }
        }
        if (initialTabChosen) return@LaunchedEffect
        if (navigator.away.isNotEmpty() || building != null || selectedRoutineId != null) {
            initialTabChosen = true
            return@LaunchedEffect
        }
        if (empty == null) return@LaunchedEffect
        // Login is never forced: a signed-out empty Gym opens on Coach only while this phone can ask it.
        if (empty && store.coach.anonymous && anonymousCoachAccess == AnonymousCoachAccess.Checking) return@LaunchedEffect
        initialTabChosen = true
        if (!empty || store.coach.anonymous && anonymousCoachAccess != AnonymousCoachAccess.Available) return@LaunchedEffect
        try {
            if (store.coach.selectedChatId == null) store.coach.freshChat(setup = true)
            navigator.choose(Tab.Coach)
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { note = "Your conversation couldn’t be saved. Try again." }
    }

    // LEAVING KEEPS THE WINDOW. The transient is the room's and follows the lifter through every pop,
    // tab change and sheet; the clock that closes a window is the store's own, one per delete, so a
    // screen going away settles nothing.
    //
    // Said for as long as a way back is open and never a moment longer: the span is the store's
    // `undoWindowMs` and never a snackbar default, and the store says how much is left — the room
    // reads no clock of its own. The key is everything that could change what is offered, so the
    // instant a settle writes a delete, or a second delete joins the window, this effect
    // is cancelled and the transient is redrawn for what is left. An Undo offered over a delete
    // already sent is a lie.
    val takeable = store.deletions.holding
    LaunchedEffect(takeable?.subjectId, store.held.withheld.size) {
        val said = Withheld.line(store.held.withheld) ?: return@LaunchedEffect
        val left = store.deletions.wayBackLeftMs
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
            // A closed offer cannot promise that Undo restored the row.
            if (store.deletions.keepWithheld() == null && store.deletions.deleteRefused == null) {
                transient.showSnackbar(Withheld.alreadyGone, duration = SnackbarDuration.Short)
            }
            return@LaunchedEffect
        }
        transient.currentSnackbarData?.dismiss()
    }

    // The existing recovery band reports a failed hold or Undo once.
    LaunchedEffect(store.deletions.deleteRefused) {
        val refused = store.deletions.deleteRefused ?: return@LaunchedEffect
        // It takes the transient off whatever is standing there: a way back must never hide a
        // refusal, and another window's Undo is still offered when this one has been read.
        transient.currentSnackbarData?.dismiss()
        // SAID first, cleared afterwards, and the order is the whole of it: clearing it first
        // changes the key this effect is running under, and an effect that changes its own key
        // cancels itself — the sentence was never said, and a delete the log refused looked exactly
        // like one that worked. Cleared only once it HAS been said, so a room torn down mid-sentence
        // still owes it.
        transient.showSnackbar(refused, duration = SnackbarDuration.Long)
        store.deletions.clearDeleteRefused()
    }

    // Workout windows follow the room; durable weights follow the process.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val watcher = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                store.coach.refreshAnonymousAccess()
                // Read again on every return: the timeout is changed in system settings, away from here.
                store.deletions.undoWindowMs = accessibleUndoWindowMs(context)
            }
            // The transient goes down with what it was offering: an Undo left standing over an act
            // that was let go would offer a way back to something that never happened.
            if (event == Lifecycle.Event.ON_STOP && store.deletions.abandonWithheld()) {
                transient.currentSnackbarData?.dismiss()
            }
        }
        lifecycleOwner.lifecycle.addObserver(watcher)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(watcher)
            store.deletions.abandonWithheld()
        }
    }

    // The visible logger keeps the screen on.
    val window = (context as? Activity)?.window
    val running = loggerShown
    DisposableEffect(window, running) {
        if (running) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    // A double tap is a second session, so the door closes while the first is in flight. The start is
    // written to this phone's replica at once, offline too, and the engine carries it to the account.
    // A user-tapped start never silently joins.
    fun open(routineId: String) {
        scope.launch {
            if (starting) return@launch
            starting = true
            try {
                note = null
                val opened = store.workout.start(routineId)
                if (opened is GymResult.Failed) {
                    note = opened.why.line("nothing started")
                    return@launch
                }
                navigator.reset()
                selectedRoutineId = null
                if (notifications != null && Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                    !notificationPrefs.getBoolean("requested", false)) {
                    notificationPrefs.edit().putBoolean("requested", true).apply()
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                val movement = LiveOrder.resume(store.workout.order, store.workout.sets) ?: return@launch
                store.workout.choose(movement)
            } finally {
                starting = false
            }
        }
    }

    fun close() {
        scope.launch {
            val owner = currentAccount.user?.id
            note = null
            when (val ended = store.workout.finish()) {
                is FinishOutcome.Closed -> {
                    if (owner != currentAccount.user?.id) return@launch
                    sessionStates.removeState("${Frame.Workout(navigator.tab).key}:${ended.detail.session.id}")
                    if (ended.detail.sets.isNotEmpty()) haptics.finished()
                    navigator.reset(listOf(Away.Session(SessionSummary(ended.detail.session, ended.detail.sets, store.routines.catalog), ended.detail)))
                    pruneReceipts()
                    finished = FinishedSession(ended.detail.session, ended.detail.sets, review = null,
                        reviewRead = false, suggestsKeep = ended.detail.sets.isNotEmpty() &&
                            finishReceipts.suggestsKeep(ended.detail.session.id, !currentAccount.isSignedIn))
                }
                is FinishOutcome.Failed ->
                    note = ended.why.line("the session is still open")
            }
        }
    }

    val receipt = finished?.let { store.history.retainedSession(SessionDetail(it.session, it.sets)) }
    LaunchedEffect(receipt, account.resolved, store.seat.accountReady, store.seat.replicaReadRevision) {
        if (!account.resolved || account.user?.id.orEmpty() != seat || !store.seat.accountReady) return@LaunchedEffect
        val saved = receipt ?: return@LaunchedEffect
        val detail = when (val read = store.history.finishedSession(saved.session.id)) {
            is GymResult.Failed -> return@LaunchedEffect
            is GymResult.Ok -> read.value
        }
        if (detail == null) {
            finishStates.removeState(saved.session.id)
            finished = null
            navigator.reset()
            chooseTab(Tab.Log)
            return@LaunchedEffect
        }
        finished = finished?.copy(session = detail.session, sets = detail.sets)
        if (navigator.away.isEmpty()) navigator.reset(listOf(Away.Session(SessionSummary(detail.session, detail.sets, store.routines.catalog), detail)))
        val owner = currentAccount.user?.id
        val review = store.history.review(detail.session.id)
        if (owner == currentAccount.user?.id && receipt?.session?.id == detail.session.id) {
            finished = finished?.copy(review = review, reviewRead = true)
        }
    }

    fun discard(sessionId: String, source: String, snapshot: SessionDetail? = null) {
        if (discardPrompt != null || discarding || queuedFinishShare != null) return
        val standing = (navigator.away.lastOrNull() as? Away.Session)?.takeIf { it.summary.id == sessionId }
        val detail = snapshot ?: standing?.detail?.let(store.history::retainedSession)
        val summary = detail?.let { SessionSummary(it.session, it.sets, store.routines.catalog) }
            ?: store.history.allSessions.firstOrNull { it.id == sessionId } ?: standing?.summary ?: return
        note = null
        discardPrompt = WorkoutDiscardPrompt(summary, detail, source, store.seat.replica, store.seat.accountKey == Seat.anonymous)
        telemetry.event("gym_action", mapOf("screen" to source, "action" to "discard", "state" to "shown"))
    }

    fun openCoachChat(id: String, action: String) {
        store.coach.selectChat(id, action)
        look(Away.Thread(id))
    }

    fun openCoachWorkout(id: String) {
        val owner = store.seat.accountKey
        scope.launch {
            when (val read = store.history.sessionDetail(id)) {
                is GymResult.Ok -> if (owner == store.seat.accountKey) {
                    val detail = read.value
                    look(Away.Session(SessionSummary(detail.session, detail.sets, store.routines.catalog), detail))
                }
                is GymResult.Failed -> if (owner == store.seat.accountKey) note = read.why.line("that workout didn’t open")
            }
        }
    }

    fun ask(question: String, requestId: String = Ids.thread(), photo: CoachAttachment? = null) {
        val id = store.coach.selectedChatId ?: try { store.coach.freshChat() }
            catch (_: Exception) { note = "Your message couldn’t be saved. Try again."; return }
        if (!store.coach.submit(id, question, photo, requestId)) note = "Your message couldn’t be saved. Try again."
    }

    fun stopCoach() { store.coach.stopChat(conversationId) }

    fun askSomethingNew(draft: String = "") {
        try { store.coach.freshChat(draft) }
        catch (_: Exception) { note = "Your draft couldn’t be saved. Try again."; return }
        navigator.reset()
        receipts = emptyMap()
        chooseTab(Tab.Coach)
    }

    LaunchedEffect(queuedFinishShare, finishShareReady, account.resolved, account.user?.id,
        account.identityRevision, store.seat.accountReady, shell.signInAttempts.active, shell.signInAttempts.result) {
        val request = queuedFinishShare ?: return@LaunchedEffect
        val result = shell.signInAttempts.result?.takeIf { it.id == request }
        val owner = queuedFinishShareOwner ?: result?.userId
        val superseded = owner == null &&
            (shell.signInAttempts.active?.let { it != request } == true || shell.signInAttempts.result?.let { it.id != request } == true)
        if (result?.completed == false || superseded || owner != null && account.resolved && account.user?.id != owner) {
            queuedFinishShare = null
            queuedFinishShareOwner = null
            finishShareReady = false
            shell.signInAttempts.consume(request)
            return@LaunchedEffect
        }
        if (!finishShareReady) {
            closingFinish = true
            try {
                if (finished != null) launch { finishSheet.hide() }.join()
                if (queuedFinishShare != request) return@LaunchedEffect
                finished?.let { finishStates.removeState(it.session.id) }
                finished = null
                finishShareReady = true
                if (!currentAccount.isSignedIn && shell.signInAttempts.active != request &&
                    shell.signInAttempts.result?.id != request) shell.openSignInForResult(request)
            } finally { closingFinish = false }
            return@LaunchedEffect
        }
        if (!account.resolved || !account.isSignedIn || !store.seat.accountReady) return@LaunchedEffect
        if (owner == null || account.user?.id != owner || store.seat.accountKey != Seat.of(owner)) return@LaunchedEffect
        val authenticatedOwner = owner
        queuedFinishShareOwner = authenticatedOwner
        try {
            val chat = store.coach.freshChat(FinishCoach.question, id = request)
            navigator.reset()
            receipts = emptyMap()
            chooseTab(Tab.Coach)
            if (!store.coach.hasRequest(chat, request) &&
                !store.coach.submit(chat, FinishCoach.question, requestId = request, authenticatedOwner = authenticatedOwner)) {
                note = "Your message couldn’t be saved. Try again."
            }
        } catch (_: Exception) {
            note = "Your message couldn’t be saved. Try again."
        }
        queuedFinishShare = null
        queuedFinishShareOwner = null
        finishShareReady = false
        shell.signInAttempts.consume(request)
    }

    // The save lives here rather than on the builder: the builder's composition dies the moment the
    // draft is let go of. The door closes while one is in flight, or two taps are two routines.
    fun write(draft: RoutineDraft) {
        if (savingRoutine) return
        val initiatingOwner = currentAccount.user?.id
        val initiatingIdentity = currentAccount.identityRevision
        val initiatingAccountKey = store.seat.accountKey
        val initiatingReplica = store.seat.replica
        val attempt = Any()
        val prepared = if (draft.id == null && draft.creationId == null) draft.copy(creationId = Ids.routine()) else draft
        building = prepared
        routineSaveAttempt = attempt
        savingRoutine = true
        fun ownsAttempt() = routineSaveAttempt === attempt && currentAccount.user?.id == initiatingOwner &&
            currentAccount.identityRevision == initiatingIdentity &&
            store.seat.accountKey == initiatingAccountKey && store.seat.replica == initiatingReplica
        scope.launch(routineSaveContext.minusKey(Job)) {
            try {
                if (!ownsAttempt()) return@launch
                note = null
                val written = store.routines.saveRoutine(prepared, initiatingAccountKey, initiatingReplica)
                if (!ownsAttempt()) return@launch
                when (written) {
                    is GymResult.Failed -> note = written.why.line("${draft.name} wasn’t saved")
                    is GymResult.Ok -> {
                        haptics.saved()
                        building = null
                        navigator.reset()
                        selectedRoutineId = written.value.id
                        chooseTab(Tab.Routines)
                    }
                }
            } finally {
                if (routineSaveAttempt === attempt) {
                    routineSaveAttempt = null
                    savingRoutine = false
                }
            }
        }
    }

    suspend fun destroy(routineId: String): Boolean {
        val named = store.routines.routine(routineId)?.name ?: return true
        val failure = store.deletions.delete(Deletion.Routine(routineId, named))
        if (failure != null) {
            note = failure.line("$named is still in your program")
            return false
        }
        note = null
        building = null
        selectedRoutineId = null
        navigator.reset()
        chooseTab(Tab.Routines)
        return true
    }

    key(seat) {
        if (account.resolved && account.user?.id.orEmpty() == seat) {
            val origin = account.origin
            val sharing = remember(origin) { WorkoutShareActions(origin, store.sharing::share, store.sharing::revokeShare) }
            val lookedAtIds = lookedAt.split(' ').filter { it.isNotEmpty() }.toSet()
            val clipboard = LocalClipboard.current
            val logShareScope = key(account.identityRevision, store) { rememberCoroutineScope() }

            // The log row's long press. The card inside the session mints the same link and says more about
            // it; from the row there is nothing to draw, so the transient carries the whole answer.
            fun shareWorkout(sessionId: String) {
                val owner = account.user?.id
                val revision = account.identityRevision
                val storeSeat = store.seat.accountKey
                logShareScope.launch {
                    if (!currentAccount.resolved || owner != currentAccount.user?.id ||
                        revision != currentAccount.identityRevision || storeSeat != store.seat.accountKey) return@launch
                    note = null
                    val minted = store.sharing.share(sessionId)
                    currentCoroutineContext().ensureActive()
                    if (!currentAccount.resolved || owner != currentAccount.user?.id ||
                        revision != currentAccount.identityRevision || storeSeat != store.seat.accountKey) return@launch
                    when (minted) {
                        is GymResult.Ok -> {
                            try {
                                clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("plain text", WorkoutSharing.link(minted.value, origin))))
                            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                            catch (failure: Exception) {
                                telemetry.failure("gym.share", failure)
                                telemetry.event("gym_action", mapOf("screen" to "log", "action" to "share", "outcome" to "failed"))
                                note = "The link could not be copied. Try Share this workout again."
                                return@launch
                            }
                            telemetry.event("gym_action", mapOf("screen" to "log", "action" to "share", "outcome" to "ok"))
                            transient.showSnackbar(
                                "Link copied — anyone who has it can read this workout",
                                duration = SnackbarDuration.Long,
                            )
                        }
                        is GymResult.Failed -> {
                            telemetry.event("gym_action", mapOf("screen" to "log", "action" to "share",
                                "outcome" to if (minted.why is WriteFailure.Refused) "refused" else "failed"))
                            note = minted.why.line("the link wasn’t made")
                        }
                    }
                }
            }

            // Over the conversation or the routines home, never a push. Closing it — swipe, scrim, back —
            // decides nothing: the proposal stays pending and its card reads `still waiting`.
            reviewing?.let { open ->
                WindmillSheet(
                    onDismissRequest = {
                        if (reviewBusy) return@WindmillSheet
                        reviewing = null
                        if (open.proposalId !in lookedAtIds) lookedAt = (lookedAtIds + open.proposalId).joinToString(" ")
                    },
                    sheetState = reviewSheet,
                    containerColor = skin.surface,
                    scrimColor = skin.scrim,
                ) {
                    BackHandler(enabled = reviewBusy) {}
                    val proposalReview = remember(store) { ReviewBinding(store) }
                    ReviewSheet(
                        onBusy = { reviewBusy = it },
                        proposalId = open.proposalId,
                        state = proposalReview,
                        events = proposalReview,
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
                            if (settled.intent != works.windmill.gym.presentation.ProposalIntent.Remove ||
                                settled.state != works.windmill.gym.presentation.ProposalState.Applied) {
                                settled.receipt?.let { landReceipt(open.door, it) }
                                closeReview()
                            }
                        },
                    )
                }
            }

            finished?.let { original ->
                val canonical = store.history.retainedSession(SessionDetail(original.session, original.sets))
                val ended = original.copy(session = canonical.session,
                    sets = canonical.sets.filterNot { it.id in store.held.withheldIds || it.id in store.held.deletedSets })
                WindmillSheet(
                    onDismissRequest = {
                        finishStates.removeState(original.session.id)
                        finished = null
                        if (ended.sets.isEmpty()) { navigator.reset(); chooseTab(Tab.Routines) }
                    },
                    sheetState = finishSheet,
                    contentWindowInsets = { WindowInsets(0, 0, 0, 0) },
                    containerColor = skin.surface,
                    scrimColor = skin.scrim,
                    dragHandle = if (ended.sets.isEmpty()) null else { {
                        Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
                            Box(Modifier.size(32.dp, 4.dp).background(skin.inkFaint, androidx.compose.foundation.shape.RoundedCornerShape(2.dp)))
                        }
                    } },
                ) {
                    finishStates.SaveableStateProvider(original.session.id) {
                        FinishScreen(
                            finished = ended,
                            catalog = store.routines.catalog,
                            onDone = {
                                if (!closingFinish && queuedFinishShare == null) {
                                    telemetry.event("gym_action", mapOf("screen" to "finish", "action" to "done", "outcome" to "ok"))
                                    closeFinish { if (ended.sets.isEmpty()) { navigator.reset(); chooseTab(Tab.Routines) } }
                                }
                            },
                            onDiscard = { discard(ended.session.id, "finish", SessionDetail(ended.session, ended.sets)) },
                            onKeep = if (ended.suggestsKeep && !account.isSignedIn) { {
                                if (!closingFinish && queuedFinishShare == null) {
                                    telemetry.event("gym_action", mapOf("screen" to "finish", "action" to "keep", "outcome" to "ok"))
                                    closeFinish { shell.openSignIn() }
                                }
                            } } else null,
                            onShareWithCoach = if (!askAbsent) { {
                                if (!closingFinish && queuedFinishShare == null && finished?.session?.id == ended.session.id) {
                                    val request = Ids.thread()
                                    queuedFinishShare = request
                                    queuedFinishShareOwner = currentAccount.user?.id
                                }
                            } } else null,
                        )
                    }
                }
            }

            discardPrompt?.let { prompt ->
                WorkoutDiscardDialog(prompt.summary.setCount, busy = discarding,
                    onCancel = {
                        if (!discarding && discardPrompt === prompt) {
                            telemetry.event("gym_action", mapOf("screen" to prompt.screen, "action" to "discard", "outcome" to "cancelled"))
                            discardPrompt = null
                        }
                    },
                    onDiscard = {
                        if (!discarding && discardPrompt === prompt) {
                            discarding = true
                            val owner = currentAccount.user?.id
                            scope.launch {
                                try {
                                    val failure = store.workout.discardWorkout(prompt.summary.id, prompt.screen, prompt.replica, prompt.anonymous)
                                    if (owner != currentAccount.user?.id) return@launch
                                    discardPrompt = null
                                    if (failure != null) {
                                        val line = when (failure) {
                                            WriteFailure.NoAnswer -> "This workout couldn’t be deleted on this phone. It is still saved."
                                            else -> failure.line("the workout is still saved")
                                        }
                                        closeFinish {
                                            navigator.reset(listOf(Away.Session(prompt.summary, prompt.detail)))
                                            note = line
                                        }
                                        return@launch
                                    }
                                    closeFinish { navigator.reset(); chooseTab(Tab.Log) }
                                } finally { discarding = false }
                            }
                        }
                    },
                )
            }

            val routinesHome = remember(store) { RoutinesBinding(store) }
            if (building == null) selectedRoutineId?.let { id ->
                RoutineSheet(
                    routineId = id,
                    state = routinesHome,
                    onDismiss = { selectedRoutineId = null },
                    onStart = { open(it) },
                    onBuild = { building = it },
                    starting = starting,
                    failure = note,
                )
            }

            val youInitial = account.user?.email?.take(1) ?: ""
            val recoveryRead = store.recovery.latest?.takeIf { it.belongsTo(account) }
            val fixRead = store.recovery.fixDraft?.read
            val recovery = remember(store) { RecoveryBinding(store) }
            if (fixRead?.belongsTo(account) == true) WorkoutFixScreen(recovery, recovery, currentOwner = { fixRead.belongsTo(currentAccount) })

            @Composable
            fun CoachStance(otherwise: @Composable () -> Unit) = when {
                !account.isSignedIn && anonymousCoachAccess != AnonymousCoachAccess.Available ->
                    CoachAccessStance(seat = youInitial, onSignIn = shell.openSignIn,
                        bound = anonymousCoachAccess == AnonymousCoachAccess.Bound && store.coach.allThreads.isNotEmpty(),
                        onThreads = if (store.coach.allThreads.isEmpty()) null else ({ look(Away.Threads) }))
                askAbsent -> AskAbsentStance(seat = youInitial, onThreads = { look(Away.Threads) })
                else -> otherwise()
            }

            @Composable
            fun Conversation(backTo: String?, onBack: (() -> Unit)?) = AskScreen(
                store = store,
                seat = youInitial,
                thread = conversation,
                conversationId = conversationId,
                onOpenRoutine = { selectedRoutineId = it },
                onOpenWorkout = ::openCoachWorkout,
                onOpenChat = { openCoachChat(it, "reply_open") },
                receipts = receipts[Reviewing.coach].orEmpty(),
                lookedAt = lookedAtIds,
                asking = asking,
                cap = cap,
                onAsk = { asked -> ask(asked) },
                onPhotoAsk = { asked, photo -> ask(asked, photo = photo) },
                onStop = if (account.isSignedIn) ::stopCoach else null, upload = coachUpload,
                onSignIn = shell.openSignIn,
                onBuildRoutine = { building = RoutineDraft(position = store.routines.all.size) },
                onRetry = { ask(it.question, it.requestId.ifEmpty { Ids.thread() }, it.attachments.firstOrNull()) },
                onAskNew = { askSomethingNew() },
                seed = "",
                onNewDraft = { askSomethingNew(it) },
                onThreads = { look(Away.Threads) },
                onConnections = { look(Away.Connections) },
                origin = origin,
                backTo = backTo,
                onBack = onBack,
                onReview = { review(it.id, it.routineId, Reviewing.coach) },
            )

            @Composable
            fun TabScreen(tab: Tab, transient: SnackbarHostState? = null) = when (tab) {
                Tab.Log -> LogScreen(
                    store = store,
                    seat = youInitial,
                    onOpenSession = { look(Away.Session(it)) },
                    onOpenBodyweight = { look(Away.Bodyweight) },
                    onOpenMovement = { exercise, session -> look(Away.Movement(exercise, session)) },
                    onShareSession = { shareWorkout(it) },
                    onDiscardSession = { discard(it, "log") },
                    onOpenRecovery = { id -> look(if (id == null) Away.OnThisPhone else Away.InspectWorkout(id)) },
                    recovery = recoveryRead,
                    transient = transient,
                )
                Tab.Coach -> CoachStance { Conversation(backTo = null, onBack = null) }
                Tab.Routines -> RoutinesScreen(
                    state = routinesHome,
                    events = routinesHome,
                    lookedAt = lookedAtIds,
                    seat = youInitial,
                    // A routine starts from its plan sheet.
                    onBuild = { building = it },
                    onOpenRoutine = { selectedRoutineId = it },
                    onDeleteRoutine = { destroy(it) },
                    onReview = { review(it.id, it.routineId, Reviewing.routines) },
                    transient = transient,
                )
            }

            // What a way back is named after: the screen beneath, else the tab, or the logger when it stands.
            fun wayBackTo(under: Away?, tab: Tab): String = under?.wayBack(store.routines.catalog)
                ?: if (loggerShown) store.workout.session?.plan?.routine ?: Readout.noRoutine else tab.title

            @Composable
            fun PushedScreen(frame: Frame.Pushed) {
                val backTo = wayBackTo(frame.under, frame.tab)
                when (val standing = frame.away) {
                    is Away.Movement -> RecordScreen(
                        exerciseId = standing.exerciseId,
                        focusSessionId = standing.focusSessionId,
                        store = store,
                        backTo = backTo,
                        onBack = { back() },
                        onDraftOpen = { pushedDraftOpen = it },
                    )
                    Away.Connections -> ConnectedLogScreen(
                        store = store,
                        isSignedIn = account.isSignedIn,
                        origin = origin,
                        backTo = backTo,
                        onBack = { back() },
                        onSignIn = shell.openSignIn,
                    )
                    Away.Notes -> NotesScreen(
                        store = store,
                        isSignedIn = account.isSignedIn,
                        backTo = backTo,
                        onBack = { back() },
                        onEdit = { held, seedTitle -> look(Away.NoteEditor(held, seedTitle)) },
                        onSignIn = shell.openSignIn,
                        say = { note = it },
                    )
                    // The list beneath reads itself again on the way back: a saved note is on the list
                    // because the log says so.
                    is Away.NoteEditor -> NoteEditorScreen(
                        note = standing.note,
                        seedTitle = standing.seedTitle,
                        store = store,
                        backTo = backTo,
                        onBack = { back() },
                        onDone = { back() },
                    )
                    is Away.Session -> if (finished?.let { it.session.id == standing.summary.id && it.sets.isEmpty() } == true) {
                        GymScreen(title = standing.summary.plan?.routine ?: Readout.noRoutine,
                            onBack = { back() }, backTo = backTo) { }
                    } else {
                        val sessionPage = remember(store) { SessionBinding(store) }
                        SessionScreen(
                            summary = standing.summary,
                            seed = standing.detail,
                            state = sessionPage,
                            events = sessionPage,
                            sharing = sharing,
                            backTo = backTo,
                            onBack = { back() },
                            say = { note = it },
                            onOpenMovement = { look(Away.Movement(it)) },
                            onDiscard = { discard(it, "session") },
                            onDraftOpen = { pushedDraftOpen = it },
                        )
                    }
                    Away.OnThisPhone -> if (recoveryRead != null) OnThisPhoneScreen(recoveryRead,
                        onBack = { back() }, onInspect = { look(Away.InspectWorkout(it)) }) else TabScreen(frame.tab)
                    is Away.InspectWorkout -> if (recoveryRead != null) {
                        val row = recoveryRead.workouts.firstOrNull { it.id == standing.id }
                        if (row != null) WorkoutInspectScreen(recovery, recovery, recoveryRead, row, onBack = { back() },
                            currentOwner = { recoveryRead.belongsTo(currentAccount) })
                        else LaunchedEffect(standing.id) { back() }
                    } else TabScreen(frame.tab)
                    Away.Bodyweight -> BodyweightScreen(
                        store = store,
                        backTo = backTo,
                        onBack = { back() },
                        say = { note = it },
                        onDraftOpen = { pushedDraftOpen = it },
                    )
                    is Away.Coach -> CoachStance { Conversation(backTo = backTo, onBack = { back() }) }
                    Away.Threads -> ThreadsScreen(
                        store = store,
                        backTo = backTo,
                        onBack = { back() },
                        onOpen = { openCoachChat(it, "history_open") },
                        onAskNew = { askSomethingNew() },
                    )
                    is Away.Thread -> ThreadScreen(
                        threadId = standing.threadId,
                        seat = youInitial,
                        composerEnabled = account.isSignedIn || anonymousCoachAccess == AnonymousCoachAccess.Available,
                        onSignIn = shell.openSignIn,
                        onBuildRoutine = { building = RoutineDraft(position = store.routines.all.size) },
                        onAskNew = { askSomethingNew() },
                        store = store,
                        origin = origin,
                        onThreads = { look(Away.Threads) },
                        onConnections = { look(Away.Connections) },
                        onOpenRoutine = { selectedRoutineId = it },
                        onOpenWorkout = ::openCoachWorkout,
                        onOpenChat = { openCoachChat(it, "reply_open") },
                        receipts = receipts[Reviewing.thread(standing.threadId)].orEmpty(),
                        lookedAt = lookedAtIds,
                        backTo = backTo,
                        onBack = { back() },
                        onReview = { review(it.id, it.routineId, Reviewing.thread(standing.threadId)) },
                        say = { note = it },
                    )
                }
            }

            // The editor keeps the draft it last drew while it slides away after a save or a cancel.
            val leavingDraft = remember { object { var draft: RoutineDraft? = null } }

            // One frame of the room: its screen and the chrome that frame owns. Only the standing frame
            // carries the room's line and transient; a frame a gesture reveals, or one sliding away,
            // shows its rail and nothing that is about the moment.
            @Composable
            fun RoomFrame(frame: Frame, standing: Boolean) {
                val coachRoom = frame is Frame.Root && frame.tab == Tab.Coach ||
                    frame is Frame.Pushed && (frame.away is Away.Coach || frame.away is Away.Thread)
                val loggerTransient = frame is Frame.Workout
                // A screen with a floating button hosts the transient itself, above that button (05.17).
                val screenTransient = loggerTransient || frame is Frame.Root && frame.tab != Tab.Coach
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = skin.canvas,
                    bottomBar = {
                        val line = note.takeIf { standing && (selectedRoutineId == null || building != null) }
                        if (frame.railStands || line != null || !loggerTransient) {
                            Column(Modifier.fillMaxWidth().background(skin.canvas)) {
                                // Reserve the transient's measured height below screen-owned actions.
                                if (standing && !screenTransient) GymSnackbarHost(transient)
                                line?.let {
                                    Text(
                                        it,
                                        style = GymNativeType.note,
                                        color = skin.inkDim,
                                        maxLines = 2,
                                        // Said as it changes, so TalkBack hears the line the eye reads.
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 16.dp, vertical = 4.dp)
                                            .semantics { liveRegion = LiveRegionMode.Polite },
                                    )
                                }
                                if (frame.railStands) {
                                    if (frame is Frame.Root && liveSession != null && selectedRoutineId == null && reviewing == null) WorkoutBar(
                                        session = liveSession,
                                        onOpen = {
                                            val result = workout?.key?.let { store.workout.setLoggerHidden(it, false) }
                                                ?: WorkoutChange.Unavailable(store.workout.workoutFailure ?: "The workout is not ready.")
                                            telemetry.event("gym_action", mapOf("screen" to "workout_bar", "action" to "open",
                                                "outcome" to if (result == WorkoutChange.Saved) "ok" else "refused"))
                                            if (result is WorkoutChange.Unavailable) note = result.reason
                                        },
                                    )
                                    TabRail(
                                        current = if (coachRoom) Tab.Coach else frame.tab,
                                        recoveryCount = PhoneRecovery.needsYou(recoveryRead?.workouts.orEmpty()),
                                        onPick = { picked ->
                                            note = null
                                            if (picked == Tab.Coach) askSomethingNew()
                                            else { navigator.reset(); chooseTab(picked) }
                                        },
                                    )
                                } else {
                                    Box(Modifier.fillMaxWidth().navigationBarsPadding())
                                }
                            }
                        }
                    },
                ) { inner ->
                    // Each frame keeps its saved state under its own key, so two frames on the stage at once
                    // never share one, even when both show the same session. The logger's state is its
                    // session's and leaves the stage with it.
                    val stateKey = if (frame is Frame.Workout) liveSession?.let { "${frame.key}:${it.id}" } else frame.key
                    // Consumed as well as applied: a screen inside that pads itself for the keyboard would
                    // otherwise count the navigation bar twice and leave a gap above the keys.
                    Box(Modifier.fillMaxSize().padding(inner).consumeWindowInsets(inner)) {
                        if (stateKey != null) sessionStates.SaveableStateProvider(stateKey) {
                            when (frame) {
                                is Frame.Workout -> LoggerScreen(
                                    store = store,
                                    say = { note = it },
                                    onFinish = { close() },
                                    onHide = ::hideWorkout,
                                    transient = transient.takeIf { standing },
                                )
                                // A day being built outranks a tab and nothing else, and it covers the rail.
                                is Frame.Draft -> (building?.also { leavingDraft.draft = it } ?: leavingDraft.draft)?.let { draft ->
                                    val builder = remember(store) { RoutineBuilderBinding(store) }
                                    RoutineBuilder(
                                        draft = draft,
                                        state = builder,
                                        events = builder,
                                        saving = savingRoutine,
                                        onDraft = { building = it },
                                        onSave = { building?.let(::write) },
                                        onClose = { building = null },
                                        say = { note = it },
                                        // An edit returns to its routine's sheet; a new draft to what it was opened over.
                                        backTo = selectedRoutineId?.let { store.routines.routine(it)?.name }
                                            ?: wayBackTo(navigator.away.lastOrNull(), frame.tab),
                                    )
                                }
                                is Frame.Pushed -> PushedScreen(frame)
                                is Frame.Root -> TabScreen(frame.tab, transient.takeIf { standing })
                            }
                        }
                    }
                }
            }

            val standing = navigator.standing(building = building != null, logger = loggerShown)
            val standingKey = standing.frame.key
            GymStage(standing = standing, guards = navigator.guards, onBack = ::goBack) { frame ->
                RoomFrame(frame, standing = frame.key == standingKey)
            }
        } else {
            Box(Modifier.fillMaxSize().background(skin.canvas))
        }
    }
}

// 00.7: a navigation label stays whole. It keeps one line while it clears each neighbouring label by
// `gap` and stays inside the bar; otherwise it wraps at its spaces. It is never shrunk or cut, and it
// may spill past its own item into the width a neighbour leaves.
internal object RailLabels {
    val gap = 8.dp

    // In px: `pitch` between neighbouring item centres, `edge` from the bar's side to an outer centre,
    // and for each label its one-line width and its widest word. Answers the width each label takes.
    fun widths(pitch: Float, edge: Float, gap: Float, line: List<Float>, word: List<Float>): List<Float> {
        val taken = line.toMutableList()
        fun wraps(at: Int) = word[at] < taken[at]
        fun crowded(left: Int) = taken[left] / 2 + taken[left + 1] / 2 + gap > pitch
        listOf(0, taken.lastIndex).filter { taken[it] / 2 > edge && wraps(it) }.forEach { taken[it] = word[it] }
        while (true) {
            val left = (0 until taken.lastIndex).firstOrNull { crowded(it) && (wraps(it) || wraps(it + 1)) } ?: return taken
            val wrapping = listOf(left, left + 1).filter(::wraps).maxBy { taken[it] }
            taken[wrapping] = word[wrapping]
        }
    }
}

@Composable
internal fun TabRail(current: Tab, recoveryCount: Int, onPick: (Tab) -> Unit) {
    val skin = LocalGymColors.current
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    Column(Modifier.fillMaxWidth().background(skin.surface)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val barWidth = constraints.maxWidth
            val labelWidths = remember(barWidth, density) {
                with(density) {
                    fun width(text: String) = measurer.measure(text, GymChrome.tab, softWrap = false).size.width.toFloat()
                    val side = 12.dp.toPx()
                    // NavigationBar's own spacing between its items.
                    val spacing = 8.dp.toPx()
                    val slot = (barWidth - 2 * side - spacing * Tab.entries.lastIndex) / Tab.entries.size
                    RailLabels.widths(pitch = slot + spacing, edge = side + slot / 2, gap = RailLabels.gap.toPx(),
                        line = Tab.entries.map { width(it.title) },
                        word = Tab.entries.map { tab -> tab.title.split(' ').maxOf(::width) },
                    ).map { ceil(it).toInt().toDp() }
                }
            }
            NavigationBar(
                containerColor = skin.surface,
                tonalElevation = 0.dp,
                // The 12 dp sides are the bar's own inset, inside its surface, so a long label may spill into them.
                windowInsets = WindowInsets(left = 12.dp, right = 12.dp),
            ) {
                Tab.entries.forEachIndexed { index, entry ->
                    NavigationBarItem(
                        selected = entry == current,
                        onClick = { onPick(entry) },
                        icon = { BadgedBox(badge = {
                            if (entry == Tab.Log && recoveryCount > 0) Badge { Text(recoveryCount.toString()) }
                        }) { Icon(painterResource(railIcon(entry)), contentDescription = null, modifier = Modifier.size(24.dp)) } },
                        label = {
                            Text(entry.title, style = GymChrome.tab, textAlign = TextAlign.Center,
                                modifier = Modifier.requiredWidth(labelWidths[index]))
                        },
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
        }
        Box(Modifier.fillMaxWidth().background(skin.canvas).navigationBarsPadding())
    }
}

// The Undo carries a control and a line of text, so it waits as long as the system's accessibility
// timeout asks for such content, and never less than nine seconds (05.17).
internal fun accessibleUndoWindowMs(context: Context): Long {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return Withheld.windowMs
    val accessibility = context.getSystemService(AccessibilityManager::class.java) ?: return Withheld.windowMs
    val recommended = accessibility.getRecommendedTimeoutMillis(Withheld.windowMs.toInt(),
        AccessibilityManager.FLAG_CONTENT_CONTROLS or AccessibilityManager.FLAG_CONTENT_TEXT)
    return Withheld.window(recommended.toLong())
}

@DrawableRes
internal fun railIcon(tab: Tab): Int = when (tab) {
    Tab.Routines -> R.drawable.gym_nav_routines
    Tab.Log -> R.drawable.gym_nav_log
    Tab.Coach -> R.drawable.gym_nav_coach
}
