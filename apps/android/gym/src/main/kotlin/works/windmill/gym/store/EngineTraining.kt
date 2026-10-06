package works.windmill.gym.store

import java.time.ZoneId
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import works.windmill.domain.kit.*
import works.windmill.gym.domain.*
import works.windmill.gym.domain.sync.*
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
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

class EngineTraining(val engine: Engine, private val rest: () -> TrainingSyncing?) : TrainingSyncing {
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
    var legacyUpdateRequired = false
        private set
    val updateRequired: Boolean get() = legacyUpdateRequired || engine.status.state.value.upgradeRequired
    val anonymous: Boolean get() = read { it.isAnonymous }
    val firstPullComplete: Boolean get() = read { it.firstPullComplete() }
    val notesReady: Boolean get() = anonymous || firstPullComplete

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
            override fun load(read: Reader) = withLegacyCatalogue(action, action.load(read), read)
            override fun decide(loaded: L, ids: IDSource) = action.decide(loaded, ids)
        }
        return when (val outcome = run(wrapped)) {
            is Outcome.Committed -> outcome.result
            is Outcome.Unchanged -> outcome.result
            is Outcome.Refused -> throw refusal(outcome.refusal)
        }
    }
    private fun cachedCatalogue(read: Reader): Catalogue {
        val catalogue = Catalogue(read, ViewMode.stored)
        if (read.isAnonymous || read.firstPullComplete()) return catalogue
        val cached = cache<Exercise>("cache", "movements").filter { old -> catalogue.exercises.none { it.id.text == old.id } }
            .map { old -> EngineExercise(Id(old.id, EngineExercise), old.name, old.pattern, old.equipment,
                old.stepKg ?: ExerciseRules.defaultStepKg(old.equipment), old.aliases) }
        return Catalogue(catalogue.exercises + cached)
    }
    @Suppress("UNCHECKED_CAST")
    private fun <L, T> withLegacyCatalogue(action: Decider<L, T, GymRefusal>, loaded: L, read: Reader): L {
        if (read.isAnonymous || read.firstPullComplete()) return loaded
        if (loaded is TrainingState) return loaded.copy(catalogue = cachedCatalogue(read)) as L
        if (action is StartSession && loaded is StartSession.Loaded) {
            val cached = action.routineId?.let { id -> program().firstOrNull { it.id == id.text } }
            val routine = loaded.routine ?: cached?.let { RoutineWrite(it).engine(null) }
            return loaded.copy(state = loaded.state.copy(catalogue = cachedCatalogue(read)), routine = routine) as L
        }
        return loaded
    }
    private suspend fun <T> ancillary(body: suspend (TrainingSyncing) -> T): T = try {
        body(rest() ?: throw WindmillApiException.Refused(401, Refusal("Sign in first.")))
    } catch (failure: WindmillApiException.Refused) {
        if (failure.status == 410 && failure.refusal.code == "client-update-required") legacyUpdateRequired = true
        throw failure
    }

    private inline fun <reified T> cache(kind: String, field: String? = null): List<T> = LegacyGymMigration.cached(engine, kind).flatMap { source ->
        val values = if (field == null) listOf(source) else (source[field] as? Json.Arr)?.values.orEmpty()
        values.mapNotNull { value -> runCatching { WindmillJson.decodeFromString<T>(value.jcs) }.getOrNull() }
    }
    override suspend fun exercises(): List<Exercise> = catalogue()
    fun catalogue(): List<Exercise> = read { reader ->
        val aliases = reader.device("rack:aliases0")?.obj().orEmpty()
        val served = Catalogue(reader).exercises.map { value -> value.ui().let { exercise ->
            val phone = aliases[exercise.id]?.arr()?.map(Json::str).orEmpty()
            val pending = reader.repository(EngineExercise).record(value.id, ViewMode.drawn)?.isPending == true ||
                reader.repository(ExerciseName).record(Id(value.id.record, ExerciseName), ViewMode.drawn)?.isPending == true
            val ordered = if (pending) phone + exercise.aliases else exercise.aliases + phone
            exercise.copy(aliases = ordered.filter { it != exercise.name }.distinct().take(5))
        } }
        val available = if (reader.isAnonymous || reader.firstPullComplete()) served else {
            val localIds = reader.repository(EngineExercise).all(ViewMode.drawn).mapTo(mutableSetOf()) { it.id.text } +
                reader.repository(ExerciseName).all(ViewMode.drawn).map { it.id.text }
            val held = cache<Exercise>("cache", "movements").filterNot { it.id in localIds }
            served.filterNot { value -> held.any { it.id == value.id } } + held
        }
        LegacyGymMigration.edits(engine).filter { it.kind == "exercise" }.fold(available) { current, edit ->
            val changed = edit.source?.let { WindmillJson.decodeFromString<Exercise>(it.jcs) }
            current.filterNot { it.id == edit.id } + listOfNotNull(changed)
        }
    }.sortedWith { a, b -> compareBytes(a.pattern, b.pattern).takeIf { it != 0 }
        ?: compareBytes(a.name, b.name).takeIf { it != 0 } ?: compareBytes(a.id, b.id) }
    override suspend fun createExercise(write: ExerciseWrite): Exercise {
        val value = EngineExercise(Id(write.id, EngineExercise), write.name, write.pattern, write.equipment,
            write.stepKg ?: ExerciseRules.defaultStepKg(write.equipment))
        val existing = read { it.repository(EngineExercise).find(value.id, ViewMode.drawn) }
        if (existing == null) apply(CreateExercise(value))
        return exercises().first { it.id == write.id }
    }
    override suspend fun renameExercise(exerciseId: String, name: String): Exercise {
        val old = catalogue().firstOrNull { it.id == exerciseId } ?: throw missing("That movement is no longer on the log.")
        if (!anonymous && !firstPullComplete && read { it.repository(EngineExercise).find(Id(exerciseId, EngineExercise), ViewMode.drawn) } == null && old.custom) {
            val changed = old.copy(name = ExerciseRules.name.apply(name, Path("name")),
                aliases = ExerciseRules.renamedAliases(old.name, name, old.aliases))
            LegacyGymMigration.deferEdit(engine, "exercise", exerciseId, Json.parse(WindmillJson.encodeToString(changed)), Json.parse(WindmillJson.encodeToString(old)))
            return changed
        }
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
        LegacyGymMigration.discardRefusal(engine, exerciseId)
        return exercises().first { it.id == exerciseId }
    }
    override suspend fun startSession(start: SessionStart): Session {
        val open = read { TrainingLog(it).open }
        if (start.joinOpenSession == false && open != null && open.id.text != start.id)
            throw WindmillApiException.Refused(409, Refusal("A workout is already open. Finish it first.", code = "session-already-open"))
        val action = StartSession(Id(start.id, EngineSession), start.routineId?.let { Id(it, EngineRoutine) }, Instant(start.startedAt))
        val id = apply(object : Action<StartSession.Loaded, Id<EngineSession>, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = withLegacyCatalogue(action, action.load(read), read)
            override fun decide(loaded: StartSession.Loaded, ids: IDSource): Decision<Id<EngineSession>, GymRefusal> {
                val decision = action.decide(loaded, ids)
                if (decision !is Decision.Write || start.joinOpenSession != false) return decision
                val command = requireNotNull(decision.plan.command)
                val explicit = object : ServerCommand {
                    override val name = command.name
                    override val args = command.args.obj() + ("joinOpenSession" to Json.of(false))
                    override val specs = emptyList<ValueSpec>()
                }
                return Decision.Write(Plan(explicit, decision.plan.predictions), decision.result)
            }
        })
        return session(id.text)?.session ?: throw WindmillApiException.Malformed
    }
    override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
        val value = EngineSet(Id(write.id, EngineSet), Id(sessionId, EngineSession), Id(write.exerciseId, EngineExercise),
            write.weightKg, write.reps, write.kind.wire, completedAt = Instant(write.completedAt))
        val existing = read { it.repository(EngineSet).find(value.id, ViewMode.drawn) }
        if (existing != null) {
            if (existing.sessionId != value.sessionId || existing.exerciseId != value.exerciseId || existing.completedAt != value.completedAt)
                throw WindmillApiException.Refused(409, Refusal("that set id is already used", code = "set-id-taken"))
            return existing.ui()
        }
        LegacyGymMigration.pendingOwnedStart(engine, sessionId)?.let { pending ->
            pending.sets.firstOrNull { it.id == write.id }?.let { old ->
                if (old.exerciseId != write.exerciseId || old.completedAtMs != write.completedAt)
                    throw WindmillApiException.Refused(409, Refusal("that set id is already used", code = "set-id-taken"))
                return old
            }
            val set = checkedPendingSet(sessionId, value.ui())
            val entry = SetQueue.Entry(set, sessionId, needsPush = true, remints = 0)
            if (LegacyGymMigration.retainPendingWorkout(engine, pending.copy(sets = pending.sets + set), listOf(entry), emptyList())) return set
        }
        val migration = LegacyGymMigration.operations(engine).firstOrNull { it.entry.set.id == write.id }
        if (migration?.entry?.attempted == true && !anonymous && !firstPullComplete) throw WindmillApiException.Offline
        apply(AppendSet(value))
        return read { it.repository(EngineSet).find(value.id, ViewMode.drawn) }?.ui() ?: throw WindmillApiException.Malformed
    }
    private fun checkedPendingSet(sessionId: String, set: TrainingSet): TrainingSet = read { reader ->
        val value = EngineSet(Id(set.id, EngineSet), Id(sessionId, EngineSession), Id(set.exerciseId, EngineExercise),
            set.weightKg, set.reps, set.kind.wire, set.rpe, set.note, Instant(set.completedAtMs), set.setNumber)
        if (cachedCatalogue(reader).find(value.exerciseId) == null)
            throw refusal(GymRefusal.of(Refused(RefusalCode(Gym.Codes.unknownExercise), value.id.ref, path = Refused.Path.predicted)))
        try { Valid(value, EngineSet, at = reader.moment).value.ui() }
        catch (invalid: Violation) { throw refusal(GymRefusal.of(invalid)) }
    }
    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet {
        LegacyGymMigration.pendingOwnedStart(engine, sessionId)?.let { pending ->
            val old = pending.sets.firstOrNull { it.id == setId } ?: throw missing("That set is no longer on the log.")
            val next = checkedPendingSet(sessionId, fix.corrected(old))
            val entry = (LegacyGymMigration.operations(engine).firstOrNull { it.sessionId == sessionId && it.entry.set.id == setId }?.entry
                ?: SetQueue.Entry(next, sessionId, needsPush = true, remints = 0)).copy(set = next, needsPush = true, write = Owed.Fix)
            if (LegacyGymMigration.retainPendingWorkout(engine, pending.copy(sets = pending.sets.map { if (it.id == setId) next else it }), listOf(entry), emptyList())) return next
        }
        val old = read { it.repository(EngineSet).find(Id(setId, EngineSet), ViewMode.drawn) }
            ?.takeIf { it.sessionId.text == sessionId } ?: throw missing("That set is no longer on the log.")
        val next = old.copy(weightKg = fix.weightKg ?: old.weightKg, reps = fix.reps ?: old.reps,
            kind = fix.kind?.wire ?: old.kind, note = fix.note ?: old.note, rpe = if (fix.rpeNamed) fix.rpe else old.rpe)
        apply(CorrectSet(next))
        return read { it.repository(EngineSet).find(next.id, ViewMode.drawn) }?.ui() ?: throw WindmillApiException.Malformed
    }
    override suspend fun deleteSet(sessionId: String, setId: String) {
        LegacyGymMigration.pendingOwnedStart(engine, sessionId)?.let { pending ->
            val old = pending.sets.firstOrNull { it.id == setId } ?: return
            val entry = (LegacyGymMigration.operations(engine).firstOrNull { it.sessionId == sessionId && it.entry.set.id == setId }?.entry
                ?: SetQueue.Entry(old, sessionId, needsPush = true, remints = 0)).copy(needsPush = true, write = Owed.Delete)
            if (LegacyGymMigration.retainPendingWorkout(engine, pending.copy(sets = pending.sets.filterNot { it.id == setId },
                    deleted = (pending.deleted + setId).distinct()), listOf(entry), emptyList())) return
        }
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
    override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session {
        LegacyGymMigration.pendingOwnedStart(engine, sessionId)?.let { pending ->
            if (finishedAtMs <= 0 || finishedAtMs !in pending.session.startedAtMs..SessionRules.maxInstantMs)
                throw refusal(GymRefusal.of(Refused(RefusalCode(Gym.Codes.badInstant), Id(sessionId, EngineSession).ref, path = Refused.Path.predicted)))
            val closed = pending.session.copy(finishedAtMs = finishedAtMs)
            if (LegacyGymMigration.retainPendingWorkout(engine, pending.copy(session = closed), emptyList(), emptyList())) return closed
        }
        apply(FinishSession(Id(sessionId, EngineSession), Instant(finishedAtMs)))
        return session(sessionId)?.session ?: throw missing("That workout is no longer on the log.")
    }
    override suspend fun discardSession(sessionId: String) { apply(DiscardSession(Id(sessionId, EngineSession))) }
    fun prepareAdoption() {
        if (!anonymous) return
        for (detail in details()) {
            val deleted = read { reader -> reader.devices("rack:deletedSet").values.filter { it["sessionId"] == Json.of(detail.session.id) }
                .map { it.member("setId").str() } }
            val row = LocalLog.FinishedSession(detail.session, detail.sets, deleted)
            if (detail.session.isOpen) LegacyGymMigration.retainWorkout(engine, row) else LegacyGymMigration.retainAndImport(engine, row)
        }
    }
    fun openWorkout(): SessionDetail? {
        val id = read { TrainingLog(it).open?.id?.text }
        if (id != null) return details().firstOrNull { it.session.id == id }
        return LegacyGymMigration.pendingOwnedStart(engine)?.let { SessionDetail(it.session, it.sets) }
    }
    fun details(): List<SessionDetail> = read { reader ->
        val log = TrainingLog(reader)
        val cachedStarts = if (reader.isAnonymous || reader.firstPullComplete()) emptyList() else LegacyGymMigration.cached(engine, "start")
        val drawn = log.drawnSessions.map { session ->
            val sets = log.sets(session.id).map { it.ui() }
            val held = cachedStarts.firstOrNull { it["session"]?.get("id") == session.id.json }?.get("entries")?.obj().orEmpty().values.mapNotNull { entry ->
                runCatching { WindmillJson.decodeFromString<SetQueue.Entry>(entry.jcs) }.getOrNull()?.takeIf { it.write != Owed.Delete }?.set
            }.filter { reader.repository(EngineSet).record(Id(it.id, EngineSet), ViewMode.stored) == null }
            SessionDetail(session.ui(), (sets + held).distinctBy { it.id }.sortedWith(compareBy({ it.completedAtMs }, { it.id })))
        }
        drawn + LegacyGymMigration.retainedWorkouts(engine).filter { pending -> drawn.none { it.session.id == pending.session.id } }
            .map { SessionDetail(it.session, it.sets.filterNot { set -> set.id in it.deleted }) }
    }
    fun pendingSetIds(): Set<String> = read { reader -> reader.source.drawn(EngineSet.type)
        .filter { it.isVisible && (reader.isAnonymous || it.isPending) }.mapTo(mutableSetOf()) { it.id.toString() } } +
        LegacyGymMigration.operations(engine).filter { it.entry.write != Owed.Delete }.map { it.entry.set.id } +
        LegacyGymMigration.retainedWorkouts(engine).flatMap { row -> row.sets.filterNot { it.id in row.deleted }.map { it.id } }
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
    } + LegacyGymMigration.operations(engine).map { it.sessionId } + LegacyGymMigration.retainedWorkouts(engine).map { it.session.id }
    override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        if (!anonymous && !firstPullComplete && details().isEmpty()) throw WindmillApiException.Offline
        val history = details()
        val names = if (anonymous) emptyMap() else catalogue().associate { it.id to it.name }
        return history.sortedWith(compareByDescending<SessionDetail> { it.session.startedAtMs }.thenByDescending { it.session.id })
            .filter { before == null || it.session.startedAtMs < before || it.session.startedAtMs == before && (beforeId == null || it.session.id < beforeId) }
            .take(limit).map { detail ->
                val stale = read { TrainingLog(it).drawnSessions.firstOrNull { it.id.text == detail.session.id }?.closedBy == "stale" }
                val summary = EngineReadouts.summary(detail, history)
                summary.copy(closedItself = stale, exercises = summary.exercises.map { names[it] ?: it })
            }
    }
    override suspend fun session(id: String): SessionDetail? = details().firstOrNull { it.session.id == id }
    override suspend fun review(sessionId: String): Review = EngineReadouts.review(
        session(sessionId) ?: throw missing("That workout is no longer on the log."), details())
    override suspend fun lastTime(exerciseId: String): LastTime {
        if (catalogue().none { it.id == exerciseId }) throw WindmillApiException.Refused(400,
            Refusal("That movement is not in the catalog.", code = "unknown-exercise"))
        val known = LastTime.of(exerciseId, details())
        if (!anonymous && !firstPullComplete && known.isFirstTime) throw WindmillApiException.Offline
        return known
    }
    override suspend fun lastSets(): List<LastSet> {
        val known = LastSet.of(details())
        if (anonymous || firstPullComplete) return known
        val sources = LegacyGymMigration.cached(engine, "cache")
        val answered = sources.any { it["lastSets"] is Json.Arr }
        if (!answered && known.isEmpty()) throw WindmillApiException.Offline
        return (known + cache<LastSet>("cache", "lastSets")).groupBy { it.exerciseId }.values.map { rows -> rows.maxBy { it.atMs } }.sortedBy { it.exerciseId }
    }
    override suspend fun routines(): List<Routine> = program()
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
        val held = if (reader.isAnonymous || reader.firstPullComplete()) emptyList() else cache<Routine>("cache", "routines").filter { value ->
            reader.repository(EngineRoutine).record(Id(value.id, EngineRoutine), ViewMode.stored) == null
        }
        val available = LegacyGymMigration.edits(engine).filter { it.kind == "routine" }.fold(served + held) { current, edit ->
            val write = edit.source?.let { WindmillJson.decodeFromString<RoutineWrite>(it.jcs) }
            val base = current.firstOrNull { it.id == edit.id } ?: WindmillJson.decodeFromString<Routine>(edit.base.jcs)
            val changed = write?.let { base.copy(name = it.name, position = it.position,
                entries = it.entries.mapIndexed { index, entry -> RoutineEntry(index + 1, entry.exerciseId, entry.sets) }) }
            current.filterNot { it.id == edit.id } + listOfNotNull(changed)
        }
        available.sortedWith(compareByDescending<Routine> { it.lastTrainedAtMs ?: Long.MIN_VALUE }.thenBy { it.position }.thenBy { it.id })
    }
    override suspend fun routine(id: String): Routine? = routines().firstOrNull { it.id == id }
    override suspend fun createRoutine(write: RoutineWrite): Routine {
        val value = write.engine(null)
        if (routine(write.id) == null) apply(saveRoutine(value))
        return routine(write.id) ?: throw WindmillApiException.Malformed
    }
    override suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine = writing { runner ->
        val old = read { it.repository(EngineRoutine).find(Id(id, EngineRoutine), ViewMode.drawn) }
        if (old == null && !anonymous && !firstPullComplete) {
            val cached = program().firstOrNull { it.id == id } ?: throw missing("That routine is no longer on the log.")
            if (write.expectedRevision != null && write.expectedRevision != cached.revision) throw WindmillApiException.Refused(409, Refusal("That routine changed. Open it again.", code = "stale"))
            LegacyGymMigration.deferEdit(engine, "routine", id, Json.parse(WindmillJson.encodeToString(write.copy(id = id))), Json.parse(WindmillJson.encodeToString(cached)))
            return@writing program().first { it.id == id }
        }
        if (old == null) throw missing("That routine is no longer on the log.")
        if (write.expectedRevision != null && old.revision != null && write.expectedRevision != old.revision)
            throw WindmillApiException.Refused(409, Refusal("That routine changed. Open it again.", code = "stale"))
        val draft = Draft.opening(old).edit { write.copy(id = id).engine(old) }
        when (val result = runner.save(draft, EngineRoutine, GymRefusal) {}) {
            is SaveResult.Refused -> throw refusal(result.refusal)
            is SaveResult.Failed -> throw result.error
            is SaveResult.Saved -> Unit
        }
        LegacyGymMigration.discardRefusal(engine, id)
        read { it.repository(EngineRoutine).find(Id(id, EngineRoutine), ViewMode.drawn) }!!.ui()
    }
    override suspend fun deleteRoutine(id: String) {
        if (!anonymous && !firstPullComplete && read { it.repository(EngineRoutine).find(Id(id, EngineRoutine), ViewMode.drawn) } == null) {
            val cached = program().firstOrNull { it.id == id } ?: return
            LegacyGymMigration.deferEdit(engine, "routine", id, null, Json.parse(WindmillJson.encodeToString(cached)))
        } else apply(deleteRoutine(Id(id, EngineRoutine)))
    }
    override suspend fun proposal(id: String): Proposal? = read { reader ->
        val identity = Id(id, EngineProposal)
        val queued = reader.commands().any { it.command.name in setOf(Gym.Commands.applyProposal, Gym.Commands.dismissProposal) && it.command.args["proposalId"] == identity.json }
        if (queued) reader.confirmed(EngineProposal, identity)?.takeIf { it.isVisible }?.let { EngineProposal.decode(Fields(it)).ui(reader) }
        else reader.repository(EngineProposal).find(identity, ViewMode.drawn)?.ui(reader)
    }
    override suspend fun applyProposal(id: String) = decideProposal(id, applying = true)
    override suspend fun dismissProposal(id: String) = decideProposal(id, applying = false)
    private suspend fun decideProposal(id: String, applying: Boolean): ProposalDecision {
        val replica = engine.activeReplica()
        val status = engine.status.state.value
        if (anonymous || status.authPaused) throw WindmillApiException.Refused(401, Refusal("Sign in again to decide this proposal."))
        if (!status.online) throw WindmillApiException.Offline
        val before = engine.notices("gym").notices.value.map { it.id }.toSet()
        if (applying) apply(ApplyProposal(Id(id, EngineProposal))) else apply(DismissProposal(Id(id, EngineProposal)))
        return withTimeoutOrNull(15_000) {
            while (true) {
                if (engine.activeReplica() != replica) throw WindmillApiException.Refused(409, Refusal("The account changed. Open this again."))
                engine.notices("gym").notices.value.firstOrNull { notice -> notice.id !in before &&
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
        } ?: throw WindmillApiException.Offline
    }
    override suspend fun progress(): StatsProgress = StatsProgress.of(details(), engine.physNow())
    override suspend fun record(exerciseId: String): MovementRecord? = exercises().firstOrNull { it.id == exerciseId }
        ?.let { EngineReadouts.record(it, details(), routines(), engine.physNow()) }
    override suspend fun preferences(): GymPreferences = settings()
    fun settings(): GymPreferences = read { reader ->
        val saved = reader.repository(Preferences).find(Preferences().id, ViewMode.drawn)
        if (saved == null && !reader.isAnonymous && !reader.firstPullComplete()) cache<GymPreferences>("cachePreferences").lastOrNull()?.let { return@read it }
        val value = saved ?: Preferences()
        GymPreferences(Units.entries.first { it.wire == value.units }, value.confirmHaptic, value.confirmSound)
    }
    override suspend fun savePreferences(document: GymPreferences): GymPreferences {
        val next = Preferences(units = document.units.wire, confirmHaptic = document.confirmHaptic, confirmSound = document.confirmSound)
        writing { runner ->
            val draft = runner.open(Preferences, next.id, Preferences()).edit { next }
            when (val result = runner.save(draft, Preferences, GymRefusal) {}) {
                is SaveResult.Refused -> throw refusal(result.refusal)
                is SaveResult.Failed -> throw result.error
                is SaveResult.Saved -> Unit
            }
        }
        return preferences()
    }
    override suspend fun notes(): List<Note> = read { reader -> reader.repository(EngineNote).all(ViewMode.drawn)
        .mapIndexed { index, note -> Note(note.id.text, index, note.title, note.body, note.updatedAt?.ms ?: 0) } }
    override suspend fun writeNote(id: String, write: NoteWrite): Note {
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
    override suspend fun deleteNote(id: String) { apply(deleteNote(Id(id, EngineNote))) }
    override suspend fun reorderNotes(order: List<String>): List<Note> {
        if (order.distinct().size != order.size || order.toSet() != notes().map { it.id }.toSet())
            throw WindmillApiException.Refused(409, Refusal("The notes changed. Read them again.", code = "stale"))
        apply(object : Action<List<EngineNote>, Unit, GymRefusal> {
            override val scope = EngineNote.scope
            override val refusals = GymRefusal
            override fun load(read: Reader) = read.repository(EngineNote).all(ViewMode.drawn)
            override fun decide(loaded: List<EngineNote>, ids: IDSource): Decision<Unit, GymRefusal> {
                if (loaded.map { it.id.text }.toSet() != order.toSet()) return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.stale, null, path = Refused.Path.predicted)))
                val plan = Plan()
                for ((index, id) in order.withIndex()) plan.move(Id(id, EngineNote), order.getOrNull(index - 1)?.let { Id(it, EngineNote) })
                return Decision.Write(plan, Unit)
            }
        })
        return notes()
    }
    override suspend fun bodyweight(from: String?, to: String?): List<WeighIn> = weighins(from, to)
    fun weighins(from: String? = null, to: String? = null): List<WeighIn> = read { reader ->
        val served = reader.repository(EngineWeighIn).all(ViewMode.drawn).mapNotNull { it.kg?.let { kg -> WeighIn(it.id.text, kg, it.recordedAt?.ms ?: 0) } }
        val held = if (reader.isAnonymous || reader.firstPullComplete()) emptyList() else cache<WeighIn>("cacheWeighin").filter { value ->
            reader.repository(EngineWeighIn).record(Id(value.dateLocal, EngineWeighIn), ViewMode.stored) == null
        }
        val deleted = LegacyGymMigration.edits(engine).filter { it.kind == Gym.Types.weighin && it.source == null }.map { it.id }.toSet()
        (served + held).filter { it.dateLocal !in deleted && (from == null || it.dateLocal >= from) && (to == null || it.dateLocal <= to) }.sortedBy { it.dateLocal }
    }
    override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn {
        val day = LocalDay.parse(dateLocal) ?: throw WindmillApiException.Refused(400, Refusal(works.windmill.gym.domain.Bodyweight.notAForecast, code = "bad-instant"))
        val next = EngineWeighIn(day, write.weightKg, Instant(write.recordedAt))
        val old = read { it.repository(EngineWeighIn).find(next.id, ViewMode.drawn) }
        if (old?.recordedAt == null || old.recordedAt!! <= next.recordedAt!!) {
            val action = saveWeighIn(next)
            apply(object : Action<Pair<SaveDraftLoaded<EngineWeighIn>, List<works.windmill.sync.api.DeviceWrite>>, Saved, GymRefusal> {
                override val scope = action.scope
                override val refusals = action.refusals
                override fun load(read: Reader) = action.load(read) to LegacyGymMigration.resolveEditWrites(read.source, Gym.Types.weighin, dateLocal)
                override fun decide(loaded: Pair<SaveDraftLoaded<EngineWeighIn>, List<works.windmill.sync.api.DeviceWrite>>, ids: IDSource): Decision<Saved, GymRefusal> {
                    val decision = action.decide(loaded.first, ids)
                    val write = when (decision) {
                        is Decision.Write -> decision
                        is Decision.Unchanged -> if (loaded.second.isEmpty()) return decision else Decision.Write(Plan(), decision.result)
                        is Decision.Refuse -> return decision
                    }
                    loaded.second.forEach { write.plan.device(it.key, it.value) }
                    return write
                }
            })
        }
        LegacyGymMigration.discardRefusal(engine, dateLocal)
        return bodyweight(dateLocal, dateLocal).first()
    }
    override suspend fun deleteBodyweight(dateLocal: String) {
        if (!anonymous && !firstPullComplete && read { it.repository(EngineWeighIn).record(Id(dateLocal, EngineWeighIn), ViewMode.drawn) } == null) {
            val cached = cache<WeighIn>("cacheWeighin").firstOrNull { it.dateLocal == dateLocal } ?: return
            LegacyGymMigration.deferEdit(engine, Gym.Types.weighin, dateLocal, null, Json.parse(WindmillJson.encodeToString(cached)))
        } else apply(deleteWeighIn(Id(dateLocal, EngineWeighIn)))
    }
    override suspend fun share(sessionId: String) = ancillary { it.share(sessionId) }
    override suspend fun revokeShare(sessionId: String) = ancillary { it.revokeShare(sessionId) }
    override suspend fun ask(question: AskQuestion) = ancillary { it.ask(question) }
    override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit) = ancillary { it.stream(question, onSnapshot) }
    override suspend fun stop(threadId: String, requestId: String) = ancillary { it.stop(threadId, requestId) }
    override suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit) = ancillary { it.uploadPhoto(threadId, photo, bytes, onProgress) }
    override suspend fun photo(threadId: String, attachmentId: String) = ancillary { it.photo(threadId, attachmentId) }
    override suspend fun threads() = ancillary { it.threads() }
    override suspend fun thread(id: String) = ancillary { it.thread(id) }
    override suspend fun threadPage(id: String, before: String?) = ancillary { it.threadPage(id, before) }
    override suspend fun threadsPage(cursor: String?) = ancillary { it.threadsPage(cursor) }
    override suspend fun deleteThread(id: String) = ancillary { it.deleteThread(id) }
    override suspend fun grants() = ancillary { it.grants() }
    override suspend fun mcpKeys() = ancillary { it.mcpKeys() }

    suspend fun reconcileLegacyOperations() {
        LegacyGymMigration.reconcileConfirmed(engine)
        if (!anonymous && firstPullComplete) for (edit in LegacyGymMigration.edits(engine)) {
            try {
                when (edit.kind) {
                    Gym.Types.weighin -> deleteBodyweight(edit.id)
                    "exercise" -> {
                        val requested = edit.source?.let { WindmillJson.decodeFromString<Exercise>(it.jcs) }
                            ?: throw missing("That movement is no longer on the log.")
                        renameExercise(edit.id, requested.name)
                    }
                    "routine" -> if (edit.source == null) apply(deleteRoutine(Id(edit.id, EngineRoutine))) else {
                        val write = WindmillJson.decodeFromString<RoutineWrite>(edit.source!!.jcs)
                        val base = WindmillJson.decodeFromString<Routine>(edit.base.jcs)
                        replaceRoutine(edit.id, write.copy(expectedRevision = write.expectedRevision ?: base.revision))
                    }
                }
                LegacyGymMigration.resolveEdit(engine, edit.token)
            } catch (refused: WindmillApiException.Refused) {
                LegacyGymMigration.refuseEdit(engine, edit.token, refused.refusal.code ?: "invalid")
            }
        }
        if (anonymous || firstPullComplete) for (deletion in LegacyGymMigration.deletedSets(engine)) {
            deleteSet(deletion.sessionId, deletion.setId)
            LegacyGymMigration.resolveDeletion(engine, deletion.token)
        }
        for (operation in LegacyGymMigration.operations(engine)) {
            if (!anonymous && !firstPullComplete) continue
            if (LegacyGymMigration.refusals(engine).any { it.id == operation.sessionId && it.session?.isOpen == true }) continue
            if (!anonymous && read { it.confirmed(EngineSession, Id(operation.sessionId, EngineSession))?.isVisible != true }) continue
            val entry = operation.entry
            try {
                val known = read { it.repository(EngineSet).find(Id(entry.set.id, EngineSet), ViewMode.drawn) }
                if (entry.step == Owed.Append || known == null && entry.write != Owed.Delete) appendSet(operation.sessionId, SetWrite(entry.set))
                when (entry.write) {
                    Owed.Append -> Unit
                    Owed.Fix -> fixSet(operation.sessionId, entry.set.id, SetFix(entry.set))
                    Owed.Delete -> deleteSet(operation.sessionId, entry.set.id)
                }
                LegacyGymMigration.resolveOperation(engine, operation.token)
            } catch (refused: WindmillApiException.Refused) {
                LegacyGymMigration.refuseOperation(engine, operation.token, refused.refusal.code ?: "invalid")
            }
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
        } else RefusedClaim(notice.id, "Saved change", reason)
    }
    fun refusedNotes(): List<RefusedWrite> = engine.notices("gym").notices.value.mapNotNull { notice ->
        val domain = DomainNotice(notice, engine.registry, GymRefusal)
        val subject = domain.subject?.takeIf { it.type == EngineNote.type } ?: return@mapNotNull null
        val title = domain.values(subject)["title"]?.str().orEmpty()
        RefusedClaim(notice.id, "Note: $title", refusal(domain.refusal).line)
    }
    fun dismissRefusals() { for (notice in engine.notices("gym").notices.value) engine.dismissNotice(notice.id) }

    fun commitAccepted(queue: SetQueue, entry: SetQueue.Entry): TrainingSet {
        val write = SetWrite(entry.set)
        val value = EngineSet(Id(write.id, EngineSet), Id(entry.sessionId, EngineSession), Id(write.exerciseId, EngineExercise),
            write.weightKg, write.reps, write.kind.wire, completedAt = Instant(write.completedAt))
        val action = AppendSet(value)
        val runner = ActionRunner(engine, engine.registry, zone, object : ActionContext { override var insideRun = false })
        val existing = read { it.repository(EngineSet).find(value.id, ViewMode.drawn) }
        if (existing != null && (existing.sessionId != value.sessionId || existing.exerciseId != value.exerciseId || existing.completedAt != value.completedAt))
            throw WindmillApiException.Refused(409, Refusal("that set id is already used", code = "set-id-taken"))
        if (existing == null) LegacyGymMigration.pendingOwnedStart(engine, entry.sessionId)?.let { pending ->
            val checked = checkedPendingSet(entry.sessionId, entry.set)
            val row = pending.copy(sets = (queue.sets(entry.sessionId).filterNot { it.id == checked.id } + checked)
                .sortedWith(compareBy({ it.completedAtMs }, { it.id })))
            if (LegacyGymMigration.retainPendingWorkout(engine, row, listOf(entry.copy(set = checked)), controls(queue))) return checked
        }
        if (existing == null) when (val outcome = runner.run(object : Action<TrainingState, Id<EngineSet>, GymRefusal> {
            override val scope = action.scope
            override val refusals = action.refusals
            override fun load(read: Reader) = action.load(read).let { if (read.isAnonymous || read.firstPullComplete()) it else it.copy(catalogue = cachedCatalogue(read)) }
            override fun decide(loaded: TrainingState, ids: IDSource): Decision<Id<EngineSet>, GymRefusal> = when (val decision = action.decide(loaded, ids)) {
                is Decision.Write -> decision.also { controls(queue).forEach { write -> it.plan.device(write.key, write.value) } }
                else -> decision
            }
        })) {
            is Outcome.Refused -> throw refusal(outcome.refusal)
            else -> Unit
        }
        return read { it.repository(EngineSet).find(value.id, ViewMode.drawn) }?.ui() ?: throw WindmillApiException.Malformed
    }
    private fun controls(queue: SetQueue): List<works.windmill.sync.api.DeviceWrite> = queue.session?.let { session -> listOf(
        works.windmill.sync.api.DeviceWrite("movementOrder:${session.id}", Json.Arr(queue.order.map(Json::of))),
        works.windmill.sync.api.DeviceWrite("movement:${session.id}", queue.chosenMovement?.let(Json::of)),
        works.windmill.sync.api.DeviceWrite("rack:${session.id}", Json.parse(WindmillJson.encodeToString(WorkoutState.serializer(), queue.workout))),
    ) }.orEmpty()
    fun persistControls(queue: SetQueue) {
        if (queue.engineReplica != engine.activeReplica()) return
        val wanted = controls(queue)
        if (engine.read(EngineSession.scope) { reader -> wanted.all { reader.device(it.key) == it.value } }) return
        engine.commit(EngineSession.scope) { reader ->
            val changed = wanted.filter { reader.device(it.key) != it.value }
            if (changed.isEmpty()) null to Unit else works.windmill.sync.api.Gesture(emptyList(), local = changed) to Unit
        }
    }
    fun restoreControls(queue: SetQueue) {
        val session = queue.session ?: return
        val original = LegacyGymMigration.sourceSessionId(engine, session.id)
        engine.read(EngineSession.scope) { reader ->
            fun device(kind: String) = reader.device("$kind:${session.id}") ?: original?.let { reader.device("$kind:$it") }
            device("movementOrder")?.arr()?.map(Json::str)?.let(queue::hold)
            device("movement")?.str()?.let(queue::choose)
            device("rack")?.let { value ->
                val controls = WindmillJson.decodeFromString(WorkoutState.serializer(), value.jcs)
                queue.control(controls.invalidate())
            }
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
    private fun missing(message: String) = WindmillApiException.Refused(404, Refusal(message, code = "unknown-record"))
    private fun refusal(refusal: GymRefusal): WindmillApiException.Refused {
        val (code, message) = when (refusal) {
            is GymRefusal.Invalid -> "invalid" to "Check ${refusal.violation.path.text.substringAfterLast('.')}."
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
        val status = when (code) { "unknown-record" -> 404; "invalid", "bad-instant", "unknown-exercise" -> 400; else -> 409 }
        return WindmillApiException.Refused(status, Refusal(message, code = code))
    }
}
