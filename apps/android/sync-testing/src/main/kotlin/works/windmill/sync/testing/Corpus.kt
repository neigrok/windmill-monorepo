package works.windmill.sync.testing

import java.io.File
import works.windmill.sync.core.Json
import works.windmill.sync.core.Registry
import works.windmill.sync.core.Row
import works.windmill.sync.api.TextValue

enum class CorpusRole { ALL, CLIENT, SERVER }
data class Vector(val file: String, val name: String, val input: Json, val expect: Json) {
    override fun toString() = "$file · $name"
}
typealias Handler = (Json) -> Json

class Corpus(val root: File) {
    val paths: List<String> get() = root.walkTopDown().filter { it.isFile && it.extension in listOf("json", "jsonl") }
        .map { it.relativeTo(root).invariantSeparatorsPath }.sorted().toList()
    val clientPaths: List<String> get() = paths.filter { role(it) in listOf(CorpusRole.ALL, CorpusRole.CLIENT) }
    fun vectors(path: String): List<Vector> {
        val file = File(root, path)
        if (file.extension == "jsonl") return listOf(Vector(path, "transcript", Json.Arr(file.readLines().filter { it.isNotBlank() }.map(Json::parse)), Json.Null))
        val document = Json.parse(file.readBytes())
        if (document !is Json.Arr) return listOf(Vector(path, "the whole file", Json.Null, document))
        val names = mutableSetOf<String>()
        return document.values.map {
            it.expectKeys(listOf("name", "input", "expect"))
            val name = it.member("name").str()
            check(names.add(name)) { "duplicate vector: $path" }
            Vector(path, name, it.member("input"), it.member("expect"))
        }
    }
    fun unclaimed(handlers: Map<String, Handler>, paths: List<String>): List<String> = paths.filter { it !in handlers }
    fun requireCoverage(handlers: Map<String, Handler>, paths: List<String>) {
        val missing = unclaimed(handlers, paths)
        check(missing.isEmpty()) { "unclaimed corpus files (${missing.size}): ${missing.joinToString()}" }
    }
    fun run(handlers: Map<String, Handler>, paths: List<String>): Int {
        requireCoverage(handlers, paths)
        var count = 0
        val failures = mutableListOf<String>()
        for (path in paths) for (vector in vectors(path)) {
            count++
            try { assertVector(vector, handlers.getValue(path)) }
            catch (failure: AssertionError) { failures.add(failure.message ?: "$path assertion") }
        }
        if (failures.isNotEmpty()) throw AssertionError(failures.joinToString("\n"))
        return count
    }
    companion object {
        val roles = listOf(
            "constants.json" to CorpusRole.ALL, "stamp/" to CorpusRole.ALL, "hlc/tick.json" to CorpusRole.ALL,
            "hlc/observe.json" to CorpusRole.ALL, "jcs/" to CorpusRole.ALL, "join/" to CorpusRole.ALL,
            "derive/" to CorpusRole.ALL, "identity/seeded.json" to CorpusRole.ALL, "digest/" to CorpusRole.ALL,
            "protocol/" to CorpusRole.ALL, "identity/table.json" to CorpusRole.SERVER, "admit/" to CorpusRole.SERVER,
            "text/" to CorpusRole.SERVER, "envelope/credentials.json" to CorpusRole.SERVER, "push/serve.json" to CorpusRole.SERVER,
            "pull/serve.json" to CorpusRole.SERVER, "pull/hello.json" to CorpusRole.SERVER, "live/death.json" to CorpusRole.SERVER,
            "machine/scope.json" to CorpusRole.SERVER, "gym/admit.json" to CorpusRole.SERVER,
            "journal/admit.json" to CorpusRole.SERVER, "journal/revisions.json" to CorpusRole.SERVER,
            "journal/client.json" to CorpusRole.CLIENT, "journal/content-clock.json" to CorpusRole.CLIENT,
            "journal/claim-edit.json" to CorpusRole.CLIENT, "hlc/offset.json" to CorpusRole.CLIENT,
            "hlc/jump.json" to CorpusRole.CLIENT, "fracindex/" to CorpusRole.CLIENT, "view/" to CorpusRole.CLIENT,
            "commit/" to CorpusRole.CLIENT, "hold/" to CorpusRole.CLIENT, "refusal/" to CorpusRole.CLIENT,
            "write/" to CorpusRole.CLIENT, "lineage/" to CorpusRole.CLIENT, "pull/pages.json" to CorpusRole.CLIENT,
            "machine/intent.json" to CorpusRole.CLIENT, "machine/replica.json" to CorpusRole.CLIENT,
        )
        fun role(path: String): CorpusRole = roles.firstOrNull { it.first == path }?.second
            ?: roles.firstOrNull { it.first.endsWith('/') && path.startsWith(it.first) }?.second
            ?: error("unclassified corpus file: $path")
        fun assertVector(vector: Vector, handler: Handler) {
            val actual = try { handler(vector.input) } catch (error: IllegalArgumentException) {
                if (vector.expect == Json.objectOf("error" to Json.of(true))) return
                throw AssertionError("${vector.file} · ${vector.name}: unexpected ${error.javaClass.simpleName}", error)
            }
            if (actual.jcs != vector.expect.jcs) throw AssertionError("${vector.file} · ${vector.name}\nexpected ${vector.expect.jcs}\nactual   ${actual.jcs}")
        }
    }
}

fun Record(confirmed: Row, registry: Registry): works.windmill.sync.api.Record {
    val definition = registry.type(confirmed.key.type)
    val visible = when {
        definition == null -> false
        definition.identity == "singleton" -> true
        definition.life -> confirmed.lattice.life?.isAlive == true
        definition.json["visibleWhen"] == null -> confirmed.lattice.fields.isNotEmpty() || confirmed.texts.isNotEmpty()
        else -> definition.json.member("visibleWhen").arr().any { name ->
            val value = confirmed.texts[name.str()]?.let { Json.of(it.text) } ?: confirmed.lattice.fields[name.str()]?.value
            value != null && value !== Json.Null && value != Json.of("")
        }
    }
    return works.windmill.sync.api.Record(confirmed.key.type, confirmed.key.id, confirmed.lattice.life, confirmed.lattice.born,
        confirmed.lattice.fields.mapValues { it.value.value }, confirmed.texts.mapValues { TextValue(it.value.text, it.value.merged, false) },
        confirmed.serials, confirmed.rc, confirmed.ru, visible, false, false)
}
