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

// Sign-in for the native superapp — the same one door the web has, reached the way a phone can
// reach it. The account is an email address (backend/AUTH.md): the mint rides `door: "app"`, so
// the mail carries a 6-DIGIT CODE and typing it here finishes the sign-in on this phone. A pasted
// magic link or bare token still works — older mails, and links minted from another surface — as
// the fallback behind the same field. The session secret the verify yields is the app's only
// credential and lives in an app-private store, never anywhere another app can read — a session is
// a 90-day bearer of someone's whole account.

sealed class AuthStatus {
    open val user: User? get() = null

    data object Unknown : AuthStatus()      // the app has not yet asked /v1/me — the seat is a ghost, not empty
    data object SignedOut : AuthStatus()
    data class SignedIn(override val user: User) : AuthStatus()
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

    // The seat on launch. A lapsed session is a non-event (AUTH.md): drop the dead secret and show
    // the door, never an error — nobody needs to be told their 90 days ran out. But ONLY the
    // server's own 401 spends the secret: an unreachable host and a 500 say nothing about the
    // session, and clearing on them was silent sign-out — a lifter opening the app in a no-signal
    // basement lost their 90-day bearer and the queue's owed sets had nothing left to replay under.
    // The seat reads signed out for now, the secret survives, and the next restore reclaims it.
    suspend fun restore() {
        if (sessions.read() == null) {
            status = AuthStatus.SignedOut
            return
        }
        status = try {
            AuthStatus.SignedIn(api.get<UserResponse>("/v1/me").user)
        } catch (unanswered: WindmillApiException) {
            if (unanswered.isUnauthorized) sessions.clear()
            AuthStatus.SignedOut
        }
    }

    // `door: "app"` is what makes the mail carry a code rather than a link — a link would open the
    // web app and burn itself there; a code finishes where the person is standing.
    suspend fun requestLink(email: String) {
        val address = email.trim()
        api.send<Unit>("POST", "/v1/auth/magic-link", MagicLinkRequest(address, door = "app"))
        linkSentTo = address
    }

    // The emailed six digits, typed back with the address they were sent to.
    suspend fun completeCode(email: String, code: String) {
        val answer = api.sendCapturingSession<UserResponse>(
            "POST", "/v1/auth/verify-code", CodeRequest(email.trim(), code.trim()))
        signedIn(answer)
    }

    // The fallback door: a magic link from an older mail or another surface's request, pasted as
    // whatever the person was looking at — the whole URL or the bare token. Both land here, and
    // both are accepted: asking someone to extract a token out of a URL is asking them to do the
    // parser's job.
    suspend fun completeLink(pasted: String) {
        val token = MagicLink.token(pasted) ?: throw MagicLink.unreadable
        val answer = api.sendCapturingSession<UserResponse>("POST", "/v1/auth/verify", TokenRequest(token))
        signedIn(answer)
    }

    // Both doors end the same way: the cookie is the credential, and no cookie is no sign-in.
    private fun signedIn(answer: Captured<UserResponse>) {
        val session = answer.session
        if (session.isNullOrEmpty()) throw MagicLink.unreadable
        sessions.write(session)
        linkSentTo = null
        status = AuthStatus.SignedIn(answer.reply.user)
    }

    suspend fun signOut() {
        try {
            api.send<Unit>("POST", "/v1/auth/logout")
        } catch (unreachable: WindmillApiException) {
            // Signing out is a local decision; a server that could not be told still loses the
            // session when its 15-minute link or 90-day window lapses.
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

// The fallback parser, for the pasted-link door behind the code field. The emailed link is
// `{app}/#/auth?token=…` — the token lives in the URL *fragment*, so the obvious reading (a query
// parser) finds nothing. This is the whole reason this is a tested function and not two lines at a
// call site.
object MagicLink {
    val unreadable: WindmillApiException = WindmillApiException.Refused(400, Refusal())

    // One fact, one sentence per credential, wherever it fails. The server collapses wrong,
    // expired, burned and unknown into the one 410 on purpose, so the door repeats the one
    // sentence rather than guessing which it was.
    const val expired = "That link has expired. Links work once and last 15 minutes — send a fresh one."
    const val expiredCode = "That code has expired. Codes work once and last 15 minutes — send a fresh one."

    // And it is not always that fact. A request that never reached the server has not expired
    // anything, and "send a fresh one" is advice nobody offline can follow — so only the failure
    // that is really about the credential gets the sentence about it.
    fun refusal(failure: Throwable, ofCode: Boolean = false): String {
        if (failure is WindmillApiException.Offline) return failure.line
        return if (ofCode) expiredCode else expired
    }

    fun token(pasted: String): String? {
        val trimmed = pasted.trim()
        if (trimmed.isEmpty()) return null
        if (!trimmed.contains("://") && !trimmed.contains("token=")) return trimmed

        // Everything after the first `token=`, up to whatever ends it. Works on the fragment form,
        // on a plain query, and on a link a mail client wrapped in tracking parameters.
        val start = trimmed.indexOf("token=")
        if (start < 0) return null
        val token = trimmed.substring(start + "token=".length)
            .takeWhile { it != '&' && it != '#' && !it.isWhitespace() }
        return token.ifEmpty { null }
    }
}

// Where the session secret sleeps. An interface so tests get a fake for free and never touch
// device-wide state a test suite must not mutate.
interface SessionStore {
    fun read(): String?
    fun write(secret: String)
    fun clear()
}

// The Android home for the secret: an app-private SharedPreferences file. MODE_PRIVATE is the
// whole of the protection — hardware-backed storage (the Keychain's true analog) would cost a
// dependency this app does not carry yet, and the file is unreadable to other apps either way.
class PrefsSessions(context: Context) : SessionStore {
    private val prefs = context.getSharedPreferences("works.windmill.session", Context.MODE_PRIVATE)

    override fun read(): String? = prefs.getString("wm_session", null)

    override fun write(secret: String) {
        prefs.edit().putString("wm_session", secret).apply()
    }

    override fun clear() {
        prefs.edit().remove("wm_session").apply()
    }
}

class MemorySessions(private var secret: String? = null) : SessionStore {
    @Synchronized override fun read(): String? = secret
    @Synchronized override fun write(secret: String) { this.secret = secret }
    @Synchronized override fun clear() { secret = null }
}
