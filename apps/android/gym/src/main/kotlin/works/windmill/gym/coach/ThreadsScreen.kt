package works.windmill.gym.coach

import androidx.compose.ui.platform.LocalContext
import works.windmill.platform.R as PlatformR
import works.windmill.gym.presentation.ProposalReceipt
import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import works.windmill.gym.ui.gymColors
import works.windmill.gym.ui.GymLayout
import works.windmill.gym.ui.GymScreen
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.Stable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import works.windmill.platform.i18n.text
import androidx.compose.foundation.layout.size
import androidx.lifecycle.compose.LifecycleStartEffect
import works.windmill.gym.R
import works.windmill.gym.ui.DeleteSwipeRow
import works.windmill.gym.ui.DarkAndDaylight
import works.windmill.gym.ui.GymPreview
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.store.GymResult
import kotlinx.coroutines.launch
import works.windmill.platform.i18n.Words

// What the conversation list draws. `reading` holds the empty line back until the first read of the engine has landed.
@Stable
interface ThreadsState {
    val accountKey: String
    val threads: List<ConversationRow>
    val reading: Boolean
    fun nowMs(): Long
    fun draft(id: String): CoachDraft
    fun draftSaved(id: String): Boolean
    fun isAsking(id: String): Boolean
}

// What the conversation list asks of Coach.
interface ThreadsEvents {
    fun watching(on: Boolean)
    suspend fun deleteThread(id: String): GymResult<Unit>
}

// The conversation list over Coach's chats.
class ThreadsBinding(private val coach: CoachChats) : ThreadsState, ThreadsEvents {
    override val accountKey: String get() = coach.accountKey
    override val threads: List<ConversationRow> get() = coach.history
    override val reading: Boolean get() = coach.conversations?.rows == null
    override fun nowMs(): Long = coach.now()
    override fun draft(id: String): CoachDraft = coach.draft(id)
    override fun draftSaved(id: String): Boolean = coach.draftSaved(id)
    override fun isAsking(id: String): Boolean = coach.isAsking(id)
    override fun watching(on: Boolean) { coach.conversations?.watchHistory(on) }
    override suspend fun deleteThread(id: String): GymResult<Unit> = coach.deleteThread(id)
}

@Composable
fun ThreadsScreen(
    state: ThreadsState,
    events: ThreadsEvents,
    backTo: String,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onAskNew: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val telemetry = LocalTelemetry.current
    val context = LocalContext.current
    val nowMs = state.nowMs()
    val scope = rememberCoroutineScope()
    var failure by remember(state.accountKey) { mutableStateOf<String?>(null) }
    var confirming by remember(state.accountKey) { mutableStateOf<String?>(null) }
    var deleting by remember(state.accountKey) { mutableStateOf(emptySet<String>()) }

    LifecycleStartEffect(events) {
        events.watching(true)
        onStopOrDispose { events.watching(false) }
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

    GymScreen(title = stringResource(R.string.gym_coach_history), onBack = onBack, backTo = backTo) {
        Box(Modifier.fillMaxSize()) {
            val held = state.threads.filterNot { it.id in deleting }
            if (!state.reading && held.isEmpty() && failure == null) Column(Modifier.fillMaxSize().padding(horizontal = 32.dp, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
                LaunchedEffect(Unit) { telemetry.event("gym_action", mapOf("screen" to "threads", "action" to "empty", "outcome" to "shown")) }
                Icon(painterResource(R.drawable.gym_coach_forum), null, Modifier.size(40.dp), tint = colors.onSurfaceVariant)
                Text(stringResource(R.string.gym_coach_threads_none), style = GymType.coachAccessNote, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
            } else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 88.dp)) {
                failure?.let { line -> item("failure") {
                    Text(line, style = GymType.coachLine, color = colors.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                } }
                items(held, key = { it.id }) { thread ->
                    DeleteSwipeRow(actionLabel = stringResource(R.string.gym_coach_delete_conversation), onDelete = { requestDelete(thread.id); false }) {
                        val draft = state.draft(thread.id)
                        val preview = when {
                            thread.answering || state.isAsking(thread.id) -> stringResource(R.string.gym_coach_answering)
                            draft.text.isNotBlank() || draft.photo != null -> stringResource(if (state.draftSaved(thread.id)) R.string.gym_coach_draft_saved_here else R.string.gym_coach_draft)
                            else -> CoachMarkdown.plain(thread.answerPreview)
                        }
                        ListItem(
                            headlineContent = { Text(thread.named.text(), style = GymType.coachTitle) },
                            supportingContent = preview.takeIf { it.isNotBlank() }?.let { { Text(it, style = GymType.coachSupporting, maxLines = 2) } },
                            trailingContent = { thread.day(nowMs)?.text()?.let { Text(it.replaceFirstChar { c -> c.uppercase() }, style = GymType.coachSupporting) } },
                            colors = ListItemDefaults.colors(containerColor = colors.surface, headlineColor = colors.onSurface,
                                supportingColor = colors.onSurfaceVariant, trailingIconColor = colors.onSurfaceVariant),
                            modifier = Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.gym_coach_open_conversation)) { onOpen(thread.id) },
                        )
                    }
                }
            }
            val newChat = stringResource(R.string.gym_coach_new_chat)
            ExtendedFloatingActionButton(
                onClick = onAskNew, icon = { Icon(painterResource(R.drawable.gym_coach_new_chat), null, Modifier.size(24.dp)) },
                text = { Text(newChat, style = GymType.coachTitle) },
                containerColor = colors.surfaceContainer, contentColor = colors.primary,
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).semantics { contentDescription = newChat },
            )
        }
    }
    confirming?.let { id ->
        AlertDialog(
            onDismissRequest = ::cancelDelete,
            title = { Text(stringResource(R.string.gym_coach_delete_conversation_ask), style = GymType.coachDeleteTitle) },
            text = { Text(stringResource(R.string.gym_coach_delete_conversation_body), style = GymType.coachSupporting) },
            containerColor = colors.surfaceContainer, titleContentColor = colors.onSurface, textContentColor = colors.onSurfaceVariant,
            dismissButton = { TextButton(onClick = ::cancelDelete) { Text(stringResource(PlatformR.string.platform_cancel), style = GymType.coachAction) } },
            confirmButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = gymColors.alarmInk), onClick = {
                confirming = null
                deleting = deleting + id
                scope.launch {
                    try {
                        when (val result = events.deleteThread(id)) {
                            is GymResult.Ok -> failure = null
                            is GymResult.Failed -> failure = result.why.says(R.string.gym_coach_delete_conversation_no_answer).text(context)
                        }
                    } finally { deleting = deleting - id }
                }
            }) { Text(stringResource(PlatformR.string.platform_delete), style = GymType.coachAction) } },
        )
    }
}

@Composable
fun ThreadScreen(
    state: AskState,
    events: AskEvents,
    threadId: String,
    receipts: List<ProposalReceipt>,
    lookedAt: Set<String>,
    backTo: String,
    onBack: () -> Unit,
    onReview: (Proposal) -> Unit,
    say: (String?) -> Unit,
    onThreads: () -> Unit = onBack,
    onConnections: () -> Unit = {},
    onOpenRoutine: ((String) -> Unit)? = null,
    onOpenChat: ((String) -> Unit)? = null,
    seat: String? = null,
    composerEnabled: Boolean = true,
    onSignIn: (() -> Unit)? = null,
    onBuildRoutine: (() -> Unit)? = null,
) {
    val coach = state.coach
    val chat = coach.chat(threadId)

    LaunchedEffect(threadId, coach.accountKey) {
        if (coach.selectedChatId != threadId) coach.selectChat(threadId)
    }

    if (chat == null) {
        GymScreen(title = stringResource(R.string.gym_coach_conversation), onBack = onBack, backTo = backTo) {
            Column(Modifier.padding(GymLayout.gutter)) {
                Text(stringResource(R.string.gym_coach_reading_conversation), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        return
    }
    val unsaved = stringResource(R.string.gym_coach_message_unsaved)
    AskScreen(
        state = state, events = events, thread = coach.exchanges(threadId), conversationId = threadId,
        receipts = receipts, lookedAt = lookedAt, asking = coach.isAsking(threadId), refusal = coach.refusalOnScreen(threadId),
        onAsk = { question, photo -> if (!coach.send(threadId, question, photo)) say(unsaved) },
        onStop = { coach.stop() }, seat = seat, composerEnabled = composerEnabled,
        composerVisible = !coach.anonymous || coach.anonymousAccess == AnonymousCoachAccess.Available,
        onSignIn = onSignIn,
        onBuildRoutine = onBuildRoutine,
        onThreads = onThreads, onConnections = onConnections, onOpenRoutine = onOpenRoutine,
        onOpenChat = onOpenChat,
        onReview = onReview,
    )
}

private data class PreviewThreads(
    override val threads: List<ConversationRow>,
    override val accountKey: String = "preview-lifter",
    override val reading: Boolean = false,
) : ThreadsState {
    override fun nowMs(): Long = System.currentTimeMillis()
    override fun draft(id: String): CoachDraft = CoachDraft()
    override fun draftSaved(id: String): Boolean = true
    override fun isAsking(id: String): Boolean = false
}

private object PreviewThreadsEvents : ThreadsEvents {
    override fun watching(on: Boolean) = Unit
    override suspend fun deleteThread(id: String): GymResult<Unit> = GymResult.Ok(Unit)
}

@Composable
private fun ThreadsPreview(threads: List<ConversationRow>) {
    GymPreview {
        ThreadsScreen(PreviewThreads(threads), PreviewThreadsEvents, backTo = "Coach", onBack = {}, onOpen = {}, onAskNew = {})
    }
}

private val previewThreads: List<ConversationRow> get() {
    val now = System.currentTimeMillis()
    return listOf(
        ConversationRow("preview-1", Words.Plain("Can you add a second leg day to my week?"), now - 3_600_000, answering = true),
        ConversationRow("preview-2", Words.Plain("My left shoulder clicks on overhead press"), now - 86_400_000,
            answerPreview = "Swap to a landmine press for two weeks and keep the load where it stays pain-free."),
        ConversationRow("preview-3", Words.Plain("How long should I rest between heavy squat sets?"), now - 6 * 86_400_000,
            answerPreview = "Three to five minutes on your top sets; two is enough on back-off sets."),
    )
}

@DarkAndDaylight
@Composable
private fun ThreadsChatsPreview() = ThreadsPreview(threads = previewThreads)

@DarkAndDaylight
@Composable
private fun ThreadsEmptyPreview() = ThreadsPreview(threads = emptyList())
