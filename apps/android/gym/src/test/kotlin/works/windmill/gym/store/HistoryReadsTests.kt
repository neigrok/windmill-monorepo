package works.windmill.gym.store

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.sync.engine.signIn
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant
import works.windmill.domain.kit.Outcome
import works.windmill.gym.presentation.Review
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.SetWrite
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.ImportedSet
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.ModelServer
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Session as EngineSession
import works.windmill.gym.domain.sync.TrainingSet as EngineSet

class HistoryReadsTests {
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

    @Test fun anOpenMovementEditorCannotWriteIntoAnotherAccountBeforeOrAfterConnect() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = room.store.routines.catalog.first { it.id == "bench-press" }
            val account = room.store.seat.accountKey
            val replica = room.store.seat.replica
            assertTrue(room.engine.signOut("keep").member("complete").bool())
            assertTrue(room.engine.signIn("bob", mapOf("gym" to true)).member("complete").bool())
            val beforeConnect = room.engine.snapshot()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")),
                room.store.history.edit(opened.id, "ALICE_PRIVATE_NAME", "dumbbell", 2, opened, account, replica))
            assertEquals(beforeConnect, room.engine.snapshot())
            room.selected = "bob"
            room.store.connect(room.account())
            val afterConnect = room.engine.snapshot()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")),
                room.store.history.edit(opened.id, "ALICE_PRIVATE_NAME", "dumbbell", 2, opened, account, replica))
            assertEquals(afterConnect, room.engine.snapshot())
            assertEquals(opened, room.training.catalogue().first { it.id == opened.id })
        }
    }

    @Test fun anonymousAdoptionCannotReuseAnOpenMovementEditorEvenWhenTheReplicaIdStaysTheSame() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.store.routines.create("ANONYMOUS_PRIVATE_MOVEMENT", "barbell")
            val opened = room.store.routines.catalog.first { it.id == "bench-press" }
            val account = room.store.seat.accountKey
            val replica = room.store.seat.replica
            assertTrue(room.engine.signIn("alice", mapOf("gym" to false)).member("complete").bool())
            assertEquals(replica, room.engine.activeReplica())
            val before = room.engine.snapshot()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")),
                room.store.history.edit(opened.id, "ANONYMOUS_PRIVATE_NAME", "dumbbell", 2, opened, account, replica))
            assertEquals(before, room.engine.snapshot())
            assertEquals(opened, room.training.catalogue().first { it.id == opened.id })
        }
    }

    @Test fun aCommittedEditKeepsItsSuccessWhenTheNextLockOwnerChangesAccount() = runTest {
        val armed = java.util.concurrent.atomic.AtomicBoolean(false)
        val lifecycle = java.util.concurrent.atomic.AtomicReference<Thread>()
        val lifecycleFailure = java.util.concurrent.atomic.AtomicReference<Throwable>()
        lateinit var engine: works.windmill.sync.engine.Engine
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry, createEngine = { snapshot, clock ->
            works.windmill.sync.engine.Engine.memory(works.windmill.sync.schema.SyncSchema.registry, snapshot,
                clock = object : works.windmill.sync.engine.EngineClock {
                    override fun now(): Long {
                        if (armed.compareAndSet(true, false)) {
                            val thread = Thread {
                                try {
                                    assertTrue(engine.signOut("keep").member("complete").bool())
                                    assertTrue(engine.signIn("bob", mapOf("gym" to false)).member("complete").bool())
                                } catch (failure: Throwable) { lifecycleFailure.set(failure) }
                            }
                            lifecycle.set(thread)
                            thread.start()
                            val deadline = System.nanoTime() + 5_000_000_000
                            while (thread.state != Thread.State.WAITING && thread.isAlive && System.nanoTime() < deadline) Thread.yield()
                            assertEquals(Thread.State.WAITING, thread.state)
                        }
                        return clock.now()
                    }
                }).also { engine = it }
        }).use { room ->
            room.select("alice")
            val base = room.store.routines.catalog.first { it.id == "bench-press" }
            events.clear(); failures.clear(); armed.set(true)
            val result = room.store.history.edit(base.id, "Alice press", "other", 1, base)
            lifecycle.get().join(5_000)
            assertFalse(lifecycle.get().isAlive)
            assertNull(lifecycleFailure.get())
            val accepted = base.copy(name = "Alice press", equipment = "other", aliases = listOf("Bench Press"))
            assertEquals(GymResult.Ok(accepted), result)
            assertEquals(base, room.training.catalogue().first { it.id == base.id })
            room.selected = "bob"
            room.store.connect(room.account("bob"))
            assertEquals(base, room.store.routines.catalog.first { it.id == base.id })
            assertEquals(listOf("gym_action" to mapOf("screen" to "record", "action" to "edit", "outcome" to "ok")), events)
            assertEquals(emptyList<String>(), failures)
            room.select("alice")
            assertEquals(accepted, room.training.catalogue().first { it.id == base.id })
        }
    }

    @Test fun editReportsBoundedOutcomesAndUnexpectedFailureWithoutMovementContent() = runTest {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures += operation to properties
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val base = room.store.routines.catalog.first { it.id == "bench-press" }
            assertTrue(room.store.history.edit(base.id, "PRIVATE_MOVEMENT", "dumbbell", 2, base) is GymResult.Ok)
            room.store.refreshEngine()
            assertEquals("PRIVATE_MOVEMENT", room.store.routines.catalog.first { it.id == base.id }.name)
            assertEquals(GymResult.Failed(WriteFailure.Refused("Name it to save it.")), room.store.history.edit(base.id, " "))
            val before = room.engine.snapshot()
            room.engine.failNextCommit()
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), room.store.history.edit(base.id, "PRIVATE_FAILED_MOVEMENT"))
            assertEquals(before, room.engine.snapshot())
            assertEquals(listOf("ok", "refused", "failed").map { outcome -> "gym_action" to
                mapOf("screen" to "record", "action" to "edit", "outcome" to outcome) }, events)
            assertEquals(listOf("gym.editExercise" to emptyMap<String, String>()), failures)
        }
    }

    @Test
    fun testSignedOutTheRecordAndTheReviewAreComputedOnThePhone() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val movement = (room.store.routines.create("Bench Press", "barbell") as GymResult.Ok).value

            room.startExternalWorkout()
            room.store.workout.choose(movement.id)
            room.store.workout.logSet(weightKg = 60.0, reps = 10)
            repeat(4) { room.store.workout.logSet(weightKg = 82.5, reps = 5) }
            room.now += 60_000
            val ended = (room.store.workout.finish() as FinishOutcome.Closed).session
            runCurrent()

            val record = (room.store.history.record(movement.id) as GymResult.Ok).value
            assertEquals("Bench Press", record.exercise.name)
            assertEquals(listOf(ended.id), record.recentDays.map { it.sessionId })
            assertEquals("every set counts, with all recorded loads",
                listOf(60.0, 82.5, 82.5, 82.5, 82.5), record.recentDays.single().sets.map { it.weightKg })

            val review = room.store.history.review(ended.id)
            assertEquals("a first workout beats nothing and has no routine before it", Review(), review)

            val detail = (room.store.history.sessionDetail(ended.id) as GymResult.Ok).value
            assertEquals(5, detail.sets.size)
            runCurrent()
        }
    }

    @Test
    fun testARenameMovesTheNameAndNeverTheIdAndTheReplicaKeepsIt() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        val movement: works.windmill.gym.presentation.Exercise
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)
            movement = (room.store.routines.create("Bench Pres", "barbell") as GymResult.Ok).value

            room.startExternalWorkout()
            room.store.workout.choose(movement.id)
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            room.store.workout.finish()
            runCurrent()

            assertEquals("the page draws the movement the write confirmed, not the string typed at it",
                movement.copy(name = "Bench Press", aliases = listOf("Bench Pres")),
                (room.store.history.edit(movement.id, " Bench Press ") as GymResult.Ok).value)
            room.store.refreshEngine()
            assertEquals("Bench Press", room.store.routines.catalog.single { it.id == movement.id }.name)

            val record = (room.store.history.record(movement.id) as GymResult.Ok).value
            assertEquals("Bench Press", record.exercise.name)
            assertEquals("the history is whole — the id never moved", 1, record.recentDays.size)

            assertEquals("Name it to save it.",
                ((room.store.history.edit(movement.id, "   ") as GymResult.Failed).why as WriteFailure.Refused).said)
            assertEquals("a catalog movement is renamed on the phone signed out too",
                "Squat", (room.store.history.edit("back-squat", "Squat") as GymResult.Ok).value.name)
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals("Bench Press", relaunched.store.routines.catalog.single { it.id == movement.id }.name)
            runCurrent()
        }
    }

    @Test
    fun testSignedInARenameGoesToTheLogAndTheCatalogFollowsIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)

            assertEquals("Low-bar Squat",
                (room.store.history.edit("back-squat", "Low-bar Squat") as GymResult.Ok).value.name)

            assertEquals(listOf("exerciseName back-squat"), owed(room))
            room.store.refreshEngine()
            assertEquals("Low-bar Squat", room.store.routines.catalog.single { it.id == "back-squat" }.name)
            assertEquals("the id is what every set points at, and it did not move",
                "back-squat", room.store.routines.catalog.single { it.id == "back-squat" }.id)
            room.sync(server)
            assertEquals("Low-bar Squat", anotherPhone(server, room.now) { phone ->
                phone.store.routines.catalog.single { it.id == "back-squat" }.name })
            runCurrent()
        }
    }

    @Test
    fun testARecordOfAMovementTheLogDoesNotHoldSaysWhyRatherThanDrawingNothing() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())

            assertEquals(GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log")),
                room.store.history.record("ex_gone"))
            runCurrent()
        }
    }

    @Test
    fun testTheLogPagesOlderOnAskAndKnowsWhenItHasReachedTheBottom() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            repeat(60) { index ->
                val id = "session${index.toString().padStart(3, '0')}"
                room.training.startSession(SessionStart(id, room.now - 100_000 + index * 1_000L))
                room.training.finishSession(id, room.now - 99_500 + index * 1_000L)
            }
            room.store.connect(room.account())

            assertEquals("a full page, so there may be more", Older.More, room.store.history.older)
            assertEquals(50, room.store.history.logged.size)
            assertEquals("newest first", "session059", room.store.history.logged.first().id)

            room.store.history.loadOlder()

            assertEquals("sixty sessions, no row twice", 60, room.store.history.logged.size)
            assertEquals(60, room.store.history.logged.map { it.id }.toSet().size)
            assertEquals("a short page is the bottom", Older.End, room.store.history.older)
            assertEquals("session000", room.store.history.logged.last().id)

            room.store.history.loadOlder()
            assertEquals("the bottom stays the bottom", Older.End, room.store.history.older)
            assertEquals(60, room.store.history.logged.size)
            runCurrent()
        }
    }

    @Test
    fun testTheEngineReReadKeepsThePagesTheLifterWalked() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            repeat(60) { index ->
                val id = "session${index.toString().padStart(3, '0')}"
                room.training.startSession(SessionStart(id, room.now - 100000 + index * 1000L))
                room.training.finishSession(id, room.now - 99500 + index * 1000L)
            }
            room.select(null); room.store.history.loadOlder()
            assertEquals(60, room.store.history.logged.size)
            assertEquals(Older.End, room.store.history.older)
            room.training.startSession(SessionStart("sessionShelf", room.now - 1000))
            room.training.appendSet("sessionShelf", SetWrite("setShelf", "bench-press", 100.0, 5, room.now - 900))
            room.training.finishSession("sessionShelf", room.now - 500)
            room.store.refreshEngine()
            assertEquals("the pages the lifter walked are still under their thumb", 61, room.store.history.logged.size)
            assertEquals("no row twice", 61, room.store.history.logged.map { it.id }.toSet().size)
            assertEquals("newest first, with the imported session at the head", "sessionShelf", room.store.history.logged.first().id)
            assertEquals("the deepest row is where the walk left it", "session000", room.store.history.logged.last().id)
            assertEquals("the foot is still the bottom they arrived at", Older.End, room.store.history.older)
        }
    }

    @Test
    fun testSignedOutThePhoneIsTheWholeLogAndThereIsNothingOlder() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val ended = room.workout(load = 100.0)
            runCurrent()
            room.store.refreshEngine()

            assertEquals(Older.End, room.store.history.older)
            assertEquals(listOf(ended.id), room.store.history.allSessions.map { it.id })
            assertEquals("saved on this device is the only thing it is", setOf(ended.id), room.store.workout.deviceOnlySessionIds)
            assertEquals("and the row carries what the log's own row would",
                listOf(1), room.store.history.allSessions.map { it.workingSetCount })
            assertEquals(listOf(500.0), room.store.history.allSessions.map { it.tonnageKg })
            runCurrent()
        }
    }

    @Test
    fun testARowWalkedDownToWithLoadOlderFollowsItsOwnCorrection() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
            repeat(60) { index ->
                val id = "session${index.toString().padStart(3, '0')}"
                val startedAt = room.now - 100_000 + index * 1_000L
                val set = ImportedSet(Id("set${index.toString().padStart(5, '0')}", EngineSet), Id("bench-press", EngineExercise),
                    100.0, 5, Instant(startedAt + 100))
                assertTrue(runner.run(ImportSession(Id(id, EngineSession), Instant(startedAt), Instant(startedAt + 500), listOf(set))) is Outcome.Committed)
            }
            room.store.connect(room.account())
            room.store.history.loadOlder()
            assertEquals("the deepest row is a page and a half down", "session000", room.store.history.logged.last().id)
            assertEquals(listOf(500.0, 1), listOf(room.store.history.logged.last().tonnageKg, room.store.history.logged.last().workingSetCount))

            room.store.workout.fixSet("session000", "set00000", SetFix(weightKg = 60.0, reps = 3))

            assertEquals("the walk is not undone by a fix at the bottom of it", 60, room.store.history.logged.size)
            assertEquals("and the row followed the correction",
                listOf(180.0, 1), listOf(room.store.history.logged.last().tonnageKg, room.store.history.logged.last().workingSetCount))
            runCurrent()
        }
    }

    @Test
    fun testAnUnreadLogReadsAtTheFootAndLoadsFromWhereItStoppedOnceThePullLands() = runTest {
        val server = EngineRoomFixture.server()
        val held = anotherPhone(server, 1_800_000_000_000L) { phone ->
            phone.workout().also { phone.sync(server) }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            room.select("alice")

            assertEquals(Older.Reading, room.store.history.older)
            assertTrue(room.store.history.logged.isEmpty())

            room.pull(server)
            room.store.history.loadOlder()

            assertEquals(listOf(held.id), room.store.history.logged.map { it.id })
            assertEquals(Older.End, room.store.history.older)
            runCurrent()
        }
    }
}
