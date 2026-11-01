package works.windmill.gym.store

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.Blocker
import works.windmill.gym.presentation.GymPreferences
import works.windmill.gym.presentation.PlanSnapshot
import works.windmill.gym.domain.sync.Prefill
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.presentation.TrainingSet
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.ModelServer

class WorkoutSessionTests {
    @get:Rule
    val tmp = TemporaryFolder()

    // A second phone signed into the same account reads what the log holds, or writes as somebody
    // elsewhere would.
    private suspend fun <T> TestScope.anotherPhone(server: ModelServer, now: Long, account: String = "alice",
                                                   act: suspend (EngineRoomFixture) -> T): T =
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { phone ->
            phone.now = now
            phone.select(account); phone.pull(server); phone.store.refreshEngine()
            act(phone).also { runCurrent() }
        }

    // What this phone still owes the log, one line per intent: a command by name, a record by type and id.
    private fun owed(room: EngineRoomFixture): List<String> = room.outbox().map { entry ->
        val intent = entry.member("intent")
        intent["cmd"]?.member("name")?.str()
            ?: intent.member("d").arr().joinToString { "${it.member("t").str()} ${it.member("id").str()}" }
    }

    // A refusal reaches the notices off the engine's own thread.
    private suspend fun noticed(room: EngineRoomFixture) =
        withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }

    @Test
    fun testASetLoggedOfflineSurvivesARelaunchAndFlushesOnReconnect() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        val opened: Session
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            assertTrue(room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable))
            room.store.refreshEngine()

            assertEquals(SaveState.Blocked(Blocker.Offline), room.store.workout.saveState)
            assertEquals("offline · saved here", room.store.workout.saveState.line)
            assertEquals("the row is on screen — the device is holding it",
                listOf(82.5), room.store.workout.sets.map { it.weightKg })
            assertEquals(listOf("gym.start", "set ${room.store.workout.sets.single().id}"), owed(room))
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            relaunched.sync(server); relaunched.store.refreshEngine()

            assertEquals(listOf(82.5), anotherPhone(server, relaunched.now) { phone ->
                phone.training.session(opened.id)!!.sets.map { it.weightKg } })
            assertEquals("the log numbered it, so it is the log's now",
                listOf(1), relaunched.store.workout.sets.map { it.setNumber })
            assertTrue(relaunched.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testASetRefusedByAClosedSessionIsDroppedAndSaidOutLoud() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            room.startExternalWorkout()
            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                assertTrue(phone.store.workout.finish() is FinishOutcome.Closed)
                phone.sync(server)
            }

            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 60.0, reps = 10)
            val lost = room.store.workout.sets.single()
            room.sync(server); noticed(room); room.store.refreshEngine()

            assertTrue("a set that never landed is not drawn as though it had", room.store.workout.sets.isEmpty())
            assertEquals(listOf<RefusedWrite>(RefusedSet(lost.id, "bench-press", 60.0, 10, "That workout has finished.")),
                room.store.workout.refusals)
            assertEquals("That workout has finished.", room.store.workout.saveState.line)
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testFinishingSendsWhatIsOwedBeforeItClosesTheSession() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            room.store.workout.logSet(weightKg = 100.0, reps = 5)
            room.store.workout.logSet(weightKg = 100.0, reps = 5)
            val logged = room.store.workout.sets.map { it.id }

            val outcome = room.store.workout.finish()
            runCurrent()

            val closed = (outcome as? FinishOutcome.Closed)?.session
            assertNotNull("the session did not close: $outcome", closed)
            assertFalse(closed!!.isOpen)
            assertNull("the room has nothing running once the workout closed", room.store.workout.session)
            assertEquals("every set of this session is ahead of its finish in what the phone owes",
                listOf("gym.start") + logged.map { "set $it" } + "gym.finish", owed(room))

            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                val held = phone.training.session(opened.id)!!
                assertEquals(listOf(100.0, 100.0), held.sets.map { it.weightKg })
                assertFalse(held.session.isOpen)
            }
            runCurrent()
        }
    }

    @Test
    fun testAServerFailureKeepsTheSetOwedRatherThanRefusingIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.startExternalWorkout(); room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 90.0, reps = 5)

            assertTrue(room.training.reportDelivery(room.engine.activeReplica(),
                Reply.Failed(SyncResponse(500, Json.objectOf()))))
            room.store.refreshEngine()

            assertEquals(listOf("gym.start", "set ${room.store.workout.sets.single().id}"), owed(room))
            assertTrue("the server failing is not the set being refused", room.store.workout.refusals.isEmpty())
            assertEquals("and a log that answered 500 is not a missing signal — the note names the log",
                SaveState.Blocked(Blocker.LogFailed), room.store.workout.saveState)
            assertEquals("the log didn’t answer · saved here", room.store.workout.saveState.line)
            assertEquals(Blocker.LogFailed, room.store.workout.strandedBy)
            assertEquals("the row stays on screen — the device is holding it", 1, room.store.workout.sets.size)
            runCurrent()
        }
    }

    @Test
    fun testStartingWhileASessionIsOpenRefusesAndSurfacesTheOpenWorkout() = runTest {
        val server = EngineRoomFixture.server()
        val (live, logged) = anotherPhone(server, 1_800_000_000_000L) { phone ->
            // A finished workout first, so the open one never shares an id with the start this room mints.
            phone.workout()
            val pushA = (phone.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(phone.store.routines.catalog)) as GymResult.Ok).value
            val live = (phone.store.workout.start(pushA.id) as GymResult.Ok).value
            phone.store.workout.choose("bench-press"); phone.store.workout.logSet(82.5, 5)
            val start = phone.outbox().map { it.member("intent") }
                .last { it["cmd"]?.member("name")?.str() == "gym.start" }.member("cmd").member("args")
            assertEquals("every user-tapped start states the flag as an explicit false",
                Json.of(false), start.member("joinOpenSession"))
            phone.sync(server)
            live to phone.store.workout.sets.single().id
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            room.select("alice"); room.pull(server)

            val refused = room.store.workout.start(routineId = live.routineId!!)

            assertTrue("a start while a workout is open is a refusal, never a silent join: $refused",
                refused is GymResult.Failed)
            assertEquals("A workout is already open. Finish it first.",
                ((refused as GymResult.Failed).why as WriteFailure.Refused).said)
            assertTrue("the refused start wrote nothing", room.outbox().isEmpty())
            assertEquals("the refresh adopted the open workout, with its own snapshot", live.id, room.store.workout.session?.id)
            assertEquals("Push A", room.store.workout.session?.plan?.routine)
            assertEquals("and the sets already logged into it", listOf(logged), room.store.workout.sets.map { it.id })
            assertEquals("and stands where the last set went, not in the picker over a session of sets",
                "bench-press", room.store.workout.exerciseId)
            runCurrent()
        }
    }

    @Test
    fun testThePrefillTakesThePlanUntilTheLifterHasLiftedSomething() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.store.workout.start(pushA.id)
            room.store.workout.choose("bench-press")

            assertEquals(Prefill(weightKg = 82.5, reps = 5), room.store.workout.prefill)

            room.store.workout.logSet(weightKg = 85.0, reps = 4)
            assertEquals("the sticky carry-forward follows the thumb",
                Prefill(weightKg = 85.0, reps = 4), room.store.workout.prefill)
            runCurrent()
        }
    }

    @Test
    fun testSignedOutASessionRunsFinishesAndSurvivesARelaunch() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)
            assertEquals(SaveState.Idle, room.store.workout.saveState)

            val opened = room.startExternalWorkout()
            assertEquals("session01", opened.id)
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)

            assertEquals(listOf(82.5), room.store.workout.sets.map { it.weightKg })
            assertEquals("saved on this device", room.store.workout.saveState.line)

            room.now += 60_000
            val ended = (room.store.workout.finish() as FinishOutcome.Closed).session
            runCurrent()
            assertFalse(ended.isOpen)
            assertNull(room.store.workout.session)
            assertEquals(listOf("session01"), room.store.history.allSessions.map { it.id })
            assertEquals(listOf(1), room.store.history.allSessions.map { it.setCount })
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals(listOf("session01"), relaunched.store.history.allSessions.map { it.id })
            assertEquals("the phone's replica is the one owner of a finished signed-out session",
                listOf(82.5), relaunched.training.details().single().sets.map { it.weightKg })
            runCurrent()
        }
    }

    @Test
    fun testSignedOutLastTimeAndPrefillComeFromTheDeviceHistory() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)

            room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            assertEquals("no history is a first time", true, room.store.workout.lastTime?.isFirstTime)

            room.store.workout.logSet(weightKg = 60.0, reps = 10)
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            room.store.workout.finish()
            runCurrent()

            room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            assertEquals("every set carries: every set reaches the log",
                listOf(60.0, 82.5), room.store.workout.lastTime?.sets?.map { it.weightKg })
            assertEquals("the last set's weight, the first set's reps", Prefill(82.5, 10), room.store.workout.prefill)
            runCurrent()
        }
    }

    @Test
    fun testSignedInWithNoSignalAStartComposesOnTheDeviceAndTheEngineSyncsIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")
                .targeting("bench-press", List(3) { SetTarget(5, 100.0) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.store.refreshEngine()
            val opened = (room.store.workout.start(routine.id) as GymResult.Ok).value
            assertEquals("the plan froze off the routine this store holds", PlanSnapshot(routine), opened.plan)
            room.store.workout.choose("bench-press"); room.store.workout.logSet(100.0, 5)
            assertEquals(1, room.store.workout.strandedCount)
            val set = room.store.workout.sets.single()
            assertEquals(listOf(100.0), room.training.session(opened.id)!!.sets.map { it.weightKg })
            assertTrue("the offline command and set are durable", room.outbox().isNotEmpty())
            val server = EngineRoomFixture.server()
            room.sync(server); room.store.refreshEngine()
            assertEquals(opened.id, room.store.workout.session!!.id)
            assertEquals(set.id, room.store.workout.sets.single().id)
            assertEquals(opened.plan, room.store.workout.session!!.plan)
            assertEquals(listOf(100.0), room.store.workout.sets.map { it.weightKg })
            assertTrue(room.store.workout.refusals.isEmpty())
        }
    }

    @Test
    fun testAStartWhoseReplyWasLostRetriesTheExactEngineIntentAndKeepsItsId() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        var snapshot: works.windmill.sync.core.Json
        var original: works.windmill.sync.core.Json
        var opened: Session
        var set: TrainingSet
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice")
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            room.sync(server)
            opened = (room.store.workout.start(routine.id) as GymResult.Ok).value
            room.store.workout.choose("bench-press"); room.store.workout.logSet(100.0, 5)
            set = room.store.workout.sets.single()
            room.engine.releaseHeld(true)
            original = room.engine.nextPush()!!
            assertEquals(200, server.push(original, works.windmill.sync.modelserver.Credential.Account("alice"), room.now).status)
            snapshot = room.engine.snapshot() // The response is lost after the server has committed it.
        }
        EngineRoomFixture(folder, backgroundScope, snapshot).use { restored ->
            restored.selected = "alice"
            restored.engine.start()
            val retry = restored.engine.nextPush()!!
            assertEquals(original, retry)
            val response = server.push(retry, works.windmill.sync.modelserver.Credential.Account("alice"), restored.now)
            val reading = works.windmill.sync.core.ClockReading(restored.now, restored.now, "test")
            restored.engine.onPushResponse(retry, works.windmill.sync.engine.SyncResponse(response.status, response.body),
                works.windmill.sync.engine.RequestTiming(reading, reading))
            restored.pull(server); restored.store.connect(restored.account())
            assertEquals(opened.id, restored.store.workout.session!!.id)
            assertEquals(listOf(set.id), restored.store.workout.sets.map { it.id })
            assertEquals(listOf(100.0), restored.store.workout.sets.map { it.weightKg })
            assertEquals(1, restored.training.details().size)
            assertTrue(restored.store.workout.refusals.isEmpty())
        }
    }

    @Test
    fun testARefusedEngineStartIsSaidOnceAndItsOriginalIntentStaysOnThePhone() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val server = EngineRoomFixture.server()
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            room.sync(server)
            val opened = (room.store.workout.start(routine.id) as GymResult.Ok).value
            server.refuse(code = "id-taken")
            room.sync(server)
            withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            room.store.refreshEngine()
            val notices = room.engine.notices("gym").notices.value
            assertEquals(1, notices.size)
            assertTrue("the refused source retains its original identity", notices.single().content.command!!.args.member("id").str() == opened.id)
            val said = room.store.workout.refusals
            assertEquals(1, said.size)
            repeat(2) { room.store.refreshEngine(); assertEquals("said again, held once", said, room.store.workout.refusals) }
            assertEquals(notices, room.engine.notices("gym").notices.value)
        }
    }

    @Test
    fun testFixingASetSignedOutRewritesThePhonesRowAndWritesNothingForAnIdItNeverHeld() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            val ended = (room.store.workout.finish() as FinishOutcome.Closed).session
            runCurrent()

            val setId = (room.store.history.sessionDetail(ended.id) as GymResult.Ok).value.sets.single().id
            val fixed = room.store.workout.fixSet(ended.id, setId, SetFix(weightKg = 90.0, reps = 3))

            assertEquals(listOf(90.0), listOf((fixed as FixOutcome.Corrected).set.weightKg))
            assertEquals("one row per set — a correction is never a second set",
                listOf(setId), (room.store.history.sessionDetail(ended.id) as GymResult.Ok).value.sets.map { it.id })
            assertEquals(listOf(90.0),
                (room.store.history.sessionDetail(ended.id) as GymResult.Ok).value.sets.map { it.weightKg })
            assertEquals("the row the log screen draws moved with it",
                listOf(270.0), room.store.history.allSessions.map { it.tonnageKg })
            val before = owed(room)
            assertEquals("a row this workout does not hold is not one a fix can reach",
                FixOutcome.Gone("that set is no longer on the log"),
                room.store.workout.fixSet(ended.id, "set_gone", SetFix(weightKg = 90.0, reps = 3)))
            assertNull(room.store.workout.deleteSet(ended.id, "set_gone"))
            assertEquals("nothing is written for an id this phone has never held", before, owed(room))
            runCurrent()
        }
    }

    @Test
    fun testFixingASetOnTheAccountReachesTheLogAndMovesNoPlanAndNoRoutine() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.store.refreshEngine()
            val opened = (room.store.workout.start(pushA.id) as GymResult.Ok).value
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            room.store.workout.finish()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val logged = room.training.session(opened.id)!!.sets.single()

            val fixed = room.store.workout.fixSet(opened.id, logged.id, SetFix(weightKg = 90.0, reps = 3))

            val corrected = logged.copy(weightKg = 90.0, reps = 3)
            assertEquals(corrected, (fixed as FixOutcome.Corrected).set)
            assertEquals("the head re-read, and it followed the correction: the row that read 412.5 now reads 270",
                listOf(270.0), room.store.history.logged.map { it.tonnageKg })
            assertEquals(listOf(1), room.store.history.logged.map { it.workingSetCount })

            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                assertEquals(listOf(corrected), phone.training.session(opened.id)!!.sets)
                assertEquals("the frozen plan is what makes last Tuesday still readable — it may not move",
                    PlanSnapshot(pushA), phone.training.session(opened.id)!!.session.plan)
                assertEquals("and next week's target is nobody's business here",
                    listOf(List(5) { SetTarget(5, 82.5) }), phone.training.routine(pushA.id)!!.entries.map { it.sets })
            }
            runCurrent()
        }
    }

    // The live session's rows are the phone's until the log takes them. A set no sync has carried
    // yet is corrected in place, still owed: the strip draws the correction at once, and the
    // corrected body is what lands when the signal is back.
    @Test
    fun testFixingASetNoSyncHasCarriedRewritesItOnThePhoneAndTheCorrectionIsWhatLands() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.sync(server)
            room.store.workout.choose("bench-press")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.store.workout.logSet(weightKg = 85.0, reps = 5)
            runCurrent()
            val (tried, behind) = room.store.workout.sets.map { it.id }
            assertEquals(setOf(tried, behind), room.store.workout.stalled)
            assertEquals(2, room.store.workout.strandedCount)

            val fixed = room.store.workout.fixSet(opened.id, behind, SetFix(weightKg = 90.0, reps = 3))
            runCurrent()

            assertEquals(90.0, (fixed as FixOutcome.Corrected).set.weightKg, 0.0)
            assertEquals("the strip draws the correction from the store", listOf(82.5 to 5, 90.0 to 3),
                room.store.workout.sets.map { it.weightKg to it.reps })
            assertEquals("still owed — the log has never seen the id", setOf(tried, behind), room.store.workout.stalled)

            room.sync(server)
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Answer(SyncResponse(200, Json.objectOf())))
            room.store.refreshEngine()
            assertEquals("the corrected body is the one that landed", listOf(82.5 to 5, 90.0 to 3),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.weightKg to it.reps } })
            assertTrue(room.store.workout.stalled.isEmpty())
            assertEquals(0, room.store.workout.strandedCount)
            runCurrent()
        }
    }

    @Test
    fun testFixingADeliveredSetOfTheLiveSessionRedrawsTheStripFromTheStore() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val logged = room.store.workout.sets.single()
            assertTrue(room.store.workout.stalled.isEmpty())

            val fixed = room.store.workout.fixSet(opened.id, logged.id, SetFix(weightKg = 90.0, reps = 3))

            val corrected = (fixed as FixOutcome.Corrected).set
            assertEquals("the strip draws the correction the moment it is filed", listOf(corrected), room.store.workout.sets)
            runCurrent()
            assertEquals("the correction is owed until the log takes it", listOf("set ${logged.id}"), owed(room))

            room.sync(server); room.store.refreshEngine()
            assertEquals("the log holds the whole row the device read", listOf(corrected),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets })
            assertEquals("the strip follows the log's answer", listOf(90.0 to 3),
                room.store.workout.sets.map { it.weightKg to it.reps })
            assertTrue("a fix the log took owes nothing", room.store.workout.stalled.isEmpty())
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    // A set no sync has carried leaves the strip at once, and the log never keeps it.
    @Test
    fun testDeletingASetNoSyncHasCarriedLeavesThePhoneAndTheLogNeverKeepsIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.sync(server)
            room.store.workout.choose("bench-press")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.store.workout.logSet(weightKg = 85.0, reps = 5)
            runCurrent()
            val (tried, behind) = room.store.workout.sets

            assertNull(room.store.workout.deleteSet(opened.id, behind.id))
            runCurrent()

            assertEquals(listOf(tried), room.store.workout.sets)
            assertEquals("the unsent row and its tombstone ride out together",
                listOf("set ${tried.id}", "set ${behind.id}", "set ${behind.id}"), owed(room))
            assertEquals(1, room.store.workout.strandedCount)
            room.sync(server)
            assertEquals("and it never lands", listOf(tried.id),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.id } })
            runCurrent()
        }
    }

    @Test
    fun testDeletingADeliveredSetOfTheLiveSessionTakesItOffTheStrip() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val first = room.store.workout.sets.single()

            assertNull(room.store.workout.deleteSet(opened.id, first.id))
            runCurrent()

            assertEquals(emptyList<TrainingSet>(), room.store.workout.sets)
            assertEquals(setOf(first.id), room.store.held.deletedSets)
            assertEquals(listOf("set ${first.id}"), owed(room))
            room.sync(server)
            assertEquals("the log let it go", emptyList<TrainingSet>(),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets })

            room.store.workout.logSet(weightKg = 90.0, reps = 3)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val second = room.store.workout.sets.single()
            assertNull("a delete is filed, never refused on the spot", room.store.workout.deleteSet(opened.id, second.id))
            runCurrent()
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Failed(SyncResponse(503, Json.objectOf())))
            room.store.refreshEngine()
            assertEquals(emptyList<TrainingSet>(), room.store.workout.sets)
            assertEquals("a delete the log could not take stays owed", listOf("set ${second.id}"), owed(room))
            assertEquals(listOf(second.id),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.id } })

            room.sync(server)
            assertEquals(emptyList<TrainingSet>(),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets })
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testSignedOutASetOnTheAccountCannotBeTouchedAndIsNotBlamedOnTheSignal() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = room.workout()
            runCurrent()
            val held = room.training.session(opened.id)!!.sets.single()
            room.select(null)
            val before = owed(room)

            assertEquals(FixOutcome.Gone("that set is no longer on the log"),
                room.store.workout.fixSet(opened.id, held.id, SetFix(weightKg = 90.0, reps = 3)))
            assertNull(room.store.workout.deleteSet(opened.id, held.id))
            assertEquals("nothing was written", before, owed(room))

            room.select("alice")
            assertEquals("signing out was not a way to touch the account's set",
                listOf(held), room.training.session(opened.id)!!.sets)
            runCurrent()
        }
    }

    @Test
    fun feedbackPreferencesDoNotChangeKilogramSetWrites() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")

            room.seedFeedback(GymPreferences(confirmSound = true))
            room.store.workout.logSet(weightKg = 82.5, reps = 5)

            assertEquals(GymPreferences(confirmSound = true), room.store.workout.preferences)
            assertEquals(listOf(82.5), room.training.session(opened.id)!!.sets.map { it.weightKg })
            assertEquals(listOf(82.5), room.store.workout.sets.map { it.weightKg })
            val written = room.outbox().map { it.member("intent") }
                .single { intent -> intent["d"]?.arr()?.any { it.member("t").str() == "set" } == true }.jcs
            assertTrue("the set went out in kilograms: $written", written.contains("\"weightKg\":[82.5,"))
            assertFalse("no unit reached the set that was written: $written", written.contains("lb"))
            assertFalse(written.contains("units"))

            room.seedFeedback(GymPreferences())
            assertEquals(listOf(82.5), room.training.session(opened.id)!!.sets.map { it.weightKg })
            runCurrent()
        }
    }

    @Test
    fun testAnAccountsOwnSettingsArriveOnSignInAndAreNotOverwrittenByAFreshPhone() = runTest {
        val server = EngineRoomFixture.server()
        anotherPhone(server, 1_800_000_000_000L) { phone ->
            phone.seedFeedback(GymPreferences(confirmHaptic = false))
            phone.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            room.select("alice"); room.pull(server); room.store.refreshEngine()

            assertEquals(GymPreferences(confirmHaptic = false), room.store.workout.preferences)
            assertTrue("a phone with nothing to say says nothing", room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testASettingSavedWithNoSignalIsHeldHereAndLandsOnTheNextSync() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)

            room.seedFeedback(GymPreferences(confirmSound = true))

            assertEquals("the row on screen is the one the lifter chose", true, room.store.workout.preferences.confirmSound)
            assertEquals(listOf("prefs prefs"), owed(room))
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            relaunched.sync(server)
            assertEquals(true, anotherPhone(server, relaunched.now) { phone -> phone.store.workout.preferences.confirmSound })
            runCurrent()
        }
    }

    @Test
    fun testAReorderMovesTheWalkAndASwipeRefusesAMovementWithASetInIt() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)
            room.startExternalWorkout()
            room.store.workout.choose("back-squat")
            room.store.workout.logSet(weightKg = 100.0, reps = 5)
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 80.0, reps = 8)
            room.store.refreshEngine()
            room.store.workout.choose("romanian-deadlift")
            assertEquals(listOf("back-squat", "bench-press", "romanian-deadlift"), room.store.workout.order)

            room.store.workout.reorder(from = 2, to = 0)
            assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), room.store.workout.order)
            assertEquals("every set is exactly where it was — sets are keyed by movement, never position",
                listOf(100.0, 80.0), room.store.workout.sets.map { it.weightKg })
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals("and the walk survives the relaunch",
                listOf("romanian-deadlift", "back-squat", "bench-press"), relaunched.store.workout.order)

            assertFalse("a movement holding a set does not leave on a swipe", relaunched.store.workout.drop("back-squat"))
            assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), relaunched.store.workout.order)

            assertTrue(relaunched.store.workout.drop("romanian-deadlift"))
            assertEquals(listOf("back-squat", "bench-press"), relaunched.store.workout.order)
            assertNull("the movement in hand left the session, so the picker comes back up",
                relaunched.store.workout.exerciseId)
            assertEquals("and nothing logged went with it",
                listOf(100.0, 80.0), relaunched.store.workout.sets.map { it.weightKg })
            runCurrent()
        }
    }

    @Test
    fun testALiveSessionTheLogHoldsIsNotReStartedOnARelaunchAndItsSetsLand() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        val opened: Session
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            opened = room.startExternalWorkout()
            room.sync(server)
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            assertEquals(opened.id, relaunched.store.workout.session?.id)
            assertTrue("no start replay for a session the log answered for", relaunched.outbox().isEmpty())

            relaunched.store.workout.choose("bench-press")
            relaunched.store.workout.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            assertEquals("only its set is owed", listOf("set ${relaunched.store.workout.sets.single().id}"), owed(relaunched))
            relaunched.sync(server); relaunched.store.refreshEngine()
            assertEquals(SaveState.OnTheLog, relaunched.store.workout.saveState)
            assertEquals("its set walked straight to the log", listOf(82.5),
                anotherPhone(server, relaunched.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.weightKg } })
            runCurrent()
        }
    }

    @Test
    fun testAnAbandonedDeviceSessionIsFinishedAtItsLastActivityOnConnect() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            val lastSetAt = room.store.workout.sets.single().completedAtMs
            runCurrent()

            room.now += 3 * 60 * 60 * 1000
            val soon = room.freshStore()
            soon.connect(room.account())
            assertEquals("three hours is still a workout", "session01", soon.workout.session?.id)
            runCurrent()

            room.now += 2 * 60 * 60 * 1000
            val later = room.freshStore()
            later.connect(room.account())
            assertNull("five hours after the last set it is over", later.workout.session)
            assertEquals("finished at the last set", lastSetAt, room.training.session("session01")!!.session.finishedAtMs)
            assertEquals(listOf(82.5), room.training.session("session01")!!.sets.map { it.weightKg })
            runCurrent()

            val second = room.freshStore()
            second.connect(room.account())
            val startedAt = room.startExternalWorkout(second).startedAtMs
            runCurrent()
            room.now += 5 * 60 * 60 * 1000
            val empty = room.freshStore()
            empty.connect(room.account())
            assertNull(empty.workout.session)
            assertEquals("a session with no sets ended when it began",
                startedAt, room.training.session("session02")!!.session.finishedAtMs)
            runCurrent()
        }
    }

    @Test
    fun testAnAccountSessionAbandonedForHoursIsLetGoOnConnectAndTheLogEndsIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.sync(server)
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            val logged = room.store.workout.sets.single()
            runCurrent()

            room.now += 30 * 60 * 60 * 1000
            val relaunched = room.freshStore()
            relaunched.connect(room.account())

            assertNull("the room let the workout go", relaunched.workout.session)
            assertEquals("its owed set is still owed, and no finish was written", listOf("set ${logged.id}"), owed(room))

            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                val held = phone.training.session(opened.id)!!
                assertEquals("the owed set drained into it", listOf(82.5), held.sets.map { it.weightKg })
                assertEquals("and the log ended the workout at that set", logged.completedAtMs, held.session.finishedAtMs)
            }
            runCurrent()
        }
    }

    @Test
    fun testALapsedSignInIsNamedRatherThanCalledNoSignal() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.startExternalWorkout(); room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)

            assertTrue(room.training.reportDelivery(room.engine.activeReplica(),
                Reply.Failed(SyncResponse(401, Json.objectOf()))))
            room.store.refreshEngine()

            assertEquals(SaveState.Blocked(Blocker.SignInLapsed), room.store.workout.saveState)
            assertEquals("sign in again · saved here", room.store.workout.saveState.line)
            assertEquals(Blocker.SignInLapsed, room.store.workout.strandedBy)
            assertEquals(1, room.store.workout.strandedCount)
            assertTrue("still owed, never dropped", room.store.workout.refusals.isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testAStartFromARoutineDeletedElsewhereIsRefusedWithoutCreatingAWorkout() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val before = room.engine.snapshot()

            assertEquals(GymResult.Failed(WriteFailure.Refused("That is no longer on the log.")),
                room.store.workout.start("rt_deleted_elsewhere"))

            assertEquals(before, room.engine.snapshot())
            assertNull(room.store.workout.session)
            assertTrue(room.training.details().isEmpty())
            assertTrue(room.outbox().isEmpty())
        }
    }

    @Test
    fun testAFixOfARowDeletedElsewhereTakesItOffTheStripAndSaysSo() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val logged = room.store.workout.sets.single()
            anotherPhone(server, room.now) { phone ->
                assertNull(phone.store.workout.deleteSet(opened.id, logged.id))
                runCurrent()
                phone.sync(server)
            }

            val fixed = (room.store.workout.fixSet(opened.id, logged.id, SetFix(reps = 4)) as FixOutcome.Corrected).set
            runCurrent()
            room.sync(server); noticed(room); room.store.refreshEngine()

            assertEquals(emptyList<TrainingSet>(), room.store.workout.sets)
            assertEquals(listOf(fixed.id to "That is no longer on the log."), room.store.workout.refusals.map { it.id to it.reason })
            assertEquals(listOf(mapOf("reps" to Json.of(4))), room.engine.notices("gym").notices.value.map {
                it.content.deltas.single().lattice.fields.mapValues { field -> field.value.value }
            })
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    // A correction the log will never take owes nothing more: the log's numbers replace it, and the
    // refusal is said.
    @Test
    fun testAFixTheLogRefusesGivesTheRowBackItsLoggedNumbersAndSaysSo() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val logged = room.store.workout.sets.single()

            val fixed = (room.store.workout.fixSet(opened.id, logged.id, SetFix(reps = 4)) as FixOutcome.Corrected).set
            runCurrent()
            assertEquals("the correction is drawn while it is owed", listOf(fixed), room.store.workout.sets)

            server.refuse(code = "invalid")
            room.sync(server); noticed(room); room.store.refreshEngine()

            assertEquals("the log's numbers replace the refused ones", listOf(logged), room.store.workout.sets)
            assertEquals(listOf(fixed.id to "That change could not be saved."), room.store.workout.refusals.map { it.id to it.reason })
            assertEquals(listOf(mapOf("reps" to Json.of(4))), room.engine.notices("gym").notices.value.map {
                it.content.deltas.single().lattice.fields.mapValues { field -> field.value.value }
            })
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testAFreshArrivalLogsFourSetsAndARelaunchLosesNoneOfThem() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        val opened: Session
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)

            opened = room.startExternalWorkout()
            room.store.refreshEngine()
            assertNotNull("the tap opened it", room.store.workout.session)
            assertNull("nothing is chosen yet — that is what the picker is for", room.store.workout.exerciseId)

            room.store.workout.choose("back-squat")
            room.store.workout.logSet(weightKg = 100.0, reps = 5)
            room.store.workout.logSet(weightKg = 100.0, reps = 5)
            room.store.workout.logSet(weightKg = 102.5, reps = 5)
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 80.0, reps = 8)

            assertEquals("the whole workout is on this device and nowhere else",
                4, room.training.session(opened.id)!!.sets.size)
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { reopened ->
            reopened.now = clock; reopened.engine.start()
            reopened.select(null)

            assertEquals(opened.id, reopened.store.workout.session?.id)
            assertEquals(listOf(100.0, 100.0, 102.5, 80.0), reopened.store.workout.sets.map { it.weightKg })
            assertEquals(listOf(5, 5, 5, 8), reopened.store.workout.sets.map { it.reps })
            assertEquals(listOf("back-squat", "bench-press"), reopened.store.workout.order)
            assertEquals("it stands where the last set went, not in the picker over a session of sets",
                "bench-press", reopened.store.workout.exerciseId)
            runCurrent()
        }
    }
}
