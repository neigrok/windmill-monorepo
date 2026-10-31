package works.windmill.gym.coach

import works.windmill.gym.ui.GymLayout
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.LocalGymColors
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.TextButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.layout.size
import works.windmill.gym.R
import works.windmill.gym.ui.DeleteSwipeRow
import works.windmill.platform.telemetry.LocalTelemetry
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ids
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadsScreen(
    store: TrainingStore,
    backTo: String,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onAskNew: () -> Unit,
) {
    val skin = LocalGymColors.current
    val telemetry = LocalTelemetry.current
    val nowMs = System.currentTimeMillis()
    val scope = rememberCoroutineScope()
    var attempt by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var failure by remember(store.coach.accountKey) { mutableStateOf<String?>(null) }
    var confirming by remember(store.coach.accountKey) { mutableStateOf<String?>(null) }
    var deleting by remember(store.coach.accountKey) { mutableStateOf(emptySet<String>()) }

    LaunchedEffect(store.coach.accountKey, attempt) {
        loading = true
        failure = when (val read = store.coach.readThreads()) {
            is GymResult.Ok -> null
            is GymResult.Failed -> read.why.line("your conversations are out of reach")
        }
        loading = false
    }

    fun requestDelete(id: String) {
        if (confirming != null || id in deleting) return
        confirming = id
        telemetry.event("gym_action", mapOf("screen" to "threads", "action" to "delete", "state" to "shown"))
    }
    fun cancelDelete() {
        if (confirming == null) return
        confirming = null
        telemetry.event("gym_action", mapOf("screen" to "threads", "action" to "delete", "outcome" to "cancelled"))
    }

    GymScreen(title = Threads.title, onBack = onBack, backTo = backTo) {
        Box(Modifier.fillMaxSize()) {
            PullToRefreshBox(isRefreshing = loading, onRefresh = { attempt++ }) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 88.dp)) {
                    failure?.let { line -> item("failure") {
                        Text(line, style = CoachType.body(14), color = skin.inkDim, modifier = Modifier.padding(16.dp))
                    } }
                    val held = store.coach.threads.filterNot { it.id in deleting }
                    if (!loading && held.isEmpty() && failure == null) item("none") {
                        Text(Threads.none, style = CoachType.body(15), color = skin.inkDim, modifier = Modifier.padding(16.dp))
                    }
                    items(held, key = { it.id }) { thread ->
                        DeleteSwipeRow(actionLabel = "Delete conversation", onDelete = { requestDelete(thread.id); false }) {
                            val draft = store.coach.draft(thread.id)
                            val preview = when {
                                store.coach.isAsking(thread.id) || thread.generation?.status == "running" -> "Answering…"
                                draft.text.isNotBlank() || draft.photo != null -> if (store.coach.draftSaved(thread.id)) "Draft · saved on this device" else "Draft"
                                else -> thread.outcome.detail?.replaceFirstChar { it.uppercase() }
                                    ?: CoachMarkdown.plain(thread.answerPreview)
                            }
                            ListItem(
                                headlineContent = { Text(thread.title, style = CoachType.body(16, FontWeight.Bold).copy(lineHeight = 24.sp)) },
                                supportingContent = preview.takeIf { it.isNotBlank() }?.let { { Text(it, style = CoachType.body(14).copy(lineHeight = 20.sp), maxLines = 2) } },
                                trailingContent = { thread.day(nowMs)?.let { Text(it.replaceFirstChar { c -> c.uppercase() }, style = CoachType.body(14).copy(lineHeight = 20.sp)) } },
                                colors = ListItemDefaults.colors(containerColor = skin.canvas, headlineColor = skin.ink,
                                    supportingColor = skin.inkDim, trailingIconColor = skin.inkDim),
                                modifier = Modifier.clickable(role = Role.Button, onClickLabel = "Open conversation") { onOpen(thread.id) },
                            )
                        }
                    }
                    store.coach.nextThreadCursor?.let { cursor -> item("older") {
                        CoachAction(if (loading) "Reading conversations…" else "Earlier conversations", enabled = !loading, onClick = {
                            loading = true
                            scope.launch {
                                failure = when (val read = store.coach.readThreads(cursor)) {
                                    is GymResult.Ok -> null
                                    is GymResult.Failed -> read.why.line("your conversations are out of reach")
                                }
                                loading = false
                            }
                        })
                    } }
                }
            }
            ExtendedFloatingActionButton(
                onClick = onAskNew, icon = { Icon(painterResource(R.drawable.gym_coach_new_chat), null, Modifier.size(24.dp)) },
                text = { Text(Threads.open, style = CoachType.body(16, FontWeight.Bold).copy(lineHeight = 24.sp)) },
                containerColor = skin.surface, contentColor = skin.accent,
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).semantics { contentDescription = Threads.open },
            )
        }
    }
    confirming?.let { id ->
        AlertDialog(
            onDismissRequest = ::cancelDelete,
            title = { Text("Delete this conversation?", style = CoachType.body(24, FontWeight.Bold).copy(lineHeight = 32.sp)) },
            text = { Text("You can’t undo this.", style = CoachType.body(14).copy(lineHeight = 20.sp)) },
            containerColor = skin.surface, titleContentColor = skin.ink, textContentColor = skin.inkDim,
            dismissButton = { TextButton(onClick = ::cancelDelete) { Text("Cancel", style = CoachType.body(14, FontWeight.Bold).copy(lineHeight = 20.sp, letterSpacing = 0.1.sp)) } },
            confirmButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = skin.alarmInk), onClick = {
                confirming = null
                deleting = deleting + id
                scope.launch {
                    when (val result = store.coach.deleteThread(id)) {
                        is GymResult.Ok -> failure = null
                        is GymResult.Failed -> failure = result.why.line("that conversation is still here")
                    }
                    deleting = deleting - id
                }
            }) { Text("Delete", style = CoachType.body(14, FontWeight.Bold).copy(lineHeight = 20.sp, letterSpacing = 0.1.sp)) } },
        )
    }
}

@Composable
fun ThreadScreen(
    threadId: String,
    store: TrainingStore,
    receipts: List<String>,
    lookedAt: Set<String>,
    backTo: String,
    onBack: () -> Unit,
    onReview: (ThreadProposal) -> Unit,
    say: (String?) -> Unit,
    onAskNew: () -> Unit = onBack,
    origin: String = "https://windmill.works",
    onThreads: () -> Unit = onBack,
    onNotes: () -> Unit = {},
    onConnections: (() -> Unit)? = null,
    onOpenRoutine: ((String) -> Unit)? = null,
    onOpenWorkout: ((String) -> Unit)? = null,
    onOpenChat: ((String) -> Unit)? = null,
    seat: String? = null,
    composerEnabled: Boolean = true,
    onSignIn: (() -> Unit)? = null,
    onBuildRoutine: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val coach = store.coach
    val chat = coach.chat(threadId)
    val history = chat?.history
    val conversation = chat?.exchanges.orEmpty()
    val asking = coach.isAsking(threadId)
    val upload = coach.upload(threadId)
    val cap = AskCap.entries.firstOrNull { it.name == chat?.cap }
    var failure by remember(threadId, coach.accountKey) { mutableStateOf<String?>(null) }
    var attempt by remember(threadId) { mutableIntStateOf(0) }
    var olderBusy by remember(threadId) { mutableStateOf(false) }

    fun ask(question: String, requestId: String = Ids.thread(), photo: CoachAttachment? = null) {
        if (!coach.submit(threadId, question, photo, requestId)) say("Your message couldn’t be saved. Try again.")
    }

    LaunchedEffect(threadId, coach.accountKey, attempt) {
        failure = null
        olderBusy = true
        try {
            if (coach.selectedChatId != threadId) coach.selectChat(threadId)
            when (val read = coach.thread(threadId)) {
                is GymResult.Ok -> coach.resumeChats()
                is GymResult.Failed -> failure = read.why.line("that conversation didn’t open")
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (_: Exception) { failure = "that conversation didn’t open" }
        finally { olderBusy = false }
    }

    if (chat == null || (failure != null && chat.history == null && chat.exchanges.isEmpty())) {
        GymScreen(title = Threads.conversation, onBack = onBack, backTo = backTo) {
            Column(Modifier.padding(GymLayout.gutter)) {
                Text(failure ?: "Reading conversation…", color = LocalGymColors.current.inkDim)
                if (failure != null) CoachAction("Try again", { attempt++ })
            }
        }
        return
    }
    AskScreen(
        store = store, thread = conversation, conversationId = threadId,
        receipts = receipts, lookedAt = lookedAt, asking = asking, cap = cap,
        onAsk = { ask(it) }, onPhotoAsk = { text, photo -> ask(text, photo = photo) },
        onStop = if (coach.anonymous) null else ({ coach.stopChat(threadId) }), upload = upload,
        onRetry = { ask(it.question, it.requestId.ifEmpty { Ids.thread() }, it.attachments.firstOrNull()) },
        onAskNew = onAskNew, seed = "", origin = origin, backTo = backTo, onBack = onBack, seat = seat, composerEnabled = composerEnabled,
        composerVisible = !coach.anonymous || coach.anonymousAccess == works.windmill.gym.coach.onboarding.AnonymousCoachAccess.Available,
        onSignIn = onSignIn,
        onBuildRoutine = onBuildRoutine,
        onThreads = onThreads, onNotes = onNotes, onConnections = onConnections, onOpenRoutine = onOpenRoutine,
        onOpenWorkout = onOpenWorkout, onOpenChat = onOpenChat,
        onReview = { onReview(ThreadProposal(it.id, it.state, it.changeCount, it.routineId, it.routineName, it.createdAtMs)) },
        onOlder = history?.nextCursor?.let { cursor -> {
            if (!olderBusy) {
                olderBusy = true
                scope.launch {
                    when (val read = coach.readOlderChat(threadId, cursor)) {
                        is GymResult.Ok -> failure = null
                        is GymResult.Failed -> failure = read.why.line("Earlier messages didn’t open.")
                    }
                    olderBusy = false
                }
            }
        } },
        olderBusy = olderBusy, historyFailure = failure,
        proposalIds = history?.proposals.orEmpty().map { it.id },
    )
}
