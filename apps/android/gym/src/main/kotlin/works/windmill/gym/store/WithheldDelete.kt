package works.windmill.gym.store

import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.TrainingSet

// The four things a lifter can delete in this room, behind one window. They share no verb — a set
// leaves through the log or through the shelf, a device-held routine leaves through `orphanRoutine`
// and an account's through the wire, a conversation is server-only — so this is one abstraction over
// four verbs and not a widened data class. What they DO share is the only thing that matters here:
// nothing is sent while the window is open, so an Undo can never arrive after the wire.
//
// And every one of them is held by the ROOM alone: this list, in this process, with nothing on disk,
// no queue and no retry behind it. So leaving the room lets all four go the same way — a delete a
// backgrounded app fired has nobody to read what the log answered, and one that timed out would be
// dropped in silence. A set's delete rides `SetQueue` on iOS and does not here; until it does, that
// is the difference between the two phones and this file is the one place it is decided.
sealed interface Deletion {
    // What the window is keyed on. One window per subject, and the id every list filters against.
    val subjectId: String

    // What the transient says while the window is open.
    val line: String

    // The fact the act carries with it, said at the MOMENT of the act rather than as a caption
    // standing on some other screen. Only the conversation has one, and only while it is the whole
    // of what is held — a count has no one detail to carry.
    val detail: String? get() = null

    // The tail of the sentence a refusal is said in, after the window closed and the log said no.
    val stillThere: String

    // The set travels WHOLE: it is the last copy while the window is open, and Undo has to put it
    // back exactly.
    data class Set(val sessionId: String, val set: TrainingSet) : Deletion {
        override val subjectId: String get() = set.id
        // The room's own weight rendering, and this room draws kilograms and says so.
        override val line: String
            get() = "${Readout.weight(set.weightKg)} kg × ${set.reps} is out of the log."
        override val stillThere: String get() = "that set is still on the log"
    }

    data class Routine(val routineId: String, val name: String) : Deletion {
        override val subjectId: String get() = routineId
        override val line: String get() = "$name deleted."
        override val stillThere: String get() = "$name is still in your program"
    }

    data class Thread(val threadId: String) : Deletion {
        override val subjectId: String get() = threadId
        override val line: String get() = "Conversation deleted."
        // What deleting a conversation does NOT take with it. It used to be a standing caption three
        // screens deep, where nobody stood at the moment they deleted anything.
        override val detail: String get() = "a change you applied stays in the routine’s history"
        override val stillThere: String get() = "that conversation is still here"
    }

    data class Session(val sessionId: String) : Deletion {
        override val subjectId: String get() = sessionId
        override val line: String get() = "Session deleted."
        override val stillThere: String get() = "that session is still on the log"
    }
}

// A delete this device has made and has NOT told the log about. `sent` is the moment the window
// stops being the lifter's — the delete is on the wire and there is no way back — while the row
// stays in the list until the log answers, so a settle cancelled mid-flight is still owed and the
// next one re-sends it.
data class WithheldDelete(
    val deletion: Deletion,
    val untilMs: Long,
    val sent: Boolean = false,
) {
    val subjectId: String get() = deletion.subjectId
    val takeable: Boolean get() = !sent
}

// The window holds MORE than one: each delete carries its own clock and a second one never settles
// the first. One held thing NAMES what left; two or more can only be counted, because a transient
// that named one of them would be saying the wrong thing about the others. Undo takes the newest
// back and the transient re-reads for the rest.
//
// A set just LOGGED has a way back on the same clock, and it is held in this same transient — so it
// is counted here too. It is the one thing in the window that is not a delete, which is exactly why
// the count has two spellings: `2 deleted.` is a lie the moment an append is among them.
//
// The same bytes on all three surfaces.
object Withheld {
    const val undo = "Undo"

    // Said when Undo is pressed a frame after the clock fired: the log has it, and pretending
    // otherwise would be the one lie this whole mechanism exists to prevent.
    const val alreadyGone = "The window closed — that delete already went."

    // The room's own weight rendering, in the shape every other line here takes: the subject first,
    // then what happened to it.
    fun logged(set: TrainingSet): String =
        "${Readout.weight(set.weightKg)} kg × ${set.reps} logged."

    fun line(held: List<WithheldDelete>, justLogged: TrainingSet? = null): String? {
        val deletes = held.count { it.takeable }
        val open = deletes + if (justLogged == null) 0 else 1
        if (open == 0) return null
        if (open > 1) return if (justLogged == null) "$open deleted." else "$open to take back."
        if (justLogged != null) return logged(justLogged)
        val only = held.last { it.takeable }.deletion
        return only.detail?.let { "${only.line}\n$it" } ?: only.line
    }
}
