package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.ConnectedLog
import works.windmill.gym.presentation.ConnectedLogState
import works.windmill.gym.presentation.ConnectedTool
import works.windmill.gym.presentation.LogLevel
import works.windmill.gym.presentation.LogReach
import works.windmill.gym.store.SharingStore
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.telemetry.LocalTelemetry

private object ConnectionType {
    val body = TextStyle(fontFamily = GymNativeType.sans, fontSize = 16.sp, lineHeight = 24.sp)
    val supporting = body.copy(fontSize = 14.sp, lineHeight = 20.sp)
    val row = body.copy(fontSize = 17.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)
}

// What the connected-log page draws: the seat's answer about the tools that read the training log.
@Stable
interface ConnectionsState {
    val accountKey: String
    val isLoading: Boolean
    val connectedLog: ConnectedLogState
    val connectedLogGeneration: Long
}

// What the connected-log page asks of the stores.
interface ConnectionsEvents {
    suspend fun readConnectedLog()
    suspend fun refreshConnectedLog()
}

// The connected-log page over the room's stores.
class ConnectionsBinding(private val seat: TrainingSeat, private val sharing: SharingStore) : ConnectionsState, ConnectionsEvents {
    constructor(store: TrainingStore) : this(store.seat, store.sharing)

    override val accountKey: String get() = seat.accountKey
    override val isLoading: Boolean get() = seat.isLoading
    override val connectedLog: ConnectedLogState get() = sharing.connectedLog
    override val connectedLogGeneration: Long get() = sharing.connectedLogGeneration

    override suspend fun readConnectedLog() { sharing.readConnectedLog() }
    override suspend fun refreshConnectedLog() { sharing.refreshConnectedLog() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectedLogScreen(
    state: ConnectionsState,
    events: ConnectionsEvents,
    isSignedIn: Boolean,
    origin: String,
    backTo: String,
    onBack: () -> Unit,
    onSignIn: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val web = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    val owner = state.accountKey
    var how by rememberSaveable(owner) { mutableStateOf<Boolean?>(null) }
    var refreshing by remember(owner) { mutableStateOf(false) }
    val rootScroll = rememberLazyListState()
    val howScroll = rememberLazyListState()
    val now = System.currentTimeMillis()
    fun refresh() {
        if (refreshing || !isSignedIn || state.isLoading) return
        refreshing = true
        scope.launch {
            try { events.refreshConnectedLog() }
            finally { if (state.accountKey == owner) refreshing = false }
        }
    }
    fun browse(url: String) {
        runCatching { web.openUri(url) }.onFailure { telemetry.failure("gym.openConnections", it) }
    }
    LaunchedEffect(events, owner, isSignedIn, state.isLoading, state.connectedLogGeneration) {
        if (isSignedIn && !state.isLoading) events.readConnectedLog()
    }
    ReadsAgainOnReturn { refresh() }
    val log = if (isSignedIn) state.connectedLog else ConnectedLogState.None
    val connected = log as? ConnectedLogState.Connected
    BackHandler(enabled = how != null) { how = null }
    if (how != null) {
        GymScreen(title = ConnectedLog.disclosure, onBack = { how = null }, backTo = ConnectedLog.title) {
            LazyColumn(Modifier.fillMaxSize(), state = howScroll,
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 20.dp)) {
                item("how") {
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        ConnectedLog.how.forEach { Text(it, style = ConnectionType.body, color = colors.onSurface) }
                    }
                }
                if (how == true) item("levels") {
                    HorizontalDivider(color = colors.outlineVariant)
                    ConnectionLevels()
                }
            }
        }
        return
    }
    GymScreen(title = ConnectedLog.title, onBack = onBack, backTo = backTo,
        bottomBar = {
            Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                Button(onClick = { if (isSignedIn) browse(ConnectedLog.setupUrl(origin)) else onSignIn() },
                    shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.primary, contentColor = colors.onPrimary)) {
                    Text(if (isSignedIn) ConnectedLog.action else ConnectedLog.actionSignedOut,
                        style = GymNativeType.button, textAlign = TextAlign.Center)
                }
            }
        }) {
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = ::refresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), state = rootScroll,
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 20.dp)) {
                when (log) {
                    is ConnectedLogState.Connected -> {
                        item("head") { ConnectionHeading(ConnectedLog.connectedHead, FontWeight.Bold) }
                        items(log.tools, key = { "tool:${it.credential}:${it.id}" }) { tool ->
                            ConnectionRow(tool.name, tool.meta(now)) { browse(ConnectedLog.connectionsUrl(origin)) }
                        }
                    }
                    ConnectedLogState.None -> {
                        item("head") { ConnectionHeading(ConnectedLog.head) }
                        item("levels") { ConnectionLevels() }
                    }
                    ConnectedLogState.Unknown -> item("reading") {
                        Text("Reading your connections…", style = ConnectionType.body, color = colors.onSurfaceVariant,
                            modifier = Modifier.padding(16.dp))
                    }
                    ConnectedLogState.Refused, ConnectedLogState.Offline -> item("failure") {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(if (log == ConnectedLogState.Offline) ConnectedLog.offline else ConnectedLog.unread,
                                style = ConnectionType.body, color = colors.onSurfaceVariant)
                            TextButton(onClick = ::refresh, enabled = !refreshing, modifier = Modifier.heightIn(min = 48.dp)) { Text("Try again") }
                        }
                    }
                }
                item("disclosure") {
                    HorizontalDivider(color = colors.outlineVariant)
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(role = Role.Button) { how = connected != null }
                        .padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(ConnectedLog.disclosure, style = ConnectionType.row,
                            color = colors.onSurface, modifier = Modifier.weight(1f))
                        Icon(painterResource(R.drawable.gym_note_chevron), null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionHeading(text: String, weight: FontWeight = FontWeight.Normal) {
    Text(text, style = ConnectionType.supporting.copy(fontWeight = weight), color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp))
}

@Composable
private fun ConnectionLevels() {
    Column {
        LogLevel.entries.forEach { ConnectionRow(it.label, it.meta) }
        Text(ConnectedLog.caption, style = ConnectionType.supporting, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp))
    }
}

@Composable
private fun ConnectionRow(title: String, detail: String, onOpen: (() -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).semantics(mergeDescendants = true) {}
        .then(if (onOpen == null) Modifier else Modifier.clickable(role = Role.Button, onClickLabel = ConnectedLog.opensInBrowser, onClick = onOpen))
        .padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = ConnectionType.row, color = colors.onSurface)
            Text(detail, style = ConnectionType.supporting.copy(letterSpacing = 0.25.sp), color = colors.onSurfaceVariant)
        }
        if (onOpen != null) Icon(painterResource(R.drawable.gym_forward), null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
    }
}

private data class ConnectionsPreviewState(override val connectedLog: ConnectedLogState) : ConnectionsState {
    override val accountKey: String = "preview"
    override val isLoading: Boolean = false
    override val connectedLogGeneration: Long = 0
}

private object ConnectionsPreviewEvents : ConnectionsEvents {
    override suspend fun readConnectedLog() = Unit
    override suspend fun refreshConnectedLog() = Unit
}

@Composable
private fun ConnectionsPreview(log: ConnectedLogState) {
    GymPreview {
        ConnectedLogScreen(ConnectionsPreviewState(log), ConnectionsPreviewEvents, isSignedIn = true,
            origin = "https://windmill.works", backTo = "Settings", onBack = {}, onSignIn = {})
    }
}

@DarkAndDaylight
@Composable
private fun ConnectionsAnsweredPreview() {
    val since = System.currentTimeMillis() - 12L * 86_400_000
    ConnectionsPreview(ConnectedLogState.Connected(listOf(
        ConnectedTool("claude", "Claude", since, LogReach("gym:read gym:write"), ConnectedTool.Credential.Approved),
        ConnectedTool("key-1", "Training notebook", since, LogReach(""), ConnectedTool.Credential.Pasted),
    )))
}

@DarkAndDaylight
@Composable
private fun ConnectionsNonePreview() = ConnectionsPreview(ConnectedLogState.None)
