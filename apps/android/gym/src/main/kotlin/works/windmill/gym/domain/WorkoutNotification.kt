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

data class WorkoutNotification(
    val key: WorkoutKey,
    val title: String,
    val movement: String,
    val rackLine: String,
    val counter: String,
    val offer: LogSetOffer?,
    val hidden: Boolean,
) {
    constructor(key: WorkoutKey, session: Session, movement: String, sets: List<TrainingSet>,
        state: WorkoutState, ready: Boolean) : this(
        key, session.plan?.routine ?: "Free session", movement,
        state.rack?.let { "${Readout.weight(it.weightKg)} kg × ${it.reps}" } ?: "Open workout",
        LiveLines.counter(LiveLines.workingCount(sets), state.rack?.exerciseId?.let { session.plan?.entry(it) }),
        state.offer.takeIf { ready }, state.hidden,
    )
}

data class LogSetCommand(val key: WorkoutKey, val offerId: String)

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
    val editorOpen: Boolean = false,
    val hidden: Boolean = false,
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
        return invalidate().copy(hidden = hide)
    }

    fun reconcile(now: WorkoutMoment): WorkoutState =
        if (bootId == now.bootId) this else invalidate().copy(bootId = now.bootId)

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
}
