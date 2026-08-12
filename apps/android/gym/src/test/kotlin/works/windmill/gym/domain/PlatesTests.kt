package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// WHAT WOULD GO ON THE BAR, and — the half this wave exists for — what to say when nothing would.
// A readout that quietly rounded to a weight the lifter cannot build would be worse than no
// readout: it is a false statement about the physical world, made by the product, on the screen
// they are standing at a rack reading.

class PlatesTests {
    private val standard = GymPreferences()

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

    // A rack that owns nothing still makes exactly one weight WHILE THERE IS A BAR, and the line
    // says which: `below` is the bare bar and `above` is the neighbour that goes missing. Take the
    // bar away as well and `below` goes too — that is the case below this one.
    @Test
    fun testAGymWithNoPlatesMakesTheBarAndNothingElse() {
        val bare = standard.copy(platesKg = emptyList())
        assertEquals(PlateReadout.JustTheBar, Plates.readout(20.0, bare))
        assertEquals("just the bar", Plates.readout(20.0, bare)?.line)
        val readout = Plates.readout(40.0, bare)
        assertEquals(PlateReadout.Unloadable(targetKg = 40.0, belowKg = 20.0, aboveKg = null), readout)
        assertEquals("these plates don’t make 40 · 20 is the nearest", readout?.line)
    }

    // A machine, or a pair of dumbbells: legal, and the bar term simply goes. Nothing here divides
    // by the bar, so a zero is a value and never an edge.
    @Test
    fun testABarOfZeroDropsTheBarTermRatherThanBreaking() {
        val machine = standard.copy(barWeightKg = 0.0)
        assertEquals("25 + 15 per side", Plates.readout(80.0, machine)?.line)
        assertNull("nothing on a bar that is not there", Plates.readout(0.0, machine))
    }

    // ...AND WITH NO BAR THERE IS NO FLOOR. `below` is the bare bar wherever there is one; on a
    // machine there is nothing under the lightest plate, and a readout that offered `0` as the
    // nearest load would be naming a lift nobody performs. Below the lightest plate the line names
    // only what is above it, and a machine with no plates at all says nothing whatever.
    @Test
    fun testAMachineNeverNamesZeroAsALoadItCanMake() {
        val machine = standard.copy(barWeightKg = 0.0, platesKg = listOf(25.0))
        val readout = Plates.readout(10.0, machine)
        assertEquals(PlateReadout.Unloadable(targetKg = 10.0, belowKg = null, aboveKg = 50.0), readout)
        assertEquals("these plates don’t make 10 · 50 is the nearest", readout?.line)

        // A rack that reaches past it keeps both neighbours, and neither of them is zero.
        val fine = standard.copy(barWeightKg = 0.0, platesKg = listOf(1.25))
        assertEquals("these plates don’t make 31 · 30 or 32.5", Plates.readout(31.0, fine)?.line)

        assertNull("no bar and no plates makes no load at all",
                   Plates.readout(30.0, standard.copy(barWeightKg = 0.0, platesKg = emptyList())))
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
            assertNull("plate $value",
                       Plates.readout(100.0, standard.copy(barWeightKg = 0.0, platesKg = listOf(value))))
        }
        // A plate wider than the search itself is the same class of value and the same answer: it
        // is dropped rather than indexed into a table that cannot hold it. This one is exact —
        // 4294967291 hundredths truncates to −5 as an Int, which walks the reachability table five
        // cells off its own end. `normalized()` keeps every real document inside 0.01–100 kg, so
        // this is only ever a file repaired on read.
        val absurd = standard.copy(platesKg = listOf(42_949_672.91))
        assertEquals("these plates don’t make 40 · 20 is the nearest", Plates.readout(40.0, absurd)?.line)
    }

    // Under the bar there is no bar being loaded — a fixed barbell, a dumbbell, band-assisted work
    // below zero — so the line is ABSENT rather than lecturing about a rack nobody is standing at.
    @Test
    fun testUnderTheBarItSaysNothingAtAll() {
        assertNull(Plates.readout(15.0, standard))
        assertNull(Plates.readout(0.0, standard))
        assertNull(Plates.readout(-20.0, standard))
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
