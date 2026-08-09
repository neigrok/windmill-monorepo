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
// belongs — and written only when they actually changed, because a name nobody edited is not news.
class DeviceCatalogTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private val names = listOf(
        Exercise(id = "bench-press", name = "Bench Press"),
        Exercise(id = "back-squat", name = "Back Squat"))

    @Test
    fun testTheNamesSurviveARelaunchFromDisk() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        DeviceCatalog(file).hold(names)

        assertEquals(names, DeviceCatalog(file).movements)
    }

    @Test
    fun testAnUnreadableCatalogOpensEmptyRatherThanCrashing() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        file.writeText("not json at all")

        assertEquals("the names are a convenience and the ids are the truth",
            emptyList<Exercise>(), DeviceCatalog(file).movements)
    }

    @Test
    fun testACatalogNobodyEditedIsNotRewritten() {
        val file = File(tmp.root, "catalog-${System.nanoTime()}.json")
        val catalog = DeviceCatalog(file)
        catalog.hold(names)
        assertTrue(file.exists())

        file.delete()
        catalog.hold(names)
        assertFalse("a name nobody edited is not news", file.exists())

        catalog.hold(names + Exercise(id = "deadlift", name = "Deadlift"))
        assertTrue("a changed catalog is", file.exists())
    }
}
