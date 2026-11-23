package works.windmill.gym.coach.turn

import android.content.res.AssetManager
import works.windmill.agent.coach.Profile
import works.windmill.domain.kit.AbilityClass
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Seat
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.sync.core.Json

// The words the model reads in a gym turn: the contract's own files (packages/api-contract/gym/coach), which this module ships in its assets under gym-coach/.
class CoachWords(val prompt: String, val firstContent: Json, val refusals: Json) {
    companion object {
        fun shipped(assets: AssetManager): CoachWords {
            fun read(name: String) = assets.open("gym-coach/$name").use { it.readBytes() }
            return CoachWords(read("prompt.md").decodeToString(), Json.parse(read("first-content.json")), Json.parse(read("refusals.json")))
        }
    }
}

// Gym's profile for the Coach engine, for each seat (gym Coach on the AI service §3): catalog/3's tools the seat is offered, each strict as the catalog states it, the words every app ships, the limits of phone-hosted Coach abilities Appendix A and the groups the gate allows once. The engine builds the first content around what the host gives it, so the words of history and context are put together here, as the server puts them together today.
class GymProfile(private val catalog: Catalog, private val words: CoachWords) {
    private val earlier = words.firstContent.member("earlierConversation")

    fun of(seat: Seat): Profile {
        val tools = catalog.offered(seat)
        val offered = tools.map { it.name }.toSet()
        val groups = listOf(
            group("routine-proposal", listOf("propose_routine_change", "propose_routine_removal"), "one-proposal"),
            group("workout-proposal", listOf("propose_workout_change"), "one-proposal"),
            group("note", listOf("save_note"), "one-note"),
        ).filter { group -> group.member("tools").arr().all { it.str() in offered } }
        return Profile(Json.objectOf(
            "name" to Json.of(name), "version" to Json.of(version),
            "system" to Json.array(Json.of(words.prompt)),
            "firstContent" to Json.objectOf("historyPrefix" to Json.of(""), "contextPrefix" to Json.of(""), "questionPrefix" to Json.of(""),
                "emptyQuestion" to words.firstContent.member("pictureOnlyQuestion")),
            "refusals" to Json.Obj(refusals().toList()),
            "tools" to Json.Arr(tools.map { ability ->
                Json.objectOf("name" to Json.of(ability.name), "description" to Json.of(ability.description), "input" to ability.input,
                    "countsAsWrite" to Json.of(ability.kind == AbilityClass.add), "strict" to Json.of(ability.strict))
            }),
            "groups" to Json.Arr(groups),
            "model" to Json.of("large"), "effort" to Json.of(if (seat == Seat.bound) "medium" else "low"),
            "output" to Json.objectOf("maxTokens" to Json.of(2_000), "minTokens" to Json.of(1_024)),
            "label" to Json.of("coach"),
            "limits" to Json.objectOf("modelCalls" to Json.of(8), "abilityCalls" to Json.of(12), "writes" to Json.of(6)),
        ))
    }

    // The earlier conversation as one block, oldest first, each line under its speaker's name; nothing when there is none.
    fun history(lines: List<CoachMessage>): String {
        if (lines.isEmpty()) return ""
        return earlier.member("marker").str() + lines.joinToString("") { "\n\n" + earlier.member(it.role.name).str() + ": " + it.text }
    }

    // A context read as the model reads it: its lead sentence, then its result in canonical form.
    fun context(ability: String, result: ByteArray): String = words.firstContent.member("contextLeads").member(ability).str() + "\n" + result.decodeToString()

    // The sentence beside each code the model may read. The gate's codes are the words' own; `one-proposal` names no target, since one code answers both groups. `invalid-input` and the executor's own codes have no sentence in the words, so the model reads the code alone.
    private fun refusals(): Map<String, Json> {
        val sentences = words.refusals.obj().mapValues { (code, sentence) ->
            if (code == "one-proposal") Json.of(sentence.str().replace("{target}", "routine or workout")) else sentence
        }
        val unsaid = (listOf("invalid-input") + AbilityRefusal.entries.map { it.code }).filter { it !in sentences }
        return sentences + unsaid.associateWith { Json.of("") }
    }

    private fun group(name: String, tools: List<String>, code: String) = Json.objectOf(
        "name" to Json.of(name), "tools" to Json.Arr(tools.map(Json::of)), "maxSuccesses" to Json.of(1), "code" to Json.of(code))

    companion object {
        const val name = "gym.coach"
        const val version = 1L
    }
}
