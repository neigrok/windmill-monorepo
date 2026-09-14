package works.windmill.gym.ui

import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymModule
import works.windmill.gym.GymRoom
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.LocalShellActions
import works.windmill.platform.ShellActions
import works.windmill.platform.User
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.you.YouSheet

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class AccountRouteTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun auth(signedIn: Boolean, restoreNow: Boolean = true, response: () -> Int = { 200 }): AuthStore {
        val user = User("u1", "sam@example.com", "Sam")
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(response()).message("OK")
                .body("""{"user":{"id":"u1","email":"sam@example.com","name":"Sam"}}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        return AuthStore("https://windmill.works/".toHttpUrl(),
            MemorySessions(if (signedIn) "session-u1" else null, if (signedIn) user else null), client)
            .also { if (restoreNow) runBlocking { it.restore() } }
    }

    private fun store(scope: CoroutineScope, server: FakeTraining) = TrainingStore(
        SetQueue(File(tmp.root, "queue.json")), DeviceCopy(File(tmp.root, "catalog.json")),
        LocalLog(File(tmp.root, "local.json")), LocalPreferences(File(tmp.root, "prefs.json")),
        LocalBodyweight(File(tmp.root, "weights.json")), scope,
        sync = { if (it.isSignedIn) server else null },
    )

    @Test
    fun connectedLogRoundTripKeepsTheRegisteredAccountDestinations() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val auth = auth(signedIn = true)
        val store = store(scope, FakeTraining())
        lateinit var shell: ShellActions
        compose.setContent { AccountRoot(auth, store) { shell = it } }
        compose.onNodeWithContentDescription("Your account").performClick()
        val first = shell
        assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("You").assertDoesNotExist()
        compose.onNodeWithContentDescription("Back to Routines").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        assertSame("the root retained its ShellActions instance", first, shell)
        assertEquals("closing a child route must not unregister the still-mounted GymRoom",
            listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun signedOutSettingsRoundTripKeepsTheSameAccountOverview() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val auth = auth(signedIn = false)
        val store = store(scope, FakeTraining())
        lateinit var shell: ShellActions
        compose.setContent { AccountRoot(auth, store) { shell = it } }
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("You").assertDoesNotExist()
        compose.onNodeWithContentDescription("Back to Routines").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun moduleOwnedStoreKeepsDestinationsAfterAConnectedLogRoundTrip() {
        val auth = auth(signedIn = true)
        lateinit var shell: ShellActions
        compose.setContent { AccountRoot(auth, null) { shell = it } }
        compose.onNodeWithContentDescription("Your account").performClick()
        val first = shell
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Back to Routines").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        assertSame(first, shell)
        assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
    }

    @Test
    fun moduleDefaultStoreRegistersTheRestoredAccountOverview() {
        val auth = auth(signedIn = true)
        lateinit var shell: ShellActions
        val restoration = StateRestorationTester(compose)
        restoration.setContent { AccountRoot(auth, null) { shell = it } }
        compose.onNodeWithContentDescription("Your account").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("You").assertIsDisplayed()
        assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
    }

    @Test
    fun restoredOverviewKeepsItsRoutesAcrossDelayedStartupAuthentication() {
        val hold = AtomicBoolean(false)
        val release = CountDownLatch(1)
        lateinit var auth: AuthStore
        lateinit var shell: ShellActions
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            val current = remember {
                auth(signedIn = true, restoreNow = false) {
                    if (hold.get()) check(release.await(5, TimeUnit.SECONDS))
                    200
                }
            }
            SideEffect { auth = current }
            AccountRoot(current, null) { shell = it }
        }
        compose.onNodeWithContentDescription("Your account").performClick()
        hold.set(true)
        try {
            restoration.emulateSavedInstanceStateRestore()
            compose.onNodeWithText("You").assertIsDisplayed()
            compose.runOnIdle { assertEquals(AuthStatus.Unknown, auth.status) }
            assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
            release.countDown()
            compose.waitUntil(5_000) { auth.status is AuthStatus.SignedIn }
            compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).performClick()
            compose.onNodeWithContentDescription("Back to Routines").performClick()
            compose.onNodeWithContentDescription("Your account").performClick()
            assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
            compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
            compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        } finally { release.countDown() }
    }

    @Test
    fun sameOwnerVerificationChangesKeepRoutesBetweenAccountOpens() {
        val reply = AtomicInteger(200)
        val auth = auth(signedIn = true, response = { reply.get() })
        lateinit var shell: ShellActions
        compose.setContent { AccountRoot(auth, null) { shell = it } }
        compose.onNodeWithContentDescription("Your account").performClick()
        val first = shell
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Back to Routines").performClick()
        reply.set(503)
        runBlocking { auth.restore() }
        compose.runOnIdle { assertEquals(AuthStatus.SignedIn(User("u1", "sam@example.com", "Sam"), verified = false), auth.status) }
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Back to Routines").performClick()
        reply.set(200)
        runBlocking { auth.reverify() }
        compose.onNodeWithContentDescription("Your account").performClick()
        assertSame(first, shell)
        assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
    }

    @Test
    fun restoredAccountOverviewRegistersDestinationsWithTheFreshShellAndStore() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val auth = auth(signedIn = true)
        val server = FakeTraining()
        val restoration = StateRestorationTester(compose)
        lateinit var shell: ShellActions
        var stores = 0
        restoration.setContent {
            val store = remember { stores++; store(scope, server) }
            AccountRoot(auth, store) { shell = it }
        }
        compose.onNodeWithContentDescription("Your account").performClick()
        val first = shell
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("You").assertIsDisplayed()
        assertNotSame(first, shell)
        assertEquals(2, stores)
        assertEquals(listOf("settings", "connections"), shell.destinations.map { it.id })
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Back to Routines").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNode(hasText("Gym settings") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNode(hasText("Connected log") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        scope.cancel()
    }
}

@Composable
private fun AccountRoot(auth: AuthStore, store: TrainingStore?, onShell: (ShellActions) -> Unit) {
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
    val context = androidx.compose.ui.platform.LocalContext.current
    val ownedStore = store ?: remember {
        TrainingStore(SetQueue(File(context.filesDir, SetQueue.fileName)),
            DeviceCopy(File(context.filesDir, DeviceCopy.fileName)),
            LocalLog(File(context.filesDir, LocalLog.fileName)),
            LocalPreferences(File(context.filesDir, LocalPreferences.fileName)),
            LocalBodyweight(File(context.filesDir, LocalBodyweight.fileName)), scope)
    }
    val module = remember(ownedStore) { GymModule(ownedStore) }
    val standing = auth.status
    val account = Account(auth.api, standing.user,
        verified = (standing as? AuthStatus.SignedIn)?.verified ?: true,
        resolved = standing != AuthStatus.Unknown)
    CompositionLocalProvider(LocalShellActions provides shell) {
        WindmillMaterial {
            module.Skin {
                if (store == null) module.Room(account) else GymRoom(account, store)
                if (youUp) YouSheet(auth, onDismiss = { youUp = false },
                    destinations = shell.destinations, startSignIn = signIn, flowId = authFlow,
                    onSignedIn = shell::authenticated, onAuthDismiss = shell::authDismissed)
            }
        }
    }
    SideEffect { onShell(shell) }
}
