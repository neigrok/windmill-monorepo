package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.Against
import works.windmill.gym.domain.AgainstMovement
import works.windmill.gym.domain.Effort
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.MovementProgress
import works.windmill.gym.domain.PersonalRecord
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Record
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.sync.GymEstimate
import works.windmill.gym.domain.sync.TrainingHistory
import works.windmill.gym.domain.sync.Session as EngineSession
import works.windmill.sync.api.Change
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.Command
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.signIn
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// The receipt's record and the record page's tiles are the shared reads, projected: every shared `review` and `record`
// case answers the same through `EngineTraining`, and a phone that has not read its account asserts neither.
class SharedReadParityTests {
    @Test fun everySharedReviewCaseIsTheReceiptsReview() {
        val cases = sharedCases("review")
        assertEquals(13, cases.size)
        for (case in cases) Engine.memory(SyncSchema.registry, clock = clock(case.member("input").member("now").long())).use { engine ->
            seed(engine, case.member("input").member("records").member("drawn").arr())
            val id = case.member("input").member("input").member("args").arr().single().str()
            val expected = case.member("expect").member("result")
            assertEquals(case.member("name").str(), sharedForm(expected).jcs, sharedForm(EngineTraining(engine).review(id)).jcs)
        }
    }

    @Test fun everySharedRecordCaseIsTheRecordPagesStanding() {
        val cases = sharedCases("record")
        assertEquals(5, cases.size)
        for (case in cases) Engine.memory(SyncSchema.registry, clock = clock(case.member("input").member("now").long())).use { engine ->
            seed(engine, case.member("input").member("records").member("drawn").arr())
            val id = case.member("input").member("input").member("args").arr().single().str()
            val expected = case.member("expect").member("result")
            val movement = EngineTraining(engine).progress().movement(id)
            assertEquals(case.member("name").str(),
                Json.objectOf("bestE1rm" to (expected.obj()["bestE1rm"] ?: Json.Null), "heaviest" to (expected.obj()["heaviest"] ?: Json.Null)).jcs,
                standing(movement).jcs)
        }
    }

    @Test fun anEarlierHeavyHighRepSetNeverHidesTheStrongerEstimateItsLoadAlsoHeld() = withEngine(signedIn = false) { engine ->
        seedWorkout(engine, "earlier", 1_799_000_000_000, listOf(100.0 to 12, 100.0 to 10, 90.0 to 5, 90.0 to 5))
        seedWorkout(engine, "today", 1_799_500_000_000, List(4) { 110.0 to 5 })
        val training = EngineTraining(engine)
        assertEquals(Review(PersonalRecord("heaviest", "bench-press", 110.0, 110.0, 5, 100.0, 1_799_000_000_000)),
            training.review("today"))
        assertEquals(sharedReview(engine, "today").member("record").jcs, sharedForm(training.review("today")).member("record").jcs)
    }

    @Test fun aPhoneThatHasNotReadItsAccountClaimsNoRecordAndShowsNoTiles() = withEngine(signedIn = true) { engine ->
        seedWorkout(engine, "earlier", java.time.Instant.parse("2027-01-04T10:00:00Z").toEpochMilli(), List(4) { 100.0 to 5 })
        seedWorkout(engine, "today", java.time.Instant.parse("2027-01-10T10:00:00Z").toEpochMilli(), List(4) { 110.0 to 5 })
        val training = EngineTraining(engine)
        assertFalse(training.firstPullComplete)
        assertEquals(Review(), training.review("today"))
        assertTrue(sharedReview(engine, "today").obj()["record"] == null)
        val movement = training.progress().movement("bench-press")
        assertEquals(2, movement.sessions.size)
        assertNull(movement.best)
        assertNull(movement.heaviest)
        assertFalse(movement.hasChart(java.time.ZoneOffset.UTC))
        val bench = Exercise("bench-press", "Bench Press", "press", "barbell", 2.5)
        val page = Record.page(MovementRecord.of(bench, training.details(), 1_800_000_000_000), 1_800_000_000_000, movement)
        assertEquals(Record.Page("Bench Press", "Barbell", emptyList(), emptyList(),
            listOf(Record.Day("10 Jan", "110 × 5 · 110 × 5 · 110 × 5 · 110 × 5"), Record.Day("4 Jan", "100 × 5 · 100 × 5 · 100 × 5 · 100 × 5")),
            null, null), page)
    }

    @Test fun theReceiptCountsEverySetOfTheComparisonAndItsBoundsBesideTheSharedTopSet() = withEngine(signedIn = false) { engine ->
        seedWorkout(engine, "before", 1_799_000_000_000, listOf(50.0 to 5, 55.0 to 6, 60.0 to 4), routineId = "routineA")
        seedWorkout(engine, "now", 1_799_500_000_000, listOf(75.0 to 8, 75.0 to 6, 80.0 to 8), routineId = "routineA")
        assertEquals(Review(PersonalRecord("e1rm", "bench-press", 80.0 * (1 + 8 / 30.0), 80.0, 8, 60.0 * (1 + 4 / 30.0),
            1_799_000_000_000), Against("before", null, 1_799_000_000_000, listOf(
            AgainstMovement("bench-press", Effort(3, 8, 80.0, minReps = 6, maxReps = 8, minWeightKg = 75.0),
                Effort(3, 4, 60.0, minReps = 4, maxReps = 6, minWeightKg = 50.0)),
            AgainstMovement("row", Effort(1, 1, 0.0), Effort(1, 1, 0.0))))), EngineTraining(engine).review("now"))
    }

    // No set here carries a server number, as on a signed-out phone: the picker's last set is the last one logged.
    @Test fun thePickersLastSetIsTheLastOneLoggedWhileNoSetIsNumbered() = withEngine(signedIn = false) { engine ->
        val start = 1_799_000_000_000L
        seed(engine, listOf(row(Gym.Types.session, "w1", "startedAt" to Json.of(start), "finishedAt" to Json.of(start + 3_600_000),
            "closedBy" to Json.of("finish"))) + listOf("set_zz" to (100.0 to 5), "set_mm" to (90.0 to 5), "set_aa" to (80.0 to 8)).mapIndexed { index, (id, set) ->
            row(Gym.Types.set, id, "sessionId" to Json.of("w1"), "exerciseId" to Json.of("bench-press"), "weightKg" to Json.of(set.first),
                "reps" to Json.of(set.second), "note" to Json.of(""), "completedAt" to Json.of(start + 60_000L * (index + 1)))
        })
        assertEquals(listOf(LastSet("bench-press", 80.0, 8, start)), EngineTraining(engine).lastSets())
    }

    private fun sharedCases(method: String): List<Json> {
        var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (directory != null && !File(directory, "packages/api-contract").isDirectory) directory = directory.parentFile
        val file = File(requireNotNull(directory) { "the repo's packages/api-contract was not found" }, "packages/api-contract/gym/domain/training-reads.json")
        return Json.parse(file.readText()).arr().filter {
            val input = it.member("input")
            input.member("read").str() == "TrainingHistory" && input.member("input").member("method").str() == method
        }
    }

    private fun clock(now: Long) = object : EngineClock { override fun now() = now }

    // Every session, set and movement a case holds, predicted by one command so the server's own fields land too.
    private fun seed(engine: Engine, rows: List<Json>) {
        val changes = rows.filter { it.member("t").str() in setOf(Gym.Types.session, Gym.Types.set, Gym.Types.exercise) }.map { row ->
            Change.create(row.member("t").str(), NewID.Given(RecordID(row.member("id").str())),
                row.member("f").obj().mapValues { (_, value) -> value.arr().first() })
        }
        val command = Command(Gym.Commands.start, Json.objectOf("id" to Json.of("seed"), "startedAt" to Json.of(1L)))
        assertTrue(engine.commit(ScopeRef(Gym.scope), Gesture(emptyList(), command = command, predict = changes)) is CommitOutcome.Committed)
    }

    // A finished workout of bench sets; one in a routine also holds a single bodyweight row.
    private fun seedWorkout(engine: Engine, id: String, startedAt: Long, sets: List<Pair<Double, Int>>, routineId: String? = null) {
        fun set(index: Int, exercise: String, kg: Double, reps: Int) = row(Gym.Types.set, "$id-set$index", "sessionId" to Json.of(id),
            "exerciseId" to Json.of(exercise), "weightKg" to Json.of(kg), "reps" to Json.of(reps), "note" to Json.of(""),
            "completedAt" to Json.of(startedAt + 60_000L * (index + 1)))
        val session = row(Gym.Types.session, id, *listOfNotNull("startedAt" to Json.of(startedAt), "finishedAt" to Json.of(startedAt + 3_600_000),
            "closedBy" to Json.of("finish"), routineId?.let { "routineId" to Json.of(it) }).toTypedArray())
        seed(engine, listOf(session) + sets.mapIndexed { index, (kg, reps) -> set(index, "bench-press", kg, reps) } +
            listOfNotNull(routineId?.let { set(sets.size, "row", 0.0, 1) }))
    }

    private fun row(type: String, id: String, vararg fields: Pair<String, Json>) = Json.objectOf("t" to Json.of(type), "id" to Json.of(id),
        "f" to Json.Obj(fields.map { (name, value) -> name to Json.array(value) }))

    private fun withEngine(signedIn: Boolean, body: (Engine) -> Unit) = Engine.memory(SyncSchema.registry, clock = clock(1_800_000_000_000)).use { engine ->
        if (signedIn) engine.signIn("A", mapOf("gym" to true))
        body(engine)
    }

    private fun sharedReview(engine: Engine, id: String): Json = ActionRunner(engine, engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
        .read(EngineSession.scope) { TrainingHistory(it).review(Id(id, EngineSession)) }

    // What the shared review decides, in its own words: the record whole, and the comparison's sessions, movements, top
    // sets and plan. The receipt counts every set beside the top one, so the shared count of top-load sets is left out.
    private fun sharedForm(review: Json): Json = Json.objectOf("record" to (review.obj()["record"] ?: Json.Null),
        "against" to (review.obj()["against"]?.let { against -> Json.objectOf(
            "sessionId" to against.member("sessionId"), "routine" to (against.obj()["routine"] ?: Json.Null), "startedAt" to against.member("startedAt"),
            "movements" to Json.Arr(against.member("movements").arr().map { movement -> Json.objectOf("exerciseId" to movement.member("exerciseId"),
                "now" to top(movement.member("now")), "before" to (movement.obj()["before"]?.let(::top) ?: Json.Null),
                "planned" to (movement.obj()["planned"]?.let { it.obj()["sets"] ?: Json.Arr(emptyList()) } ?: Json.Null)) }))
        } ?: Json.Null))

    private fun top(effort: Json) = Json.objectOf("weightKg" to effort.member("weightKg"), "reps" to effort.member("reps"))

    private fun sharedForm(review: Review): Json = Json.objectOf(
        "record" to (review.record?.let { Json.objectOf("kind" to Json.of(it.kind), "exerciseId" to Json.of(it.exerciseId), "value" to Json.of(it.value),
            "weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps), "previous" to Json.of(it.previous), "previousAt" to Json.of(it.previousAtMs)) } ?: Json.Null),
        "against" to (review.against?.let { against -> Json.objectOf("sessionId" to Json.of(against.sessionId),
            "routine" to (against.routine?.let(Json::of) ?: Json.Null), "startedAt" to Json.of(against.startedAtMs),
            "movements" to Json.Arr(against.movements.map { movement -> Json.objectOf("exerciseId" to Json.of(movement.exerciseId),
                "now" to Json.objectOf("weightKg" to Json.of(movement.now.weightKg), "reps" to Json.of(movement.now.reps)),
                "before" to (movement.before?.let { Json.objectOf("weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps)) } ?: Json.Null),
                "planned" to (movement.planned?.let { line -> Json.Arr(line.sets.map { set -> Json.Obj(listOfNotNull(set.reps?.let { "reps" to Json.of(it) },
                    set.weightKg?.let { "weightKg" to Json.of(it) })) }) } ?: Json.Null)) }))
        } ?: Json.Null))

    // The two tiles a record page stands on, as the shared record read spells them.
    private fun standing(movement: MovementProgress): Json = Json.objectOf(
        "bestE1rm" to (movement.best?.let { point -> point.fact.estimate!!.let {
            Json.objectOf("at" to Json.of(point.startedAt), "weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps), "e1rm" to Json.of(it.e1rm!!))
        } } ?: Json.Null),
        "heaviest" to (movement.heaviest?.let { point -> point.fact.heaviest.let { fact -> Json.Obj(listOfNotNull("at" to Json.of(point.startedAt),
            "weightKg" to Json.of(fact.weightKg), "reps" to Json.of(fact.reps), GymEstimate.value(fact.weightKg, fact.reps, fact.rpe)?.let { "e1rm" to Json.of(it) })) }
        } ?: Json.Null))
}
