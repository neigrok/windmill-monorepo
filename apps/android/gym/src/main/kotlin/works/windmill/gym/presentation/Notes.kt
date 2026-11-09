package works.windmill.gym.presentation

import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Title-and-body pairs the lifter writes and Coach reads, in precedence order. Notes live with the
// account: signed out, there is no notebook.

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

data class NoteWrite(val title: String, val body: String)

object Notes {
    // The same three numbers the server checks; the server's sentence is what a refusal shows.
    const val maxNotes = 10
    const val titleMax = 60
    const val bodyMaxBytes = 500
    // A counter is chrome only in the last fifth of its bound: a short note carries none.
    const val counterFrom = 400
    const val titleCounterFrom = 48

    // Suggestions remain hints until the lifter types a title.
    val titleSuggestions = listOf(R.string.gym_notes_placeholder_talk, R.string.gym_notes_placeholder_training)

    fun bytes(body: String): Int = body.toByteArray(Charsets.UTF_8).size

    // Null below the threshold: nothing is drawn.
    fun bytesCounter(body: String): Words? {
        val used = bytes(body.trim())
        if (used < counterFrom) return null
        return Words.Message(R.string.gym_notes_bytes_counter, listOf(used.toString(), bodyMaxBytes.toString()))
    }

    // Past the bound the counter goes alarm; Save stays tappable and the log's sentence refuses in place.
    fun over(body: String): Boolean = bytes(body.trim()) > bodyMaxBytes

    // Code points, not UTF-16 units: `char_length` is what the column checks.
    fun titleLength(title: String): Int = title.trim().let { it.codePointCount(0, it.length) }

    fun titleCharacters(title: String): Words? {
        val used = titleLength(title)
        if (used < titleCounterFrom) return null
        return Words.Message(R.string.gym_notes_title_counter, listOf(used.toString(), titleMax.toString()))
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
