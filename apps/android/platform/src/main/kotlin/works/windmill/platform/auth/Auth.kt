package works.windmill.platform.auth

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.Serializable
import kotlinx.coroutines.CancellationException
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import works.windmill.platform.User
import works.windmill.platform.net.Captured
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

sealed class AuthStatus {
    open val user: User? get() = null

    data object Unknown : AuthStatus()      // /v1/me not asked yet
    data object SignedOut : AuthStatus()
    data class Unresolved(override val user: User? = null) : AuthStatus()
    // `verified` false: signed in, standing on the device's last-known user.
    data class SignedIn(override val user: User, val verified: Boolean = true) : AuthStatus()
}

class AuthStore(
    private val baseUrl: HttpUrl,
    private val sessions: SessionStore,
    private val client: OkHttpClient = OkHttpClient(),
    val telemetry: Telemetry = Telemetry.None,
) {
    var status: AuthStatus by mutableStateOf(AuthStatus.Unknown)
        private set
    var linkSentTo: String? by mutableStateOf(null)
        private set

    val api = WindmillApi(baseUrl, sessions::read, client, telemetry)
    val localSession: LocalSession get() = sessions.localSession
    private var generation = 0L
    var identityRevision by mutableStateOf(0L)
        private set

    fun accountApi(user: User?): WindmillApi {
        val secret = sessions.read()
        return WindmillApi(baseUrl, credential = {
            val local = sessions.localSession
            if (user != null && local is LocalSession.Owned && local.user.id == user.id && sessions.read() == secret) secret else null
        }, client = client, telemetry = telemetry)
    }

    // Only a 401 spends the secret; an unreachable host or a 5xx keeps it.
    suspend fun restore() {
        val attempt = generation
        if (sessions.read() == null) {
            status = if (sessions.localSession == LocalSession.Absent) AuthStatus.SignedOut else AuthStatus.Unresolved(sessions.localSession.user)
            telemetry.identity(status.user?.id)
            telemetry.event("auth_restore", mapOf("outcome" to if (status == AuthStatus.SignedOut) "signed_out" else "unresolved"))
            if (status is AuthStatus.Unresolved) telemetry.failure("auth_local_identity", IllegalStateException("Saved account unavailable"))
            return
        }
        try {
            val user = api.get<UserResponse>("/v1/me").user
            if (attempt != generation) return
            sessions.remember(user)
            status = AuthStatus.SignedIn(user)
            telemetry.identity(user.id)
            telemetry.event("auth_restore", mapOf("outcome" to "verified"))
        } catch (unanswered: WindmillApiException) {
            if (attempt != generation) return
            if (unanswered.isUnauthorized) {
                sessions.clear()
                identityRevision += 1
                status = AuthStatus.SignedOut
                telemetry.identity(null)
            } else {
                status = when (val local = sessions.localSession) {
                    LocalSession.Absent -> AuthStatus.SignedOut
                    is LocalSession.Owned -> AuthStatus.SignedIn(local.user, verified = false)
                    is LocalSession.Unresolved -> AuthStatus.Unresolved(local.user)
                }
            }
            telemetry.event("auth_restore", mapOf("outcome" to if (unanswered.isUnauthorized) "expired" else "unverified"))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            telemetry.failure("auth_restore", failure)
            if (attempt == generation) status = AuthStatus.Unresolved(sessions.user())
        }
    }

    suspend fun reverify() {
        if (status is AuthStatus.Unresolved) { restore(); return }
        val standing = status as? AuthStatus.SignedIn ?: return
        if (standing.verified) return
        restore()
    }

    // `door: "app"` makes the mail carry a 6-digit code rather than a link.
    suspend fun requestLink(email: String) {
        telemetry.event("auth_code_requested")
        val attempt = generation
        val address = email.trim()
        api.send<Unit>("POST", "/v1/auth/magic-link", MagicLinkRequest(address, door = "app"))
        if (attempt != generation) throw CancellationException("Authentication changed.")
        linkSentTo = address
        telemetry.event("auth_code_sent")
    }

    suspend fun completeCode(email: String, code: String, beforeCommit: (User) -> Unit = {}) {
        telemetry.event("auth_sign_in_started", mapOf("method" to "code"))
        val attempt = ++generation
        val answer = api.sendCapturingSession<UserResponse>(
            "POST", "/v1/auth/verify-code", CodeRequest(email.trim(), code.trim()))
        if (attempt != generation) throw CancellationException("Authentication changed.")
        if (answer.session.isNullOrEmpty()) throw MagicLink.unreadable
        beforeCommit(answer.reply.user)
        if (attempt != generation) throw CancellationException("Authentication changed.")
        signedIn(answer)
    }

    // Accepts either the whole magic-link URL or the bare token.
    suspend fun completeLink(pasted: String, beforeCommit: (User) -> Unit = {}) {
        telemetry.event("auth_sign_in_started", mapOf("method" to "link"))
        val attempt = ++generation
        val token = MagicLink.token(pasted) ?: throw MagicLink.unreadable
        val answer = api.sendCapturingSession<UserResponse>("POST", "/v1/auth/verify", TokenRequest(token))
        if (attempt != generation) throw CancellationException("Authentication changed.")
        if (answer.session.isNullOrEmpty()) throw MagicLink.unreadable
        beforeCommit(answer.reply.user)
        if (attempt != generation) throw CancellationException("Authentication changed.")
        signedIn(answer)
    }

    private fun signedIn(answer: Captured<UserResponse>) {
        val session = answer.session
        if (session.isNullOrEmpty()) throw MagicLink.unreadable
        try { sessions.commit(session, answer.reply.user) }
        catch (failure: Exception) {
            identityRevision += 1
            status = AuthStatus.Unresolved(status.user)
            throw failure
        }
        identityRevision += 1
        linkSentTo = null
        status = AuthStatus.SignedIn(answer.reply.user)
        telemetry.identity(answer.reply.user.id)
        telemetry.event("auth_signed_in")
    }

    suspend fun signOut() {
        val attempt = ++generation
        try {
            api.send<Unit>("POST", "/v1/auth/logout")
        } catch (unreachable: WindmillApiException) {
            // Sign-out is local.
        }
        if (attempt != generation) return
        sessions.clear()
        identityRevision += 1
        linkSentTo = null
        status = AuthStatus.SignedOut
        telemetry.identity(null)
        telemetry.event("auth_signed_out")
    }
}

@Serializable
data class MagicLinkRequest(val email: String, val door: String)

@Serializable
data class CodeRequest(val email: String, val code: String)

@Serializable
data class TokenRequest(val token: String)

@Serializable
data class UserResponse(val user: User)

// The emailed link is `{app}/#/auth?token=…`: the token is in the fragment, not the query.
object MagicLink {
    val unreadable: WindmillApiException = WindmillApiException.Refused(400, Refusal())

    const val expired = "That link has expired. Links work once and last 15 minutes — send a fresh one."
    const val expiredCode = "That code has expired. Codes work once and last 15 minutes — send a fresh one."

    fun refusal(failure: Throwable, ofCode: Boolean = false): String {
        if (failure is WindmillApiException.Offline) return failure.line
        return if (ofCode) expiredCode else expired
    }

    fun token(pasted: String): String? {
        val trimmed = pasted.trim()
        if (trimmed.isEmpty()) return null
        if (!trimmed.contains("://") && !trimmed.contains("token=")) return trimmed

        val start = trimmed.indexOf("token=")
        if (start < 0) return null
        val token = trimmed.substring(start + "token=".length)
            .takeWhile { it != '&' && it != '#' && !it.isWhitespace() }
        return token.ifEmpty { null }
    }
}

sealed interface LocalSession {
    val user: User? get() = null
    data object Absent : LocalSession
    data class Owned(override val user: User) : LocalSession
    data class Unresolved(override val user: User? = null) : LocalSession
}

@Serializable
private data class SavedSession(val secret: String, val user: User, val version: Int = 1) {
    init { require(version == 1 && secret.isNotBlank() && user.id.isNotBlank()) }
}

interface SessionStore {
    val localSession: LocalSession get() {
        val secret = read()
        val user = user()
        if (secret == null && user == null) return LocalSession.Absent
        return if (!secret.isNullOrBlank() && user != null) LocalSession.Owned(user) else LocalSession.Unresolved(user)
    }
    fun commit(secret: String, user: User) { write(secret); remember(user) }
    fun read(): String?
    fun write(secret: String)
    fun user(): User?
    fun remember(user: User)
    fun clear()
}

// A secret that cannot be sealed is not written at all — never fall back to plaintext.
class PrefsSessions(
    private val prefs: KeptValues,
    private val vault: SecretVault = SecretVault.onThisDevice(),
    private val telemetry: Telemetry = Telemetry.None,
) : SessionStore {
    constructor(context: Context, vault: SecretVault? = null, telemetry: Telemetry = Telemetry.None) :
        this(SharedPrefsValues(context), vault ?: SecretVault.onThisDevice(telemetry), telemetry)

    private var unavailable = false

    override val localSession: LocalSession get() {
        if (unavailable) return LocalSession.Unresolved()
        if (prefs.read(bundleKey) != null) return saved()?.let { LocalSession.Owned(it.user) } ?: LocalSession.Unresolved()
        val present = listOf(secretKey, secretKey + sealed, userKey, userKey + sealed).any { prefs.read(it) != null }
        val known = (prefs.read(userKey) ?: prefs.read(userKey + sealed)?.let(vault::open))
            ?.let { runCatching { WindmillJson.decodeFromString<User>(it) }.onFailure { telemetry.failure("session_user_decode", it) }.getOrNull() }
        return if (present) LocalSession.Unresolved(known) else LocalSession.Absent
    }

    private fun persist(values: Map<String, String?>) {
        check(!unavailable) { "Restart the app to recover the saved account." }
        try { prefs.write(values) }
        catch (failure: Exception) { unavailable = true; throw failure }
    }

    private fun saved(): SavedSession? = prefs.read(bundleKey)?.let { encoded ->
        vault.open(encoded)?.let { runCatching { WindmillJson.decodeFromString<SavedSession>(it) }.onFailure { telemetry.failure("session_decode", it) }.getOrNull() }
    }

    override fun commit(secret: String, user: User) {
        val value = WindmillJson.encodeToString(SavedSession.serializer(), SavedSession(secret, user))
        val encoded = vault.seal(value) ?: throw java.io.IOException("The session could not be sealed.")
        persist(mapOf(bundleKey to encoded, secretKey to null, secretKey + sealed to null,
            userKey to null, userKey + sealed to null))
    }

    override fun read(): String? = if (unavailable) null else if (prefs.read(bundleKey) != null) saved()?.secret else kept(secretKey)

    override fun write(secret: String) {
        val encoded = vault.seal(secret) ?: return
        persist(mapOf(secretKey + sealed to encoded, secretKey to null, bundleKey to null))
    }

    override fun user(): User? = if (unavailable) null else if (prefs.read(bundleKey) != null) saved()?.user else kept(userKey)
        ?.let { runCatching { WindmillJson.decodeFromString<User>(it) }.onFailure { telemetry.failure("session_user_decode", it) }.getOrNull() }

    override fun remember(user: User) {
        val secret = read()
        if (secret != null) { commit(secret, user); return }
        seal(userKey, WindmillJson.encodeToString(User.serializer(), user))
    }

    override fun clear() {
        persist(mapOf(
            bundleKey to null, secretKey to null, secretKey + sealed to null,
            userKey to null, userKey + sealed to null))
    }

    private fun seal(key: String, plain: String) {
        val wrapped = vault.seal(plain) ?: return
        persist(mapOf(key + sealed to wrapped, key to null))
    }

    private fun kept(key: String): String? {
        prefs.read(key)?.let { fromBefore ->
            try { seal(key, fromBefore) } catch (failure: Exception) { telemetry.failure("session_migrate", failure); return null }
            return fromBefore
        }
        return prefs.read(key + sealed)?.let { vault.open(it) }
    }

    private companion object {
        const val bundleKey = "wm_identity.sealed"
        const val secretKey = "wm_session"
        const val userKey = "wm_user"
        const val sealed = ".sealed"
    }
}

// `write` takes the whole edit at once, nulls removing, so a seal and its plaintext drop are one
// commit.
interface KeptValues {
    fun read(key: String): String?
    fun write(values: Map<String, String?>)
}

private class SharedPrefsValues(context: Context) : KeptValues {
    private val prefs = context.getSharedPreferences("works.windmill.session", Context.MODE_PRIVATE)

    override fun read(key: String): String? = prefs.getString(key, null)

    override fun write(values: Map<String, String?>) {
        val edit = prefs.edit()
        for ((key, value) in values) {
            if (value == null) edit.remove(key) else edit.putString(key, value)
        }
        if (!edit.commit()) throw java.io.IOException("The session could not be saved.")
    }
}

class MemorySessions(private var secret: String? = null, private var known: User? = null) : SessionStore {
    @Synchronized override fun read(): String? = secret
    @Synchronized override fun write(secret: String) { this.secret = secret }
    @Synchronized override fun user(): User? = known
    @Synchronized override fun remember(user: User) { known = user }
    @Synchronized override fun clear() {
        secret = null
        known = null
    }
}
