package works.windmill.gym.store

import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn

sealed interface Deletion {
    sealed interface Recoverable : Deletion
    val subjectId: String

    val line: String

    val detail: String? get() = null

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

    data class Thread(val threadId: String) : Recoverable {
        override val subjectId: String get() = threadId
        override val line: String get() = "Conversation deleted."
        override val detail: String get() = "your routine keeps what you applied"
        override val stillThere: String get() = "that conversation is still here"
    }

    data class Session(val sessionId: String) : Recoverable {
        override val subjectId: String get() = sessionId
        override val line: String get() = "Session deleted."
        override val stillThere: String get() = "that session is still on the log"
    }

    data class Note(val noteId: String) : Deletion {
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

data class HeldWeightReceipt(val replica: String, val anonymous: Boolean, val gestureId: String, val localIds: List<String>, val weighIn: WeighIn)

object Withheld {
    const val windowMs = 9_000L

    const val undo = "Undo"

    const val alreadyGone = "The Undo window closed."

    fun line(held: List<WithheldDelete>): String? {
        val open = held.count { it.takeable }
        if (open == 0) return null
        if (open > 1) return "$open deleted."
        val only = held.last { it.takeable }.deletion
        return only.detail?.let { "${only.line}\n$it" } ?: only.line
    }
}
