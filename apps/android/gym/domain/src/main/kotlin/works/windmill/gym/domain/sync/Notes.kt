package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class Note(override val id: Id<Note>, val title: String = "", val body: String = "", val updatedAt: Instant? = null) : Writable<Note> {
    override fun fields(): Map<String, Json> = mapOf("title" to Json.of(title), "body" to Json.of(body))

    companion object : DraftableType<Note>, RemovableType<Note>, OrderedType<Note> {
        override val type = Gym.Types.note
        override val scope = ScopeRef(Gym.scope)
        override val orderField = "ord"
        override val savesGuarded = true
        override val heldRemoval = true
        override fun decode(f: Fields) = Note(Id(f.id, this), f.string("title"), f.string("body", ""), f.optionalInstant("updatedAt"))
        override val checks = listOf(
            Check<Note>("title") { note, _ -> note.copy(title = NoteRules.title.apply(note.title, Path("title"))) },
            Check<Note>("body") { note, _ -> note.copy(body = NoteRules.body.apply(note.body, Path("body"))) },
        )
        fun position(id: Id<Note>, stored: List<Note>): Int? = stored.indexOfFirst { it.id == id }.takeIf { it >= 0 }
    }
}

object NoteRules {
    val title = TextSpec("note.title", MeasureUnit.chars, 1, 60, trim = true, nfc = true)
    val body = TextSpec("note.body", MeasureUnit.bytes, 0, 500, trim = true, nfc = true)
    val rules = listOf(Rule.local(title), Rule.local(body))
}

class SaveNoteCall(val note: Note) : Action<SaveNoteCall.Loaded, Id<Note>, GymRefusal> {
    data class Loaded(val save: SaveDraftLoaded<Note>, val stored: List<Note>, val slots: Capacity)
    override val scope = Note.scope
    override val refusals = GymRefusal
    val save get() = SaveDraft(note, Note, GymRefusal, Placement.Bottom)
    override fun load(read: Reader): Loaded {
        val notes = read.repository(Note)
        return Loaded(save.load(read), notes.all(works.windmill.sync.api.ViewMode.stored), notes.capacity())
    }
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Id<Note>, GymRefusal> {
        return when (val decided = save.decision(loaded.save, ids)) {
            is Decision.Unchanged -> Decision.Unchanged(note.id)
            is Decision.Refuse -> if (decided.refusal is GymRefusal.Taken) Decision.Unchanged(note.id) else decided
            is Decision.Write -> {
                val same = loaded.stored.firstOrNull { it.fields() == decided.result.values }
                if (same != null) return Decision.Unchanged(same.id)
                val full = loaded.slots.refusal(1, note.id.ref)
                if (full != null) return Decision.Refuse(GymRefusal.of(full))
                Decision.Write(decided.plan, note.id)
            }
        }
    }
}

fun saveNote(note: Note) = SaveDraft(note, Note, GymRefusal)
fun deleteNote(id: Id<Note>) = Remove(Note, id, GymRefusal)
fun moveNote(id: Id<Note>, below: Id<Note>?) = Move(Note, id, below, GymRefusal)
