package works.windmill.platform.auth

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import works.windmill.platform.User
import works.windmill.platform.net.Captured
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

sealed class AuthStatus {
    open val user: User? get() = null

    data object Unknown : AuthStatus()      // /v1/me not asked yet
    data object SignedOut : AuthStatus()
    // `verified` false: signed in, standing on the device's last-known user.
    data class SignedIn(override val user: User, val verified: Boolean = true) : AuthStatus()
}

class AuthStore(
    baseUrl: HttpUrl,
    private val sessions: SessionStore,
    client: OkHttpClient = OkHttpClient(),
) {
    var status: AuthStatus by mutableStateOf(AuthStatus.Unknown)
        private set
    var linkSentTo: String? by mutableStateOf(null)
        private set

    val api = WindmillApi(baseUrl, sessions::read, client)

    // Only a 401 spends the secret; an unreachable host or a 5xx keeps it.
    suspend fun restore() {
        if (sessions.read() == null) {
            status = AuthStatus.SignedOut
            return
        }
        status = try {
            val user = api.get<UserResponse>("/v1/me").user
            sessions.remember(user)
            AuthStatus.SignedIn(user)
        } catch (unanswered: WindmillApiException) {
            if (unanswered.isUnauthorized) {
                sessions.clear()
                AuthStatus.SignedOut
            } else {
                sessions.user()?.let { AuthStatus.SignedIn(it, verified = false) } ?: AuthStatus.SignedOut
            }
        }
    }

    suspend fun reverify() {
        val standing = status as? AuthStatus.SignedIn ?: return
        if (standing.verified) return
        restore()
    }

    // `door: "app"` makes the mail carry a 6-digit code rather than a link.
    suspend fun requestLink(email: String) {
        val address = email.trim()
        api.send<Unit>("POST", "/v1/auth/magic-link", MagicLinkRequest(address, door = "app"))
        linkSentTo = address
    }

    suspend fun completeCode(email: String, code: String) {
        val answer = api.sendCapturingSession<UserResponse>(
            "POST", "/v1/auth/verify-code", CodeRequest(email.trim(), code.trim()))
        signedIn(answer)
    }

    // Accepts either the whole magic-link URL or the bare token.
    suspend fun completeLink(pasted: String) {
        val token = MagicLink.token(pasted) ?: throw MagicLink.unreadable
        val answer = api.sendCapturingSession<UserResponse>("POST", "/v1/auth/verify", TokenRequest(token))
        signedIn(answer)
    }

    private fun signedIn(answer: Captured<UserResponse>) {
        val session = answer.session
        if (session.isNullOrEmpty()) throw MagicLink.unreadable
        sessions.write(session)
        sessions.remember(answer.reply.user)
        linkSentTo = null
        status = AuthStatus.SignedIn(answer.reply.user)
    }

    suspend fun signOut() {
        try {
            api.send<Unit>("POST", "/v1/auth/logout")
        } catch (unreachable: WindmillApiException) {
            // Sign-out is local.
        }
        sessions.clear()
        linkSentTo = null
        status = AuthStatus.SignedOut
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

interface SessionStore {
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
) : SessionStore {
    constructor(context: Context, vault: SecretVault = SecretVault.onThisDevice()) :
        this(SharedPrefsValues(context), vault)

    override fun read(): String? = kept(secretKey)

    override fun write(secret: String) {
        seal(secretKey, secret)
    }

    override fun user(): User? = kept(userKey)
        ?.let { runCatching { WindmillJson.decodeFromString<User>(it) }.getOrNull() }

    override fun remember(user: User) {
        seal(userKey, WindmillJson.encodeToString(User.serializer(), user))
    }

    override fun clear() {
        prefs.write(mapOf(
            secretKey to null, secretKey + sealed to null,
            userKey to null, userKey + sealed to null))
    }

    private fun seal(key: String, plain: String) {
        val wrapped = vault.seal(plain) ?: return
        prefs.write(mapOf(key + sealed to wrapped, key to null))
    }

    private fun kept(key: String): String? {
        prefs.read(key)?.let { fromBefore ->
            seal(key, fromBefore)
            return fromBefore
        }
        return prefs.read(key + sealed)?.let { vault.open(it) }
    }

    private companion object {
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
        edit.apply()
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
