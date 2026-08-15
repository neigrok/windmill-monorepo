package works.windmill.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import works.windmill.gym.GymModule
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.PrefsSessions
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.you.YouSheet

// THE COMPOSITION ROOT — deliberately lean for a one-room app: resolve auth, build the account,
// mount gym full-screen. No hub, no switcher, no capsule — those arrive with a second room, and a
// shell that drew them now would be promising screens nobody has built. The You surface is a sheet
// the room opens through LocalShellActions; the room never learns what it looks like.
//
// Dark system bars and the basalt window ground are the theme's (res/values/themes.xml), so the
// first frame is never a white flash and nothing here restates a decision the theme already made.
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val auth = AuthStore(WindmillApi.resolvedBaseUrl(BuildConfig.WM_API_BASE_URL), PrefsSessions(this))
        setContent { Root(auth) }
    }
}

@Composable
private fun Root(auth: AuthStore) {
    // The seat on launch, asked once: a lapsed session is a non-event, and until the answer lands
    // the account below is simply nobody — a supported state, not a degraded one. A restore the
    // server could not answer stands the seat up on the device's last-known user, unverified, and
    // every return to the foreground asks again until it is — a phone that came out of a basement
    // should not have to relaunch to be sure whose seat it is.
    LaunchedEffect(Unit) { auth.restore() }
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val watcher = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) scope.launch { auth.reverify() }
        }
        lifecycleOwner.lifecycle.addObserver(watcher)
        onDispose { lifecycleOwner.lifecycle.removeObserver(watcher) }
    }

    // The room mounts IMMEDIATELY, whatever the seat turns out to be. Signed out is a working
    // state — the gym runs off the device's own shelf — so the first frame is the room over local
    // state, never a blank ground while /v1/me resolves. When restore lands a user, the account
    // below rebuilds and the room's connect-on-account-change lifecycle claims what the device
    // made in the meantime; every connect clears the per-seat answers (the last-time cache) and
    // re-asks for the movement in hand, so the second pass inherits nothing from the nobody
    // pass — not a failed read, and not a shelf answer standing where the log's should be.
    var youUp by remember { mutableStateOf(false) }
    val shell = remember { ShellActions(openYou = { youUp = true }) }
    val gym = remember { GymModule() }

    // Rebuilt from the auth snapshot on every change of who is signed in, so the room's own
    // connect-on-account-change lifecycle sees the sign-in the moment the sheet finishes it.
    val standing = auth.status
    val account = Account(auth.api, standing.user,
        verified = (standing as? AuthStatus.SignedIn)?.verified ?: true)

    // WindmillMaterial wraps EVERYTHING, and it is the root's job rather than a screen's: every
    // Material component this app draws — the sheets today, whatever is added later — reads its
    // defaults from a scheme, and without one it reads Material's baseline purple. See
    // platform/design/WindmillMaterial.kt for what that actually looked like on screen.
    CompositionLocalProvider(LocalShellActions provides shell) {
        WindmillMaterial {
            gym.Room(account)
            if (youUp) YouSheet(auth, onDismiss = { youUp = false })
        }
    }
}
