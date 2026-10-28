package works.windmill.gym.store

import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.WorkoutChange
import works.windmill.gym.domain.WorkoutKey
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
            assertEquals(WorkoutChange.Saved, phone.store.editRack(92.5, 7))
            val key = phone.store.notification.value!!.key
            val rack = phone.store.rack
            val offer = phone.store.notification.value!!.offer
            assertEquals(WorkoutChange.Saved, phone.store.showWorkout(key, true))
            val hiddenNotificationOffer = phone.store.notification.value!!.offer
            assertFalse(phone.store.loggerHidden)
            assertEquals(WorkoutChange.Saved, phone.store.setLoggerHidden(key, true))
            assertTrue(phone.store.loggerHidden)
            assertTrue(phone.store.notification.value!!.hidden)
            assertEquals(hiddenNotificationOffer, phone.store.notification.value!!.offer)
            assertEquals(rack?.copy(revision = phone.store.rack!!.revision), phone.store.rack)
            val restored = phone.freshStore()
            restored.connect(phone.account())
            assertTrue(restored.loggerHidden)
            assertTrue(restored.notification.value!!.hidden)
            assertEquals(phone.store.rack!!.copy(revision = restored.rack!!.revision), restored.rack)
            assertTrue(restored.rack!!.revision > phone.store.rack!!.revision)
            assertEquals(WorkoutChange.Saved, restored.showWorkout(key, false))
            assertTrue(restored.loggerHidden)
            assertFalse(restored.notification.value!!.hidden)
            assertEquals(WorkoutChange.Saved, restored.setLoggerHidden(key, false))
            assertFalse(restored.loggerHidden)
            assertEquals(92.5, restored.rack!!.weightKg, 0.0)
            assertEquals(7, restored.rack!!.reps)
            assertEquals(offer!!.exerciseId, restored.notification.value!!.offer!!.exerciseId)
            assertEquals(WorkoutChange.Stale, restored.setLoggerHidden(key.copy(ownerKey = "other"), true))
            assertEquals(WorkoutChange.Stale, restored.showWorkout(key.copy(sessionId = "old"), true))
        }
    }

    @Test fun visibilityWritesRefuseAChangedReplicaAndAnUnrestoredOwner() = runTest {
        var allowed = true
        EngineRoomFixture(tmp.newFolder(), this, workoutAuthority = { allowed }).use { phone ->
            phone.select("u1"); phone.pull(EngineRoomFixture.server()); phone.workout(finish = false)
            val key = phone.store.notification.value!!.key
            val before = phone.controlsFile.readText()
            allowed = false
            assertTrue(phone.store.setLoggerHidden(key, true) is WorkoutChange.Unavailable)
            assertTrue(phone.store.showWorkout(key, true) is WorkoutChange.Unavailable)
            allowed = true
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            assertTrue(phone.store.setLoggerHidden(key, true) is WorkoutChange.Unavailable)
            assertTrue(phone.store.showWorkout(key, true) is WorkoutChange.Unavailable)
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
                val key = phone.store.notification.value!!.key
                if (notification) assertEquals(WorkoutChange.Saved, phone.store.showWorkout(key, true))
                val before = phone.controlsFile.readText()
                broken = true
                val result = if (notification) phone.store.showWorkout(key, false) else phone.store.setLoggerHidden(key, true)
                assertTrue(result is WorkoutChange.Unavailable)
                assertFalse(phone.store.loggerHidden)
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
            val key = phone.store.notification.value!!.key
            phone.engine.failNextCommit()
            assertEquals(WorkoutChange.Saved, phone.store.setLoggerHidden(key, true))
            assertTrue(phone.store.loggerHidden)
            val restored = phone.freshStore()
            restored.connect(phone.account())
            assertTrue("A locally accepted Hide must remain hidden after restart", restored.loggerHidden)
            assertEquals(listOf("gym.workout_controls"), failures)
            assertEquals("The workout could not be saved safely. Restart the app to recover it.", restored.workoutFailure)
        }
    }

}
