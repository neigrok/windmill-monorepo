package works.windmill.platform

import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SignInAttemptsTests {
    private fun restore(attempts: SignInAttempts): SignInAttempts {
        val saved = with(SignInAttempts.Saver) { with(SaverScope { true }) { save(attempts) } }!!
        return SignInAttempts.Saver.restore(saved)!!
    }

    @Test
    fun activeAttemptAndCompletionSurviveRecreationAndAreConsumedOnce() {
        val attempts = SignInAttempts().apply { begin("share-request") }
        val recreated = restore(attempts)
        assertEquals("share-request", recreated.active)
        assertNull(recreated.result)
        recreated.complete("user-a")
        recreated.complete("user-b")
        val completed = restore(recreated)
        assertNull(completed.active)
        assertEquals(SignInResult("share-request", "user-a"), completed.result)
        completed.consume("other-request")
        assertEquals(SignInResult("share-request", "user-a"), completed.result)
        completed.consume("share-request")
        assertNull(restore(completed).result)
    }

    @Test
    fun cancellationIsBoundToOneAttemptAndANewAttemptReplacesTheOldResult() {
        val attempts = SignInAttempts().apply { begin("cancelled-share"); cancel() }
        assertEquals(SignInResult("cancelled-share", null), restore(attempts).result)
        attempts.begin("new-explicit-request")
        assertNull(attempts.result)
        assertEquals("new-explicit-request", attempts.active)
        attempts.complete("user-a")
        assertEquals(SignInResult("new-explicit-request", "user-a"), attempts.result)
    }
    @Test
    fun ordinarySignInCancellationInvalidatesACompletedResultWithNoActiveAttempt() {
        val attempts = SignInAttempts().apply { begin("share-request"); complete("user-a") }
        assertNull(attempts.active)
        attempts.cancel()
        attempts.complete("user-b")
        assertEquals(SignInResult("share-request", null), restore(attempts).result)
    }

}
