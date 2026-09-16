package works.windmill.gym.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.ConnectedLogState
import works.windmill.gym.domain.LogLevel
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.design.WindmillFont

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectedLogScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    origin: String,
    backTo: String,
    onBack: () -> Unit,
    onSignIn: () -> Unit,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val web = LocalUriHandler.current
    val telemetry = LocalTelemetry.current
    val owner = store.accountKey
    var open by rememberSaveable(owner) { mutableStateOf(false) }
    var refreshing by remember(owner) { mutableStateOf(false) }
    val now = System.currentTimeMillis()
    fun refresh() {
        if (refreshing || !isSignedIn) return
        refreshing = true
        scope.launch {
            try { store.refreshConnectedLog() }
            finally { if (store.accountKey == owner) refreshing = false }
        }
    }
    LaunchedEffect(store, owner, isSignedIn) { if (isSignedIn) store.readConnectedLog() }
    ReadsAgainOnReturn { refresh() }
    val state = store.connectedLog
    val connected = state as? ConnectedLogState.Connected
    GymScreen(title = ConnectedLog.title, onBack = onBack, backTo = backTo,
        bottomBar = {
            Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
                Button(onClick = {
                    if (isSignedIn) runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                .onFailure { telemetry.failure("gym.openConnections", it) }
                    else onSignIn()
                }, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = skin.accent, contentColor = skin.onAccent)) {
                    Text(if (isSignedIn) ConnectedLog.action else ConnectedLog.actionSignedOut,
                        style = WindmillFont.body(16, FontWeight.Bold), textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                    if (isSignedIn) Icon(painterResource(R.drawable.gym_open_in_new), ConnectedLog.opensInBrowser,
                        modifier = Modifier.size(24.dp))
                }
            }
        }) {
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = ::refresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp)) {
                when {
                    isSignedIn && connected != null -> {
                        item("head") { Text(ConnectedLog.connectedHead, style = WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 31.sp), color = skin.ink) }
                        items(connected.tools, key = { "tool:${it.credential}:${it.id}" }) { tool -> ConnectionRow(tool.name, tool.meta(now)) }
                    }
                    isSignedIn && state == ConnectedLogState.Refused -> item("head") {
                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text(ConnectedLog.unavailable, style = WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 31.sp), color = skin.ink)
                            Text(ConnectedLog.unread, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                            TextButton(onClick = ::refresh, enabled = !refreshing, modifier = Modifier.heightIn(min = 48.dp)) { Text("Try again") }
                        }
                    }
                    isSignedIn && state == ConnectedLogState.Unknown -> item("head") {
                        Text("Reading your connections…", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                    }
                    else -> item("head") {
                        Text(ConnectedLog.head, style = WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 31.sp), color = skin.ink)
                    }
                }
                items(LogLevel.entries, key = { "level:${it.wire}" }) { level ->
                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        ConnectionRow(level.label, level.meta)
                        HorizontalDivider(color = skin.raised)
                    }
                }
                item("caption") { Text(ConnectedLog.caption, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.ink) }
                if (isSignedIn && connected != null) item("manage") {
                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button) {
                        runCatching { web.openUri(ConnectedLog.connectionsUrl(origin)) }
                            .onFailure { telemetry.failure("gym.openConnections", it) }
                    }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(ConnectedLog.manage, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
                            color = skin.ink, modifier = Modifier.weight(1f))
                        Icon(painterResource(R.drawable.gym_open_in_new), ConnectedLog.opensInBrowser, tint = skin.inkDim, modifier = Modifier.size(24.dp))
                    }
                }
                item("disclosure") {
                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button) { open = !open }
                        .semantics { stateDescription = if (open) ConnectedLog.open else ConnectedLog.closed }
                        .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(ConnectedLog.disclosure, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
                            color = skin.ink, modifier = Modifier.weight(1f))
                        Box(Modifier.graphicsLayer { rotationZ = if (open) 90f else 0f }) { Chevron() }
                    }
                }
                if (open) item("how") {
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        ConnectedLog.how.forEach { Text(it, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectionRow(title: String, detail: String) {
    val skin = LocalGymColors.current
    Column(Modifier.fillMaxWidth().heightIn(min = 64.dp).semantics(mergeDescendants = true) {}
        .padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
        Text(detail, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
    }
}
