package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Exercise

class DeviceCopyTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private val names = listOf(
        Exercise(id = "bench-press", name = "Bench Press"),
        Exercise(id = "back-squat", name = "Back Squat"))

    @Test
    fun testTheNamesSurviveARelaunchFromDisk() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        DeviceCopy(file).hold("alice", names)

        assertEquals(names, DeviceCopy(file).movements("alice"))
    }

    @Test
    fun testACopyBelongsToTheSeatItWasReadForAndToNoOther() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        DeviceCopy(file).hold(null, names)

        val reopened = DeviceCopy(file)
        assertEquals(names, reopened.movements(null))
        assertEquals("a private name may not cross a seat", emptyList<Exercise>(), reopened.movements("alice"))
    }

    @Test
    fun testAnUnreadableCatalogOpensEmptyRatherThanCrashing() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        file.writeText("not json at all")

        assertEquals("the names are a convenience and the ids are the truth",
            emptyList<Exercise>(), DeviceCopy(file).movements(null))
    }

    @Test
    fun testACatalogNobodyEditedIsNotRewritten() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        val catalog = DeviceCopy(file)
        catalog.hold("alice", names)
        assertTrue(file.exists())

        file.delete()
        catalog.hold("alice", names)
        assertFalse("a name nobody edited is not news", file.exists())

        catalog.hold("alice", names + Exercise(id = "deadlift", name = "Deadlift"))
        assertTrue("a changed catalog is", file.exists())

        file.delete()
        catalog.hold("bob", names + Exercise(id = "deadlift", name = "Deadlift"))
        assertTrue("the same names under a new seat are news — the last seat's copy goes", file.exists())
    }
}
