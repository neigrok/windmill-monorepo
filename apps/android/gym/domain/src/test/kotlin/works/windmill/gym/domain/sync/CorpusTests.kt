package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.*
import works.windmill.sync.core.Json
import works.windmill.sync.schema.SyncSchema

class CorpusTests {
    val book = RuleBook(SyncSchema.registry, listOf(Note, WeighIn), NoteRules.rules + WeighInRules.rules)
    val corpus = ProductCorpus(book)

    @Test fun everyProductFileIsClaimedAndEveryVectorPasses() {
        val paths = listOf("gym/domain/rules.json", "gym/domain/values.json", "gym/domain/notes-actions.json", "gym/domain/bodyweight-actions.json", "gym/rules/bodyweight.json")
        assertEquals(paths.sorted(), Contract.files("gym"))
        RuleBookParity.check(book, paths[0])
        var cases = 1
        for (path in paths.drop(1)) for (vector in Contract.vectors(path)) {
            val input = vector.input["input"]
            val actual = when (path) {
                "gym/domain/values.json" -> corpus.value(vector)
                "gym/domain/notes-actions.json" -> corpus.decision(SaveNoteCall(Note.fromForm(input!!.member("note"))), vector, { it.json }, ::refusalForm)
                "gym/domain/bodyweight-actions.json" -> when (vector.input.member("action").str()) {
                    "SaveWeighIn" -> {
                        val day = LocalDay.parse(input!!.member("day").str())!!
                        val blank = WeighIn(day)
                        corpus.save(WeighIn, GymRefusal, vector, blank,
                            { it.copy(kg = input["kg"]?.orNull()?.num()) },
                            { Json.objectOf("id" to blank.id.json, "fields" to Json.Obj(it.values.toList())) }, ::refusalForm)
                    }
                    "DeleteWeighIn" -> corpus.decision(deleteWeighIn(WeighIn(LocalDay.parse(input!!.member("day").str())!!).id), vector, { Json.Null }, ::refusalForm)
                    else -> error("unclaimed gym action")
                }
                "gym/rules/bodyweight.json" -> corpus.read(vector, WeighIn.scope) { bodyweightForm(Bodyweight(it), input) }
                else -> error("unclaimed gym file")
            }
            assertEquals("$path · ${vector.name}", vector.expect.jcs, actual.jcs)
            cases++
        }
        println("Gym corpus: ${paths.size}/${paths.size} files, $cases cases, no unclaimed file")
    }

    @Test fun existingSharedLocalRulesAndCodesAreCovered() {
        RuleBookCheck.check(book, GymRefusal, "gym/domain/values.json")
        RegistryCheck.entity(Note, Note(Id("note0001", Note), "Title", "Body"), book)
        RegistryCheck.entity(WeighIn, WeighIn(LocalDay.parse("2026-01-01")!!, 80.0, Instant(1)), book)
    }
}

fun refusalForm(value: GymRefusal): Json = when (value) {
    is GymRefusal.Invalid -> Json.objectOf("invalid" to value.violation.json)
    is GymRefusal.Stale -> Json.objectOf("stale" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Gone -> Json.objectOf("gone" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Taken -> Json.objectOf("taken" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Future -> Json.objectOf("future" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Full -> Json.objectOf("full" to Json.objectOf("type" to Json.of(value.type), "cap" to Json.of(value.cap), "path" to Json.of(value.path.name)))
    is GymRefusal.Other -> Json.objectOf("other" to value.refused.form)
    is GymRefusal.SessionFinished -> Json.objectOf("sessionFinished" to value.refused.form)
    is GymRefusal.SessionOpen -> Json.objectOf("sessionOpen" to value.refused.form)
    is GymRefusal.SessionOverlap -> Json.objectOf("sessionOverlap" to value.refused.form)
    is GymRefusal.PayloadConflict -> Json.objectOf("payloadConflict" to value.refused.form)
    is GymRefusal.UnknownExercise -> Json.objectOf("unknownExercise" to value.refused.form)
    is GymRefusal.BadInstant -> Json.objectOf("badInstant" to value.refused.form)
    is GymRefusal.ProposalSettled -> Json.objectOf("proposalSettled" to value.refused.form)
    is GymRefusal.ProposalSuperseded -> Json.objectOf("proposalSuperseded" to value.refused.form)
}

fun bodyweightForm(value: Bodyweight, input: Json?): Json {
    fun entry(item: Bodyweight.Entry) = Json.objectOf("day" to Json.of(item.day.text), "kg" to Json.of(item.kg))
    fun chart(window: Bodyweight.Window): Json {
        val drawn = value.chart(window)
        return Json.objectOf("dots" to Json.Arr(drawn.dots.map(::entry)), "gaps" to Json.Arr(drawn.gaps.map {
            Json.objectOf("after" to Json.of(it.after.text), "before" to Json.of(it.before.text))
        }))
    }
    return Json.objectOf("stance" to Json.of(value.stance.name), "today" to Json.of(value.today.text), "reading" to (value.reading?.let {
        Json.objectOf("entry" to entry(it.entry), "daysAgo" to Json.of(it.daysAgo))
    } ?: Json.Null), "recent" to chart(Bodyweight.Window.recent), "all" to chart(Bodyweight.Window.all),
        "list" to Json.Arr(value.entries(input?.get("from")?.orNull()?.str()?.let(LocalDay::parse), input?.get("to")?.orNull()?.str()?.let(LocalDay::parse)).map(::entry)))
}
