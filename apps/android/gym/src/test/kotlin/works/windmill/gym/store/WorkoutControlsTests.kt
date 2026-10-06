package works.windmill.gym.store

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WorkoutEvent
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.platform.storage.AtomicDocument

class WorkoutControlsTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun controlsFile(): File = File(tmp.root, "gym-${System.nanoTime()}.json")

    private fun aSet(id: String, exerciseId: String = "bench-press", at: Long) = TrainingSet(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, completedAtMs = at)

    @Test
    fun theSelectedMovementAndTheStoredRowsSurviveReopeningAndStayWithTheirSeat() {
        val file = controlsFile()
        val controls = WorkoutControls(file)
        controls.hold(Session(id = "live", startedAtMs = 1_000))
        controls.choose("bench-press")
        controls.store(aSet("set_a", at = 2_000), "live")
        controls.choose("overhead-press")
        val stored = aSet("set_a", at = 2_000).copy(setNumber = 7)
        controls.store(stored, "live")
        controls.flush()

        val reopened = WorkoutControls(file)
        assertEquals(listOf("overhead-press", listOf(stored)), listOf(reopened.chosenMovement, reopened.sets))
        reopened.adopt("another")
        assertNull(reopened.chosenMovement)
    }

    @Test
    fun anUnreadableFileOpensEmptyAndRefusesToBeOverwritten() {
        val file = controlsFile()
        file.writeText("not json at all")

        val controls = WorkoutControls(file)
        assertNull(controls.session)
        assertEquals(emptyList<TrainingSet>(), controls.sets)
        assertFalse(controls.writable)
        assertThrows(IllegalStateException::class.java) { controls.hold(Session("new", 2_000)) }
        assertEquals("not json at all", file.readText())
    }

    // The bytes an earlier app version wrote: a live session on a plan in the scalar `sets · reps ·
    // weightKg` shape and a set carrying the retired delivery fields. Opening rewrites the plan on the
    // way in and reads past the fields this version no longer holds; the next flush writes this
    // version's shape.
    @Test
    fun aDocumentWrittenByAnEarlierVersionIsRewrittenOnOpenAndNothingIsLost() {
        val file = controlsFile()
        file.writeText(
            """{"queues":{"anon":{"session":{"id":"ses_9","startedAt":5000,"routineId":"rt_1","plan":{"routine":"Push A","entries":[""" +
            """{"exerciseId":"bench-press","sets":3,"reps":8,"weightKg":60.0,"restSeconds":90},{"exerciseId":"chin-up","sets":2},{"exerciseId":"face-pull"}]}},""" +
            """"entries":{"set_z":{"set":{"id":"set_z","exerciseId":"bench-press","weightKg":60.0,"reps":8,"kind":"working","completedAt":5100},""" +
            """"sessionId":"ses_9","needsPush":true,"remints":0}},"order":["bench-press"],"unclaimed":true}}}"""
        )
        val plan = PlanSnapshot(routine = "Push A", entries = listOf(
            PlanEntry(exerciseId = "bench-press", sets = List(3) { SetTarget(8, 60.0) }),
            PlanEntry(exerciseId = "chin-up", sets = List(2) { SetTarget() }),
            PlanEntry(exerciseId = "face-pull"),
        ))
        fun WorkoutControls.assertWhole() {
            assertEquals("ses_9", session?.id)
            assertEquals(plan, session?.plan)
            assertEquals(listOf("bench-press"), order)
            assertEquals(listOf("set_z"), sets.map { it.id })
        }

        val controls = WorkoutControls(file)
        controls.assertWhole()
        assertTrue(controls.writable)
        assertTrue("not written back until the next flush", file.readText().contains("\"sets\":3"))

        controls.flush()
        val written = file.readText()
        assertFalse(written.contains("\"sets\":3") || written.contains("\"sets\":2"))
        assertFalse(written.contains("needsPush") || written.contains("unclaimed"))
        assertTrue(written.contains("\"sets\":[{\"reps\":8,\"weightKg\":60.0}"))
        assertTrue(written.contains("{\"exerciseId\":\"face-pull\"}"))
        WorkoutControls(file).assertWhole()
    }

    // A row this build cannot read costs that row and never the document around it: a set beside an
    // unreadable one is still held, and an unreadable live session leaves its sets in place.
    @Test
    fun oneUnreadableRowCostsThatRowAndNeverTheDocument() {
        val file = controlsFile()
        file.writeText(
            """{"queues":{"anon":{"session":{"id":"ses_1","startedAt":1000},"entries":{""" +
            """"set_a":{"set":{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"completedAt":1100},"sessionId":"ses_1"},""" +
            """"set_b":{"set":{"id":"set_b","exerciseId":"bench-press","weightKg":82.5,"reps":"eight","completedAt":1200},"sessionId":"ses_1"}},""" +
            """"order":["bench-press"]},""" +
            """"u.alice":{"session":{"id":"ses_2","startedAt":"noon"},"entries":{""" +
            """"set_c":{"set":{"id":"set_c","exerciseId":"deadlift","weightKg":140.0,"reps":3,"completedAt":2100},"sessionId":"ses_2"}}}}}"""
        )

        val anonymous = WorkoutControls(file)
        assertEquals("ses_1", anonymous.session?.id)
        assertEquals(listOf("set_a"), anonymous.sets.map { it.id })
        assertEquals(listOf("bench-press"), anonymous.order)

        val alice = WorkoutControls(file, deviceOwner = "alice")
        assertNull(alice.session)
        assertEquals(listOf("set_c"), alice.sets("ses_2").map { it.id })
    }

    @Test
    fun theSetsComeBackInTheOrderTheyWereLiftedAndAStoredRowReplacesTheHeldOne() {
        val controls = WorkoutControls(controlsFile())
        controls.store(aSet("set_c", at = 3_000), sessionId = "ses_1")
        controls.store(aSet("set_a", at = 1_000), sessionId = "ses_1")
        controls.store(aSet("set_b", at = 2_000), sessionId = "ses_1")
        controls.store(aSet("set_a", at = 1_000).copy(setNumber = 4), sessionId = "ses_1")

        assertEquals(listOf("set_a" to 4, "set_b" to null, "set_c" to null),
            controls.sets("ses_1").map { it.id to it.setNumber })
    }

    @Test
    fun closingASessionLetsGoOfItAndEverySetItHeld() {
        val controls = WorkoutControls(controlsFile())
        controls.hold(Session(id = "ses_1", startedAtMs = 1_000))
        controls.choose("bench-press")
        controls.store(aSet("set_a", at = 1_100), sessionId = "ses_1")
        controls.store(aSet("set_b", at = 1_200), sessionId = "ses_other")
        controls.close("ses_1")

        assertNull(controls.session)
        assertEquals(emptyList<String>(), controls.order)
        assertEquals(emptyList<TrainingSet>(), controls.sets("ses_1"))
        assertEquals("another session's sets are not touched", listOf("set_b"), controls.sets("ses_other").map { it.id })
    }

    @Test
    fun theMovementOrderBelongsToItsSessionAndGoesWithIt() {
        val file = controlsFile()
        val controls = WorkoutControls(file)
        controls.hold(Session(id = "ses_1", startedAtMs = 1_000))
        controls.choose("bench-press")
        controls.choose("bench-press")
        controls.choose("back-squat")
        assertEquals(listOf("bench-press", "back-squat"), controls.order)

        controls.flush()
        assertEquals(listOf("bench-press", "back-squat"), WorkoutControls(file).order)

        controls.hold(Session(id = "ses_2", startedAtMs = 2_000))
        assertEquals("a different session is a different workout", emptyList<String>(), controls.order)
    }

    @Test
    fun aLiveSessionIsNeverDrawnForTheNextSeatAndComesBackWithItsOwn() {
        val file = controlsFile()
        val controls = WorkoutControls(file)
        controls.adopt("alice")
        controls.hold(Session(id = "ses_alice", startedAtMs = 1_000))
        controls.store(aSet("set_a", at = 1_100), "ses_alice")
        controls.flush()

        controls.adopt(null)
        assertNull("signing out draws no workout", controls.session)
        assertEquals(emptyList<TrainingSet>(), controls.sets)

        controls.adopt("bob")
        assertNull("and the next account is drawn none of it", controls.session)
        assertEquals(emptyList<TrainingSet>(), controls.sets("ses_alice"))

        val relaunched = WorkoutControls(file)
        relaunched.adopt("alice")
        assertEquals("ses_alice", relaunched.session?.id)
        assertEquals("A's set was kept with A's seat, never dropped", listOf("set_a"), relaunched.sets.map { it.id })
    }

    @Test
    fun repeatedSeatSelectionNeverMovesTheSignedOutWorkout() {
        val controls = WorkoutControls(controlsFile())
        controls.hold(Session(id = "ses_anon", startedAtMs = 1_000))
        controls.flush()

        controls.adopt("alice")
        assertNull(controls.session)
        controls.adopt(null)
        controls.adopt("alice")
        assertNull("returning to the account still does not take the workout", controls.session)
        controls.adopt(null)
        assertEquals("ses_anon", controls.session?.id)
    }

    @Test
    fun oneOfferCommitsItsSetAndNextRackTogetherAndCannotReturnAfterUndo() {
        val file = controlsFile()
        var writes = 0
        var nextId = 0
        val controls = WorkoutControls(file, write = { target, text -> writes++; AtomicDocument.write(target, text) })
        val live = Session("session", 100_000)
        controls.hold(live)
        controls.choose("bench")
        val now = WorkoutMoment(101_000, 1_000, "boot")
        val first = controls.prepare(null, now, true) { "set_${++nextId}" }
        val command = LogSetCommand(WorkoutKey("anon", live.id), requireNotNull(first.offer).id)
        val before = writes
        assertEquals(LogSetAcceptance.Accepted("set_1"), controls.accept(command, now, null) { "set_${++nextId}" })
        assertEquals(before + 1, writes)
        val set = TrainingSet("set_1", "bench", weightKg = 20.0, reps = 5, completedAtMs = now.wallMs)
        assertEquals(WorkoutControls.Entry(set, live.id, 101_000, WorkoutEvent(set.id, now), eventOrder = first.revision + 1),
            controls.entry("set_1"))
        assertEquals(setOf("set_1"), controls.workout.consumed)
        assertEquals(listOf("set_2", 2, "set_1", now), listOf(controls.workout.offer?.id,
            controls.workout.offer?.workingOrdinal, controls.latestSet(now)?.id, controls.latestSet(now)?.origin))
        val reopened = WorkoutControls(file)
        assertEquals(controls.workout, reopened.workout)
        assertEquals(controls.entry("set_1"), reopened.entry("set_1"))
        assertEquals(LogSetAcceptance.Stale, reopened.accept(command, now, null) { error("no new ID") })
        reopened.drop("set_1")
        reopened.prepare(null, now, true) { "set_${++nextId}" }
        assertEquals(emptyList<TrainingSet>(), reopened.sets)
        assertEquals(setOf("set_1"), reopened.workout.consumed)
        assertEquals(LogSetAcceptance.Stale, WorkoutControls(file).accept(command, now, null) { error("no new ID") })
    }

    @Test
    fun sameBootClockChangePreservesEventButNewBootRetiresTheOldOffer() {
        val file = controlsFile()
        var id = 0
        val controls = WorkoutControls(file)
        controls.hold(Session("session", 100_000))
        controls.choose("bench")
        val origin = WorkoutMoment(101_000, 1_000, "boot1")
        controls.prepare(null, origin, true) { "set_${++id}" }
        controls.accept(LogSetCommand(WorkoutKey("anon", "session"), requireNotNull(controls.workout.offer).id),
            origin, null) { "set_${++id}" }
        val afterClockEdit = WorkoutMoment(901_000, 4_000, "boot1")
        val reopened = WorkoutControls(file)
        reopened.prepare(null, afterClockEdit, true) { "set_${++id}" }
        assertEquals(origin, reopened.latestSet(afterClockEdit)?.origin)
        val oldOffer = requireNotNull(reopened.workout.offer)
        val afterBoot = WorkoutMoment(902_000, 100, "boot2")
        reopened.prepare(null, afterBoot, true) { "set_${++id}" }
        assertEquals(listOf("set_1"), reopened.sets.map { it.id })
        assertEquals(LogSetAcceptance.Stale, reopened.accept(LogSetCommand(oldOffer.key, oldOffer.id), afterBoot,
            null) { error("no new ID") })
    }

    @Test
    fun malformedWorkoutControlsCannotBeOverwrittenOrUsedAsAnEmptyDocument() {
        for (controls in listOf("""{"version":2}""", """{"rack":{"reps":"bad"}}""",
            """{"consumed":false}""", """{"offer":{"id":"missing-context"}}""",
            """{"futureAuthority":true}""",
            """{"rack":{"exerciseId":"bench","weightKg":20.0,"reps":5,"basisSetCount":0,"edited":false,"revision":1,"futureAuthority":true}}""")) {
            val file = controlsFile()
            val raw = """{"queues":{"anon":{"session":{"id":"session","startedAt":100000},"workout":$controls}}}"""
            file.writeText(raw)
            val opened = WorkoutControls(file)
            assertFalse(opened.writable)
            assertThrows(IllegalStateException::class.java) { opened.hold(Session("new", 200_000)) }
            assertEquals(raw, file.readText())
        }
    }

    @Test
    fun malformedSeatContainersCannotBeOverwrittenAsAnEmptyDocument() {
        for (text in listOf("""{"queues":[]}""", """{"queues":{"u.A":true}}""")) {
            val file = controlsFile().apply { writeText(text) }
            val controls = WorkoutControls(file, "A")
            assertFalse(controls.writable)
            assertThrows(IllegalStateException::class.java) { controls.hold(Session("new", 2_000)) }
            assertEquals(text, file.readText())
        }
    }

    @Test
    fun aRejectedCommitKeepsTheWholePreviousDocumentAndRefusesFurtherWrites() {
        val file = controlsFile()
        val session = Session("session", 1_000)
        val first = TrainingSet("first", "bench", weightKg = 60.0, reps = 8, completedAtMs = 2_000)
        val initial = WorkoutControls(file, deviceOwner = "A")
        initial.hold(session)
        initial.choose("bench")
        initial.store(first, session.id)
        val bytes = file.readText()
        val broken = WorkoutControls(file, deviceOwner = "A", write = { _, _ -> throw IOException("disk full") })
        assertThrows(IOException::class.java) {
            broken.store(first.copy(id = "second", completedAtMs = 3_000), session.id)
        }
        assertEquals(bytes, file.readText())
        assertEquals(listOf(first), broken.sets)
        assertThrows(IllegalStateException::class.java) { broken.drop(first.id) }
        val reopened = WorkoutControls(file, deviceOwner = "A")
        assertEquals(listOf(session, listOf("bench"), "bench", listOf(first)),
            listOf(reopened.session, reopened.order, reopened.chosenMovement, reopened.sets))
    }

    @Test
    fun anUncertainCommitRequiresReopenAndRetainsTheSinglePersistedSet() {
        val file = controlsFile()
        val session = Session("session", 1_000)
        WorkoutControls(file).hold(session)
        val set = TrainingSet("accepted", "bench", weightKg = 60.0, reps = 8, completedAtMs = 2_000)
        val broken = WorkoutControls(file, write = { destination, text ->
            AtomicDocument.write(destination, text)
            throw IOException("reply lost after replacement")
        })
        assertThrows(IOException::class.java) { broken.store(set, session.id) }
        assertEquals(emptyList<TrainingSet>(), broken.sets)
        assertThrows(IllegalStateException::class.java) { broken.store(set.copy(id = "replacement"), session.id) }
        val reopened = WorkoutControls(file)
        assertEquals(WorkoutControls.Entry(set, session.id), reopened.entry(set.id))
        assertEquals(session, reopened.session)
        assertEquals(listOf(set), reopened.sets)
    }

    @Test
    fun acceptedOperationOrderWinsAfterBackwardWallChangeAndEqualElapsedTicks() {
        val file = controlsFile()
        val controls = WorkoutControls(file)
        var id = 0
        controls.hold(Session("session", 100_000))
        controls.choose("bench")
        val first = WorkoutMoment(101_000, 1_000, "boot")
        controls.prepare(null, first, true) { "set_${++id}" }
        val offer = requireNotNull(controls.workout.offer)
        controls.accept(LogSetCommand(offer.key, offer.id), first, null) { "set_${++id}" }
        val second = WorkoutMoment(51_000, 1_000, "boot")
        val next = requireNotNull(controls.workout.offer)
        controls.accept(LogSetCommand(next.key, next.id), second, null) { "set_${++id}" }
        val reopened = WorkoutControls(file)
        reopened.prepare(null, second.copy(elapsedMs = 2_000), true) { "set_${++id}" }
        assertEquals(WorkoutEvent("set_2", second), reopened.latestSet(second))
        assertEquals(mapOf("set_1" to 101_000L, "set_2" to 51_000L), reopened.sets.associate { it.id to it.completedAtMs })
    }

    @Test
    fun droppingTheNewestSetRestoresThePriorEvent() {
        val file = controlsFile()
        val controls = WorkoutControls(file)
        var id = 0
        val origin = WorkoutMoment(101_000, 1_000, "boot")
        controls.hold(Session("session", 100_000))
        controls.choose("bench")
        controls.prepare(null, origin, true) { "set_${++id}" }
        val first = requireNotNull(controls.workout.offer)
        controls.accept(LogSetCommand(first.key, first.id), origin, null) { "set_${++id}" }
        val second = requireNotNull(controls.workout.offer)
        controls.accept(LogSetCommand(second.key, second.id), origin.copy(wallMs = 111_000, elapsedMs = 11_000), null) { "set_${++id}" }
        controls.drop(second.id)
        controls.prepare(null, origin.copy(wallMs = 116_000, elapsedMs = 16_000), true) { "set_${++id}" }
        assertEquals(WorkoutEvent(first.id, origin), WorkoutControls(file).latestSet(origin))
        assertEquals(listOf(first.id), controls.sets.map { it.id })
    }

    @Test
    fun invalidCommittedNumbersNeverProduceAnOfferOrAcceptAnOldOne() {
        val controls = WorkoutControls(controlsFile())
        val now = WorkoutMoment(2_000, 1_000, "boot")
        var id = 0
        controls.hold(Session("session", 1_000))
        controls.choose("bench")
        controls.prepare(null, now, true) { "set_${++id}" }
        val old = requireNotNull(controls.workout.offer)
        for ((weight, reps) in listOf(20.0 to 100, 500.1 to 8, -500.1 to 8, 20.0 to 0)) {
            controls.control(controls.workout.edit(weight, reps))
            controls.prepare(null, now, true) { "set_${++id}" }
            assertNull(controls.workout.offer)
            assertEquals(weight, controls.workout.rack?.weightKg)
            assertEquals(reps, controls.workout.rack?.reps)
            assertEquals(LogSetAcceptance.Stale, controls.accept(LogSetCommand(old.key, old.id), now, null) { error("stale never mints") })
        }
        assertEquals(emptyList<TrainingSet>(), controls.sets)
    }
}
