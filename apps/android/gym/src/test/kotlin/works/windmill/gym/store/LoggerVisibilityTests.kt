package works.windmill.gym.store

import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.WorkoutChange
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.signOut

class LoggerVisibilityTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun loggerVisibilityAndNotificationOffRestoreIndependentlyWithTheSameRack() = runTest {
        EngineRoomFixture(tmp.newFolder(), this).use { phone ->
            phone.select("u1")
            phone.pull(EngineRoomFixture.server())
            phone.workout(finish = false)
            assertEquals(WorkoutChange.Saved, phone.store.workout.editRack(92.5, 7))
            val key = phone.store.workout.notification.value!!.key
            val rack = phone.store.workout.rack
            val offer = phone.store.workout.notification.value!!.offer
            assertEquals(WorkoutChange.Saved, phone.store.workout.showWorkout(key, true))
            val hiddenNotificationOffer = phone.store.workout.notification.value!!.offer
            assertFalse(phone.store.workout.loggerHidden)
            assertEquals(WorkoutChange.Saved, phone.store.workout.setLoggerHidden(key, true))
            assertTrue(phone.store.workout.loggerHidden)
            assertTrue(phone.store.workout.notification.value!!.hidden)
            assertEquals(hiddenNotificationOffer, phone.store.workout.notification.value!!.offer)
            assertEquals(rack?.copy(revision = phone.store.workout.rack!!.revision), phone.store.workout.rack)
            val restored = phone.freshStore()
            restored.connect(phone.account())
            assertTrue(restored.workout.loggerHidden)
            assertTrue(restored.workout.notification.value!!.hidden)
            assertEquals(phone.store.workout.rack!!.copy(revision = restored.workout.rack!!.revision), restored.workout.rack)
            assertTrue(restored.workout.rack!!.revision > phone.store.workout.rack!!.revision)
            assertEquals(WorkoutChange.Saved, restored.workout.showWorkout(key, false))
            assertTrue(restored.workout.loggerHidden)
            assertFalse(restored.workout.notification.value!!.hidden)
            assertEquals(WorkoutChange.Saved, restored.workout.setLoggerHidden(key, false))
            assertFalse(restored.workout.loggerHidden)
            assertEquals(92.5, restored.workout.rack!!.weightKg, 0.0)
            assertEquals(7, restored.workout.rack!!.reps)
            assertEquals(offer!!.exerciseId, restored.workout.notification.value!!.offer!!.exerciseId)
            assertEquals(WorkoutChange.Stale, restored.workout.setLoggerHidden(key.copy(ownerKey = "other"), true))
            assertEquals(WorkoutChange.Stale, restored.workout.showWorkout(key.copy(sessionId = "old"), true))
        }
    }

    @Test fun visibilityWritesRefuseAChangedReplicaAndAnUnrestoredOwner() = runTest {
        var allowed = true
        EngineRoomFixture(tmp.newFolder(), this, workoutAuthority = { allowed }).use { phone ->
            phone.select("u1"); phone.pull(EngineRoomFixture.server()); phone.workout(finish = false)
            val key = phone.store.workout.notification.value!!.key
            val before = phone.controlsFile.readText()
            allowed = false
            assertTrue(phone.store.workout.setLoggerHidden(key, true) is WorkoutChange.Unavailable)
            assertTrue(phone.store.workout.showWorkout(key, true) is WorkoutChange.Unavailable)
            allowed = true
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            assertTrue(phone.store.workout.setLoggerHidden(key, true) is WorkoutChange.Unavailable)
            assertTrue(phone.store.workout.showWorkout(key, true) is WorkoutChange.Unavailable)
            assertEquals(before, phone.controlsFile.readText())
        }
    }

    @Test fun aLocalVisibilityWriteFailureKeepsTheLoggerAndReportsOnlyItsStaticOperation() = runTest {
        for (notification in listOf(false, true)) {
            var broken = false
            val failures = mutableListOf<Pair<String, Map<String, String>>>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) = Unit
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
            }
            EngineRoomFixture(tmp.newFolder(), this, telemetry = telemetry, controlsWrite = { file, bytes ->
                if (broken) throw IOException("private fixture storage failure")
                AtomicDocument.write(file, bytes)
            }).use { phone ->
                phone.select("u1"); phone.pull(EngineRoomFixture.server()); phone.workout(finish = false)
                val key = phone.store.workout.notification.value!!.key
                if (notification) assertEquals(WorkoutChange.Saved, phone.store.workout.showWorkout(key, true))
                val before = phone.controlsFile.readText()
                broken = true
                val result = if (notification) phone.store.workout.showWorkout(key, false) else phone.store.workout.setLoggerHidden(key, true)
                assertTrue(result is WorkoutChange.Unavailable)
                assertFalse(phone.store.workout.loggerHidden)
                assertEquals(before, phone.controlsFile.readText())
                assertEquals(listOf((if (notification) "gym.showWorkout" else "gym.logger_visibility") to emptyMap<String, String>()), failures)
            }
        }
    }
    @Test fun anAcceptedLoggerHideSurvivesAControlsPublicationFailureAndColdReopen() = runTest {
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), this, telemetry = telemetry).use { phone ->
            phone.select("u1"); phone.pull(EngineRoomFixture.server()); phone.workout(finish = false)
            val key = phone.store.workout.notification.value!!.key
            phone.engine.failNextCommit()
            assertEquals(WorkoutChange.Saved, phone.store.workout.setLoggerHidden(key, true))
            assertTrue(phone.store.workout.loggerHidden)
            val restored = phone.freshStore()
            restored.connect(phone.account())
            assertTrue("A locally accepted Hide must remain hidden after restart", restored.workout.loggerHidden)
            assertEquals(listOf("gym.workout_controls"), failures)
            assertEquals("The workout could not be saved safely. Restart the app to recover it.", restored.workout.workoutFailure)
        }
    }

}
