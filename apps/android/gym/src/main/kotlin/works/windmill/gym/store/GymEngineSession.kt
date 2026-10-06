package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import works.windmill.platform.User
import works.windmill.platform.auth.AuthLifecycle
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.Refusal
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineError
import works.windmill.sync.engine.LineageAnswer
import works.windmill.sync.engine.SignInSession
import works.windmill.sync.engine.SignOutChoice
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.anonCount
import works.windmill.sync.core.*

class GymEngineSession(
    val engine: Engine,
    val runtime: SyncRuntime,
    private val telemetry: Telemetry = Telemetry.None,
    private val transport: AutoCloseable? = null,
) : AuthLifecycle, AutoCloseable {
    var decision: SignInSession? by mutableStateOf(null)
        private set
    var decisionFailure: String? by mutableStateOf(null)
        private set
    var decisionBusy by mutableStateOf(false)
        private set
    private var answer: CompletableDeferred<Unit>? = null
    var beforeAccountChange: suspend () -> Unit = {}

    val anonymousCounts: Map<String, Int> get() {
        val snapshot = engine.snapshot()
        val anon = snapshot.member("replicas").arr().firstOrNull { it.member("meta").member("state").str() == "anon" } ?: return emptyMap()
        return engine.anonCount(anon.member("meta").member("replica").str(), "gym").obj().mapValues { it.value.long().toInt() }
    }

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

    suspend fun decide(choice: LineageAnswer) {
        val session = decision ?: return
        if (decisionBusy) return
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

    override suspend fun signOut() {
        val snapshot = engine.snapshot()
        val active = snapshot.member("replicas").arr().first { it.member("meta").member("replica") == snapshot.member("active") }.member("meta")
        if (active.member("state").str() != "bound") return
        beforeAccountChange()
        val session = runtime.signOut()
        session.finish(SignOutChoice.keep)
        telemetry.event("gym_sign_out", mapOf("action" to "keep", "outcome" to "completed"))
    }

    fun enter() = runtime.enter()
    suspend fun leave() = runtime.leave()
    override fun close() { answer?.cancel(); runtime.close(); transport?.close(); engine.close() }
}

val LocalGymEngineSession = staticCompositionLocalOf<GymEngineSession?> { null }

fun gymLineageCounts(counts: Map<String, Int>): String = counts.toSortedMap().entries.filter { it.value > 0 }.joinToString(" · ") { (type, amount) ->
    if (type == "pending") return@joinToString "$amount saved item${if (amount == 1) "" else "s"} awaiting sync"
    val noun = when (type) {
        "session" -> "workout"
        "set" -> "set"
        "routine" -> "routine"
        "exercise" -> "movement"
        "weighin" -> "weigh-in"
        "note" -> "note"
        "prefs" -> "setting"
        "exerciseName" -> "movement name"
        "routineCreation" -> "routine creation"
        "pending" -> "saved item awaiting sync"
        else -> "record"
    }
    "$amount $noun${if (amount == 1) "" else "s"}"
}
