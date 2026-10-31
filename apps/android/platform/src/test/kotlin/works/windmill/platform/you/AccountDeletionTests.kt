package works.windmill.platform.you

import java.io.IOException
import javax.crypto.KeyGenerator
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.User
import works.windmill.platform.auth.*
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.telemetry.EventSchemas

@OptIn(ExperimentalCoroutinesApi::class)
class AccountDeletionTests {
    private val user = User("40000000-0000-0000-0000-000000000001", "lifter@example.com")
    private val request = AccountDeletionRequest(user.id, "50000000-0000-0000-0000-000000000001", "ab".repeat(32), 1_792_940_000_123)
    private val receipt = AccountDeletionResponse("closed", 1_795_532_000_123, "2026-11-24T14:53:20Z", 1_795_964_000_123)
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val vault = SecretVault { key }
    private class Values : KeptValues {
        val kept = mutableMapOf<String, String>()
        var fail: ((Map<String, String?>) -> Boolean)? = null
        var after = false
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) {
            val failing = fail?.invoke(values) == true
            if (failing) fail = null
            if (failing && !after) throw IOException("test private content")
            values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value }
            if (failing) throw IOException("test private content")
        }
    }
    private inner class Fixture(val scope: CoroutineScope, val values: Values = Values()) {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, String?>>()
        val retired = mutableListOf<Triple<String, Set<String>, Int>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to error.message }
            override fun retireAccount(userId: String, carrying: Set<String>) { retired += Triple(userId, carrying, cleanupCalls) }
        }
        val storage = AccountDeletionStorage(values, vault, telemetry)
        var identity: DeletionIdentity? = DeletionIdentity(user, "secret", "replica-a", 0)
        var active = "replica-a"
        var prepareCalls = 0
        var finishCalls = 0
        var cleanupCalls = 0
        var cancelCalls = 0
        var prepareGate: CompletableDeferred<Unit>? = null
        var closeGate: CompletableDeferred<Unit>? = null
        var closeFailure: Exception? = null
        var resultFailure: Exception? = null
        var cleanupFailure = false
        var count = 3
        var clock = request.requestedAtMs
        var operation = request.operationId
        val closes = mutableListOf<Pair<AccountDeletionRequest, String>>()
        val results = mutableListOf<AccountDeletionRequest>()
        val api = object : AccountDeletionApi {
            override suspend fun close(request: AccountDeletionRequest, credential: String): AccountDeletionResponse {
                closes += request to credential
                closeGate?.await()
                closeFailure?.let { throw it }
                return receipt
            }
            override suspend fun result(request: AccountDeletionRequest): AccountDeletionResponse {
                results += request
                resultFailure?.let { throw it }
                return receipt
            }
        }
        fun store() = AccountDeletionStore(storage, api, scope, { identity }, { opening ->
            check(identity == opening)
            opening.copy(revision = opening.revision + 1).also { identity = it }
        }, { count }, { opening ->
            prepareCalls++
            prepareGate?.await()
            check(identity == opening)
            object : AuthSignOutSession {
                var ended = false
                override val account = user.id
                override val unsent = count
                override suspend fun finish(choice: AuthSignOutChoice) {
                    check(!ended && choice == AuthSignOutChoice.Discard)
                    ended = true
                    finishCalls++
                    active = "anonymous"
                }
                override suspend fun cancel() { if (!ended) { ended = true; cancelCalls++ } }
            }
        }, { pending, held ->
            check(pending.replica == "replica-a")
            if (active == "replica-a") {
                if (held != null) held.finish(AuthSignOutChoice.Discard)
                else { finishCalls++; active = "anonymous" }
            } else check(active == "anonymous")
        }, {
            cleanupCalls++
            if (cleanupFailure) throw IOException("test private cleanup")
            identity = null
        }, telemetry, { clock }, { operation }, { request.proof })
    }

    @Test fun actualBackendReceiptRetainsMillisecondsWhileIsoIsTruncatedToSeconds() {
        val parsed = WindmillJson.decodeFromString<AccountDeletionResponse>("""{"state":"closed","closesMs":1795532000123,"closingOn":"2026-11-24T14:53:20Z","receiptExpiresMs":1795964000123}""")
        assertEquals(receipt, parsed)
        assertThrows(IllegalArgumentException::class.java) { receipt.copy(closingOn = "2026-11-24T14:53:21Z") }
    }

    @Test fun cancelAndInvalidEmailNeverPreparePersistOrSendAndCountRefreshes() = runTest {
        val fixture = Fixture(this)
        val store = fixture.store()
        store.open()
        assertFalse(store.emailMatches("wrong@example.com"))
        assertTrue(store.emailMatches("  LIFTER@example.com  "))
        fixture.count = 1; store.refreshCount(); assertEquals(1, store.count)
        store.confirm("wrong@example.com")
        store.back()
        assertEquals(0, fixture.prepareCalls)
        assertEquals(emptyList<Pair<AccountDeletionRequest, String>>(), fixture.closes)
        assertFalse(fixture.storage.blocked)
        assertFalse(store.visible)
    }

    @Test fun unknownDeleteUsesOnlyOriginalProofRecoveryUntilConfirmedAndCleaned() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Refused(401, Refusal(code = "unauthenticated"))
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Unknown, store.page)
        assertTrue(store.transitionPending)
        assertEquals(request, fixture.storage.pending?.request)
        assertEquals(1, fixture.cancelCalls)
        assertEquals(0, fixture.finishCalls)
        fixture.clock += AccountDeletionStore.admissionWindowMs
        fixture.resultFailure = WindmillApiException.Refused(404, Refusal(code = "unavailable"))
        store.recover()
        assertEquals(AccountDeletionPage.Unavailable, store.page)
        assertTrue(fixture.storage.blocked)
        store.back(); store.open(); store.confirm(user.email)
        fixture.resultFailure = WindmillApiException.Offline
        store.recover(); assertEquals(AccountDeletionPage.TemporarilyUnavailable, store.page)
        fixture.resultFailure = null
        store.recover()
        assertEquals(listOf(request to "secret"), fixture.closes)
        assertEquals(listOf(request, request, request), fixture.results)
        assertEquals(1, fixture.finishCalls)
        assertEquals(1, fixture.cleanupCalls)
        assertEquals(AccountDeletionPage.Deleted, store.page)
        assertEquals(receipt, store.deletedReceipt)
        assertFalse(store.transitionPending)
        assertNull(fixture.identity)
    }

    @Test fun initialAndFinishedMarkerFailuresBeforeAndAfterCommitNeverReuseAnEndedHandle() = runTest {
        for (phase in listOf("initial", "closed", "finished", "clear")) for (after in listOf(false, true)) {
            val fixture = Fixture(this)
            fixture.values.after = after
            fixture.values.fail = { values ->
                val pending = values["pending.sealed"]?.let(vault::open)?.let { WindmillJson.decodeFromString<PendingAccountDeletion>(it) }
                when (phase) {
                    "initial" -> pending != null && pending.receipt == null
                    "closed" -> pending?.receipt != null && !pending.engineFinished
                    "finished" -> pending?.engineFinished == true
                    else -> "pending.sealed" in values && pending == null
                }
            }
            val store = fixture.store(); store.open(); store.confirm(user.email)
            if (phase == "initial" && !after) {
                assertEquals(AccountDeletionPage.Confirm, store.page)
                assertEquals(0, fixture.closes.size)
                assertFalse(store.transitionPending)
                assertEquals(1, fixture.cancelCalls)
                continue
            }
            if (!after) {
                assertTrue(fixture.storage.blocked)
                assertEquals(AccountDeletionPage.Cleanup, store.page)
                store.recover()
            }
            assertEquals(AccountDeletionPage.Deleted, store.page)
            assertFalse(fixture.storage.blocked)
            assertEquals(1, fixture.finishCalls)
            assertEquals(listOf(request to "secret"), fixture.closes)
            assertTrue(fixture.results.isEmpty())
            assertTrue(fixture.failures.none { it.second?.contains("private") == true })
        }
    }

    @Test fun processDeathAfterEngineFinishBeforeMarkerAndAfterMarkerBeforeCleanupRecoversOriginal() = runTest {
        for (markerWritten in listOf(false, true)) {
            val fixture = Fixture(this)
            val pending = PendingAccountDeletion(request, user, "secret", "replica-a", receipt, markerWritten)
            fixture.storage.replace(null, pending)
            fixture.active = "anonymous"
            val restored = fixture.store()
            restored.recover()
            assertEquals(AccountDeletionPage.Deleted, restored.page)
            assertEquals(0, fixture.prepareCalls)
            assertEquals(0, fixture.finishCalls)
            assertEquals(1, fixture.cleanupCalls)
            assertTrue(fixture.closes.isEmpty() && fixture.results.isEmpty())
        }
    }

    @Test fun cleanupFailureRetainsKnownClosureAndDoesNotPollOrDiscardAgain() = runTest {
        val fixture = Fixture(this); fixture.cleanupFailure = true
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Cleanup, store.page)
        assertEquals(true, fixture.storage.pending?.engineFinished)
        store.back()
        assertTrue(fixture.storage.blocked)
        fixture.cleanupFailure = false
        fixture.store().recover()
        assertFalse(fixture.storage.blocked)
        assertEquals(1, fixture.finishCalls)
        assertEquals(2, fixture.cleanupCalls)
        assertTrue(fixture.results.isEmpty())
    }

    @Test fun aReceiptReadTheServerAnswersTemporarilyUnavailableShowsD2() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Offline
        val store = fixture.store(); store.open(); store.confirm(user.email)
        fixture.clock += AccountDeletionStore.admissionWindowMs
        fixture.resultFailure = WindmillApiException.Refused(503, Refusal(code = "temporarily_unavailable"))
        store.recover()
        assertEquals(AccountDeletionPage.TemporarilyUnavailable, store.page)
        assertTrue(fixture.storage.blocked)
        assertFalse(store.closureConfirmed)
    }

    @Test fun oneReadTimeoutFilesNoSecondReportBesideTheTransportsOwn() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Timeout(java.net.SocketTimeoutException("timeout"))
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Unknown, store.page)
        assertEquals(emptyList<Pair<String, String?>>(), fixture.failures)
        assertEquals(listOf("account_delete" to mapOf("state" to "shown"),
            "account_delete" to mapOf("action" to "confirm", "outcome" to "started"),
            "account_delete" to mapOf("outcome" to "pending_confirmation")), fixture.events)
    }

    @Test fun aDeletedAccountsQueuedDeletionEventsLeaveItsShelfBeforeEveryCleanupAttempt() = runTest {
        val fixture = Fixture(this); fixture.cleanupFailure = true
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertTrue(store.closureConfirmed)
        fixture.cleanupFailure = false
        store.recover()
        assertEquals(AccountDeletionPage.Deleted, store.page)
        assertEquals(listOf(Triple(user.id, setOf("account_delete"), 0), Triple(user.id, setOf("account_delete"), 1)), fixture.retired)
    }

    @Test fun aNewConfirmedDeletionAfterGraceRestorationCannotReuseThePriorClosedProjection() = runTest {
        val fixture = Fixture(this)
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Deleted, store.page)
        store.back()
        fixture.identity = DeletionIdentity(user, "restored-session", "replica-a", 2)
        fixture.active = "replica-a"
        fixture.operation = "50000000-0000-0000-0000-000000000002"
        fixture.closeFailure = WindmillApiException.Refused(401, Refusal(code = "unauthenticated"))
        store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Unknown, store.page)
        assertNull(store.deletedReceipt)
        assertEquals(fixture.operation, fixture.storage.pending?.request?.operationId)
        assertNull(fixture.storage.pending?.receipt)
        assertEquals(1, fixture.finishCalls)
        assertEquals(2, fixture.closes.size)
    }

    @Test fun malformedRecordFencesWithoutNormalIdentityOrNetworkRecovery() = runTest {
        val fixture = Fixture(this)
        fixture.values.kept["pending.sealed"] = "unreadable"
        fixture.storage.reload()
        val store = fixture.store(); store.recover()
        assertTrue(store.transitionPending)
        assertEquals(AccountDeletionPage.Unavailable, store.page)
        assertTrue(fixture.closes.isEmpty() && fixture.results.isEmpty())
        assertEquals(0, fixture.prepareCalls + fixture.finishCalls + fixture.cleanupCalls)
    }

    @Test fun callerCancellationAndDuplicateConfirmKeepTheSingleAppOwnedOperation() = runTest {
        val fixture = Fixture(backgroundScope); fixture.closeGate = CompletableDeferred()
        val store = fixture.store(); store.open()
        val caller = launch { store.confirm(user.email) }
        runCurrent(); assertEquals(1, fixture.closes.size)
        caller.cancelAndJoin()
        val duplicate = launch { store.confirm(user.email) }
        runCurrent(); assertEquals(1, fixture.closes.size)
        fixture.closeGate!!.complete(Unit)
        duplicate.join()
        assertEquals(AccountDeletionPage.Deleted, store.page)
        assertEquals(1, fixture.prepareCalls)
        assertEquals(1, fixture.finishCalls)
    }

    @Test fun realSessionClearReconcilesOnlyOriginalIdentityBeforeAndAfterStorageFailure() {
        for (after in listOf(false, true)) {
            val values = Values()
            val sessions = PrefsSessions(values, vault)
            sessions.commit("secret", user)
            val auth = AuthStore("http://localhost/".toHttpUrl(), sessions)
            values.after = after
            values.fail = { it["wm_identity.sealed"] == null && "wm_identity.sealed" in it }
            if (!after) assertThrows(IOException::class.java) { auth.completeAccountDeletion(user, "secret") }
            else auth.completeAccountDeletion(user, "secret")
            auth.completeAccountDeletion(user, "secret")
            assertEquals(LocalSession.Absent, sessions.localSession)
            assertEquals(AuthStatus.SignedOut, auth.status)
            val newer = user.copy(email = "changed@example.com")
            sessions.commit("new-secret", newer)
            assertThrows(IllegalStateException::class.java) { auth.completeAccountDeletion(user, "secret") }
            assertEquals(LocalSession.Owned(newer), sessions.localSession)
            val other = User("other", "other@example.com")
            sessions.commit("other-secret", other)
            auth.completeAccountDeletion(user, "secret")
            assertEquals(LocalSession.Owned(other), sessions.localSession)
        }
    }

    @Test fun onlyFreshVerifiedSignInReopensAndFailedCallbackRetriesTheSameProposal() = runTest {
        val server = okhttp3.mockwebserver.MockWebServer()
        server.start()
        val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        try {
            val sessions = MemorySessions()
            var fail = true
            val reopened = mutableListOf<User>()
            val auth = AuthStore(server.url("/"), sessions, handoffScope = owner, onVerifiedSignIn = {
                if (fail) { fail = false; throw IOException("owner write refused") }
                reopened += it
            })
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("""{"user":{"id":"${user.id}","email":"${user.email}"}}""")
                .addHeader("Set-Cookie", "wm_session=verified-secret; Path=/; HttpOnly"))
            assertTrue(runCatching { auth.completeCode(user.email, "123456") }.isFailure)
            assertEquals(ProposedSignIn("verified-secret", user), sessions.proposed)
            assertTrue(reopened.isEmpty())
            assertTrue(auth.resumePendingSignIn(user.email))
            assertEquals(listOf(user), reopened)
            assertEquals(AuthStatus.SignedIn(user), auth.status)
            assertNull(sessions.proposed)
            assertEquals(1, server.requestCount)
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("""{"user":{"id":"${user.id}","email":"${user.email}"}}"""))
            auth.restore()
            assertEquals(listOf(user), reopened)
        } finally { owner.cancel(); server.shutdown() }
    }

    @Test fun pendingDeletionRestoreNeverCallsMeOrGenericSignOutEvenWithUnreadableRecord() = runTest {
        val server = okhttp3.mockwebserver.MockWebServer()
        server.start()
        try {
            val sessions = MemorySessions("secret", user)
            val auth = AuthStore(server.url("/"), sessions, lifecycle = object : AuthLifecycle {
                override suspend fun signedIn(user: User, token: String, restoring: Boolean): Unit = error("No bootstrap during deletion")
                override suspend fun signOut(): Unit = error("No forced Keep during deletion")
            }, externalTransitionPending = { true })
            auth.restore()
            assertEquals(AuthStatus.SignedIn(user, false), auth.status)
            assertTrue(auth.transitionPending)
            assertEquals(0, server.requestCount)
            assertTrue(runCatching { auth.requestLink(user.email) }.exceptionOrNull() is CancellationException)
        } finally { server.shutdown() }
    }

    @Test fun pendingDeletionDoesNotMigrateLegacyCredentialsDuringRestore() = runTest {
        val values = Values()
        values.kept["wm_session"] = "legacy-secret"
        values.kept["wm_user"] = WindmillJson.encodeToString(User.serializer(), user)
        val retained = values.kept.toMap()
        val sessions = PrefsSessions(values, vault)
        val auth = AuthStore("http://localhost/".toHttpUrl(), sessions, externalTransitionPending = { true })
        auth.restore()
        assertEquals(AuthStatus.SignedIn(user, false), auth.status)
        assertEquals(retained, values.kept)
    }

    @Test fun deletionEventsRejectContentProofAndUnknownLabels() {
        assertEquals(mapOf("action" to "check", "outcome" to "pending_confirmation"), EventSchemas.platform.properties("account_delete",
            mapOf("action" to "check", "outcome" to "pending_confirmation", "email" to user.email, "proof" to request.proof,
                "account" to user.id, "operation" to request.operationId, "state" to "private_text")))
    }

    @Test fun aSlowClockFirstCloseTheServerCallsUnavailableClearsTheRecordAndSaysTheClockSentence() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Refused(404, Refusal(code = "unavailable"))
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Confirm, store.page)
        assertEquals(AccountDeletionStore.clockSentence, store.failure)
        assertFalse(fixture.storage.blocked)
        assertFalse(store.transitionPending)
        assertTrue(store.visible)
        assertEquals(listOf(request to "secret"), fixture.closes)
        assertTrue(fixture.results.isEmpty())
        assertEquals(1, fixture.cancelCalls)
        assertEquals(0, fixture.finishCalls)
        assertEquals(listOf("account_delete" to mapOf("state" to "shown"),
            "account_delete" to mapOf("action" to "confirm", "outcome" to "started"),
            "account_delete" to mapOf("outcome" to "refused")), fixture.events)
    }

    @Test fun anOfflineCloseIsSentAgainWithTheSameTupleInsideTheAdmissionWindow() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Offline
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.TemporarilyUnavailable, store.page)
        assertTrue(fixture.storage.blocked)
        fixture.closeFailure = null
        fixture.clock += AccountDeletionStore.admissionWindowMs - 1
        store.recover()
        assertEquals(listOf(request to "secret", request to "secret"), fixture.closes)
        assertTrue(fixture.results.isEmpty())
        assertEquals(AccountDeletionPage.Deleted, store.page)
        assertEquals(receipt, store.deletedReceipt)
        assertFalse(fixture.storage.blocked)
        assertEquals(1, fixture.finishCalls)
    }

    @Test fun aSentAgainCloseWhoseSessionIsGoneReadsTheReceipt() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Offline
        val store = fixture.store(); store.open(); store.confirm(user.email)
        fixture.closeFailure = WindmillApiException.Refused(401, Refusal(code = "unauthenticated"))
        store.recover()
        assertEquals(listOf(request to "secret", request to "secret"), fixture.closes)
        assertEquals(listOf(request), fixture.results)
        assertEquals(AccountDeletionPage.Deleted, store.page)
        assertFalse(fixture.storage.blocked)
    }

    @Test fun aSentAgainCloseThatClosedNothingClearsTheRecordWithoutReadingTheReceipt() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Offline
        val store = fixture.store(); store.open(); store.confirm(user.email)
        fixture.closeFailure = WindmillApiException.Refused(404, Refusal(code = "unavailable"))
        store.recover()
        assertEquals(AccountDeletionPage.Confirm, store.page)
        assertEquals(AccountDeletionStore.clockSentence, store.failure)
        assertEquals(user, store.confirmingUser)
        assertFalse(fixture.storage.blocked)
        assertTrue(fixture.results.isEmpty())
        assertEquals(0, fixture.finishCalls)
    }

    @Test fun outsideTheAdmissionWindowAnUnavailableReceiptKeepsThePhoneFenced() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Offline
        val store = fixture.store(); store.open(); store.confirm(user.email)
        fixture.clock += AccountDeletionStore.admissionWindowMs
        fixture.resultFailure = WindmillApiException.Refused(404, Refusal(code = "unavailable"))
        store.recover()
        assertEquals(AccountDeletionPage.Unavailable, store.page)
        assertTrue(fixture.storage.blocked)
        assertTrue(store.transitionPending)
        assertEquals(listOf(request to "secret"), fixture.closes)
        assertEquals(listOf(request), fixture.results)
    }

    @Test fun aClockAheadRefusalSaysTheClockSentenceAndOnlyAnExplicitTryAgainMintsAnotherOperation() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Refused(409, Refusal(code = "clock-ahead"))
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertEquals(AccountDeletionPage.Confirm, store.page)
        assertEquals(AccountDeletionStore.clockSentence, store.failure)
        assertFalse(fixture.storage.blocked)
        advanceUntilIdle()
        assertEquals(listOf(request to "secret"), fixture.closes)
        fixture.operation = "50000000-0000-0000-0000-000000000002"
        store.confirm(user.email)
        assertEquals(listOf(request.operationId, fixture.operation), fixture.closes.map { it.first.operationId })
        assertEquals(AccountDeletionStore.clockSentence, store.failure)
        assertEquals(2, fixture.events.count { it.second == mapOf("outcome" to "refused") })
    }

    @Test fun anAccountMismatchRefusalAsksThePageToReturnToYouWithoutACancelledStep() = runTest {
        val fixture = Fixture(this)
        fixture.closeFailure = WindmillApiException.Refused(409, Refusal(code = "account-mismatch"))
        val store = fixture.store(); store.open(); store.confirm(user.email)
        assertTrue(store.visible)
        assertTrue(store.exitRequested)
        assertEquals(AccountDeletionPage.Confirm, store.page)
        assertEquals(AccountDeletionStore.failedSentence, store.failure)
        assertFalse(fixture.storage.blocked)
        store.back()
        assertFalse(store.visible)
        assertFalse(store.exitRequested)
        assertEquals(listOf("account_delete" to mapOf("state" to "shown"),
            "account_delete" to mapOf("action" to "confirm", "outcome" to "started"),
            "account_delete" to mapOf("outcome" to "refused")), fixture.events)
    }

    @Test fun aVerifiedCodeStagedBeforeProcessDeathReopensItsOwnerWhenRestoreFinishesIt() = runTest {
        val owner = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        try {
            val sessions = MemorySessions()
            sessions.stage(ProposedSignIn("verified-secret", user))
            val reopened = mutableListOf<User>()
            val auth = AuthStore("http://127.0.0.1:9/".toHttpUrl(), sessions, handoffScope = owner, onVerifiedSignIn = { reopened += it })
            auth.restore()
            assertEquals(AuthStatus.SignedIn(user), auth.status)
            assertNull(sessions.proposed)
            assertEquals(listOf(user), reopened)
        } finally { owner.cancel() }
    }
}
