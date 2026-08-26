package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

// The claim's last slot: the weigh-ins go out only once every session has landed.
class BodyweightClaimTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun shelf() = LocalLog(File(tmp.root, "local-${System.nanoTime()}.json"))
    private fun settings() = LocalPreferences(File(tmp.root, "prefs-${System.nanoTime()}.json"))
    private fun queue() = SetQueue(File(tmp.root, "queue-${System.nanoTime()}.json"))
    private fun weights() = LocalBodyweight(File(tmp.root, "bodyweight-${System.nanoTime()}.json"))

    private fun aSet(id: String, at: Long) = TrainingSet(
        id = id, exerciseId = "bench-press", weightKg = 82.5, reps = 5, completedAtMs = at)

    @Test
    fun testTheWeighInsClaimLastAfterEverySessionLanded() = runTest {
        val server = FakeTraining()
        val localLog = shelf()
        val weights = weights()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000), listOf(aSet("set_a", at = 1_100))))
        weights.record(WeighIn("2026-08-25", 82.4, recordedAt = 5_000))
        weights.record(WeighIn("2026-08-26", 82.0, recordedAt = 6_000))
        weights.delete("2026-08-20")

        val outcome = ClaimReplay(server, localLog, queue(), settings(), weights).run()

        assertEquals(listOf("start", "append", "finish", "putBodyweight", "putBodyweight", "deleteBodyweight"),
            server.calls)
        assertEquals(listOf("2026-08-25", "2026-08-26"), server.weighIns.keys.sorted())
        assertTrue("nothing is owed once the log holds every row", weights.owed.isEmpty() && weights.deletions.isEmpty())
        assertTrue(outcome.liveLanded)
        assertFalse(outcome.retryable)
        assertTrue(outcome.said.isEmpty())
    }

    @Test
    fun testAStaleReplayKeepsTheLogsNewerRowOnThisPhoneToo() = runTest {
        val server = FakeTraining()
        server.weighIns["2026-08-25"] = WeighIn("2026-08-25", 83.0, recordedAt = 9_000)
        val weights = weights()
        weights.record(WeighIn("2026-08-25", 82.4, recordedAt = 5_000))

        ClaimReplay(server, shelf(), queue(), settings(), weights).run()

        assertEquals("the server's newer correction stands", 83.0, server.weighIns.getValue("2026-08-25").weightKg, 0.0)
        assertEquals(83.0, weights.entries.single().weightKg, 0.0)
        assertTrue(weights.owed.isEmpty())
    }

    @Test
    fun testALogThatWentQuietLeavesTheWeighInOwedAndTheClaimRetryable() = runTest {
        val server = FakeTraining()
        server.refuseBodyweight = IOException("offline")
        val weights = weights()
        weights.record(WeighIn("2026-08-25", 82.4, recordedAt = 5_000))

        val outcome = ClaimReplay(server, shelf(), queue(), settings(), weights).run()

        assertTrue(outcome.retryable)
        assertEquals(listOf("2026-08-25"), weights.owed.map { it.dateLocal })
        assertTrue("nothing was lost, so nothing is said", outcome.said.isEmpty())
    }

    @Test
    fun testARefusalWithAReasonIsSaidAndTheRowLetGo() = runTest {
        val server = FakeTraining()
        server.refuseBodyweight = WindmillApiException.Refused(400,
            Refusal(message = "Between 20 and 400 kg — check the number.", code = null))
        val weights = weights()
        weights.record(WeighIn("2026-08-25", 82.4, recordedAt = 5_000))

        val outcome = ClaimReplay(server, shelf(), queue(), settings(), weights).run()

        assertFalse(outcome.retryable)
        assertEquals(listOf("weigh-in · 25 Aug" to "Between 20 and 400 kg — check the number."),
            outcome.said.map { (it as RefusedClaim).name to it.reason })
        assertTrue("let go, so no later connect re-sends the same terminal write", weights.owed.isEmpty())
        assertTrue(weights.entries.isEmpty())
    }

    @Test
    fun testNothingGoesOutWhileAShelfSessionIsStillWaitingOnTheLog() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_elsewhere", startedAtMs = 500))
        val localLog = shelf()
        localLog.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000), listOf(aSet("set_a", at = 1_100))))
        val weights = weights()
        weights.record(WeighIn("2026-08-25", 82.4, recordedAt = 5_000))

        ClaimReplay(server, localLog, queue(), settings(), weights).run()

        assertFalse("putBodyweight" in server.calls)
        assertEquals(listOf("2026-08-25"), weights.owed.map { it.dateLocal })
    }
}
