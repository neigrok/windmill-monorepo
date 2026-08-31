package works.windmill.gym.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// /v1/gym/notes, owner-scoped: title-and-body pairs the lifter writes and Coach reads, in precedence
// order. Account-only — this phone keeps no copy and the claim replays none.

@Serializable
data class Note(
    val id: String,
    val position: Int = 0,
    val title: String,
    val body: String = "",
    @SerialName("updatedAt") val updatedAtMs: Long = 0,
) {
    // The row's meta: the first line of the body that says anything.
    val firstLine: String?
        get() = body.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
}

// Both fields carry NO DEFAULT: encodeDefaults is off, so an empty body would travel as an absent key
// and the route reads an absent key as a note it cannot read.
@Serializable
data class NoteWrite(val title: String, val body: String)

@Serializable
data class NotesOrder(val order: List<String>)

object Notes {
    const val title = "Notes"

    // The same three numbers the server checks; the server's sentence is what a refusal shows.
    const val maxNotes = 10
    const val titleMax = 60
    const val bodyMaxBytes = 500
    // A counter is chrome only in the last fifth of its bound: a short note carries none.
    const val counterFrom = 400
    const val titleCounterFrom = 48

    // The head, and nothing else in it.
    const val honesty = "Any agent you connect can read these too."
    const val sub = "what you write for Coach"

    // The one caption on the screen: the handle shows the drag, this says what the order means.
    const val topWins = "Top note wins."

    const val add = "Add a note"
    const val full = "10 of 10 notes. Delete one to add another."

    // Placeholder text inside empty rows, never stored: tapping one opens the editor with the title
    // filled in, and nothing is written until the lifter saves.
    val placeholders = listOf("How I want to be talked to", "What I am training for")

    const val signedOut = "Notes live with your account, so they need you signed in."

    // Beside the dials in settings, where the question is asked.
    const val settingsLine = "Coach reads your notes, not your settings."

    const val titlePlaceholder = "Title"
    const val bodyPlaceholder = "What Coach should know"
    const val save = "Save"
    // One tap. The note leaves the editor and the window holds it, with Undo on the room's transient.
    const val delete = "Delete note"

    fun bytes(body: String): Int = body.toByteArray(Charsets.UTF_8).size

    // Null below the threshold: nothing is drawn.
    fun counter(body: String): String? {
        val used = bytes(body.trim())
        if (used < counterFrom) return null
        return "$used of $bodyMaxBytes bytes"
    }

    // Past the bound the counter goes alarm; Save stays tappable and the log's sentence refuses in place.
    fun over(body: String): Boolean = bytes(body.trim()) > bodyMaxBytes

    // Code points, not UTF-16 units: `char_length` is what the column checks.
    fun titleLength(title: String): Int = title.trim().let { it.codePointCount(0, it.length) }

    fun titleCounter(title: String): String? {
        val used = titleLength(title)
        if (used < titleCounterFrom) return null
        return "$used of $titleMax characters"
    }

    fun titleOver(title: String): Boolean = titleLength(title) > titleMax

    fun savable(title: String): Boolean = title.trim().isNotEmpty()

    // One step at a time, the way the drag hands it over.
    fun moved(notes: List<Note>, from: Int, to: Int): List<Note> {
        if (from == to || from !in notes.indices || to !in notes.indices) return notes
        val order = notes.toMutableList()
        order.add(to, order.removeAt(from))
        return order
    }
}
