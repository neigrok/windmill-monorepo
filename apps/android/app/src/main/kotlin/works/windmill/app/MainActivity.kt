package works.windmill.app

import android.graphics.Color
import android.os.Bundle
import android.app.KeyguardManager
import android.content.Intent
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.whenResumed
import works.windmill.gym.notification.WorkoutRoute
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
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
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.you.YouSheet
import works.windmill.platform.telemetry.LocalTelemetry

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val runtime = application as WindmillApplication
        if (savedInstanceState == null) route(intent)
        setContent {
            val dark = isSystemInDarkTheme()
            SideEffect {
                val bars = if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
                    else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }
            CompositionLocalProvider(LocalWindmillDark provides dark) { Root(runtime) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    override fun onResume() {
        super.onResume()
        (application as WindmillApplication).telemetry.event("app_foregrounded")
        (application as WindmillApplication).workoutNotifications.refreshCapabilities()
    }

    override fun onStop() {
        (application as WindmillApplication).telemetry.event("app_backgrounded")
        super.onStop()
    }

    private fun route(intent: Intent) {
        val runtime = application as WindmillApplication
        val destination = runtime.workoutNotifications.route(intent) ?: return
        val key = when (destination) {
            is WorkoutRoute.Open -> destination.key
            is WorkoutRoute.Log -> destination.command.key
        }
        lifecycleScope.launch { runtime.gym.openWorkout(key) }
        if (destination !is WorkoutRoute.Log) return
        val keyguard = getSystemService(KeyguardManager::class.java)
        fun accept() {
            if (keyguard.isDeviceLocked || isFinishing || isDestroyed) return
            lifecycleScope.launch { runtime.gym.logSet(destination.command) }
        }
        if (!keyguard.isDeviceLocked) { accept(); return }
        lifecycleScope.launch {
            lifecycle.whenResumed {
                window.decorView.post {
                    if (!isFinishing && !isDestroyed) keyguard.requestDismissKeyguard(this@MainActivity,
                        object : KeyguardManager.KeyguardDismissCallback() {
                            override fun onDismissSucceeded() { accept() }
                        })
                }
            }
        }
    }
}

@Composable
private fun Root(runtime: WindmillApplication) {
    val auth = runtime.auth
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

    var youUp by rememberSaveable { mutableStateOf(false) }
    var signIn by rememberSaveable { mutableStateOf(false) }
    var authFlow by rememberSaveable { mutableStateOf<String?>(null) }
    val shell = remember {
        ShellActions(openYou = { signIn = false; authFlow = null; youUp = true },
            openSignIn = { flow -> signIn = true; authFlow = flow; youUp = true })
    }
    val gym = remember(runtime) { GymModule(runtime.gym.store, runtime.workoutNotifications) }

    val standing = auth.status
    val accountApi = remember(auth.identityRevision, standing.user?.id) { auth.accountApi(standing.user) }
    val account = Account(accountApi, standing.user,
        verified = (standing as? AuthStatus.SignedIn)?.verified ?: true,
        resolved = standing != AuthStatus.Unknown && standing !is AuthStatus.Unresolved,
        locallyTrusted = auth.localSession !is works.windmill.platform.auth.LocalSession.Unresolved, identityRevision = auth.identityRevision,
        telemetry = runtime.telemetry)

    // WindmillMaterial wraps everything Material draws; the room's Skin wraps the room AND the
    // shell's sheet, so the sheet borrows the hosting room's colours — in gym the brand's gold
    // would read as a personal record. When roadmap and journal mount, each brings its own Skin
    // and the same door takes it.
    CompositionLocalProvider(LocalShellActions provides shell, LocalTelemetry provides runtime.telemetry) {
        WindmillMaterial {
            gym.Skin {
                Box {
                    gym.Room(account)
                    if (standing is AuthStatus.Unresolved) Column(
                        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(24.dp),
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text("Account unavailable", style = MaterialTheme.typography.headlineSmall)
                        Text("This device’s account could not be restored. Try again, or sign in.",
                            Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.bodyLarge)
                        TextButton(onClick = { scope.launch { auth.restore() } }) { Text("Try again") }
                        TextButton(onClick = { shell.openSignIn(null) }) { Text("Sign in") }
                    }
                }
                if (youUp) YouSheet(auth, onDismiss = { youUp = false },
                    destinations = shell.destinations, startSignIn = signIn, flowId = authFlow,
                    onSignedIn = shell::authenticated, onAuthDismiss = shell::authDismissed)
            }
        }
    }
}
