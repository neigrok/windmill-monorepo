package works.windmill.gym.coach.turn

import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.sync.core.Json

// The words Coach's model reads land in the assets under gym-coach/ as the contract's own files.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachWordsAssetsTests {
    @Test fun theWordsLandInTheAssetsAsTheContractsOwnFiles() {
        val assets = ApplicationProvider.getApplicationContext<android.content.Context>().assets
        val contract = File(System.getProperty("windmill.contract"), "gym/coach")
        for (file in listOf("prompt.md", "first-content.json", "refusals.json"))
            assertArrayEquals(file, contract.resolve(file).readBytes(), assets.open("gym-coach/$file").use { it.readBytes() })

        val firstContent = assets.open("gym-coach/first-content.json").use { Json.parse(it.readBytes()) }
        assertEquals("Please help me with this photo.", firstContent.member("pictureOnlyQuestion").str())
        assertEquals(setOf("list_sessions", "list_notes", "list_exercises", "list_routines", "get_session"),
            firstContent.member("contextLeads").obj().keys)
        val refusals = assets.open("gym-coach/refusals.json").use { Json.parse(it.readBytes()) }
        assertEquals(setOf("not-offered", "seat-required", "one-proposal", "one-note", "coach-turn-volume", "stopped"), refusals.obj().keys)
    }
}
