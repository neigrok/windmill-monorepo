package works.windmill.gym.domain.coach

import works.windmill.domain.kit.*
import works.windmill.gym.domain.sync.Bodyweight
import works.windmill.gym.domain.sync.Catalogue
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.GymEstimate
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.LastTime
import works.windmill.gym.domain.sync.Note
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.RoutineChange
import works.windmill.gym.domain.sync.RoutineEntry
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.TrainingHistory
import works.windmill.gym.domain.sync.TrainingLog
import works.windmill.gym.domain.sync.TrainingSet
import works.windmill.gym.domain.sync.WeighIn
import works.windmill.gym.domain.sync.WeighInRules
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.compareBytes

// The read abilities over the replica (Coach INV-4, INV-5): each a decider that loads what its projection needs and answers the server's result bytes, with the rows it served. The documents every ability prints are here too.

// What one ability call answers: the result the model reads, the log rows it served, the records it created.
data class AbilityAnswer(val payload: Json, val served: ReadServed = ReadServed.none, val created: List<RecordRef> = emptyList())

object CoachDocuments {
    fun entries(entries: List<RoutineEntry>): Json = Json.Arr(entries.mapIndexed { index, entry ->
        Json.Obj(entry.json.obj().toList() + ("position" to Json.of(index + 1)))
    })

    // A routine as the program lists it; a revision the log has not numbered yet reads as the first.
    fun routine(value: Routine, lastTrainedAt: Instant? = null, pending: Proposal? = null): Json = Json.Obj(buildList {
        add("id" to value.id.json); add("name" to Json.of(value.name)); add("position" to Json.of(value.position)); add("revision" to Json.of(value.revision ?: 1))
        lastTrainedAt?.let { add("lastTrainedAt" to Json.of(it.ms)) }
        add("entries" to entries(value.entries))
        pending?.let { add("pendingProposal" to Json.Obj(head(it, value))) }
    })

    private fun head(value: Proposal, routine: Routine?): List<Pair<String, Json>> = buildList {
        add("id" to value.id.json); add("routineId" to value.routineId.json); add("intent" to Json.of(value.intent))
        add("state" to Json.of(value.state)); add("summary" to Json.of(value.summary))
        routine?.let { add("changeCount" to Json.of(value.changeCount(it))) }
        value.settledAt?.let { add("settledAt" to Json.of(it.ms)) }
        add("source" to source(value.door, value.connection, value.agent, value.threadId))
    }

    private fun source(door: String, connection: String, agent: String, thread: String?): Json = Json.Obj(buildList {
        add("door" to Json.of(door))
        if (connection.isNotEmpty()) add("connection" to Json.of(connection))
        if (agent.isNotEmpty()) add("agent" to Json.of(agent))
        thread?.let { add("thread" to Json.of(it)) }
    })

    private fun change(value: RoutineChange, index: Int, loggedSets: Int? = null): Json =
        Json.Obj(value.json.obj().toList() + listOfNotNull("position" to Json.of(index + 1), loggedSets?.let { "loggedSets" to Json.of(it) }))

    // A proposal's receipt: the proposal with its diff, where a human decides, and the words that keep the model honest.
    fun proposal(value: Proposal, routine: Routine?, loggedSets: (Id<Exercise>) -> Int, appBaseUrl: String): Json {
        val baseName = value.baseName ?: routine?.name
        val proposal = head(value, routine) + buildList {
            (value.baseRevision ?: routine?.revision)?.let { add("baseRevision" to Json.of(it)) }
            baseName?.let { add("baseName" to Json.of(it)) }
            add("name" to Json.of(value.proposedName))
            add("changes" to Json.Arr(value.changes.mapIndexed { index, line -> change(line, index, if (line.kind == "removed") loggedSets(line.exerciseId) else null) }))
        }
        val note = when (value.state) {
            "applied" -> "This proposal was already applied by the lifter — this is the record of it, not a second change."
            "dismissed" -> "The lifter rejected this proposal. Nothing changed. It stays in the routine's history. Do not resend the same id; propose again " +
                "only if you have something different to say."
            "superseded" -> "This proposal was superseded — the routine moved after it was minted, so it can no longer be applied. Read the routine again " +
                "with list_routines before you propose anything else."
            else -> "Nothing has changed. ${baseName ?: ""} still reads exactly as it did, and this proposal is waiting in the lifter's app until " +
                "they open it and tap Apply — no tool on this connection can apply it. Say so when you answer: the routine is unchanged and " +
                "something is waiting for them."
        }
        return Json.objectOf("proposal" to Json.Obj(proposal), "reviewUrl" to Json.of("$appBaseUrl/#/gym/proposals/${value.id}"), "note" to Json.of(note))
    }

    // A workout proposal's receipt: the proposal with its diff against the plan it read, and the words that keep the model honest. The lifter decides it on the workout's card, which has no address.
    fun workoutProposal(value: WorkoutProposal, base: List<RoutineEntry>, planRevision: Int?): Json {
        val proposal = Json.Obj(buildList {
            add("id" to value.id.json); add("sessionId" to value.sessionId.json); add("state" to Json.of(value.state)); add("summary" to Json.of(value.summary))
            add("changeCount" to Json.of(value.changeCount ?: RoutineChange.count(base, value.changes)))
            value.settledAt?.let { add("settledAt" to Json.of(it.ms)) }
            add("source" to source(value.door, value.connection, value.agent, value.threadId))
            add("baseRevision" to Json.of(value.baseRevision ?: planRevision ?: 1))
            add("changes" to Json.Arr(value.changes.mapIndexed { index, line -> change(line, index) }))
        })
        val note = when (value.state) {
            "applied" -> "This change was already applied by the lifter — this is the record of it, not a second change."
            "dismissed" -> "The lifter dismissed this change, and the workout kept its plan. Do not resend the same id; propose again only if you have " +
                "something different to say."
            "superseded" -> "This change was superseded — the workout's plan moved, or a newer change replaced it, so it can no longer be applied. Read the " +
                "workout again with get_session before you propose anything else."
            else -> "Nothing has changed. This workout keeps its plan, and this change is waiting on its card in the lifter's app until they tap " +
                "Apply — no tool on this connection can apply it. Say so when you answer: the workout is unchanged and a change is waiting for them."
        }
        return Json.objectOf("proposal" to proposal, "note" to Json.of(note))
    }

    fun note(value: Note, position: Int): Json =
        Json.objectOf("id" to value.id.json, "position" to Json.of(position), "title" to Json.of(value.title), "body" to Json.of(value.body))

    // Coach §3.3: an estimate in a result is stated to one decimal, rounding last: every `e1rm` and `topE1rm`, and the number a new best in e1RM is about.
    fun stated(document: Json): Json = when (document) {
        is Json.Arr -> Json.Arr(document.values.map(::stated))
        is Json.Obj -> {
            val estimate = document["kind"] == Json.of("e1rm")
            Json.Obj(document.members.map { (key, value) ->
                val states = key in listOf("e1rm", "topE1rm") || (estimate && key in listOf("value", "previous"))
                key to if (value is Json.Num && states) Json.of(GymEstimate.stated(value.value)) else stated(value)
            })
        }
        else -> document
    }

    // The order a workout's sets are read in: as performed, then by their number, then by id.
    fun performed(sets: List<TrainingSet>): List<TrainingSet> = sets.sortedWith(compareBy({ it.completedAt }, { it.setNumber ?: 0 }, { it.id }))

    // A movement's sets of one workout, by their number.
    fun numbered(sets: List<TrainingSet>): List<TrainingSet> = sets.sortedWith(compareBy({ it.setNumber ?: 0 }, { it.id }))
}

// `list_sessions`, `get_session`, `get_sessions`, `last_time`, `get_last_times` and `get_stats` over the whole history.
class LogRead(val query: Query) : Decider<TrainingHistory, AbilityAnswer, GymRefusal> {
    sealed interface Query {
        data class Sessions(val before: Instant, val beforeId: String, val limit: Int) : Query
        data class Workout(val id: Id<Session>, val review: Boolean) : Query
        data class Workouts(val ids: List<Id<Session>>, val review: Boolean) : Query
        data class LastTimeOf(val id: Id<Exercise>) : Query
        data class LastTimesOf(val ids: List<Id<Exercise>>) : Query
        data class Stats(val only: Id<Exercise>?) : Query
    }

    // A document of the log with the rows it served.
    private data class Line(val members: List<Pair<String, Json>>, val served: ReadServed)

    override val scope = Session.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = TrainingHistory(read)

    override fun decide(loaded: TrainingHistory, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        val answer = when (val query = query) {
            is Query.Sessions -> sessions(query, loaded)
            is Query.Workout -> {
                val session = loaded.log.drawnSessions.firstOrNull { it.id == query.id } ?: return Decision.Refuse(gone(query.id.ref))
                val line = workout(session, query.review, loaded)
                AbilityAnswer(Json.Obj(line.members), line.served)
            }
            is Query.Workouts -> workouts(query, loaded)
            is Query.LastTimeOf -> {
                val last = LastTime.of(query.id, newestFirst(loaded.log), loaded.log)
                if (last.session == null && loaded.log.catalogue.find(query.id) == null) return Decision.Refuse(gone(query.id.ref))
                val line = lastTime(last)
                AbilityAnswer(Json.Obj(line.members), line.served)
            }
            is Query.LastTimesOf -> lastTimes(query, loaded.log)
            is Query.Stats -> stats(query, loaded)
        }
        return Decision.Unchanged(answer)
    }

    private fun sessions(query: Query.Sessions, history: TrainingHistory): AbilityAnswer {
        val page = newestFirst(history.log)
            .filter { it.startedAt < query.before || (it.startedAt == query.before && it.id.record < RecordID(query.beforeId)) }
            .take(query.limit)
        return AbilityAnswer(Json.objectOf("sessions" to CoachDocuments.stated(Json.Arr(page.map(history::summary)))),
            page.fold(ReadServed.none) { served, session -> served.saw(session) })
    }

    private fun workouts(query: Query.Workouts, history: TrainingHistory): AbilityAnswer {
        val drawn = history.log.drawnSessions
        val lines = query.ids.mapNotNull { id -> drawn.firstOrNull { it.id == id }?.let { workout(it, query.review, history) } }
        val missing = query.ids.filter { id -> drawn.none { it.id == id } }
        return AbilityAnswer(Json.objectOf("sessions" to Json.Arr(lines.map { Json.Obj(it.members) }), "missingSessionIds" to Json.Arr(missing.map { it.json })),
            lines.fold(ReadServed.none) { served, line -> served.saw(line.served) })
    }

    private fun lastTimes(query: Query.LastTimesOf, log: TrainingLog): AbilityAnswer {
        val newest = newestFirst(log)
        val (known, missing) = query.ids.map { LastTime.of(it, newest, log) }.partition { it.session != null || log.catalogue.find(it.exerciseId) != null }
        val lines = known.map { last -> lastTime(last) to (last.session != null) }
        return AbilityAnswer(Json.objectOf(
            "exercises" to Json.Arr(lines.map { (line, trained) -> Json.Obj(line.members.filter { it.first != "routine" } + ("trained" to Json.of(trained))) }),
            "missingExerciseIds" to Json.Arr(missing.map { it.exerciseId.json }),
        ), lines.fold(ReadServed.none) { served, (line, _) -> served.saw(line.served) })
    }

    private fun stats(query: Query.Stats, history: TrainingHistory): AbilityAnswer {
        val stats = history.stats()
        val served = stats.member("weeks").arr().fold(ReadServed.none) { held, week -> held.saw(week.member("startedAt").long()) }
        val movements = stats.member("movements").arr().filter { query.only == null || it["exerciseId"] == query.only.json }
        return AbilityAnswer(CoachDocuments.stated(Json.objectOf("weeks" to stats.member("weeks"), "movements" to Json.Arr(movements))), served)
    }

    // The server's `ORDER BY started_at DESC, id DESC` (INV-1): a same-millisecond tie goes to the higher id, where the UI's `drawnSessions` lists the lower first and the training-reads vectors pin it so.
    private fun newestFirst(log: TrainingLog): List<Session> = log.drawnSessions.sortedWith(compareByDescending<Session> { it.startedAt }.thenByDescending { it.id })

    private fun workout(session: Session, review: Boolean, history: TrainingHistory): Line {
        val sets = CoachDocuments.performed(history.log.sets(session.id))
        val members = buildList {
            add("session" to TrainingHistory.sessionDocument(session))
            add("sets" to Json.Arr(sets.map(TrainingHistory::setDocument)))
            if (review) add("review" to CoachDocuments.stated(history.review(session.id)))
        }
        return Line(members, sets.fold(ReadServed.none.saw(session)) { served, set -> served.saw(set) })
    }

    private fun lastTime(last: LastTime): Line {
        val exercise = "exerciseId" to last.exerciseId.json
        val session = last.session ?: return Line(listOf(exercise), ReadServed.none)
        val sets = CoachDocuments.numbered(last.sets)
        val members = buildList {
            add(exercise)
            add("session" to TrainingHistory.sessionDocument(session))
            session.name?.takeIf { it.isNotEmpty() }?.let { add("routine" to Json.of(it)) }
            add("sets" to Json.Arr(sets.map(TrainingHistory::setDocument)))
        }
        return Line(members, sets.fold(ReadServed.none.saw(session)) { served, set -> served.saw(set) })
    }

    private fun gone(subject: RecordRef) = GymRefusal.of(Refused(RefusalCode.unknownRecord, subject, path = Refused.Path.predicted))

    companion object {
        const val defaultPage = 20
        const val maxPage = 200
    }
}

// `list_routines`: the routines most recently trained first, each with the proposal waiting on it.
class ProgramRead(val routineId: Id<Routine>? = null) : Decider<TrainingHistory, AbilityAnswer, GymRefusal> {
    override val scope = Routine.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = TrainingHistory(read)

    override fun decide(loaded: TrainingHistory, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        fun document(routine: Routine) = CoachDocuments.routine(routine, loaded.lastTrainedAt(routine.id), loaded.pendingProposal(routine.id))
        val listed = routineId?.let { id ->
            listOf(loaded.program.firstOrNull { it.id == id } ?: return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted))))
        } ?: loaded.program
        return Decision.Unchanged(AbilityAnswer(Json.objectOf("routines" to Json.Arr(listed.map(::document)))))
    }
}

// `list_exercises`: the catalogue by pattern, then the name the lifter sees, in the server's order (INV-1): its `ORDER BY pattern, name` runs under the database's `en_US.UTF-8` collation (`Collation`); patterns are lowercase ASCII words, the same order either way. What the collation leaves tied, the id breaks.
class CatalogueRead : Decider<Catalogue, AbilityAnswer, GymRefusal> {
    override val scope = Exercise.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Catalogue(read)

    override fun decide(loaded: Catalogue, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        val exercises = loaded.exercises.sortedWith { a, b ->
            compareBytes(a.pattern, b.pattern).takeIf { it != 0 } ?: Collation.order.compare(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id)
        }
        return Decision.Unchanged(AbilityAnswer(Json.objectOf("exercises" to Json.Arr(exercises.map(TrainingHistory::exerciseDocument)))))
    }
}

// `list_notes`: precedence order, without the id and the instant the model has no use for.
class NotesRead : Decider<NotesRead.Loaded, AbilityAnswer, GymRefusal> {
    data class Loaded(val drawn: List<Note>, val stored: List<Note>)

    override val scope = Note.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded(read.repository(Note).all(ViewMode.drawn), read.repository(Note).all(ViewMode.stored))

    override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        val rows = loaded.drawn.map { note ->
            Json.objectOf("position" to Json.of(Note.position(note.id, loaded.stored) ?: 0), "title" to Json.of(note.title), "body" to Json.of(note.body))
        }
        return Decision.Unchanged(AbilityAnswer(Json.objectOf("notes" to Json.Arr(rows))))
    }
}

// `list_bodyweight`: day ascending between two inclusive days, either open.
class BodyweightRead(val from: String? = null, val to: String? = null) : Decider<Bodyweight, AbilityAnswer, GymRefusal> {
    override val scope = WeighIn.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Bodyweight(read)

    override fun decide(loaded: Bodyweight, ids: IDSource): Decision<AbilityAnswer, GymRefusal> {
        fun day(label: String, text: String?): LocalDay? = text?.let {
            LocalDay.parse(it) ?: throw Violation(WeighInRules.dayRule, Path(label), Violation.Reason.Custom("notADay"))
        }
        val entries = loaded.entries(day("from", from), day("to", to)).map { Json.objectOf("dateLocal" to Json.of(it.day.text), "weightKg" to Json.of(it.kg)) }
        return Decision.Unchanged(AbilityAnswer(Json.objectOf("entries" to Json.Arr(entries))))
    }
}
