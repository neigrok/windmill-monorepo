package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.WeighIn

sealed interface Deletion {
    sealed interface Recoverable : Deletion
    val subjectId: String

    val line: String

    val stillThere: String?

    data class Set(val sessionId: String, val set: TrainingSet) : Deletion {
        override val subjectId: String get() = set.id
        override val line: String
            get() = "${Readout.weight(set.weightKg)} kg × ${set.reps} is out of the log."
        override val stillThere: String get() = "that set is still on the log"
    }

    data class Routine(val routineId: String, val name: String) : Deletion {
        override val subjectId: String get() = routineId
        override val line: String get() = "$name deleted."
        override val stillThere: String get() = "$name is still in your program"
    }

    data class Session(val sessionId: String) : Recoverable {
        override val subjectId: String get() = sessionId
        override val line: String get() = "Session deleted."
        override val stillThere: String get() = "that session is still on the log"
    }

    data class Note(val noteId: String, val origin: Origin = Origin.List) : Deletion {
        enum class Origin(val screen: String) { List("notes"), Editor("note_editor") }

        override val subjectId: String get() = noteId
        override val line: String get() = "Note deleted."
        override val stillThere: String get() = "that note is still here"
    }

    data class Bodyweight(val dateLocal: String) : Recoverable {
        override val subjectId: String get() = dateLocal
        override val line: String get() = "Weigh-in deleted."
        override val stillThere: String? get() = null
    }

}

data class WithheldDelete(
    val deletion: Deletion.Recoverable,
    val untilMs: Long,
    val sent: Boolean = false,
    val receipt: HeldWeightReceipt? = null,
) {
    val subjectId: String get() = deletion.subjectId
    val takeable: Boolean get() = !sent
}

// What this room has taken off its lists: deletes inside their way back and set deletes already settled. Every
// list that could draw one filters against it.
class HeldDeletes {
    // Weight receipts project engine holds; workout recovery remains room-owned.
    var withheld: List<WithheldDelete> by mutableStateOf(emptyList())
        internal set
    // One room's memory of its own deletes, never a tombstone: a session read BEFORE the delete would
    // otherwise draw a row that is gone.
    var deletedSets: Set<String> by mutableStateOf(emptySet())
        internal set
    // Every id the lifter has deleted inside a window still open. As far as the lifter is concerned the row is gone.
    val withheldIds: Set<String> get() = withheld.mapTo(mutableSetOf()) { it.subjectId }

    // Takes the open window on this subject off without asking anyone: a whole-record rewrite replaced it.
    internal fun release(subjectId: String): WithheldDelete? {
        val taking = withheld.firstOrNull { it.subjectId == subjectId && it.takeable } ?: return null
        withheld = withheld - taking
        return taking
    }
}

data class HeldWeightReceipt(val replica: String, val anonymous: Boolean, val gestureId: String, val localIds: List<String>, val weighIn: WeighIn)

object Withheld {
    // The shortest a way back ever lasts; the system's accessibility timeout may ask for longer.
    const val windowMs = 9_000L

    fun window(recommendedMs: Long): Long = maxOf(windowMs, recommendedMs)

    const val undo = "Undo"

    const val alreadyGone = "The Undo window closed."

    fun line(held: List<WithheldDelete>): String? {
        val open = held.count { it.takeable }
        if (open == 0) return null
        if (open > 1) return "$open deleted."
        val only = held.last { it.takeable }.deletion
        return only.line
    }
}
