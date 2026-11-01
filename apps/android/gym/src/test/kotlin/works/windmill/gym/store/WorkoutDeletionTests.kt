package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.test.runTest
import works.windmill.sync.engine.signOut
import works.windmill.sync.engine.signIn
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.TrainingSet
import works.windmill.platform.storage.AtomicDocument

class WorkoutDeletionTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun exactOwnerEraseReconcilesBeforeAndAfterWriteFailureAndPreservesOtherQueues() {
        for (after in listOf(false, true)) {
            val file = File(tmp.root, "controls-$after")
            var fail = false
            val controls = WorkoutControls(file, "A") { target, text ->
                val failing = fail
                fail = false
                if (failing && !after) throw IOException("before write")
                AtomicDocument.write(target, text)
                if (failing) throw IOException("after write")
            }
            controls.project("replica-a", Session("workout-a", 1000), listOf(TrainingSet("set-a", "squat", weightKg = 20.0, reps = 4, completedAtMs = 2000)))
            controls.adopt("B")
            controls.project("replica-b", Session("workout-b", 3000), emptyList())
            controls.adopt(null)
            controls.project("replica-anon", Session("workout-anon", 4000), emptyList())
            controls.adopt("A")
            val before = diskJson.parseToJsonElement(file.readText()).jsonObject
            val beforeQueues = before.getValue("queues").jsonObject
            fail = true
            if (after) controls.eraseOwner("A", "replica-a")
            else {
                assertThrows(IOException::class.java) { controls.eraseOwner("A", "replica-a") }
                controls.eraseOwner("A", "replica-a")
            }
            val expected = JsonObject(before + ("queues" to JsonObject(beforeQueues - Seat.of("A"))))
            assertEquals(expected, diskJson.parseToJsonElement(file.readText()))
            assertNull(controls.session)
            assertTrue(controls.writable)
            controls.eraseOwner("A", "replica-a")
            assertEquals(expected, diskJson.parseToJsonElement(file.readText()))
            val restored = WorkoutControls(file, "B")
            assertEquals("workout-b", restored.session?.id)
            restored.adopt(null)
            assertEquals("workout-anon", restored.session?.id)
        }
    }

    @Test fun pendingStartupWritesNothingAndDeletedProjectionDoesNotReturnOnGraceRestoration() = runTest {
        val directory = File(tmp.root, "store-projection").also { it.mkdirs() }
        EngineRoomFixture(directory, backgroundScope).use { room ->
            room.select("A")
            room.store.connect(room.account())
            room.startExternalWorkout()
            val original = room.engine.activeReplica()
            assertNotNull(room.store.workout.session)
            val before = room.controlsFile.readText()
            val cold = room.freshStore()
            assertFalse(cold.restoreWorkout("A", false))
            assertEquals(before, room.controlsFile.readText())
            room.engine.signOut("discard")
            room.store.eraseDeletedOwner("A", original)
            assertNull(room.store.workout.session)
            assertNull(room.store.workout.rack)
            assertTrue(room.store.workout.sets.isEmpty())
            assertNull(room.store.workout.notification.value)
            room.engine.signIn("A", mapOf("gym" to false))
            assertTrue(room.store.restoreWorkout("A", true))
            assertNull(room.store.workout.session)
            assertTrue(room.store.workout.sets.isEmpty())
            val restored = WorkoutControls(room.controlsFile, "A")
            assertNull(restored.session)
            assertTrue(restored.sets.isEmpty())
        }
    }

    @Test fun staleReplicaCannotEraseNewerAccountControls() {
        val file = File(tmp.root, "newer-controls")
        val controls = WorkoutControls(file, "A")
        controls.project("replacement", Session("new-workout", 1000), emptyList())
        val before = file.readText()
        assertThrows(IllegalStateException::class.java) { controls.eraseOwner("A", "original") }
        assertEquals(before, file.readText())
        assertEquals("new-workout", controls.session?.id)
    }
}
