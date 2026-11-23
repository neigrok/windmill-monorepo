package works.windmill.gym.coach.turn

import androidx.annotation.StringRes
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import works.windmill.agent.coach.AiFailure
import works.windmill.gym.R
import works.windmill.gym.coach.Ask
import works.windmill.gym.coach.asked
import works.windmill.platform.i18n.Words
import works.windmill.sync.core.Json

// Why a send could not go: the composer's bound, the phone's own admission (Coach §4.1), or what the pass door or the AI service answered, in the access states of Coach engine §7. Each is said once, at the conversation's end, with the one door that exists.
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
    // `subject_exhausted`, the allowance used up, by what holds the request where the refusal carried the allowance, and the moment the seat's period ends.
    data class Shortfall(val shortfall: AllowanceShortfall?, val resetsAtMs: Long? = null) : CoachTurnRefusal
    // Shared capacity for the day used up (`free_day_exhausted`), or every call this seat may have in flight taken (`concurrency_exhausted`).
    data class Allowance(val allowance: String, val resetsAtMs: Long? = null) : CoachTurnRefusal
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
        is Shortfall -> when (shortfall) {
            AllowanceShortfall.spent -> Words.Message(R.string.gym_coach_allowance_spent)
            AllowanceShortfall.held -> Words.Message(R.string.gym_coach_allowance_held)
            AllowanceShortfall.tooLarge -> Words.Message(R.string.gym_coach_allowance_too_large)
            // No allowance came with the refusal: only what is always true.
            null -> Words.Message(R.string.gym_coach_allowance_no_room)
        }
        is Allowance -> when (allowance) {
            "free_day_exhausted" -> Words.Message(R.string.gym_coach_free_day_exhausted)
            "concurrency_exhausted" -> Words.Message(R.string.gym_coach_concurrency_exhausted)
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
        is Shortfall -> resetsAtMs
        is Allowance -> resetsAtMs
        is FreeMonthExhausted -> resetsAtMs
        else -> null
    }

    // The words the notice draws: the refusal, when what refused comes back where the server named it, in the phone's zone and clock, and the sign-in an allowance that refused the send offers. A reset brings back a spent allowance, never a request too large or what earlier requests hold.
    fun said(anonymous: Boolean, clock24: Boolean, zone: ZoneId = ZoneId.systemDefault()): Words {
        val day = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
        val time = DateTimeFormatter.ofPattern(if (clock24) "H:mm" else "h:mm a", Locale.getDefault())
        fun moment(ms: Long, format: DateTimeFormatter) = format.format(Instant.ofEpochMilli(ms).atZone(zone))
        return when {
            this is FreeMonthExhausted && resetsAtMs != null -> Words.Message(R.string.gym_coach_notice_comes_back, listOf(words, moment(resetsAtMs, day)))
            this is Allowance && allowance == "free_day_exhausted" && resetsAtMs != null -> Words.Message(R.string.gym_coach_notice_use_again,
                listOf(words, moment(resetsAtMs, day), moment(resetsAtMs, time)))
            this is Shortfall && recovery(anonymous) == CoachRecovery.signIn -> Words.Message(R.string.gym_coach_notice_sign_in, listOf(words))
            this is Shortfall && shortfall == AllowanceShortfall.spent && resetsAtMs != null -> Words.Message(R.string.gym_coach_notice_comes_back, listOf(words, moment(resetsAtMs, day)))
            else -> words
        }
    }

    // A cap the server refills and a deployment without Coach stand on every chat; everything else on the chat that met it.
    val capped: Boolean get() = this is Shortfall || this is Allowance || this is FreeMonthExhausted || this == RateLimited || this == Absent

    // The one door the notice offers: sign-in where the phone's own AI allowance refused the send or belongs to an account, the lifter's own agent where Coach's shared capacity is paused, the update, or Send again. Signed in, an allowance that refused the send offers nothing while paid plans are closed.
    fun recovery(anonymous: Boolean): CoachRecovery? = when (this) {
        Offline -> CoachRecovery.tryAgain
        LogArriving, is TooLong, Absent, Unanswered -> null
        is Shortfall -> if (anonymous) CoachRecovery.signIn else null
        is Allowance -> if (allowance == "free_day_exhausted") CoachRecovery.ownAgent else null
        is FreeMonthExhausted, RateLimited -> CoachRecovery.ownAgent
        UpdateRequired -> CoachRecovery.update
        is Installation -> if (anonymous) CoachRecovery.signIn else null
        SessionLapsed, AnonymousUnavailable -> CoachRecovery.signIn
    }

    // The `gym_ask_outcome` this refusal ends with, and the cap it names.
    val askOutcome: Pair<String, String?> get() = when (this) {
        Offline -> "offline" to null
        is Shortfall, is Allowance, is FreeMonthExhausted -> "capped" to "allowance"
        RateLimited -> "capped" to "daily"
        Absent -> "absent" to null
        LogArriving, is TooLong, UpdateRequired, is Installation, SessionLapsed, AnonymousUnavailable, Unanswered -> "refused" to null
    }

    companion object {
        // Coach engine §7: the access state a turn's failure stands for, in the words gym's boards hold. A 404 from the pass door reads as AI switched off, which signed in means this server has no Coach.
        fun of(failure: AiFailure, anonymous: Boolean): CoachTurnRefusal {
            val allowance = failure.allowance
            fun moment(field: String) = allowance?.get(field)?.orNull()?.long(0)
            return when (val code = failure.code) {
                null -> if (failure.source == "transport") Offline else Unanswered
                "subject_exhausted" -> Shortfall(AllowanceShortfall.of(allowance), moment("resetsAt"))
                "free_day_exhausted" -> Allowance(code, moment("budgetResetsAt"))
                "free_month_exhausted" -> FreeMonthExhausted(moment("budgetResetsAt"))
                "concurrency_exhausted" -> Allowance(code)
                "rate_limited", "busy", "paused" -> RateLimited
                "unauthenticated" -> SessionLapsed
                "invalid_installation", "device_bound" -> Installation(code)
                "client-update-required" -> UpdateRequired
                "anonymous_ai_unavailable" -> if (anonymous) AnonymousUnavailable else Absent
                else -> Unanswered
            }
        }

        private fun count(value: Int): String = "%,d".format(Locale.US, value)
    }
}

// What holds back a request the allowance refused `subject_exhausted`, as the allowance's amounts show. `subject_exhausted` alone says none of these: a positive balance refuses a round that does not fit.
enum class AllowanceShortfall {
    // Nothing is left, and no earlier request whose cost is unconfirmed holds any of it.
    spent,
    // Nothing is left, and earlier requests whose cost is not yet confirmed hold the rest.
    held,
    // Something is left, less than the request needs.
    tooLarge;

    companion object {
        // An allowance that is absent, or whose amounts cannot be read, shows nothing.
        fun of(remaining: String?, reserved: String?): AllowanceShortfall? {
            val left = remaining?.toBigDecimalOrNull() ?: return null
            val holding = reserved?.toBigDecimalOrNull() ?: return null
            if (left.signum() > 0) return tooLarge
            return if (holding.signum() > 0) held else spent
        }

        fun of(allowance: Json?): AllowanceShortfall? = of((allowance?.get("remaining") as? Json.Str)?.value, (allowance?.get("reserved") as? Json.Str)?.value)
    }
}

enum class CoachRecovery { tryAgain, signIn, ownAgent, update }

// A fault of this phone's own, said in the band: never a refusal, and the draft stays.
enum class CoachTurnFault(@StringRes val said: Int) {
    busy(R.string.gym_coach_fault_busy),
    accountChanging(R.string.gym_coach_fault_account_changing),
    noAnswer(R.string.gym_coach_fault_no_answer),
    unsaved(R.string.gym_coach_message_unsaved),
    pictureUnavailable(R.string.gym_coach_fault_picture_unavailable);

    // The `gym_ask_outcome` a send held back by this fault ends with.
    val askOutcome: String get() = if (this == unsaved || this == pictureUnavailable) "failed" else "refused"
}
