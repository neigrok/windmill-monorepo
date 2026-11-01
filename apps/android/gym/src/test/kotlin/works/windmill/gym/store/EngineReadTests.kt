package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import works.windmill.sync.api.Change
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.core.RecordID
import works.windmill.sync.schema.Gym
import works.windmill.sync.api.DeviceWrite
import works.windmill.sync.api.Gesture
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.RecordsView
import works.windmill.platform.User
import works.windmill.gym.presentation.RoutineWrite
import works.windmill.gym.presentation.RoutineEntryWrite
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.presentation.SessionStart
import works.windmill.gym.presentation.SetWrite
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.domain.sync.SessionRules
import works.windmill.platform.Account
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.schema.SyncSchema

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class EngineReadTests {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun aRestoredReceiptReadCannotCrossAReplicaOrAccountChange() = runTest {
        val now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var pause = false
            val held = ArrayDeque<Pair<CoroutineContext, Runnable>>()
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) {
                    if (pause) held.add(context to block) else delegate.dispatch(context, block)
                }
            }
            assertTrue(engine.signIn("first", mapOf("gym" to false)).member("complete").bool())
            val training = EngineTraining(engine)
            training.startSession(SessionStart("session1", now - 10_000))
            training.finishSession("session1", now - 5_000)
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                now = { now }, readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", User("first", "first@example.com")))
            assertEquals(GymResult.Ok(training.session("session1")), store.finishedSession("session1"))
            pause = true
            val pending = async { store.finishedSession("session1") }
            try {
                runCurrent()
                assertFalse(held.isEmpty())
                assertTrue(engine.signOut("keep").member("complete").bool())
                assertTrue(engine.signIn("other", mapOf("gym" to false)).member("complete").bool())
            } finally {
                pause = false
                while (held.isNotEmpty()) {
                    val (context, task) = held.removeFirst()
                    delegate.dispatch(context, task)
                }
            }
            runCurrent()
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), pending.await())
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), store.finishedSession("session1"))
            store.connect(Account("http://127.0.0.1:8098", User("other", "other@example.com")))
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), store.finishedSession("session1"))
        }
    }

    @Test fun aRestoredReceiptRetriesAfterAnAccountABARoundTripBeforePublication() = runTest {
        val now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var afterRead: (() -> Unit)? = null
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    afterRead?.also { afterRead = null }?.invoke()
                })
            }
            assertTrue(engine.signIn("alice", mapOf("gym" to false)).member("complete").bool())
            val training = EngineTraining(engine)
            training.startSession(SessionStart("session1", now - 10_000))
            training.finishSession("session1", now - 5_000)
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                now = { now }, readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", User("alice", "alice@example.com")))
            val original = training.session("session1")!!
            assertEquals(GymResult.Ok(original), store.finishedSession("session1"))
            val replica = engine.activeReplica()
            afterRead = {
                assertTrue(engine.signOut("keep").member("complete").bool())
                assertTrue(engine.signIn("bob", mapOf("gym" to false)).member("complete").bool())
                assertTrue(engine.signOut("discard").member("complete").bool())
                assertTrue(engine.signIn("alice", mapOf("gym" to false)).member("complete").bool())
                assertEquals(replica, engine.activeReplica())
                assertTrue(engine.commit(ScopeRef.product("gym"), Gesture(listOf(Change.delete(
                    Gym.Types.session, RecordID("session1"))))) is CommitOutcome.Committed)
            }
            assertEquals(GymResult.Ok<SessionDetail?>(null), store.finishedSession("session1"))
            assertNull(afterRead)
            assertEquals(replica, store.workoutReplica)
            assertEquals(GymResult.Ok<SessionDetail?>(null), store.finishedSession("session1"))
        }
    }

    @Test fun aRestoredReceiptRequiresTheBoundSeatAfterAnonymousReplicaAdoption() = runTest {
        EngineRoomFixture(temporary.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val session = room.startExternalWorkout()
            room.training.finishSession(session.id, room.now + 1)
            val replica = room.engine.activeReplica()
            assertTrue(room.engine.signIn("alice", mapOf("gym" to false)).member("complete").bool())
            assertEquals(replica, room.engine.activeReplica())
            assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), room.store.finishedSession(session.id))
            room.selected = "alice"
            room.store.connect(room.account())
            assertEquals(GymResult.Ok(room.training.session(session.id)), room.store.finishedSession(session.id))
        }
    }

    @Test fun parsedLogTracksWritesReplicaSelectionAndTheAutoCloseBoundary() = runTest {
        var now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val training = EngineTraining(engine)
            training.startSession(SessionStart("session1", now))
            val first = training.details()
            assertSame(first, training.details())
            val set = TrainingSet("set00001", "bench-press", weightKg = 50.0, reps = 8, completedAtMs = now + 1_000)
            now += 1_000
            training.appendSet("session1", SetWrite(set))
            val changed = training.details()
            assertNotSame(first, changed)
            assertEquals(listOf(set), changed.single().sets)
            assertSame(changed, training.details())
            val pending = training.pendingSetIds()
            assertEquals(setOf(set.id), pending)
            assertSame(pending, training.pendingSetIds())
            now += SessionRules.staleAfterMs - 1
            assertSame(changed, training.details())
            now += 1
            val closed = training.details()
            assertEquals(set.completedAtMs, closed.single().session.finishedAtMs)
            assertTrue(training.sessions(50, null, null).single().closedItself)
            assertSame(closed, training.details())
            engine.signIn("first", mapOf("gym" to false))
            engine.signOut("keep")
            engine.signIn("other", mapOf("gym" to false))
            assertEquals(emptyList<Any>(), training.details())
            assertNotSame(closed, training.details())
            assertEquals(emptySet<String>(), training.pendingSetIds())
        }
    }

    @Test fun deviceImportSourcesInvalidateTheParsedLogWithoutARecordWrite() = runTest {
        val now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val training = EngineTraining(engine)
            val first = training.details()
            val source = SavedWorkout(Session("session1", now - 10_000, now - 1_000),
                listOf(TrainingSet("set00001", "bench-press", weightKg = 50.0, reps = 8, completedAtMs = now - 2_000)))
            training.imports.prepare(source)
            assertNotSame(first, training.details())
            assertEquals(source.session, training.details().single().session)
            assertEquals(source.sets, training.details().single().sets)
            assertEquals(setOf("set00001"), training.pendingSetIds())
        }
    }

    @Test fun progressReadsRunOnTheInjectedBackgroundDispatcher() = runTest {
        val threads = ConcurrentLinkedQueue<String>()
        val now = 1_800_000_000_000L
        Executors.newSingleThreadExecutor { body -> Thread(body, "gym-read-worker") }.asCoroutineDispatcher().use { reads ->
            Engine.memory(SyncSchema.registry, clock = object : EngineClock {
                override fun now(): Long { threads.add(Thread.currentThread().name); return now }
            }).use { engine ->
                val training = EngineTraining(engine)
                val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                    now = { now }, readDispatcher = reads)
                store.connect(Account("http://127.0.0.1:8098", null))
                threads.clear()
                assertTrue(store.loadProgress(force = true) is GymResult.Ok)
                assertEquals(setOf("gym-read-worker"), threads.toSet())
            }
        }
    }
    @Test fun failedBackgroundReadReportsItsStaticBoundary() = runTest {
        var failing = false
        val failures = ConcurrentLinkedQueue<Pair<String, Map<String, String>>>()
        val failedThreads = ConcurrentLinkedQueue<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures.add(operation to properties)
            }
        }
        Executors.newSingleThreadExecutor { body -> Thread(body, "gym-read-worker") }.asCoroutineDispatcher().use { reads ->
            Engine.memory(SyncSchema.registry, clock = object : EngineClock {
                override fun now(): Long {
                    if (failing) {
                        failedThreads.add(Thread.currentThread().name)
                        throw IOException("read unavailable")
                    }
                    return 1_800_000_000_000L
                }
            }).use { engine ->
                val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), EngineTraining(engine), backgroundScope,
                    telemetry = telemetry, readDispatcher = reads)
                store.connect(Account("http://127.0.0.1:8098", null))
                failing = true
                assertTrue(store.loadProgress(force = true) is GymResult.Failed)
                assertEquals(listOf("gym.loadProgress" to emptyMap<String, String>()), failures.toList())
                assertEquals(setOf("gym-read-worker"), failedThreads.toSet())
                assertFalse(store.progressLoading)
            }
        }
    }

    @Test fun aQueuedReadCannotPublishAfterTheReplicaChanges() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), EngineTraining(engine), backgroundScope,
                readDispatcher = StandardTestDispatcher(testScheduler, "reads"))
            store.connect(Account("http://127.0.0.1:8098", null))
            val pending = async(start = CoroutineStart.UNDISPATCHED) { store.loadProgress(force = true) }
            assertTrue(store.progressLoading)
            engine.signIn("other", mapOf("gym" to false))
            runCurrent()
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), pending.await())
            assertFalse(store.progressLoading)
            assertNull(store.progressFailure)
        }
    }

    @Test fun continuousRevisionChangesAbandonTheReadAfterThreeAttempts() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var churn = false
            var changes = 0
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    if (churn) engine.commit(ScopeRef.product("gym")) {
                        Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(++changes)))) to Unit
                    }
                })
            }
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), EngineTraining(engine), backgroundScope,
                readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", null))
            churn = true
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), store.loadProgress(force = true))
            assertEquals(3, changes)
            assertFalse(store.progressLoading)
        }
    }

    @Test fun replicaChangeDuringObservationKeepsTheConsumerForLaterUpdates() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var pause = false
            val held = ArrayDeque<Pair<CoroutineContext, Runnable>>()
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) {
                    if (pause) held.add(context to block) else delegate.dispatch(context, block)
                }
            }
            val training = EngineTraining(engine)
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", null))
            pause = true
            val consumer = store.observeEngine()
            try {
                runCurrent()
                assertFalse(held.isEmpty())
                engine.signIn("other", mapOf("gym" to false))
            } finally {
                pause = false
                while (held.isNotEmpty()) {
                    val (context, task) = held.removeFirst()
                    delegate.dispatch(context, task)
                }
            }
            runCurrent()
            assertTrue(consumer.isActive)
            store.connect(Account("http://127.0.0.1:8098", User("other", "other@example.com")))
            val view = engine.records(ScopeRef.product("gym"), "routine")
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            withContext(Dispatchers.Default) {
                withTimeout(5_000) { view.state.first { state -> state is RecordsView.State.Loaded &&
                    state.snapshot.records.any { it.id.toString() == "routine1" } } }
            }
            runCurrent()
            assertEquals(listOf("routine1"), store.routines.map { it.id })
            assertTrue(consumer.isActive)
        }
    }

    @Test fun aDelayedLogRefreshCannotCloseAWorkoutStartedDuringItsRead() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var afterRead: (() -> Unit)? = null
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    afterRead?.invoke()
                })
            }
            val training = EngineTraining(engine)
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", null))
            var readsCompleted = 0
            var opened: Session? = null
            afterRead = {
                if (++readsCompleted == 3) {
                    afterRead = null
                    opened = runBlocking { (store.start("routine1") as GymResult.Ok).value }
                }
            }
            store.refreshEngine()
            assertNotNull(opened)
            assertEquals(opened, store.session)
            assertEquals(opened, training.openWorkout()?.session)
        }
    }

    @Test fun aDelayedAdoptionCannotReopenTheWorkoutFinishedDuringItsRead() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var afterRead: (() -> Unit)? = null
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    afterRead?.invoke()
                })
            }
            val training = EngineTraining(engine)
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", null))
            assertTrue(store.start("routine1") is GymResult.Ok)
            var readsCompleted = 0
            var finished = false
            afterRead = {
                if (++readsCompleted == 4) {
                    afterRead = null
                    finished = runBlocking { store.finish() is FinishOutcome.Closed }
                }
            }
            store.refreshEngine()
            assertTrue(finished)
            assertNull(store.session)
            assertNull(training.openWorkout())
        }
    }
    @Test fun aSupersededManualPageReadLeavesARetryableState() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), EngineTraining(engine), backgroundScope,
                readDispatcher = StandardTestDispatcher(testScheduler))
            val page = async(start = CoroutineStart.UNDISPATCHED) { store.loadOlder() }
            val detail = async(start = CoroutineStart.UNDISPATCHED) { store.sessionDetail("session1") }
            assertEquals(Older.Loading, store.older)
            engine.signIn("other", mapOf("gym" to false))
            runCurrent()
            page.await()
            assertEquals(Older.Failed, store.older)
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), detail.await())
            engine.signOut("keep")
            store.loadOlder()
            assertEquals(Older.End, store.older)
        }
    }

    @Test fun aFinishRefreshCannotAbandonTheNextExternalWorkoutAdoption() = runTest {
        EngineRoomFixture(temporary.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            assertTrue(room.store.start("routine1") is GymResult.Ok)
            room.store.choose("bench-press")
            room.store.logSet(50.0, 8)
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            val next = room.training.startSession(SessionStart("nextworkout", ++room.now))
            room.store.refreshEngine()
            assertEquals(next.id, room.store.session?.id)
            room.store.choose("back-squat")
            room.store.logSet(100.0, 5)
            assertEquals(listOf(100.0 to 5), room.training.session(next.id)!!.sets.map { it.weightKg to it.reps })
        }
    }

    @Test fun abandonedSelectedHistoryRetriesWithoutReplacingAnEditedRack() = runTest {
        val now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var changes = 0
            var churn = false
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    if (churn && changes < 3) engine.commit(ScopeRef.product("gym")) {
                        Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(++changes)))) to Unit
                    }
                })
            }
            val training = EngineTraining(engine)
            training.startSession(SessionStart("history1", now - 10_000))
            training.appendSet("history1", SetWrite("set00001", "bench-press", 100.0, 6, now - 9_000))
            training.finishSession("history1", now - 5_000)
            training.startSession(SessionStart("session1", now))
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                now = { now }, readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", null))
            store.observeEngine()
            runCurrent()
            churn = true
            store.choose("bench-press")
            assertEquals(3, changes)
            assertTrue(store.lastTime!!.isUnread)
            assertTrue(store.editRack(77.0, 7) is works.windmill.gym.presentation.WorkoutChange.Saved)
            runCurrent()
            assertEquals(listOf(100.0 to 6), store.lastTime!!.sets.map { it.weightKg to it.reps })
            assertEquals(77.0 to 7, store.rack!!.weightKg to store.rack!!.reps)
            assertEquals(77.0 to 7, store.notification.value!!.offer!!.weightKg to store.notification.value!!.offer!!.reps)
        }
    }

    @Test fun arrivingAccountCannotPrepareARackFromThePreviousAccountsHistory() = runTest {
        val now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var pauseAt = 0
            var readCount = 0
            val held = ArrayDeque<Pair<CoroutineContext, Runnable>>()
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) {
                    if (pauseAt > 0 && ++readCount >= pauseAt) held.add(context to block)
                    else delegate.dispatch(context, block)
                }
            }
            val training = EngineTraining(engine)
            val file = File(temporary.root, "controls.json")
            suspend fun seed(account: String, weight: Double) {
                engine.signIn(account, mapOf("gym" to false))
                training.startSession(SessionStart("history$account", now - 10_000))
                training.appendSet("history$account", SetWrite("set0000$account", "bench-press", weight, 6, now - 9_000))
                training.finishSession("history$account", now - 5_000)
                val live = training.startSession(SessionStart("session$account", now))
                val controls = WorkoutControls(file)
                controls.adopt(account)
                controls.project(engine.activeReplica(), live, emptyList())
                controls.choose("bench-press")
                controls.flush()
                training.persistControls(controls)
            }
            seed("B", 80.0)
            engine.signOut("keep")
            seed("A", 140.0)
            val store = TrainingStore(WorkoutControls(file), training, backgroundScope, now = { now }, readDispatcher = reads)
            store.connect(Account("http://127.0.0.1:8098", User("A", "a@example.com")))
            assertEquals(listOf(140.0), store.lastTime!!.sets.map { it.weightKg })
            store.prepareEngineTransition()
            engine.signOut("keep")
            engine.signIn("B", mapOf("gym" to false))
            pauseAt = 3
            val connection = async(start = CoroutineStart.UNDISPATCHED) {
                store.connect(Account("http://127.0.0.1:8098", User("B", "b@example.com")))
            }
            // A held read is released however the checks end: a read never dispatched can never be cancelled, so a
            // failed check would otherwise leave runTest waiting on it for good.
            try {
                runCurrent()
                assertFalse(held.isEmpty())
                assertTrue(store.lastTime!!.isUnread)
                assertEquals("sessionB", store.session!!.id)
                assertEquals(20.0, store.rack!!.weightKg, 0.0)
                assertEquals(20.0, store.notification.value!!.offer!!.weightKg, 0.0)
            } finally {
                pauseAt = 0
                while (held.isNotEmpty()) {
                    val (context, task) = held.removeFirst()
                    delegate.dispatch(context, task)
                }
            }
            connection.await()
            assertEquals(listOf(80.0), store.lastTime!!.sets.map { it.weightKg })
            assertEquals(80.0, store.rack!!.weightKg, 0.0)
        }
    }

    @Test fun abandonedConnectionTailResumesItsRoutineMovement() = runTest {
        val now = 1_800_000_000_000L
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = now }).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var readCount = 0
            var changes = 0
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    if (++readCount >= 3 && changes < 3) engine.commit(ScopeRef.product("gym")) {
                        Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(++changes)))) to Unit
                    }
                })
            }
            val training = EngineTraining(engine)
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            training.startSession(SessionStart("session1", now, "routine1"))
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                now = { now }, readDispatcher = reads)
            store.observeEngine()
            runCurrent()
            store.connect(Account("http://127.0.0.1:8098", null))
            assertEquals(3, changes)
            runCurrent()
            assertFalse(store.isLoading)
            assertEquals("session1", store.session!!.id)
            assertEquals("bench-press", store.exerciseId)
            assertEquals("bench-press", store.lastTime!!.exerciseId.record.string)
            assertFalse(store.lastTime!!.isUnread)
            assertNotNull(store.notification.value!!.offer)
        }
    }

    @Test fun anOpenRetainedImportCannotBecomeTheAuthoritativeLiveWorkout() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val training = EngineTraining(engine)
            val retained = Session("session1", 1_800_000_000_000L)
            training.imports.prepare(SavedWorkout(retained, emptyList()))
            assertEquals(listOf(retained), training.details().map { it.session })
            assertNull(training.openWorkout())
        }
    }
    @Test fun aConnectionSupersededByThreeRevisionsResumesWithoutLeakingThePreviousSeat() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var changes = 0
            var churn = false
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    if (churn && changes < 3) engine.commit(ScopeRef.product("gym")) {
                        Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(++changes)))) to Unit
                    }
                })
            }
            val training = EngineTraining(engine)
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                readDispatcher = reads)
            engine.signIn("first", mapOf("gym" to false))
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            store.connect(Account("http://127.0.0.1:8098", User("first", "first@example.com")))
            assertEquals(listOf("routine1"), store.routines.map { it.id })
            store.observeEngine()
            runCurrent()
            engine.signOut("keep")
            engine.signIn("other", mapOf("gym" to false))
            training.createRoutine(RoutineWrite("routine2", "Pull A", 0, listOf(RoutineEntryWrite("barbell-row"))))
            churn = true
            val connection = async(start = CoroutineStart.UNDISPATCHED) {
                store.connect(Account("http://127.0.0.1:8098", User("other", "other@example.com")))
                store.isLoading
            }
            assertEquals(emptyList<String>(), store.routines.map { it.id })
            assertTrue(connection.await())
            runCurrent()
            assertEquals(3, changes)
            assertFalse(store.isLoading)
            assertNull(store.workoutFailure)
            assertEquals(listOf("routine2"), store.routines.map { it.id })
            assertTrue(store.start("routine2") is GymResult.Ok)
        }
    }

    @Test fun readingPendingSetsAfterARevisionChangeNeverQueriesTheEngineOnTheCaller() = runTest {
        var unavailable = false
        Engine.memory(SyncSchema.registry, clock = object : EngineClock {
            override fun now(): Long {
                check(!unavailable) { "A Compose read cannot query the engine." }
                return 1_800_000_000_000L
            }
        }).use { engine ->
            val training = EngineTraining(engine)
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                readDispatcher = StandardTestDispatcher(testScheduler))
            store.connect(Account("http://127.0.0.1:8098", null))
            assertTrue(store.start("routine1") is GymResult.Ok)
            store.choose("bench-press")
            store.logSet(50.0, 8)
            val set = store.sets.single()
            engine.commit(ScopeRef.product("gym")) {
                Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(1)))) to Unit
            }
            unavailable = true
            assertEquals(setOf(set.id), store.stalled)
            unavailable = false
        }
    }
    @Test fun runtimeRetriesAnAbandonedRestoreBeforeAcceptingAWorkoutCommand() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            var changes = 0
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    if (changes < 3) engine.commit(ScopeRef.product("gym")) {
                        Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(++changes)))) to Unit
                    }
                })
            }
            val training = EngineTraining(engine)
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            val store = TrainingStore(WorkoutControls(File(temporary.root, "controls.json")), training, backgroundScope,
                readDispatcher = reads)
            val runtime = GymRuntime(store, cachedOwner = { null }, authorityAvailable = { true }, dispatcher = delegate)
            runtime.restoreLocal()
            assertEquals(3, changes)
            assertNull(store.workoutFailure)
            assertTrue(store.start("routine1") is GymResult.Failed)
            runtime.restoreLocal()
            assertTrue(store.start("routine1") is GymResult.Ok)
        }
    }
    @Test fun abandonedLastTimeRestoreDoesNotMarkTheWorkoutReady() = runTest {
        Engine.memory(SyncSchema.registry).use { engine ->
            val delegate = StandardTestDispatcher(testScheduler)
            val training = EngineTraining(engine)
            training.createRoutine(RoutineWrite("routine1", "Push A", 0, listOf(RoutineEntryWrite("bench-press"))))
            val file = File(temporary.root, "controls.json")
            val first = TrainingStore(WorkoutControls(file), training, backgroundScope, readDispatcher = delegate)
            first.connect(Account("http://127.0.0.1:8098", null))
            val opened = (first.start("routine1") as GymResult.Ok).value
            first.choose("bench-press")
            val controls = WorkoutControls(file)
            assertEquals(engine.activeReplica(), controls.engineReplica)
            var readsCompleted = 0
            var changes = 0
            val reads = object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) = delegate.dispatch(context, Runnable {
                    block.run()
                    if (++readsCompleted >= 2 && changes < 3) engine.commit(ScopeRef.product("gym")) {
                        Gesture(emptyList(), local = listOf(DeviceWrite("rack:capturerevision", Json.of(++changes)))) to Unit
                    }
                })
            }
            val restored = TrainingStore(controls, training, backgroundScope, readDispatcher = reads)
            assertFalse(restored.restoreWorkout(null, true))
            assertEquals(3, changes)
            assertNull(restored.notification.value)
            assertTrue(restored.restoreWorkout(null, true))
            assertEquals(opened, restored.session)
            assertEquals("bench-press", restored.exerciseId)
            assertNotNull(restored.lastTime)
            assertNotNull(restored.notification.value)
        }
    }
}
