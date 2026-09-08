package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.ConnectedLogState
import works.windmill.gym.domain.ConnectedTool
import works.windmill.gym.domain.LogLevel
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// The decision surface where a lifter hands their log to their own AI: what a grant reaches, as
// three rows of facts, and the one action that starts it. Two states from two reads — the head line
// steps aside for the list of what is connected — and one disclosure, closed by default, that is the
// whole of the long form. Signed out the log is this device's and a grant belongs to an account, so
// the action is the sign-in door.
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
    val scope = rememberCoroutineScope()
    val web = LocalUriHandler.current
    var open by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val now = remember { System.currentTimeMillis() }

    // Asked on the way in and again whenever the store drops the seat's answer; the store reads only
    // while it holds none, so this ask and the settings row's are one read.
    LaunchedEffect(store.connectedLog.answered) { store.readConnectedLog() }
    // Back from the browser `Connect a tool` opened, the tool just connected must be here without a
    // pull.
    ReadsAgainOnReturn { scope.launch { store.refreshConnectedLog() } }

    val state = store.connectedLog
    val connected = state as? ConnectedLogState.Connected

    GymScreen(
        title = ConnectedLog.title,
        onBack = onBack,
        backTo = backTo,
        bottomBar = {
            if (isSignedIn) {
                ActionBand(ConnectedLog.action, leavesTheApp = true) {
                    runCatching { web.openUri(ConnectedLog.setupUrl(origin)) }
                }
            } else {
                ActionBand(ConnectedLog.actionSignedOut, leavesTheApp = false, onTap = onSignIn)
            }
        },
    ) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    store.refreshConnectedLog()
                    refreshing = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(top = GymLayout.contentTop, bottom = GymLayout.scrollTailBand),
            ) {
                when {
                    connected != null -> {
                        item("connected") { SectionHead(ConnectedLog.connectedHead) }
                        // Prefixed so a wire id can never collide with a fixed key below.
                        items(connected.tools, key = { "tool:" + it.id }) { tool -> ToolRow(tool, now) }
                    }
                    state == ConnectedLogState.Refused -> {
                        item("connected") { SectionHead(ConnectedLog.connectedHead) }
                        item("unread") { Fact(ConnectedLog.unread, GymSkin.inkDim) }
                    }
                    else -> item("head") {
                        Text(
                            ConnectedLog.head,
                            style = WindmillFont.display(22),
                            color = GymSkin.ink,
                            modifier = Modifier.padding(horizontal = rowInset, vertical = WindmillSpace.x2),
                        )
                    }
                }
                items(LogLevel.entries, key = { it.wire }) { level ->
                    ListItem(
                        headlineContent = { Text(level.label, style = WindmillFont.body(15, FontWeight.Bold)) },
                        supportingContent = { Text(level.meta, style = GymType.numeral(13)) },
                        colors = rowColors(),
                    )
                }
                item("caption") { Fact(ConnectedLog.caption, GymSkin.inkFaint) }
                if (connected != null) {
                    item("manage") {
                        ListItem(
                            headlineContent = { Text(ConnectedLog.manage, style = WindmillFont.body(15)) },
                            trailingContent = { LeavesTheApp() },
                            colors = rowColors(),
                            modifier = Modifier.clickable(role = Role.Button) {
                                runCatching { web.openUri(ConnectedLog.connectionsUrl(origin)) }
                            },
                        )
                    }
                }
                // The platform's expand-more / expand-less pair, and the state in the bytes a screen
                // reader hears: the chevron alone says nothing to TalkBack.
                item("disclosure") {
                    ListItem(
                        headlineContent = { Text(ConnectedLog.disclosure, style = WindmillFont.body(15)) },
                        trailingContent = {
                            Icon(
                                if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                                contentDescription = null,
                                tint = GymSkin.inkFaint,
                                modifier = Modifier.size(20.dp),
                            )
                        },
                        colors = rowColors(),
                        modifier = Modifier
                            .clickable(role = Role.Button) { open = !open }
                            .semantics { stateDescription = if (open) ConnectedLog.open else ConnectedLog.closed },
                    )
                }
                if (open) items(ConnectedLog.how) { line -> Fact(line, GymSkin.inkDim) }
            }
        }
    }
}

// The reach band: the screen's one primary, above the safe-bottom inset and out of the scroll. A tap
// that leaves the app says so in the glyph, in the bytes a screen reader hears.
@Composable
private fun ActionBand(label: String, leavesTheApp: Boolean, onTap: () -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.canvas)
            .padding(horizontal = GymLayout.gutter)
            .padding(top = WindmillSpace.x2, bottom = WindmillSpace.x3)
            .heightIn(min = GymTap.primary)
            .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
            .clickable(role = Role.Button, onClick = onTap),
    ) {
        Text(label, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
        if (leavesTheApp) LeavesTheApp(tint = GymSkin.onAccent)
    }
}

@Composable
private fun LeavesTheApp(tint: Color = GymSkin.accent) {
    Icon(
        GymGlyph.openInNew,
        contentDescription = ConnectedLog.opensInBrowser,
        tint = tint,
        modifier = Modifier.size(16.dp),
    )
}

@Composable
private fun ToolRow(tool: ConnectedTool, now: Long) {
    ListItem(
        headlineContent = { Text(tool.name, style = WindmillFont.body(15, FontWeight.Bold)) },
        supportingContent = { Text(tool.meta(now), style = GymType.numeral(13)) },
        colors = rowColors(),
    )
}

@Composable
private fun SectionHead(title: String) {
    Text(
        title,
        style = GymType.numeral(11, FontWeight.Bold),
        color = GymSkin.inkFaint,
        modifier = Modifier.padding(horizontal = rowInset, vertical = WindmillSpace.x2),
    )
}

// A line of prose under a group: the caption, the unread row, the disclosure's lines.
@Composable
private fun Fact(line: String, color: Color) {
    Text(
        line,
        style = GymType.numeral(13).copy(lineHeight = 19.sp),
        color = color,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = rowInset, vertical = WindmillSpace.x2),
    )
}

@Composable
private fun rowColors() = ListItemDefaults.colors(
    containerColor = Color.Transparent,
    headlineColor = GymSkin.ink,
    supportingColor = GymSkin.inkDim,
)

// The platform's own list-item inset, so prose drawn between rows lines up with their text.
private val rowInset = 16.dp
