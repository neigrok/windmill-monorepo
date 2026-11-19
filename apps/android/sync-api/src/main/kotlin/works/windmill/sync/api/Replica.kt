package works.windmill.sync.api

import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Stamp

interface ScopeReader {
    val isAnonymous: Boolean
    fun drawn(type: String, id: RecordID): Record?
    fun stored(type: String, id: RecordID): Record?
    fun drawn(type: String): List<Record>
    fun stored(type: String): List<Record>
    fun drawn(type: String, field: String, id: RecordID): List<Record>
    fun stored(type: String, field: String, id: RecordID): List<Record>
    // §2.5, §7.5: the born of the scope's spent id of a record, all the device keeps of a derived record deleted elsewhere once its row is
    // gone; null where the scope keeps none.
    fun spentBorn(type: String, id: RecordID): Stamp?
    fun device(key: String): Json?
    fun firstPullComplete(): Boolean
    fun confirmed(type: String, id: RecordID): Record?
    fun checkpoint(): ScopeCheckpoint
    fun serverSchema(): Long? = null
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

// Engine §7.1 Ordered local acts. A composed act decides in parts: `stage` commits one part's segment to the act's tentative copy, through
// every segment staged before it, and answers its local refusal, or null; `beginPart` opens the next part's load, whose reads and identities
// go through every staged segment. Nothing staged is durable: the request's segments commit afresh, under the act's one hold.
interface ActContext {
    val now: Long
    val replica: String
    val actor: String
    val isAnonymous: Boolean
    fun finishLoad()
    fun <T> inScope(scope: ScopeRef, body: (ScopeReader) -> T): T
    fun mintID(type: String, scope: ScopeRef): RecordID
    fun opaqueID(): String
    fun stage(scope: ScopeRef, segment: (CommitContext) -> Gesture): CommitOutcome.Refused?
    fun beginPart()
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
    fun <T> commitAct(prepare: (ActContext) -> Pair<ActRequest?, T>, segment: (T, Int, CommitContext) -> Gesture): Pair<ActCommitOutcome?, T>
    // Engine §7.3: cancels a gesture while every entry of it is still held; true iff it did.
    fun cancelHeld(gestureId: String): Boolean
    // K-3, engine §7.3 Undo of an act: the inverse of an act opted into Undo or of a held cancellation, its answer by request, and the
    // release of an act the product's stack no longer holds.
    fun requestInverse(actId: String, slots: List<UndoSegment>? = null): InverseResult
    fun readInverseResult(requestId: String): InverseResult
    fun releaseReversibleAct(actId: String): Boolean
    fun <T> read(scope: ScopeRef, body: (ScopeReader) -> T): T
    fun mintID(type: String): RecordID
    fun physNow(): Long
    fun dismissNotice(id: String)
    fun commit(scope: ScopeRef, gesture: Gesture): CommitOutcome = commit(scope) { gesture to Unit }.first
        ?: throw IllegalStateException("a commit of a gesture always has an outcome")
}

fun Replica.commitAct(segments: List<ScopedGesture>, gestureId: String? = null): ActCommitOutcome? = commitAct(
    { ActRequest(segments.map { it.scope }, segments.any { it.gesture.hold }, gestureId) to segments },
    { values, index, _ -> values[index].gesture }).first

data class ScopeCheckpoint(val epoch: String? = null, val cleanSeq: Long? = null)
data class QueuedCommand(val gestureId: String, val command: Command, val canSupersede: Boolean)
