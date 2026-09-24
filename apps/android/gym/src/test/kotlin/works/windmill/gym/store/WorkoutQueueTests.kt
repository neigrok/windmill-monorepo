package works.windmill.gym.store

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.RestAlertCommand
import works.windmill.gym.domain.WorkoutEvent
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutMoment
import works.windmill.platform.storage.AtomicDocument

class WorkoutQueueTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun oneOfferCommitsItsSetHoldRestAndNextRackTogetherAndCannotReturnAfterUndo() {
        val file = File(tmp.root, "sets.json")
        var writes = 0
        var nextId = 0
        val queue = SetQueue(file, write = { target, text -> writes++; AtomicDocument.write(target, text) })
        val live = Session("session", 100_000)
        queue.hold(live)
        queue.choose("bench")
        val now = WorkoutMoment(101_000, 1_000, "boot")
        val prefs = GymPreferences(restSeconds = 90)
        val first = queue.prepare(null, prefs, now, true) { "set_${++nextId}" }
        val command = LogSetCommand(WorkoutKey("anon", live.id), requireNotNull(first.offer).id)
        val before = writes
        assertEquals(LogSetAcceptance.Accepted("set_1"), queue.accept(command, now, null, prefs) { "set_${++nextId}" })
        assertEquals(before + 1, writes)
        val set = TrainingSet("set_1", "bench", weightKg = 20.0, reps = 5, completedAtMs = now.wallMs)
        val expected = SetQueue.Entry(set, live.id, true, 0, 101_000, WorkoutEvent(set.id, now), eventOrder = first.revision + 1)
        assertEquals(listOf(expected), queue.pending)
        assertEquals(setOf("set_1"), queue.workout.consumed)
        assertEquals(listOf("set_2", 2, "set_1", now), listOf(queue.workout.offer?.id,
            queue.workout.offer?.workingOrdinal, queue.workout.rest?.id, queue.workout.rest?.origin))
        val reopened = SetQueue(file)
        assertEquals(queue.workout, reopened.workout)
        assertEquals(queue.pending, reopened.pending)
        assertEquals(LogSetAcceptance.Stale, reopened.accept(command, now, null, prefs) { error("no new ID") })
        reopened.drop("set_1")
        reopened.prepare(null, prefs, now, true) { "set_${++nextId}" }
        assertEquals(emptyList<TrainingSet>(), reopened.sets)
        assertEquals(setOf("set_1"), reopened.workout.consumed)
        assertEquals(LogSetAcceptance.Stale, SetQueue(file).accept(command, now, null, prefs) { error("no new ID") })
    }

    @Test
    fun sameBootClockChangePreservesRestButNewBootRetiresTheOldOffer() {
        val file = File(tmp.root, "sets.json")
        var id = 0
        val queue = SetQueue(file)
        queue.hold(Session("session", 100_000))
        queue.choose("bench")
        val origin = WorkoutMoment(101_000, 1_000, "boot1")
        val prefs = GymPreferences(restSeconds = 90)
        queue.prepare(null, prefs, origin, true) { "set_${++id}" }
        queue.accept(LogSetCommand(WorkoutKey("anon", "session"), requireNotNull(queue.workout.offer).id),
            origin, null, prefs) { "set_${++id}" }
        val afterClockEdit = WorkoutMoment(901_000, 4_000, "boot1")
        val reopened = SetQueue(file)
        reopened.prepare(null, prefs, afterClockEdit, true) { "set_${++id}" }
        assertEquals(origin, reopened.workout.rest?.origin)
        val oldOffer = requireNotNull(reopened.workout.offer)
        val afterBoot = WorkoutMoment(902_000, 100, "boot2")
        reopened.prepare(null, prefs, afterBoot, true) { "set_${++id}" }
        assertEquals(listOf("set_1"), reopened.sets.map { it.id })
        assertEquals(LogSetAcceptance.Stale, reopened.accept(LogSetCommand(oldOffer.key, oldOffer.id), afterBoot,
            null, prefs) { error("no new ID") })
    }

    @Test
    fun hiddenOrWithdrawnAlertAuthorityCannotReturnAndTheClaimSurvivesReopening() {
        val file = File(tmp.root, "sets.json")
        var id = 0
        val queue = SetQueue(file)
        queue.hold(Session("session", 100_000))
        queue.choose("bench")
        val key = WorkoutKey("anon", "session")
        val origin = WorkoutMoment(101_000, 1_000, "boot")
        val prefs = GymPreferences(restSeconds = 30)
        queue.prepare(null, prefs, origin, true) { "set_${++id}" }
        queue.accept(LogSetCommand(key, requireNotNull(queue.workout.offer).id), origin, null, prefs) { "set_${++id}" }
        queue.control(queue.workout.access(true))
        val first = requireNotNull(queue.workout.rest)
        val stale = RestAlertCommand(key, first.id, first.alertRevision)
        queue.control(queue.workout.visibility(true))
        queue.control(queue.workout.visibility(false))
        queue.control(queue.workout.access(false))
        queue.control(queue.workout.access(true))
        val due = WorkoutMoment(131_000, 31_000, "boot")
        assertNull(queue.workout.claim(stale, key, due))
        val current = requireNotNull(queue.workout.rest)
        val command = RestAlertCommand(key, current.id, current.alertRevision)
        queue.control(requireNotNull(queue.workout.claim(command, key, due)))
        val reopened = SetQueue(file)
        assertEquals(queue.workout, reopened.workout)
        assertNull(reopened.workout.claim(command, key, due))
        assertEquals(setOf("set_1"), reopened.workout.attemptedRest)
    }

    @Test
    fun malformedWorkoutAuthorityCannotBeOverwrittenOrUsedAsAnEmptyQueue() {
        val file = File(tmp.root, "sets.json")
        val raw = """{"queues":{"anon":{"session":{"id":"session","startedAt":100000},"workout":{"version":2}}}}"""
        file.writeText(raw)
        val queue = SetQueue(file)
        assertFalse(queue.writable)
        assertThrows(IllegalStateException::class.java) { queue.hold(Session("new", 200_000)) }
        assertEquals(raw, file.readText())
    }

    @Test
    fun aRejectedCommitKeepsTheWholePreviousQueueAndRefusesFurtherWrites() {
        val file = File(tmp.root, "sets.json")
        val session = Session("session", 1_000)
        val first = TrainingSet("first", "bench", weightKg = 60.0, reps = 8, completedAtMs = 2_000)
        val initial = SetQueue(file, deviceOwner = "A")
        initial.hold(session)
        initial.choose("bench")
        initial.store(first, session.id, needsPush = true)
        val bytes = file.readText()
        val broken = SetQueue(file, deviceOwner = "A", write = { _, _ -> throw IOException("disk full") })
        assertThrows(IOException::class.java) {
            broken.store(first.copy(id = "second", completedAtMs = 3_000), session.id, needsPush = true)
        }
        assertEquals(bytes, file.readText())
        assertEquals(listOf(first), broken.sets)
        assertThrows(IllegalStateException::class.java) { broken.drop(first.id) }
        val reopened = SetQueue(file, deviceOwner = "A")
        assertEquals(listOf(session, listOf("bench"), "bench", initial.pending),
            listOf(reopened.session, reopened.order, reopened.chosenMovement, reopened.pending))
    }

    @Test
    fun anUncertainCommitRequiresReopenAndRetainsTheSinglePersistedSetIdentity() {
        val file = File(tmp.root, "sets.json")
        val session = Session("session", 1_000)
        SetQueue(file).hold(session)
        val set = TrainingSet("accepted", "bench", weightKg = 60.0, reps = 8, completedAtMs = 2_000)
        val broken = SetQueue(file, write = { destination, text ->
            AtomicDocument.write(destination, text)
            throw IOException("reply lost after replacement")
        })
        assertThrows(IOException::class.java) {
            broken.store(set, session.id, needsPush = true)
        }
        assertEquals(emptyList<TrainingSet>(), broken.sets)
        assertThrows(IllegalStateException::class.java) {
            broken.store(set.copy(id = "replacement"), session.id, needsPush = true)
        }
        val reopened = SetQueue(file)
        assertEquals(listOf(SetQueue.Entry(set, session.id, true, 0, 2_000)), reopened.pending)
        assertEquals(session, reopened.session)
        assertEquals(listOf(set), reopened.sets)
    }
    @Test
    fun acceptedOperationOrderWinsAfterBackwardWallChangeAndEqualElapsedTicks() {
        val file = File(tmp.root, "clock.json")
        val queue = SetQueue(file)
        val prefs = GymPreferences(restSeconds = 90)
        var id = 0
        queue.hold(Session("session", 100_000))
        queue.choose("bench")
        val first = WorkoutMoment(101_000, 1_000, "boot")
        queue.prepare(null, prefs, first, true) { "set_${++id}" }
        val offer = requireNotNull(queue.workout.offer)
        queue.accept(LogSetCommand(offer.key, offer.id), first, null, prefs) { "set_${++id}" }
        val second = WorkoutMoment(51_000, 1_000, "boot")
        val next = requireNotNull(queue.workout.offer)
        queue.accept(LogSetCommand(next.key, next.id), second, null, prefs) { "set_${++id}" }
        val reopened = SetQueue(file)
        reopened.prepare(null, prefs, second.copy(elapsedMs = 2_000), true) { "set_${++id}" }
        assertEquals(listOf("set_2", second, setOf("set_1")), listOf(reopened.workout.rest?.id,
            reopened.workout.rest?.origin, reopened.workout.attemptedRest))
        assertEquals(mapOf("set_1" to 101_000L, "set_2" to 51_000L), reopened.sets.associate { it.id to it.completedAtMs })
    }

    @Test
    fun droppingTheNewestSetRestoresPriorElapsedWithoutMakingItsOldAlertEligibleAgain() {
        val file = File(tmp.root, "undo.json")
        val queue = SetQueue(file)
        val prefs = GymPreferences(restSeconds = 90)
        var id = 0
        val origin = WorkoutMoment(101_000, 1_000, "boot")
        queue.hold(Session("session", 100_000))
        queue.choose("bench")
        queue.prepare(null, prefs, origin, true) { "set_${++id}" }
        val first = requireNotNull(queue.workout.offer)
        queue.accept(LogSetCommand(first.key, first.id), origin, null, prefs) { "set_${++id}" }
        val second = requireNotNull(queue.workout.offer)
        queue.accept(LogSetCommand(second.key, second.id), origin.copy(wallMs = 111_000, elapsedMs = 11_000), null, prefs) { "set_${++id}" }
        queue.drop(second.id)
        queue.prepare(null, prefs, origin.copy(wallMs = 116_000, elapsedMs = 16_000), true) { "set_${++id}" }
        val rest = requireNotNull(queue.workout.rest)
        assertEquals(listOf(first.id, origin, true), listOf(rest.id, rest.origin, rest.attempted))
        val allowed = queue.workout.access(true)
        queue.control(allowed)
        assertNull(SetQueue(file).workout.claim(RestAlertCommand(first.key, first.id,
            requireNotNull(allowed.rest).alertRevision), first.key, origin.copy(wallMs = 191_000, elapsedMs = 91_000)))
        assertEquals(listOf(first.id), queue.sets.map { it.id })
    }

    @Test
    fun invalidCommittedNumbersNeverProduceAnOfferOrAcceptAnOldOne() {
        val queue = SetQueue(File(tmp.root, "bounds.json"))
        val prefs = GymPreferences()
        val now = WorkoutMoment(2_000, 1_000, "boot")
        var id = 0
        queue.hold(Session("session", 1_000))
        queue.choose("bench")
        queue.prepare(null, prefs, now, true) { "set_${++id}" }
        val old = requireNotNull(queue.workout.offer)
        for ((weight, reps) in listOf(20.0 to 100, 500.1 to 8, -500.1 to 8, 20.0 to 0)) {
            queue.control(queue.workout.edit(weight, reps))
            queue.prepare(null, prefs, now, true) { "set_${++id}" }
            assertNull(queue.workout.offer)
            assertEquals(weight, queue.workout.rack?.weightKg)
            assertEquals(reps, queue.workout.rack?.reps)
            assertEquals(LogSetAcceptance.Stale, queue.accept(LogSetCommand(old.key, old.id), now, null, prefs) { error("stale never mints") })
        }
        assertEquals(emptyList<TrainingSet>(), queue.sets)
    }

    @Test
    fun malformedAuthorityContainersCannotBeOverwrittenAsAnEmptyQueue() {
        for (text in listOf("""{"queues":[]}""", """{"queues":{"u.A":true}}""", """{"claims":false}""")) {
            val file = File(tmp.root, "container.json").apply { writeText(text) }
            val queue = SetQueue(file, "A")
            assertFalse(queue.writable)
            assertThrows(IllegalStateException::class.java) { queue.hold(Session("new", 2_000)) }
            assertEquals(text, file.readText())
        }
    }

    @Test
    fun frozenClaimIgnoresRevokedAuthorityButPreservesLaterEditedRackIncludingLegacyBatches() {
        for (legacy in listOf(false, true)) for (editedAfter in listOf(false, true)) {
            val file = File(tmp.root, "claim-$legacy-$editedAfter")
            val queue = SetQueue(file)
            val live = Session("session", 100_000)
            val moment = WorkoutMoment(101_000, 1_000, "boot")
            val prefs = GymPreferences(restSeconds = 90)
            var id = 0
            queue.hold(live, unclaimed = true); queue.choose("bench")
            if (!legacy) queue.prepare(null, prefs, moment, true) { "set_${++id}" }
            val batch = ClaimBatch("batch", queue.claimItems())
            if (legacy) queue.prepare(null, prefs, moment, true) { "set_${++id}" }
            val old = requireNotNull(queue.workout.offer)
            if (editedAfter) queue.control(queue.workout.edit(92.0, 6))
            queue.adopt("B")
            queue.complete(batch, "B")
            queue.prepare(null, prefs, moment, true) { "set_${++id}" }
            assertEquals(live, queue.session)
            assertEquals(20.0, queue.workout.rack?.weightKg)
            assertEquals(5, queue.workout.rack?.reps)
            assertEquals(LogSetAcceptance.Stale, queue.accept(LogSetCommand(old.key, old.id), moment, null, prefs) { error("stale") })
            val source = SetQueue(file)
            if (editedAfter) {
                assertEquals(live, source.session)
                assertEquals(92.0, source.workout.rack?.weightKg)
                assertEquals(6, source.workout.rack?.reps)
            } else assertNull(source.session)
            val snapshot = file.readText()
            SetQueue(file, "B").complete(batch, "B")
            assertEquals(snapshot, file.readText())
            assertEquals(emptyList<TrainingSet>(), SetQueue(file, "B").sets)
        }
    }

}
