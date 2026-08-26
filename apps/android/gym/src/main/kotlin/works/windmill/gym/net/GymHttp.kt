package works.windmill.gym.net

import java.io.IOException
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseRename
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.NotesOrder
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalDecision
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionFinish
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite
import works.windmill.gym.store.RefusalFacts
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

// Pass every path WHOLE, query included: appending it as a path segment percent-encodes `?` and `&`.
class GymHttp(private val api: WindmillApi) : TrainingSyncing {
    override suspend fun exercises(): List<Exercise> =
        api.get<Catalog>("/v1/gym/exercises").exercises

    override suspend fun createExercise(write: ExerciseWrite): Exercise =
        api.send<Exercise>("POST", "/v1/gym/exercises", write)

    override suspend fun startSession(start: SessionStart): Session =
        api.send<Session>("POST", "/v1/gym/sessions", start)

    override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet =
        api.send<TrainingSet>("POST", "/v1/gym/sessions/$sessionId/sets", write)

    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet =
        api.send<TrainingSet>("PATCH", "/v1/gym/sessions/$sessionId/sets/$setId", fix)

    override suspend fun deleteSet(sessionId: String, setId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/sets/$setId")
    }

    override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session =
        api.send<Session>("POST", "/v1/gym/sessions/$sessionId/finish", SessionFinish(finishedAtMs))

    override suspend fun discardSession(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId")
    }

    override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        var query = "?limit=$limit"
        if (before != null) query += "&before=$before"
        if (beforeId != null) query += "&beforeId=${escaped(beforeId)}"
        return api.get<Log>("/v1/gym/sessions$query").sessions
    }

    override suspend fun session(id: String): SessionDetail? = try {
        api.get<SessionDetail>("/v1/gym/sessions/$id")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun review(sessionId: String): Review =
        api.get<Review>("/v1/gym/sessions/$sessionId/review")

    override suspend fun lastTime(exerciseId: String): LastTime =
        api.get<LastTime>("/v1/gym/last?exercise=${escaped(exerciseId)}")

    override suspend fun lastSets(): List<LastSet> =
        api.get<LastSets>("/v1/gym/exercises/last").movements

    override suspend fun routines(): List<Routine> =
        api.get<Routines>("/v1/gym/routines").routines

    override suspend fun routine(id: String): Routine? = try {
        api.get<Routine>("/v1/gym/routines/$id")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun createRoutine(write: RoutineWrite): Routine =
        api.send<Routine>("POST", "/v1/gym/routines", write)

    override suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine =
        api.send<Routine>("PUT", "/v1/gym/routines/$id", write)

    override suspend fun deleteRoutine(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/routines/$id")
    }

    override suspend fun proposal(id: String): Proposal? = try {
        api.get<Proposal>("/v1/gym/proposals/$id")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun applyProposal(id: String): ProposalDecision =
        api.send<ProposalDecision>("POST", "/v1/gym/proposals/$id/apply")

    override suspend fun dismissProposal(id: String): ProposalDecision =
        api.send<ProposalDecision>("POST", "/v1/gym/proposals/$id/dismiss")

    override suspend fun record(exerciseId: String): MovementRecord? = try {
        api.get<MovementRecord>("/v1/gym/exercises/$exerciseId/record")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun renameExercise(exerciseId: String, name: String): Exercise =
        api.send<Exercise>("PATCH", "/v1/gym/exercises/$exerciseId", ExerciseRename(name))

    override suspend fun share(sessionId: String): SessionShare =
        api.send<SessionShare>("POST", "/v1/gym/sessions/$sessionId/share")

    override suspend fun revokeShare(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/share")
    }

    override suspend fun preferences(): GymPreferences =
        api.get<GymPreferences>("/v1/gym/preferences")

    // WindmillJson omits a value equal to its declared default; the route reads an omitted field as
    // that default.
    override suspend fun savePreferences(document: GymPreferences): GymPreferences =
        api.send<GymPreferences>("PUT", "/v1/gym/preferences", document)

    // A 404 here means the route is absent from the deployment, not a missing object.
    override suspend fun ask(question: AskQuestion): AskAnswer =
        api.send<AskAnswer>("POST", "/v1/gym/ask", question)

    override suspend fun threads(): List<AskThread> =
        api.get<Conversations>("/v1/gym/threads").threads

    override suspend fun thread(id: String): AskThread? = try {
        api.get<AskThread>("/v1/gym/threads/$id")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun deleteThread(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/threads/$id")
    }

    override suspend fun notes(): List<Note> =
        api.get<NotesPage>("/v1/gym/notes").notes

    override suspend fun writeNote(id: String, write: NoteWrite): Note =
        api.send<NoteReply>("PUT", "/v1/gym/notes/$id", write).note

    override suspend fun deleteNote(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/notes/$id")
    }

    override suspend fun reorderNotes(order: List<String>): List<Note> =
        api.send<NotesPage>("PUT", "/v1/gym/notes", NotesOrder(order)).notes

    override suspend fun bodyweight(from: String?, to: String?): List<WeighIn> {
        val bounds = listOfNotNull(from?.let { "from=${escaped(it)}" }, to?.let { "to=${escaped(it)}" })
        val query = if (bounds.isEmpty()) "" else "?" + bounds.joinToString("&")
        return api.get<BodyweightPage>("/v1/gym/bodyweight$query").entries
    }

    // The date rides raw in the path, as every id does: digits and hyphens need no escaping.
    override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn =
        api.send<WeighInReply>("PUT", "/v1/gym/bodyweight/$dateLocal", write).entry

    override suspend fun deleteBodyweight(dateLocal: String) {
        api.send<Unit>("DELETE", "/v1/gym/bodyweight/$dateLocal")
    }

    private fun escaped(value: String): String = buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val code = byte.toInt() and 0xFF
            val char = code.toChar()
            if (char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9') append(char)
            else append("%%%02X".format(code))
        }
    }
}

// No facts reads as Retry: a set is never dropped on a guess.
fun RefusalFacts(refusing: Throwable): RefusalFacts = when (refusing) {
    is WindmillApiException.Offline -> RefusalFacts(offline = true)
    is IOException -> RefusalFacts(offline = true)
    is WindmillApiException.Malformed -> RefusalFacts(malformed = true)
    is WindmillApiException.Refused -> RefusalFacts(
        status = refusing.status, code = refusing.refusal.code, sentence = refusing.refusal.message)
    else -> RefusalFacts()
}

@Serializable
private data class Catalog(val exercises: List<Exercise>)

@Serializable
private data class LastSets(val movements: List<LastSet> = emptyList())

@Serializable
private data class Log(val sessions: List<SessionSummary>)

@Serializable
private data class Routines(val routines: List<Routine>)

@Serializable
private data class Conversations(val threads: List<AskThread> = emptyList())

@Serializable
private data class NotesPage(val notes: List<Note> = emptyList())

@Serializable
private data class NoteReply(val note: Note)

@Serializable
private data class BodyweightPage(val entries: List<WeighIn> = emptyList())

@Serializable
private data class WeighInReply(val entry: WeighIn)
