package works.windmill.gym.store

import java.io.File
import works.windmill.gym.domain.ClaimBatch
import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TrainingSet

class SetQueueTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun queueFile(): File = File(tmp.root, "gym-${System.nanoTime()}.json")

    private fun aSet(id: String, exerciseId: String = "bench-press", at: Long) = TrainingSet(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, completedAtMs = at)

    @Test
    fun theSelectedMovementAndSetsSurviveCanonicalRepliesAndReopening() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "live", startedAtMs = 1_000))
        queue.choose("bench-press")
        queue.store(aSet("local", at = 2_000), "live", needsPush = true)
        queue.choose("overhead-press")
        queue.remint("local", "retry")
        val canonical = aSet("stored", at = 3_000).copy(setNumber = 7)
        queue.appended(canonical, queue.sending(queue.pending.single()))
        queue.store(canonical.copy(completedAtMs = 4_000), "live", needsPush = false)
        queue.flush()
        val reopened = SetQueue(file)
        assertEquals(listOf("overhead-press", listOf(canonical.copy(completedAtMs = 4_000))),
            listOf(reopened.chosenMovement, reopened.sets))
        reopened.remapExercise("overhead-press", "canonical-press")
        assertEquals("canonical-press", reopened.chosenMovement)
        reopened.adopt("another")
        assertNull(reopened.chosenMovement)
    }

    @Test
    fun testTheLiveSessionAndItsOwedSetsSurviveBeingReadBackFromDisk() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.flush()

        val reopened = SetQueue(file)
        assertEquals("ses_1", reopened.session?.id)
        assertEquals(listOf("set_a"), reopened.sets.map { it.id })
        assertEquals("an unsent set is still owed after a relaunch", 1, reopened.pending.size)
    }

    @Test
    fun testAnUnreadableFileOpensEmptyRatherThanCrashing() {
        val file = queueFile()
        file.writeText("not json at all")

        val queue = SetQueue(file)
        assertNull(queue.session)
        assertTrue(queue.pending.isEmpty())
    }

    // The previous app version's bytes: a live session on a plan in the scalar `sets · reps ·
    // weightKg` shape and one owed set. Opening rewrites the plan on the way in; the set is still
    // owed, the session still unclaimed, and the next flush writes this version's shape.
    @Test
    fun testAQueueWrittenByThePreviousVersionIsRewrittenOnOpenAndNothingIsLost() {
        val file = queueFile()
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
        fun SetQueue.assertWhole() {
            assertEquals("ses_9", session?.id)
            assertEquals(plan, session?.plan)
            assertTrue(sessionIsUnclaimed)
            assertEquals(listOf("bench-press"), order)
            assertEquals(listOf("set_z"), pending.map { it.set.id })
        }

        val queue = SetQueue(file)
        queue.assertWhole()
        assertTrue("not written back until the next flush", file.readText().contains("\"sets\":3"))

        queue.flush()
        val written = file.readText()
        assertFalse(written.contains("\"sets\":3") || written.contains("\"sets\":2"))
        assertTrue(written.contains("\"sets\":[{\"reps\":8,\"weightKg\":60.0}"))
        assertTrue(written.contains("{\"exerciseId\":\"face-pull\"}"))
        SetQueue(file).assertWhole()
    }

    // A row this build cannot read costs that row and never the queue around it: an owed set beside
    // an unreadable one is still owed, and an unreadable live session leaves its owed sets in place.
    @Test
    fun testOneUnreadableRowCostsThatRowAndNeverTheQueue() {
        val file = queueFile()
        file.writeText(
            """{"queues":{"anon":{"session":{"id":"ses_1","startedAt":1000},"entries":{""" +
            """"set_a":{"set":{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"completedAt":1100},"sessionId":"ses_1","needsPush":true,"remints":0},""" +
            """"set_b":{"set":{"id":"set_b","exerciseId":"bench-press","weightKg":82.5,"reps":"eight","completedAt":1200},"sessionId":"ses_1","needsPush":true,"remints":0}},""" +
            """"order":["bench-press"]},""" +
            """"u.alice":{"session":{"id":"ses_2","startedAt":"noon"},"entries":{""" +
            """"set_c":{"set":{"id":"set_c","exerciseId":"deadlift","weightKg":140.0,"reps":3,"completedAt":2100},"sessionId":"ses_2","needsPush":true,"remints":0}}}}}"""
        )

        val anonymous = SetQueue(file)
        assertEquals("ses_1", anonymous.session?.id)
        assertEquals(listOf("set_a"), anonymous.pending.map { it.set.id })
        assertEquals(listOf("bench-press"), anonymous.order)

        val alice = SetQueue(file, deviceOwner = "alice")
        assertNull(alice.session)
        assertEquals(listOf("set_c"), alice.pending.map { it.set.id })
    }

    @Test
    fun testWhatIsOwedComesBackInTheOrderItWasPerformed() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_c", at = 3_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_a", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_b", at = 2_000), sessionId = "ses_1", needsPush = true)

        assertEquals("the server numbers sets max+1 per movement, so the queue sends in that order",
            listOf("set_a", "set_b", "set_c"), queue.pending.map { it.set.id })
    }

    @Test
    fun testABlockedLaneIsSteppedOverAndTheNextMovementIsOffered() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", "bench-press", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_b", "back-squat", at = 2_000), sessionId = "ses_1", needsPush = true)

        val first = queue.nextOwed(skipping = emptySet())
        assertEquals("set_a", first?.set?.id)
        assertEquals("set_b", queue.nextOwed(skipping = setOf(first!!.lane))?.set?.id)
    }

    @Test
    fun testAServerRowArrivingForAnOwedSetSettlesIt() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_a", at = 1_000).copy(setNumber = 4), sessionId = "ses_1", needsPush = false)

        assertTrue(queue.pending.isEmpty())
        assertEquals(listOf(4), queue.sets("ses_1").map { it.setNumber })
    }

    @Test
    fun testAnAnsweredAppendReplacesTheDrawnSetWithTheStoredRow() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.appended(aSet("set_a", at = 1_100).copy(setNumber = 1), queue.sending(queue.pending.single()))

        assertTrue(queue.pending.isEmpty())
        assertEquals("the log numbered it, so it is the log's now",
            listOf(1), queue.sets.map { it.setNumber })

        queue.store(aSet("set_b", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.appended(aSet("set_c", at = 1_200).copy(setNumber = 2), queue.sending(queue.pending.single()))
        assertEquals(emptyList<SetQueue.Entry>(), queue.pending)
        assertEquals(listOf("set_a", "set_c"), queue.sets.map { it.id })
    }

    // A change to a set whose append went out is filed behind that append: the mark carries through
    // the fix and the delete, the file keeps both, and the next step on the wire is the append again.
    @Test
    fun testAChangeToAnAttemptedSetIsFiledBehindItsAppendAndSurvivesReopening() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_b", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.sending(queue.pending.first())
        queue.sending(queue.pending.last())
        assertEquals(listOf(false, false), listOf(queue.isUnsent("set_a"), queue.isUnsent("set_b")))

        queue.fix(aSet("set_a", at = 1_100).copy(reps = 4))
        queue.delete("set_b")

        val reopened = SetQueue(file)
        assertEquals(listOf(
            SetQueue.Entry(aSet("set_a", at = 1_100).copy(reps = 4), "ses_1", needsPush = true, remints = 0,
                loggedAtMs = 1_100, attempted = true, write = Owed.Fix),
            SetQueue.Entry(aSet("set_b", at = 1_200), "ses_1", needsPush = true, remints = 0,
                loggedAtMs = 1_200, attempted = true, write = Owed.Delete),
        ), reopened.pending)
        assertEquals(listOf(Owed.Append, Owed.Append), reopened.pending.map { it.step })
        assertEquals("the deleted row leaves the drawn sets at once",
            listOf(aSet("set_a", at = 1_100).copy(reps = 4)), reopened.sets)
    }

    // A reply settles an entry only while it reads as it did when sent: an append answered after a
    // fix was filed leaves the fix owed, aimed at the row the log now holds, and a fix answered after
    // a newer fix leaves the newer one owed.
    @Test
    fun testAReplyNeverOverwritesAnEntryChangedAfterItWasSent() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        val append = queue.sending(queue.pending.single())
        queue.fix(aSet("set_a", at = 1_100).copy(reps = 4))

        assertEquals(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 4),
            queue.appended(aSet("set_a", at = 1_100).copy(setNumber = 1), append))
        assertEquals(listOf(Triple(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 4), false, Owed.Fix)),
            queue.pending.map { Triple(it.set, it.attempted, it.write) })

        val fix = queue.sending(queue.pending.single())
        assertEquals(Owed.Fix, fix.step)
        queue.fix(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 3))
        assertFalse(queue.fixed(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 4), fix))
        assertFalse(queue.letGo(fix))
        queue.store(aSet("set_a", at = 1_100).copy(setNumber = 1), sessionId = "ses_1", needsPush = false)
        assertEquals("a row read off the log does not settle a correction still owed",
            listOf(Triple(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 3), false, Owed.Fix)),
            queue.pending.map { Triple(it.set, it.attempted, it.write) })

        val newer = queue.sending(queue.pending.single())
        assertTrue(queue.fixed(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 3), newer))
        assertEquals(emptyList<SetQueue.Entry>(), queue.pending)
        assertEquals(listOf(aSet("set_a", at = 1_100).copy(setNumber = 1, reps = 3)), queue.sets)
    }

    // A remint is the append the set never became: a fresh, unmarked key carrying the corrected body.
    // A set taken back needs no new key and leaves quietly.
    @Test
    fun testARemintGivesAFreshUnmarkedAppendAndLetsATakenBackSetGo() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.store(aSet("set_b", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.sending(queue.pending.first())
        queue.sending(queue.pending.last())
        queue.fix(aSet("set_a", at = 1_100).copy(reps = 4))
        queue.delete("set_b")

        queue.remint("set_a", fresh = "set_c")
        queue.remint("set_b", fresh = "set_d")

        assertEquals(listOf(SetQueue.Entry(aSet("set_c", at = 1_100).copy(reps = 4), "ses_1", needsPush = true,
            remints = 1, loggedAtMs = 1_100)), queue.pending)
        assertTrue(queue.isUnsent("set_c"))
    }

    @Test
    fun testARemintMovesTheSetToTheFreshIdAndSpendsOneOfTheRepairs() {
        val queue = SetQueue(queueFile())
        queue.store(aSet("set_a", at = 1_000), sessionId = "ses_1", needsPush = true)
        queue.remint("set_a", fresh = "set_b")

        assertEquals(listOf("set_b"), queue.pending.map { it.set.id })
        assertEquals(listOf(1), queue.pending.map { it.remints })
        assertEquals("a remint moves the key and nothing else",
            listOf(82.5), queue.pending.map { it.set.weightKg })
    }

    @Test
    fun testClosingASessionLetsGoOfTheDeliveredRowsAndKeepsTheOwedOne() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_landed", at = 1_100), sessionId = "ses_1", needsPush = false)
        queue.store(aSet("set_owed", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.close("ses_1")

        assertNull(queue.session)
        assertEquals(listOf("set_owed"), queue.pending.map { it.set.id })
        assertEquals(listOf("set_owed"), queue.sets("ses_1").map { it.id })
    }

    @Test
    fun testForgettingADiscardedSessionTakesTheOwedSetsWithIt() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.store(aSet("set_owed", at = 1_200), sessionId = "ses_1", needsPush = true)
        queue.forget("ses_1")

        assertNull(queue.session)
        assertTrue(queue.pending.isEmpty())
    }

    @Test
    fun testRemappingTheSessionMovesTheWorkoutWholeToTheFreshId() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_spent", startedAtMs = 1_000))
        queue.store(aSet("set_a", at = 1_100), sessionId = "ses_spent", needsPush = true)
        queue.store(aSet("set_b", at = 1_200), sessionId = "ses_other", needsPush = true)
        queue.remapSession("ses_spent", fresh = "ses_fresh")

        assertEquals("ses_fresh", queue.session?.id)
        assertEquals(listOf("set_a"), queue.owed("ses_fresh").map { it.set.id })
        assertEquals("another session's sets are not touched",
            listOf("set_b"), queue.owed("ses_other").map { it.set.id })
        assertTrue(queue.owed("ses_spent").isEmpty())
    }

    @Test
    fun testRemappingAMovementReachesTheSetsTheOrderAndThePlan() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000,
            plan = works.windmill.gym.domain.PlanSnapshot(routine = "Push",
                entries = listOf(works.windmill.gym.domain.PlanEntry(exerciseId = "ex_spent", sets = List(3) { works.windmill.gym.domain.SetTarget() })))))
        queue.append("ex_spent")
        queue.store(aSet("set_a", "ex_spent", at = 1_100), sessionId = "ses_1", needsPush = true)
        queue.remapExercise("ex_spent", fresh = "ex_fresh")

        assertEquals(listOf("ex_fresh"), queue.order)
        assertEquals(listOf("ex_fresh"), queue.pending.map { it.set.exerciseId })
        assertEquals(listOf("ex_fresh"), queue.session?.plan?.entries?.map { it.exerciseId })
    }

    @Test
    fun testTheMovementOrderBelongsToItsSessionAndGoesWithIt() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.append("bench-press")
        queue.append("bench-press")
        queue.append("back-squat")
        assertEquals(listOf("bench-press", "back-squat"), queue.order)

        queue.flush()
        assertEquals(listOf("bench-press", "back-squat"), SetQueue(file).order)

        queue.hold(Session(id = "ses_2", startedAtMs = 2_000))
        assertEquals("a different session is a different workout",
            emptyList<String>(), queue.order)
    }

    @Test
    fun testTheUnclaimedBitIsPerSessionOnDiskAndAbsentReadsAsUnclaimed() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.hold(Session(id = "ses_1", startedAtMs = 1_000))
        queue.flush()
        assertFalse("answered by the server", queue.sessionIsUnclaimed)
        assertFalse(SetQueue(file).sessionIsUnclaimed)

        queue.hold(Session(id = "ses_mine", startedAtMs = 2_000), unclaimed = true)
        queue.flush()
        assertTrue("composed on the device", SetQueue(file).sessionIsUnclaimed)

        queue.claimed("ses_other")
        assertTrue("a claim for some other id changes nothing", queue.sessionIsUnclaimed)
        queue.claimed("ses_mine")
        queue.flush()
        assertFalse("the claim's start landed it", SetQueue(file).sessionIsUnclaimed)

        queue.forget("ses_mine")
        assertFalse("no session, nothing unclaimed", queue.sessionIsUnclaimed)

        file.writeText("""{"session":{"id":"ses_old","startedAt":1000},"entries":{}}""")
        val fromBefore = SetQueue(file, deviceOwner = null)
        assertNull("a file from before the seats, on a phone holding no session, belongs to " +
            "nobody until a human says so", fromBefore.session)
        assertEquals("ses_old", fromBefore.unattributedSession?.id)
        val batch = ClaimBatch("legacy-workout-approval", fromBefore.claimItems())
        fromBefore.adopt("alice")
        assertNull("selection does not claim it", fromBefore.session)
        fromBefore.preflight(batch, "alice")
        fromBefore.complete(batch, "alice")
        assertTrue("and once released it reads as unclaimed — that build's file says nothing " +
            "about whether the log ever answered", fromBefore.sessionIsUnclaimed)
    }

    @Test
    fun testALiveSessionIsNeverDrawnForTheNextSeatAndItsOwedSetsAreNotLost() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.adopt("alice")
        queue.hold(Session(id = "ses_alice", startedAtMs = 1_000), unclaimed = true)
        queue.store(aSet("set_a", at = 1_100), "ses_alice", needsPush = true)
        queue.flush()

        queue.adopt(null)
        assertNull("signing out draws no workout", queue.session)
        assertTrue(queue.pending.isEmpty())

        queue.adopt("bob")
        assertNull("and the next account is drawn none of it", queue.session)
        assertEquals("nothing of A's is owed under B's bearer", emptyList<String>(),
            queue.pending.map { it.set.id })

        val relaunched = SetQueue(file)
        relaunched.adopt("alice")
        assertEquals("ses_alice", relaunched.session?.id)
        assertEquals("A's owed set was parked, never dropped",
            listOf("set_a"), relaunched.pending.map { it.set.id })
    }

    @Test
    fun testExplicitConsentRequiresAFreeQueueAndMovesTheWholeWorkout() {
        val file = queueFile()
        val queue = SetQueue(file)
        queue.adopt("alice")
        queue.hold(Session(id = "ses_alice", startedAtMs = 1_000), unclaimed = true)
        queue.flush()

        queue.adopt(null)
        queue.hold(Session(id = "ses_anon", startedAtMs = 2_000), unclaimed = true)
        queue.store(aSet("set_anon", at = 2_100), "ses_anon", needsPush = true)
        queue.flush()

        val batch = ClaimBatch("workout-approval", queue.claimItems())
        assertThrows(IllegalStateException::class.java) { queue.preflight(batch, "alice") }
        queue.adopt("alice")
        assertEquals("A's own live workout holds the slot", "ses_alice", queue.session?.id)
        queue.adopt(null)
        assertEquals("and the anonymous one is still here, whole",
            "ses_anon", queue.session?.id)
        assertEquals(listOf("set_anon"), queue.pending.map { it.set.id })

        queue.adopt("bob")
        assertNull("a free account still needs explicit consent", queue.session)
        queue.complete(batch, "bob")
        assertEquals("a free seat claims it", "ses_anon", queue.session?.id)
        assertEquals(listOf("set_anon"), queue.pending.map { it.set.id })
    }

    @Test
    fun testALiveWorkoutFromBeforeTheSeatsBelongsToTheSeatTheDeviceWasHolding() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_old","startedAt":1000},"entries":{}}""")

        val queue = SetQueue(file, deviceOwner = "alice")
        assertEquals("ses_old", queue.session?.id)
        assertNull("no door is needed and none is offered", queue.unattributedSession)

        queue.adopt(null)
        queue.adopt("alice")
        assertEquals("through the app's own null-first connect ordering",
            "ses_old", queue.session?.id)

        queue.adopt("bob")
        assertNull("and it went to A alone", queue.session)
        queue.adopt("alice")
        assertEquals("ses_old", queue.session?.id)
    }

    @Test
    fun testAQueueFromBeforeTheSeatsOnASignedOutDeviceStaysQuarantined() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_old","startedAt":1000},"entries":{}}""")

        val queue = SetQueue(file, deviceOwner = null)
        queue.adopt(null)
        queue.adopt("alice")
        assertNull("not even the first account to sign in afterwards", queue.session)
        assertEquals("ses_old", queue.unattributedSession?.id)
        assertNull("and the decision is on DISK — a relaunch that does hold a session must still " +
            "find a quarantine", SetQueue(file, deviceOwner = "bob").session)
        val batch = ClaimBatch("quarantine-approval", queue.claimItems())
        queue.preflight(batch, "alice")
        queue.complete(batch, "alice")
        assertEquals("ses_old", queue.session?.id)
    }

    @Test
    fun testASignedOutMigrationIsWrittenDownAtOnce() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")

        SetQueue(file, deviceOwner = null)

        val later = SetQueue(file, deviceOwner = "bob")
        assertNull("B WAS HANDED A STRANGER'S WORKOUT", later.session)
        assertEquals("ses_before", later.unattributedSession?.id)
    }

    @Test
    fun testAQuarantineIsNotReleasedOntoASeatThatStillOwesSets() {
        val file = queueFile()
        file.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")

        val queue = SetQueue(file, deviceOwner = null)
        queue.adopt("alice")
        queue.store(aSet("set_a", at = 1_100), "ses_alice", needsPush = true)

        assertNull("no workout stands over them", queue.session)
        assertEquals(1, queue.pending.size)
        val batch = ClaimBatch("occupied-queue-approval", queue.claimItems())
        val refusal = assertThrows(IllegalStateException::class.java) { queue.preflight(batch, "alice") }
        assertEquals("Finish the account’s current workout before adding this training.", refusal.message)
        assertTrue("and nothing was taken out of quarantine", queue.hasUnattributed)
    }

    @Test
    fun testRepeatedSeatSelectionDoesNotClaimTheAnonymousWorkout() {
        val queue = SetQueue(queueFile())
        queue.hold(Session(id = "ses_anon", startedAtMs = 1_000), unclaimed = true)
        queue.flush()

        queue.adopt("alice")
        assertNull(queue.session)
        queue.adopt(null)
        queue.adopt("alice")
        assertNull("returning to the account still does not claim a workout", queue.session)
        queue.adopt(null)
        assertEquals("ses_anon", queue.session?.id)
    }
}
