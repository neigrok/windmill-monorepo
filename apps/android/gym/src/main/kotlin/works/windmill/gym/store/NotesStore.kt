package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.presentation.Note
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry

// The notebook of the seat in hand. The first pull distinguishes an unread notebook from an empty one.
class NotesStore(
    private val seat: TrainingSeat,
    private val held: HeldDeletes,
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
    internal suspend fun reread(owner: String?) = notebookWrite.withLock {
        if (owner != seat.owner) return@withLock
        notebook = training.notes()
        notesRead = training.notesReady
        noteRefusals = training.refusedNotes()
    }

    // Notes are read from the replica of the seat in hand. A refused save keeps its receipt and its
    // submitted words.
    suspend fun readNotes(): GymResult<List<Note>> {
        val owner = seat.owner
        return notebookWrite.withLock {
            if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            val served = training.notes()
            notebook = served
            notesRead = training.notesReady
            noteRefusals = training.refusedNotes()
            GymResult.Ok(served)
        }
    }

    suspend fun saveNote(id: String, write: NoteWrite): GymResult<Note> {
        if (!seat.workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val owner = seat.owner
        val result: GymResult<Note> = notebookWrite.withLock {
            if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val written = training.writeNote(id, write)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                notebook = if (notebook.any { it.id == id }) notebook.map { if (it.id == id) written else it }
                    else notebook + written
                GymResult.Ok(written)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                seat.reportFailure("gym.saveNote", refusing)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
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
        if (!seat.workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val owner = seat.owner
        return notebookWrite.withLock {
            if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChanged)
            try {
                training.deleteNote(id, replica ?: return@withLock WriteFailure.Refused(accountChanged), anonymous)
                if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChanged)
                notebook = notebook.filterNot { it.id == id }
                null
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                seat.reportFailure("gym.deleteNote", refusing)
                if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChanged)
                if (refusing is TrainingDeleteUnconfirmed) seat.tried("gym.readNotes") { notebook = training.notes() }
                if ((refusing as? TrainingRefused)?.code != "unknown-record") return@withLock WriteFailure(refusing)
                notebook = notebook.filterNot { it.id == id }
                null
            }
        }
    }

    // A drop moves its one note below the drawn neighbor.
    suspend fun reorderNotes(moved: String, drawn: List<String>): GymResult<List<Note>> {
        if (!seat.workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val owner = seat.owner
        return notebookWrite.withLock {
            if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val changed = training.moveNote(moved, drawn, held.withheldIds)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                val written = training.notes()
                notebook = written
                if (changed) telemetry.event("gym_note_moved")
                GymResult.Ok(written)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                seat.reportFailure("gym.reorderNotes", refusing)
                if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }
}
