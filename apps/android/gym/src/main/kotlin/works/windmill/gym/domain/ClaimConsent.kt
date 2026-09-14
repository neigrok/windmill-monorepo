package works.windmill.gym.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class ClaimSource { Anonymous, Quarantine }

@Serializable
enum class ClaimKind { Movement, Routine, Session, Queue, Bodyweight, Preferences }

@Serializable
data class ClaimItem(
    val source: ClaimSource,
    val kind: ClaimKind,
    val id: String,
    val revision: String,
    val payload: String,
    val atMs: Long? = null,
    val activeSession: Boolean = false,
) {
    init {
        require(id.isNotBlank())
        require(revision.matches(Regex("[0-9a-f]{64}")))
        require(payload.isNotBlank())
        require(!activeSession || kind == ClaimKind.Queue)
    }
}

@Serializable
data class ClaimBatch(val id: String, val items: List<ClaimItem>) {
    init {
        require(id.isNotBlank())
        require(items.map { Triple(it.source, it.kind, it.id) }.distinct().size == items.size)
    }

    val isEmpty: Boolean get() = items.isEmpty()
    val sessions: Int get() = items.filter { it.kind == ClaimKind.Session ||
        (it.kind == ClaimKind.Queue && it.activeSession) }.map { it.source to it.id }.distinct().size
    val routines: Int get() = items.count { it.kind == ClaimKind.Routine }
    val movements: Int get() = items.count { it.kind == ClaimKind.Movement }
    val weighIns: Int get() = items.count { it.kind == ClaimKind.Bodyweight }
    val preferences: Int get() = items.count { it.kind == ClaimKind.Preferences }
}

@Serializable
sealed class ClaimConsent {
    abstract val batch: ClaimBatch

    @Serializable
    @SerialName("awaiting-sign-in")
    data class AwaitingSignIn(override val batch: ClaimBatch, val flowId: String) : ClaimConsent() {
        init { require(!batch.isEmpty && flowId.isNotBlank()) }
    }

    @Serializable
    @SerialName("approved")
    data class Approved(override val batch: ClaimBatch, val owner: String, val flowId: String? = null) : ClaimConsent() {
        init { require(!batch.isEmpty && owner.isNotBlank() && (flowId == null || flowId.isNotBlank())) }
        fun resumeFor(owner: String?): ClaimBatch? = batch.takeIf { this.owner == owner }
    }

    @Serializable
    @SerialName("discarding")
    data class Discarding(override val batch: ClaimBatch) : ClaimConsent() {
        init { require(!batch.isEmpty) }
    }

    companion object {
        fun requestSignIn(current: ClaimConsent?, batch: ClaimBatch, flowId: String): AwaitingSignIn {
            val next = AwaitingSignIn(batch, flowId)
            check(current == null || current == next) { "Another local-data decision is still outstanding." }
            return next
        }

        fun approve(current: ClaimConsent?, batch: ClaimBatch, owner: String, flowId: String? = null): Approved {
            val next = Approved(batch, owner, flowId)
            if (current == null) {
                check(flowId == null) { "This sign-in no longer has a local-data decision." }
                return next
            }
            check(current.batch == batch) { "The local-data snapshot changed." }
            if (current is AwaitingSignIn) {
                check(current.flowId == flowId) { "This sign-in belongs to another local-data decision." }
                return next
            }
            check(current is Approved && current.owner == owner) { "This local data is bound to another decision or account." }
            return current
        }

        fun discard(current: ClaimConsent?, batch: ClaimBatch): Discarding {
            val next = Discarding(batch)
            check(current == null || (current.batch == batch && current !is Approved)) {
                "Another local-data decision is still outstanding."
            }
            return next
        }

        fun complete(current: ClaimConsent?, batchId: String): ClaimConsent? {
            require(batchId.isNotBlank())
            check(current == null || current.batch.id == batchId) { "Another local-data decision is still outstanding." }
            return null
        }
    }
}
