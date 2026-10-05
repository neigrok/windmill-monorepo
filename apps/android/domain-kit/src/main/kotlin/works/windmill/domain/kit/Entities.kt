package works.windmill.domain.kit

import works.windmill.sync.api.Record
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.compareBytes

interface Entity<E : Entity<E>> { val id: Id<E> }
interface Writable<E : Writable<E>> : Entity<E> { fun fields(): Map<String, Json> }
interface EntityType<E : Entity<E>> {
    val type: String
    val scope: ScopeRef
    fun decode(f: Fields): E
}
interface WritableType<E : Writable<E>> : EntityType<E> { val checks: List<Check<E>> }
interface RemovableType<E : Entity<E>> : EntityType<E> { val heldRemoval: Boolean }
interface OrderedType<E : Entity<E>> : EntityType<E> { val orderField: String }
interface DraftableType<E : Writable<E>> : WritableType<E> { val savesGuarded: Boolean }
typealias DraftType<E> = DraftableType<E>
interface TimestampedType<E : Writable<E>> : DraftableType<E> { val timestampField: String }
interface ValueType<V : ValueObject<V>> { fun decode(f: Fields): V }

class Id<E : Entity<E>>(val record: RecordID, val entity: EntityType<E>) : Comparable<Id<E>> {
    constructor(day: LocalDay, entity: EntityType<E>) : this(RecordID(day.text), entity)
    constructor(text: String, entity: EntityType<E>) : this(RecordID(text), entity)
    val day: LocalDay? get() = record.string?.let(LocalDay::parse)
    val ref: RecordRef get() = RecordRef(entity.type, record)
    val json: Json get() = record.json
    override fun compareTo(other: Id<E>): Int = record.compareTo(other.record)
    override fun equals(other: Any?): Boolean = other is Id<*> && record == other.record && entity.type == other.entity.type
    override fun hashCode(): Int = 31 * record.hashCode() + entity.type.hashCode()
    override fun toString(): String = record.toString()
}

class EntityFacts(val entity: EntityType<*>) {
    val type: String get() = entity.type
    val scope: ScopeRef get() = entity.scope
    val orderField: String? get() = (entity as? OrderedType<*>)?.orderField
    val heldRemoval: Boolean? get() = (entity as? RemovableType<*>)?.heldRemoval
    val savesGuarded: Boolean? get() = (entity as? DraftableType<*>)?.savesGuarded
    val timestampField: String? get() = (entity as? TimestampedType<*>)?.timestampField
    val isOrdered: Boolean get() = orderField != null
    val isRemovable: Boolean get() = heldRemoval != null
    val isGuarded: Boolean get() = savesGuarded == true
}

class DecodeError(val type: String, val field: String, val reason: String) : IllegalArgumentException("$type.$field: $reason")

class Fields private constructor(val type: String, val path: String, private val recordID: RecordID?,
    private val values: Map<String, Json>, private val serials: Map<String, Json>) {
    constructor(record: Record) : this(record.type, "", record.id,
        record.values + record.texts.mapValues { Json.of(it.value.text) }, record.serials)
    constructor(objectValue: Json) : this(objectValue, "", "")
    constructor(objectValue: Json, type: String, path: String) : this(type, path, null,
        (objectValue as? Json.Obj)?.members ?: throw DecodeError(type, path, "not an object"), emptyMap())
    constructor(type: String, id: RecordID, values: Map<String, Json>) : this(type, "", id, values, emptyMap())
    val id: RecordID get() = checkNotNull(recordID) { "the fields of a value object have no record id" }
    fun string(f: String): String = (present(f) as? Json.Str)?.value ?: throw failure(f, "not a string")
    fun string(f: String, default: String): String = if (isAbsent(f)) default else string(f)
    fun optionalString(f: String): String? = if (isAbsent(f)) null else string(f)
    fun int(f: String): Int {
        val n = (present(f) as? Json.Num)?.value ?: throw failure(f, "not an integer")
        if (n < Int.MIN_VALUE || n > Int.MAX_VALUE || n != n.toInt().toDouble()) throw failure(f, "not an integer")
        return n.toInt()
    }
    fun optionalInt(f: String): Int? = if (isAbsent(f)) null else int(f)
    fun double(f: String): Double = (present(f) as? Json.Num)?.value ?: throw failure(f, "not a number")
    fun optionalDouble(f: String): Double? = if (isAbsent(f)) null else double(f)
    fun bool(f: String): Boolean = (present(f) as? Json.Bool)?.value ?: throw failure(f, "not a boolean")
    fun bool(f: String, default: Boolean): Boolean = if (isAbsent(f)) default else bool(f)
    fun instant(f: String): Instant {
        val n = (present(f) as? Json.Num)?.value ?: throw failure(f, "not an integer of milliseconds")
        if (n < Long.MIN_VALUE.toDouble() || n >= -Long.MIN_VALUE.toDouble() || n != n.toLong().toDouble())
            throw failure(f, "not an integer of milliseconds")
        return Instant(n.toLong())
    }
    fun optionalInstant(f: String): Instant? = if (isAbsent(f)) null else instant(f)
    fun <E : Entity<E>> ref(f: String, type: EntityType<E>): Id<E> = try {
        Id(RecordID(present(f)), type)
    } catch (error: DecodeError) { throw error } catch (_: IllegalArgumentException) { throw failure(f, "not an id") }
    fun <E : Entity<E>> optionalRef(f: String, type: EntityType<E>): Id<E>? = if (isAbsent(f)) null else ref(f, type)
    fun <V> value(f: String, decode: (Fields) -> V): V = decode(Fields(present(f), type, named(f)))
    fun <V : ValueObject<V>> value(f: String, type: ValueType<V>): V = value(f, type::decode)
    fun <V> optionalValue(f: String, decode: (Fields) -> V): V? = if (isAbsent(f)) null else value(f, decode)
    fun <V : ValueObject<V>> optionalValue(f: String, type: ValueType<V>): V? = optionalValue(f, type::decode)
    fun <V> list(f: String, decode: (Fields) -> V): List<V> {
        val items = (present(f) as? Json.Arr)?.values ?: throw failure(f, "not an array")
        return items.mapIndexed { i, item -> decode(Fields(item, type, "${named(f)}.$i")) }
    }
    fun <V : ValueObject<V>> list(f: String, type: ValueType<V>): List<V> = list(f, type::decode)
    fun <V> optionalList(f: String, decode: (Fields) -> V): List<V>? = if (isAbsent(f)) null else list(f, decode)
    fun <V : ValueObject<V>> optionalList(f: String, type: ValueType<V>): List<V>? = optionalList(f, type::decode)
    fun text(f: String): String = (values[f] as? Json.Str)?.value ?: ""
    fun serial(f: String): Int? = (serials[f] as? Json.Num)?.value?.let { if (it >= Int.MIN_VALUE && it <= Int.MAX_VALUE && it == it.toInt().toDouble()) it.toInt() else null }
    fun json(f: String): Json? = values[f] ?: serials[f]
    fun isAbsent(f: String): Boolean = values[f] == null || values[f] === Json.Null
    fun present(f: String): Json = values[f]?.takeUnless { it === Json.Null } ?: throw failure(f, "absent")
    fun named(f: String): String = if (path.isEmpty()) f else "$path.$f"
    fun failure(f: String, reason: String): DecodeError = DecodeError(type, named(f), reason)
}

class Check<E>(val field: String?, val apply: (E, Moment) -> E) {
    companion object {
        fun <E> key(apply: (E, Moment) -> Unit): Check<E> = Check(null) { value, moment -> apply(value, moment); value }
    }
}

class Valid<E : Writable<E>>(value: E, val type: WritableType<E>, fields: List<String>? = null, at: Moment) {
    val value: E
    internal val id = value.id
    internal val written: Map<String, Json>
    val checked: List<String> = (fields ?: value.fields().keys.toList()).uniqueInByteOrder()
    init {
        check(value.id.entity.type == type.type && value.id.entity.scope == type.scope) { "a valid value names its own entity type" }
        var checking = value
        for (check in type.checks) {
            val field = check.field
            if (field != null && field !in checked) continue
            val before = checking.fields().toMap()
            checking = try { check.apply(checking, at) }
            catch (error: Violation) { throw error }
            catch (error: Exception) { throw IllegalStateException("a check of ${type.type} threw another error", error) }
            check(checking.id == value.id) { "a check of ${type.type} changed the record id" }
            if (field != null) {
                val after = checking.fields()
                check((before.keys + after.keys).filter { it != field }.all { before[it]?.jcs == after[it]?.jcs }) {
                    "the check of ${type.type}.$field changed another field"
                }
            }
        }
        val stamped = (type as? TimestampedType<*>)?.timestampField
        if (stamped != null && stamped in checked) checking = type.decoding(checking.id, checking.fields() + (stamped to Json.of(at.now.ms)))
        val written = checking.fields()
        for (field in checked) written[field]?.firstNul(Path(field))?.let {
            throw Violation("${type.type}.$field", it, Violation.Reason.Nul)
        }
        this.value = checking
        this.written = written.toMap()
    }
}

fun <E : Writable<E>> WritableType<E>.decoding(id: Id<E>, fields: Map<String, Json>): E = try {
    decode(Fields(type, id.record, fields))
} catch (error: DecodeError) { throw IllegalStateException("$type does not decode its own fields", error) }

fun List<String>.uniqueInByteOrder(): List<String> = distinct().sortedWith { a, b -> compareBytes(a, b) }
