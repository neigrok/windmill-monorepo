package works.windmill.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import works.windmill.gym.GymModule
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.PrefsSessions
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
    // the account below is simply nobody — a supported state, not a degraded one.
    LaunchedEffect(Unit) { auth.restore() }

    // The room waits for that answer. On iOS the hub resolves auth before any room can mount; here
    // the room IS the app, and mounting it at Unknown would run its connect-on-account lifecycle
    // once as nobody and once as the restored user — the first pass poisons the second (a resumed
    // movement reads "the log didn't answer" for a log nobody asked). The wait is one frame of the
    // basalt ground the theme already painted.
    if (auth.status is AuthStatus.Unknown) return

    var youUp by remember { mutableStateOf(false) }
    val shell = remember { ShellActions(openYou = { youUp = true }) }
    val gym = remember { GymModule() }

    // Rebuilt from the auth snapshot on every change of who is signed in, so the room's own
    // connect-on-account-change lifecycle sees the sign-in the moment the sheet finishes it.
    val account = Account(auth.api, auth.status.user)

    CompositionLocalProvider(LocalShellActions provides shell) {
        gym.Room(account)
        if (youUp) YouSheet(auth, onDismiss = { youUp = false })
    }
}
