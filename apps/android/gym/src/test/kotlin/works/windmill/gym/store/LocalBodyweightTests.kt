package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.WeighIn

class LocalBodyweightTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun file() = File(tmp.root, "bodyweight-${System.nanoTime()}.json")

    @Test
    fun testOneRowPerDateAndTheNewerRecordedAtWins() {
        val shelf = LocalBodyweight(file())
        shelf.record(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))
        shelf.record(WeighIn("2026-08-26", 82.0, recordedAt = 2_000))

        val corrected = shelf.record(WeighIn("2026-08-25", 82.6, recordedAt = 3_000))
        assertEquals(82.6, corrected.weightKg, 0.0)

        val stale = shelf.record(WeighIn("2026-08-25", 90.0, recordedAt = 500))
        assertEquals("a replayed stale write answers with the row that stands", 82.6, stale.weightKg, 0.0)
        assertEquals(listOf("2026-08-25" to 82.6, "2026-08-26" to 82.0),
            shelf.entries.map { it.dateLocal to it.weightKg })
        assertEquals("both dates are owed until the log answers", listOf("2026-08-25", "2026-08-26"),
            shelf.owed.map { it.dateLocal })
        assertEquals(82.0, shelf.latest!!.weightKg, 0.0)
    }

    @Test
    fun testALandedRowClearsWhatIsOwedUnlessAWriteOvertookTheReply() {
        val shelf = LocalBodyweight(file())
        shelf.record(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))
        shelf.landed(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))
        assertTrue(shelf.owed.isEmpty())

        shelf.record(WeighIn("2026-08-25", 82.5, recordedAt = 2_000))
        // The reply to the FIRST send arrives after the second write.
        shelf.landed(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))
        assertEquals("the newer write stays owed and stays drawn", listOf("2026-08-25"), shelf.owed.map { it.dateLocal })
        assertEquals(82.5, shelf.entries.single().weightKg, 0.0)

        // The server's own correction, newer than anything here, replaces the row.
        shelf.landed(WeighIn("2026-08-25", 83.0, recordedAt = 9_000))
        assertEquals(83.0, shelf.entries.single().weightKg, 0.0)
        assertTrue(shelf.owed.isEmpty())
    }

    @Test
    fun testADeleteLeavesAtOnceAndIsOwedUntilTheLogAnswers() {
        val shelf = LocalBodyweight(file())
        shelf.record(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))
        shelf.delete("2026-08-25")
        assertTrue(shelf.entries.isEmpty())
        assertTrue("a delete lets go of the write it would have overtaken", shelf.owed.isEmpty())
        assertEquals(listOf("2026-08-25"), shelf.deletions)

        shelf.deletionLanded("2026-08-25")
        assertTrue(shelf.deletions.isEmpty())

        // A write after the delete is a new row, and the pending delete would have eaten it.
        shelf.delete("2026-08-26")
        shelf.record(WeighIn("2026-08-26", 81.0, recordedAt = 5_000))
        assertTrue(shelf.deletions.isEmpty())
        assertEquals(listOf("2026-08-26"), shelf.owed.map { it.dateLocal })
    }

    @Test
    fun testTheLogsSeriesReplacesTheCopyExceptWhatThisPhoneStillOwes() {
        val shelf = LocalBodyweight(file(), deviceOwner = "u1")
        shelf.record(WeighIn("2026-08-20", 84.0, recordedAt = 1_000))
        shelf.landed(WeighIn("2026-08-20", 84.0, recordedAt = 1_000))
        shelf.record(WeighIn("2026-08-25", 82.4, recordedAt = 2_000))
        shelf.delete("2026-08-22")

        shelf.readBack(listOf(
            WeighIn("2026-08-22", 83.0, recordedAt = 500),
            WeighIn("2026-08-24", 82.8, recordedAt = 700),
            WeighIn("2026-08-25", 82.0, recordedAt = 100),
        ))

        assertEquals("the 20th went elsewhere, the 22nd is deleted here, the 25th is owed here",
            listOf("2026-08-24" to 82.8, "2026-08-25" to 82.4),
            shelf.entries.map { it.dateLocal to it.weightKg })
    }

    @Test
    fun testTheAnonymousShelfMovesOntoAConfirmedAccountSeatAndEveryRowIsOwed() {
        val file = file()
        val shelf = LocalBodyweight(file)
        shelf.record(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))

        shelf.adopt("u1", confirmed = false)
        assertTrue("an unverified seat draws its own empty room", shelf.entries.isEmpty())

        shelf.adopt("u1", confirmed = true)
        assertEquals(listOf("2026-08-25"), shelf.entries.map { it.dateLocal })
        assertEquals(listOf("2026-08-25"), shelf.owed.map { it.dateLocal })

        shelf.adopt(null)
        assertTrue("moved, never copied", shelf.entries.isEmpty())

        // On disk under the account's key, so the next launch for that seat finds it.
        val reopened = LocalBodyweight(file, deviceOwner = "u1")
        assertEquals(listOf("2026-08-25"), reopened.owed.map { it.dateLocal })
    }

    @Test
    fun testTwoSeatsNeverSeeEachOthersRows() {
        val file = file()
        val first = LocalBodyweight(file, deviceOwner = "u1")
        first.record(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))

        val second = LocalBodyweight(file, deviceOwner = "u2")
        assertTrue(second.entries.isEmpty())
        assertNull(second.latest)
        second.record(WeighIn("2026-08-25", 70.0, recordedAt = 2_000))

        assertEquals(82.4, LocalBodyweight(file, deviceOwner = "u1").latest!!.weightKg, 0.0)
        assertEquals(70.0, LocalBodyweight(file, deviceOwner = "u2").latest!!.weightKg, 0.0)
    }

    @Test
    fun testARefusalThatCannotChangeTakesTheRowOffTheChart() {
        val shelf = LocalBodyweight(file())
        shelf.record(WeighIn("2026-08-25", 82.4, recordedAt = 1_000))
        shelf.letGo("2026-08-25")
        assertTrue(shelf.entries.isEmpty())
        assertTrue(shelf.owed.isEmpty())
    }
}
