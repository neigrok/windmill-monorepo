package works.windmill.platform.ai

import android.content.Context
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import works.windmill.platform.User
import works.windmill.platform.auth.AuthLifecycle
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

@Serializable
data class AiAllowance(
    val code: String,
    val currency: String,
    val period: String,
    val tier: String,
    val configured: Boolean,
    val limit: String? = null,
    val used: String,
    val reserved: String,
    val remaining: String,
    val resetsAtMs: Long? = null,
    val budgetResetsAtMs: Long? = null,
)

@Serializable
data class AiInstallationResponse(val bound: Boolean, val allowance: AiAllowance, val credential: String? = null)

@Serializable
class AiInstallationRequest

class AiInstallationStorageFailure : IOException("Installation access could not be retained.")

interface AiInstallationApi {
    suspend fun issue(): AiInstallationResponse
    suspend fun current(credential: String): AiInstallationResponse
    suspend fun bind(credential: String, token: String): AiInstallationResponse
}

class AiInstallationHttp(private val baseUrl: HttpUrl, private val telemetry: Telemetry = Telemetry.None,
    private val client: OkHttpClient = OkHttpClient()) : AiInstallationApi {
    private fun api(credential: String? = null, token: String? = null) = WindmillApi(baseUrl, { token }, client, telemetry = telemetry,
        headers = credential?.let { mapOf("X-Windmill-Installation" to it) }.orEmpty())

    override suspend fun issue(): AiInstallationResponse =
        api().send("POST", "/v1/ai/installations", AiInstallationRequest(), operation = "ai_installation")

    override suspend fun current(credential: String): AiInstallationResponse =
        api(credential).get("/v1/ai/installations/current", operation = "ai_installation")

    override suspend fun bind(credential: String, token: String): AiInstallationResponse =
        api(credential, token).send("POST", "/v1/ai/installations/bind", AiInstallationRequest(), operation = "ai_installation")
}

class AiInstallation(
    private val values: KeptValues,
    private val vault: SecretVault,
    private val api: AiInstallationApi,
    private val telemetry: Telemetry = Telemetry.None,
) {
    @Serializable
    private data class Saved(val credential: String, val bound: Boolean? = null, val invalid: Boolean = false)

    private val mutex = Mutex()
    private var pending: Saved? = null
    private var currentRead = false
    private var checkedAccount: String? = null
    @Volatile private var bindingIntent = false

    @Synchronized fun retainBindingIntent() {
        bindingIntent = true
        if (!flag(bindingKey, "bound")) saveFlag(bindingKey, "bound")
    }

    private fun linked(): Boolean {
        if (bindingIntent) return true
        return flag(bindingKey, "bound").also { if (it) bindingIntent = true }
    }

    suspend fun forAnonymousSend(): String = mutex.withLock {
        if (linked()) throw WindmillApiException.Refused(409, Refusal(code = "device_bound"))
        var saved = credential()
        if (saved.invalid) throw WindmillApiException.Refused(401, Refusal(code = "invalid_installation"))
        if (linked() || saved.bound == true) throw WindmillApiException.Refused(409, Refusal(code = "device_bound"))
        if (!currentRead) {
            val response = try { api.current(saved.credential) }
            catch (failure: WindmillApiException.Refused) {
                if (failure.status == 401 && failure.refusal.code == "invalid_installation") persist(saved.copy(invalid = true))
                throw failure
            }
            saved = saved.copy(bound = response.bound)
            persist(saved)
            currentRead = true
        }
        if (linked() || saved.bound == true) throw WindmillApiException.Refused(409, Refusal(code = "device_bound"))
        saved.credential
    }

    suspend fun forRecovery(): String = mutex.withLock {
        val saved = existing() ?: throw WindmillApiException.Refused(401, Refusal(code = "invalid_installation"))
        if (saved.invalid) throw WindmillApiException.Refused(401, Refusal(code = "invalid_installation"))
        saved.credential
    }

    suspend fun markBound() = mutex.withLock {
        existing()?.let { persist(it.copy(bound = true)) }
        currentRead = true
    }

    suspend fun markInvalid() = mutex.withLock {
        existing()?.let { persist(it.copy(invalid = true)) }
    }

    suspend fun bind(account: String, token: String) {
        retainBindingIntent()
        mutex.withLock {
            if (checkedAccount == account) return@withLock
            val saved = credential()
            if (saved.invalid) return@withLock
            persist(saved.copy(bound = true))
            try {
                val response = api.bind(saved.credential, token)
                if (!response.bound) {
                    telemetry.failure("ai_installation", WindmillApiException.Malformed)
                    throw WindmillApiException.Malformed
                }
                persist(saved.copy(bound = true))
            } catch (failure: WindmillApiException.Refused) {
                when {
                    failure.status == 409 && failure.refusal.code == "installation_bound" -> persist(saved.copy(bound = true))
                    failure.status == 401 && failure.refusal.code == "invalid_installation" -> persist(saved.copy(invalid = true))
                    else -> throw failure
                }
            }
            currentRead = true
            checkedAccount = account
        }
    }

    private suspend fun credential(): Saved {
        existing()?.let { return it }
        val response = api.issue()
        val credential = response.credential
        if (credential == null || !validCredential.matches(credential) || response.bound) {
            telemetry.failure("ai_installation", WindmillApiException.Malformed)
            throw WindmillApiException.Malformed
        }
        val saved = Saved(credential, false)
        pending = saved
        persist(saved)
        currentRead = true
        return saved
    }

    private fun existing(): Saved? {
        pending?.let { persist(it); return it }
        return try {
            val sealed = values.read(key) ?: return null
            val plain = vault.open(sealed) ?: throw IOException("Installation access could not be opened.")
            WindmillJson.decodeFromString(Saved.serializer(), plain).also {
                if (!validCredential.matches(it.credential)) throw IOException("Installation access is invalid.")
            }
        } catch (failure: Exception) {
            telemetry.failure("ai_installation", IOException("Installation access could not be read."))
            throw AiInstallationStorageFailure()
        }
    }

    private fun persist(saved: Saved) {
        pending = saved
        try {
            val previous = values.read(key)
            if (previous?.let(vault::open) == WindmillJson.encodeToString(Saved.serializer(), saved)) {
                pending = null
                return
            }
            val sealed = vault.seal(WindmillJson.encodeToString(Saved.serializer(), saved))
                ?: throw IOException("Installation access could not be sealed.")
            try { values.write(mapOf(key to sealed)) }
            finally { if (values.read(key) != sealed) vault.forget(sealed) }
            previous?.let(vault::forget)
            pending = null
        } catch (failure: Exception) {
            telemetry.failure("ai_installation", IOException("Installation access could not be saved."))
            throw AiInstallationStorageFailure()
        }
    }

    private fun flag(key: String, expected: String): Boolean = state {
        val saved = values.read(key) ?: return@state false
        if (vault.open(saved) != expected) throw IOException("Installation state is unreadable.")
        true
    }

    private fun saveFlag(key: String, value: String?) = state {
        val previous = values.read(key)
        val sealed = value?.let { vault.seal(it) ?: throw IOException("Installation state could not be sealed.") }
        try { values.write(mapOf(key to sealed)) }
        finally {
            val retained = values.read(key)
            if (sealed != null && retained != sealed) vault.forget(sealed)
            if (previous != null && retained != previous) vault.forget(previous)
        }
    }

    private fun <T> state(work: () -> T): T = try { work() }
    catch (_: Exception) {
        telemetry.failure("ai_installation", IOException("Installation state could not be retained."))
        throw AiInstallationStorageFailure()
    }

    companion object {
        private const val key = "installation.sealed"
        private const val bindingKey = "binding.sealed"
        private val validCredential = Regex("[A-Za-z0-9_-]{43}")

        fun onThisDevice(context: Context, api: AiInstallationApi, telemetry: Telemetry): AiInstallation {
            val prefs = context.getSharedPreferences("works.windmill.ai", Context.MODE_PRIVATE)
            val values = object : KeptValues {
                override fun read(key: String): String? = prefs.getString(key, null)
                override fun write(values: Map<String, String?>) {
                    val edit = prefs.edit()
                    values.forEach { (key, value) -> if (value == null) edit.remove(key) else edit.putString(key, value) }
                    if (!edit.commit()) throw IOException("Installation access could not be saved.")
                }
            }
            // The installation boundary owns crypto failures under ai_installation.
            return AiInstallation(values, SecretVault.onThisDevice(Telemetry.None), api, telemetry)
        }
    }
}

class AiInstallationLifecycle(
    private val delegate: AuthLifecycle,
    private val installation: AiInstallation,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry,
) : AuthLifecycle {
    override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
        delegate.signedIn(user, token, restoring)
        try { installation.retainBindingIntent() }
        catch (_: Exception) {
            telemetry.event("ai_installation_outcome", mapOf("action" to "bind", "outcome" to "failed"))
            return
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try { installation.bind(user.id, token) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                telemetry.event("ai_installation_outcome", mapOf("action" to "bind", "outcome" to
                    if (failure is WindmillApiException.Refused) "refused" else "failed"))
            }
        }
    }

    override suspend fun signOut() = delegate.signOut()
    override suspend fun prepareSignOut(account: String) = delegate.prepareSignOut(account)
    override suspend fun recoverSignOut(account: String, choice: works.windmill.platform.auth.AuthSignOutChoice) =
        delegate.recoverSignOut(account, choice)
    override suspend fun cleanupSignOut(account: String) = delegate.cleanupSignOut(account)
    override suspend fun cancelSignIn(user: User, token: String): Boolean = delegate.cancelSignIn(user, token)
}
