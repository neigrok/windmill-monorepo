package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.store.RefusedClaim
import works.windmill.gym.store.RefusedSet

// The banner's words, held still. One function feeds the logger's banner and the Routines home's,
// so the copy cannot fork between the two screens — and the claim-level line is the cross-platform
// pin: a lost document is said by NAME, "…couldn't be claimed", with the server's sentence under it.
class RefusalBannerTests {
    @Test
    fun testALostSetAndALostClaimSpeakInTheBannersOneVoice() {
        val catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))

        assertEquals("Bench Press 82.5 × 5 never reached the log",
            refusalHeadline(RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5,
                reps = 5, reason = "the session closed before this set reached it"), catalog))

        assertEquals("“Push Day” couldn’t be claimed",
            refusalHeadline(RefusedClaim(name = "Push Day", reason = "that document is unclaimable"), catalog))
    }
}
