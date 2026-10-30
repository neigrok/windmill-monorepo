package works.windmill.platform.auth

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.Serializable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import works.windmill.platform.User
import works.windmill.platform.net.Captured
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

class AuthHandoffFailure internal constructor() : Exception()

@Serializable
enum class AuthSignOutChoice { Keep, Discard }

@Serializable
data class SignOutIntent(val account: String, val choice: AuthSignOutChoice, val engineFinished: Boolean = false) {
    init { require(account.isNotBlank()) }
}

enum class SignOutStorage { Current, Cleared, Unavailable }

data class AuthSignOutQuestion(val unsent: Int)

interface AuthSignOutSession {
    val account: String
    val unsent: Int
    suspend fun finish(choice: AuthSignOutChoice)
    suspend fun cancel()
}

enum class AuthHandoffResult { Accepted, Refused, Failed, Retired }

sealed class AuthStatus {
    open val user: User? get() = null

    data object Unknown : AuthStatus()      // /v1/me not asked yet
    data object SignedOut : AuthStatus()
    data class Unresolved(override val user: User? = null) : AuthStatus()
    // `verified` false: signed in, standing on the device's last-known user.
    data class SignedIn(override val user: User, val verified: Boolean = true) : AuthStatus()
}

class AuthStore(
    val baseUrl: HttpUrl,
    private val sessions: SessionStore,
    private val client: OkHttpClient = OkHttpClient(),
    val telemetry: Telemetry = Telemetry.None,
    private val lifecycle: AuthLifecycle = AuthLifecycle.None,
    private val handoffScope: CoroutineScope? = null,
) {
    var status: AuthStatus by mutableStateOf(AuthStatus.Unknown)
        private set
    var linkSentTo: String? by mutableStateOf(null)
        private set

    val api = WindmillApi(baseUrl, sessions::read, client, telemetry)
    val localSession: LocalSession get() = sessions.localSession
    private var generation = 0L
    val accountOperationRevision: Long get() = generation
    private class Handoff(val proposed: ProposedSignIn, val attempt: Long, val revision: Long, val work: Deferred<Unit>)
    private var handoff: Handoff? = null
    var handoffPending by mutableStateOf(false)
        private set
    var handoffRevision by mutableStateOf(0L)
        private set
    var handoffResult: AuthHandoffResult? by mutableStateOf(null)
        private set
    var identityRevision by mutableStateOf(0L)
        private set

    private data class SignOutOpening(val user: User, val secret: String?, val attempt: Long, val revision: Long,
        var handle: AuthSignOutSession? = null, var engineFinished: Boolean = false, var choice: AuthSignOutChoice? = null)
    private var signOutOpening: SignOutOpening? = null
    private var signOutJob: Deferred<Unit>? = null
    private var signOutError: Exception? = null
    private var signOutTransition by mutableStateOf(false)
    val transitionPending: Boolean get() = signOutTransition || sessions.signOutPending
    var signOutQuestion by mutableStateOf<AuthSignOutQuestion?>(null)
        private set
    var signOutBusy by mutableStateOf(false)
        private set
    var signOutFailure by mutableStateOf<String?>(null)
        private set

    private fun requireNoTransition() {
        if (transitionPending) throw CancellationException("An account transition is pending.")
    }

    fun accountApi(user: User?): WindmillApi {
        val secret = sessions.read()
        return WindmillApi(baseUrl, credential = {
            val local = sessions.localSession
            if (!transitionPending && user != null && local is LocalSession.Owned && local.user.id == user.id && sessions.read() == secret) secret else null
        }, client = client, telemetry = telemetry)
    }

    // Only a 401 spends the secret; an unreachable host or a 5xx keeps it.
    suspend fun restore() {
        if (signOutBusy) return
        if (sessions.signOutPending || signOutOpening?.choice != null) {
            runSignOutWork { recoverSignOut() }
            if (signOutFailure != null) status = AuthStatus.Unresolved(sessions.user() ?: signOutOpening?.user)
            return
        }
        if (signOutTransition) return
        val attempt = generation
        sessions.proposed?.let { proposed ->
            try { finishOwned(proposed, attempt, restoring = true) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (attempt != generation) return
                status = currentStanding()
                telemetry.event("auth_restore", mapOf("outcome" to "unverified"))
            }
            return
        }
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
            lifecycle.signedIn(user, requireNotNull(sessions.read()), restoring = true)
            if (attempt != generation) return
            status = AuthStatus.SignedIn(user)
            telemetry.identity(user.id)
            telemetry.event("auth_restore", mapOf("outcome" to "verified"))
        } catch (unanswered: WindmillApiException) {
            if (attempt != generation) return
            if (unanswered.isUnauthorized) {
                lifecycle.signOut()
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
        if (transitionPending) return
        if (handoffPending || handoffResult == AuthHandoffResult.Failed || handoffResult == AuthHandoffResult.Refused) return
        if (status is AuthStatus.Unresolved) { restore(); return }
        val standing = status as? AuthStatus.SignedIn ?: return
        if (standing.verified) return
        restore()
    }

    // `door: "app"` makes the mail carry a 6-digit code rather than a link.
    suspend fun requestLink(email: String) {
        requireNoTransition()
        telemetry.event("auth_code_requested")
        val attempt = generation
        val address = email.trim()
        api.send<Unit>("POST", "/v1/auth/magic-link", MagicLinkRequest(address, door = "app"))
        if (attempt != generation) throw CancellationException("Authentication changed.")
        linkSentTo = address
        telemetry.event("auth_code_sent")
    }

    suspend fun completeCode(email: String, code: String, beforeCommit: (User) -> Unit = {}) {
        requireNoTransition()
        telemetry.event("auth_sign_in_started", mapOf("method" to "code"))
        val attempt = ++generation
        retireHandoff()
        if (attempt != generation) throw CancellationException("Authentication changed.")
        val answer = api.sendCapturingSession<UserResponse>(
            "POST", "/v1/auth/verify-code", CodeRequest(email.trim(), code.trim()))
        if (attempt != generation) throw CancellationException("Authentication changed.")
        if (answer.session.isNullOrEmpty()) throw MagicLink.unreadable
        beforeCommit(answer.reply.user)
        if (attempt != generation) throw CancellationException("Authentication changed.")
        signedIn(answer, attempt)
    }

    // Accepts either the whole magic-link URL or the bare token.
    suspend fun completeLink(pasted: String, beforeCommit: (User) -> Unit = {}) {
        requireNoTransition()
        telemetry.event("auth_sign_in_started", mapOf("method" to "link"))
        val attempt = ++generation
        retireHandoff()
        if (attempt != generation) throw CancellationException("Authentication changed.")
        val token = MagicLink.token(pasted) ?: throw MagicLink.unreadable
        val answer = api.sendCapturingSession<UserResponse>("POST", "/v1/auth/verify", TokenRequest(token))
        if (attempt != generation) throw CancellationException("Authentication changed.")
        if (answer.session.isNullOrEmpty()) throw MagicLink.unreadable
        beforeCommit(answer.reply.user)
        if (attempt != generation) throw CancellationException("Authentication changed.")
        signedIn(answer, attempt)
    }

    private suspend fun signedIn(answer: Captured<UserResponse>, attempt: Long) {
        val session = answer.session
        if (session.isNullOrEmpty()) throw MagicLink.unreadable
        val proposed = ProposedSignIn(session, answer.reply.user)
        try { sessions.stage(proposed) }
        catch (failure: Exception) {
            identityRevision += 1
            status = currentStanding()
            throw failure
        }
        finishOwned(proposed, attempt, restoring = false)
    }

    private suspend fun finishOwned(proposed: ProposedSignIn, attempt: Long, restoring: Boolean) {
        val owner = handoffScope ?: return finishProposed(proposed, attempt, restoring)
        handoff?.takeIf { handoffPending && it.proposed == proposed && it.attempt == attempt }?.let { it.work.await(); return }
        lateinit var next: Handoff
        val work = owner.async(start = CoroutineStart.LAZY) {
            try {
                finishProposed(proposed, attempt, restoring)
                if (handoff === next && attempt == generation) handoffResult = AuthHandoffResult.Accepted
            } catch (cancelled: CancellationException) {
                if (handoff === next) handoffResult = AuthHandoffResult.Retired
                throw cancelled
            } catch (refused: WindmillApiException) {
                if (handoff === next) handoffResult = AuthHandoffResult.Refused
                throw refused
            } catch (failure: Exception) {
                if (handoff === next) handoffResult = AuthHandoffResult.Failed
                telemetry.failure("auth_sign_in", failure)
                throw AuthHandoffFailure()
            } finally {
                if (handoff === next) handoffPending = false
            }
        }
        handoffRevision += 1
        next = Handoff(proposed, attempt, handoffRevision, work)
        handoff = next
        handoffResult = null
        handoffPending = true
        work.start()
        work.await()
    }

    suspend fun awaitExistingHandoff(revision: Long): Boolean {
        val opening = handoff?.takeIf { it.revision == revision && it.attempt == generation } ?: return false
        opening.work.await()
        return handoff === opening && opening.attempt == generation && handoffResult == AuthHandoffResult.Accepted &&
            sessions.localSession == LocalSession.Owned(opening.proposed.user) && sessions.read() == opening.proposed.secret
    }

    private suspend fun retireHandoff(opening: Handoff? = handoff) {
        opening ?: return
        if (handoff === opening) handoffResult = AuthHandoffResult.Retired
        opening.work.cancelAndJoin()
        if (handoff === opening) { handoff = null; handoffPending = false }
    }

    suspend fun resumePendingSignIn(email: String): Boolean {
        requireNoTransition()
        if (handoffScope == null) return false
        val proposed = sessions.proposed?.takeIf { it.user.email.equals(email.trim(), ignoreCase = true) } ?: return false
        finishOwned(proposed, generation, restoring = false)
        return true
    }

    suspend fun cancelPendingSignIn() {
        requireNoTransition()
        val attempt = ++generation
        val opening = handoff
        val proposed = sessions.proposed
        suspend fun cancel() {
            if (attempt != generation) return
            retireHandoff(opening)
            if (attempt != generation) return
            if (proposed != null && sessions.proposed == proposed) {
                lifecycle.cancelSignIn(proposed.user, proposed.secret)
                if (attempt == generation) sessions.clearProposed(proposed)
            }
            if (attempt != generation) return
            val standing = currentStanding()
            val verified = status as? AuthStatus.SignedIn
            status = if (verified?.verified == true && standing is AuthStatus.SignedIn && verified.user == standing.user) verified else standing
            linkSentTo = null
        }
        val owner = handoffScope
        if (owner == null) cancel() else owner.async(start = CoroutineStart.UNDISPATCHED) {
            try { cancel() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (refused: WindmillApiException) { throw refused }
            catch (failure: Exception) {
                telemetry.failure("auth_sign_in", failure)
                throw AuthHandoffFailure()
            }
        }.await()
    }

    private fun currentStanding(): AuthStatus = when (val local = sessions.localSession) {
        LocalSession.Absent -> AuthStatus.SignedOut
        is LocalSession.Owned -> AuthStatus.SignedIn(local.user, verified = false)
        is LocalSession.Unresolved -> AuthStatus.Unresolved(local.user ?: status.user)
    }

    private suspend fun finishProposed(proposed: ProposedSignIn, attempt: Long, restoring: Boolean) {
        try {
            lifecycle.signedIn(proposed.user, proposed.secret, restoring)
            if (attempt != generation || sessions.proposed != proposed) throw CancellationException("Authentication changed.")
            sessions.publishProposed(proposed)
        } catch (cancelled: CancellationException) {
            val completed = withContext(NonCancellable) { lifecycle.cancelSignIn(proposed.user, proposed.secret) }
            val accepted = completed && sessions.proposed == proposed
            if (accepted) sessions.publishProposed(proposed) else sessions.clearProposed(proposed)
            if (accepted && sessions.localSession == LocalSession.Owned(proposed.user) && sessions.read() == proposed.secret) {
                identityRevision += 1
                status = AuthStatus.SignedIn(proposed.user)
                telemetry.identity(proposed.user.id)
            } else if (attempt == generation) status = currentStanding()
            throw cancelled
        } catch (failure: Exception) {
            if (failure is WindmillApiException && failure.isUnauthorized) {
                lifecycle.cancelSignIn(proposed.user, proposed.secret)
                sessions.clearProposed(proposed)
            }
            if (attempt == generation) status = currentStanding()
            throw failure
        }
        identityRevision += 1
        linkSentTo = null
        status = AuthStatus.SignedIn(proposed.user)
        telemetry.identity(proposed.user.id)
        telemetry.event(if (restoring) "auth_restore" else "auth_signed_in", if (restoring) mapOf("outcome" to "verified") else emptyMap())
    }

    private suspend fun runSignOutWork(body: suspend () -> Unit) {
        signOutJob?.takeIf { it.isActive }?.let { it.await(); return }
        suspend fun run() {
            signOutBusy = true
            signOutFailure = null
            signOutError = null
            try { body() }
            catch (cancelled: CancellationException) {
                if (!sessions.signOutPending && signOutOpening?.choice == null) {
                    val opening = signOutOpening
                    try { withContext(NonCancellable) { opening?.handle?.cancel() } }
                    catch (failure: Exception) {
                        telemetry.failure("auth_sign_out", failure)
                        signOutFailure = "Sign-out could not be saved. Your work is still on this phone. Try again."
                        signOutQuestion = opening?.handle?.let { AuthSignOutQuestion(it.unsent) }
                        throw cancelled
                    }
                    if (signOutOpening === opening) {
                        signOutOpening = null
                        signOutQuestion = null
                        signOutTransition = false
                        generation += 1
                    }
                }
                throw cancelled
            }
            catch (failure: Exception) {
                telemetry.failure("auth_sign_out", failure)
                signOutError = failure
                signOutFailure = "Sign-out could not be saved. Your work is still on this phone. Try again."
                signOutQuestion = null
                if (!sessions.signOutPending && signOutOpening?.handle == null && signOutOpening?.choice == null) {
                    signOutTransition = false
                    signOutOpening = null
                    generation += 1
                }
            } finally { signOutBusy = false }
        }
        val owner = handoffScope
        if (owner == null) run()
        else owner.async(start = CoroutineStart.LAZY) { run() }.also { signOutJob = it; it.start() }.await()
    }

    private fun current(opening: SignOutOpening): Boolean = signOutOpening === opening &&
        opening.attempt == generation && opening.revision == identityRevision &&
        sessions.user()?.id == opening.user.id && sessions.read() == opening.secret

    suspend fun prepareSignOut() = runSignOutWork {
        if (sessions.signOutPending || signOutOpening?.choice != null) { recoverSignOut(); return@runSignOutWork }
        signOutOpening?.let { opening ->
            if (current(opening) && opening.handle != null) {
                signOutQuestion = AuthSignOutQuestion(requireNotNull(opening.handle).unsent)
                return@runSignOutWork
            }
        }
        requireNoTransition()
        if (handoffPending) return@runSignOutWork
        val user = (status as? AuthStatus.SignedIn)?.user ?: return@runSignOutWork
        if (sessions.localSession != LocalSession.Owned(user)) return@runSignOutWork
        val opening = SignOutOpening(user, sessions.read(), ++generation, identityRevision)
        signOutOpening = opening
        signOutTransition = true
        retireHandoff()
        if (!current(opening)) throw CancellationException("The account changed.")
        val handle = lifecycle.prepareSignOut(user.id)
        if (!current(opening) || handle.account != user.id) {
            withContext(NonCancellable) { handle.cancel() }
            signOutTransition = false
            signOutOpening = null
            throw CancellationException("The account changed.")
        }
        opening.handle = handle
        signOutQuestion = AuthSignOutQuestion(handle.unsent)
    }

    suspend fun cancelSignOut() = runSignOutWork {
        if (sessions.signOutPending) return@runSignOutWork
        val opening = signOutOpening ?: return@runSignOutWork
        opening.handle?.cancel()
        if (signOutOpening !== opening) return@runSignOutWork
        signOutOpening = null
        signOutQuestion = null
        signOutTransition = false
        generation += 1
    }

    suspend fun confirmSignOut(choice: AuthSignOutChoice) = runSignOutWork {
        val opening = signOutOpening ?: return@runSignOutWork
        if (!current(opening) || signOutQuestion == null) return@runSignOutWork
        opening.choice = choice
        sessions.beginSignOut(SignOutIntent(opening.user.id, choice))
        finishSignOut(opening, requireNotNull(sessions.pendingSignOut))
    }

    private suspend fun recoverSignOut() {
        signOutTransition = true
        val retained = signOutOpening?.takeIf { it.attempt == generation && it.revision == identityRevision && it.choice != null }
        if (retained != null) {
            val choice = requireNotNull(retained.choice)
            when (sessions.reconcileSignOut(retained.user, retained.secret, choice, retained.engineFinished)) {
                SignOutStorage.Unavailable -> error("The saved sign-out could not be recovered.")
                SignOutStorage.Cleared -> { completeSignOut(retained); return }
                SignOutStorage.Current -> Unit
            }
            val intent = sessions.pendingSignOut ?: SignOutIntent(retained.user.id, choice, retained.engineFinished)
                .also(sessions::beginSignOut)
            finishSignOut(retained, intent)
            return
        }
        val intent = requireNotNull(sessions.pendingSignOut) { "The saved sign-out could not be read." }
        val user = requireNotNull(sessions.user()) { "The saved account could not be read." }
        check(user.id == intent.account) { "The account changed." }
        val opening = SignOutOpening(user, sessions.read(), ++generation, identityRevision, choice = intent.choice)
        signOutOpening = opening
        finishSignOut(opening, intent)
    }

    private suspend fun finishSignOut(opening: SignOutOpening, intent: SignOutIntent) {
        check(current(opening) && intent.account == opening.user.id) { "The account changed." }
        signOutQuestion = null
        opening.engineFinished = opening.engineFinished || intent.engineFinished
        if (!opening.engineFinished) {
            val handle = opening.handle
            if (handle != null) handle.finish(intent.choice)
            else lifecycle.recoverSignOut(intent.account, intent.choice)
            opening.engineFinished = true
        }
        check(current(opening)) { "The account changed." }
        if (!intent.engineFinished) sessions.beginSignOut(intent.copy(engineFinished = true))
        lifecycle.cleanupSignOut(intent.account)
        check(current(opening)) { "The account changed." }
        sessions.clear()
        completeSignOut(opening)
    }

    private fun completeSignOut(opening: SignOutOpening) {
        check(signOutOpening === opening && opening.attempt == generation && opening.revision == identityRevision)
        identityRevision += 1
        generation += 1
        linkSentTo = null
        status = AuthStatus.SignedOut
        signOutOpening = null
        signOutQuestion = null
        signOutTransition = false
        telemetry.identity(null)
        telemetry.event("auth_signed_out")
        val secret = opening.secret
        if (secret != null) handoffScope?.launch {
            try { WindmillApi(baseUrl, { secret }, client, telemetry).send<Unit>("POST", "/v1/auth/logout") }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: WindmillApiException) { }
            catch (failure: Exception) { telemetry.failure("auth_logout", failure) }
        }
    }

    suspend fun signOut() {
        if (status == AuthStatus.Unknown) (sessions.localSession as? LocalSession.Owned)?.let {
            status = AuthStatus.SignedIn(it.user, verified = false)
        }
        prepareSignOut()
        signOutError?.let { throw it }
        if (signOutQuestion != null) confirmSignOut(AuthSignOutChoice.Keep)
        signOutError?.let { throw it }
    }

}

interface AuthLifecycle {
    suspend fun signedIn(user: User, token: String, restoring: Boolean)
    suspend fun signOut()
    suspend fun prepareSignOut(account: String): AuthSignOutSession = object : AuthSignOutSession {
        override val account = account
        override val unsent = 0
        override suspend fun finish(choice: AuthSignOutChoice) {
            check(choice == AuthSignOutChoice.Keep) { "Discard requires an account-aware lifecycle." }
            signOut()
        }
        override suspend fun cancel() = Unit
    }
    suspend fun recoverSignOut(account: String, choice: AuthSignOutChoice) {
        check(choice == AuthSignOutChoice.Keep) { "Discard requires an account-aware lifecycle." }
        signOut()
    }
    suspend fun cleanupSignOut(account: String) = Unit
    suspend fun cancelSignIn(user: User, token: String): Boolean = false

    object None : AuthLifecycle {
        override suspend fun signedIn(user: User, token: String, restoring: Boolean) = Unit
        override suspend fun signOut() = Unit
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
        if (failure is WindmillApiException.Refused) {
            if (failure.status == 426) return failure.line
            val message = failure.refusal.message?.trim().orEmpty()
            val detail = failure.refusal.detail?.trim().orEmpty()
            if (message.isNotEmpty() && detail.isNotEmpty()) {
                val punctuation = if (message.last() in ".!?…") "" else "."
                return "$message$punctuation $detail"
            }
            if (message.isNotEmpty()) return message
            if (detail.isNotEmpty()) return detail
        }
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

data class ProposedSignIn(val secret: String, val user: User)

interface SessionStore {
    val pendingSignOut: SignOutIntent? get() = null
    val signOutPending: Boolean get() = pendingSignOut != null
    fun beginSignOut(intent: SignOutIntent) {}
    fun beginSignOut() { user()?.let { beginSignOut(SignOutIntent(it.id, AuthSignOutChoice.Keep)) } }
    fun reconcileSignOut(user: User, secret: String?, choice: AuthSignOutChoice, engineFinished: Boolean): SignOutStorage {
        if (engineFinished && this.user() == null && read() == null && !signOutPending) return SignOutStorage.Cleared
        val intent = pendingSignOut
        if (this.user() != user || read() != secret || signOutPending &&
            (intent?.account != user.id || intent?.choice != choice)) return SignOutStorage.Unavailable
        return SignOutStorage.Current
    }
    val proposed: ProposedSignIn? get() = null
    fun stage(proposed: ProposedSignIn) { commit(proposed.secret, proposed.user) }
    fun publishProposed(expected: ProposedSignIn) {}
    fun clearProposed(expected: ProposedSignIn? = null) {}
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
    private val vault: SecretVault,
    private val telemetry: Telemetry = Telemetry.None,
) : SessionStore {
    constructor(context: Context, vault: SecretVault, telemetry: Telemetry) : this(SharedPrefsValues(context), vault, telemetry)

    private var unavailable = false
    override val signOutPending: Boolean get() = prefs.read(signOutKey) != null || prefs.read(signOutIntentKey) != null
    override val pendingSignOut: SignOutIntent? get() {
        prefs.read(signOutIntentKey)?.let { sealed ->
            return vault.open(sealed)?.let { raw -> runCatching { WindmillJson.decodeFromString<SignOutIntent>(raw) }
                .onFailure { telemetry.failure("session_sign_out_decode", java.io.IOException("The sign-out choice could not be read.")) }.getOrNull() }
        }
        return if (prefs.read(signOutKey) == "1") user()?.let { SignOutIntent(it.id, AuthSignOutChoice.Keep) } else null
    }
    override fun beginSignOut(intent: SignOutIntent) {
        check(user()?.id == intent.account) { "The account changed." }
        val encoded = vault.seal(WindmillJson.encodeToString(SignOutIntent.serializer(), intent))
            ?: throw java.io.IOException("The sign-out choice could not be sealed.")
        persist(mapOf(signOutIntentKey to encoded, signOutKey to null))
    }

    override fun reconcileSignOut(user: User, secret: String?, choice: AuthSignOutChoice, engineFinished: Boolean): SignOutStorage {
        val identityKeys = listOf(bundleKey, secretKey, secretKey + sealed, userKey, userKey + sealed, proposedKey)
        if (engineFinished && identityKeys.none { prefs.read(it) != null } && !signOutPending) {
            unavailable = false
            return SignOutStorage.Cleared
        }
        val stored = if (prefs.read(bundleKey) != null) saved() else {
            val token = prefs.read(secretKey) ?: prefs.read(secretKey + sealed)?.let(vault::open)
            val encodedUser = prefs.read(userKey) ?: prefs.read(userKey + sealed)?.let(vault::open)
            val known = encodedUser?.let { runCatching { WindmillJson.decodeFromString<User>(it) }.getOrNull() }
            if (token != null && known != null) SavedSession(token, known) else null
        }
        val intent = pendingSignOut
        if (stored?.user != user || stored?.secret != secret || prefs.read(proposedKey) != null ||
            signOutPending && (intent?.account != user.id || intent?.choice != choice)) return SignOutStorage.Unavailable
        unavailable = false
        return SignOutStorage.Current
    }

    override val localSession: LocalSession get() {
        if (unavailable) return LocalSession.Unresolved()
        if (signOutPending) return LocalSession.Absent
        if (prefs.read(bundleKey) != null) return saved()?.let { LocalSession.Owned(it.user) } ?: LocalSession.Unresolved()
        if (prefs.read(proposedKey) != null && proposed == null) return LocalSession.Unresolved()
        val present = listOf(secretKey, secretKey + sealed, userKey, userKey + sealed).any { prefs.read(it) != null }
        val known = (prefs.read(userKey) ?: prefs.read(userKey + sealed)?.let(vault::open))
            ?.let { runCatching { WindmillJson.decodeFromString<User>(it) }.onFailure { telemetry.failure("session_user_decode", it) }.getOrNull() }
        return if (present) LocalSession.Unresolved(known) else LocalSession.Absent
    }

    // Each sealed value storage does not hold after this write, failed or not, leaves the vault's memory, atomically for other writers.
    private fun persist(values: Map<String, String?>) = synchronized(this) {
        check(!unavailable) { "Restart the app to recover the saved account." }
        val sealedKeys = values.keys.filter { it.endsWith(sealed) }
        val touched = sealedKeys.mapNotNull(prefs::read) + sealedKeys.mapNotNull(values::get)
        try { prefs.write(values) }
        catch (failure: Exception) { unavailable = true; throw failure }
        finally { (touched - sealedKeys.mapNotNull(prefs::read).toSet()).forEach(vault::forget) }
    }

    private fun saved(): SavedSession? = prefs.read(bundleKey)?.let { encoded ->
        vault.open(encoded)?.let { runCatching { WindmillJson.decodeFromString<SavedSession>(it) }.onFailure { telemetry.failure("session_decode", it) }.getOrNull() }
    }

    override val proposed: ProposedSignIn? get() = prefs.read(proposedKey)?.let { encoded ->
        vault.open(encoded)?.let { runCatching { WindmillJson.decodeFromString<SavedSession>(it) }
            .onFailure { telemetry.failure("session_decode", java.io.IOException("The proposed account could not be read.")) }
            .getOrNull()?.let { saved -> ProposedSignIn(saved.secret, saved.user) } }
    }

    override fun stage(proposed: ProposedSignIn) {
        val encoded = vault.seal(WindmillJson.encodeToString(SavedSession.serializer(), SavedSession(proposed.secret, proposed.user)))
            ?: throw java.io.IOException("The proposed session could not be sealed.")
        persist(mapOf(proposedKey to encoded))
    }

    override fun publishProposed(expected: ProposedSignIn) {
        check(proposed == expected) { "The proposed account changed. Sign in again." }
        val encoded = requireNotNull(prefs.read(proposedKey))
        persist(mapOf(bundleKey to encoded, proposedKey to null, signOutKey to null, signOutIntentKey to null, secretKey to null, secretKey + sealed to null,
            userKey to null, userKey + sealed to null))
    }

    override fun clearProposed(expected: ProposedSignIn?) {
        if (expected == null || proposed == expected) persist(mapOf(proposedKey to null))
    }

    override fun commit(secret: String, user: User) {
        val value = WindmillJson.encodeToString(SavedSession.serializer(), SavedSession(secret, user))
        val encoded = vault.seal(value) ?: throw java.io.IOException("The session could not be sealed.")
        persist(mapOf(bundleKey to encoded, proposedKey to null, signOutKey to null, signOutIntentKey to null, secretKey to null, secretKey + sealed to null,
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
        if (secret == null) { seal(userKey, WindmillJson.encodeToString(User.serializer(), user)); return }
        if (saved() != SavedSession(secret, user)) commit(secret, user)
    }

    override fun clear() {
        persist(mapOf(
            bundleKey to null, proposedKey to null, signOutKey to null, signOutIntentKey to null, secretKey to null, secretKey + sealed to null,
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
        const val proposedKey = "wm_proposed.sealed"
        const val signOutKey = "wm_sign_out"
        const val signOutIntentKey = "wm_sign_out.sealed"
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
    private var staged: ProposedSignIn? = null
    override var pendingSignOut: SignOutIntent? = null
        private set
    override fun beginSignOut(intent: SignOutIntent) { check(known?.id == intent.account); pendingSignOut = intent }
    override val localSession: LocalSession get() = if (signOutPending) LocalSession.Absent else super.localSession
    override val proposed: ProposedSignIn? get() = synchronized(this) { staged }
    @Synchronized override fun commit(secret: String, user: User) { this.secret = secret; known = user; staged = null; pendingSignOut = null }
    @Synchronized override fun stage(proposed: ProposedSignIn) { staged = proposed }
    @Synchronized override fun publishProposed(expected: ProposedSignIn) {
        check(staged == expected) { "The proposed account changed." }
        secret = expected.secret; known = expected.user; staged = null; pendingSignOut = null
    }
    @Synchronized override fun clearProposed(expected: ProposedSignIn?) { if (expected == null || staged == expected) staged = null }
    @Synchronized override fun read(): String? = secret
    @Synchronized override fun write(secret: String) { this.secret = secret }
    @Synchronized override fun user(): User? = known
    @Synchronized override fun remember(user: User) { known = user }
    @Synchronized override fun clear() {
        secret = null
        known = null
        staged = null
        pendingSignOut = null
    }
}
