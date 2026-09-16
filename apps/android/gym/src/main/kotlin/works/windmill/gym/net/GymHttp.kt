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
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.StatsProgress
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.OAuthGrant
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
        api.get<Catalog>("/v1/gym/exercises", operation = "gym_exercises").exercises

    override suspend fun createExercise(write: ExerciseWrite): Exercise =
        api.send<Exercise>("POST", "/v1/gym/exercises", write, operation = "gym_create_exercise")

    override suspend fun startSession(start: SessionStart): Session =
        api.send<Session>("POST", "/v1/gym/sessions", start, operation = "gym_start_session")

    override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet =
        api.send<TrainingSet>("POST", "/v1/gym/sessions/$sessionId/sets", write, operation = "gym_append_set")

    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet =
        api.send<TrainingSet>("PATCH", "/v1/gym/sessions/$sessionId/sets/$setId", fix, operation = "gym_fix_set")

    override suspend fun deleteSet(sessionId: String, setId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/sets/$setId", operation = "gym_delete_set")
    }

    override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session =
        api.send<Session>("POST", "/v1/gym/sessions/$sessionId/finish", SessionFinish(finishedAtMs), operation = "gym_finish_session")

    override suspend fun discardSession(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId", operation = "gym_discard_session")
    }

    override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        var query = "?limit=$limit"
        if (before != null) query += "&before=$before"
        if (beforeId != null) query += "&beforeId=${escaped(beforeId)}"
        return api.get<Log>("/v1/gym/sessions$query", operation = "gym_sessions").sessions
    }

    override suspend fun session(id: String): SessionDetail? = try {
        api.get<SessionDetail>("/v1/gym/sessions/$id", operation = "gym_session")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun review(sessionId: String): Review =
        api.get<Review>("/v1/gym/sessions/$sessionId/review", operation = "gym_review")

    override suspend fun lastTime(exerciseId: String): LastTime =
        api.get<LastTime>("/v1/gym/last?exercise=${escaped(exerciseId)}", operation = "gym_last_time")

    override suspend fun lastSets(): List<LastSet> =
        api.get<LastSets>("/v1/gym/exercises/last", operation = "gym_last_sets").movements

    override suspend fun routines(): List<Routine> =
        api.get<Routines>("/v1/gym/routines", operation = "gym_routines").routines

    override suspend fun routine(id: String): Routine? = try {
        api.get<Routine>("/v1/gym/routines/$id", operation = "gym_routine")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun createRoutine(write: RoutineWrite): Routine =
        api.send<Routine>("POST", "/v1/gym/routines", write, operation = "gym_create_routine")

    override suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine =
        api.send<Routine>("PUT", "/v1/gym/routines/$id", write, operation = "gym_replace_routine")

    override suspend fun deleteRoutine(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/routines/$id", operation = "gym_delete_routine")
    }

    override suspend fun proposal(id: String): Proposal? = try {
        api.get<Proposal>("/v1/gym/proposals/$id", operation = "gym_proposal")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun applyProposal(id: String): ProposalDecision =
        api.send<ProposalDecision>("POST", "/v1/gym/proposals/$id/apply", operation = "gym_apply_proposal")

    override suspend fun dismissProposal(id: String): ProposalDecision =
        api.send<ProposalDecision>("POST", "/v1/gym/proposals/$id/dismiss", operation = "gym_dismiss_proposal")

    override suspend fun progress(): StatsProgress = api.get("/v1/gym/stats?projection=progress", operation = "gym_progress")

    override suspend fun record(exerciseId: String): MovementRecord? = try {
        api.get<MovementRecord>("/v1/gym/exercises/$exerciseId/record", operation = "gym_record")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun renameExercise(exerciseId: String, name: String): Exercise =
        api.send<Exercise>("PATCH", "/v1/gym/exercises/$exerciseId", ExerciseRename(name), operation = "gym_rename_exercise")

    override suspend fun share(sessionId: String): SessionShare =
        api.send<SessionShare>("POST", "/v1/gym/sessions/$sessionId/share", operation = "gym_share")

    override suspend fun revokeShare(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/share", operation = "gym_revoke_share")
    }

    override suspend fun preferences(): GymPreferences =
        api.get<GymPreferences>("/v1/gym/preferences", operation = "gym_preferences")

    // WindmillJson omits a value equal to its declared default; the route reads an omitted field as
    // that default.
    override suspend fun savePreferences(document: GymPreferences): GymPreferences =
        api.send<GymPreferences>("PUT", "/v1/gym/preferences", document, operation = "gym_save_preferences")

    // A 404 here means the route is absent from the deployment, not a missing object.
    override suspend fun ask(question: AskQuestion): AskAnswer =
        api.send<AskAnswer>("POST", "/v1/gym/ask", question, timeoutSeconds = 660, operation = "gym_ask")

    override suspend fun threads(): List<AskThread> =
        api.get<Conversations>("/v1/gym/threads", operation = "gym_threads").threads

    override suspend fun thread(id: String): AskThread? = try {
        api.get<AskThread>("/v1/gym/threads/$id", operation = "gym_thread")
    } catch (refused: WindmillApiException.Refused) {
        if (refused.status == 404) null else throw refused
    }

    override suspend fun deleteThread(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/threads/$id", operation = "gym_delete_thread")
    }

    override suspend fun notes(): List<Note> =
        api.get<NotesPage>("/v1/gym/notes", operation = "gym_notes").notes

    override suspend fun writeNote(id: String, write: NoteWrite): Note =
        api.send<NoteReply>("PUT", "/v1/gym/notes/$id", write, operation = "gym_write_note").note

    override suspend fun deleteNote(id: String) {
        api.send<Unit>("DELETE", "/v1/gym/notes/$id", operation = "gym_delete_note")
    }

    override suspend fun reorderNotes(order: List<String>): List<Note> =
        api.send<NotesPage>("PUT", "/v1/gym/notes", NotesOrder(order), operation = "gym_reorder_notes").notes

    override suspend fun bodyweight(from: String?, to: String?): List<WeighIn> {
        val bounds = listOfNotNull(from?.let { "from=${escaped(it)}" }, to?.let { "to=${escaped(it)}" })
        val query = if (bounds.isEmpty()) "" else "?" + bounds.joinToString("&")
        return api.get<BodyweightPage>("/v1/gym/bodyweight$query", operation = "gym_bodyweight").entries
    }

    // The date rides raw in the path, as every id does: digits and hyphens need no escaping.
    override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn =
        api.send<WeighInReply>("PUT", "/v1/gym/bodyweight/$dateLocal", write, operation = "gym_put_bodyweight").entry

    override suspend fun deleteBodyweight(dateLocal: String) {
        api.send<Unit>("DELETE", "/v1/gym/bodyweight/$dateLocal", operation = "gym_delete_bodyweight")
    }

    override suspend fun grants(): List<OAuthGrant> =
        api.get<Grants>("/v1/oauth/grants", operation = "gym_grants").grants

    override suspend fun mcpKeys(): List<McpKey> =
        api.get<Keys>("/v1/mcp-keys", operation = "gym_mcp_keys").keys

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

@Serializable
private data class Grants(val grants: List<OAuthGrant> = emptyList())

@Serializable
private data class Keys(val keys: List<McpKey> = emptyList())
