package works.windmill.gym.domain

import kotlinx.serialization.Serializable

@Serializable
data class WorkoutMoment(val wallMs: Long, val elapsedMs: Long, val bootId: String) {
    fun reconciled(now: WorkoutMoment): WorkoutMoment? {
        if (bootId == now.bootId && elapsedMs <= now.elapsedMs) return this
        val age = now.wallMs - wallMs
        if (age !in 0..AutoClose.AFTER_MS) return null
        return WorkoutMoment(wallMs, now.elapsedMs - age, now.bootId)
    }
}

fun interface WorkoutClock {
    fun now(): WorkoutMoment
}

@Serializable
data class WorkoutKey(val ownerKey: String, val sessionId: String)

@Serializable
data class WorkoutRack(
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    val basisSetCount: Int,
    val edited: Boolean,
    val revision: Long,
)

@Serializable
data class LogSetOffer(
    val key: WorkoutKey,
    val id: String,
    val rackRevision: Long,
    val exerciseId: String,
    val workingOrdinal: Int,
    val weightKg: Double,
    val reps: Int,
)

@Serializable
data class WorkoutRest(
    val id: String,
    val origin: WorkoutMoment,
    val targetSeconds: Int?,
    val alertRevision: Long,
    val attempted: Boolean,
)

data class WorkoutNotification(
    val key: WorkoutKey,
    val title: String,
    val movement: String,
    val rackLine: String,
    val counter: String,
    val targetLine: String?,
    val rest: WorkoutRest?,
    val offer: LogSetOffer?,
    val hidden: Boolean,
    val restAlerts: Boolean,
) {
    constructor(key: WorkoutKey, session: Session, movement: String, sets: List<TrainingSet>,
        state: WorkoutState, targetSeconds: Int?, ready: Boolean) : this(
        key, session.plan?.routine ?: "Free session", movement,
        state.rack?.let { "${Readout.weight(it.weightKg)} kg × ${it.reps}" } ?: "Open workout",
        LiveLines.counter(LiveLines.workingCount(sets), state.rack?.exerciseId?.let { session.plan?.entry(it) }),
        targetSeconds?.takeIf { it > 0 }?.let { "Rest target ${Readout.clock(it * 1_000L)}" },
        state.rest, state.offer.takeIf { ready }, state.hidden, state.restAlerts,
    )
}

data class LogSetCommand(val key: WorkoutKey, val offerId: String)
data class RestAlertCommand(val key: WorkoutKey, val eventId: String, val alertRevision: Long)

sealed interface LogSetAcceptance {
    data class Accepted(val setId: String) : LogSetAcceptance
    data object Stale : LogSetAcceptance
    data class Unavailable(val reason: String) : LogSetAcceptance
}

sealed interface WorkoutChange {
    data object Saved : WorkoutChange
    data object Stale : WorkoutChange
    data class Unavailable(val reason: String) : WorkoutChange
}

@Serializable
data class WorkoutEvent(val id: String, val origin: WorkoutMoment)

@Serializable
data class WorkoutState(
    val version: Int = 1,
    val revision: Long = 0,
    val bootId: String? = null,
    val started: WorkoutMoment? = null,
    val rack: WorkoutRack? = null,
    val offer: LogSetOffer? = null,
    val consumed: Set<String> = emptySet(),
    val rest: WorkoutRest? = null,
    val attemptedRest: Set<String> = emptySet(),
    val editorOpen: Boolean = false,
    val hidden: Boolean = false,
    val alertAccess: Boolean = false,
    val restAlerts: Boolean = true,
) {
    init { require(version == 1) { "The workout controls use an unsupported format." } }

    fun invalidate(): WorkoutState = copy(revision = revision + 1,
        rack = rack?.copy(revision = revision + 1), offer = null)

    fun redial(movement: String, count: Int, prefill: Prefill): WorkoutState {
        val previous = rack
        if (previous?.exerciseId == movement && previous.basisSetCount == count &&
            (previous.edited || (previous.weightKg == prefill.weightKg && previous.reps == prefill.reps))) return this
        val next = invalidate()
        return next.copy(rack = WorkoutRack(movement, prefill.weightKg, prefill.reps, count, false, next.revision))
    }

    fun edit(weightKg: Double, reps: Int): WorkoutState {
        val current = rack ?: return this
        if (current.weightKg == weightKg && current.reps == reps) return copy(rack = current.copy(edited = true))
        val next = invalidate()
        return next.copy(rack = current.copy(weightKg = weightKg, reps = reps, edited = true, revision = next.revision))
    }

    fun editor(open: Boolean): WorkoutState {
        if (open == editorOpen) return this
        return invalidate().copy(editorOpen = open)
    }

    fun visibility(hide: Boolean): WorkoutState {
        if (hide == hidden) return this
        val next = invalidate()
        return next.copy(hidden = hide, rest = rest?.copy(alertRevision = next.revision))
    }

    fun access(available: Boolean): WorkoutState {
        if (available == alertAccess) return this
        return copy(alertAccess = available, revision = revision + 1,
            rest = rest?.copy(alertRevision = revision + 1))
    }

    fun reconcile(event: WorkoutEvent?, target: Int?, sound: Boolean, now: WorkoutMoment): WorkoutState {
        var next = if (bootId != now.bootId) invalidate().copy(bootId = now.bootId) else this
        val same = event?.id == next.rest?.id
        if (!same && next.rest != null) next = next.copy(attemptedRest = next.attemptedRest + requireNotNull(next.rest).id)
        val origin = if (same) next.rest?.origin else event?.origin
        val reconciled = origin?.reconciled(now)
        val positiveTarget = target?.takeIf { it > 0 }
        val changed = sound != next.restAlerts || (event != null &&
            (!same || positiveTarget != next.rest?.targetSeconds || reconciled != next.rest?.origin))
        if (changed) next = next.copy(revision = next.revision + 1)
        return next.copy(restAlerts = sound, rest = if (event == null || reconciled == null) null else WorkoutRest(
            event.id, reconciled, positiveTarget, if (changed) next.revision else requireNotNull(next.rest).alertRevision,
            event.id in next.attemptedRest))
    }

    fun offered(key: WorkoutKey, ordinal: Int, ready: Boolean, id: String): WorkoutState {
        val current = rack
        if (!ready || editorOpen || current == null || !LoggedSetLimits.permits(current.weightKg, current.reps)) {
            return if (offer == null) this else invalidate()
        }
        val previous = offer
        if (previous != null && previous.key == key && previous.rackRevision == current.revision &&
            previous.workingOrdinal == ordinal && previous.id !in consumed) return this
        require(id !in consumed) { "The next set needs a new identity." }
        return copy(offer = LogSetOffer(key, id, current.revision, current.exerciseId, ordinal, current.weightKg, current.reps))
    }

    fun accepts(command: LogSetCommand): Boolean = offer?.let {
        LoggedSetLimits.permits(it.weightKg, it.reps) && it.key == command.key && it.id == command.offerId && it.id !in consumed && !editorOpen &&
            rack?.revision == it.rackRevision && rack.exerciseId == it.exerciseId
    } == true

    fun consume(command: LogSetCommand): WorkoutState {
        require(accepts(command))
        return invalidate().copy(consumed = consumed + command.offerId)
    }

    fun claim(command: RestAlertCommand, key: WorkoutKey, now: WorkoutMoment): WorkoutState? {
        val event = rest ?: return null
        val target = event.targetSeconds ?: return null
        if (command.key != key || event.id != command.eventId || event.alertRevision != command.alertRevision ||
            event.attempted || event.id in attemptedRest || hidden || !restAlerts || !alertAccess ||
            event.origin.bootId != now.bootId || now.elapsedMs - event.origin.elapsedMs < target * 1_000L) return null
        return copy(attemptedRest = attemptedRest + event.id, rest = event.copy(attempted = true))
    }
}
