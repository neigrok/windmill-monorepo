package works.windmill.gym.store

import java.security.MessageDigest
import kotlinx.serialization.KSerializer
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimItem
import works.windmill.gym.domain.ClaimKind
import works.windmill.gym.domain.ClaimSource

internal val ClaimSource.seat: String
    get() = when (this) {
        ClaimSource.Anonymous -> Seat.anonymous
        ClaimSource.Quarantine -> Seat.quarantine
    }

internal fun claimRevision(payload: String): String = MessageDigest.getInstance("SHA-256")
    .digest(payload.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

internal fun <T> claimItem(source: ClaimSource, kind: ClaimKind, id: String, value: T,
    serializer: KSerializer<T>, atMs: Long? = null, active: Boolean = false): ClaimItem {
    val payload = diskJson.encodeToString(serializer, value)
    return ClaimItem(source, kind, id, claimRevision(payload), payload, atMs, active)
}

internal fun <T> ClaimItem.decode(serializer: KSerializer<T>): T {
    check(revision == claimRevision(payload)) { "The saved local-data snapshot changed." }
    return diskJson.decodeFromString(serializer, payload)
}

internal fun <T> ClaimItem.matches(value: T, serializer: KSerializer<T>): Boolean =
    revision == claimRevision(diskJson.encodeToString(serializer, value))

internal fun Map<String, String>.completed(batch: ClaimBatch, owner: String?): Boolean {
    val previous = get(batch.id) ?: return false
    check(previous == (owner?.let { "owner:$it" } ?: "discard")) { "This local-data batch already belongs to another decision." }
    return true
}
