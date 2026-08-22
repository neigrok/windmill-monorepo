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
    // `verified` is false while the seat stands on the device's last-known user because the server
    // could not be asked — no signal, or a 5xx — and true once /v1/me has answered for it. An
    // unverified seat is still SIGNED IN: the rooms connect for that account, off the copies the
    // device holds for it, and `reverify` asks again on the next resume.
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

    // The seat on launch. A lapsed session is a non-event (AUTH.md): drop the dead secret and show
    // the door, never an error — nobody needs to be told their 90 days ran out. But ONLY the
    // server's own 401 spends the secret: an unreachable host and a 500 say nothing about the
    // session, and clearing on them was silent sign-out — a lifter opening the app in a no-signal
    // basement lost their 90-day bearer and the queue's owed sets had nothing left to replay under.
    //
    // NOR IS A SEAT THAT COULD NOT BE ASKED A SIGNED-OUT ONE. The user this store last knew for
    // the secret is kept beside it, so a restore the server did not answer stands the seat up
    // SIGNED IN and unverified — the gym room connects for that account, on the copies the device
    // holds for it — and `reverify` asks again on the next resume. Only a phone that never learned
    // who the secret belongs to reads signed out for now, with the secret surviving for next time.
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

    // The unverified seat asked again — on resume, and on nothing else: a verified seat has been
    // answered for and a signed-out one holds no secret to ask with.
    suspend fun reverify() {
        val standing = status as? AuthStatus.SignedIn ?: return
        if (standing.verified) return
        restore()
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
        sessions.remember(answer.reply.user)
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

// Where the session secret sleeps — and, beside it, the last user the secret was answered for, so a
// launch the server cannot be asked on still knows whose seat this is. An interface so tests get a
// fake for free and never touch device-wide state a test suite must not mutate. `clear` takes both:
// a spent secret leaves no seat behind it.
interface SessionStore {
    fun read(): String?
    fun write(secret: String)
    fun user(): User?
    fun remember(user: User)
    fun clear()
}

// The Android home for the secret: an app-private SharedPreferences file, and every value in it
// SEALED (`SecretVault`) rather than written as itself. MODE_PRIVATE keeps other apps out and it
// was once described here as the whole of the protection, which was wrong in the one direction
// that mattered: it keeps nothing out of a BACKUP, and until the manifest turned backup
// participation off this file rode Android's cloud backup, device-to-device transfer and `adb
// backup` off the phone with a live 90-day bearer and an email address in the clear. The manifest
// closed the transport; this closes the bytes, so a copy taken before either change — or by
// anything nobody has thought of yet — decrypts nowhere but here.
//
// A SECRET THIS BUILD CANNOT SEAL IS NOT WRITTEN AT ALL. Falling back to plaintext on a phone
// whose Keystore refused would be the defect, quietly, on exactly the devices least able to afford
// it; the cost of refusing is a sign-in that does not survive a relaunch, which is visible and
// says what it is.
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

    // A user this build cannot read is no user: the seat reads signed out for now and the next
    // answered restore rewrites it.
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

    // Sealed on the way in, and the plaintext key removed in the same edit — an install upgrading
    // into this build carries its secret across on the first read below rather than being signed
    // out, and after that pass no cleartext copy of either value is left in the file.
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

// The key-value file under `PrefsSessions`, as an interface for one reason: SharedPreferences
// cannot be stood up without a device, and what MOBILE-4 actually turns on — that the bytes written
// are never the secret, that a phone whose Keystore refuses writes NOTHING rather than falling back
// to plaintext, and that an older build's cleartext is carried across and removed — is provable on
// the JVM the moment the file is a seam. `write` takes the whole edit at once, nulls removing, so
// putting the sealed value and dropping the plaintext beside it stay one atomic commit.
interface KeptValues {
    fun read(key: String): String?
    fun write(values: Map<String, String?>)
}

// The Android side of that seam, and the only line in this file that knows what a Context is.
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
