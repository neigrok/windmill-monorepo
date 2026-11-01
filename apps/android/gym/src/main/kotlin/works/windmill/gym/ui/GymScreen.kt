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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.res.painterResource
import works.windmill.gym.R
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import works.windmill.platform.LocalShellActions

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

internal object GymChrome {
    private val font = FontFamily(Font(R.font.onboarding_nunito_bold, FontWeight.Bold))
    val title = TextStyle(fontFamily = font, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 28.sp)
    val action = TextStyle(fontFamily = font, fontWeight = FontWeight.Bold, fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp)
    val account = TextStyle(fontFamily = font, fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 20.sp)
    val tab = TextStyle(fontFamily = font, fontWeight = FontWeight.Bold, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.5.sp)
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
    val skin = LocalGymColors.current
    val scrolledUnder = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = modifier.nestedScroll(scrolledUnder.nestedScrollConnection),
        containerColor = skin.canvas,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = GymChrome.title, textAlign = titleAlignment, color = skin.ink,
                        modifier = Modifier.fillMaxWidth().semantics { heading() })
                },
                navigationIcon = {
                    if (navigation != null) navigation()
                    else onBack?.let { back ->
                        IconButton(onClick = back, modifier = Modifier.size(48.dp)) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = backTo?.let { "Back to $it" } ?: "Back",
                                tint = skin.ink, modifier = Modifier.size(24.dp))
                        }
                    }
                },
                actions = actions,
                expandedHeight = 64.dp,
                windowInsets = WindowInsets(0, 0, 0, 0),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = skin.canvas, scrolledContainerColor = skin.surface),
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
    MaterialTheme(typography = MaterialTheme.typography.copy(
        bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = .5.sp),
        bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = .4.sp),
    ), content = content)
}

// A top bar action whose verb has no icon worth the guess. Material's own text action, in the
// room's accent.
@Composable
fun TopAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val skin = LocalGymColors.current
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        colors = ButtonDefaults.textButtonColors(
            contentColor = skin.accent,
            disabledContentColor = skin.inkFaint,
        ),
    ) {
        Text(label, style = GymChrome.action)
    }
}

// The trailing mark on a row that opens something. It says nothing TalkBack needs — the row it sits
// in carries the label — so it has no description of its own.
@Composable
fun Chevron(modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Icon(painterResource(R.drawable.gym_chevron), contentDescription = null,
        tint = skin.inkDim, modifier = modifier.width(10.1771.dp).height(15.5052.dp))
}

@Composable
fun YouSeat(initial: String) {
    val skin = LocalGymColors.current
    val shell = LocalShellActions.current
    Box(
        Modifier.size(48.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClickLabel = "open your account", onClick = shell.openYou)
            .semantics(mergeDescendants = true) { contentDescription = "Your account" },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(skin.raised), contentAlignment = Alignment.Center) {
            Text(initial.uppercase().ifEmpty { "•" }, style = GymChrome.account, color = skin.ink,
                modifier = Modifier.clearAndSetSemantics {})
        }
    }
}
