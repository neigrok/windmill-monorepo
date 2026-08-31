package works.windmill.gym.store

import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.TrainingSet

// Everything a lifter can delete in this room, behind one window. They share no verb — a set leaves
// through the log or through the shelf, a device-held routine leaves through `orphanRoutine` and an
// account's through the wire, a conversation and a note are server-only, a weigh-in and the
// unclaimed shelf leave this device first — so this is one abstraction over seven verbs and not a
// widened data class. What they DO share is the only thing that matters here: nothing is sent while
// the window is open, so an Undo can never arrive after the wire, and none of them asks a question
// first, because an act with a way back on screen does not get a dialog.
//
// And every one of them is held by the ROOM alone: this list, in this process, with nothing on disk,
// no queue and no retry behind it. So leaving the room lets them all go the same way — a delete a
// backgrounded app fired has nobody to read what the log answered, and one that timed out would be
// dropped in silence. That means a weigh-in delete abandoned on backgrounding puts the dot back, the
// same as every other verb here. A set's delete rides `SetQueue` on iOS and does not here; until it
// does, that is the difference between the two phones and this file is the one place it is decided.
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
    // Null where the verb has no terminal refusal at all: nothing is ever said afterwards, so
    // inventing a sentence here would pin words the room can never reach.
    val stillThere: String?

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
        override val detail: String get() = "your routine keeps what you applied"
        override val stillThere: String get() = "that conversation is still here"
    }

    data class Session(val sessionId: String) : Deletion {
        override val subjectId: String get() = sessionId
        override val line: String get() = "Session deleted."
        override val stillThere: String get() = "that session is still on the log"
    }

    data class Note(val noteId: String) : Deletion {
        override val subjectId: String get() = noteId
        override val line: String get() = "Note deleted."
        override val stillThere: String get() = "that note is still here"
    }

    // Keyed by the day, which is what the series is keyed on. The delete lands on THIS DEVICE and
    // the log is owed it by the claim, so there is no terminal refusal to say.
    //
    // The one subject here a later write can name AGAIN: every other key is a minted id nothing
    // reuses. So `TrainingStore.weighIn` takes this window down before it records — weighing the day
    // again is the undo — or the clock would delete the number the lifter had just saved.
    data class Bodyweight(val dateLocal: String) : Deletion {
        override val subjectId: String get() = dateLocal
        override val line: String get() = "Weigh-in deleted."
        override val stillThere: String? get() = null
    }

    // The shelf this phone holds for nobody. There is one of it, so the id is a constant — the
    // window is keyed by subject and the shelf has no id of its own. The last-copy fact rides in the
    // LINE and not in `detail`: it is the whole reason this delete is different from every other one
    // here, and a caption on a screen the lifter has already left cannot carry it.
    data object Unattributed : Deletion {
        override val subjectId: String get() = "unattributed"
        override val line: String get() = "Unclaimed training deleted — it was only on this phone."
        // `discardUnattributed` answers with nothing: the device is the only place it lived.
        override val stillThere: String? get() = null
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
