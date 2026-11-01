package works.windmill.gym

import androidx.compose.material3.MaterialTheme
import works.windmill.gym.ui.gymColors
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SheetState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.NonSkippableComposable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import works.windmill.gym.presentation.Ids
import works.windmill.gym.presentation.ProposalIntent
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.Seat
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.ui.FinishCoach
import works.windmill.gym.ui.FinishScreen
import works.windmill.gym.ui.FinishedSession
import works.windmill.gym.ui.ReviewBinding
import works.windmill.gym.ui.ReviewSheet
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.design.WindmillSheet
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

// The review sheet and the door it opened from, which is where its receipt lands: the live
// conversation, a stored thread, or the routines home. The proposal carries the routine the diff was
// written against.
internal data class Reviewing(val proposalId: String, val routineId: String, val door: String) {
    companion object {
        const val coach = "coach"
        const val routines = "routines"
        fun thread(id: String) = "thread:$id"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Stable
internal class ReviewFlow(
    private val scope: CoroutineScope,
    private val sheet: SheetState,
    reviewingState: MutableState<Reviewing?>,
    busyState: MutableState<Boolean>,
    lookedAtState: MutableState<String>,
    receiptsState: MutableState<Map<String, List<String>>>,
) {
    var reviewing by reviewingState
        private set
    private var busy by busyState
    private var lookedAt by lookedAtState
    private var receipts by receiptsState

    val lookedAtIds: Set<String> get() = lookedAt.split(' ').filter { it.isNotEmpty() }.toSet()

    fun receiptsAt(door: String): List<String> = receipts[door].orEmpty()

    // Opened over whatever is standing; the door is where the receipt will land.
    fun open(proposalId: String, routineId: String, door: String) {
        reviewing = Reviewing(proposalId, routineId, door)
    }

    fun close() {
        if (busy) return
        scope.launch { sheet.hide() }.invokeOnCompletion { reviewing = null }
    }

    // A thread's receipts live exactly as long as that thread is on screen.
    fun pruneReceipts(standing: Away?) {
        val thread = (standing as? Away.Thread)?.let { Reviewing.thread(it.threadId) }
        receipts = receipts.filterKeys { it == Reviewing.coach || it == thread }
    }

    fun clearReceipts() {
        receipts = emptyMap()
    }

    // A review and its receipts belong to the seat they were read on.
    fun forget() {
        receipts = emptyMap()
        reviewing = null
    }

    // Over the conversation or the routines home, never a push. Closing it — swipe, scrim, back —
    // decides nothing: the proposal stays pending and its card reads `still waiting`.
    @Composable
    fun Sheet(store: TrainingStore, onAsk: ((about: String) -> Unit)?, say: (String) -> Unit) {
        val colors = MaterialTheme.colorScheme
        reviewing?.let { open ->
            WindmillSheet(
                onDismissRequest = {
                    if (busy) return@WindmillSheet
                    reviewing = null
                    if (open.proposalId !in lookedAtIds) lookedAt = (lookedAtIds + open.proposalId).joinToString(" ")
                },
                sheetState = sheet,
                containerColor = colors.surfaceContainer,
                scrimColor = colors.scrim,
            ) {
                BackHandler(enabled = busy) {}
                val proposalReview = remember(store) { ReviewBinding(store) }
                ReviewSheet(
                    onBusy = { busy = it },
                    proposalId = open.proposalId,
                    state = proposalReview,
                    events = proposalReview,
                    onAsk = if (onAsk == null) null else { about ->
                        close()
                        onAsk(about)
                    },
                    onDecided = { settled ->
                        if (settled.intent != ProposalIntent.Remove || settled.state != ProposalState.Applied) {
                            // The server's reply, never the model's prose. From the routines home there is no
                            // thread to land in, so the room's own line carries it until the next move.
                            settled.receipt?.let { line ->
                                if (open.door == Reviewing.routines) say(line)
                                else receipts = receipts + (open.door to receipts[open.door].orEmpty() + line)
                            }
                            close()
                        }
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun rememberReviewFlow(): ReviewFlow {
    val scope = rememberCoroutineScope()
    // The review open over the room. NOT saved: it reads the log on the way in, and a recreation
    // mid-review lands back on the card, which decides nothing either.
    val reviewing = remember { mutableStateOf<Reviewing?>(null) }
    val busy = remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !busy.value })
    // Reviews opened and closed with nothing decided: their cards read `still waiting`. Saved as the
    // string it is, ids joined by a space.
    val lookedAt = rememberSaveable { mutableStateOf("") }
    // The room keeps shown receipts with their doors; unseen removal receipts live in the replica.
    val receipts = remember { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    return remember(scope, sheet) { ReviewFlow(scope, sheet, reviewing, busy, lookedAt, receipts) }
}

// The finish receipt over the room, and the Share with Coach request it queues under its own saved
// identity and owner. Its composables never skip: the seat's readiness is not all snapshot state, so
// they read the store again whenever the room recomposes.
@OptIn(ExperimentalMaterial3Api::class)
@Stable
internal class FinishFlow(
    private val scope: CoroutineScope,
    private val context: Context,
    private val telemetry: Telemetry,
    private val sheet: SheetState,
    private val states: SaveableStateHolder,
    finishedState: MutableState<FinishedSession?>,
    queuedShareState: MutableState<String?>,
    queuedShareOwnerState: MutableState<String?>,
    shareReadyState: MutableState<Boolean>,
    closingState: MutableState<Boolean>,
) {
    var finished by finishedState
        private set
    private var queuedShare by queuedShareState
    private var queuedShareOwner by queuedShareOwnerState
    private var shareReady by shareReadyState
    private var closing by closingState

    val shareQueued: Boolean get() = queuedShare != null

    fun open(detail: SessionDetail, anonymous: Boolean) {
        finished = FinishedSession(detail.session, detail.sets, review = null,
            reviewRead = false, suggestsKeep = detail.sets.isNotEmpty() && suggestsKeep(detail.session.id, anonymous))
    }

    // Only the first signed-out receipt on this phone offers Keep, and it goes on offering it.
    fun suggestsKeep(sessionId: String, anonymous: Boolean): Boolean {
        if (!anonymous) return false
        return try {
            val phone = context.getSharedPreferences("gym-receipts", 0)
            val first = phone.getString("first-anonymous-receipt", null)
            if (first != null) return first == sessionId
            check(phone.edit().putString("first-anonymous-receipt", sessionId).commit())
            true
        } catch (failure: Exception) {
            telemetry.failure("gym.finishReceipt", failure)
            false
        }
    }

    // A receipt belongs to the seat it was finished on.
    fun forget() {
        finished = null
    }

    // Compose fires no dismiss callback on a programmatic close, so every close routes through here.
    // Whatever the door does next waits for the sheet to be off, or the room's own chrome redraws
    // itself under a sheet that is still coming down. ONE descent at a time, and the continuation
    // only on a descent that finished: a second `hide()` cancels the first through the sheet's own
    // mutex, and a cancelled job completes too — so without both guards a double tap would run the
    // door's continuation twice, the second wiping what the first had just begun.
    fun close(then: () -> Unit = {}) {
        if (closing || queuedShare != null) return
        if (finished == null) { then(); return }
        closing = true
        scope.launch { sheet.hide() }.invokeOnCompletion { cause ->
            closing = false
            if (cause != null) return@invokeOnCompletion
            finished?.let { states.removeState(it.session.id) }
            finished = null
            then()
        }
    }

    // The receipt follows the log: a session the log no longer holds takes the receipt down, and one it
    // holds refreshes the receipt's sets and reads its review.
    @NonSkippableComposable
    @Composable
    fun FollowTheLog(store: TrainingStore, account: Account, seat: String, onGone: () -> Unit, onRead: (SessionDetail) -> Unit) {
        val currentAccount by rememberUpdatedState(account)
        val receipt = finished?.let { store.history.retainedSession(SessionDetail(it.session, it.sets)) }
        LaunchedEffect(receipt, account.resolved, store.seat.accountReady, store.seat.replicaReadRevision) {
            if (!account.resolved || account.user?.id.orEmpty() != seat || !store.seat.accountReady) return@LaunchedEffect
            val saved = receipt ?: return@LaunchedEffect
            val detail = when (val read = store.history.finishedSession(saved.session.id)) {
                is GymResult.Failed -> return@LaunchedEffect
                is GymResult.Ok -> read.value
            }
            if (detail == null) {
                states.removeState(saved.session.id)
                finished = null
                onGone()
                return@LaunchedEffect
            }
            finished = finished?.copy(session = detail.session, sets = detail.sets)
            onRead(detail)
            val owner = currentAccount.user?.id
            val review = store.history.review(detail.session.id)
            if (owner == currentAccount.user?.id && receipt?.session?.id == detail.session.id) {
                finished = finished?.copy(review = review, reviewRead = true)
            }
        }
    }

    // A queued Share waits for its own sign-in to complete and for the account's data to be ready; a
    // cancelled or superseded sign-in, or another owner, retires it.
    @NonSkippableComposable
    @Composable
    fun CarryShareToCoach(store: TrainingStore, account: Account, onCoach: () -> Unit, say: (String) -> Unit) {
        val shell = LocalShellActions.current
        val currentAccount by rememberUpdatedState(account)
        LaunchedEffect(queuedShare, shareReady, account.resolved, account.user?.id,
            account.identityRevision, store.seat.accountReady, shell.signInAttempts.active, shell.signInAttempts.result) {
            val request = queuedShare ?: return@LaunchedEffect
            val result = shell.signInAttempts.result?.takeIf { it.id == request }
            val owner = queuedShareOwner ?: result?.userId
            val superseded = owner == null &&
                (shell.signInAttempts.active?.let { it != request } == true || shell.signInAttempts.result?.let { it.id != request } == true)
            if (result?.completed == false || superseded || owner != null && account.resolved && account.user?.id != owner) {
                queuedShare = null
                queuedShareOwner = null
                shareReady = false
                shell.signInAttempts.consume(request)
                return@LaunchedEffect
            }
            if (!shareReady) {
                closing = true
                try {
                    if (finished != null) launch { sheet.hide() }.join()
                    if (queuedShare != request) return@LaunchedEffect
                    finished?.let { states.removeState(it.session.id) }
                    finished = null
                    shareReady = true
                    if (!currentAccount.isSignedIn && shell.signInAttempts.active != request &&
                        shell.signInAttempts.result?.id != request) shell.openSignInForResult(request)
                } finally { closing = false }
                return@LaunchedEffect
            }
            if (!account.resolved || !account.isSignedIn || !store.seat.accountReady) return@LaunchedEffect
            if (owner == null || account.user?.id != owner || store.seat.accountKey != Seat.of(owner)) return@LaunchedEffect
            val authenticatedOwner = owner
            queuedShareOwner = authenticatedOwner
            try {
                val chat = store.coach.freshChat(FinishCoach.question, id = request)
                onCoach()
                if (!store.coach.hasRequest(chat, request) &&
                    !store.coach.submit(chat, FinishCoach.question, requestId = request, authenticatedOwner = authenticatedOwner)) {
                    say("Your message couldn’t be saved. Try again.")
                }
            } catch (_: Exception) {
                say("Your message couldn’t be saved. Try again.")
            }
            queuedShare = null
            queuedShareOwner = null
            shareReady = false
            shell.signInAttempts.consume(request)
        }
    }

    // `onLeftEmpty` is where a receipt with no sets leaves the room once it is down.
    @NonSkippableComposable
    @Composable
    fun Sheet(store: TrainingStore, account: Account, askAbsent: Boolean, onLeftEmpty: () -> Unit, onDiscard: (SessionDetail) -> Unit) {
        val colors = MaterialTheme.colorScheme
        val gymColors = MaterialTheme.gymColors
        val shell = LocalShellActions.current
        val currentAccount by rememberUpdatedState(account)
        finished?.let { original ->
            val canonical = store.history.retainedSession(SessionDetail(original.session, original.sets))
            val ended = original.copy(session = canonical.session,
                sets = canonical.sets.filterNot { it.id in store.held.deletedSets })
            WindmillSheet(
                onDismissRequest = {
                    states.removeState(original.session.id)
                    finished = null
                    if (ended.sets.isEmpty()) onLeftEmpty()
                },
                sheetState = sheet,
                contentWindowInsets = { WindowInsets(0, 0, 0, 0) },
                containerColor = colors.surfaceContainer,
                scrimColor = colors.scrim,
                dragHandle = if (ended.sets.isEmpty()) null else { {
                    Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(32.dp, 4.dp).background(gymColors.inkFaint, RoundedCornerShape(2.dp)))
                    }
                } },
            ) {
                states.SaveableStateProvider(original.session.id) {
                    FinishScreen(
                        finished = ended,
                        catalog = store.routines.catalog,
                        onDone = {
                            if (!closing && queuedShare == null) {
                                telemetry.event("gym_action", mapOf("screen" to "finish", "action" to "done", "outcome" to "ok"))
                                close { if (ended.sets.isEmpty()) onLeftEmpty() }
                            }
                        },
                        onDiscard = { onDiscard(SessionDetail(ended.session, ended.sets)) },
                        onKeep = if (ended.suggestsKeep && !account.isSignedIn) { {
                            if (!closing && queuedShare == null) {
                                telemetry.event("gym_action", mapOf("screen" to "finish", "action" to "keep", "outcome" to "ok"))
                                close { shell.openSignIn() }
                            }
                        } } else null,
                        onShareWithCoach = if (!askAbsent) { {
                            if (!closing && queuedShare == null && finished?.session?.id == ended.session.id) {
                                val request = Ids.thread()
                                queuedShare = request
                                queuedShareOwner = currentAccount.user?.id
                            }
                        } } else null,
                    )
                }
            }
        }
    }
}

private fun finishedSaver(telemetry: Telemetry) = Saver<FinishedSession?, String>(
    save = { it?.let { value -> WindmillJson.encodeToString(FinishedSession.serializer(), value) } ?: "" },
    restore = { raw -> raw.takeIf { it.isNotEmpty() }?.let {
        runCatching { WindmillJson.decodeFromString(FinishedSession.serializer(), it) }
            .onFailure { telemetry.failure("gym.restoreFinishedSession", it) }.getOrNull()
    } },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun rememberFinishFlow(telemetry: Telemetry, context: Context = LocalContext.current): FinishFlow {
    val scope = rememberCoroutineScope()
    val queuedShare = rememberSaveable { mutableStateOf<String?>(null) }
    val queuedShareOwner = rememberSaveable { mutableStateOf<String?>(null) }
    val shareReady = rememberSaveable { mutableStateOf(false) }
    // The committed detail survives process replacement after the workout closes.
    val finished = rememberSaveable(stateSaver = remember(telemetry) { finishedSaver(telemetry) }) { mutableStateOf<FinishedSession?>(null) }
    val states = rememberSaveableStateHolder()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // Whether the receipt is on its way down, so a second tap during the descent is one tap.
    val closing = remember { mutableStateOf(false) }
    return remember(scope, context, telemetry, sheet, states) {
        FinishFlow(scope, context, telemetry, sheet, states, finished, queuedShare, queuedShareOwner, shareReady, closing)
    }
}
