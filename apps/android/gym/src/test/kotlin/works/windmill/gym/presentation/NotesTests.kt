package works.windmill.gym.presentation

import android.content.Context
import androidx.annotation.StringRes
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import works.windmill.platform.net.WindmillJson

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotesTests {
    @Test
    fun theBoundsAreTheServersThree() {
        assertEquals(10, Notes.maxNotes)
        assertEquals(60, Notes.titleMax)
        assertEquals(500, Notes.bodyMaxBytes)
    }

    @Test
    fun theCounterIsDrawnOnlyInTheLastFifthAndCountsBytes() {
        assertNull("a short note carries no chrome", Notes.bytesCounter("keep it blunt"))
        assertNull(Notes.bytesCounter("x".repeat(399)))
        assertEquals("400 of 500 bytes", Notes.bytesCounter("x".repeat(400)).spelled())
        assertEquals("501 of 500 bytes", Notes.bytesCounter("x".repeat(501)).spelled())
        assertEquals("bytes, not characters", "400 of 500 bytes", Notes.bytesCounter("é".repeat(200)).spelled())
        assertEquals("measured after the trim the server applies", "400 of 500 bytes",
            Notes.bytesCounter("  " + "x".repeat(400) + "\n").spelled())
    }

    @Test
    fun theWordsOnTheScreenAreTheBriefs() {
        assertEquals("Any agent you connect can read these too.", string(R.string.gym_notes_honesty))
        assertEquals("Add a note", string(R.string.gym_notes_add))
        assertEquals("10 of 10 notes. Delete one to add another.", string(R.string.gym_notes_full))
        assertEquals(listOf("How I want to be talked to", "What I am training for"), Notes.titleSuggestions.map { string(it) })
        assertEquals("Notes live with your account, so they need you signed in.", string(R.string.gym_notes_signed_out))
        assertEquals("Delete note", string(R.string.gym_notes_delete))
        assertEquals("How I want to be talked to", string(R.string.gym_notes_placeholder_talk))
        assertEquals("Write a note for Coach", string(R.string.gym_notes_body_placeholder))
    }

    // The same rule as the byte counter: the last fifth of the bound, alarm past it, code points counted.
    @Test
    fun theTitleCounterIsDrawnOnlyInTheLastFifthAndCountsCodePoints() {
        assertEquals(48, Notes.titleCounterFrom)
        assertNull("a short title carries no chrome", Notes.titleCharacters("Tone"))
        assertNull(Notes.titleCharacters("x".repeat(47)))
        assertEquals("48 of 60 characters", Notes.titleCharacters("x".repeat(48)).spelled())
        assertEquals("53 of 60 characters", Notes.titleCharacters("x".repeat(53)).spelled())
        assertEquals("61 of 60 characters", Notes.titleCharacters("x".repeat(61)).spelled())
        assertEquals("code points, not UTF-16 units", "48 of 60 characters", Notes.titleCharacters("\uD83C\uDFCB".repeat(48)).spelled())
        assertEquals("code points, not bytes", "60 of 60 characters", Notes.titleCharacters("é".repeat(60)).spelled())
        assertEquals("measured after the trim the server applies", "48 of 60 characters",
            Notes.titleCharacters("  " + "x".repeat(48) + "\n").spelled())
        assertFalse(Notes.titleOver("x".repeat(60)))
        assertTrue(Notes.titleOver("x".repeat(61)))
        assertFalse("code points, not UTF-16 units", Notes.titleOver("\uD83C\uDFCB".repeat(60)))
    }

    @Test
    fun theCounterGoesAlarmOnlyPastTheBound() {
        assertFalse(Notes.over("x".repeat(500)))
        assertTrue(Notes.over("x".repeat(501)))
        assertTrue("bytes, not characters", Notes.over("é".repeat(251)))
        assertFalse("measured after the trim the server applies", Notes.over("x".repeat(500) + "\n  "))
    }

    @Test
    fun aNoteNeedsATitleAndNothingElse() {
        assertFalse(Notes.savable("   "))
        assertTrue(Notes.savable(" Tone "))
    }

    @Test
    fun aNoteReadsBackWholeAndItsMetaIsTheFirstLineThatSaysAnything() {
        val note = WindmillJson.decodeFromString(
            Note.serializer(),
            """{"id":"note_a","position":2,"title":"Tone","body":"\n  \nBlunt.\nNo cheering.","updatedAt":7000}""",
        )
        assertEquals(Note("note_a", 2, "Tone", "\n  \nBlunt.\nNo cheering.", 7_000), note)
        assertEquals("Blunt.", note.firstLine)
        assertNull(Note("note_b", 0, "Empty", "  \n ").firstLine)
    }

    @Test
    fun aMoveIsOneStepAndAnImpossibleOneIsNoMove() {
        val a = Note("note_a", 0, "a")
        val b = Note("note_b", 1, "b")
        val c = Note("note_c", 2, "c")
        assertEquals(listOf(b, a, c), Notes.moved(listOf(a, b, c), from = 0, to = 1))
        assertEquals(listOf(a, c, b), Notes.moved(listOf(a, b, c), from = 2, to = 1))
        assertEquals(listOf(a, b, c), Notes.moved(listOf(a, b, c), from = 1, to = 1))
        assertEquals(listOf(a, b, c), Notes.moved(listOf(a, b, c), from = 1, to = 7))
    }

    @Test
    fun aNoteIdIsMintedLikeAThreadId() {
        val id = Ids.note()
        assertTrue(id, Regex("note_[0-9a-f]{16}").matches(id))
    }
}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())

private fun string(@StringRes id: Int, vararg args: Any): String = ApplicationProvider.getApplicationContext<Context>().getString(id, *args)
