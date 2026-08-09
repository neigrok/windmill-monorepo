package works.windmill.gym.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.RoutineEntryWrite
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TopSet
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.Verdict
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.MagicLink
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.UserResponse
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

// The wire, proven against the REAL backend rather than a fake — every decode in this file is a
// row the local windmill_server actually wrote. Env-gated the way the backend's WM_PG_TEST suite
// is: without WM_ANDROID_WIRE_TEST in the environment every test here is assumed away silently,
// so CI (which runs no local stack) never sees a failure it cannot act on. To run:
//
//   WM_ANDROID_WIRE_TEST=1 \
//   WM_WIRE_BEARER=<probe session secret> \
//   WM_WIRE_LINK_TOKEN=<unused magic-link token, optional> \
//   ./gradlew :gym:testDebugUnitTest --tests '*LiveWireTests*' --rerun
//
// against a windmill_server on http://localhost:8088 (WM_WIRE_BASE overrides) holding a probe
// account. Ids are probe-prefixed and unique per run; the suite discards its sessions and deletes
// its routine at the end, so a clean run leaves the account as it found it. The tests are ordered
// (NAME_ASCENDING) because they walk one workout through its life; the magic-link verify runs LAST
// because its token is single-use — a rerun on a spent token is assumed away as 410, not failed.
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class LiveWireTests {
    companion object {
        private val bearer: String? = System.getenv("WM_WIRE_BEARER")
        private val base = (System.getenv("WM_WIRE_BASE") ?: "http://localhost:8088").toHttpUrl()
        private val api by lazy { WindmillApi(base, { bearer }) }
        private val wire by lazy { GymHttp(api) }

        private val tag = "%08x".format(java.security.SecureRandom().nextInt())
        private val routineId = "rt_probe_a$tag"
        private val sessionAId = "ses_probe_a${tag}1"
        private val sessionBId = "ses_probe_a${tag}2"
        private val warmupId = "set_probe_a${tag}w"
        private val workingId = "set_probe_a${tag}g"
        private val squatId = "set_probe_a${tag}q"

        // One workout's instants, fixed at class load so every assertion downstream is exact.
        private val startA = System.currentTimeMillis() - 3_600_000
        private val finishA = startA + 180_000
        private val startB = startA + 1_800_000
        private val finishB = startB + 120_000

        private var openedA: works.windmill.gym.domain.Session? = null
        private var storedWorking: TrainingSet? = null
    }

    @Before
    fun gate() {
        assumeTrue(
            "WM_ANDROID_WIRE_TEST not set — live wire suite skipped (the WM_PG_TEST pattern)",
            System.getenv("WM_ANDROID_WIRE_TEST") != null,
        )
        assumeTrue("WM_WIRE_BEARER not set — no probe session to speak as", bearer != null)
    }

    @Test
    fun t01_theCatalogDecodesAllSixtyFourSeeds() = runBlocking {
        val catalog = wire.exercises()
        assertEquals(64, catalog.count { !it.custom })
        assertEquals(
            Exercise("farmers-carry", "Farmers Carry", "carry", "dumbbell", 2.0, false),
            catalog.first { it.id == "farmers-carry" },
        )
        assertEquals("every seed decodes to a distinct id", 64, catalog.filter { !it.custom }.map { it.id }.distinct().size)
        assertTrue(catalog.all { it.name.isNotEmpty() && it.pattern.isNotEmpty() && it.equipment.isNotEmpty() })
    }

    @Test
    fun t02_aRoutineRoundTripsAndAbsentTargetRepsStaysAbsent() = runBlocking {
        val write = RoutineWrite(routineId, "Probe Day A", 0, listOf(
            RoutineEntryWrite("bench-press", 3),
            RoutineEntryWrite("back-squat", 2, 5, 100.0, 120),
        ))
        val created = wire.createRoutine(write)
        assertEquals(routineId, created.id)
        assertEquals("Probe Day A", created.name)
        assertEquals(listOf(1, 2), created.entries.map { it.position })
        assertNull("absent targetReps means max and must come back absent", created.entries[0].targetReps)
        assertNull(created.entries[0].targetWeightKg)
        assertEquals(5, created.entries[1].targetReps)
        assertEquals(100.0, created.entries[1].targetWeightKg!!, 0.0)
        assertEquals(120, created.entries[1].restSeconds)

        assertEquals(created, wire.routine(routineId))

        // The read-modify-write: the whole document goes back, and the absence must SURVIVE it —
        // a round trip that turned "max" into a number would be rewriting the program.
        val replaced = wire.replaceRoutine(routineId, RoutineWrite(created))
        assertEquals(created, replaced)

        assertTrue(wire.routines().any { it.id == routineId })
        assertNull("an absent routine folds to null, never throws", wire.routine("rt_probe_a_gone404"))
    }

    @Test
    fun t03_aStartFreezesThePlanAndSetsComeBackNumbered() = runBlocking {
        val opened = wire.startSession(SessionStart(sessionAId, startA, routineId))
        openedA = opened
        // A start JOINS any open session — on a probe account this run owns, the id is our own.
        assertEquals(sessionAId, opened.id)
        assertEquals(startA, opened.startedAtMs)
        assertTrue(opened.isOpen)
        assertEquals(routineId, opened.routineId)
        val plan = opened.plan
        assertNotNull("a routine start answers with the frozen plan", plan)
        assertEquals("Probe Day A", plan!!.routine)
        assertEquals(PlanEntry("bench-press", 3, null, null, null), plan.entry("bench-press"))
        assertEquals(PlanEntry("back-squat", 2, 5, 100.0, 120), plan.entry("back-squat"))

        val warmup = wire.appendSet(sessionAId,
            SetWrite(warmupId, "bench-press", 40.0, 8, SetKind.Warmup, startA + 60_000))
        assertEquals(
            TrainingSet(warmupId, "bench-press", 1, 40.0, 8, SetKind.Warmup, null, "", startA + 60_000),
            warmup,
        )
        val working = wire.appendSet(sessionAId,
            SetWrite(workingId, "bench-press", 82.5, 5, SetKind.Working, startA + 120_000))
        assertEquals(
            TrainingSet(workingId, "bench-press", 2, 82.5, 5, SetKind.Working, null, "", startA + 120_000),
            working,
        )
        storedWorking = working
    }

    @Test
    fun t04_aReplayOfTheSameSetIdAnswersTheStoredRowByteForSame() = runBlocking {
        val write = SetWrite(workingId, "bench-press", 82.5, 5, SetKind.Working, startA + 120_000)
        val replayed = wire.appendSet(sessionAId, write)
        assertEquals(storedWorking, replayed)
        // And below the DTO: the raw reply object of two replays is key-for-key identical.
        val rawOnce = api.send<JsonObject>("POST", "/v1/gym/sessions/$sessionAId/sets", write)
        val rawTwice = api.send<JsonObject>("POST", "/v1/gym/sessions/$sessionAId/sets", write)
        assertEquals(rawOnce, rawTwice)
    }

    @Test
    fun t05_finishClosesReviewReadsAndAFreshSetIsDropped() = runBlocking {
        val closed = wire.finishSession(sessionAId, finishA)
        assertEquals(sessionAId, closed.id)
        assertEquals(finishA, closed.finishedAtMs)
        assertTrue(!closed.isOpen)

        // The replay converges even now — the stored row, 200, after the finish.
        val replayed = wire.appendSet(sessionAId,
            SetWrite(workingId, "bench-press", 82.5, 5, SetKind.Working, startA + 120_000))
        assertEquals(storedWorking, replayed)

        // A FRESH set has nowhere to land: 409 session-finished, and the queue's verdict is
        // Dropped — never Retry, never Remint.
        try {
            wire.appendSet(sessionAId,
                SetWrite("set_probe_a${tag}x", "bench-press", 85.0, 3, SetKind.Working, finishA + 1_000))
            fail("a fresh set into a finished session must refuse")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(409, refused.status)
            assertEquals("session-finished", refused.refusal.code)
            assertEquals(
                Verdict.Dropped("the session closed before this set reached it"),
                Verdict.refusing(RefusalFacts(refused)),
            )
        }

        val review = wire.review(sessionAId)
        assertEquals(finishA - startA, review.stats.durationMs)
        assertEquals(1, review.stats.workingSets)
        assertNotNull(review.stats.topE1rm)
        if (review.slight) {
            assertNull("slight means record is omitted", review.record)
            assertNull("slight means against is omitted", review.against)
        }
    }

    @Test
    fun t06_lastTimeAnswersHistoryOrTheBareMovement() = runBlocking {
        // The id crosses as %2D-escaped (GymHttp escapes everything but alphanumerics) and the
        // server still resolves it — the percent-encoding round trip is the point of this read.
        val trained = wire.lastTime("bench-press")
        assertEquals("bench-press", trained.exerciseId)
        assertTrue(!trained.isFirstTime)
        assertEquals(sessionAId, trained.session!!.id)
        assertEquals("Probe Day A", trained.routine)
        assertEquals(listOf(storedWorking), trained.sets)

        val untouched = wire.lastTime("suitcase-carry")
        assertEquals("suitcase-carry", untouched.exerciseId)
        assertTrue("no history means session and sets are omitted TOGETHER", untouched.isFirstTime)
        assertNull(untouched.session)
        assertNull(untouched.routine)
        assertEquals(emptyList<TrainingSet>(), untouched.sets)

        try {
            wire.lastTime("probe-not-a-movement")
            fail("an unknown movement is a 400, never folded to null")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(400, refused.status)
            assertEquals("unknown-exercise", refused.refusal.code)
        }
    }

    @Test
    fun t07_theLadderSpeaksOverTheRealWire() = runBlocking {
        val opened = wire.startSession(SessionStart(sessionBId, startB))
        assertEquals(sessionBId, opened.id)
        assertNull("an ad-hoc start carries no routine", opened.routineId)
        assertNull(opened.plan)

        // 409 set-id-taken — the working set's id already names a row in session A → Remint.
        try {
            wire.appendSet(sessionBId,
                SetWrite(workingId, "back-squat", 100.0, 5, SetKind.Working, startB + 30_000))
            fail("an id spent in another session must refuse")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(409, refused.status)
            assertEquals("set-id-taken", refused.refusal.code)
            assertEquals(Verdict.Remint("that set id is already used"), Verdict.refusing(RefusalFacts(refused)))
        }

        // 400 unknown-exercise → Refused, in the app's canonical sentence.
        try {
            wire.appendSet(sessionBId,
                SetWrite("set_probe_a${tag}z", "probe-not-a-movement", 60.0, 5, SetKind.Working, startB + 40_000))
            fail("a movement outside the catalog must refuse")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(400, refused.status)
            assertEquals("unknown-exercise", refused.refusal.code)
            assertEquals(
                Verdict.Refused("that movement is not in the catalog"),
                Verdict.refusing(RefusalFacts(refused)),
            )
        }

        // 401 → Retry: the set is only waiting for a sign-in, never dropped.
        try {
            GymHttp(WindmillApi(base, { null })).appendSet(sessionBId,
                SetWrite("set_probe_a${tag}u", "back-squat", 100.0, 5, SetKind.Working, startB + 50_000))
            fail("no bearer must refuse 401")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(401, refused.status)
            assertTrue(refused.isUnauthorized)
            assertEquals("sign in to open your training log", refused.refusal.message)
            assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(refused)))
        }

        // A dead port → Offline → Retry, and the line a person sees names the host, not a code.
        try {
            GymHttp(WindmillApi("http://127.0.0.1:9".toHttpUrl(), { bearer })).exercises()
            fail("a dead port must be offline")
        } catch (offline: WindmillApiException.Offline) {
            assertEquals("Can't reach windmill.works", offline.line)
            assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(offline)))
        }

        wire.appendSet(sessionBId, SetWrite(squatId, "back-squat", 100.0, 5, SetKind.Working, startB + 60_000))
        wire.finishSession(sessionBId, finishB)
        Unit
    }

    @Test
    fun t08_theLogPagesOnBothHalvesOfTheCursor() = runBlocking {
        val pageOne = wire.sessions(limit = 1, before = null, beforeId = null)
        assertEquals(1, pageOne.size)
        val newest = pageOne[0]
        assertEquals(sessionBId, newest.id)
        assertEquals(startB, newest.startedAtMs)
        assertEquals(finishB, newest.finishedAtMs)
        assertNull(newest.routineId)
        assertNull(newest.plan)
        assertEquals(1, newest.setCount)
        assertEquals(listOf("Back Squat"), newest.exercises)
        assertEquals(TopSet(100.0, 5), newest.topSet)
        assertEquals(false, newest.closedItself)

        // The cursor is the last row's BOTH halves — and beforeId crosses percent-escaped.
        val pageTwo = wire.sessions(limit = 1, before = newest.startedAtMs, beforeId = newest.id)
        assertEquals(1, pageTwo.size)
        val older = pageTwo[0]
        assertEquals(sessionAId, older.id)
        assertEquals(2, older.setCount)
        assertEquals(listOf("Bench Press"), older.exercises)
        assertEquals(TopSet(82.5, 5), older.topSet)
        assertEquals("Probe Day A", older.plan!!.routine)

        val detail = wire.session(sessionAId)
        assertNotNull(detail)
        assertEquals(sessionAId, detail!!.session.id)
        assertEquals(finishA, detail.session.finishedAtMs)
        assertEquals(listOf(warmupId, workingId), detail.sets.map { it.id })
        assertNull("an absent session folds to null", wire.session("ses_probe_a_gone404"))
    }

    @Test
    fun t09_statisticsDecodeWholeWeeksAndStandingBests() = runBlocking {
        val stats = wire.statistics()
        assertTrue(stats.weeks.isNotEmpty())
        assertTrue("weeks are contiguous — a silent week is present and zero",
            stats.weeks.map { it.startedAtMs }.zipWithNext().all { (a, b) -> b - a == 604_800_000L })
        assertEquals(2, stats.weeks.sumOf { it.sessions })
        assertEquals(2, stats.weeks.sumOf { it.workingSets })

        val bench = stats.movements.first { it.exerciseId == "bench-press" }
        assertEquals(startA, bench.lastTrainedAtMs)
        assertEquals(1, bench.points.size)
        assertEquals(startA, bench.points[0].atMs)
        assertEquals(82.5, bench.points[0].weightKg, 0.0)
        assertEquals(5, bench.points[0].reps)
        assertNotNull("a barbell lift has an honest e1rm", bench.points[0].e1rm)
        assertEquals(82.5, bench.bestE1rm!!.weightKg, 0.0)
        assertEquals(82.5, bench.heaviest!!.weightKg, 0.0)
    }

    @Test
    fun t10_aShareIsMintedOnceAndRevokedIsGone() = runBlocking {
        val minted = wire.share(sessionBId)
        assertTrue(minted.token.isNotEmpty())
        assertTrue(minted.expiresAtMs > System.currentTimeMillis())
        assertNotNull("the server composes the url; the client only renders it", minted.url)
        assertTrue(minted.url!!.endsWith("/#/gym/shared/${minted.token}"))

        assertEquals("share is idempotent on the session", minted, wire.share(sessionBId))

        wire.revokeShare(sessionBId)
        try {
            wire.revokeShare(sessionBId)
            fail("nothing to revoke answers 404, and the client does not fold it")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(404, refused.status)
        }
    }

    @Test
    fun t11_theProbeRowsAreCleanedUp() = runBlocking {
        wire.discardSession(sessionAId)
        wire.discardSession(sessionBId)
        wire.deleteRoutine(routineId)
        assertNull(wire.session(sessionAId))
        assertNull(wire.session(sessionBId))
        assertNull(wire.routine(routineId))
        assertTrue(wire.sessions(50, null, null).none { it.id == sessionAId || it.id == sessionBId })
    }

    // LAST on purpose: the link token works once. A rerun meets the one canonical answer for
    // spent/expired/unknown — 410 `expired` — and is assumed away with the reason, never failed.
    @Test
    fun t99_aMagicLinkUrlSignsInAndTheCookieBecomesTheBearer() = runBlocking {
        val token = System.getenv("WM_WIRE_LINK_TOKEN")
        assumeTrue("WM_WIRE_LINK_TOKEN not set — verify leg skipped", token != null)

        // The emailed form: token in the FRAGMENT, where a query parser finds nothing.
        val url = "https://windmill.works/#/auth?token=$token"
        assertEquals(token, MagicLink.token(url))

        val sessions = MemorySessions()
        val auth = AuthStore(base, sessions)
        try {
            auth.completeLink(url)
        } catch (refused: WindmillApiException.Refused) {
            assumeTrue(
                "LINK_TOKEN already spent (410 ${refused.refusal.code}) — single-use; mint a fresh one to run this leg",
                !(refused.status == 410 && refused.refusal.code == "expired"),
            )
            throw refused
        }

        val user = (auth.status as AuthStatus.SignedIn).user
        val captured = sessions.read()
        assertNotNull("the secret arrives ONLY as Set-Cookie wm_session and must be captured", captured)
        assertNull("a completed link clears the waiting state", auth.linkSentTo)

        // The captured cookie is now the bearer: /v1/me answers the same seat.
        val me = WindmillApi(base, { captured }).get<UserResponse>("/v1/me").user
        assertEquals(user, me)
    }
}
