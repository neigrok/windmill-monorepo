package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.presentation.Note
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.store.TrainingSeat.Companion.accountChange
import works.windmill.platform.telemetry.Telemetry

// The notebook of the seat in hand. The first pull distinguishes an unread notebook from an empty one.
class NotesStore(
    private val seat: TrainingSeat,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val telemetry: Telemetry,
) {
    private val notebookWrite = Mutex()

    private var notebook: List<Note> by mutableStateOf(emptyList())
    var notesRead by mutableStateOf(false)
        private set
    var noteRefusals: List<RefusedWrite> by mutableStateOf(emptyList())
        private set
    val all: List<Note> get() = notebook
    val noteCount: Int get() = notebook.size

    internal fun forgetSeat() {
        notebook = emptyList()
        notesRead = false
        noteRefusals = emptyList()
    }

    internal fun forgetRefusals() { noteRefusals = emptyList() }

    // The engine refresh's read, for the seat that asked.
    internal suspend fun reread(owner: String?): Unit = notebookWrite.withLock {
        if (owner != seat.owner) return@withLock
        readNotebook()
    }

    private suspend fun readNotebook(): List<Note> {
        val (notes, ready, refusals) = seat.readTraining {
            Triple(training.notes(), training.notesReady, training.refusedNotes())
        }
        notebook = notes
        notesRead = ready
        noteRefusals = refusals
        return notes
    }

    // A refused save keeps its receipt and submitted words.
    suspend fun readNotes(): GymResult<List<Note>> {
        val owner = seat.owner
        return try {
            notebookWrite.withLock {
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
                GymResult.Ok(readNotebook())
            }
        } catch (failed: Exception) {
            if (!currentCoroutineContext().isActive) throw failed
            if (failed is TrainingReadChanged) {
                if (owner != seat.owner) return GymResult.Failed(WriteFailure.Refused(accountChange))
                return GymResult.Failed(WriteFailure.NoAnswer)
            }
            seat.reportFailure("gym.readNotes", failed)
            GymResult.Failed(WriteFailure.NoAnswer)
        }
    }

    suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> {
        if (!seat.workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChange))
        val owner = seat.owner
        val result: GymResult<Note> = notebookWrite.withLock {
            if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
            try {
                val written = training.writeNote(id, write)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
                notebook = if (notebook.any { it.id == id }) notebook.map { if (it.id == id) written else it }
                    else notebook + written
                GymResult.Ok(written)
            } catch (refusing: Exception) {
                if (!currentCoroutineContext().isActive) throw refusing
                seat.reportFailure("gym.saveNote", refusing)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
        telemetry.event("gym_action", mapOf("screen" to "note_editor", "action" to "save",
            "outcome" to when (result) {
                is GymResult.Ok -> "ok"
                is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
            }))
        return result
    }

    // A note already gone answers as success: the row goes either way.
    suspend fun deleteNote(id: String, replica: String? = controls.engineReplica, anonymous: Boolean = seat.owner == null): WriteFailure? {
        if (!seat.workoutAuthorized) return WriteFailure.Refused(accountChange)
        val owner = seat.owner
        return notebookWrite.withLock {
            if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChange)
            try {
                training.deleteNote(id, replica ?: return@withLock WriteFailure.Refused(accountChange), anonymous)
                if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChange)
                notebook = notebook.filterNot { it.id == id }
                null
            } catch (refusing: Exception) {
                if (!currentCoroutineContext().isActive) throw refusing
                seat.reportFailure("gym.deleteNote", refusing)
                if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChange)
                if (refusing is TrainingDeleteUnconfirmed) seat.tried("gym.readNotes") { readNotebook() }
                if ((refusing as? TrainingRefused)?.code != "unknown-record") return@withLock WriteFailure(refusing)
                notebook = notebook.filterNot { it.id == id }
                null
            }
        }
    }

    // A drop moves its one note below the drawn neighbor.
    suspend fun reorderNotes(moved: String, drawn: List<String>): GymResult<List<Note>> {
        if (!seat.workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChange))
        val owner = seat.owner
        return notebookWrite.withLock {
            if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
            try {
                val changed = training.moveNote(moved, drawn)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
                val written = training.notes()
                notebook = written
                if (changed) telemetry.event("gym_note_moved")
                GymResult.Ok(written)
            } catch (refusing: Exception) {
                if (!currentCoroutineContext().isActive) throw refusing
                seat.reportFailure("gym.reorderNotes", refusing)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChange))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }
}
