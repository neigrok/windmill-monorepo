package works.windmill.sync.api

import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef

interface ScopeReader {
    val isAnonymous: Boolean
    fun drawn(type: String, id: RecordID): Record?
    fun stored(type: String, id: RecordID): Record?
    fun drawn(type: String): List<Record>
    fun stored(type: String): List<Record>
    fun drawn(type: String, field: String, id: RecordID): List<Record>
    fun stored(type: String, field: String, id: RecordID): List<Record>
    fun device(key: String): Json?
    fun firstPullComplete(): Boolean
    fun confirmed(type: String, id: RecordID): Record?
    fun checkpoint(): ScopeCheckpoint
    fun devices(prefix: String): Map<String, Json>
}

interface CommitContext : ScopeReader {
    val now: Long
    val replica: String
    val actor: String
    fun commands(): List<QueuedCommand>
    fun opaqueID(): String
    fun mintID(type: String): RecordID
}

class CommitFailure(val kind: Kind, val description: String) : Exception(description) {
    enum class Kind(val wire: String) { notWritable("not-writable"), malformed("malformed"), storeFailure("store-failure") }
    override fun equals(other: Any?): Boolean = other is CommitFailure && kind == other.kind && description == other.description
    override fun hashCode(): Int = 31 * kind.hashCode() + description.hashCode()
    override fun toString(): String = description
    companion object { fun malformed(description: String): CommitFailure = CommitFailure(Kind.malformed, description) }
}

interface Replica {
    fun <T> commit(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T>
    fun undo(gestureId: String): Boolean
    fun <T> read(scope: ScopeRef, body: (ScopeReader) -> T): T
    fun mintID(type: String): RecordID
    fun physNow(): Long
    fun dismissNotice(id: String)
    fun commit(scope: ScopeRef, gesture: Gesture): CommitOutcome = commit(scope) { gesture to Unit }.first
        ?: throw IllegalStateException("a commit of a gesture always has an outcome")
}

data class ScopeCheckpoint(val epoch: String? = null, val cleanSeq: Long? = null)
data class QueuedCommand(val gestureId: String, val command: Command, val canSupersede: Boolean)
