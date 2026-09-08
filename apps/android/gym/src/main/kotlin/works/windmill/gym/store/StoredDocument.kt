package works.windmill.gym.store

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

// Unknown keys are tolerated and an absent optional is omitted rather than written as null.
internal val diskJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

// How every device store reads its file: as a tree first, the previous app version's shapes
// rewritten into this one's, then one item at a time — so a row this build cannot read costs that
// row and never the shelf, the queue or the copy around it. The rewritten document is not written
// back here; the next flush writes it in this version's shape.
internal object StoredDocument {
    fun tree(file: File): JsonObject? {
        val text = runCatching { file.readText() }.getOrNull() ?: return null
        val parsed = runCatching { diskJson.parseToJsonElement(text) }.getOrNull()
        return (parsed as? JsonObject)?.let { migrated(it) as JsonObject }
    }

    // One row of a list, or nothing where the file has no such list; a row that will not decode is
    // dropped and its neighbours kept.
    fun <T> each(node: JsonElement?, strategy: DeserializationStrategy<T>): List<T>? {
        val rows = node as? JsonArray ?: return null
        return rows.mapNotNull { one(it, strategy) }
    }

    fun <T> keyed(node: JsonElement?, strategy: DeserializationStrategy<T>): Map<String, T> {
        val rows = node as? JsonObject ?: return emptyMap()
        return rows.mapNotNull { (key, row) -> one(row, strategy)?.let { key to it } }.toMap()
    }

    fun <T> one(node: JsonElement?, strategy: DeserializationStrategy<T>): T? {
        if (node == null || node is JsonNull) return null
        return runCatching { diskJson.decodeFromJsonElement(strategy, node) }.getOrNull()
    }

    // The previous version wrote a routine entry's target as the `targetSets · targetReps ·
    // targetWeightKg` triple and a plan entry's as scalar `sets · reps · weightKg`; both become
    // `sets: [n identical items]`, and a null count becomes no `sets` key — the open line. Read
    // wherever an entry stands, since routines and frozen plans sit at more than one depth.
    private fun migrated(node: JsonElement): JsonElement = when (node) {
        is JsonArray -> JsonArray(node.map(::migrated))
        is JsonObject -> JsonObject(rewritten(node).mapValues { migrated(it.value) })
        else -> node
    }

    private fun rewritten(node: JsonObject): Map<String, JsonElement> {
        if ("exerciseId" !in node) return node
        val triple = listOf("targetSets", "targetReps", "targetWeightKg")
        if (triple.any { it in node }) {
            return scheme(node, count = node["targetSets"], reps = node["targetReps"], load = node["targetWeightKg"], previous = triple)
        }
        if (node["sets"] is JsonPrimitive) {
            return scheme(node, count = node["sets"], reps = node["reps"], load = node["weightKg"], previous = listOf("sets", "reps", "weightKg"))
        }
        return node
    }

    private fun scheme(
        node: JsonObject,
        count: JsonElement?,
        reps: JsonElement?,
        load: JsonElement?,
        previous: List<String>,
    ): Map<String, JsonElement> {
        val kept = node.filterKeys { it !in previous }
        val sets = (count as? JsonPrimitive)?.intOrNull ?: return kept
        val set = JsonObject(buildMap {
            (reps as? JsonPrimitive)?.takeIf { it !is JsonNull }?.let { put("reps", it) }
            (load as? JsonPrimitive)?.takeIf { it !is JsonNull }?.let { put("weightKg", it) }
        })
        return kept + ("sets" to JsonArray(List(sets) { set }))
    }
}

// Temp file renamed over the old copy, so a crash mid-write leaves the last good file on disk.
// Failures are swallowed: the memory copy is the truth.
internal fun writeAtomically(file: File, text: String) {
    runCatching {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        try {
            Files.move(tmp.toPath(), file.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
