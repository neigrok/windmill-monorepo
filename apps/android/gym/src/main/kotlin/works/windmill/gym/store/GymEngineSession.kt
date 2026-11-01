package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import works.windmill.platform.User
import works.windmill.platform.auth.AuthLifecycle
import works.windmill.platform.auth.AuthSignOutChoice
import works.windmill.platform.auth.AuthSignOutSession
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.Refusal
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineError
import works.windmill.sync.engine.LineageAnswer
import works.windmill.sync.engine.SignInSession
import works.windmill.sync.engine.SignOutChoice
import works.windmill.sync.engine.SignOutSession
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.discardDormant
import works.windmill.sync.core.*

class GymEngineSession(
    val engine: Engine,
    val runtime: SyncRuntime,
    private val telemetry: Telemetry = Telemetry.None,
    private val transport: AutoCloseable? = null,
    // Settles what the training store owes the replica in hand before another one is selected.
    private val beforeAccountChange: suspend () -> Unit = {},
    private val clearAccountCredential: (String) -> Unit = {},
) : AuthLifecycle, AutoCloseable {
    var decision: SignInSession? by mutableStateOf(null)
        private set
    private val decisionIdentity = java.util.UUID.randomUUID().toString()
    val decisionKey: String get() = "$decisionIdentity:$decisionRevision"
    var decisionRevision: Long by mutableLongStateOf(0L)
        private set
    var decisionFailure: String? by mutableStateOf(null)
        private set
    var decisionBusy by mutableStateOf(false)
        private set
    private var answer: CompletableDeferred<Unit>? = null

    override suspend fun signedIn(user: User, token: String, restoring: Boolean) {
        val snapshot = engine.snapshot()
        val active = snapshot.member("replicas").arr().first { it.member("meta").member("replica") == snapshot.member("active") }.member("meta")
        if (active.member("state").str() == "bound" && active["account"]?.str() == user.id) {
            runtime.reauthenticate(token)
            return
        }
        try {
            beforeAccountChange()
            EngineTraining(engine).prepareAdoption()
            var session = runtime.signIn(user.id, token)
            while (!session.isComplete) {
                val completion = CompletableDeferred<Unit>()
                decisionRevision += 1
                decision = session
                decisionFailure = null
                answer = completion
                telemetry.event("gym_sign_in_decision", mapOf("state" to "shown"))
                completion.await()
                if (!session.isComplete) session = runtime.resumeSignIn() ?: throw EngineError(EngineError.Code.signInEnded)
            }
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) { runtime.abandonSignIn(user.id, token) }
            throw cancelled
        }
        catch (failure: EngineError) {
            telemetry.event("gym_sign_in_decision", mapOf("outcome" to failure.code.name))
            if (failure.code == EngineError.Code.unreachable) throw WindmillApiException.Offline
            if (failure.code == EngineError.Code.upgradeRequired)
                throw WindmillApiException.Refused(426, Refusal(code = "client-update-required"))
            if (failure.code == EngineError.Code.unauthenticated)
                throw WindmillApiException.Refused(401, Refusal())
            throw failure
        } finally {
            decision = null
            answer = null
            decisionBusy = false
        }
    }

    override suspend fun cancelSignIn(user: User, token: String): Boolean = runtime.abandonSignIn(user.id, token)

    suspend fun cancel() {
        if (decisionBusy) return
        decision?.cancel()
        telemetry.event("gym_sign_in_decision", mapOf("action" to "cancel", "outcome" to "cancelled"))
        answer?.cancel(CancellationException("Sign-in cancelled."))
    }

    suspend fun decide(choice: LineageAnswer, opening: SignInSession? = decision) {
        val session = decision ?: return
        if (decisionBusy || session !== opening) return
        decisionBusy = true
        decisionFailure = null
        try {
            session.complete(session.decisions.associate { it.product to choice })
            telemetry.event("gym_sign_in_decision", mapOf("action" to choice.name, "outcome" to "completed"))
            answer?.complete(Unit)
        } catch (changed: EngineError) {
            if (changed.code == EngineError.Code.signInChanged) {
                telemetry.event("gym_sign_in_decision", mapOf("outcome" to "changed"))
                answer?.complete(Unit)
            } else decisionFailure = "The account could not be selected. Try again."
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            telemetry.failure("gym_sign_in_decision", failure)
            decisionFailure = "The account could not be selected. Your work is still on this phone. Try again."
        } finally { decisionBusy = false }
    }

    private var recoveringSignOut: SignOutSession? = null

    private fun activeAccount(): String? {
        val snapshot = engine.snapshot()
        val active = snapshot.member("replicas").arr().first { it.member("meta").member("replica") == snapshot.member("active") }.member("meta")
        return if (active.member("state").str() == "bound") active.member("account").str() else null
    }

    // The engine's sign-out held for exactly this account, as the account's lifecycle answers it.
    private class HeldSignOut(private val held: SignOutSession, private val tell: suspend (String, suspend () -> Unit) -> Unit) : AuthSignOutSession {
        override val account = held.account
        override val unsent = held.unsent
        override suspend fun finish(choice: AuthSignOutChoice) = tell(choice.name.lowercase()) {
            held.finish(if (choice == AuthSignOutChoice.Keep) SignOutChoice.keep else SignOutChoice.discard)
        }
        override suspend fun cancel() = tell("cancel") { held.cancel() }
    }

    private suspend fun holdSignOut(account: String): SignOutSession {
        check(activeAccount() == account) { "The account changed." }
        beforeAccountChange()
        check(activeAccount() == account) { "The account changed." }
        val held = runtime.signOut()
        if (held.account != account) {
            held.cancel()
            error("The account changed.")
        }
        return held
    }

    override suspend fun prepareSignOut(account: String): AuthSignOutSession {
        val held = holdSignOut(account)
        telemetry.event("gym_sign_out", mapOf("state" to "shown"))
        return HeldSignOut(held, ::signOutAction)
    }

    // Deletion asks no sign-out question, so it tells nothing as one; `account_delete` tells it.
    suspend fun prepareAccountDeletion(account: String): AuthSignOutSession = HeldSignOut(holdSignOut(account)) { _, body -> body() }

    // Keep and Discard end the account, so their outcome is a signed-out event; Cancel stays with the account.
    private suspend fun signOutAction(action: String, body: suspend () -> Unit) {
        val tell: (String, Map<String, String>) -> Unit = if (action == "cancel") telemetry::event else telemetry::signedOutEvent
        try {
            body()
            tell("gym_sign_out", mapOf("action" to action, "outcome" to "completed"))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            tell("gym_sign_out", mapOf("action" to action, "outcome" to "failed"))
            throw failure
        }
    }

    override suspend fun recoverSignOut(account: String, choice: AuthSignOutChoice) = signOutAction(choice.name.lowercase()) {
        endAccount(account, choice)
    }

    private suspend fun endAccount(account: String, choice: AuthSignOutChoice) {
        val active = activeAccount()
        check(active == null || active == account) { "The account changed." }
        if (active == account) {
            if (recoveringSignOut == null) beforeAccountChange()
            check(activeAccount() == account) { "The account changed." }
            val held = recoveringSignOut ?: runtime.signOut().also { recoveringSignOut = it }
            check(held.account == account) { "The account changed." }
            held.finish(if (choice == AuthSignOutChoice.Keep) SignOutChoice.keep else SignOutChoice.discard)
            recoveringSignOut = null
        } else if (choice == AuthSignOutChoice.Discard) engine.discardDormant(account)
    }

    fun deletionUnsent(account: String): Int {
        val snapshot = engine.snapshot()
        val active = snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") }
        check(active.member("meta")["account"]?.str() == account && active.member("meta").member("state").str() == "bound")
        val pending = active["device"]?.obj().orEmpty().entries.sumOf { (product, rows) ->
            WorkoutImports.pendingDeviceWork(product, rows.obj()).distinct().count { it in rows.obj() }
        }
        return active["outbox"]?.arr().orEmpty().count { it.member("state").str() in setOf("held", "ready", "sent") } + pending
    }

    private var deletingSignOut: SignOutSession? = null

    suspend fun finishAccountDeletion(account: String, replica: String, held: AuthSignOutSession?) {
        val snapshot = engine.snapshot()
        val retained = snapshot.member("replicas").arr().filter { it.member("meta")["account"]?.str() == account }
        check(retained.all { it.member("meta").member("replica").str() == replica }) { "The account replica changed." }
        val original = retained.singleOrNull()
        if (original == null) { held?.cancel(); deletingSignOut = null; return }
        val meta = original.member("meta")
        if (meta.member("state").str() == "dormant") {
            held?.cancel()
            engine.discardDormant(account)
            deletingSignOut = null
            return
        }
        check(meta.member("state").str() == "bound" && snapshot.member("active").str() == replica) { "The account changed." }
        if (held != null) held.finish(AuthSignOutChoice.Discard)
        else {
            val opening = deletingSignOut ?: runtime.signOut().also { deletingSignOut = it }
            check(opening.account == account)
            opening.finish(SignOutChoice.discard)
        }
        deletingSignOut = null
    }

    override suspend fun cleanupSignOut(account: String) {
        check(activeAccount() != account) { "The account is still selected." }
        clearAccountCredential(account)
    }

    // A sign-out nobody was asked about, as when the session expires, tells no sign-out outcome.
    override suspend fun signOut() {
        val account = activeAccount() ?: return
        endAccount(account, AuthSignOutChoice.Keep)
        cleanupSignOut(account)
    }

    fun enter() = runtime.enter()
    suspend fun leave() = runtime.leave()
    override fun close() { answer?.cancel(); runtime.close(); transport?.close(); engine.close() }
}

val LocalGymEngineSession = staticCompositionLocalOf<GymEngineSession?> { null }

