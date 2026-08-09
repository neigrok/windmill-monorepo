package works.windmill.gym.net

import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionFinish
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.TrainingStatistics
import works.windmill.gym.store.RefusalFacts
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

// The one place the native gym talks to the backend — the twin of the iOS GymApi and of
// web/src/products/gym/gymApi.js, against the same routes:
//   GET  /v1/gym/exercises            ·  POST /v1/gym/exercises
//   POST /v1/gym/sessions             ·  POST /v1/gym/sessions/:id/sets
//   POST /v1/gym/sessions/:id/finish  ·  DELETE /v1/gym/sessions/:id
//   GET  /v1/gym/sessions?before=&beforeId=&limit=   ·  GET /v1/gym/sessions/:id
//   GET  /v1/gym/sessions/:id/review  ·  GET /v1/gym/last?exercise=
//   GET  /v1/gym/routines             ·  POST /v1/gym/routines
//   PUT  /v1/gym/routines/:id         ·  DELETE /v1/gym/routines/:id
//   GET  /v1/gym/stats
//   POST /v1/gym/sessions/:id/share   ·  DELETE /v1/gym/sessions/:id/share
// The session rides as a Bearer header rather than a cookie (WindmillApi); nothing else differs.
//
// `GET /v1/gym/shared/:token` — the coach's own read, and the one unauthenticated route in the
// product — is deliberately NOT here. Nothing on this phone reads a shared session: the lifter is
// the owner and reads their own log through the eighteen owner-scoped doors above. The token this
// client mints is spelled as an address for somebody else to open (CoachShare.kt).
//
// EVERY PATH IS PASSED WHOLE, query included. A path-segment append percent-encodes `?` and `&`
// into the path and silently 404s every endpoint carrying a query — WindmillApi resolves the whole
// string against the base, and the platform's request tests exist to keep that fixed.
class GymHttp(private val api: WindmillApi) : TrainingSyncing {
    override suspend fun exercises(): List<Exercise> =
        api.get<Catalog>("/v1/gym/exercises").exercises

    override suspend fun createExercise(write: ExerciseWrite): Exercise =
        api.send<Exercise>("POST", "/v1/gym/exercises", write)

    override suspend fun startSession(start: SessionStart): Session =
        api.send<Session>("POST", "/v1/gym/sessions", start)

    override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet =
        api.send<TrainingSet>("POST", "/v1/gym/sessions/$sessionId/sets", write)

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

    // The long window, computed on every read and cached nowhere — server-side or here. There is no
    // parameter: the window is the whole finished log, and a client that asked for a slice of it
    // would be the second place in the product deciding what a week is.
    override suspend fun statistics(): TrainingStatistics =
        api.get<TrainingStatistics>("/v1/gym/stats")

    override suspend fun share(sessionId: String): SessionShare =
        api.send<SessionShare>("POST", "/v1/gym/sessions/$sessionId/share")

    override suspend fun revokeShare(sessionId: String) {
        api.send<Unit>("DELETE", "/v1/gym/sessions/$sessionId/share")
    }

    // Ids are [A-Za-z0-9_-] by the server's own rule, so this only ever has work to do on the two
    // punctuation marks in that set — and doing it anyway costs nothing and cannot be forgotten
    // later, when an id from somewhere else reaches a query string.
    private fun escaped(value: String): String = buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val code = byte.toInt() and 0xFF
            val char = code.toChar()
            if (char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9') append(char)
            else append("%%%02X".format(code))
        }
    }
}

// The platform's exception, stripped to the facts the verdicts read — so the four verdicts stay a
// rule the store module proves on the JVM without importing the network. Anything that is not a
// refusal with a status — a transport failure, a reply this build could not read, an exception
// nobody has met — carries no facts at all, and no facts is Retry: replay is free, and a set is
// never dropped on a guess. A refusal that arrived without a sentence stays sentence-less here;
// the fallback ("the log refused this set") is Verdict's own.
fun RefusalFacts(refusing: Throwable): RefusalFacts = when (refusing) {
    is WindmillApiException.Offline -> RefusalFacts(offline = true)
    is WindmillApiException.Malformed -> RefusalFacts(malformed = true)
    is WindmillApiException.Refused -> RefusalFacts(
        status = refusing.status, code = refusing.refusal.code, sentence = refusing.refusal.message)
    else -> RefusalFacts()
}

@Serializable
private data class Catalog(val exercises: List<Exercise>)

@Serializable
private data class Log(val sessions: List<SessionSummary>)

@Serializable
private data class Routines(val routines: List<Routine>)
