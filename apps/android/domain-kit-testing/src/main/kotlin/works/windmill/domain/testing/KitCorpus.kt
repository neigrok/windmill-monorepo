package works.windmill.domain.testing

import java.io.File
import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.testing.Corpus
import works.windmill.sync.testing.Handler

object KitCorpus {
    val handlers: Map<String, Handler> = mapOf(
        "value/text.json" to { value(it) }, "value/number.json" to { value(it) }, "value/choice.json" to { value(it) },
        "value/count.json" to { input ->
            val spec = input.member("spec")
            val path = path(input, spec)
            val count = CountSpec(spec.member("path").str(), spec.member("min").long().toInt(), spec.member("max").long().toInt())
            try {
                val items = input.member("items").orNull()?.arr()?.let { items ->
                    count.apply(items, path) { item, at -> input["itemSpec"]?.let { apply(it, item, at) } ?: item }
                }
                Json.objectOf("items" to (items?.let(Json::Arr) ?: Json.Null))
            } catch (violation: Violation) { Json.objectOf("violation" to violation.json) }
        },
        "time/day.json" to { input ->
            fun day(key: String) = LocalDay.parse(input.member(key).str()) ?: throw IllegalArgumentException("day")
            when (input.member("op").str()) {
                "fromInstant" -> Json.objectOf("day" to Json.of(LocalDay.from(Instant(input.member("ms").long()), input.member("offsetSeconds").long().toInt()).text))
                "parse" -> Json.objectOf("day" to Json.of(day("text").text))
                "adding" -> Json.objectOf("day" to Json.of(day("day").adding(input.member("days").long()).text))
                "daysUntil" -> Json.objectOf("days" to Json.of(day("day").daysUntil(day("other"))))
                "weekday" -> Json.objectOf("weekday" to Json.of(day("day").weekday))
                else -> error("unknown day operation")
            }
        },
        "order/list.json" to WriteVectors::list,
        "capacity/count.json" to WriteVectors::capacity,
        "plan/translate.json" to WriteVectors::translate,
        "run/pipeline.json" to WriteVectors::pipeline,
        "draft/save.json" to WriteVectors::save,
        "draft/script.json" to WriteVectors::script,
        "refusal/subject.json" to WriteVectors::subject,
    )
    fun valueVector(input: Json): Json = if (input["spec"]?.get("kind")?.str() == "count") handlers.getValue("value/count.json")(input) else value(input)
    fun path(input: Json, spec: Json): Path = Path(input["at"]?.str() ?: spec.member("path").str().substringAfterLast('.'))
    fun textSpec(spec: Json): TextSpec = TextSpec(spec.member("path").str(), MeasureUnit.valueOf(spec.member("unit").str()),
        spec.member("min").long().toInt(), spec.member("max").long().toInt(), spec.member("trim").bool(), spec.member("nfc").bool())
    fun apply(spec: Json, value: Json, at: Path, asInt: Boolean = false): Json {
        return when (spec.member("kind").str()) {
            "text" -> textSpec(spec).applyOptional(value.orNull()?.str(), at)?.let { Json.of(it) } ?: Json.Null
            "number" -> {
                val numberSpec = NumberSpec(spec.member("path").str(), spec.member("min").num(), spec.member("max").num(),
                    spec["integer"]?.bool() ?: false, spec["quantum"]?.orNull()?.num())
                if (value === Json.Null) return Json.Null
                val number = if (value is Json.Num) value.value else when (value.str()) {
                    "NaN" -> Double.NaN; "Infinity" -> Double.POSITIVE_INFINITY; "-Infinity" -> Double.NEGATIVE_INFINITY
                    else -> error("unknown non-finite number")
                }
                if (asInt) {
                    require(number.isFinite() && number >= Int.MIN_VALUE && number <= Int.MAX_VALUE && number == number.toInt().toDouble())
                    Json.of(numberSpec.apply(number.toInt(), at))
                } else Json.of(numberSpec.apply(number, at))
            }
            "choice" -> ChoiceSpec(spec.member("path").str(), spec.member("values").arr().map { it.str() }).applyOptional(value.orNull()?.str(), at)?.let { Json.of(it) } ?: Json.Null
            else -> error("unknown value spec")
        }
    }
    fun value(input: Json): Json {
        input["isBlank"]?.let { return Json.objectOf("isBlank" to Json.of(TextSpec.isBlank(it.str()))) }
        val spec = input.member("spec")
        input["measure"]?.let { return Json.objectOf("measured" to Json.of(textSpec(spec).measure(it.str()))) }
        return try { Json.objectOf("value" to apply(spec, input.member("value"), path(input, spec), input["as"]?.str() == "int")) }
        catch (violation: Violation) { Json.objectOf("violation" to violation.json) }
    }
}

fun main(args: Array<String>) {
    require(args.size in 1..2 && (args.size == 1 || args[1] in listOf("--all", "--subset")))
    System.setProperty("windmill.contract", File(args[0]).absolutePath)
    val corpus = Corpus(File(args[0], "domain-kit"))
    check(corpus.paths.toSet() == KitCorpus.handlers.keys) {
        "kit corpus file inventory differs: missing ${(KitCorpus.handlers.keys - corpus.paths.toSet()).sorted()}; unclaimed ${(corpus.paths.toSet() - KitCorpus.handlers.keys).sorted()}"
    }
    val supported = corpus.paths.filter { it in KitCorpus.handlers }
    println("kit corpus: ${supported.size}/${corpus.paths.size} files, ${supported.sumOf { corpus.vectors(it).size }}/${corpus.paths.sumOf { corpus.vectors(it).size }} vectors")
    corpus.run(KitCorpus.handlers, corpus.paths)
}
