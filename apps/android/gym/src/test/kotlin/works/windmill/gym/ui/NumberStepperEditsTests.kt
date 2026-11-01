package works.windmill.gym.ui

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class NumberStepperEditsTests {
    @Test fun aSecondSeparatorKeepsTheWholePreviousEditorValue() {
        for (text in listOf("12..5", "12,,5", "12.,5", "12,.5")) {
            val current = TextFieldValue("12.5", TextRange(2), TextRange(0, 2))
            assertSame(text, current, numberStepperEdit(current, TextFieldValue(text, TextRange(3))))
        }
    }

    @Test fun replacingTheSelectedSeparatorPreservesTheNewCaretAndComposition() {
        val current = TextFieldValue("12.5", TextRange(2, 3))
        val replacement = TextFieldValue("12,5", TextRange(3), TextRange(0, 3))
        assertSame(replacement, numberStepperEdit(current, replacement))
        val dot = TextFieldValue("12.5", TextRange(3), TextRange(2, 3))
        assertSame(dot, numberStepperEdit(replacement, dot))
    }

    @Test fun validReplacementAndPastePreserveTheirExactRawText() {
        val current = TextFieldValue("12.5", TextRange(0, 4))
        for (text in listOf("-82.5", "−82,5", ".5", "-.5", "  -12,5  ", "1.7976931348623157e+308", "-1E-308")) {
            val next = TextFieldValue(text, TextRange(text.length))
            assertEquals(text, next.copy(text = text.replace('-', '−')), numberStepperEdit(current, next))
        }
    }

    @Test fun malformedPasteIsRejectedAtomicallyWithoutMovingSelection() {
        val current = TextFieldValue("12.5", TextRange(1, 3))
        for (text in listOf("1.2.3", "5kg", "12 5", "--5", "1e2.5", ".e2", "1e2e3", "NaN", "Infinity")) {
            assertSame(text, current, numberStepperEdit(current, TextFieldValue(text, TextRange(text.length))))
        }
    }

    @Test fun emptySignAndLeadingSeparatorBuffersRemainEditable() {
        val current = TextFieldValue("12.5", TextRange(0, 4))
        for (text in listOf("", "-", "−", "+", ".", ",", "-.", "−,", "1.", "1,", "1e", "1e-", "1E+")) {
            val next = TextFieldValue(text, TextRange(text.length))
            assertEquals(text, next.copy(text = text.replace('-', '−')), numberStepperEdit(current, next))
        }
    }

    @Test fun cursorSelectionAndCompositionChangesPreserveTheText() {
        val current = TextFieldValue("−12.5", TextRange(5))
        val moved = current.copy(selection = TextRange(4, 1), composition = TextRange(1, 4))
        assertSame(moved, numberStepperEdit(current, moved))
        assertEquals("−12.5", moved.text)
    }

    @Test fun aTypedHyphenBecomesTheMinusSignWithItsCaretAndComposition() {
        val typed = TextFieldValue("-12.5", TextRange(1), TextRange(0, 1))
        assertEquals(TextFieldValue("−12.5", TextRange(1), TextRange(0, 1)), numberStepperEdit(TextFieldValue("12.5", TextRange(0)), typed))
    }

    @Test fun anExistingInvalidBufferCanBeSelectedAndReplaced() {
        val current = TextFieldValue("12..5", TextRange(5))
        val selected = current.copy(selection = TextRange(0, 5))
        assertSame(selected, numberStepperEdit(current, selected))
        val fixed = TextFieldValue("12.5", TextRange(3))
        assertSame(fixed, numberStepperEdit(selected, fixed))
    }

    @Test fun deletionOnlyEditsRecoverMalformedBuffersAndPartlyDeletedExponents() {
        for ((before, after) in listOf("12...5" to "12..5", "12..5" to "12..", "12.." to "12.",
            "1.25e+305" to "e+305", "e+305" to "e+30", "e+30" to "e+", "e+" to "e", "e" to "")) {
            val current = TextFieldValue(before, TextRange(before.length))
            val next = TextFieldValue(after, TextRange(after.length))
            assertSame("$before → $after", next, numberStepperEdit(current, next))
        }
        val current = TextFieldValue("12...5", TextRange(2, 5))
        for (text in listOf("1.2x", "1,,2", "..7", "e+5"))
            assertSame(text, current, numberStepperEdit(current, TextFieldValue(text)))
    }
}
