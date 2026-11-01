package works.windmill.gym.presentation

import org.junit.Assert.assertEquals
import org.junit.Test

class NumberEntryTests {
    @Test fun signedLoadsAndCommaDecimalsKeepTheirEnteredValue() {
        val cases = mapOf(
            "-12.5" to -12.5,
            "-102.5" to -102.5,
            "-499.99" to -499.99,
            "−12.5" to -12.5,
            "−102,5" to -102.5,
            Readout.weight(-499.99) to -499.99,
            " -102,5 " to -102.5,
            "+12.5" to 12.5,
            "0" to 0.0,
            "1e1" to 10.0,
        )
        for ((text, expected) in cases) {
            assertEquals(text, NumberEntry.Reading(expected, "kg"),
                NumberEntry.read(text, NumberEntry.Field.Load, keeping = 82.5))
        }
    }

    @Test fun aFloorRefusesALoadUnderItAsTypedAndNamesTheKeptValue() {
        assertEquals(NumberEntry.Reading(null, "Enter 0 or more, or cancel to keep 75", belowFloor = true),
            NumberEntry.read("−12.5", NumberEntry.Field.Load, keeping = 75.0, floor = 0.0))
        assertEquals(NumberEntry.Reading(null, "Enter 0 or more, or cancel to keep 75", belowFloor = true),
            NumberEntry.read("-0.01", NumberEntry.Field.Load, keeping = 75.0, floor = 0.0))
        assertEquals(NumberEntry.Reading(0.0, "kg"), NumberEntry.read("-0.004", NumberEntry.Field.Load, keeping = 75.0, floor = 0.0))
        assertEquals(NumberEntry.Reading(0.0, "kg"), NumberEntry.read("0", NumberEntry.Field.Load, keeping = 75.0, floor = 0.0))
        assertEquals(NumberEntry.Reading(-12.5, "kg"), NumberEntry.read("−12.5", NumberEntry.Field.Load, keeping = 75.0, floor = null))
        assertEquals(NumberEntry.Reading(-10.0, "kg"), NumberEntry.read("−10", NumberEntry.Field.Load, keeping = -10.0, floor = 0.0))
        assertEquals(NumberEntry.Reading(null, "Enter 0 or more, or cancel to keep −10", belowFloor = true),
            NumberEntry.read("−7.5", NumberEntry.Field.Load, keeping = -10.0, floor = 0.0))
    }

    @Test fun aStepStopsAtTheFloorAndAnUnflooredStepKeepsItsSign() {
        assertEquals(listOf(0.0, 0.0, 1.0, -1.0, -5.0),
            listOf(NumberEntry.bumped(1.0, -1, big = true, floor = 0.0), NumberEntry.bumped(0.0, -1, big = false, floor = 0.0),
                NumberEntry.bumped(0.0, 1, big = false, floor = 0.0), NumberEntry.bumped(0.0, -1, big = false, floor = null),
                NumberEntry.bumped(-2.5, -1, big = true, floor = null)))
    }

    @Test fun aKeptLoadUnderTheFloorNeverStepsDownToItAndStepsUpOnlyAsFarAsIt() {
        assertEquals(listOf(-10.0, -10.0, 0.0, 0.0),
            listOf(NumberEntry.bumped(-10.0, -1, big = false, floor = 0.0), NumberEntry.bumped(-10.0, -1, big = true, floor = 0.0),
                NumberEntry.bumped(-10.0, 1, big = false, floor = 0.0), NumberEntry.bumped(-10.0, 1, big = true, floor = 0.0)))
    }

    @Test fun loadRoundingUsesHundredthsAndHalfAwayFromZero() {
        val cases = mapOf(
            "102.505" to 102.51,
            "-102.505" to -102.51,
            "0.005" to 0.01,
            "-0.005" to -0.01,
            "499.995" to 500.0,
            "-499.995" to -500.0,
            "21.25" to 21.25,
        )
        for ((text, expected) in cases) {
            assertEquals(text, NumberEntry.Reading(expected, "kg"),
                NumberEntry.read(text, NumberEntry.Field.Load, keeping = 0.0))
        }
    }

    @Test fun finiteLoadsHaveNoPolicyCapAndCanonicalReadoutsRoundTrip() {
        for (value in listOf(-5000.0, 5000.0, 35333333333333.34, Double.MAX_VALUE, -Double.MAX_VALUE)) {
            assertEquals(NumberEntry.Reading(value, "kg"),
                NumberEntry.read(Readout.weight(value), NumberEntry.Field.Load, keeping = 0.0))
        }
    }

    @Test fun emptyAndIncompleteSignNameTheUnchangedPriorValue() {
        for (text in listOf("", "  ", "-", " - ", "−")) {
            assertEquals(text, NumberEntry.Reading(null, "Enter a number, or cancel to keep −102.5"),
                NumberEntry.read(text, NumberEntry.Field.Load, keeping = -102.5))
            assertEquals(text, NumberEntry.Reading(null, "Enter a number, or cancel to keep 8"),
                NumberEntry.read(text, NumberEntry.Field.Reps, keeping = 8.0))
        }
    }

    @Test fun repeatedSeparatorsAreRefusedBeforeParsingOrBounds() {
        for (text in listOf("10,2,5", "10.2.5", "10,2.5", "500..1", "bad..")) {
            for (field in NumberEntry.Field.entries) {
                assertEquals("$field: $text", NumberEntry.Reading(null, "One decimal point only."),
                    NumberEntry.read(text, field, keeping = 5.0))
            }
        }
    }

    @Test fun malformedAndNonFiniteValuesCannotCommit() {
        for (text in listOf(".", ",", "+", "--", "7-2", "NaN", "Infinity", "-Infinity", "1e999")) {
            for (field in NumberEntry.Field.entries) {
                assertEquals("$field: $text", NumberEntry.Reading(null, "That is not a number yet."),
                    NumberEntry.read(text, field, keeping = 5.0))
            }
        }
    }

    @Test fun performedRepsAcceptWholeValuesWithinOneToNinetyNine() {
        for ((text, value) in mapOf("1" to 1.0, "99" to 99.0, "8.0" to 8.0, " 8,0 " to 8.0, "1e1" to 10.0)) {
            assertEquals(text, NumberEntry.Reading(value, "whole reps"),
                NumberEntry.read(text, NumberEntry.Field.Reps, keeping = 5.0))
        }
        for (text in listOf("0", "-1", "100", "1.5", "99.01", "7,5")) {
            assertEquals(text, NumberEntry.Reading(null, "Whole reps, 1 to 99."),
                NumberEntry.read(text, NumberEntry.Field.Reps, keeping = 5.0))
        }
    }

    @Test fun incompleteAndRepairedInputRetainsItsValidationState() {
        val edits = listOf("-", "-1", "-12", "-12,", "-12,5", "-12,5,", "-12,5")
        assertEquals(listOf(
            NumberEntry.Reading(null, "Enter a number, or cancel to keep 82.5"),
            NumberEntry.Reading(-1.0, "kg"),
            NumberEntry.Reading(-12.0, "kg"),
            NumberEntry.Reading(-12.0, "kg"),
            NumberEntry.Reading(-12.5, "kg"),
            NumberEntry.Reading(null, "One decimal point only."),
            NumberEntry.Reading(-12.5, "kg"),
        ), edits.map { NumberEntry.read(it, NumberEntry.Field.Load, keeping = 82.5) })
    }
}
