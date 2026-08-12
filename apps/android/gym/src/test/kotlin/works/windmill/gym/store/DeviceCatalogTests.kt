package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Exercise

// The movement names, held on the device so a cold launch never draws the slug where the name
// belongs — for the seat they were read for, because a rename is a per-account override — and
// written only when they actually changed, because a name nobody edited is not news.
class DeviceCatalogTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private val names = listOf(
        Exercise(id = "bench-press", name = "Bench Press"),
        Exercise(id = "back-squat", name = "Back Squat"))

    @Test
    fun testTheNamesSurviveARelaunchFromDisk() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        DeviceCatalog(file).hold("alice", names)

        assertEquals(names, DeviceCatalog(file).movements("alice"))
    }

    // The anonymous seat is a seat, and its own names are not the next account's to read.
    @Test
    fun testACopyBelongsToTheSeatItWasReadForAndToNoOther() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        DeviceCatalog(file).hold(null, names)

        val reopened = DeviceCatalog(file)
        assertEquals(names, reopened.movements(null))
        assertEquals("a private name may not cross a seat", emptyList<Exercise>(), reopened.movements("alice"))
    }

    @Test
    fun testAnUnreadableCatalogOpensEmptyRatherThanCrashing() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        file.writeText("not json at all")

        assertEquals("the names are a convenience and the ids are the truth",
            emptyList<Exercise>(), DeviceCatalog(file).movements(null))
    }

    @Test
    fun testACatalogNobodyEditedIsNotRewritten() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        val catalog = DeviceCatalog(file)
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
