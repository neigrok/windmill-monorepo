package works.windmill.gym.coach.turn

import works.windmill.agent.TurnRefusal
import works.windmill.gym.coach.Ask

// Why a send could not go: the phone's own admission (Coach §4.1), or the server's refusal by §6.5 code. Each is said once, at the conversation's end, with the one door that exists.
sealed interface CoachTurnRefusal {
    data object Offline : CoachTurnRefusal
    data object LogArriving : CoachTurnRefusal
    data class Allowance(val allowance: String) : CoachTurnRefusal
    data class FreeMonthExhausted(val resetsAtMs: Long?) : CoachTurnRefusal
    data object RateLimited : CoachTurnRefusal
    data object UpdateRequired : CoachTurnRefusal
    data object Absent : CoachTurnRefusal
    data class Installation(val installation: String) : CoachTurnRefusal
    data object SessionLapsed : CoachTurnRefusal
    data class Said(val said: String) : CoachTurnRefusal

    val code: String get() = when (this) {
        Offline -> "offline"
        LogArriving -> "coach-replica-syncing"
        is Allowance -> allowance
        is FreeMonthExhausted -> "free_month_exhausted"
        RateLimited -> TurnRefusal.rateLimited
        UpdateRequired -> "coach-update-required"
        Absent -> "absent"
        is Installation -> installation
        SessionLapsed -> "unauthenticated"
        is Said -> said
    }

    val sentence: String get() = when (this) {
        Offline -> "No connection. Your question is kept here."
        LogArriving -> "Your log is still arriving on this phone. Ask again in a moment."
        is Allowance -> when (allowance) {
            "subject_exhausted" -> "You have used all of your AI allowance."
            "free_day_exhausted" -> "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit."
            "concurrency_exhausted" -> "Another AI request is still in progress. Try again when it finishes."
            "funding_required" -> "Your plan has no funded AI allowance for this period."
            else -> "Coach’s AI allowance is unavailable right now."
        }
        is FreeMonthExhausted -> "Coach is paused for everyone this month."
        RateLimited -> "You can ask again later."
        UpdateRequired -> "This version can’t ask Coach any more. Update Windmill to continue."
        Absent -> "This Windmill does not have Coach. You can still read your log."
        is Installation -> if (installation == "invalid_installation") "This phone can’t ask Coach signed out any more. Sign in to continue."
            else "This phone is linked to an account. Sign in to ask Coach."
        SessionLapsed -> Ask.accessNeedsSignIn
        is Said -> "Coach didn’t answer. Try again in a moment"
    }

    // The composer stays closed on a cap the server refills and on a deployment without Coach; everything else asks again.
    val capped: Boolean get() = this is Allowance || this is FreeMonthExhausted || this == RateLimited || this == Absent

    // The one door the notice offers: sign-in where the phone's own AI access is spent or belongs to an account, the lifter's own agent where Coach's shared capacity is paused, the update, or Send again. Signed in, a spent allowance offers nothing while paid plans are closed.
    fun recovery(anonymous: Boolean): CoachRecovery? = when (this) {
        Offline -> CoachRecovery.tryAgain
        LogArriving, Absent, is Said -> null
        is Allowance -> if (anonymous && allowance == "subject_exhausted") CoachRecovery.signIn else null
        is FreeMonthExhausted, RateLimited -> CoachRecovery.ownAgent
        UpdateRequired -> CoachRecovery.update
        is Installation -> if (anonymous) CoachRecovery.signIn else null
        SessionLapsed -> CoachRecovery.signIn
    }

    // The `gym_ask_outcome` this refusal ends with, and the cap it names.
    val askOutcome: Pair<String, String?> get() = when (this) {
        Offline -> "offline" to null
        is Allowance, is FreeMonthExhausted -> "capped" to "allowance"
        RateLimited -> "capped" to "daily"
        Absent -> "absent" to null
        LogArriving, UpdateRequired, is Installation, SessionLapsed, is Said -> "refused" to null
    }

    companion object {
        fun of(code: String, status: Int? = null, resetsAtMs: Long? = null): CoachTurnRefusal = when {
            code == TurnRefusal.unreachable -> Offline
            code == "free_month_exhausted" -> FreeMonthExhausted(resetsAtMs)
            code == "invalid_installation" || code == "installation_bound" || code == "device_bound" -> Installation(code)
            code in TurnRefusal.allowanceCodes -> Allowance(code)
            code == TurnRefusal.rateLimited -> RateLimited
            code == "coach-update-required" || code == "client-update-required" -> UpdateRequired
            status == 401 -> SessionLapsed
            status == 404 -> Absent
            else -> Said(code)
        }
    }
}

enum class CoachRecovery(val title: String) {
    tryAgain("Try again"), signIn("Sign in"), ownAgent("Use your own AI agent"), update("Update")
}

// A fault of this phone's own, said in the band: never a refusal, and the draft stays.
enum class CoachTurnFault(val sentence: String) {
    busy("Coach is answering another message. Try again when it finishes."),
    accountChanging("Your account is changing. Your question is kept here."),
    noAnswer("Coach didn’t answer. Try again in a moment"),
    unsaved("Your message couldn’t be saved. Try again."),
    pictureUnavailable("That photo is unavailable. Remove it and choose it again."),
    stoppedOffline("Coach is stopped on this phone. Stopping it on the server needs a connection."),
    stopUnheard("The stop request didn’t reach Coach. Try again."),
}
