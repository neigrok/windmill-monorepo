package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import works.windmill.gym.R
import works.windmill.platform.LocalShellActions
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.filled.Close
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.text.rememberTextMeasurer

// A screen that reads the account again when the app comes back from elsewhere: ON_RESUME after an
// ON_STOP, which is the browser a door opened closing over a tool just connected. A dialog or a
// permission sheet only pauses, and the first ON_RESUME on the way in is not a return. Nothing
// fires while the screen is not showing, because the observer leaves with it.
@Composable
fun ReadsAgainOnReturn(onReturn: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentReturn by rememberUpdatedState(onReturn)
    DisposableEffect(lifecycleOwner) {
        var stopped = false
        val watcher = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> stopped = true
                Lifecycle.Event.ON_RESUME -> if (stopped) {
                    stopped = false
                    currentReturn()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(watcher)
        onDispose { lifecycleOwner.lifecycle.removeObserver(watcher) }
    }
}

// The room owns system insets; each screen owns its native title and actions. The bar tints to the
// card ground once the screen's content scrolls under it (00.1), and stays pinned.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymScreen(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    backTo: String? = null,
    navigation: (@Composable () -> Unit)? = null,
    titleAlignment: TextAlign = TextAlign.Start,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    // Given to a screen with a floating button: Scaffold lays the transient above it, and the button never moves.
    transient: SnackbarHostState? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val scrolledUnder = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = modifier.nestedScroll(scrolledUnder.nestedScrollConnection),
        containerColor = colors.surface,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = GymType.topBarTitle, textAlign = titleAlignment, color = colors.onSurface,
                        modifier = Modifier.fillMaxWidth().semantics { heading() })
                },
                navigationIcon = {
                    if (navigation != null) navigation()
                    else onBack?.let { back ->
                        IconButton(onClick = back, modifier = Modifier.size(48.dp)) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = backTo?.let { stringResource(R.string.gym_screen_back_to, it) } ?: stringResource(R.string.gym_action_back),
                                tint = colors.onSurface, modifier = Modifier.size(24.dp))
                        }
                    }
                },
                actions = actions,
                expandedHeight = 64.dp,
                windowInsets = WindowInsets(0, 0, 0, 0),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surface, scrolledContainerColor = colors.surfaceContainer),
                scrollBehavior = scrolledUnder,
                modifier = Modifier.testTag("gym-top-bar"),
            )
        },
        bottomBar = bottomBar,
        snackbarHost = { transient?.let { GymSnackbarHost(it, Modifier.testTag("Transient")) } },
        floatingActionButton = floatingActionButton,
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) { content() }
    }
}

// The planning forms' outlined fields speak the platform's own type: body-large for what is typed,
// body-small for the label once it floats.
@Composable
fun NativeFieldType(content: @Composable () -> Unit) {
    MaterialTheme(typography = MaterialTheme.typography.withStockFields(FontFamily.SansSerif), content = content)
}

// A top bar action whose verb has no icon worth the guess. Material's own text action, in the
// room's accent.
@Composable
fun TopAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        colors = ButtonDefaults.textButtonColors(
            contentColor = colors.primary,
            disabledContentColor = gymColors.inkFaint,
        ),
    ) {
        Text(label, style = GymType.topBarAction)
    }
}

// A sheet's head on Material's top app bar: Close dismisses the sheet as a swipe down does and the title names the sheet,
// over an optional one-line subtitle. The sheet's commit stays a full-width button at its foot, in thumb reach. The bar
// is as tall as its lines need and never less than Material's 64 dp, so large text neither clips the title nor takes
// room the body needs above the keyboard.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymSheetBar(
    title: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    closeEnabled: Boolean = true,
    subtitle: String? = null,
    subtitleSpoken: String? = null,
    subtitleIcon: (@Composable () -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val lines = measurer.measure(title, GymType.topBarTitle, maxLines = 1).size.height +
        (subtitle?.let { measurer.measure(it, GymType.nativeSupporting, maxLines = 1).size.height } ?: 0)
    TopAppBar(
        title = {
            Column {
                Text(title, style = GymType.topBarTitle, color = colors.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() })
                subtitle?.let {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.semantics(mergeDescendants = true) { subtitleSpoken?.let { contentDescription = it } }) {
                        subtitleIcon?.invoke()
                        Text(it, style = GymType.nativeSupporting, color = colors.onSurfaceVariant, maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        },
        navigationIcon = {
            IconButton(onClick = onClose, enabled = closeEnabled) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.gym_action_close), tint = colors.onSurface)
            }
        },
        expandedHeight = maxOf(64.dp, with(density) { lines.toDp() } + 16.dp),
        windowInsets = WindowInsets(0, 0, 0, 0),
        colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surfaceContainer, scrolledContainerColor = colors.surfaceContainer),
        modifier = modifier,
    )
}

@Composable
fun YouSeat(initial: String) {
    val colors = MaterialTheme.colorScheme
    val shell = LocalShellActions.current
    val yourAccount = stringResource(R.string.gym_screen_your_account)
    Box(
        Modifier.size(48.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.gym_screen_open_account), onClick = shell.openYou)
            .semantics(mergeDescendants = true) { contentDescription = yourAccount },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(colors.surfaceContainerHighest), contentAlignment = Alignment.Center) {
            Text(initial.uppercase().ifEmpty { "•" }, style = GymType.accountInitial, color = colors.onSurface,
                modifier = Modifier.clearAndSetSemantics {})
        }
    }
}
