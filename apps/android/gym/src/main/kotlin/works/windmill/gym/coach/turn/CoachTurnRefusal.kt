package works.windmill.gym.coach.turn

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import works.windmill.agent.TurnRefusal
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.asked

// Why a send could not go: the composer's bound, the phone's own admission (Coach §4.1), or the server's refusal by §6.5 code. Each is said once, at the conversation's end, with the one door that exists.
sealed interface CoachTurnRefusal {
    data object Offline : CoachTurnRefusal
    data object LogArriving : CoachTurnRefusal
    data class TooLong(val overBytes: Int) : CoachTurnRefusal {
        companion object {
            fun of(typed: String): TooLong? {
                val over = asked(typed).encodeToByteArray().size - Ask.maxQuestionBytes
                return if (over > 0) TooLong(over) else null
            }
        }
    }
    data class Allowance(val allowance: String, val resetsAtMs: Long? = null) : CoachTurnRefusal
    data class FreeMonthExhausted(val resetsAtMs: Long?) : CoachTurnRefusal
    data object RateLimited : CoachTurnRefusal
    data object UpdateRequired : CoachTurnRefusal
    data object Absent : CoachTurnRefusal
    data class Installation(val installation: String) : CoachTurnRefusal
    data object SessionLapsed : CoachTurnRefusal
    data class Said(val said: String) : CoachTurnRefusal

    val sentence: String get() = when (this) {
        Offline -> "No connection. Your question is kept here."
        LogArriving -> "Your log is still arriving on this phone. Ask again in a moment."
        is TooLong -> "Too long by ${count(overBytes)} ${if (overBytes == 1) "byte" else "bytes"}. The limit is ${count(Ask.maxQuestionBytes)} bytes.\nEnglish letters take 1 byte each. Other letters and emoji take more."
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

    // The words the notice draws: the sentence, when a paused pool comes back where the server named it, in the phone's zone and clock, and the sign-in a spent allowance offers.
    fun notice(anonymous: Boolean, clock24: Boolean, zone: ZoneId = ZoneId.systemDefault()): String {
        fun moment(ms: Long, pattern: String) = DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(zone))
        return when {
            this is FreeMonthExhausted && resetsAtMs != null -> "$sentence It comes back on ${moment(resetsAtMs, "MMM d")}."
            this is Allowance && allowance == "free_day_exhausted" && resetsAtMs != null ->
                "$sentence\nYou can use Coach again on ${moment(resetsAtMs, "MMM d")} at ${moment(resetsAtMs, if (clock24) "H:mm" else "h:mm a")}."
            this is Allowance && recovery(anonymous) == CoachRecovery.signIn -> "$sentence\nSign in to continue."
            else -> sentence
        }
    }

    // A cap the server refills and a deployment without Coach stand on every chat; everything else on the chat that met it.
    val capped: Boolean get() = this is Allowance || this is FreeMonthExhausted || this == RateLimited || this == Absent

    // The one door the notice offers: sign-in where the phone's own AI access is spent or belongs to an account, the lifter's own agent where Coach's shared capacity is paused, the update, or Send again. Signed in, a spent allowance offers nothing while paid plans are closed.
    fun recovery(anonymous: Boolean): CoachRecovery? = when (this) {
        Offline -> CoachRecovery.tryAgain
        LogArriving, is TooLong, Absent, is Said -> null
        is Allowance -> when {
            allowance == "free_day_exhausted" -> CoachRecovery.ownAgent
            anonymous && allowance == "subject_exhausted" -> CoachRecovery.signIn
            else -> null
        }
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
        LogArriving, is TooLong, UpdateRequired, is Installation, SessionLapsed, is Said -> "refused" to null
    }

    companion object {
        fun of(code: String, status: Int? = null, resetsAtMs: Long? = null): CoachTurnRefusal = when {
            code == "free_month_exhausted" -> FreeMonthExhausted(resetsAtMs)
            code == "invalid_installation" || code == "installation_bound" || code == "device_bound" -> Installation(code)
            code in TurnRefusal.allowanceCodes -> Allowance(code, resetsAtMs)
            code == TurnRefusal.rateLimited -> RateLimited
            code == "coach-update-required" || code == "client-update-required" -> UpdateRequired
            status == 401 -> SessionLapsed
            status == 404 -> Absent
            else -> Said(code)
        }

        private fun count(value: Int): String = "%,d".format(Locale.US, value)
    }
}

enum class CoachRecovery { tryAgain, signIn, ownAgent, update }

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
