package works.windmill.gym.domain

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// WHAT WOULD GO ON THE BAR, and — the half this wave exists for — what to say when nothing would.
// A readout that quietly rounded to a weight the lifter cannot build would be worse than no
// readout: it is a false statement about the physical world, made by the product, on the screen
// they are standing at a rack reading.
//
// The rule's truth is packages/api-contract/gym-plate-readout.json, read here straight out of the
// repo working tree exactly as LadderTests reads the ladder's — not copied into test resources. A
// copied fixture is a copy, and copies are the thing that package exists to prevent.
//
// THE GOLDEN PINS THE ANSWER; THE SENTENCE IS ANDROID'S. Which of the five answers comes back, the
// per-side decomposition, and the two neighbours are the rule, and three languages must agree on
// them. The line under the numeral is presentation — each surface spells a number its own way — so
// it is pinned below by hand, in this file, where changing it costs nobody else a red build.

class PlatesTests {
    @Serializable
    data class Golden(val grid: Double, val capKg: Double, val cases: List<Case>)

    @Serializable
    data class Case(
        val totalKg: Double,
        val barWeightKg: Double,
        val platesKg: List<Double>,
        val answer: String,
        // ABSENT IS A REAL VALUE HERE, and it is why these three carry defaults: only a `loaded`
        // case spells `perSide` and only an `unloadable` one spells its neighbours. A default that
        // stood in for a LOST expectation would be a green test on a fixture that no longer says
        // anything, so the guard below checks that every case still carries what its answer needs.
        val perSide: List<GoldenPlate> = emptyList(),
        val belowKg: Double? = null,
        val aboveKg: Double? = null,
    )

    @Serializable
    data class GoldenPlate(val kg: Double, val count: Int)

    companion object {
        // Walk up from the test JVM's working directory until the golden turns up, rather than
        // counting directories: a hard-coded depth is a tripwire that fires the day the package
        // moves, and this suite is exactly the thing that must not quietly stop finding its
        // contract when that happens.
        val goldenFile: File = run {
            val relative = "packages/api-contract/gym-plate-readout.json"
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

    private val standard = GymPreferences()

    @Before
    fun loadGolden() {
        // A golden that cannot be found must fail the suite, never quietly skip it — an unrun
        // contract is drift nobody sees.
        assertTrue(
            "plate readout golden not found at ${goldenFile.path} — this suite reads the repo's packages/api-contract/gym-plate-readout.json, not a bundled copy",
            goldenFile.exists()
        )
        golden = json.decodeFromString(Golden.serializer(), goldenFile.readText())
    }

    // A loop over an empty array is a green test, so the case-driven test below is only as honest as
    // the fixture is full. Emptying it disarms EVERY language at once from a file none of them owns
    // — exactly the move someone makes to turn a red build green.
    @Test
    fun testTheGoldenStillCarriesItsCases() {
        assertEquals("the golden's grid is no longer the ladder's own", 0.01, golden.grid, 0.0)
        assertTrue("cases shrank to ${golden.cases.size}", golden.cases.size >= 22)
        // All five answers, named one by one. Both edges this wave fixed live in exactly one answer
        // each — `underBar` and `none` — and a pruner looking for redundancy finds those rows first.
        for (answer in listOf("loaded", "bare", "underBar", "unloadable", "none")) {
            assertTrue("no $answer case left in the golden", golden.cases.any { it.answer == answer })
        }
        assertTrue(
            "a loaded case lost its perSide — it would compare against an empty expectation",
            golden.cases.filter { it.answer == "loaded" }.all { it.perSide.isNotEmpty() },
        )
        assertTrue(
            "an unloadable case lost both neighbours — the answer is the two loads that CAN be made",
            golden.cases.filter { it.answer == "unloadable" }.all { it.belowKg != null || it.aboveKg != null },
        )
    }

    // THE CONTRACT ITSELF, every row of it. Exact equality and no tolerance is deliberate: every
    // number on both sides is whole hundredths over 100, so the parser and the arithmetic land on
    // the same double, and there is no accumulated step for a tolerance to forgive.
    @Test
    fun testEveryCaseAnswersTheGolden() {
        for (case in golden.cases) {
            val rack = GymPreferences(barWeightKg = case.barWeightKg, platesKg = case.platesKg)
            val readout = Plates.readout(case.totalKg, rack)
            val where = "${case.totalKg} kg on a ${case.barWeightKg} kg bar with ${case.platesKg}"
            assertEquals("answer at $where", case.answer, answerOf(readout))
            if (readout is PlateReadout.Loaded) {
                assertEquals("per side at $where", case.perSide,
                             readout.perSide.map { GoldenPlate(it.kg, it.count) })
            }
            if (readout is PlateReadout.Unloadable) {
                assertEquals("belowKg at $where", case.belowKg, readout.belowKg)
                assertEquals("aboveKg at $where", case.aboveKg, readout.aboveKg)
            }
        }
    }

    // The two vocabularies meet HERE and nowhere else: the golden names its five answers as strings,
    // the logger reads a sealed type, and `none` is the absence of a readout rather than a member of
    // it. The `when` is exhaustive on purpose — a sixth answer on either side has to be spelled here
    // before this suite will compile.
    private fun answerOf(readout: PlateReadout?): String = when (readout) {
        null -> "none"
        is PlateReadout.Loaded -> "loaded"
        PlateReadout.JustTheBar -> "bare"
        is PlateReadout.UnderBar -> "underBar"
        is PlateReadout.Unloadable -> "unloadable"
    }

    // The cap is the golden's own number rather than a second copy typed beside it, and the row it
    // stops at still answers — a cap that swallowed the last loadable weight would be a silence the
    // lifter cannot explain.
    @Test
    fun testTheReadoutStopsAtTheGoldensCap() {
        assertNotNull("at the cap", Plates.readout(golden.capKg, standard))
        assertNull("one grid step past the cap", Plates.readout(golden.capKg + golden.grid, standard))
    }

    // The design's own numeral — and NOT the design's own line, which is a canon defect this test
    // deliberately does not copy. §K draws `20 + 25·2 + 15 + 2.5 per side` under 105 kg, and that
    // rack cannot exist: 20 + 2 × (25·2 + 15 + 2.5) is 155 kg, and read as a flat sum it is 87.5.
    // The right answer for 105 on a standard rack is 42.5 a side, which is 25 + 15 + 2.5 — three
    // plates, not four. Filed for the canon owner rather than fixed here: this repo cannot edit the
    // design project, and a test that quietly matched the drawing would put the wrong number on a
    // bar. Named in the wave report so it reaches the drift ledger.
    @Test
    fun testTheDesignsOwnNumeralLoadsWithThreePlatesASide() {
        val readout = Plates.readout(105.0, standard)
        assertEquals(
            PlateReadout.Loaded(20.0, listOf(Plates.Stack(25.0, 1), Plates.Stack(15.0, 1), Plates.Stack(2.5, 1))),
            readout,
        )
        assertEquals("20 + 25 + 15 + 2.5 per side", readout?.line)
    }

    // `·2` appears only where a plate actually repeats, so the ordinary line reads as a list of
    // plates rather than as a multiplication table.
    @Test
    fun testARepeatedPlateCarriesItsCountAndASinglePlateDoesNot() {
        assertEquals("20 + 25·2 + 10 per side", Plates.readout(140.0, standard)?.line)
        assertEquals("20 + 25 + 20 + 1.25 per side", Plates.readout(112.5, standard)?.line)
    }

    // THE CONTRACT'S OWN EXAMPLE, and the whole reason the ladder was left alone: a gym with no
    // 1.25s cannot make 102.5, and the answer is a line that says so and names both neighbours —
    // never a button that silently refuses to offer the weight.
    @Test
    fun testAWeightTheseRacksCannotMakeNamesTheTwoTheyCan() {
        val noSmallPlates = standard.copy(platesKg = listOf(25.0, 20.0, 15.0, 10.0, 5.0, 2.5))
        val readout = Plates.readout(102.5, noSmallPlates)
        assertEquals(PlateReadout.Unloadable(targetKg = 102.5, belowKg = 100.0, aboveKg = 105.0), readout)
        assertEquals("these plates don’t make 102.5 · 100 or 105", readout?.line)
        // And the same gym WITH its 1.25s loads it without comment.
        assertEquals("20 + 25 + 15 + 1.25 per side", Plates.readout(102.5, standard)?.line)
    }

    // A rack that owns nothing still makes exactly one weight, and the line says which: `below` is
    // the bare bar, and `above` is the neighbour that goes missing because this gym owns nothing to
    // put on it.
    @Test
    fun testAGymWithNoPlatesMakesTheBarAndNothingElse() {
        val bare = standard.copy(platesKg = emptyList())
        assertEquals(PlateReadout.JustTheBar, Plates.readout(20.0, bare))
        assertEquals("just the bar", Plates.readout(20.0, bare)?.line)
        val readout = Plates.readout(40.0, bare)
        assertEquals(PlateReadout.Unloadable(targetKg = 40.0, belowKg = 20.0, aboveKg = null), readout)
        assertEquals("these plates don’t make 40 · 20 is the nearest", readout?.line)
    }

    // THE FIRST RULING: a bar of zero is a machine or a pair of dumbbells, which is the lifter
    // saying there is no bar — so there is no sentence about one, whatever the plates could make.
    // This copy used to answer here with a per-side decomposition, which reads plausibly and claims
    // a symmetry the equipment may not have.
    @Test
    fun testABarOfZeroSaysNothingAtAll() {
        val machine = standard.copy(barWeightKg = 0.0)
        assertNull("a machine is not a bar being loaded", Plates.readout(80.0, machine))
        assertNull("...and it does not become one at a weight the plates happen to make",
                   Plates.readout(30.0, machine))
        assertNull(Plates.readout(0.0, machine))
    }

    // THE SECOND RULING, and it goes the other way: under the bar the line SAYS SO. This copy used
    // to fall silent, which left a lifter wondering where the plate list went. Below zero is a
    // different question — a band takes weight off and no bar is being loaded at all — and there
    // the silence is the honest answer.
    @Test
    fun testUnderTheBarItNamesTheBarRatherThanFallingSilent() {
        assertEquals(PlateReadout.UnderBar(20.0), Plates.readout(15.0, standard))
        assertEquals("lighter than the 20 kg bar", Plates.readout(15.0, standard)?.line)
        assertEquals("lighter than the 20 kg bar", Plates.readout(0.5, standard)?.line)
        // A 15 kg women's bar says its own number, because the sentence is about THIS rack.
        assertEquals("lighter than the 15 kg bar", Plates.readout(10.0, standard.copy(barWeightKg = 15.0))?.line)

        assertNull("a bodyweight zero is not a bar being loaded", Plates.readout(0.0, standard))
        assertNull("and neither is band-assisted work", Plates.readout(-20.0, standard))
    }

    // NOTHING HERE THROWS ON A WEIGHT REHYDRATED FROM STORAGE — the same law Ladder.kt states and
    // LadderTests pins, and this readout is on that path through the logger's prefill. A number
    // that is not a number is silence, not an exception mid-set. `cents` rounds, and rounding is
    // exactly what these values break.
    @Test
    fun testAnUnorderableWeightIsSilenceRatherThanACrash() {
        for (value in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertNull("weight $value", Plates.readout(value, standard))
            assertNull("bar $value", Plates.readout(100.0, standard.copy(barWeightKg = value)))
            // A plate that is not a plate is DROPPED rather than searched with, so the rack answers
            // as the empty one it effectively is.
            assertEquals("plate $value", "these plates don’t make 100 · 20 is the nearest",
                         Plates.readout(100.0, standard.copy(platesKg = listOf(value)))?.line)
        }
        // A plate wider than the search itself is the same class of value and the same answer: it
        // is dropped rather than indexed into a table that cannot hold it. This one is exact —
        // 4294967291 hundredths truncates to −5 as an Int, which walks the reachability table five
        // cells off its own end. `normalized()` keeps every real document inside 0.01–100 kg, so
        // this is only ever a file repaired on read.
        val absurd = standard.copy(platesKg = listOf(42_949_672.91))
        assertEquals("these plates don’t make 40 · 20 is the nearest", Plates.readout(40.0, absurd)?.line)
    }

    // GREEDY IS WRONG ON A REAL RACK, which is why this is a table search. Forty-five a side off 15s
    // and 20s is three 15s; walking down the rack takes two 20s and strands five kilos.
    @Test
    fun testARackGreedyWouldStrandStillLoads() {
        val odd = standard.copy(platesKg = listOf(20.0, 15.0))
        assertEquals("20 + 15·3 per side", Plates.readout(110.0, odd)?.line)
    }

    // The halving is where doubles would lose this: 42.5 across two sides is 21.25 a side, and
    // 85 / 2 on binary doubles is exactly the arithmetic that turns a loadable weight into an
    // unloadable one. Every number here is whole hundredths before it is halved.
    @Test
    fun testTheHalvingHoldsOnTheAwkwardHundredths() {
        assertEquals("20 + 20 + 1.25 per side", Plates.readout(62.5, standard)?.line)
        assertEquals("20 + 1.25 per side", Plates.readout(22.5, standard)?.line)
        // An odd number of hundredths cannot be halved onto two sides at all — and the answer is
        // the two loads that can be, not a silent round to one of them.
        assertEquals(
            "these plates don’t make 105.01 · 105 or 107.5",
            Plates.readout(105.01, standard)?.line,
        )
    }

    // The lifter's own rack and nobody else's: turning a plate off changes the answer, and the
    // answer is what the settings screen promises the readout will do.
    @Test
    fun testTurningAPlateOffMovesTheReadout() {
        assertEquals("20 + 25 + 15 + 2.5 per side", Plates.readout(105.0, standard)?.line)
        val without25s = standard.togglingPlate(25.0)
        assertEquals("20 + 20·2 + 2.5 per side", Plates.readout(105.0, without25s)?.line)
    }
}
