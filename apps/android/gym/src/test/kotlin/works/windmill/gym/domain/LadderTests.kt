package works.windmill.gym.domain

import java.io.File
import kotlin.math.abs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

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

    private val tolerance = 1e-9

    companion object {
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
        assertTrue(
            "ladder golden not found at ${goldenFile.path} — this suite reads the repo's packages/api-contract/gym-ladder.json, not a bundled copy",
            goldenFile.exists()
        )
        golden = json.decodeFromString(Golden.serializer(), goldenFile.readText())
    }

    @Test
    fun testTheGoldenStillCarriesItsCases() {
        assertEquals("the golden's band table changed shape", 3, golden.bands.size)
        assertTrue("weightCases shrank to ${golden.weightCases.size}", golden.weightCases.size >= 22)
        assertTrue("roundCases shrank to ${golden.roundCases.size}", golden.roundCases.size >= 8)
        assertTrue("repCases shrank to ${golden.repCases.size}", golden.repCases.size >= 4)
        assertTrue("no assisted weights left", golden.weightCases.any { it.weight < 0 })
        assertTrue("no loaded weights left", golden.weightCases.any { it.weight > 0 })
    }

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
        assertEquals(1, Ladder.bumpReps(-3, direction = -1))
    }

    @Test
    fun testTheTierCaptionIsReadOffTheBandTable() {
        assertEquals("under 20 kg · fine 1 · plate 2.5", Ladder.tier(0.0))
        assertEquals("under 20 kg · fine 1 · plate 2.5", Ladder.tier(19.99))
        assertEquals("20–50 kg · fine 2.5 · plate 5", Ladder.tier(20.0))
        assertEquals("20–50 kg · fine 2.5 · plate 5", Ladder.tier(49.99))
        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(50.0))
        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(105.0))
        assertEquals("under 20 kg · fine 1 · plate 2.5", Ladder.tier(-19.0))
        assertEquals("over 50 kg · fine 2.5 · plate 10", Ladder.tier(-102.5))
    }

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
