package works.windmill.gym.coach.turn

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import works.windmill.agent.TurnLabel
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
    // `spent`: the server's read says the balance is gone. `subject_exhausted` alone does not: a positive balance refuses a round that does not fit (§7.1).
    data class Allowance(val allowance: String, val resetsAtMs: Long? = null, val spent: Boolean = false) : CoachTurnRefusal
    data class FreeMonthExhausted(val resetsAtMs: Long?) : CoachTurnRefusal
    data object RateLimited : CoachTurnRefusal
    data object UpdateRequired : CoachTurnRefusal
    data object Absent : CoachTurnRefusal
    data class Installation(val installation: String) : CoachTurnRefusal
    data object SessionLapsed : CoachTurnRefusal
    // Anonymous AI is switched off on the server: the words and the door are the installation door's own.
    data object AnonymousUnavailable : CoachTurnRefusal
    // Any other refusal the server answered.
    data object Unanswered : CoachTurnRefusal

    val sentence: String get() = when (this) {
        Offline -> "No connection. Your question is kept here."
        LogArriving -> "Your log is still arriving on this phone. Ask again in a moment."
        is TooLong -> "Too long by ${count(overBytes)} ${if (overBytes == 1) "byte" else "bytes"}. The limit is ${count(Ask.maxQuestionBytes)} bytes.\nEnglish letters take 1 byte each. Other letters and emoji take more."
        is Allowance -> when {
            allowance == "subject_exhausted" && spent -> "You have used all of your AI allowance."
            allowance == "free_day_exhausted" -> "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit."
            allowance == "concurrency_exhausted" -> "Another AI request is still in progress. Try again when it finishes."
            allowance == "funding_required" -> "Your plan has no funded AI allowance for this period."
            else -> "Coach’s AI allowance is unavailable right now."
        }
        is FreeMonthExhausted -> "Coach is paused for everyone this month."
        RateLimited -> "You can ask again later."
        UpdateRequired -> "This version can’t ask Coach any more. Update Windmill to continue."
        Absent -> Ask.notHere
        is Installation -> if (installation == "invalid_installation") "This phone can’t ask Coach signed out any more. $signInToContinue"
            else "This phone is linked to an account. Sign in to ask Coach."
        SessionLapsed, AnonymousUnavailable -> Ask.accessNeedsSignIn
        Unanswered -> CoachTurnFault.noAnswer.sentence
    }

    // The moment a cap the server named is over.
    val endsAtMs: Long? get() = when (this) {
        is Allowance -> resetsAtMs
        is FreeMonthExhausted -> resetsAtMs
        else -> null
    }

    // The words the notice draws: the sentence, when what refused comes back where the server named it, in the phone's zone and clock, and the sign-in a spent allowance offers.
    fun notice(anonymous: Boolean, clock24: Boolean, zone: ZoneId = ZoneId.systemDefault()): String {
        fun moment(ms: Long, pattern: String) = DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(zone))
        return when {
            this is FreeMonthExhausted && resetsAtMs != null -> "$sentence It comes back on ${moment(resetsAtMs, "MMM d")}."
            this is Allowance && allowance == "free_day_exhausted" && resetsAtMs != null ->
                "$sentence\nYou can use Coach again on ${moment(resetsAtMs, "MMM d")} at ${moment(resetsAtMs, if (clock24) "H:mm" else "h:mm a")}."
            this is Allowance && recovery(anonymous) == CoachRecovery.signIn -> "$sentence\n$signInToContinue"
            this is Allowance && allowance == "subject_exhausted" && resetsAtMs != null -> "$sentence It comes back on ${moment(resetsAtMs, "MMM d")}."
            else -> sentence
        }
    }

    // A cap the server refills and a deployment without Coach stand on every chat; everything else on the chat that met it.
    val capped: Boolean get() = this is Allowance || this is FreeMonthExhausted || this == RateLimited || this == Absent

    // The one door the notice offers: sign-in where the phone's own AI allowance refused the send or belongs to an account, the lifter's own agent where Coach's shared capacity is paused, the update, or Send again. Signed in, an allowance that refused the send offers nothing while paid plans are closed.
    fun recovery(anonymous: Boolean): CoachRecovery? = when (this) {
        Offline -> CoachRecovery.tryAgain
        LogArriving, is TooLong, Absent, Unanswered -> null
        is Allowance -> when {
            allowance == "free_day_exhausted" -> CoachRecovery.ownAgent
            anonymous && allowance == "subject_exhausted" -> CoachRecovery.signIn
            else -> null
        }
        is FreeMonthExhausted, RateLimited -> CoachRecovery.ownAgent
        UpdateRequired -> CoachRecovery.update
        is Installation -> if (anonymous) CoachRecovery.signIn else null
        SessionLapsed, AnonymousUnavailable -> CoachRecovery.signIn
    }

    // The `gym_ask_outcome` this refusal ends with, and the cap it names.
    val askOutcome: Pair<String, String?> get() = when (this) {
        Offline -> "offline" to null
        is Allowance, is FreeMonthExhausted -> "capped" to "allowance"
        RateLimited -> "capped" to "daily"
        Absent -> "absent" to null
        LogArriving, is TooLong, UpdateRequired, is Installation, SessionLapsed, AnonymousUnavailable, Unanswered -> "refused" to null
    }

    companion object {
        const val signInToContinue = "Sign in to continue."

        fun of(code: String, status: Int? = null, resetsAtMs: Long? = null, spent: Boolean = false): CoachTurnRefusal = when {
            code == TurnRefusal.unreachable || code == TurnLabel.notAStream -> Offline
            code == TurnRefusal.anonymousUnavailable -> AnonymousUnavailable
            code == "free_month_exhausted" -> FreeMonthExhausted(resetsAtMs)
            code == "invalid_installation" || code == "installation_bound" || code == "device_bound" -> Installation(code)
            code in TurnRefusal.allowanceCodes -> Allowance(code, resetsAtMs, spent)
            code == TurnRefusal.rateLimited -> RateLimited
            code == "coach-update-required" || code == "client-update-required" -> UpdateRequired
            status == 401 -> SessionLapsed
            status == 404 -> Absent
            else -> Unanswered
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
    stopUnheard("Coach is stopped on this phone.");

    // The `gym_ask_outcome` a send held back by this fault ends with. A stop's fault belongs to a turn that told its own.
    val askOutcome: String get() = if (this == unsaved || this == pictureUnavailable) "failed" else "refused"
}
