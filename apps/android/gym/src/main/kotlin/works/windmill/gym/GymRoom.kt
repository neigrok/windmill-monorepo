package works.windmill.gym

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.view.accessibility.AccessibilityManager
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.gym.presentation.SessionDetail
import androidx.compose.runtime.rememberCoroutineScope
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
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
import works.windmill.gym.ui.WorkoutDiscardDialog
import works.windmill.gym.ui.WorkoutDiscardPrompt
import works.windmill.gym.store.WriteFailure
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.gym.coach.AskAbsentStance
import works.windmill.gym.coach.AskBinding
import works.windmill.gym.coach.AskScreen
import works.windmill.gym.coach.CoachAccessStance
import works.windmill.gym.ui.BodyweightBinding
import works.windmill.gym.ui.BodyweightScreen
import works.windmill.gym.ui.ConnectedLogScreen
import works.windmill.gym.ui.ConnectionsBinding
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.LocalGymColors
import works.windmill.gym.ui.PhoneRecovery
import works.windmill.gym.ui.OnThisPhoneScreen
import works.windmill.gym.ui.WorkoutInspectScreen
import works.windmill.gym.ui.WorkoutFixScreen
import works.windmill.gym.ui.RecoveryBinding
import works.windmill.gym.ui.LogBinding
import works.windmill.gym.ui.LogScreen
import works.windmill.gym.ui.LoggerBinding
import works.windmill.gym.ui.LoggerScreen
import works.windmill.gym.ui.NoteEditorScreen
import works.windmill.gym.ui.NotesBinding
import works.windmill.gym.ui.NotesScreen
import works.windmill.gym.ui.RecordBinding
import works.windmill.gym.ui.RecordScreen
import works.windmill.gym.ui.RoutineBuilder
import works.windmill.gym.ui.RoutineBuilderBinding
import works.windmill.gym.ui.RoutineSheet
import works.windmill.gym.ui.RoutinesBinding
import works.windmill.gym.ui.RoutinesScreen
import works.windmill.gym.ui.rememberGymHaptics
import works.windmill.gym.ui.SessionBinding
import works.windmill.gym.ui.SessionScreen
import works.windmill.gym.coach.ThreadScreen
import works.windmill.gym.coach.ThreadsBinding
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

// The three tabs, the live session, and the screens a tab can push — the finish receipt is a sheet
// over one of those, not an arm of this. The shell owns the theme control and billing; its account
// seat rides the trailing slot of each root's own top bar, because a native rail has no fourth seat.
//
// The visible logger takes the whole screen; hidden workouts leave the tab roots available.
//
// The application owns the store; this room owns its navigator, the frames `GymStage` moves between,
// and transient UI state.
@Composable
fun GymRoom(account: Account, store: TrainingStore, notifications: WorkoutNotifications? = null,
    routineSaveContext: CoroutineContext = EmptyCoroutineContext) {
    val telemetry = LocalTelemetry.current
    val skin = LocalGymColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val shell = LocalShellActions.current
    val finishFlow = rememberFinishFlow(telemetry)
    var discardPrompt by remember { mutableStateOf<WorkoutDiscardPrompt?>(null) }
    var discarding by remember { mutableStateOf(false) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notifications?.refreshCapabilities()
    }
    val currentAccount by rememberUpdatedState(account)
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
    val reviewFlow = rememberReviewFlow()
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

    // The note is about the screen you are ON, so every move between destinations clears it.
    fun look(at: Away) {
        note = null
        if (at is Away.Coach) {
            try { store.coach.freshChat(at.seed) }
            catch (_: Exception) { note = "Your draft couldn’t be saved. Try again."; return }
        }
        navigator.push(at)
        reviewFlow.pruneReceipts(navigator.away.lastOrNull())
    }

    fun back() {
        note = null
        navigator.pop()
        reviewFlow.pruneReceipts(navigator.away.lastOrNull())
    }

    fun review(proposalId: String, routineId: String, door: String) {
        if (store.workout.session != null) { note = "Finish this session"; return }
        reviewFlow.open(proposalId, routineId, door)
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
        reviewFlow.reviewing != null -> "proposal"
        finishFlow.finished != null -> "finish"
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
            if (building == null && !savingRoutine && !pushedDraftOpen && reviewFlow.reviewing == null && navigator.away.none { it is Away.NoteEditor }) {
                navigator.reset()
                selectedRoutineId = null
                reviewFlow.pruneReceipts(navigator.away.lastOrNull())
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
            reviewFlow.forget()
            finishFlow.forget()
            discardPrompt = null
            building = null
            routineSaveAttempt = null
            savingRoutine = false
            selectedRoutineId = null
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
                val notificationPrefs = context.getSharedPreferences("workout-notifications", 0)
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
                    reviewFlow.pruneReceipts(navigator.away.lastOrNull())
                    finishFlow.open(ended.detail, anonymous = !currentAccount.isSignedIn)
                }
                is FinishOutcome.Failed ->
                    note = ended.why.line("the session is still open")
            }
        }
    }

    finishFlow.FollowTheLog(store, account, seat,
        onGone = {
            navigator.reset()
            chooseTab(Tab.Log)
        },
        onRead = { detail ->
            if (navigator.away.isEmpty()) navigator.reset(listOf(Away.Session(SessionSummary(detail.session, detail.sets, store.routines.catalog), detail)))
        },
    )

    fun discard(sessionId: String, source: String, snapshot: SessionDetail? = null) {
        if (discardPrompt != null || discarding || finishFlow.shareQueued) return
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

    fun enterCoach() {
        navigator.reset()
        reviewFlow.clearReceipts()
        chooseTab(Tab.Coach)
    }

    fun askSomethingNew(draft: String = "") {
        try { store.coach.freshChat(draft) }
        catch (_: Exception) { note = "Your draft couldn’t be saved. Try again."; return }
        enterCoach()
    }

    finishFlow.CarryShareToCoach(store, account, onCoach = ::enterCoach, say = { note = it })

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
            val lookedAtIds = reviewFlow.lookedAtIds
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

            reviewFlow.Sheet(store,
                // Offered only where Coach itself is: an account, and a deployment that has one.
                onAsk = if (account.isSignedIn && !askAbsent) {
                    { about -> look(Away.Coach("What would this change to $about do?")) }
                } else {
                    null
                },
                say = { note = it },
            )

            finishFlow.Sheet(store, account, askAbsent,
                onLeftEmpty = {
                    navigator.reset()
                    chooseTab(Tab.Routines)
                },
                onDiscard = { ended -> discard(ended.session.id, "finish", ended) },
            )

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
                                        finishFlow.close {
                                            navigator.reset(listOf(Away.Session(prompt.summary, prompt.detail)))
                                            note = line
                                        }
                                        return@launch
                                    }
                                    finishFlow.close { navigator.reset(); chooseTab(Tab.Log) }
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
            fun Conversation(backTo: String?, onBack: (() -> Unit)?) = remember(store) { AskBinding(store) }.let { ask -> AskScreen(
                state = ask, events = ask,
                seat = youInitial,
                thread = conversation,
                conversationId = conversationId,
                onOpenRoutine = { selectedRoutineId = it },
                onOpenWorkout = ::openCoachWorkout,
                onOpenChat = { openCoachChat(it, "reply_open") },
                receipts = reviewFlow.receiptsAt(Reviewing.coach),
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
            ) }

            @Composable
            fun TabScreen(tab: Tab, transient: SnackbarHostState? = null) = when (tab) {
                Tab.Log -> remember(store) { LogBinding(store) }.let { log -> LogScreen(
                    state = log,
                    events = log,
                    seat = youInitial,
                    onOpenSession = { look(Away.Session(it)) },
                    onOpenBodyweight = { look(Away.Bodyweight) },
                    onOpenMovement = { exercise, session -> look(Away.Movement(exercise, session)) },
                    onShareSession = { shareWorkout(it) },
                    onDiscardSession = { discard(it, "log") },
                    onOpenRecovery = { id -> look(if (id == null) Away.OnThisPhone else Away.InspectWorkout(id)) },
                    recovery = recoveryRead,
                    transient = transient,
                ) }
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
                    is Away.Movement -> remember(store) { RecordBinding(store) }.let { record -> RecordScreen(
                        state = record,
                        events = record,
                        exerciseId = standing.exerciseId,
                        focusSessionId = standing.focusSessionId,
                        backTo = backTo,
                        onBack = { back() },
                        onDraftOpen = { pushedDraftOpen = it },
                    ) }
                    Away.Connections -> remember(store) { ConnectionsBinding(store) }.let { connections -> ConnectedLogScreen(
                        state = connections,
                        events = connections,
                        isSignedIn = account.isSignedIn,
                        origin = origin,
                        backTo = backTo,
                        onBack = { back() },
                        onSignIn = shell.openSignIn,
                    ) }
                    Away.Notes -> remember(store) { NotesBinding(store) }.let { notes -> NotesScreen(
                        state = notes,
                        events = notes,
                        isSignedIn = account.isSignedIn,
                        backTo = backTo,
                        onBack = { back() },
                        onEdit = { held, seedTitle -> look(Away.NoteEditor(held, seedTitle)) },
                        onSignIn = shell.openSignIn,
                        say = { note = it },
                    ) }
                    // The list beneath reads itself again on the way back: a saved note is on the list
                    // because the log says so.
                    is Away.NoteEditor -> NoteEditorScreen(
                        events = remember(store) { NotesBinding(store) },
                        note = standing.note,
                        seedTitle = standing.seedTitle,
                        backTo = backTo,
                        onBack = { back() },
                        onDone = { back() },
                    )
                    is Away.Session -> if (finishFlow.finished?.let { it.session.id == standing.summary.id && it.sets.isEmpty() } == true) {
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
                    Away.Bodyweight -> remember(store) { BodyweightBinding(store) }.let { bodyweight -> BodyweightScreen(
                        state = bodyweight,
                        events = bodyweight,
                        backTo = backTo,
                        onBack = { back() },
                        say = { note = it },
                        onDraftOpen = { pushedDraftOpen = it },
                    ) }
                    is Away.Coach -> CoachStance { Conversation(backTo = backTo, onBack = { back() }) }
                    Away.Threads -> remember(store) { ThreadsBinding(store.coach) }.let { threads -> ThreadsScreen(
                        state = threads, events = threads,
                        backTo = backTo,
                        onBack = { back() },
                        onOpen = { openCoachChat(it, "history_open") },
                        onAskNew = { askSomethingNew() },
                    ) }
                    is Away.Thread -> remember(store) { AskBinding(store) }.let { ask -> ThreadScreen(
                        state = ask, events = ask,
                        threadId = standing.threadId,
                        seat = youInitial,
                        composerEnabled = account.isSignedIn || anonymousCoachAccess == AnonymousCoachAccess.Available,
                        onSignIn = shell.openSignIn,
                        onBuildRoutine = { building = RoutineDraft(position = store.routines.all.size) },
                        onAskNew = { askSomethingNew() },
                        origin = origin,
                        onThreads = { look(Away.Threads) },
                        onConnections = { look(Away.Connections) },
                        onOpenRoutine = { selectedRoutineId = it },
                        onOpenWorkout = ::openCoachWorkout,
                        onOpenChat = { openCoachChat(it, "reply_open") },
                        receipts = reviewFlow.receiptsAt(Reviewing.thread(standing.threadId)),
                        lookedAt = lookedAtIds,
                        backTo = backTo,
                        onBack = { back() },
                        onReview = { review(it.id, it.routineId, Reviewing.thread(standing.threadId)) },
                        say = { note = it },
                    ) }
                }
            }

            // The editor keeps the draft it last drew while it slides away after a save or a cancel.
            val leavingDraft = remember { object { var draft: RoutineDraft? = null } }

            // Only the standing frame carries the room's line and transient; a frame a gesture reveals, or
            // one sliding away, shows its rail and nothing that is about the moment.
            @Composable
            fun RoomFrame(frame: Frame, standing: Boolean) {
                FrameChrome(
                    frame = frame,
                    transient = transient.takeIf { standing && !frame.hostsTransient },
                    line = note.takeIf { standing && (selectedRoutineId == null || building != null) },
                    workout = liveSession.takeIf { selectedRoutineId == null && reviewFlow.reviewing == null },
                    onOpenWorkout = {
                        val result = workout?.key?.let { store.workout.setLoggerHidden(it, false) }
                            ?: WorkoutChange.Unavailable(store.workout.workoutFailure ?: "The workout is not ready.")
                        telemetry.event("gym_action", mapOf("screen" to "workout_bar", "action" to "open",
                            "outcome" to if (result == WorkoutChange.Saved) "ok" else "refused"))
                        if (result is WorkoutChange.Unavailable) note = result.reason
                    },
                    recoveryCount = PhoneRecovery.needsYou(recoveryRead?.workouts.orEmpty()),
                    onPick = { picked ->
                        note = null
                        if (picked == Tab.Coach) askSomethingNew()
                        else { navigator.reset(); chooseTab(picked) }
                    },
                ) {
                    val screenTransient = transient.takeIf { standing && frame.hostsTransient }
                    // Each frame keeps its saved state under its own key, so two frames on the stage at once
                    // never share one, even when both show the same session. The logger's state is its
                    // session's and leaves the stage with it.
                    val stateKey = if (frame is Frame.Workout) liveSession?.let { "${frame.key}:${it.id}" } else frame.key
                    if (stateKey != null) sessionStates.SaveableStateProvider(stateKey) {
                        when (frame) {
                            is Frame.Workout -> remember(store) { LoggerBinding(store) }.let { logger -> LoggerScreen(
                                state = logger,
                                events = logger,
                                say = { note = it },
                                onFinish = { close() },
                                onHide = ::hideWorkout,
                                transient = screenTransient,
                            ) }
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
                            is Frame.Root -> TabScreen(frame.tab, screenTransient)
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

// The Undo carries a control and a line of text, so it waits as long as the system's accessibility
// timeout asks for such content, and never less than nine seconds (05.17).
internal fun accessibleUndoWindowMs(context: Context): Long {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return Withheld.windowMs
    val accessibility = context.getSystemService(AccessibilityManager::class.java) ?: return Withheld.windowMs
    val recommended = accessibility.getRecommendedTimeoutMillis(Withheld.windowMs.toInt(),
        AccessibilityManager.FLAG_CONTENT_CONTROLS or AccessibilityManager.FLAG_CONTENT_TEXT)
    return Withheld.window(recommended.toLong())
}
