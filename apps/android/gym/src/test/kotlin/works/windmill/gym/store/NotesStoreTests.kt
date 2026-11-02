package works.windmill.gym.store

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.Note
import works.windmill.gym.presentation.NoteWrite
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.nextPush
import works.windmill.sync.schema.SyncSchema
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class NotesStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun failedNotebookReadsKeepTheWholeSnapshotAndRecover() = runTest {
        for (failure in listOf(IOException("read unavailable"), CancellationException("read unavailable"))) {
            val expectedFailures = listOf("gym.readNotes" to emptyMap<String, String>())
            var armed = false
            val failures = mutableListOf<Pair<String, Map<String, String>>>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) = Unit
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                    failures.add(operation to properties)
                }
            }
            EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry, createEngine = { snapshot, clock ->
                Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock {
                    override fun now(): Long {
                        if (armed) throw failure
                        return clock.now()
                    }
                })
            }).use { room ->
                room.select("alice")
                room.pull(EngineRoomFixture.server())
                assertEquals(GymResult.Ok(Note("note_a", 0, "A", "First", 0)),
                    room.store.notes.saveNote("note_a", NoteWrite("A", "First")))
                assertEquals(GymResult.Ok(Note("note_b", 1, "B", "Second", 0)),
                    room.store.notes.saveNote("note_b", NoteWrite("B", "Second")))
                val expected = listOf(Note("note_a", 0, "A", "First", 0), Note("note_b", 1, "B", "Second", 0))
                assertEquals(GymResult.Ok(expected), room.store.notes.readNotes())
                val ready = room.store.notes.notesRead
                val refusals = room.store.notes.noteRefusals
                failures.clear()
                armed = true

                assertEquals(GymResult.Failed(WriteFailure.NoAnswer), room.store.notes.readNotes())
                assertEquals(expectedFailures, failures)
                assertEquals(expected, room.store.notes.all)
                assertEquals(ready, room.store.notes.notesRead)
                assertEquals(refusals, room.store.notes.noteRefusals)

                armed = false
                assertEquals(GymResult.Ok(expected), room.store.notes.readNotes())
                assertEquals(expectedFailures, failures)
            }
        }
    }

    @Test
    fun cancellingANotebookReadKeepsItsSnapshotWithoutReporting() = runTest {
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures.add(operation)
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry,
            readDispatcher = StandardTestDispatcher(testScheduler)).use { room ->
            room.select("alice")
            room.pull(EngineRoomFixture.server())
            assertEquals(GymResult.Ok(Note("note_a", 0, "A", "First", 0)),
                room.store.notes.saveNote("note_a", NoteWrite("A", "First")))
            val expected = listOf(Note("note_a", 0, "A", "First", 0))
            assertEquals(GymResult.Ok(expected), room.store.notes.readNotes())
            val ready = room.store.notes.notesRead
            val refusals = room.store.notes.noteRefusals
            val pending = async(start = CoroutineStart.UNDISPATCHED) { room.store.notes.readNotes() }
            pending.cancel()
            pending.join()
            assertTrue(pending.isCancelled)
            assertEquals(expected, room.store.notes.all)
            assertEquals(ready, room.store.notes.notesRead)
            assertEquals(refusals, room.store.notes.noteRefusals)
            assertEquals(emptyList<String>(), failures)
        }
    }

    @Test
    fun cancellationExceptionsFromAnActiveNotebookWriteReturnFailures() = runTest {
        var armed = false
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures.add(operation)
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry, createEngine = { snapshot, clock ->
            Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock {
                override fun now(): Long {
                    if (armed) throw CancellationException("write unavailable")
                    return clock.now()
                }
            })
        }).use { room ->
            room.select("alice")
            room.pull(EngineRoomFixture.server())
            val first = Note("note_a", 0, "A", "First", 0)
            val second = Note("note_b", 1, "B", "Second", 0)
            assertEquals(GymResult.Ok(first), room.store.notes.saveNote("note_a", NoteWrite("A", "First")))
            assertEquals(GymResult.Ok(second), room.store.notes.saveNote("note_b", NoteWrite("B", "Second")))
            val before = room.engine.snapshot()
            armed = true

            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), room.store.notes.saveNote("note_a", NoteWrite("Changed", "")))
            assertEquals(WriteFailure.NoAnswer, room.store.notes.deleteNote("note_a"))
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), room.store.notes.reorderNotes("note_a", listOf("note_b", "note_a")))
            assertEquals(listOf(first, second), room.store.notes.all)
            assertEquals(listOf("gym.saveNote", "gym.deleteNote", "gym.reorderNotes"), failures)

            armed = false
            assertEquals(before, room.engine.snapshot())
        }
    }

    @Test
    fun testANoteIsSavedEditedReorderedAndDeletedInTheLogsOwnOrder() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())

            val first = room.store.notes.saveNote("note_a", NoteWrite("How I want to be talked to", "Blunt."))
            val second = room.store.notes.saveNote("note_b", NoteWrite("What I am training for", "A 140 squat."))
            assertEquals(GymResult.Ok(Note("note_a", 0, "How I want to be talked to", "Blunt.", 0)), first)
            assertEquals(GymResult.Ok(Note("note_b", 1, "What I am training for", "A 140 squat.", 0)), second)

            assertEquals("a spent id edits in place and keeps its position",
                GymResult.Ok(Note("note_a", 0, "How I want to be talked to", "Blunt, no cheering.", 0)),
                room.store.notes.saveNote("note_a", NoteWrite("How I want to be talked to", "Blunt, no cheering.")))

            val reordered = room.store.notes.reorderNotes("note_a", listOf("note_b", "note_a"))
            assertEquals(GymResult.Ok(listOf(
                Note("note_b", 0, "What I am training for", "A 140 squat.", 0),
                Note("note_a", 1, "How I want to be talked to", "Blunt, no cheering.", 0),
            )), reordered)
            assertEquals("an order naming a note outside the notebook is refused before anything is written",
                GymResult.Failed(WriteFailure.Refused("The notes changed. Read them again before reordering.")),
                room.store.notes.reorderNotes("note_gone", listOf("note_gone")))

            assertNull(room.store.notes.deleteNote("note_b"))
            assertNull("a note already gone is gone", room.store.notes.deleteNote("note_b"))
            assertEquals(GymResult.Ok(listOf(
                Note("note_a", 0, "How I want to be talked to", "Blunt, no cheering.", 0),
            )), room.store.notes.readNotes())
            runCurrent()
        }
    }

    @Test
    fun noteDropsAfterDeletionRefuseStaleOrMultipleMovesWithoutWriting() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            room.select("alice"); room.pull(server)
            for (index in 0..2) assertTrue(room.store.notes.saveNote("note_00$index", NoteWrite("Note $index", "")) is GymResult.Ok)
            room.sync(server)
            assertNull(room.store.deletions.delete(Deletion.Note("note_001")))
            val before = room.engine.snapshot()
            assertTrue(room.store.notes.reorderNotes("note_002", listOf("note_000", "note_002")) is GymResult.Ok)
            assertEquals(before, room.engine.snapshot())
            val refused = GymResult.Failed(WriteFailure.Refused("The notes changed. Read them again before reordering."))
            for ((moved, order) in listOf(
                "note_001" to listOf("note_000", "note_002"),
                "note_000" to listOf("note_000", "note_000"),
                "note_000" to listOf("note_002"),
                "note_000" to listOf("note_002", "note_missing"),
            )) assertEquals(refused, room.store.notes.reorderNotes(moved, order))
            assertEquals(before, room.engine.snapshot())

            assertTrue(room.store.notes.reorderNotes("note_000", listOf("note_002", "note_000")) is GymResult.Ok)
            assertEquals(listOf("note_002", "note_000"), room.store.notes.all.map { it.id })
            assertEquals(listOf("note_002", "note_000"), room.training.notes().map { it.id })
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(listOf("note_002", "note_000"), room.store.notes.all.map { it.id })

            val moved = room.engine.snapshot()
            assertEquals(refused, room.store.notes.reorderNotes("note_000", listOf("note_000", "note_002", "note_001")))
            assertEquals(moved, room.engine.snapshot())
            room.training.writeNote("note_003", NoteWrite("New arrival", ""))
            val arrived = room.engine.snapshot()
            assertEquals(refused, room.store.notes.reorderNotes("note_000", listOf("note_000", "note_001", "note_002")))
            assertEquals(arrived, room.engine.snapshot())
        }
    }

    @Test
    fun testAccountNotesStayWithTheirOwnerAndSignedOutReadsNeverPush() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            room.select("alice"); room.pull(server)
            assertTrue(room.store.notes.saveNote("note_1", NoteWrite("Tone", "blunt")) is GymResult.Ok)
            room.sync(server)
            val notes = room.store.notes.readNotes()
            room.select(null)

            assertEquals(GymResult.Ok(emptyList<Note>()), room.store.notes.readNotes())
            assertEquals(emptyList<Note>(), room.store.notes.all)
            assertNull(room.engine.nextPush())
            assertTrue(room.store.notes.saveNote("note_1", NoteWrite("Device", "local")) is GymResult.Ok)
            assertTrue(room.store.notes.saveNote("note_2", NoteWrite("Second", "local")) is GymResult.Ok)
            assertTrue(room.store.notes.saveNote("note_1", NoteWrite("Device", "edited")) is GymResult.Ok)
            assertTrue(room.store.notes.reorderNotes("note_2", listOf("note_2", "note_1")) is GymResult.Ok)
            assertEquals(listOf("note_2", "note_1"), room.store.notes.all.map { it.id })
            assertNull("signed-out edits do not produce an account request", room.engine.nextPush())
            assertNull(room.store.notes.deleteNote("note_1"))
            assertNull(room.store.notes.deleteNote("note_2"))
            assertEquals(GymResult.Ok(emptyList<Note>()), room.store.notes.readNotes())
            assertNull("signed-out deletes do not produce an account request", room.engine.nextPush())
            room.select("bob"); room.pull(server)
            assertEquals(GymResult.Ok(emptyList<Note>()), room.store.notes.readNotes())
            room.select("alice")
            assertEquals(notes, room.store.notes.readNotes())
            runCurrent()
        }
    }

    @Test
    fun testNoteBoundsAndStaleOrderRefusalsReachTheScreen() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            repeat(10) { room.store.notes.saveNote("note_$it", NoteWrite("note $it", "")) }

            assertEquals(GymResult.Failed(WriteFailure.Refused("The log has reached its limit. Remove an entry first.")),
                room.store.notes.saveNote("note_more", NoteWrite("eleven", "")))
            assertEquals(GymResult.Failed(WriteFailure.Refused("a note runs to 500 bytes")),
                room.store.notes.saveNote("note_0", NoteWrite("note 0", "x".repeat(501))))
            assertEquals(GymResult.Failed(WriteFailure.Refused("a title runs to 60 characters")),
                room.store.notes.saveNote("note_0", NoteWrite("t".repeat(61), "")))
            // A stale drop is refused before anything is written.
            assertEquals(GymResult.Failed(WriteFailure.Refused("The notes changed. Read them again before reordering.")),
                room.store.notes.reorderNotes("note_gone", listOf("note_gone")))
            runCurrent()
        }
    }
}
