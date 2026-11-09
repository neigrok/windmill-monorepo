package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import works.windmill.gym.R
import works.windmill.gym.presentation.Readout
import works.windmill.platform.i18n.Words
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.presentation.WeighIn

sealed interface Deletion {
    val subjectId: String

    val words: Words

    data class Set(val sessionId: String, val set: TrainingSet) : Deletion {
        override val subjectId: String get() = set.id
        override val words: Words
            get() = Words.Message(R.string.gym_store_set_deleted, listOf(Readout.weight(set.weightKg), set.reps.toString()))
    }

    data class Routine(val routineId: String, val name: String) : Deletion {
        override val subjectId: String get() = routineId
        override val words: Words get() = Words.Message(R.string.gym_store_routine_deleted, listOf(name))
    }

    data class Note(val noteId: String, val origin: Origin = Origin.List) : Deletion {
        enum class Origin(val screen: String) { List("notes"), Editor("note_editor") }

        override val subjectId: String get() = noteId
        override val words: Words get() = Words.Message(R.string.gym_store_note_deleted)
    }

    data class Bodyweight(val dateLocal: String) : Deletion {
        override val subjectId: String get() = dateLocal
        override val words: Words get() = Words.Message(R.string.gym_store_weigh_in_deleted)
    }

}

// A weigh-in the engine holds until `untilMs`, the instant its Undo offer is released.
data class WithheldDelete(val deletion: Deletion.Bodyweight, val untilMs: Long, val receipt: HeldWeightReceipt) {
    val subjectId: String get() = deletion.subjectId
}

// What this room has taken off its lists: weigh-ins inside their way back and set deletes already settled.
class HeldDeletes {
    // The engine's weigh-in holds, as their receipts project them.
    var withheld: List<WithheldDelete> by mutableStateOf(emptyList())
        internal set
    // One room's memory of its own deletes, never a tombstone: a session read BEFORE the delete would
    // otherwise draw a row that is gone.
    var deletedSets: Set<String> by mutableStateOf(emptySet())
        internal set
    // Every day the lifter has deleted inside a window still open: as far as the lifter is concerned the row is gone.
    val withheldIds: Set<String> get() = withheld.mapTo(mutableSetOf()) { it.subjectId }

    // Takes the open window on this subject off without asking anyone: a whole-record rewrite replaced it.
    internal fun release(subjectId: String): WithheldDelete? {
        val taking = withheld.firstOrNull { it.subjectId == subjectId } ?: return null
        withheld = withheld - taking
        return taking
    }
}

data class HeldWeightReceipt(val replica: String, val anonymous: Boolean, val gestureId: String, val localIds: List<String>, val weighIn: WeighIn)

object Withheld {
    // The shortest a way back ever lasts; the system's accessibility timeout may ask for longer.
    const val windowMs = 9_000L

    fun window(recommendedMs: Long): Long = maxOf(windowMs, recommendedMs)

    fun words(held: List<WithheldDelete>): Words? = when (held.size) {
        0 -> null
        1 -> held.single().deletion.words
        else -> Words.Counted(R.plurals.gym_store_deleted, held.size, listOf(held.size.toString()))
    }
}
