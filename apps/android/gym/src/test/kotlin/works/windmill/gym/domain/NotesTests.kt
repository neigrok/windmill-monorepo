package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class NotesTests {
    @Test
    fun theBoundsAreTheServersThree() {
        assertEquals(10, Notes.maxNotes)
        assertEquals(60, Notes.titleMax)
        assertEquals(500, Notes.bodyMaxBytes)
    }

    @Test
    fun theCounterIsDrawnOnlyInTheLastFifthAndCountsBytes() {
        assertNull("a short note carries no chrome", Notes.counter("keep it blunt"))
        assertNull(Notes.counter("x".repeat(399)))
        assertEquals("400 of 500 bytes", Notes.counter("x".repeat(400)))
        assertEquals("501 of 500 bytes", Notes.counter("x".repeat(501)))
        assertEquals("bytes, not characters", "400 of 500 bytes", Notes.counter("é".repeat(200)))
        assertEquals("measured after the trim the server applies", "400 of 500 bytes",
            Notes.counter("  " + "x".repeat(400) + "\n"))
    }

    @Test
    fun theWordsOnTheScreenAreTheBriefs() {
        assertEquals("Any agent you connect can read these too.", Notes.honesty)
        assertEquals("what you write for Coach", Notes.sub)
        assertEquals("Top note wins.", Notes.topWins)
        assertEquals("Add a note", Notes.add)
        assertEquals("10 of 10 notes. Delete one to add another.", Notes.full)
        assertEquals(listOf("How I want to be talked to", "What I am training for"), Notes.placeholders)
        assertEquals("Notes live with your account, so they need you signed in.", Notes.signedOut)
        assertEquals("Coach reads your notes, not your settings.", Notes.settingsLine)
        // One tap and a way back on the transient: the note's delete asks nothing.
        assertEquals("Delete note", Notes.delete)
    }

    // The same rule as the byte counter: the last fifth of the bound, alarm past it, code points counted.
    @Test
    fun theTitleCounterIsDrawnOnlyInTheLastFifthAndCountsCodePoints() {
        assertEquals(48, Notes.titleCounterFrom)
        assertNull("a short title carries no chrome", Notes.titleCounter("Tone"))
        assertNull(Notes.titleCounter("x".repeat(47)))
        assertEquals("48 of 60 characters", Notes.titleCounter("x".repeat(48)))
        assertEquals("53 of 60 characters", Notes.titleCounter("x".repeat(53)))
        assertEquals("61 of 60 characters", Notes.titleCounter("x".repeat(61)))
        assertEquals("code points, not UTF-16 units", "48 of 60 characters", Notes.titleCounter("\uD83C\uDFCB".repeat(48)))
        assertEquals("code points, not bytes", "60 of 60 characters", Notes.titleCounter("é".repeat(60)))
        assertEquals("measured after the trim the server applies", "48 of 60 characters",
            Notes.titleCounter("  " + "x".repeat(48) + "\n"))
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
    fun aNoteWriteCarriesBothFieldsEvenWhenTheBodyIsEmpty() {
        assertEquals(
            """{"title":"Tone","body":""}""",
            WindmillJson.encodeToString(NoteWrite.serializer(), NoteWrite(title = "Tone", body = "")),
        )
        assertEquals(
            """{"order":["note_b","note_a"]}""",
            WindmillJson.encodeToString(NotesOrder.serializer(), NotesOrder(listOf("note_b", "note_a"))),
        )
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
