package works.windmill.app

import android.app.Application
import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.store.GymEngineSession
import works.windmill.platform.User
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.ProposedSignIn
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.*
import works.windmill.sync.schema.SyncSchema

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi", application = Application::class)
class SignInDecisionTests {
    private val compose = createComposeRule()
    @get:Rule val activity = RuleChain.outerRule(object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }).around(compose)

    @Test fun theOwnedDecisionAndDiscardStepSurviveRestorationModeAndFontChanges() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val engine = Engine.memory(SyncSchema.registry)
        val scopeRef = ScopeRef.product("gym")
        engine.commit(scopeRef) { Gesture(listOf(Change.create("exercise", NewID.Given(RecordID("local-movement")),
            mapOf("name" to Json.of("Local movement"), "pattern" to Json.of("isolation"), "equipment" to Json.of("barbell"), "stepKg" to Json.of(2.5))))) to Unit }
        engine.releaseHeld(true)
        val tokens = object : SessionTokens {
            private val values = mutableMapOf<String, String>()
            override fun token(account: String) = values[account]
            override fun save(account: String, token: String) { values[account] = token }
            override fun delete(account: String) { values.remove(account) }
            override fun accounts() = values.keys.toSet()
        }
        val transport = object : SyncTransport {
            override suspend fun hello(token: String?) = Reply.Answer(SyncResponse(200, Json.objectOf(
                "serverTime" to Json.of(System.currentTimeMillis()), "epoch" to Json.of("epoch"),
                "schema" to Json.of(SyncSchema.registry.version), "minSchema" to Json.of(SyncSchema.registry.minVersion),
                "as" to Json.of("A"), "holdsRecords" to Json.objectOf("gym" to Json.of(true)))))
            override suspend fun push(request: Json, token: String) = Reply.Unreachable
            override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
            override suspend fun openLive(token: String) = Reply.Unreachable
        }
        GymEngineSession(engine, SyncRuntime(engine, transport, tokens, "test", products = listOf("gym"))).use { session ->
            val user = User("A", "a@example.com")
            val sessions = MemorySessions().apply { stage(ProposedSignIn("sealed-A", user)) }
            val auth = AuthStore("https://test.invalid/".toHttpUrl(), sessions, lifecycle = session, handoffScope = scope)
            val restore = scope.async { auth.restore() }
            val dark = mutableStateOf(true)
            val font = mutableFloatStateOf(1f)
            val state = StateRestorationTester(compose)
            state.setContent {
                CompositionLocalProvider(LocalWindmillDark provides dark.value, LocalDensity provides Density(1f, font.floatValue)) {
                    WindmillMaterial { EngineAccountDecision(session, auth, Telemetry.None) }
                }
            }
            try {
                compose.waitUntil(10_000) { compose.runOnIdle { session.decision != null } }
                compose.onNodeWithText("Add to your account?").assertIsDisplayed()
                val opening = compose.runOnIdle { requireNotNull(session.decision) }
                compose.onNodeWithText("Discard").performClick()
                compose.onNodeWithText("Discard 1 movement?").assertIsDisplayed()
                state.emulateSavedInstanceStateRestore()
                compose.runOnIdle { dark.value = false; font.floatValue = 1.4f }
                compose.onNodeWithText("Discard 1 movement?").assertIsDisplayed()
                compose.onNodeWithText("Check your email").assertDoesNotExist()
                compose.runOnIdle {
                    assertSame(opening, session.decision)
                    assertEquals(mapOf("exercise" to 1), opening.decisions.single().count)
                    assertTrue(auth.handoffPending); assertFalse(restore.isCompleted)
                }
                compose.onNodeWithText("Cancel").performClick()
                compose.onNodeWithText("Add to your account?").assertIsDisplayed()
                compose.onNodeWithText("Add").performClick()
                compose.waitUntil(10_000) { compose.runOnIdle { restore.isCompleted } }
                compose.runOnIdle {
                    assertEquals(AuthStatus.SignedIn(user), auth.status)
                    assertEquals(listOf("local-movement"), engine.read(scopeRef) { it.drawn("exercise").map { row -> row.id.string } })
                    assertNull(session.decision); assertFalse(auth.handoffPending)
                }
            } finally { scope.cancel() }
        }
    }
}
