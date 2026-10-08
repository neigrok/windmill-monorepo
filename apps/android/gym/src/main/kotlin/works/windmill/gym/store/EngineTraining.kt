package works.windmill.gym.store

import java.time.ZoneId
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CopyableThreadContextElement
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import works.windmill.domain.kit.*
import works.windmill.gym.domain.*
import works.windmill.gym.domain.sync.*
import works.windmill.platform.net.WindmillJson
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.*
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.Reply
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.schema.Gym
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.gym.domain.sync.Session as EngineSession
import works.windmill.gym.domain.sync.TrainingSet as EngineSet
import works.windmill.gym.domain.sync.Note as EngineNote
import works.windmill.gym.domain.sync.WeighIn as EngineWeighIn
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.SetTarget as EngineTarget
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.StatsProgress

private val <E : Entity<E>> Id<E>.text: String get() = record.string ?: error("gym-string-identity")

class EngineTraining(val engine: Engine) {
    companion object {
        val intentResultWrites: works.windmill.sync.api.IntentResultDeviceWrites = { intent, result, epoch, gestureId, values ->
            WorkoutImports.intentResultWrites(intent, result, epoch, gestureId, values) +
                RemovalReceipts.intentResultWrites(intent, result, epoch, gestureId, values)
        }
    }
    private val removalReceipts = RemovalReceipts(engine)
    fun removalReceipts(): Map<String, Proposal> = removalReceipts.confirmed()
    fun removalProposals(): Map<String, Proposal> = removalReceipts.proposals()
    fun removalPending(id: String): Boolean = removalReceipts.pending(id)
    fun removalReceiptShown(proposal: Proposal, replica: String) = removalReceipts.shown(proposal, replica)
    private val deliveryBlockers = mutableMapOf<String, Blocker>()
    val deliveryBlocker: Blocker? get() = synchronized(deliveryBlockers) { deliveryBlockers[engine.activeReplica()] }
    fun reportDelivery(replica: String, reply: Reply<SyncResponse>): Boolean = synchronized(deliveryBlockers) {
        if (engine.activeReplica() != replica) return@synchronized false
        val response = when (reply) {
            Reply.Unreachable -> null
            is Reply.Failed -> reply.response
            is Reply.Answer -> reply.value
        }
        when {
            response == null -> deliveryBlockers[replica] = Blocker.Offline
            response.status == 401 -> deliveryBlockers[replica] = Blocker.SignInLapsed
            response.status >= 500 -> deliveryBlockers[replica] = Blocker.LogFailed
            response.status == 200 -> deliveryBlockers.remove(replica)
        }
        true
    }
    private val zone = Zone { at ->
        ZoneId.systemDefault().rules.getOffset(java.time.Instant.ofEpochMilli(at.ms)).totalSeconds
    }
    private val reader = ActionRunner(engine, engine.registry, zone, object : ActionContext { override var insideRun = false })
    val imports = WorkoutImports(engine)
    val anonymous: Boolean get() = read { it.isAnonymous }
    val firstPullComplete: Boolean get() = read { it.firstPullComplete() }
    val notesReady: Boolean get() = anonymous || firstPullComplete
    val planUnreadable: Boolean get() = read { reader ->
        reader.repository(EngineSession).all(ViewMode.stored).any { it.planUnreadable } ||
            reader.repository(EngineSession).all(ViewMode.drawn).any { it.planUnreadable }
    }

    private fun <T> read(body: (Reader) -> T): T = reader.read(EngineSession.scope, body)
    private suspend fun <T> writing(body: (ActionRunner) -> T): T = withGymActionContext { context ->
        check(!context.insideRun) { "a run cannot enter inside a run" }
        body(ActionRunner(engine, engine.registry, zone, context))
    }
    private suspend fun <L, T> apply(action: Decider<L, T, GymRefusal>): T = writing { runner -> runner.execute(action) }
    private fun <L, T> ActionRunner.execute(action: Decider<L, T, GymRefusal>): T {
        val wrapped = object : Action<L, T, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = action.load(read)
            override fun decide(loaded: L, ids: IDSource) = action.decide(loaded, ids)
        }
        return when (val outcome = run(wrapped)) {
            is Outcome.Committed -> outcome.result
            is Outcome.Unchanged -> outcome.result
            is Outcome.Refused -> throw refusal(outcome.refusal)
        }
    }
    fun catalogue(): List<Exercise> = read { reader ->
        val aliases = reader.device("rack:aliases0")?.obj().orEmpty()
        Catalogue(reader).exercises.map { value -> value.ui().let { exercise ->
            val phone = aliases[exercise.id]?.arr()?.map(Json::str).orEmpty()
            val pending = reader.repository(EngineExercise).record(value.id, ViewMode.drawn)?.isPending == true ||
                reader.repository(ExerciseName).record(Id(value.id.record, ExerciseName), ViewMode.drawn)?.isPending == true
            val ordered = if (pending) phone + exercise.aliases else exercise.aliases + phone
            exercise.copy(aliases = ordered.filter { it != exercise.name }.distinct().take(5))
        } }
    }.sortedWith { a, b -> compareBytes(a.pattern, b.pattern).takeIf { it != 0 }
        ?: compareBytes(a.name, b.name).takeIf { it != 0 } ?: compareBytes(a.id, b.id) }
    suspend fun createExercise(write: ExerciseWrite): Exercise {
        val value = EngineExercise(Id(write.id, EngineExercise), write.name, write.pattern, write.equipment,
            write.stepKg ?: ExerciseRules.defaultStepKg(write.equipment))
        val existing = read { it.repository(EngineExercise).find(value.id, ViewMode.drawn) }
        if (existing == null) apply(CreateExercise(value))
        return catalogue().first { it.id == write.id }
    }
    suspend fun renameExercise(exerciseId: String, name: String): Exercise {
        if (catalogue().none { it.id == exerciseId }) throw missing("That movement is no longer on the log.")
        val action = RenameExercise(Id(exerciseId, EngineExercise), name)
        apply(object : Action<Triple<RenameExercise.Loaded, Json?, Boolean>, Unit, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = Triple(action.load(read), read.device("rack:aliases0"),
                read.repository(EngineExercise).record(Id(exerciseId, EngineExercise), ViewMode.drawn)?.isPending == true ||
                    read.repository(ExerciseName).record(Id(exerciseId, ExerciseName), ViewMode.drawn)?.isPending == true)
            override fun decide(loaded: Triple<RenameExercise.Loaded, Json?, Boolean>, ids: IDSource): Decision<Unit, GymRefusal> {
                val decision = action.decide(loaded.first, ids)
                if (decision is Decision.Write) {
                    val aliases = loaded.second?.obj().orEmpty().toMutableMap()
                    val phone = aliases[exerciseId]?.arr()?.map(Json::str).orEmpty()
                    val server = loaded.first.exercise!!.aliases
                    aliases[exerciseId] = Json.Arr(ExerciseRules.renamedAliases(loaded.first.exercise!!.name, name,
                        if (loaded.third) phone + server else server + phone).map(Json::of))
                    decision.plan.device("rack:aliases0", Json.Obj(aliases.toList()))
                }
                return decision
            }
        })
        return catalogue().first { it.id == exerciseId }
    }
    suspend fun startSession(start: SessionStart): Session {
        val open = read { TrainingLog(it).open }
        if (open != null && open.id.text != start.id) throw TrainingRefused("session-already-open", "A workout is already open. Finish it first.")
        val action = StartSession(Id(start.id, EngineSession), start.routineId?.let { Id(it, EngineRoutine) }, Instant(start.startedAt))
        val id = apply(object : Action<StartSession.Loaded, Id<EngineSession>, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = action.load(read)
            override fun decide(loaded: StartSession.Loaded, ids: IDSource): Decision<Id<EngineSession>, GymRefusal> {
                val decision = action.decide(loaded, ids)
                if (decision !is Decision.Write) return decision
                val command = requireNotNull(decision.plan.command)
                val explicit = object : ServerCommand {
                    override val name = command.name
                    override val args = command.args.obj() + ("joinOpenSession" to Json.of(false))
                    override val specs = emptyList<ValueSpec>()
                }
                return Decision.Write(Plan(explicit, decision.plan.predictions), decision.result)
            }
        })
        return session(id.text)?.session ?: error("The engine does not hold the record it just wrote.")
    }
    suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
        val value = engineSet(sessionId, write)
        alreadyWritten(value)?.let { return it.ui() }
        apply(AppendSet(value))
        return storedSet(value.id)
    }
    private fun engineSet(sessionId: String, write: SetWrite) = EngineSet(Id(write.id, EngineSet), Id(sessionId, EngineSession),
        Id(write.exerciseId, EngineExercise), write.weightKg, write.reps, write.kind.wire, completedAt = Instant(write.completedAt))
    // A set id names one set: a redelivered append finds it written, and a different set under it is refused.
    private fun alreadyWritten(value: EngineSet): EngineSet? = read { it.repository(EngineSet).find(value.id, ViewMode.drawn) }?.also { existing ->
        if (existing.sessionId != value.sessionId || existing.exerciseId != value.exerciseId || existing.completedAt != value.completedAt)
            throw TrainingRefused("set-id-taken", "that set id is already used")
    }
    private fun storedSet(id: Id<EngineSet>): TrainingSet =
        read { it.repository(EngineSet).find(id, ViewMode.drawn) }?.ui() ?: error("The engine does not hold the record it just wrote.")
    suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet {
        val old = read { it.repository(EngineSet).find(Id(setId, EngineSet), ViewMode.drawn) }
            ?.takeIf { it.sessionId.text == sessionId } ?: throw missing("That set is no longer on the log.")
        val next = old.copy(weightKg = fix.weightKg ?: old.weightKg, reps = fix.reps ?: old.reps,
            kind = fix.kind?.wire ?: old.kind, note = fix.note ?: old.note, rpe = if (fix.rpeNamed) fix.rpe else old.rpe)
        apply(CorrectSet(next))
        return storedSet(next.id)
    }
    suspend fun deleteSet(sessionId: String, setId: String) {
        val id = Id(setId, EngineSet)
        val old = read { it.repository(EngineSet).find(id, ViewMode.drawn) } ?: return
        if (old.sessionId.text != sessionId) throw missing("That set is no longer on the log.")
        val action = Remove(EngineSet, id, GymRefusal)
        apply(object : Action<EngineSet?, Unit, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = action.load(read)
            override fun decide(loaded: EngineSet?, ids: IDSource) = action.decide(loaded, ids).also { decision ->
                if (decision is Decision.Write) decision.plan.device("rack:deletedSet${Sha256.hex(setId.toByteArray()).take(32)}", Json.objectOf(
                    "setId" to Json.of(setId), "sessionId" to Json.of(sessionId)))
            }
        })
    }
    suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session {
        reconcileImports()
        if (imports.hasUnsubmittedSets(sessionId)) throw TrainingUnanswered
        apply(FinishSession(Id(sessionId, EngineSession), Instant(finishedAtMs)))
        return session(sessionId)?.session ?: throw missing("That workout is no longer on the log.")
    }
    suspend fun discardSession(sessionId: String) { apply(DiscardSession(Id(sessionId, EngineSession))) }
    // Before a sign-in, every signed-out workout is retained in the import journal for the account.
    fun prepareAdoption() {
        if (!anonymous) return
        for (detail in details()) {
            val deleted = read { reader -> reader.devices("rack:deletedSet").values.filter { it["sessionId"] == Json.of(detail.session.id) }
                .map { it.member("setId").str() } }
            imports.prepare(SavedWorkout(detail.session, detail.sets, deleted))
        }
    }
    fun openWorkout(): SessionDetail? {
        val id = read { TrainingLog(it).open?.id?.text } ?: return null
        return details().firstOrNull { it.session.id == id }
    }
    fun details(): List<SessionDetail> = read { reader ->
        val log = TrainingLog(reader)
        val heldStarts = if (reader.isAnonymous || reader.firstPullComplete()) emptyList() else imports.startSources()
        val drawn = log.drawnSessions.map { session ->
            val sets = log.sets(session.id).map { it.ui() }
            val held = heldStarts.firstOrNull { it["session"]?.get("id") == session.id.json }?.get("entries")?.obj().orEmpty().values.mapNotNull { entry ->
                runCatching { WindmillJson.decodeFromString<OwedSet>(entry.jcs) }.getOrNull()?.takeIf { it.write != Owed.Delete }?.set
            }.filter { reader.repository(EngineSet).record(Id(it.id, EngineSet), ViewMode.stored) == null }
            SessionDetail(session.ui(), (sets + held).distinctBy { it.id }.sortedWith(compareBy({ it.completedAtMs }, { it.id })))
        }
        drawn + imports.retainedWorkouts().filter { pending -> drawn.none { it.session.id == pending.session.id } }
            .map { SessionDetail(it.session, it.sets.filterNot { set -> set.id in it.deleted }) }
    }
    fun pendingSetIds(): Set<String> = read { reader -> reader.source.drawn(EngineSet.type)
        .filter { it.isVisible && (reader.isAnonymous || it.isPending) }.mapTo(mutableSetOf()) { it.id.toString() } } +
        imports.operations().filter { it.entry.write != Owed.Delete }.map { it.entry.set.id } +
        imports.retainedWorkouts().flatMap { row -> row.sets.filterNot { it.id in row.deleted }.map { it.id } }
    fun pendingSessionIds(): Set<String> = read { reader ->
        val sessions = reader.source.drawn(EngineSession.type).filter { it.isVisible && (reader.isAnonymous || it.isPending) }
            .mapTo(mutableSetOf()) { it.id.toString() }
        reader.source.drawn(EngineSet.type).filter { reader.isAnonymous || it.isPending }.mapNotNullTo(sessions) {
            (it.values["sessionId"] as? Json.Str)?.value
        }
        reader.devices("rack:deletedSet").values.filter { value ->
            reader.repository(EngineSet).record(RecordID(value.member("setId").str()), ViewMode.drawn)?.isPending == true
        }.mapTo(sessions) { it.member("sessionId").str() }
        sessions
    } + imports.operations().map { it.sessionId } + imports.retainedWorkouts().map { it.session.id }
    fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        if (!anonymous && !firstPullComplete && details().isEmpty()) throw TrainingUnanswered
        val history = details()
        val names = if (anonymous) emptyMap() else catalogue().associate { it.id to it.name }
        return history.sortedWith(compareByDescending<SessionDetail> { it.session.startedAtMs }.thenByDescending { it.session.id })
            .filter { before == null || it.session.startedAtMs < before || it.session.startedAtMs == before && (beforeId == null || it.session.id < beforeId) }
            .take(limit).map { detail ->
                val stale = read { TrainingLog(it).drawnSessions.firstOrNull { it.id.text == detail.session.id }?.closedBy == "stale" }
                val summary = SessionSummary.of(detail, history)
                summary.copy(closedItself = stale, exercises = summary.exercises.map { names[it] ?: it })
            }
    }
    fun session(id: String): SessionDetail? = details().firstOrNull { it.session.id == id }
    fun review(sessionId: String): Review = Review.of(
        session(sessionId) ?: throw missing("That workout is no longer on the log."), details())
    fun lastTime(exerciseId: String): LastTime {
        if (catalogue().none { it.id == exerciseId }) throw TrainingRefused("unknown-exercise", "That movement is not in the catalog.")
        val known = LastTime.of(exerciseId, details())
        if (!anonymous && !firstPullComplete && known.isFirstTime) throw TrainingUnanswered
        return known
    }
    fun lastSets(): List<LastSet> {
        val known = LastSet.of(details())
        if (!anonymous && !firstPullComplete && known.isEmpty()) throw TrainingUnanswered
        return known
    }
    fun program(): List<Routine> = read { reader ->
        val log = TrainingLog(reader)
        val decisions = reader.commands().filter { it.command.name in setOf(Gym.Commands.applyProposal, Gym.Commands.dismissProposal) }
            .mapNotNull { it.command.args["proposalId"]?.str() }.toSet()
        val proposals = reader.repository(EngineProposal).all(ViewMode.drawn).map { proposal ->
            if (proposal.id.text !in decisions) proposal else reader.confirmed(EngineProposal, proposal.id)
                ?.takeIf { it.isVisible }?.let { EngineProposal.decode(Fields(it)) } ?: proposal
        }
        val decisionRoutines = proposals.filter { it.id.text in decisions }.map { it.routineId }.toSet()
        val drawnRoutines = reader.repository(EngineRoutine).all(ViewMode.drawn)
        val drawnAndHeld = drawnRoutines + decisionRoutines.filter { id -> drawnRoutines.none { it.id == id } }.mapNotNull { id ->
            reader.confirmed(EngineRoutine, id)?.takeIf { it.isVisible }?.let { EngineRoutine.decode(Fields(it)) }
        }
        val served = drawnAndHeld.map { drawn ->
            val value = if (drawn.id !in decisionRoutines) drawn else reader.confirmed(EngineRoutine, drawn.id)
                ?.takeIf { it.isVisible }?.let { EngineRoutine.decode(Fields(it)) } ?: drawn
            value.ui(
            log.drawnSessions.filter { it.routineId == value.id }.maxOfOrNull { it.startedAt.ms },
            proposals.filter { it.routineId == value.id && it.state == "pending" }.maxWithOrNull(compareBy<EngineProposal> { proposalCreatedAt(it, reader) }.thenBy { it.id.text })?.ui(reader)) }
        served.sortedWith(compareByDescending<Routine> { it.lastTrainedAtMs ?: Long.MIN_VALUE }.thenBy { it.position }.thenBy { it.id })
    }
    fun routine(id: String): Routine? = program().firstOrNull { it.id == id }
    suspend fun createRoutine(write: RoutineWrite): Routine {
        val value = write.engine(null)
        if (routine(write.id) == null) apply(saveRoutine(value))
        return routine(write.id) ?: error("The engine does not hold the record it just wrote.")
    }
    suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine = writing { runner ->
        val old = read { it.repository(EngineRoutine).find(Id(id, EngineRoutine), ViewMode.drawn) }
        if (old == null) throw missing("That routine is no longer on the log.")
        if (write.expectedRevision != null && old.revision != null && write.expectedRevision != old.revision)
            throw TrainingRefused("stale", "That routine changed. Open it again.")
        val draft = Draft.opening(old).edit { write.copy(id = id).engine(old) }
        when (val result = runner.save(draft, EngineRoutine, GymRefusal) {}) {
            is SaveResult.Refused -> throw refusal(result.refusal)
            is SaveResult.Failed -> throw result.error
            is SaveResult.Saved -> Unit
        }
        read { it.repository(EngineRoutine).find(Id(id, EngineRoutine), ViewMode.drawn) }!!.ui()
    }
    suspend fun deleteRoutine(id: String) { apply(deleteRoutine(Id(id, EngineRoutine))) }
    fun proposal(id: String): Proposal? = read { reader ->
        val identity = Id(id, EngineProposal)
        val queued = reader.commands().any { it.command.name in setOf(Gym.Commands.applyProposal, Gym.Commands.dismissProposal) && it.command.args["proposalId"] == identity.json }
        if (queued) reader.confirmed(EngineProposal, identity)?.takeIf { it.isVisible }?.let { EngineProposal.decode(Fields(it)).ui(reader) }
        else reader.repository(EngineProposal).find(identity, ViewMode.drawn)?.ui(reader)
    } ?: removalReceipts.proposals()[id]?.takeIf { it.isPending }
    suspend fun applyProposal(id: String) = decideProposal(id, applying = true)
    suspend fun dismissProposal(id: String) = decideProposal(id, applying = false)
    private suspend fun decideProposal(id: String, applying: Boolean): ProposalDecision {
        val replica = engine.activeReplica()
        val status = engine.status.state.value
        if (anonymous || status.authPaused) throw TrainingRefused("sign-in", "Sign in again to decide this proposal.")
        if (applying) removalReceipts.result(id, replica)?.let { return ProposalDecision(it) }
        if (!status.online) throw TrainingUnanswered
        val before = engine.notices("gym").notices.value.map { it.id }.toSet()
        val removal = if (applying) proposal(id)?.takeIf { it.isPending && it.intent == ProposalIntent.Remove } else null
        val trackingRemoval = applying && (removal != null || removalReceipts.contains(id))
        if (trackingRemoval) {
            removalReceipts.begin(id, replica, zone) { reader ->
                reader.confirmed(EngineProposal, Id(id, EngineProposal))?.takeIf { it.isVisible }
                    ?.let { EngineProposal.decode(Fields(it)).ui(reader) }
                    ?.takeIf { it.isPending && it.intent == ProposalIntent.Remove }
            }?.let { throw refusal(it) }
        } else {
            val written = writing { runner ->
                if (applying) runner.run(ApplyProposal(Id(id, EngineProposal))) else runner.run(DismissProposal(Id(id, EngineProposal)))
            }
            if (written is Outcome.Refused) throw refusal(written.refusal)
        }
        return withTimeoutOrNull(15_000) {
            while (true) {
                if (engine.activeReplica() != replica) throw TrainingRefused("account-changed", "The account changed. Open this again.")
                if (applying) {
                    removalReceipts.refusal(id, replica)?.let { throw refusal(it) }
                    removalReceipts.result(id, replica)?.let { return@withTimeoutOrNull ProposalDecision(it) }
                }
                engine.notices("gym").notices.value.firstOrNull { notice -> !trackingRemoval && notice.id !in before &&
                    notice.content.command?.args?.get("proposalId") == Json.of(id) }?.let {
                    throw refusal(DomainNotice(it, engine.registry, GymRefusal).refusal)
                }
                val confirmed = read { reader ->
                    val identity = Id(id, EngineProposal)
                    val record = reader.confirmed(EngineProposal, identity)?.takeIf { it.isVisible }
                    val pending = reader.repository(EngineProposal).record(identity, ViewMode.drawn)?.isPending == true
                    record?.let { EngineProposal.decode(Fields(it)) }?.takeIf { !pending && it.state == if (applying) "applied" else "dismissed" }
                        ?.let { proposal -> ProposalDecision(proposal.ui(reader), reader.confirmed(EngineRoutine, proposal.routineId)
                            ?.takeIf { it.isVisible }?.let { EngineRoutine.decode(Fields(it)).ui() }) }
                }
                if (confirmed != null) return@withTimeoutOrNull confirmed
                delay(25)
            }
            @Suppress("UNREACHABLE_CODE") error("The receipt loop returns or is cancelled.")
        } ?: throw TrainingUnanswered
    }
    fun progress(): StatsProgress = StatsProgress.of(details(), engine.physNow())
    fun record(exerciseId: String): MovementRecord? = catalogue().firstOrNull { it.id == exerciseId }
        ?.let { MovementRecord.of(it, details()) }
    fun settings(): GymPreferences = read { reader ->
        val value = reader.repository(Preferences).find(Preferences().id, ViewMode.drawn) ?: Preferences()
        GymPreferences(Units.entries.first { it.wire == value.units }, value.confirmHaptic, value.confirmSound)
    }
    suspend fun savePreferences(document: GymPreferences): GymPreferences {
        val next = Preferences(units = document.units.wire, confirmHaptic = document.confirmHaptic, confirmSound = document.confirmSound)
        writing { runner ->
            val draft = runner.open(Preferences, next.id, Preferences()).edit { next }
            when (val result = runner.save(draft, Preferences, GymRefusal) {}) {
                is SaveResult.Refused -> throw refusal(result.refusal)
                is SaveResult.Failed -> throw result.error
                is SaveResult.Saved -> Unit
            }
        }
        return settings()
    }
    fun notes(): List<Note> = read { reader -> reader.repository(EngineNote).all(ViewMode.drawn)
        .mapIndexed { index, note -> Note(note.id.text, index, note.title, note.body, note.updatedAt?.ms ?: 0) } }
    suspend fun writeNote(id: String, write: NoteWrite): Note {
        val next = EngineNote(Id(id, EngineNote), write.title, write.body)
        writing { runner ->
            val old = runner.open(EngineNote, next.id)
            if (old == null) runner.execute(SaveNoteCall(next))
            else when (val result = runner.save(old.edit { next }, EngineNote, GymRefusal) {}) {
                is SaveResult.Refused -> throw refusal(result.refusal)
                is SaveResult.Failed -> throw result.error
                is SaveResult.Saved -> Unit
            }
        }
        return notes().firstOrNull { it.id == id } ?: notes().first { it.title == write.title.trim() && it.body == write.body.trim() }
    }
    suspend fun deleteNote(id: String) { apply(deleteNote(Id(id, EngineNote))) }
    suspend fun moveNote(id: String, drawn: List<String>, withheld: Set<String>): Boolean = writing { runner ->
        val move = moveNote(Id(id, EngineNote), drawn.getOrNull(drawn.indexOf(id) - 1)?.let { Id(it, EngineNote) })
        val action = object : Action<Pair<MoveLoaded<EngineNote>, List<String>>, Unit, GymRefusal> {
            override val scope = move.scope
            override val refusals = GymRefusal
            override fun load(read: Reader) = move.load(read) to read.repository(EngineNote).all(ViewMode.drawn)
                .map { it.id.text }.filterNot { it in withheld }
            override fun decide(loaded: Pair<MoveLoaded<EngineNote>, List<String>>, ids: IDSource): Decision<Unit, GymRefusal> {
                val visible = loaded.second
                if (id !in visible || drawn.size != visible.size || drawn.toSet().size != drawn.size ||
                    drawn.toSet() != visible.toSet() || drawn.filterNot { it == id } != visible.filterNot { it == id }) {
                    return Decision.Refuse(GymRefusal.Stale(move.id.ref, Refused.Path.predicted))
                }
                if (drawn == visible) return Decision.Unchanged(Unit)
                return move.decision(loaded.first, ids)
            }
        }
        when (val outcome = runner.run(action)) {
            is Outcome.Committed -> true
            is Outcome.Unchanged -> false
            is Outcome.Refused -> if (outcome.refusal is GymRefusal.Stale)
                throw TrainingRefused("stale", "The notes changed. Read them again before reordering.")
                else throw refusal(outcome.refusal)
        }
    }
    fun weighins(from: String? = null, to: String? = null): List<WeighIn> = read { reader ->
        reader.repository(EngineWeighIn).all(ViewMode.drawn).mapNotNull { it.kg?.let { kg -> WeighIn(it.id.text, kg, it.recordedAt?.ms ?: 0) } }
            .filter { (from == null || it.dateLocal >= from) && (to == null || it.dateLocal <= to) }.sortedBy { it.dateLocal }
    }
    suspend fun putBodyweight(dateLocal: String, weightKg: Double): WeighIn {
        val day = LocalDay.parse(dateLocal) ?: throw TrainingRefused("bad-instant", works.windmill.gym.domain.Bodyweight.notAForecast)
        writing { runner ->
            val blank = EngineWeighIn(day)
            val draft = runner.open(EngineWeighIn, blank.id, blank).edit { it.copy(kg = weightKg) }
            when (val result = runner.save(draft, EngineWeighIn, GymRefusal) {}) {
                is SaveResult.Refused -> throw refusal(result.refusal)
                is SaveResult.Failed -> throw result.error
                is SaveResult.Saved -> Unit
            }
        }
        return weighins(dateLocal, dateLocal).first()
    }
    suspend fun deleteBodyweight(dateLocal: String) { apply(deleteWeighIn(Id(dateLocal, EngineWeighIn))) }

    // Signed-out training prepared for this account: confirmed starts settle, then the sets an
    // unfinished workout still owes follow it under their own ids.
    suspend fun reconcileImports() {
        imports.reconcileConfirmed()
        if (anonymous || firstPullComplete) for (deletion in imports.deletedSets()) {
            deleteSet(deletion.sessionId, deletion.setId)
            imports.resolveDeletion(deletion.token)
        }
        for (operation in imports.operations()) {
            if (!anonymous && !firstPullComplete) continue
            if (imports.continuesRecovery(operation)) {
                imports.recoverFinishedOperation(operation)
                continue
            }
            if (imports.refusals().any { it.id == operation.sessionId && it.session?.isOpen == true }) continue
            if (!anonymous && read { it.confirmed(EngineSession, Id(operation.sessionId, EngineSession))?.isVisible != true }) continue
            try {
                reconcileOperation(operation)
            } catch (refused: TrainingRefused) {
                if (refused.code == Gym.Codes.sessionFinished && imports.recoverFinishedOperation(operation)) continue
                imports.refuseOperation(operation, refused.code)
            }
        }
    }

    internal suspend fun reconcileOperation(operation: ImportOperation) {
        val entry = operation.entry
        val value = engineSet(operation.sessionId, SetWrite(entry.set)).copy(rpe = entry.set.rpe, note = entry.set.note)
        writing {
            val outcome = engine.commit(EngineSet.scope) { context ->
                if (imports.operationSubmission(operation, context, null) == null) return@commit null to Unit
                val read = Reader(context, EngineSet.scope, Moment(Instant(context.now), zone), engine.registry)
                val state = TrainingState(read)
                val ids = IDSource(context)
                val known = state.drawnSets.firstOrNull { it.id == value.id }
                if (known != null && (known.sessionId != value.sessionId || entry.write == Owed.Append &&
                        (known.exerciseId != value.exerciseId || known.completedAt != value.completedAt)))
                    throw TrainingRefused("set-id-taken", "that set id is already used")
                val decision = when {
                    entry.write == Owed.Delete -> Remove(EngineSet, value.id, GymRefusal).decide(known, ids)
                    known == null -> AppendSet(value).decide(state, ids)
                    entry.write == Owed.Fix -> CorrectSet(known.copy(weightKg = value.weightKg, reps = value.reps,
                        kind = value.kind, rpe = value.rpe, note = value.note)).decide(state, ids)
                    else -> Decision.Unchanged(Unit)
                }
                val plan = when (decision) {
                    is Decision.Write -> decision.plan
                    is Decision.Unchanged -> Plan()
                    is Decision.Refuse -> throw refusal(decision.refusal)
                }
                if (entry.write == Owed.Delete && known != null) plan.device("rack:deletedSet${Sha256.hex(entry.set.id.toByteArray()).take(32)}",
                    Json.objectOf("setId" to Json.of(entry.set.id), "sessionId" to Json.of(operation.sessionId)))
                val gesture = plan.gesture(EngineSet.scope, engine.registry)
                val submission = if (gesture.changes.isEmpty() || context.isAnonymous) null else context.opaqueID()
                if (submission == null && context.stored(Gym.Types.set, value.id.record)?.isPending == true) return@commit null to Unit
                gesture.gestureId = submission
                gesture.local += checkNotNull(imports.operationSubmission(operation, context, submission))
                gesture to Unit
            }.first
            if (outcome is works.windmill.sync.api.CommitOutcome.Refused)
                throw refusal(GymRefusal.of(Refused(outcome.code, subject = null, detail = outcome.detail, path = Refused.Path.predicted)))
        }
    }
    fun refusedWrites(): List<RefusedWrite> = engine.notices("gym").notices.value.map { notice ->
        val domain = DomainNotice(notice, engine.registry, GymRefusal)
        val reason = refusal(domain.refusal).line
        val subject = domain.subject
        if (subject?.type == EngineSet.type) {
            val values = domain.values(subject)
            val id = subject.id.string ?: notice.id
            RefusedSet(id, (values["exerciseId"] as? Json.Str)?.value.orEmpty(),
                (values["weightKg"] as? Json.Num)?.value ?: 0.0, (values["reps"] as? Json.Num)?.value?.toInt() ?: 0, reason)
        } else RefusedChange(notice.id, "Saved change", reason)
    }
    fun refusedNotes(): List<RefusedWrite> = engine.notices("gym").notices.value.mapNotNull { notice ->
        val domain = DomainNotice(notice, engine.registry, GymRefusal)
        val subject = domain.subject?.takeIf { it.type == EngineNote.type } ?: return@mapNotNull null
        val title = domain.values(subject)["title"]?.str().orEmpty()
        RefusedChange(notice.id, "Note: $title", refusal(domain.refusal).line)
    }
    fun dismissRefusals() {
        val notices = engine.notices("gym").notices.value
        removalReceipts.dismissRefused(notices.mapNotNull { it.content.command?.args?.get("proposalId")?.str() }.toSet())
        for (notice in notices) engine.dismissNotice(notice.id)
    }

    // A set the logger accepted, committed together with the controls that consumed its offer.
    fun commitAccepted(controls: WorkoutControls, set: TrainingSet, sessionId: String): TrainingSet {
        val value = engineSet(sessionId, SetWrite(set))
        val action = AppendSet(value)
        val runner = ActionRunner(engine, engine.registry, zone, object : ActionContext { override var insideRun = false })
        if (alreadyWritten(value) == null) when (val outcome = runner.run(object : Action<TrainingState, Id<EngineSet>, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = action.load(read)
            override fun decide(loaded: TrainingState, ids: IDSource): Decision<Id<EngineSet>, GymRefusal> = when (val decision = action.decide(loaded, ids)) {
                is Decision.Write -> decision.also { controls(controls).forEach { write -> it.plan.device(write.key, write.value) } }
                else -> decision
            }
        })) {
            is Outcome.Refused -> throw refusal(outcome.refusal)
            else -> Unit
        }
        return storedSet(value.id)
    }
    // Recover controls-only acceptances; engine rows, refusals and import sources already retain their work.
    fun recoverAcceptedSets(controls: WorkoutControls) {
        if (controls.engineReplica != engine.activeReplica()) return
        val session = controls.session ?: return
        val imported = imports.retainedWorkouts().flatMap { it.sets }.mapTo(mutableSetOf()) { it.id } +
            imports.retainedOperationSetIds()
        val missing = controls.sets(session.id).filter { set ->
            set.id in controls.workout.consumed && set.id !in imported &&
                !engine.retainsRecord(EngineSet.scope, RecordKey(EngineSet.type, RecordID(set.id)))
        }
        for (set in missing) controls.store(commitAccepted(controls, set, session.id), session.id)
    }
    private fun controls(controls: WorkoutControls): List<works.windmill.sync.api.DeviceWrite> = controls.session?.let { session -> listOf(
        works.windmill.sync.api.DeviceWrite("movementOrder:${session.id}", Json.Arr(controls.order.map(Json::of))),
        works.windmill.sync.api.DeviceWrite("movement:${session.id}", controls.chosenMovement?.let(Json::of)),
        works.windmill.sync.api.DeviceWrite("rack:${session.id}", Json.parse(WindmillJson.encodeToString(WorkoutState.serializer(), controls.workout))),
    ) }.orEmpty()
    fun persistControls(controls: WorkoutControls) {
        if (controls.engineReplica != engine.activeReplica()) return
        val wanted = controls(controls)
        if (engine.read(EngineSession.scope) { reader -> wanted.all { reader.device(it.key) == it.value } }) return
        engine.commit(EngineSession.scope) { reader ->
            val changed = wanted.filter { reader.device(it.key) != it.value }
            if (changed.isEmpty()) null to Unit else works.windmill.sync.api.Gesture(emptyList(), local = changed) to Unit
        }
    }
    fun restoreControls(controls: WorkoutControls) {
        val session = controls.session ?: return
        engine.read(EngineSession.scope) { reader ->
            fun device(kind: String) = reader.device("$kind:${session.id}")
            device("movementOrder")?.arr()?.map(Json::str)?.let(controls::hold)
            device("movement")?.str()?.let(controls::choose)
            device("rack")?.let { value -> controls.control(WindmillJson.decodeFromString(WorkoutState.serializer(), value.jcs).invalidate()) }
        }
    }

    private fun EngineExercise.ui() = Exercise(id.text, name, pattern, equipment, stepKg,
        SeedExercises.all.none { it.id == id }, aliases)
    private fun EngineSession.ui() = Session(id.text, startedAt.ms, finishedAt?.ms, (historyRoutineId ?: routineId)?.text,
        plan?.let { PlanSnapshot(name ?: it.routine, it.entries.map { entry -> PlanEntry(entry.exerciseId.text, entry.sets.orEmpty().map { set -> SetTarget(set.reps, set.weightKg) }) }) })
    private fun EngineSet.ui() = TrainingSet(id.text, exerciseId.text, setNumber, weightKg, reps, SetKind.parse(kind), rpe, note, completedAt.ms)
    private fun EngineRoutine.ui(last: Long? = null, proposal: Proposal? = null) = Routine(id.text, name, position, last,
        entries.mapIndexed { index, entry -> RoutineEntry(index + 1, entry.exerciseId.text, entry.sets.orEmpty().map { SetTarget(it.reps, it.weightKg) }) }, revision ?: 1, proposal)
    private fun RoutineWrite.engine(old: EngineRoutine?) = EngineRoutine(Id(id, EngineRoutine), name, position,
        entries.map { entry -> EngineEntry(Id(entry.exerciseId, EngineExercise), entry.sets.takeIf { it.isNotEmpty() }?.map { EngineTarget(it.reps, it.weightKg) },
            old?.entries?.firstOrNull { it.exerciseId.text == entry.exerciseId }?.restSeconds) }, old?.revision)
    private fun proposalCreatedAt(proposal: EngineProposal, reader: Reader): Long = reader.repository(EngineProposal).record(proposal.id, ViewMode.drawn)?.let { it.rc ?: it.born?.ms } ?: 0
    private fun EngineProposal.ui(reader: Reader): Proposal = Proposal(id.text, routineId.text, ProposalIntent.parse(intent), ProposalState.parse(state), summary,
        changeCount ?: changes.count { it.kind != "kept" }, proposalCreatedAt(this, reader), settledAt?.ms, ProposalSource(door, connection, agent, threadId), baseRevision, baseName.orEmpty(), proposedName,
        changes.mapIndexed { index, change -> ProposalChange(index + 1, ChangeKind.parse(change.kind), change.exerciseId.text,
            change.before?.let { ProposalTargets(it.sets.orEmpty().map { SetTarget(it.reps, it.weightKg) }) },
            change.after?.let { ProposalTargets(it.sets.orEmpty().map { SetTarget(it.reps, it.weightKg) }) },
            if (change.kind == "removed") TrainingLog(reader).sets.count { it.exerciseId == change.exerciseId } else null) })
    private fun missing(message: String) = TrainingRefused("unknown-record", message)
    private fun refusal(refusal: GymRefusal): TrainingRefused {
        val (code, message) = when (refusal) {
            is GymRefusal.Invalid -> "invalid" to when {
                refusal.violation.rule == NoteRules.title.path && refusal.violation.reason == Violation.Reason.Blank -> "a note needs a title"
                refusal.violation.rule == NoteRules.title.path && refusal.violation.reason is Violation.Reason.TooLong -> "a title runs to 60 characters"
                refusal.violation.rule == NoteRules.body.path && refusal.violation.reason is Violation.Reason.TooLong -> "a note runs to 500 bytes"
                else -> "Check ${refusal.violation.path.text.substringAfterLast('.')}."
            }
            is GymRefusal.Stale -> "stale" to "That changed. Open it again."
            is GymRefusal.Gone -> "unknown-record" to "That is no longer on the log."
            is GymRefusal.Taken -> "id-taken" to "That identity is already on the log."
            is GymRefusal.Full -> "cap" to "The log has reached its limit. Remove an entry first."
            is GymRefusal.Future -> "bad-instant" to works.windmill.gym.domain.Bodyweight.notAForecast
            is GymRefusal.SessionFinished -> refusal.refused.code.text to "That workout has finished."
            is GymRefusal.SessionOpen -> refusal.refused.code.text to "Finish the workout first."
            is GymRefusal.SessionOverlap -> refusal.refused.code.text to "This workout overlaps another workout. Correct its times and retry."
            is GymRefusal.PayloadConflict -> refusal.refused.code.text to "The workout already has different data. Review it and retry."
            is GymRefusal.UnknownExercise -> refusal.refused.code.text to "That movement is no longer on the log."
            is GymRefusal.BadInstant -> refusal.refused.code.text to "Check the workout times and retry."
            is GymRefusal.ProposalSettled -> refusal.refused.code.text to "That proposal has already been decided."
            is GymRefusal.ProposalSuperseded -> refusal.refused.code.text to "That proposal has been replaced."
            is GymRefusal.Other -> refusal.refused.code.text to "That change could not be saved."
        }
        return TrainingRefused(code, message)
    }
}

// A write the log's rules refuse, in the words a person reads: an expected answer, never a failure
// to report.
class TrainingRefused(val code: String, val line: String) : Exception()

// What the replica cannot answer yet: the account's first pull, or the log's receipt for a decision,
// has not arrived.
data object TrainingUnanswered : Exception()

@OptIn(ExperimentalCoroutinesApi::class, DelicateCoroutinesApi::class)
internal class GymActionContext : AbstractCoroutineContextElement(Key), ActionContext, CopyableThreadContextElement<Unit> {
    override var insideRun = false
    override fun updateThreadContext(context: CoroutineContext) = Unit
    override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) = Unit
    override fun copyForChild() = GymActionContext().also { it.insideRun = insideRun }
    override fun mergeForChild(overwritingElement: CoroutineContext.Element): CoroutineContext = overwritingElement
    companion object Key : CoroutineContext.Key<GymActionContext>
}

internal suspend fun <T> withGymActionContext(body: suspend (ActionContext) -> T): T {
    val inherited = coroutineContext[GymActionContext]
    if (inherited?.insideRun == true) return body(inherited)
    return withContext(GymActionContext()) { body(requireNotNull(coroutineContext[GymActionContext])) }
}
