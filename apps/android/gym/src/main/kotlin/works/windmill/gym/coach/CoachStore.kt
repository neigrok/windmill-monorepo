package works.windmill.gym.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.domain.Ids
import works.windmill.gym.net.GymRest
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.Seat
import works.windmill.gym.store.TrainingRefused
import works.windmill.gym.store.TrainingUnanswered
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry

class CoachStore internal constructor(
    private val accountOwner: () -> String?,
    private val withheldIds: () -> Set<String>,
    private val onProgramChanged: () -> Unit,
    private val rest: () -> GymRest?,
    private val localCoach: LocalCoach?,
    private val telemetry: Telemetry,
    private val elapsedNanos: () -> Long,
    private val scope: CoroutineScope,
) {
    private val owner: String? get() = accountOwner()
    val accountKey: String get() = Seat.of(owner)
    private val conversationWrite = Mutex()

    private fun reportFailure(operation: String, error: Exception) {
        if (error is WindmillApiException || error is TrainingRefused || error is TrainingUnanswered || error is CancellationException) return
        telemetry.failure(operation, error)
    }

    internal fun resetThreads() {
        conversations = emptyList()
        confirmations = emptyMap()
        nextThreadCursor = null
    }

    private companion object {
        const val accountChanged = "The account changed. Open this again."
        const val signInFirst = "Sign in first."
        const val noSuchThread = "that conversation is no longer on the log"
    }

    // Newest first; every screen reads the same list so settled deletes stay removed.
    private var conversations: List<AskThread> by mutableStateOf(emptyList())
    // Undo hides rows; the empty stance still counts everything the account holds.
    val threads: List<AskThread> get() = conversations.filterNot { it.id in withheldIds() }
    val allThreads: List<AskThread> get() = conversations

    fun pendingQuestions(): List<AskQuestion> = try {
        owner?.let { localCoach?.pending(it) }.orEmpty()
    } catch (failure: Exception) {
        reportFailure("gym.restoreConversation", failure)
        emptyList()
    }

    private val drafts = mutableMapOf<Pair<String, String>, CoachDraft>()
    var draftVersion by mutableStateOf(0)
        private set

    fun draft(key: String): CoachDraft = owner?.let { seat ->
        localCoach?.draft(seat, key) ?: drafts[seat to key]
    } ?: CoachDraft()

    fun saveDraft(key: String, draft: CoachDraft) {
        val seat = owner ?: return
        if (draft(key) == draft && (drafts[seat to key] ?: CoachDraft()) == draft) return
        localCoach?.saveDraft(seat, key, draft)
        drafts[seat to key] = draft
        draftVersion++
    }

    fun abandon(threadId: String) {
        val seat = owner ?: return
        localCoach?.clear(seat, threadId)
        drafts.remove(seat to threadId)
        draftVersion++
    }

    suspend fun importPhoto(key: String, resolver: android.content.ContentResolver, uri: android.net.Uri) {
        val seat = owner ?: error(signInFirst)
        val disk = localCoach ?: error("Photo storage is unavailable.")
        val (photo, bytes) = withContext(Dispatchers.IO) { CoachPhotos.read(resolver, uri) }
        check(seat == owner) { accountChanged }
        withContext(Dispatchers.IO) { disk.savePhoto(seat, photo.id, bytes) }
        if (seat == owner) saveDraft(key, draft(key).copy(photo = photo))
    }

    suspend fun photo(threadId: String, photo: CoachAttachment): ByteArray {
        val seat = owner ?: error(signInFirst)
        val coach = rest() ?: error(signInFirst)
        val cached = localCoach?.photoFile(seat, photo.id)
        val bytes = if (cached?.isFile == true) withContext(Dispatchers.IO) { cached.readBytes() }
            else coach.photo(threadId, photo.id)
        check(seat == owner) { accountChanged }
        return bytes
    }

    suspend fun stop(threadId: String, requestId: String): AskGeneration {
        val seat = owner ?: error(signInFirst)
        val coach = rest() ?: error(signInFirst)
        val generation = coach.stop(threadId, requestId)
        check(seat == owner) { accountChanged }
        withContext(Dispatchers.IO) { localCoach?.record(seat, generation) }
        check(seat == owner) { accountChanged }
        val current = localCoach?.snapshot(seat, requestId) ?: generation
        if (current.status in listOf("completed", "stopped")) withContext(Dispatchers.IO) { localCoach?.clear(seat, threadId, requestId) }
        check(seat == owner) { accountChanged }
        return current
    }

    private var confirmations by mutableStateOf<Map<Pair<String, String>, CoachRoutineConfirmation>>(emptyMap())
    private val routineConfirmation = Mutex()

    fun confirmedGeneration(requestId: String): AskGeneration? = owner?.let { seat ->
        confirmations[seat to requestId]?.generation ?: localCoach?.confirmed(seat, requestId)
    }

    // Runs in the store's scope, so leaving Coach mid-save still lands the routine, its refresh and its outcome.
    // A save the log confirmed stands even when this phone fails to keep its copy.
    suspend fun confirmRoutine(threadId: String, requestId: String, draft: CoachRoutineDraft): DraftOutcome {
        val seat = owner ?: return DraftOutcome.Failed(Ask.draftSignIn)
        val coach = rest() ?: return DraftOutcome.Failed(Ask.draftSignIn)
        return scope.async {
            routineConfirmation.withLock {
                if (seat != owner) return@withLock DraftOutcome.Failed(accountChanged)
                confirmedGeneration(requestId)?.takeIf { generation -> generation.routineDrafts.any { it.operationId == draft.operationId && it.state == "saved" } }
                    ?.let { return@withLock DraftOutcome.Saved(it) }
                telemetry.event("gym_coach_routine_confirm", mapOf("outcome" to "started"))
                val reply = try {
                    coach.confirmRoutine(threadId, requestId, draft.operationId).also { reply ->
                        if (reply.thread != threadId || reply.generation.requestId != requestId ||
                            reply.generation.routineDrafts.none { it.operationId == draft.operationId && it.routineId == draft.routineId && it.state == "saved" }) error("routine-confirmation-mismatch")
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    reportFailure("gym.coachRoutineConfirm", failure)
                    val refused = failure is WindmillApiException.Refused && failure.status in 400..499
                    telemetry.event("gym_coach_routine_confirm", mapOf("outcome" to if (refused) "refused" else "failed"))
                    return@withLock DraftOutcome.of(failure)
                }
                telemetry.event("gym_coach_routine_confirm", mapOf("outcome" to "saved"))
                if (seat != owner) return@withLock DraftOutcome.Failed(accountChanged)
                try {
                    withContext(Dispatchers.IO) { localCoach?.confirm(seat, reply) }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    reportFailure("gym.coachRoutineConfirm", failure)
                }
                if (seat != owner) return@withLock DraftOutcome.Failed(accountChanged)
                confirmations = confirmations + ((seat to requestId) to reply)
                onProgramChanged()
                DraftOutcome.Saved(reply.generation)
            }
        }.await()
    }

    fun pendingExchange(question: AskQuestion): AskExchange {
        val snapshot = owner?.let { localCoach?.snapshot(it, question.requestId.orEmpty()) }
        return snapshot?.exchange() ?: AskExchange(question.question, requestId = question.requestId.orEmpty(),
            trouble = Ask.interrupted, again = true,
            attachments = question.attachmentIds.mapNotNull { id ->
                owner?.let { localCoach?.draft(it, question.thread)?.photo?.takeIf { it.id == id } }
            })
    }

    suspend fun ask(threadId: String, question: String, requestId: String = Ids.thread(),
        photo: CoachAttachment? = null, stream: Boolean = false,
        onSnapshot: (AskGeneration) -> Unit = {}, onUpload: (Float?) -> Unit = {},
    ): AskOutcome {
        val started = elapsedNanos()
        telemetry.event("gym_ask_started")
        fun complete(outcome: AskOutcome, failure: Exception? = null): AskOutcome {
            val properties = mutableMapOf("duration_ms" to ((elapsedNanos() - started) / 1_000_000).toString())
            properties["outcome"] = when (outcome) {
                is AskOutcome.Answered -> "answered"
                is AskOutcome.Refused -> "refused"
                is AskOutcome.Capped -> "capped"
                is AskOutcome.Failed -> "failed"
                is AskOutcome.Fresh -> "fresh"
                AskOutcome.Absent -> "absent"
            }
            if (outcome is AskOutcome.Capped) properties["cap"] = outcome.cap.name.lowercase()
            if (failure != null) properties["failure_kind"] = when (failure) {
                WindmillApiException.Offline -> "offline"
                is WindmillApiException.Timeout -> "timeout"
                WindmillApiException.Malformed -> "malformed"
                is WindmillApiException.Transport -> "transport"
                is WindmillApiException.Refused -> "http"
                else -> "unexpected"
            }
            if (failure is WindmillApiException.Refused) properties["status"] = failure.status.toString()
            telemetry.event("gym_ask_outcome", properties)
            return outcome
        }
        val seat = owner
        val coach = rest() ?: return complete(AskOutcome.Refused(signInFirst))
        var snapshot = seat?.let { localCoach?.snapshot(it, requestId) }
        var photoUpload = false
        return try {
            val saved = seat?.let { localCoach?.pending(it)?.firstOrNull { it.requestId == requestId } }
            val request = saved ?: AskQuestion(thread = threadId, question = question, requestId = requestId,
                attachmentIds = listOfNotNull(photo?.id))
            require(request.thread == threadId && request.question == question) { "A retry must keep the original message." }
            if (seat != null) withContext(Dispatchers.IO) { localCoach?.keep(seat, request) }
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
            if (photo != null && seat != null && snapshot == null) {
                val file = localCoach?.photoFile(seat, photo.id)
                if (file?.isFile == true) {
                    photoUpload = true
                    onUpload(0f)
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    coach.uploadPhoto(threadId, photo, bytes) { if (seat == owner) onUpload(it) }
                    if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
                    photoUpload = false
                    onUpload(null)
                }
            }
            onUpload(null)
            val accept: suspend (AskGeneration) -> Unit = { next ->
                if (seat == owner && snapshot != next && (snapshot == null || next.revision >= snapshot!!.revision)) {
                    if (seat != null) withContext(Dispatchers.IO) { localCoach?.record(seat, next) }
                    if (seat == owner) {
                        snapshot = next
                        onSnapshot(next)
                    }
                }
            }
            var answered = if (stream) coach.stream(request, accept) else coach.ask(request)
            answered.generation?.let { accept(it) }
            var pause = 1_000L
            while (answered.generation?.status == "running") {
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
                delay(pause)
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
                pause = (pause * 2).coerceAtMost(10_000)
                answered = if (stream) coach.stream(request, accept) else coach.ask(request)
                answered.generation?.let { accept(it) }
            }
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
            if (answered.proposals.isNotEmpty() || answered.results.isNotEmpty()) onProgramChanged()
            if (answered.generation?.status == "failed") return complete(AskOutcome.Failed(Ask.interrupted, snapshot))
            if (seat != null) withContext(Dispatchers.IO) { localCoach?.clear(seat, threadId, requestId) }
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged))
            complete(AskOutcome.Answered(answered))
        } catch (interrupted: CancellationException) {
            telemetry.event("gym_ask_outcome", mapOf("outcome" to "cancelled",
                "duration_ms" to ((elapsedNanos() - started) / 1_000_000).toString()))
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.ask", refusing)
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
            val authoritative = try { coach.thread(threadId)?.generation?.takeIf { it.requestId == requestId } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
            if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
            if (authoritative != null && (snapshot == null || authoritative.revision >= snapshot!!.revision)) {
                snapshot = authoritative
                if (seat != null) withContext(Dispatchers.IO) { localCoach?.record(seat, authoritative) }
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
            }
            if (snapshot?.status in listOf("completed", "stopped")) {
                if (seat != null) withContext(Dispatchers.IO) { localCoach?.clear(seat, threadId, requestId) }
                if (seat != owner) return complete(AskOutcome.Refused(accountChanged), refusing)
                return complete(AskOutcome.Answered(requireNotNull(snapshot).response()))
            }
            if (photoUpload) return complete(AskOutcome.Failed("Photo didn’t upload. Retry to send this photo.", snapshot), refusing)
            if (snapshot == null && photo != null && refusing is WindmillApiException.Refused && refusing.refusal.code == "ask-attachment-invalid") {
                return complete(AskOutcome.Failed("Photo wasn’t available. Retry to upload it again."), refusing)
            }
            complete(AskOutcome.refusing(refusing, snapshot), refusing)
        }
    }

    // One thread list for every screen; reads and deletes serialize under the same lock.
    var nextThreadCursor: String? by mutableStateOf(null)
        private set

    suspend fun readThreads(cursor: String? = null): GymResult<List<AskThread>> {
        val seat = owner
        val coach = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        return conversationWrite.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                val page = coach.threads(cursor)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                conversations = if (cursor == null) page.threads else (conversations + page.threads).distinctBy { it.id }
                nextThreadCursor = page.nextCursor
                GymResult.Ok(conversations)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.readThreads", refusing)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                GymResult.Failed(WriteFailure(refusing))
            }
        }
    }

    // A log that refused with a sentence is not a log holding no such thread, so the absence answers
    // in words rather than as a null.
    suspend fun thread(id: String, before: String? = null): GymResult<AskThread> {
        val seat = owner
        val coach = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        return try {
            val read = coach.thread(id, before)
            if (seat != owner) return GymResult.Failed(WriteFailure.Refused(accountChanged))
            if (read == null) return GymResult.Failed(WriteFailure.Refused(noSuchThread))
            if (seat != null && read.generation?.status in listOf("completed", "stopped")) localCoach?.clear(seat, id, requireNotNull(read.generation).requestId)
            GymResult.Ok(read)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            reportFailure("gym.thread", refusing)
            if (seat != owner) return GymResult.Failed(WriteFailure.Refused(accountChanged))
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    // Deleting a conversation preserves applied routine changes. A 404 answers as success.
    suspend fun deleteThread(id: String): GymResult<Unit> {
        val seat = owner
        val coach = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        return conversationWrite.withLock {
            if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
            try {
                coach.deleteThread(id)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                conversations = conversations.filterNot { it.id == id }
                if (seat != null) localCoach?.clear(seat, id)
                confirmations = confirmations.filter { (key, value) -> key.first != seat || value.thread != id }
                GymResult.Ok(Unit)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                reportFailure("gym.deleteThread", refusing)
                if (seat != owner) return@withLock GymResult.Failed(WriteFailure.Refused(accountChanged))
                if ((refusing as? WindmillApiException.Refused)?.status != 404) return@withLock GymResult.Failed(WriteFailure(refusing))
                conversations = conversations.filterNot { it.id == id }
                GymResult.Ok(Unit)
            }
        }
    }

}

// `Saved` is the log's word, also for a draft an earlier tap saved. `Closed` is a draft no retry can save,
// so the card takes Save away; `Failed` keeps Save for another tap.
sealed interface DraftOutcome {
    data class Saved(val generation: AskGeneration) : DraftOutcome
    data class Closed(val said: String) : DraftOutcome
    data class Failed(val said: String) : DraftOutcome

    companion object {
        // Told apart by status, never by the English.
        fun of(failure: Exception): DraftOutcome {
            val refused = failure as? WindmillApiException.Refused ?: return Failed(Ask.draftRetry)
            return when (refused.status) {
                401 -> Failed(Ask.draftSignIn)
                404 -> Closed(Ask.draftGone)
                400, 422 -> Closed(Ask.draftInvalid)
                else -> Failed(Ask.draftRetry)
            }
        }
    }
}

// `Answered` carries the reply whole and the screen draws it without adding to it. `Refused` is the
// log answering in its own words, which a retry cannot change; `Capped` is the one refusal that takes
// the composer down, since the next question is hours away; `Failed` is the log going quiet, which
// is worth another tap. `Absent` is the deployment having no Coach. `Fresh` is the conversation being
// full or another account's: the QUESTION is fine, so asking it again opens a new thread.
sealed interface AskOutcome {
    data class Answered(val answer: AskAnswer) : AskOutcome
    data class Refused(val said: String, val generation: AskGeneration? = null) : AskOutcome
    data class Capped(val said: String, val cap: AskCap, val generation: AskGeneration? = null) : AskOutcome
    data class Failed(val said: String, val generation: AskGeneration? = null) : AskOutcome
    data class Fresh(val said: String) : AskOutcome
    data object Absent : AskOutcome

    companion object {
        // Told apart by status and code, never by the English. Only a log that went quiet, or one
        // that failed, is worth another tap; a bare 404 is a deployment with no Coach.
        fun refusing(error: Throwable, generation: AskGeneration?): AskOutcome {
            val refused = error as? WindmillApiException.Refused ?: return Failed(noAnswer, generation)
            val said = refused.refusal.message
            return when {
                refused.status == 404 -> Absent
                refused.status >= 500 -> Failed(said ?: noAnswer, generation)
                // Both ceilings take the composer down: the one unrationed way on, the connect door,
                // is drawn there and is not drawn beside a live composer.
                refused.refusal.code == "ask-daily-limit" -> Capped(said ?: AskCap.Daily.wordless, AskCap.Daily, generation)
                refused.refusal.code == "ask-out-of-budget" -> Capped(said ?: AskCap.Ceiling.wordless, AskCap.Ceiling, generation)
                refused.refusal.code == "ask-generation-active" ->
                    Failed(said ?: "Coach is answering another message. Try again when it finishes.", generation)
                // Both are answered by opening a new thread; nothing is re-sent on its own.
                refused.refusal.code == "ask-thread-full" || refused.refusal.code == "ask-thread-taken" -> Fresh(said ?: Ask.threadFull)
                else -> Refused(said ?: "Coach couldn’t take that one", generation)
            }
        }

        private const val noAnswer = "Coach didn’t answer. Try again in a moment"
    }

    fun exchange(pending: AskExchange): AskExchange = when (this) {
        is Answered -> answer.generation?.exchange()?.copy(attachments = answer.generation.attachments.ifEmpty { pending.attachments })
            ?: pending.copy(answer = answer)
        is Failed -> pending.copy(trouble = said, again = true, generation = generation ?: pending.generation)
        is Refused -> pending.copy(trouble = said, again = generation != null, generation = generation ?: pending.generation)
        is Capped -> pending.copy(trouble = said, again = generation != null, generation = generation ?: pending.generation)
        is Fresh -> pending.copy(trouble = said, needsNew = true)
        Absent -> pending.copy(trouble = Ask.notHere)
    }
}
