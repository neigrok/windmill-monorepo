package works.windmill.platform.you

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import javax.crypto.KeyGenerator
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.User
import works.windmill.platform.auth.*
import works.windmill.platform.design.WindmillMaterial

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class DeleteAccountTests {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val user = User("40000000-0000-0000-0000-000000000001", "lifter@example.com")
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val vault = SecretVault { key }
    private val kept = mutableMapOf<String, String>()
    private val storage = AccountDeletionStorage(object : KeptValues {
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) { values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value } }
    }, vault)
    private var count = 3
    private var calls = 0
    private var closed = false
    private val gate = CompletableDeferred<Unit>()
    private val receipt = AccountDeletionResponse("closed", 1_795_532_000_123, "2026-11-24T14:53:20Z", 1_795_964_000_123)
    private var identity = DeletionIdentity(user, "secret", "replica-a", 0)
    private val store = AccountDeletionStore(storage, object : AccountDeletionApi {
        override suspend fun close(request: AccountDeletionRequest, credential: String): AccountDeletionResponse {
            calls++; assertEquals(user.id, request.account); assertEquals("secret", credential)
            gate.await(); return receipt
        }
        override suspend fun result(request: AccountDeletionRequest): AccountDeletionResponse = error("No pending recovery in this test")
    }, scope, { identity }, { identity = it.copy(revision = it.revision + 1); identity }, { count }, {
        object : AuthSignOutSession {
            override val account = user.id
            override val unsent = count
            override suspend fun finish(choice: AuthSignOutChoice) { assertEquals(AuthSignOutChoice.Discard, choice); closed = true }
            override suspend fun cancel() = Unit
        }
    }, { _, held -> requireNotNull(held).finish(AuthSignOutChoice.Discard) }, {})
    @After fun stop() { scope.cancel() }

    @Test fun emailAndUnsentWarningSurviveRecreationWhileButtonsPreventDuplicateDeletion() {
        store.open()
        val restoration = StateRestorationTester(compose)
        restoration.setContent { WindmillMaterial { DeleteAccount(store) {} } }
        compose.onNodeWithTag("deletion-primary").assertIsNotEnabled()
        compose.onNodeWithText("3 changes on this phone haven’t been confirmed by your account. They are deleted too.").assertExists()
        compose.onNodeWithTag("deletion-email").performTextInput("  LIFTER@example.com  ")
        compose.onNodeWithTag("deletion-primary").assertIsEnabled()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("deletion-email").assertTextContains("  LIFTER@example.com  ")
        compose.runOnIdle { count = 0; store.refreshCount() }
        compose.onNodeWithText("3 changes on this phone haven’t been confirmed by your account. They are deleted too.").assertDoesNotExist()
        compose.onNodeWithTag("deletion-primary").performClick()
        compose.onNodeWithText("Deleting…").assertExists()
        compose.onNodeWithTag("deletion-primary").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").assertIsNotEnabled()
        restoration.emulateSavedInstanceStateRestore()
        assertEquals(1, calls)
        compose.runOnIdle { gate.complete(Unit) }
        compose.onNodeWithText("Your account is deleted").assertExists()
        compose.onNodeWithText("Done").assertIsEnabled()
        assertTrue(closed)
        assertFalse(storage.blocked)
    }

    @Test fun pendingYouShowsCheckDeletionAndNoAccountTransitionActions() {
        storage.replace(null, PendingAccountDeletion(AccountDeletionRequest(user.id,
            "50000000-0000-0000-0000-000000000001", "ab".repeat(32), 1_792_940_000_123), user, "secret", "replica-a"))
        val auth = AuthStore("http://localhost/".toHttpUrl(), MemorySessions("secret", user), externalTransitionPending = { storage.blocked })
        runBlocking { auth.restore() }
        compose.setContent { WindmillMaterial { YouSheet(auth, {}, destinations = listOf(YouDestination("notes", "Notes") {}), deletion = store) } }
        compose.onNodeWithText("Deletion unconfirmed").assertExists()
        compose.onNodeWithText("Check deletion").assertIsEnabled()
        compose.onNodeWithText("Notes").assertIsEnabled()
        compose.onNodeWithText("Sign out").assertDoesNotExist()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        compose.onNodeWithText("Delete account").assertDoesNotExist()
    }

    @Test fun aConfirmedClosureWithCleanupOwedReadsFinishDeletionInYou() {
        storage.replace(null, PendingAccountDeletion(AccountDeletionRequest(user.id,
            "50000000-0000-0000-0000-000000000001", "ab".repeat(32), 1_792_940_000_123), user, "secret", "replica-a", receipt))
        val auth = AuthStore("http://localhost/".toHttpUrl(), MemorySessions("secret", user), externalTransitionPending = { storage.blocked })
        runBlocking { auth.restore() }
        compose.setContent { WindmillMaterial { YouSheet(auth, {}, deletion = store) } }
        compose.onNodeWithText("Finish deletion").assertIsEnabled()
        compose.onNodeWithText("Check deletion").assertDoesNotExist()
    }

    @Test fun signedOutYouDoesNotOfferDeletion() {
        val auth = AuthStore("http://localhost/".toHttpUrl(), MemorySessions())
        runBlocking { auth.restore() }
        compose.setContent { WindmillMaterial { YouSheet(auth, {}, deletion = store) } }
        compose.onNodeWithText("Delete account").assertDoesNotExist()
        compose.onNodeWithText("Sign in").assertExists()
    }

    @Test fun anAccountMismatchRefusalLeavesThroughTheExitSoYouReopens() {
        val mismatched = AccountDeletionStore(storage, object : AccountDeletionApi {
            override suspend fun close(request: AccountDeletionRequest, credential: String): AccountDeletionResponse =
                throw works.windmill.platform.net.WindmillApiException.Refused(409,
                    works.windmill.platform.net.Refusal(code = "account-mismatch"))
            override suspend fun result(request: AccountDeletionRequest): AccountDeletionResponse = error("No pending recovery in this test")
        }, scope, { identity }, { identity = it.copy(revision = it.revision + 1); identity }, { count }, {
            object : AuthSignOutSession {
                override val account = user.id
                override val unsent = count
                override suspend fun finish(choice: AuthSignOutChoice) = error("A refused close finishes nothing")
                override suspend fun cancel() = Unit
            }
        }, { _, _ -> error("A refused close finishes nothing") }, {})
        mismatched.open()
        val exits = mutableListOf<Boolean>()
        compose.setContent { WindmillMaterial { if (mismatched.visible) DeleteAccount(mismatched) { exits += it } } }
        compose.onNodeWithTag("deletion-email").performTextInput(user.email)
        compose.onNodeWithTag("deletion-primary").performClick()
        compose.waitUntil(5_000) { exits.isNotEmpty() }
        compose.runOnIdle {
            assertEquals(listOf(false), exits)
            assertFalse(mismatched.visible)
            assertFalse(storage.blocked)
        }
        compose.onNodeWithTag("account-deletion-page").assertDoesNotExist()
    }
}
