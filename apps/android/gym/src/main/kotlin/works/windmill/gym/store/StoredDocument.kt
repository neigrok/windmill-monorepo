package works.windmill.gym.store

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.SerializationException
import works.windmill.platform.telemetry.Telemetry
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
internal class StoredDocument(private val file: File, private val telemetry: Telemetry) {
    fun tree(): JsonObject? {
        if (!file.exists()) return null
        return try {
            val parsed = diskJson.parseToJsonElement(file.readText()) as? JsonObject
                ?: throw SerializationException("Stored document must be an object")
            migrated(parsed) as JsonObject
        } catch (error: Exception) {
            telemetry.failure("gym.storage.read", error)
            null
        }
    }

    fun <T> write(value: T, strategy: SerializationStrategy<T>) {
        try {
            val text = diskJson.encodeToString(strategy, value)
            file.parentFile?.mkdirs()
            val temporary = File(file.parentFile, file.name + ".tmp")
            temporary.writeText(text)
            try {
                Files.move(temporary.toPath(), file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (unsupported: AtomicMoveNotSupportedException) {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (error: Exception) {
            telemetry.failure("gym.storage.write", error)
        }
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
        return try {
            diskJson.decodeFromJsonElement(strategy, node)
        } catch (error: Exception) {
            telemetry.failure("gym.storage.decode", error)
            null
        }
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
