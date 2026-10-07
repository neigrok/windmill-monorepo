package works.windmill.sync.api

import works.windmill.sync.core.*

typealias RecordID = works.windmill.sync.core.RecordID
typealias Command = works.windmill.sync.core.Command

data class RecordRef(val type: String, val id: RecordID) { val key: RecordKey get() = RecordKey(type, id) }
data class RegisterRef(val type: String, val id: RecordID, val field: String) { val key: RecordKey get() = RecordKey(type, id) }
data class OrderAnchor(val field: String, val below: RecordID?)

sealed interface NewID {
    data object Minted : NewID
    data class Seeded(val seed: String, val ordinal: Long) : NewID
    data class Derived(val label: String) : NewID
    data class Given(val id: RecordID) : NewID
}

data class TextEdit(var text: String, var editedFrom: String? = null)

data class Change(val type: String, val operation: Operation, val values: Map<String, Json> = emptyMap(),
    val texts: Map<String, TextEdit> = emptyMap(), val anchor: OrderAnchor? = null) {
    sealed interface Operation {
        data class Create(val id: NewID) : Operation
        data class Update(val id: RecordID) : Operation
        data class Delete(val id: RecordID) : Operation
        data class Revive(val id: RecordID) : Operation
        data class Put(val id: RecordID, val present: Boolean?) : Operation
        data class Write(val id: RecordID) : Operation
        data class Move(val id: RecordID) : Operation
    }
    val id: RecordID? get() = when (val op = operation) {
        is Operation.Create -> (op.id as? NewID.Given)?.id
        is Operation.Update -> op.id; is Operation.Delete -> op.id; is Operation.Revive -> op.id
        is Operation.Put -> op.id; is Operation.Write -> op.id; is Operation.Move -> op.id
    }
    companion object {
        fun create(type: String, id: NewID = NewID.Minted, values: Map<String, Json> = emptyMap(), texts: Map<String, TextEdit> = emptyMap(), anchor: OrderAnchor? = null): Change = Change(type, Operation.Create(id), values, texts, anchor)
        fun update(type: String, id: RecordID, values: Map<String, Json> = emptyMap(), texts: Map<String, TextEdit> = emptyMap()): Change = Change(type, Operation.Update(id), values, texts)
        fun delete(type: String, id: RecordID): Change = Change(type, Operation.Delete(id))
        fun revive(type: String, id: RecordID, values: Map<String, Json> = emptyMap()): Change = Change(type, Operation.Revive(id), values)
        fun put(type: String, id: RecordID, present: Boolean?, values: Map<String, Json> = emptyMap(), texts: Map<String, TextEdit> = emptyMap()): Change = Change(type, Operation.Put(id, present), values, texts)
        fun write(type: String, id: RecordID, values: Map<String, Json> = emptyMap(), texts: Map<String, TextEdit> = emptyMap()): Change = Change(type, Operation.Write(id), values, texts)
        fun move(type: String, id: RecordID, to: OrderAnchor): Change = Change(type, Operation.Move(id), anchor = to)
    }
}

data class DeviceWrite(val key: String, val value: Json?)
data class Gesture(var changes: List<Change>, var atomic: Boolean = false, var hold: Boolean = false,
    var guards: List<RegisterRef> = emptyList(), var retire: List<RecordRef> = emptyList(), var supersede: List<String> = emptyList(),
    var command: Command? = null, var predict: List<Change> = emptyList(), var local: List<DeviceWrite> = emptyList(), var gestureId: String? = null)

sealed interface CommitOutcome {
    data class Committed(val receipt: CommitReceipt) : CommitOutcome
    data class Refused(val code: RefusalCode, val detail: Json?, val notice: String? = null) : CommitOutcome
}

data class CommitReceipt(val gestureId: String, val stamp: Stamp, val localIds: List<String>, val ids: List<RecordID?>,
    val releaseAt: Long?, val retired: List<String>, val superseded: List<String> = emptyList())
enum class ViewMode { drawn, stored }
data class TextValue(val text: String, val merged: Boolean, val pending: Boolean)
data class Record(val type: String, val id: RecordID, val life: Life?, val born: Stamp?, val values: Map<String, Json>,
    val texts: Map<String, TextValue>, val serials: Map<String, Json>, val rc: Long?, val ru: Long?,
    val isVisible: Boolean, val isPending: Boolean, val isHeld: Boolean)
data class NoticeContent(var deltas: List<Delta> = emptyList(), var command: Command? = null, var dependents: List<NoticeContent> = emptyList())
data class Notice(val id: String, val product: String, val scope: ScopeRef, val code: RefusalCode, val detail: Json?,
    val content: NoticeContent, val at: Long, val isDismissed: Boolean = false)
data class UndoOffer(val id: String, val scope: ScopeRef, val releaseAt: Long)

typealias IntentResultDeviceWrites = (Intent, PushResult, String, String, Map<String, Json>) -> List<DeviceWrite>
typealias PendingDeviceWork = (String, Map<String, Json>) -> List<String>
