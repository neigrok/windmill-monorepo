package works.windmill.platform.you

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.IOException
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import works.windmill.platform.User
import works.windmill.platform.auth.AuthSignOutSession
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

@Serializable
data class AccountDeletionRequest(val account: String, val operationId: String, val proof: String, val requestedAtMs: Long) {
    init {
        require(UUID.fromString(account).toString() == account && UUID.fromString(operationId).toString() == operationId)
        require(proof.matches(Regex("[0-9a-f]{64}")) && requestedAtMs in 1 until 9_007_199_254_740_992L)
    }
}

@Serializable
data class AccountDeletionResponse(val state: String, val closesMs: Long, val closingOn: String, val receiptExpiresMs: Long) {
    init {
        require(state == "closed" && closesMs > 0 && receiptExpiresMs > closesMs)
        require(Instant.parse(closingOn).epochSecond == closesMs / 1_000)
    }
}

@Serializable
data class PendingAccountDeletion(val request: AccountDeletionRequest, val user: User, val credential: String,
    val replica: String, val receipt: AccountDeletionResponse? = null, val engineFinished: Boolean = false) {
    init {
        require(request.account == user.id && credential.isNotBlank() && replica.isNotBlank())
        require(!engineFinished || receipt != null)
    }
}

data class DeletionIdentity(val user: User, val credential: String, val replica: String, val revision: Long)

enum class AccountDeletionPage { Confirm, Deleting, Unknown, Offline, Unavailable, Cleanup, Deleted }

class AccountDeletionStorage(private val values: KeptValues, private val vault: SecretVault,
    private val telemetry: Telemetry = Telemetry.None) {
    companion object {
        private const val key = "pending.sealed"
        fun onThisDevice(context: Context, vault: SecretVault, telemetry: Telemetry): AccountDeletionStorage {
            val prefs = context.getSharedPreferences("windmill-account-deletion", Context.MODE_PRIVATE)
            return AccountDeletionStorage(object : KeptValues {
                override fun read(key: String) = prefs.getString(key, null)
                override fun write(values: Map<String, String?>) {
                    val editor = prefs.edit()
                    values.forEach { (key, value) -> if (value == null) editor.remove(key) else editor.putString(key, value) }
                    if (!editor.commit()) throw IOException("Account deletion could not be saved.")
                }
            }, vault, telemetry)
        }
    }
    var unreadable by mutableStateOf(false)
        private set
    var pending by mutableStateOf<PendingAccountDeletion?>(null)
        private set
    val blocked: Boolean get() = unreadable || pending != null

    init { reload() }

    @Synchronized fun reload() {
        try {
            val sealed = values.read(key)
            pending = sealed?.let {
                val plain = vault.open(it) ?: throw IOException("Account deletion could not be opened.")
                WindmillJson.decodeFromString<PendingAccountDeletion>(plain)
            }
            unreadable = false
        } catch (_: Exception) {
            pending = null
            unreadable = true
            telemetry.failure("account_delete_storage", IOException("Account deletion could not be read."))
        }
    }

    @Synchronized fun replace(expected: PendingAccountDeletion?, next: PendingAccountDeletion?) {
        reload()
        check(!unreadable && pending == expected) { "The account deletion changed." }
        val before = values.read(key)
        val sealed = next?.let {
            vault.seal(WindmillJson.encodeToString(PendingAccountDeletion.serializer(), it))
                ?: throw IOException("Account deletion could not be sealed.")
        }
        try {
            values.write(mapOf(key to sealed))
        } catch (_: Exception) {
            telemetry.failure("account_delete_storage", IOException("Account deletion could not be saved."))
            reload()
            if (unreadable || pending != next) throw IOException("Account deletion could not be saved.")
        } finally {
            val retained = runCatching { values.read(key) }.getOrNull()
            listOfNotNull(before, sealed).filter { it != retained }.forEach(vault::forget)
        }
        reload()
        check(!unreadable && pending == next) { "Account deletion could not be verified." }
    }
}

interface AccountDeletionApi {
    suspend fun close(request: AccountDeletionRequest, credential: String): AccountDeletionResponse
    suspend fun result(request: AccountDeletionRequest): AccountDeletionResponse
}

class AccountDeletionHttp(private val baseUrl: HttpUrl, private val telemetry: Telemetry,
    private val client: OkHttpClient = OkHttpClient()) : AccountDeletionApi {
    override suspend fun close(request: AccountDeletionRequest, credential: String): AccountDeletionResponse =
        WindmillApi(baseUrl, { credential }, client, telemetry).send("DELETE", "/v1/me", request, operation = "account_delete_request")
    override suspend fun result(request: AccountDeletionRequest): AccountDeletionResponse =
        WindmillApi(baseUrl, { null }, client, telemetry).send("POST", "/v1/account-deletion/result", request, operation = "account_delete_result")
}

class AccountDeletionStore(
    val storage: AccountDeletionStorage,
    private val api: AccountDeletionApi,
    private val scope: CoroutineScope,
    private val identity: () -> DeletionIdentity?,
    private val begin: (DeletionIdentity) -> DeletionIdentity,
    private val unsent: () -> Int,
    private val prepare: suspend (DeletionIdentity) -> AuthSignOutSession,
    private val finishEngine: suspend (PendingAccountDeletion, AuthSignOutSession?) -> Unit,
    private val cleanup: suspend (PendingAccountDeletion) -> Unit,
    private val telemetry: Telemetry = Telemetry.None,
    private val now: () -> Long = System::currentTimeMillis,
    private val operationId: () -> String = { UUID.randomUUID().toString() },
    private val proof: () -> String = { ByteArray(32).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) } },
) {
    var visible by mutableStateOf(storage.blocked)
        private set
    var page by mutableStateOf(when {
        storage.unreadable -> AccountDeletionPage.Unavailable
        storage.pending?.receipt != null -> AccountDeletionPage.Cleanup
        storage.pending != null -> AccountDeletionPage.Unknown
        else -> AccountDeletionPage.Confirm
    })
        private set
    var busy by mutableStateOf(false)
        private set
    var confirmingUser by mutableStateOf<User?>(null)
        private set
    var count by mutableStateOf(0)
        private set
    var failure by mutableStateOf<String?>(null)
        private set
    var deletedReceipt by mutableStateOf<AccountDeletionResponse?>(null)
        private set
    var exitRequested by mutableStateOf(false)
        private set
    private var preparing by mutableStateOf(false)
    val transitionPending: Boolean get() = preparing || storage.blocked
    var operationRevision by mutableStateOf(0L)
        private set
    private var work: Deferred<Unit>? = null
    private var held: AuthSignOutSession? = null
    private var finishedOperation: String? = null
    private var knownClosed: Pair<PendingAccountDeletion, AccountDeletionResponse>? = null

    fun open() {
        if (busy) { visible = true; return }
        if (storage.blocked) {
            page = when {
                storage.unreadable -> AccountDeletionPage.Unavailable
                storage.pending?.receipt != null -> AccountDeletionPage.Cleanup
                else -> AccountDeletionPage.Unknown
            }
        } else {
            confirmingUser = identity()?.user ?: return
            deletedReceipt = null
            finishedOperation = null
            knownClosed = null
            count = unsent()
            failure = null
            page = AccountDeletionPage.Confirm
        }
        exitRequested = false
        visible = true
        telemetry.event("account_delete", mapOf("state" to "shown"))
    }

    fun refreshCount() {
        if (visible && page == AccountDeletionPage.Confirm && !transitionPending && identity()?.user == confirmingUser) count = unsent()
    }

    fun emailMatches(value: String): Boolean = confirmingUser?.email?.let { it.trim().equals(value.trim(), ignoreCase = true) } == true

    suspend fun back() {
        if (busy) return
        releaseHold()
        preparing = false
        operationRevision += 1
        visible = false
        if (exitRequested) { exitRequested = false; return }
        telemetry.event("account_delete", mapOf("action" to if (page == AccountDeletionPage.Deleted) "done" else "back"))
        if (!storage.blocked && page != AccountDeletionPage.Deleted)
            telemetry.event("account_delete", mapOf("outcome" to "cancelled"))
    }

    suspend fun confirm(email: String) = run {
        if (storage.blocked || !emailMatches(email)) return@run
        val captured = identity()?.takeIf { it.user == confirmingUser } ?: return@run
        val opening = begin(captured)
        telemetry.event("account_delete", mapOf("action" to "confirm", "outcome" to "started"))
        preparing = true
        operationRevision += 1
        page = AccountDeletionPage.Deleting
        failure = null
        var submitted = false
        var attempted: PendingAccountDeletion? = null
        try {
            val handle = prepare(opening)
            held = handle
            val current = identity()
            check(current?.user == opening.user && current.credential == opening.credential && current.revision == opening.revision && handle.account == opening.user.id) {
                "The account changed."
            }
            val record = PendingAccountDeletion(AccountDeletionRequest(opening.user.id, operationId(), proof(), now()),
                opening.user, opening.credential, current.replica)
            storage.replace(null, record)
            attempted = record
            submitted = true
            val receipt = api.close(record.request, opening.credential)
            accept(record, receipt)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (refusal: WindmillApiException.Refused) {
            if (submitted && closedNothing(refusal)) refused(requireNotNull(attempted), refusal) else uncertain(refusal)
        } catch (failure: Exception) {
            if (submitted || storage.blocked) uncertain(failure)
            else {
                releaseHold()
                preparing = false
                page = AccountDeletionPage.Confirm
                this.failure = failedSentence
                report(failure, "account_delete_prepare")
                telemetry.event("account_delete", mapOf("outcome" to "failed"))
            }
        }
    }

    suspend fun recover() = run {
        telemetry.event("account_delete", mapOf("action" to if (page == AccountDeletionPage.Cleanup) "cleanup" else "check", "outcome" to "started"))
        storage.reload()
        if (storage.unreadable) { page = AccountDeletionPage.Unavailable; return@run }
        val pending = storage.pending ?: return@run
        preparing = true
        operationRevision += 1
        try {
            if (pending.receipt != null) clean(pending)
            else if (knownClosed?.first?.request == pending.request) accept(pending, requireNotNull(knownClosed).second)
            else if (admissible(pending.request)) resend(pending)
            else accept(pending, api.result(pending.request))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { uncertain(failure) }
    }

    // The session is checked before the operation, so a 401 here means a committed close revoked it or it lapsed.
    private suspend fun resend(pending: PendingAccountDeletion) {
        try { accept(pending, api.close(pending.request, pending.credential)) }
        catch (refusal: WindmillApiException.Refused) {
            when {
                closedNothing(refusal) -> refused(pending, refusal)
                refusal.status == 401 -> accept(pending, api.result(pending.request))
                else -> throw refusal
            }
        }
    }

    private fun admissible(request: AccountDeletionRequest): Boolean =
        now() - request.requestedAtMs in 0 until admissionWindowMs

    // A 404 from the close itself is an authenticated session with no committed operation: a slow phone clock.
    private fun closedNothing(refusal: WindmillApiException.Refused): Boolean =
        refusal.status == 400 && refusal.refusal.code == "malformed" ||
            refusal.status == 409 && refusal.refusal.code in setOf("account-mismatch", "clock-ahead") ||
            refusal.status == 404 && refusal.refusal.code == "unavailable"

    private suspend fun refused(attempted: PendingAccountDeletion, refusal: WindmillApiException.Refused) {
        storage.replace(attempted, null)
        releaseHold()
        preparing = false
        knownClosed = null
        confirmingUser = identity()?.user?.takeIf { it.id == attempted.user.id } ?: confirmingUser
        count = unsent()
        page = AccountDeletionPage.Confirm
        failure = if (refusal.refusal.code in setOf("clock-ahead", "unavailable")) clockSentence else failedSentence
        telemetry.event("account_delete", mapOf("outcome" to "refused"))
        if (refusal.refusal.code == "account-mismatch") exitRequested = true
    }

    private suspend fun accept(expected: PendingAccountDeletion, receipt: AccountDeletionResponse) {
        check(storage.pending?.request == expected.request) { "The account deletion changed." }
        knownClosed = expected to receipt
        val next = expected.copy(receipt = receipt)
        storage.replace(expected, next)
        clean(next)
    }

    private suspend fun clean(opening: PendingAccountDeletion) {
        page = AccountDeletionPage.Cleanup
        var pending = opening
        try {
            if (!pending.engineFinished) {
                if (finishedOperation != pending.request.operationId) {
                    finishEngine(pending, held)
                    held = null
                    finishedOperation = pending.request.operationId
                }
                val next = pending.copy(engineFinished = true)
                storage.replace(pending, next)
                pending = next
            }
            cleanup(pending)
            storage.replace(pending, null)
            preparing = false
            confirmingUser = null
            deletedReceipt = pending.receipt
            knownClosed = null
            page = AccountDeletionPage.Deleted
            telemetry.event("account_delete", mapOf("outcome" to "ok"))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            report(failure, "account_delete_cleanup")
            page = AccountDeletionPage.Cleanup
            telemetry.event("account_delete", mapOf("outcome" to "cleanup_pending"))
        }
    }

    private suspend fun uncertain(failure: Exception) {
        report(failure, "account_delete_recovery")
        page = if (storage.pending?.receipt != null || finishedOperation != null && finishedOperation == storage.pending?.request?.operationId || knownClosed != null) AccountDeletionPage.Cleanup
            else if (storage.unreadable || failure is WindmillApiException.Refused && failure.status == 404) AccountDeletionPage.Unavailable
            else if (failure is WindmillApiException.Offline) AccountDeletionPage.Offline else AccountDeletionPage.Unknown
        releaseHold()
        preparing = false
        telemetry.event("account_delete", mapOf("outcome" to
            if (page == AccountDeletionPage.Cleanup) "cleanup_pending" else "pending_confirmation"))
    }

    private suspend fun releaseHold() {
        val opening = held ?: return
        withContext(NonCancellable) { opening.cancel() }
        if (held === opening) held = null
    }

    private fun report(failure: Exception, operation: String) {
        if (failure !is WindmillApiException.Offline && failure !is WindmillApiException.Refused)
            telemetry.failure(operation, IOException("Account deletion could not be completed."))
    }

    private suspend fun run(body: suspend () -> Unit) {
        work?.takeIf { it.isActive }?.let { it.await(); return }
        work = scope.async(start = CoroutineStart.LAZY) {
            busy = true
            try { body() }
            catch (cancelled: CancellationException) {
                releaseHold()
                preparing = false
                throw cancelled
            } catch (failure: Exception) {
                report(failure, "account_delete_recovery")
                page = if (storage.blocked) AccountDeletionPage.Unavailable else AccountDeletionPage.Confirm
                this@AccountDeletionStore.failure = failedSentence
                try { releaseHold(); preparing = false }
                catch (_: Exception) { preparing = true }
            } finally { busy = false }
        }.also { it.start() }
        requireNotNull(work).await()
    }

    companion object {
        const val admissionWindowMs = 5 * 60 * 1_000L
        const val failedSentence = "Couldn’t delete your account. Check your connection and try again."
        // The clock refusal's sentence awaits design; it says the failed sentence until it is drawn.
        const val clockSentence = failedSentence
    }
}
