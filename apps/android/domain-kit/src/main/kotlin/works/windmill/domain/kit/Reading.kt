package works.windmill.domain.kit

import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.compareBytes
import works.windmill.sync.core.lives

class Reader(val source: ScopeReader, val scope: ScopeRef, val moment: Moment, val registry: Registry) {
    val actor: String get() = (source as? CommitContext)?.actor ?: ""
    val isAnonymous: Boolean get() = source.isAnonymous
    fun commands(): List<QueuedCommand> = (source as? CommitContext)?.commands() ?: emptyList()
    fun devices(prefix: String): Map<String, Json> = source.devices(prefix)
    fun checkpoint(): ScopeCheckpoint = source.checkpoint()
    fun <E : Entity<E>> confirmed(type: EntityType<E>, id: Id<E>): Record? = source.confirmed(type.type, id.record)
    fun <E : Entity<E>> repository(type: EntityType<E>): Repository<E> {
        check(type.scope == scope && registry.lives(type.type, scope)) { "${type.type} is outside $scope" }
        return Repository(type, source, registry)
    }
    fun device(key: String): Json? = source.device(key)
    fun firstPullComplete(): Boolean = source.firstPullComplete()
}

class Repository<E : Entity<E>>(val type: EntityType<E>, val source: ScopeReader, val registry: Registry) {
    fun find(id: Id<E>, view: ViewMode): E? = record(id, view)?.takeIf { it.isVisible }?.let { type.decode(Fields(it)) }
    fun all(view: ViewMode): List<E> = decode(type, if (view == ViewMode.drawn) source.drawn(type.type) else source.stored(type.type))
    fun <P : Entity<P>> children(parent: Id<P>, via: String, view: ViewMode): List<E> = decode(type,
        if (view == ViewMode.drawn) source.drawn(type.type, via, parent.record) else source.stored(type.type, via, parent.record))
    fun capacity(): Capacity = Capacity(type, source.stored(type.type), registry)
    fun record(id: Id<E>, view: ViewMode): Record? = record(id.record, view)
    fun record(id: RecordID, view: ViewMode): Record? = if (view == ViewMode.drawn) source.drawn(type.type, id) else source.stored(type.type, id)
    fun anchor(placement: Placement, orderField: String = (type as? OrderedType<*>)?.orderField ?: error("${type.type} is unordered")): RecordID? = when (placement) {
        Placement.Top -> null
        is Placement.Below -> placement.id
        Placement.Bottom -> ordered(type, source.stored(type.type).filter { it.isVisible }, orderField).lastOrNull()?.id
    }
    companion object {
        fun <E : Entity<E>> decode(type: EntityType<E>, records: Collection<Record>): List<E> = ordered(type, records.filter { it.isVisible }).map { type.decode(Fields(it)) }
        fun ordered(type: EntityType<*>, records: Collection<Record>, orderField: String? = (type as? OrderedType<*>)?.orderField): List<Record> = records.sortedWith { a, b ->
            val keys = if (orderField == null) 0 else compareBytes((a.values[orderField] as? Json.Str)?.value ?: "", (b.values[orderField] as? Json.Str)?.value ?: "")
            if (keys == 0) a.id.compareTo(b.id) else keys
        }
    }
}

data class Capacity(val type: String, val used: Int, val cap: Long) {
    constructor(type: EntityType<*>, stored: Collection<Record>, registry: Registry) : this(type.type,
        stored.count { it.isVisible && it.type == type.type }, checkNotNull(registry.type(type.type)?.cap) { "${type.type} has no cap" })
    val isFull: Boolean get() = used >= cap
    fun refusal(growing: Int, subject: RecordRef?): Refused? = if (growing > 0 && used.toLong() + growing > cap)
        Refused(RefusalCode("cap"), subject, Json.objectOf("type" to Json.of(type), "cap" to Json.of(cap)), Refused.Path.predicted) else null
}

sealed interface Placement {
    data object Top : Placement
    data class Below(val id: RecordID) : Placement
    data object Bottom : Placement
}
