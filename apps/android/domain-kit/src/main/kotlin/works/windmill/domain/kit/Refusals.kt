package works.windmill.domain.kit

import works.windmill.sync.api.Command
import works.windmill.sync.api.Notice
import works.windmill.sync.api.NoticeContent
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry

interface Refusals<R> {
    fun of(violation: Violation): R
    fun of(refused: Refused): R
    fun isGeneric(refusal: R): Boolean
}

data class Refused(val code: RefusalCode, val subject: RecordRef?, val detail: Json? = null, val path: Path) {
    enum class Path { predicted, notice }
    constructor(notice: Notice, registry: Registry) : this(notice.code,
        notice.content.deltas.firstOrNull()?.key?.let { RecordRef(it.type, it.id) }
            ?: commandSubject(notice.content.command, registry), notice.detail, Path.notice)

    val cap: Pair<String, Long>? get() {
        if (code != RefusalCode.cap) return null
        val type = (detail?.get("type") as? Json.Str)?.value ?: return null
        val count = try { detail?.get("cap")?.long() } catch (_: JsonError) { null } ?: return null
        return type to count
    }

    companion object {
        fun commandSubject(command: Command?, registry: Registry): RecordRef? {
            val definition = command?.let { registry.command(it.name) } ?: return null
            for ((name, argument) in definition.args) {
                val type = argument.ref ?: continue
                val value = command.args[name] ?: continue
                val id = try { RecordID(value) } catch (_: JsonError) { continue }
                return RecordRef(type, id)
            }
            return null
        }
    }
}

class DomainNotice<R>(val notice: Notice, registry: Registry, refusals: Refusals<R>) {
    val id = notice.id
    val gestureId = gestureId(id)
    private val refused = Refused(notice, registry)
    val subject = refused.subject
    val refusal = refusals.of(refused)

    fun values(record: RecordRef): Map<String, Json> = buildMap { fold(notice.content, record.key, this) }

    companion object {
        fun gestureId(id: String): String = id.removePrefix("notice:").let { local ->
            val slash = local.lastIndexOf('/')
            if (slash < 0) local else local.substring(0, slash)
        }

        private fun fold(content: NoticeContent, key: RecordKey, values: MutableMap<String, Json>) {
            for (delta in content.deltas.filter { it.key == key }) {
                for ((name, register) in delta.lattice.fields) values[name] = register.value
                for ((name, text) in delta.texts) values[name] = Json.of(text.text)
            }
            for (dependent in content.dependents) fold(dependent, key, values)
        }
    }
}
