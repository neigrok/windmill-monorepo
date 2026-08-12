package works.windmill.gym.domain

import java.io.File
import kotlin.math.abs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// The ladder's truth is packages/api-contract/gym-ladder.json, read here straight out of the repo
// working tree — not copied into test resources. A copied fixture is a copy, and copies are the
// thing that package exists to prevent.

class LadderTests {
    @Serializable
    data class Golden(
        val bands: List<GoldenBand>,
        val weightCases: List<WeightCase>,
        val roundCases: List<RoundCase>,
        val repCases: List<RepCase>,
    )

    @Serializable
    data class GoldenBand(val under: Double?, val small: Double, val large: Double)

    @Serializable
    data class WeightCase(
        val weight: Double,
        val labels: List<String>,
        val down: Double,
        val downBig: Double,
        val up: Double,
        val upBig: Double,
    )

    @Serializable
    data class RoundCase(val value: Double, val rounded: Double)

    @Serializable
    data class RepCase(val reps: Int, val down: Int, val up: Int)

    // Every golden value sits on the 0.01 grid and is therefore exact as decimal — but binary
    // doubles are not, so 20.01 − 2 lands a few ulps off −22.01. The tolerance is for the
    // representation, never for the rule.
    private val tolerance = 1e-9

    companion object {
        // Walk up from the test JVM's working directory until the golden turns up, rather than
        // counting directories: a hard-coded depth is a tripwire that fires the day the package
        // moves, and this suite is exactly the thing that must not quietly stop finding its
        // contract when that happens.
        val goldenFile: File = run {
            val relative = "packages/api-contract/gym-ladder.json"
            var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (directory != null) {
                val candidate = File(directory, relative)
                if (candidate.exists()) return@run candidate
                directory = directory.parentFile
            }
            File(relative)
        }

        private val json = Json { ignoreUnknownKeys = true }
    }

    private lateinit var golden: Golden

    @Before
    fun loadGolden() {
        // A golden that cannot be found must fail the suite, never quietly skip it — an unrun
        // contract is drift nobody sees.
        assertTrue(
            "ladder golden not found at ${goldenFile.path} — this suite reads the repo's packages/api-contract/gym-ladder.json, not a bundled copy",
            goldenFile.exists()
        )
        golden = json.decodeFromString(Golden.serializer(), goldenFile.readText())
    }

    // A loop over an empty array is a green test, so every case-driven test below is only as honest
    // as the fixture is full. Emptying it disarms EVERY language at once from a file none of them
    // owns — exactly the move someone makes to turn a red build green.
    @Test
    fun testTheGoldenStillCarriesItsCases() {
        assertEquals("the golden's band table changed shape", 3, golden.bands.size)
        assertTrue("weightCases shrank to ${golden.weightCases.size}", golden.weightCases.size >= 22)
        assertTrue("roundCases shrank to ${golden.roundCases.size}", golden.roundCases.size >= 8)
        assertTrue("repCases shrank to ${golden.repCases.size}", golden.repCases.size >= 4)
        // Both signs must survive. The assisted rows are the only ones that kill a rule read off the
        // SIGNED weight, which makes them the first thing a pruner mistakes for redundant.
        assertTrue("no assisted weights left", golden.weightCases.any { it.weight < 0 })
        assertTrue("no loaded weights left", golden.weightCases.any { it.weight > 0 })
    }

    // A weight is rehydrated from storage on every surface, so it is not always a number a lifter
    // typed. Kotlin cannot fall off the band table the way JS can, but the ANSWER still has to
    // match: anything unorderable reads the top band.
    @Test
    fun testUnorderableWeightReadsTheTopBand() {
        for (value in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            for (lightening in listOf(false, true)) {
                val step = Ladder.steps(abs(value), lightening)
                assertEquals("small step at $value, lightening $lightening", 2.5, step.small, tolerance)
                assertEquals("large step at $value, lightening $lightening", 10.0, step.large, tolerance)
            }
        }
    }

    @Test
    fun testBandTableMatchesTheGolden() {
        assertEquals("the Kotlin band table and the golden's bands are different lengths",
                     golden.bands.size, Ladder.bands.size)
        for ((index, expected) in golden.bands.withIndex()) {
            val band = Ladder.bands[index]
            assertEquals("band $index boundary", expected.under, band.under)
            assertEquals("band $index small step", expected.small, band.small, tolerance)
            assertEquals("band $index large step", expected.large, band.large, tolerance)
        }
    }

    @Test
    fun testEveryWeightCase() {
        for (expected in golden.weightCases) {
            val weight = expected.weight
            assertEquals("labels at $weight kg", expected.labels, Ladder.labels(weight))
            assertEquals("down at $weight kg", expected.down, Ladder.bump(weight, direction = -1, big = false), tolerance)
            assertEquals("down big at $weight kg", expected.downBig, Ladder.bump(weight, direction = -1, big = true), tolerance)
            assertEquals("up at $weight kg", expected.up, Ladder.bump(weight, direction = 1, big = false), tolerance)
            assertEquals("up big at $weight kg", expected.upBig, Ladder.bump(weight, direction = 1, big = true), tolerance)
        }
    }

    // Every roundCase is an exact IEEE tie — the one place the languages' default rounding rules
    // disagree, and reachable because typed entry rounds whatever the keypad accepts.
    @Test
    fun testEveryRoundCase() {
        for (expected in golden.roundCases) {
            assertEquals("round(${expected.value})", expected.rounded, Ladder.round(expected.value), tolerance)
            assertEquals("round(−x) == −round(x) at ${expected.value}",
                         -Ladder.round(expected.value), Ladder.round(-expected.value), tolerance)
        }
    }

    @Test
    fun testEveryRepCase() {
        for (expected in golden.repCases) {
            assertEquals("down from ${expected.reps} reps", expected.down, Ladder.bumpReps(expected.reps, direction = -1))
            assertEquals("up from ${expected.reps} reps", expected.up, Ladder.bumpReps(expected.reps, direction = 1))
        }
        // The floor is 1 because the server refuses reps < 1: at 0 the logger drew a tappable set the
        // log could only answer with a refusal. The golden pins 1 and the stored 0; anything below
        // that is unreachable through the UI, and the down key still answers there — by climbing.
        assertEquals(1, Ladder.bumpReps(-3, direction = -1))
    }

    // §K'S CAPTION, composed from the SAME band table the buttons are, so a retier moves both or
    // neither. It is read the way a lift reads the table — the caption says where the lifter is
    // standing, not what the down key will do — which is why exactly 20 kg reads as the middle band
    // while the down key answers 19 out of the one below it.
    @Test
    fun testTheTierCaptionIsReadOffTheBandTable() {
        assertEquals("under 20 kg · fine 1 · plate 2.5", Ladder.tier(0.0))
        assertEquals("under 20 kg · fine 1 · plate 2.5", Ladder.tier(19.99))
        assertEquals("20–50 kg · fine 2.5 · plate 5", Ladder.tier(20.0))
        assertEquals("20–50 kg · fine 2.5 · plate 5", Ladder.tier(49.99))
        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(50.0))
        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(105.0))
        // The bands are read off the MAGNITUDE here too, so band-assisted work is captioned rather
        // than falling off the table into the top band by accident.
        assertEquals("under 20 kg · fine 1 · plate 2.5", Ladder.tier(-19.0))
        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(-102.5))
    }

    // The caption's own numbers ARE the band table's, not a second copy typed beside them — and
    // WHICH band is the one the lifter is STANDING in, read off the magnitude with `<`. That is
    // all it claims, and the claim is deliberately narrow: at a band edge the caption does NOT
    // name every key under it. Standing at exactly 20 kg it reads `fine 2.5` while the key beside
    // it says −1, because a move that LIGHTENS reads the band below so the +1 that carried you
    // 19 → 20 is answered by a −1 back. Saying "every step it names is the step the button under
    // it takes" would be false at every boundary in the golden, on both sides of zero, and the
    // edges below are pinned so nobody can quietly widen this test into that claim.
    @Test
    fun testTheCaptionNamesTheBandTheLifterIsStandingIn() {
        for (expected in golden.weightCases) {
            val caption = Ladder.tier(expected.weight)
            val standing = Ladder.steps(abs(expected.weight), lightening = false)
            val tail = "· fine ${Ladder.text(standing.small)} · plate ${Ladder.text(standing.large)}"
            assertTrue(
                "caption at ${expected.weight} kg reads \"$caption\", which does not end \"$tail\"",
                caption.endsWith(tail),
            )
        }
    }

    // And for a loaded weight that band IS the two up-keys, which is the half of the old claim
    // that holds: a lifter reading `fine 2.5` sees +2.5 under it. Only the down-keys drop out of
    // the band below at an edge — and on the assisted side of zero the mirror swaps which pair
    // follows the caption, which is why this loop is the positive cases and the edges are spelled
    // out one by one.
    @Test
    fun testTheCaptionNamesTheUpKeysOfALoadedWeight() {
        for (expected in golden.weightCases.filter { it.weight > 0 }) {
            val labels = Ladder.labels(expected.weight)
            val standing = Ladder.steps(expected.weight, lightening = false)
            assertEquals("up keys at ${expected.weight} kg",
                         listOf("+${Ladder.text(standing.small)}", "+${Ladder.text(standing.large)}"),
                         labels.subList(2, 4))
        }
    }

    // THE EDGES THE CAPTION DOES NOT SPEAK FOR, spelled out so they cannot be mistaken for drift.
    // A bare bar and the top boundary both sit on a band line, and there the down-keys answer out
    // of the band below; assisted work mirrors it and the UP keys are the ones that do.
    @Test
    fun testAtABandEdgeTheKeysComeOutOfTwoBandsAndTheCaptionNamesOne() {
        assertEquals("20–50 kg · fine 2.5 · plate 5", Ladder.tier(20.0))
        assertEquals(listOf("−2.5", "−1", "+2.5", "+5"), Ladder.labels(20.0))

        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(50.0))
        assertEquals(listOf("−5", "−2.5", "+2.5", "+10"), Ladder.labels(50.0))

        assertEquals("20–50 kg · fine 2.5 · plate 5", Ladder.tier(-20.0))
        assertEquals("the mirror: the assisted side lightens upward",
                     listOf("−5", "−2.5", "+1", "+2.5"), Ladder.labels(-20.0))
    }

    // The law that makes one rule serve both sides of zero: bump(−w, −direction, big) is exactly
    // −bump(w, direction, big). An implementation that reads its down-band off the SIGNED weight
    // gets the loaded side right and breaks here.
    @Test
    fun testMirrorSymmetry() {
        for (expected in golden.weightCases) {
            for (direction in listOf(-1, 1)) {
                for (big in listOf(false, true)) {
                    assertEquals(
                        "mirror at ${expected.weight} kg, direction $direction, big $big",
                        -Ladder.bump(expected.weight, direction, big),
                        Ladder.bump(-expected.weight, -direction, big),
                        tolerance
                    )
                }
            }
        }
    }
}
