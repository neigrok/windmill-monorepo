package works.windmill.app

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.PrefsSessions
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.you.YouSheet

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Edge to edge on every version, not only where the platform enforces it: the room draws
        // under both bars and its own Scaffold holds the insets. The bars keep light icons, because
        // the one skin this app has is dark.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        val auth = AuthStore(WindmillApi.resolvedBaseUrl(BuildConfig.WM_API_BASE_URL), PrefsSessions(this))
        setContent { Root(auth) }
    }
}

@Composable
private fun Root(auth: AuthStore) {
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

    var youUp by remember { mutableStateOf(false) }
    val shell = remember { ShellActions(openYou = { youUp = true }) }
    val gym = remember { GymModule() }

    val standing = auth.status
    val account = Account(auth.api, standing.user,
        verified = (standing as? AuthStatus.SignedIn)?.verified ?: true)

    // WindmillMaterial must wrap everything Material draws. The gym room takes its OWN Material
    // theme inside it: the brand's primary is gold, and gold in that room means a personal record.
    // The shell's own sheet stays on the brand's.
    CompositionLocalProvider(LocalShellActions provides shell) {
        WindmillMaterial {
            GymMaterial { gym.Room(account) }
            if (youUp) YouSheet(auth, onDismiss = { youUp = false })
        }
    }
}
