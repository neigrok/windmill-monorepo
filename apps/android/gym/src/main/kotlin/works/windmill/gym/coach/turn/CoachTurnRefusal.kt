package works.windmill.gym.coach.turn

import androidx.annotation.StringRes
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import works.windmill.agent.TurnLabel
import works.windmill.agent.TurnRefusal
import works.windmill.gym.R
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.asked
import works.windmill.platform.i18n.Words

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

    val words: Words get() = when (this) {
        Offline -> Words.Message(R.string.gym_coach_offline)
        LogArriving -> Words.Message(R.string.gym_coach_log_arriving)
        is TooLong -> Words.Counted(R.plurals.gym_coach_too_long, overBytes, listOf(count(overBytes), count(Ask.maxQuestionBytes)))
        is Allowance -> when {
            allowance == "subject_exhausted" && spent -> Words.Message(R.string.gym_coach_allowance_spent)
            allowance == "free_day_exhausted" -> Words.Message(R.string.gym_coach_free_day_exhausted)
            allowance == "concurrency_exhausted" -> Words.Message(R.string.gym_coach_concurrency_exhausted)
            allowance == "funding_required" -> Words.Message(R.string.gym_coach_funding_required)
            else -> Words.Message(R.string.gym_coach_allowance_unavailable)
        }
        is FreeMonthExhausted -> Words.Message(R.string.gym_coach_free_month_exhausted)
        RateLimited -> Words.Message(R.string.gym_coach_rate_limited)
        UpdateRequired -> Words.Message(R.string.gym_coach_update_required)
        Absent -> Words.Message(R.string.gym_coach_not_here)
        is Installation -> if (installation == "invalid_installation") Words.Message(R.string.gym_coach_installation_invalid)
            else Words.Message(R.string.gym_coach_installation_bound)
        SessionLapsed, AnonymousUnavailable -> Words.Message(R.string.gym_coach_access_needs_sign_in)
        Unanswered -> Words.Message(CoachTurnFault.noAnswer.said)
    }

    // The moment a cap the server named is over.
    val endsAtMs: Long? get() = when (this) {
        is Allowance -> resetsAtMs
        is FreeMonthExhausted -> resetsAtMs
        else -> null
    }

    // The words the notice draws: the refusal, when what refused comes back where the server named it, in the phone's zone and clock, and the sign-in a spent allowance offers.
    fun said(anonymous: Boolean, clock24: Boolean, zone: ZoneId = ZoneId.systemDefault()): Words {
        fun moment(ms: Long, pattern: String) = DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).format(Instant.ofEpochMilli(ms).atZone(zone))
        return when {
            this is FreeMonthExhausted && resetsAtMs != null -> Words.Message(R.string.gym_coach_notice_comes_back, listOf(words, moment(resetsAtMs, "MMM d")))
            this is Allowance && allowance == "free_day_exhausted" && resetsAtMs != null -> Words.Message(R.string.gym_coach_notice_use_again,
                listOf(words, moment(resetsAtMs, "MMM d"), moment(resetsAtMs, if (clock24) "H:mm" else "h:mm a")))
            this is Allowance && recovery(anonymous) == CoachRecovery.signIn -> Words.Message(R.string.gym_coach_notice_sign_in, listOf(words))
            this is Allowance && allowance == "subject_exhausted" && resetsAtMs != null -> Words.Message(R.string.gym_coach_notice_comes_back, listOf(words, moment(resetsAtMs, "MMM d")))
            else -> words
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
enum class CoachTurnFault(@StringRes val said: Int) {
    busy(R.string.gym_coach_fault_busy),
    accountChanging(R.string.gym_coach_fault_account_changing),
    noAnswer(R.string.gym_coach_fault_no_answer),
    unsaved(R.string.gym_coach_message_unsaved),
    pictureUnavailable(R.string.gym_coach_fault_picture_unavailable),
    stoppedOffline(R.string.gym_coach_fault_stopped_offline),
    stopUnheard(R.string.gym_coach_fault_stop_unheard);

    // The `gym_ask_outcome` a send held back by this fault ends with. A stop's fault belongs to a turn that told its own.
    val askOutcome: String get() = if (this == unsaved || this == pictureUnavailable) "failed" else "refused"
}
