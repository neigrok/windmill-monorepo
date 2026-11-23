package works.windmill.gym.domain.coach

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.Contract
import works.windmill.domain.testing.withActionContext
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.ImportedSet
import works.windmill.gym.domain.sync.Note
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.RoutineCreation
import works.windmill.gym.domain.sync.RoutineEntry
import works.windmill.gym.domain.sync.SeedExercises
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.StartSession
import works.windmill.gym.domain.sync.TrainingLog
import works.windmill.gym.domain.sync.TrainingSet
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.gym.domain.sync.decide
import works.windmill.gym.domain.sync.deleteNote
import works.windmill.gym.domain.sync.lastTime
import works.windmill.gym.domain.sync.reader
import works.windmill.gym.domain.sync.row
import works.windmill.gym.domain.sync.setRow
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Constants
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Sha256
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.modelserver.ServerState
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

// The replica executor on the real engine, over a model server shared by every phone: what the ability corpus cannot hold, a call's record on the Coach message in the gesture that commits its writes (Coach §4.3 step 2) and the server's orders beyond the corpus's cases. CorpusTests holds every ability case.
class RunAbilityTests {
    private class Phone(val engine: SteppedEngine, context: ActionContext, val catalog: Catalog) {
        val runner = ActionRunner(engine.replica, SyncSchema.registry, FixedZone(0), context)
        fun run(request: AbilityRequest, on: Id<CoachMessage>, seat: Seat) = runner.run(RunAbility(request, on, seat, catalog, "https://windmill.works"))

        fun open(question: String = "How heavy today?"): OpenTurn.Turn = (runner.run(OpenTurn(question = question)) as Outcome.Committed).result
        fun call(turn: OpenTurn.Turn, name: String, input: String, callId: String = "call-1", seat: Seat = Seat.bound) = run(AbilityRequest(callId, name, Json.parse(input)), turn.coach, seat)
        fun message(id: Id<CoachMessage>): CoachMessage = runner.read(CoachMessage.scope) { it.repository(CoachMessage).find(id, ViewMode.stored)!! }
        fun calls(turn: OpenTurn.Turn): List<AbilityCall> = message(turn.coach).calls
        fun <E : Entity<E>> stored(type: EntityType<E>): List<E> = runner.read(ScopeRef(Gym.scope)) { it.repository(type).all(ViewMode.stored) }

        // The log seeded whole: every closed session imported with its sets, at the instants given.
        fun seed(sessions: List<Session>, sets: List<TrainingSet>) {
            for (session in sessions) {
                val imported = sets.filter { it.sessionId == session.id }.map { ImportedSet(it.id, it.exerciseId, it.weightKg, it.reps, it.completedAt) }
                assertTrue(runner.run(ImportSession(session.id, session.startedAt, session.finishedAt!!, imported)) is Outcome.Committed)
            }
        }
    }

    private fun phones(catalog: Catalog = Catalog(Contract.json("gym/catalog-3.json")), body: (Phone, Phone) -> Unit) = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, 1_800_000_000_000L, rules = GymServerRules()).use { engine ->
            engine.server.restore(ServerState().apply {
                product = Json.objectOf("seeds" to Json.Obj(SeedExercises.all.map { it.id.record.toString() to Json.Obj(it.fields().toList()) }))
            }.json)
            withActionContext { context ->
                val second = engine.device()
                body(Phone(engine, context, catalog), Phone(second, context, catalog))
            }
        }
    }

    private fun answered(outcome: Outcome<AbilityOutcome, GymRefusal>): AbilityOutcome = when (outcome) {
        is Outcome.Committed -> outcome.result
        is Outcome.Unchanged -> outcome.result
        is Outcome.Refused -> throw AssertionError("the message itself refused: ${outcome.refusal}")
    }

    private fun result(outcome: Outcome<AbilityOutcome, GymRefusal>): Json {
        val answer = answered(outcome) as? AbilityOutcome.Result ?: throw AssertionError("answered no result: ${answered(outcome)}")
        assertEquals(Sha256.hex(answer.jcs), answer.sha256)
        return Json.parse(answer.jcs)
    }

    private fun refused(code: AbilityRefusal) = AbilityOutcome.Refused(code)
    // gym Coach G-7: the id the turn mints for its `n`th record, whatever the model named.
    private fun seeded(turn: OpenTurn.Turn, n: Int) = "${turn.coach.record.string}-$n"
    // The input as the call records it: the model's, under the id its turn seeded.
    private fun naming(input: String, id: String) = Json.Obj(Json.parse(input).obj().toList().filter { it.first != "id" } + ("id" to Json.of(id)))
    private val page = """{"before":null,"beforeId":null,"limit":20}"""
    private fun cursor(before: Long, beforeId: String) = """{"before":$before,"beforeId":"$beforeId","limit":20}"""
    private fun workoutRead(id: Any) = """{"sessionId":"$id","review":false}"""
    private fun bytes(json: Json) = json.jcs.encodeToByteArray().size
    private fun ref(type: String, id: String) = RecordRef(type, RecordID(id))
    private fun digits(n: Int) = n.toString().padStart(13, '0')
    private fun workout(n: Int) = Session(Id("ses" + digits(n), Session), Instant(1_700_000_000_000 + n * 7 * 86_400_000L), Instant(1_700_003_600_000 + n * 7 * 86_400_000L), "finish")
    private fun sixtySets(session: Session, base: Int, pad: Int = 16) = (0 until 60).map { n ->
        TrainingSet(Id("set" + digits(base + n).padStart(pad - 3, '0'), TrainingSet), session.id, Id("bench-press", Exercise), 60.0, 5,
            completedAt = Instant(session.startedAt.ms + 60_000L * (n + 1)), setNumber = n + 1)
    }

    @Test fun everyWriteAbilityLandsWithItsRecordUnderTheIdItsTurnSeedsAndReachesTheOtherPhone() = phones { a, b ->
        val turn = a.open()
        val exercise = """{"id":"the-model-names-this","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}"""
        assertEquals(Json.parse("""{"custom":true,"equipment":"cable","id":"${seeded(turn, 1)}","name":"Cable fly","pattern":"isolation","stepKg":2.5}"""),
            result(a.call(turn, "create_exercise", exercise, "call-1")))
        val routine = seeded(turn, 2)
        val created = """{"id":"x","name":"Push","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":62.5}]},{"exerciseId":"${seeded(turn, 1)}"}]}"""
        result(a.call(turn, "create_routine", created, "call-2"))
        val note = """{"id":"x","title":"Tone","body":"Blunt."}"""
        assertEquals(Json.parse("""{"saved":true,"note":{"id":"${seeded(turn, 3)}","position":0,"title":"Tone","body":"Blunt."}}"""), result(a.call(turn, "save_note", note, "call-3")))
        val proposing = """{"id":"x","routineId":"$routine","name":null,"entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":65}]}],"summary":"More load"}"""
        assertEquals("https://windmill.works/#/gym/proposals/${seeded(turn, 4)}", result(a.call(turn, "propose_routine_change", proposing, "call-4")).member("reviewUrl").str())
        val removing = """{"id":"x","routineId":"$routine","summary":"Too much"}"""
        assertEquals("remove", result(a.call(turn, "propose_routine_removal", removing, "call-5")).member("proposal").member("intent").str())
        val session = Id("sesAAAAAAAAAAAA1", Session)
        assertTrue(a.runner.run(StartSession(session, Id(routine, Routine))) is Outcome.Committed)
        val swapping = """{"id":"x","sessionId":"sesAAAAAAAAAAAA1","entries":[{"exerciseId":"bench-press","sets":[{"reps":3,"weightKg":70}]}],"summary":"Heavier"}"""
        assertEquals(2, result(a.call(turn, "propose_workout_change", swapping, "call-6")).member("proposal").member("changeCount").long().toInt())

        fun recorded(n: Int, name: String, input: String, type: String) =
            AbilityCall("call-$n", name, naming(input, seeded(turn, n)), AbilityCall.Outcome.Ok, listOf(ref(type, seeded(turn, n))))
        val expected = listOf(
            recorded(1, "create_exercise", exercise, Exercise.type),
            recorded(2, "create_routine", created, Routine.type),
            recorded(3, "save_note", note, Note.type),
            recorded(4, "propose_routine_change", proposing, Proposal.type),
            recorded(5, "propose_routine_removal", removing, Proposal.type),
            recorded(6, "propose_workout_change", swapping, WorkoutProposal.type),
        )
        assertEquals(expected, a.calls(turn))
        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.completed, "Done.")) is Outcome.Committed)

        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(expected, b.calls(turn))
        assertEquals(expected.flatMap { it.created }.map { Json.objectOf("t" to Json.of(it.type), "id" to it.id.json) },
            b.message(turn.coach).receipt!!.member("results").arr())
        assertEquals("Cable fly", b.stored(Exercise).single { it.id.record.string == seeded(turn, 1) }.name)
        assertEquals(listOf("Push"), b.stored(Routine).map { it.name })
        assertEquals(listOf("Tone"), b.stored(Note).map { it.title })
        assertEquals(listOf(seeded(turn, 4) to "superseded", seeded(turn, 5) to "pending"), b.stored(Proposal).map { it.id.record.string to it.state })
        assertEquals(listOf(seeded(turn, 6) to "pending"), b.stored(WorkoutProposal).map { it.id.record.string to it.state })
    }

    // Signed out, the abilities the anon seat admits land on the replica beside the conversation; a note needs an account.
    @Test fun aSignedOutPhoneRunsTheAbilitiesItsSeatAdmits() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, 1_800_000_000_000L, account = null, rules = GymServerRules()).use { engine ->
            withActionContext { context ->
                val phone = Phone(engine, context, Catalog(Contract.json("gym/catalog-3.json")))
                val turn = phone.open()
                result(phone.call(turn, "create_routine", """{"id":"x","name":"Push","position":0,"entries":[{"exerciseId":"bench-press"}]}""", "call-1", Seat.anon))
                result(phone.call(turn, "propose_routine_change", """{"id":"x","routineId":"${seeded(turn, 1)}","name":null,"entries":[{"exerciseId":"back-squat"}],"summary":null}""", "call-2", Seat.anon))
                assertEquals(refused(AbilityRefusal.seatRequired), answered(phone.call(turn, "save_note", """{"id":"x","title":"Tone","body":"Blunt."}""", "call-3", Seat.anon)))
                assertEquals(listOf("Push"), phone.stored(Routine).map { it.name })
                assertEquals(listOf(seeded(turn, 2)), phone.stored(Proposal).map { it.id.record.string })
            }
        }
    }

    // A movement appears once in a proposal, or as often as the routine gave the plan it, as the log admits.
    @Test fun aWorkoutProposalKeepsAMovementTheRoutineGaveItsPlanTwice() = phones { a, b ->
        val turn = a.open()
        val twice = """[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":60}]},{"exerciseId":"bench-press","sets":[{"reps":3,"weightKg":70}]}]"""
        result(a.call(turn, "create_routine", """{"id":"x","name":"Bench","position":0,"entries":$twice}""", "call-1"))
        assertTrue(a.runner.run(StartSession(Id("sesAAAAAAAAAAAA1", Session), Id(seeded(turn, 1), Routine))) is Outcome.Committed)
        val thrice = """[{"exerciseId":"bench-press"},{"exerciseId":"bench-press"},{"exerciseId":"bench-press"}]"""
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "propose_workout_change", """{"id":"x","sessionId":"sesAAAAAAAAAAAA1","entries":$thrice,"summary":null}""", "call-2")))
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "propose_workout_change", """{"id":"x","sessionId":"sesAAAAAAAAAAAA1","entries":$twice,"summary":null}""", "call-3")))
        val lighter = """[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":55}]},{"exerciseId":"bench-press","sets":[{"reps":3,"weightKg":70}]}]"""
        result(a.call(turn, "propose_workout_change", """{"id":"x","sessionId":"sesAAAAAAAAAAAA1","entries":$lighter,"summary":"Lighter"}""", "call-4"))
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(listOf(seeded(turn, 4)), b.stored(WorkoutProposal).map { it.id.record.string })
        assertEquals(listOf("retargeted", "kept"), b.stored(WorkoutProposal).single().changes.map { it.kind })
    }

    @Test fun aWriteAndItsRecordLandInOneGesture() = phones { a, _ ->
        val turn = a.open()
        val outcome = a.call(turn, "create_exercise", """{"id":"x","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}""") as Outcome.Committed
        assertEquals(listOf(RecordID(seeded(turn, 1)), turn.coach.record), outcome.receipt.ids)
    }

    // gym Coach G-7: two calls of one round, made before either ran, take an ordinal each; a call its rule refused holds its ordinal, so running it again names no record a later call took.
    @Test fun aCallItsRuleRefusedHoldsItsOrdinal() = phones { a, _ ->
        val turn = a.open()
        val both = listOf(RunAbility(AbilityRequest("call-1", "save_note", Json.parse("""{"id":"x","title":" ","body":""}""")), turn.coach, Seat.bound, a.catalog, ""),
            RunAbility(AbilityRequest("call-2", "save_note", Json.parse("""{"id":"x","title":"Shoulder","body":""}""")), turn.coach, Seat.bound, a.catalog, ""))
        assertEquals(listOf(refused(AbilityRefusal.invalidArguments), AbilityOutcome.Result(Json.parse("""{"saved":true,"note":{"id":"${seeded(turn, 2)}","position":0,"title":"Shoulder","body":""}}""").jcs.encodeToByteArray())),
            both.map { answered(a.runner.run(it)) })
        assertTrue(answered(a.call(turn, "save_note", """{"id":"x","title":"Knee","body":""}""", "call-1")) is AbilityOutcome.Result)
        assertEquals(listOf(seeded(turn, 1) to "Knee", seeded(turn, 2) to "Shoulder"), a.stored(Note).map { it.id.record.string!! to it.title }.sortedBy { it.first })
        assertEquals(listOf("call-1" to AbilityCall.Outcome.Ok, "call-2" to AbilityCall.Outcome.Ok), a.calls(turn).map { it.callId to it.outcome })
    }

    // A call the gate refused holds no ordinal, and running it again takes the next one, last; a refused run again leaves the call that answered.
    @Test fun aCallTheGateRefusedHoldsNoOrdinal() = phones { a, _ ->
        val turn = a.open()
        assertEquals(refused(AbilityRefusal.invalidInput), answered(a.call(turn, "save_note", """{"id":"x","title":"Knee"}""", "call-1")))
        result(a.call(turn, "save_note", """{"id":"x","title":"Shoulder","body":""}""", "call-2"))
        result(a.call(turn, "save_note", """{"id":"x","title":"Knee","body":""}""", "call-1"))
        assertEquals(listOf(seeded(turn, 1) to "Shoulder", seeded(turn, 2) to "Knee"), a.stored(Note).map { it.id.record.string!! to it.title }.sortedBy { it.first })
        assertEquals(listOf("call-2", "call-1"), a.calls(turn).map { it.callId })
        assertTrue(a.call(turn, "save_note", """{"id":"x"}""", "call-2") is Outcome.Unchanged)
    }

    // A call runs on a turn another device marked interrupted, which is still its writer's to answer, and on no message its writer ended or another replica wrote (gym Coach on the AI service §4.2).
    @Test fun aCallRunsOnATurnAnotherDeviceMarkedInterrupted() = phones { a, b ->
        val turn = a.open()
        a.engine.sync()
        assertTrue(b.runner.run(EndTurn(turn.coach, MessageState.interrupted)) is Outcome.Committed)
        b.engine.sync()
        assertEquals(MessageState.interrupted, a.message(turn.coach).state)
        result(a.call(turn, "list_notes", "{}", "call-1"))
        val theirs = GymRefusal.Other(Refused(RefusalCode(Gym.Codes.messageFinal), turn.coach.ref, path = Refused.Path.predicted))
        assertEquals(theirs, (b.call(turn, "list_notes", "{}", "call-2") as Outcome.Refused).refusal)
        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.completed, "Done.")) is Outcome.Committed)
        assertEquals(theirs, (a.call(turn, "list_notes", "{}", "call-3") as Outcome.Refused).refusal)
        assertEquals(listOf("call-1"), a.calls(turn).map { it.callId })
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(MessageState.completed, b.message(turn.coach).state)
    }

    // The snapshot a server door left answers its replay as the call first answered, whatever the routine has become since.
    @Test fun aRoutineReplaysItsSnapshotWhateverItHasBecome() {
        val id = Id("tn7Qm2Kx9Lp4Wz8R-1", Routine)
        val snapshot = Json.parse("""{"id":"tn7Qm2Kx9Lp4Wz8R-1","name":"Push","position":0,"revision":1,"entries":[{"exerciseId":"bench-press","position":1}]}""")
        val read = reader(listOf(row(Routine(id, "Pull", 0, listOf(RoutineEntry(Id("pull-up", Exercise))), 2)), row(RoutineCreation, id.record, mapOf("snapshot" to snapshot))))
        assertEquals(Decision.Unchanged(AbilityAnswer(snapshot)), decide(CreateRoutineCall(Routine(id, "Push", 0, listOf(RoutineEntry(Id("bench-press", Exercise))))), read))
    }

    // A call run again under its id keeps one record, in its place. It re-runs, since a record holds no result; the record says what this run served and every id either run created, and a first record that answered stands only when this run was refused.
    @Test fun aCallRerunUnderItsIdKeepsOneRecord() = phones { a, _ ->
        val turn = a.open()
        val exercise = """{"id":"x","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}"""
        val first = a.call(turn, "create_exercise", exercise, "call-1")
        val once = a.calls(turn)
        assertEquals(1, once.size)
        val before = a.engine.engine.snapshot()
        val again = a.call(turn, "create_exercise", exercise, "call-1")
        assertTrue(again is Outcome.Unchanged)
        assertEquals(answered(first), answered(again))
        assertEquals(before, a.engine.engine.snapshot())
        assertEquals(once, a.calls(turn))

        val second = seeded(turn, 2)
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "last_time", """{"exerciseId":"$second"}""", "call-2")))
        result(a.call(turn, "list_notes", "{}", "call-3"))
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "last_time", """{"exerciseId":"$second"}""", "call-2")))
        assertEquals(listOf("call-1", "call-2", "call-3"), a.calls(turn).map { it.callId })
        result(a.call(turn, "create_exercise", """{"id":"x","name":"Rope pull","pattern":"pull","equipment":"cable","stepKg":null}""", "call-4"))
        assertEquals(Json.parse("""{"exerciseId":"$second"}"""), result(a.call(turn, "last_time", """{"exerciseId":"$second"}""", "call-2")))
        val calls = a.calls(turn)
        assertEquals(listOf("call-1", "call-2", "call-3", "call-4"), calls.map { it.callId })
        assertEquals(AbilityCall("call-2", "last_time", Json.parse("""{"exerciseId":"$second"}"""), AbilityCall.Outcome.Ok), calls[1])

        val standing = a.engine.engine.snapshot()
        assertEquals(refused(AbilityRefusal.invalidInput), answered(a.call(turn, "list_notes", """{"extra":1}""", "call-3")))
        assertEquals(standing, a.engine.engine.snapshot())
        assertEquals(calls, a.calls(turn))

        result(a.call(turn, "list_exercises", "{}", "call-3"))
        assertEquals(calls.take(2) + AbilityCall("call-3", "list_exercises", Json.objectOf(), AbilityCall.Outcome.Ok) + calls.drop(3), a.calls(turn))
    }

    // A call is run again only when its answer was never read, so the record says what this run served: the receipt counts what the model read.
    @Test fun aRereadRecordsWhatThisRunServed() = phones { a, _ ->
        val turn = a.open()
        assertEquals(Json.parse("""{"sessions":[]}"""), result(a.call(turn, "list_sessions", page, "same")))
        val session = workout(0)
        a.seed(listOf(session), sixtySets(session, 0).take(1))
        assertEquals(Json.parse("""{"sets":0,"sessions":1,"weeks":1}"""), result(a.call(turn, "list_sessions", page, "same")).member("read"))
        assertEquals(Json.parse("""{"read":{"sets":0,"sessions":1,"weeks":1},"results":[]}"""), AbilityCall.receipt(a.calls(turn)))
        assertEquals(Json.parse("""{"sets":1,"sessions":1,"weeks":1}"""), result(a.call(turn, "get_session", workoutRead(session.id), "same")).member("read"))
        assertEquals(listOf("same"), a.calls(turn).map { it.callId })
        assertEquals(Json.parse("""{"read":{"sets":1,"sessions":1,"weeks":1},"results":[]}"""), AbilityCall.receipt(a.calls(turn)))
    }

    // A write that landed stays on the receipt whatever re-runs under its id.
    @Test fun aRerunKeepsTheIdItsFirstRunCreated() = phones { a, _ ->
        val turn = a.open()
        val exercise = """{"id":"x","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}"""
        result(a.call(turn, "create_exercise", exercise, "same"))
        result(a.call(turn, "create_exercise", exercise, "same"))
        val created = listOf(ref(Exercise.type, seeded(turn, 1)))
        assertEquals(created, a.calls(turn).single().created)
        result(a.call(turn, "list_notes", "{}", "same"))
        assertEquals(created, a.calls(turn).single().created)
        assertEquals(Json.parse("""{"read":{"sets":0,"sessions":0,"weeks":0},"results":[{"t":"exercise","id":"${seeded(turn, 1)}"}]}"""), AbilityCall.receipt(a.calls(turn)))
    }

    // A record both runs created, as when its row is gone from this phone between them, is named once.
    @Test fun aRerunNamesARecordBothRunsCreatedOnce() {
        val created = listOf(ref(Exercise.type, "turnAAAAAAAAAAA1-1"))
        val input = """{"id":"x","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}"""
        val coach = CoachMessage(Id("turnAAAAAAAAAAA1", CoachMessage), Id("thrdAAAAAAAAAAA1", CoachThread), CoachMessage.Role.coach, "rp_00000000000000000000000000000001",
            calls = listOf(AbilityCall("same", "create_exercise", null, AbilityCall.Outcome.Ok, created)), at = Instant(1))
        val run = RunAbility(AbilityRequest("same", "create_exercise", Json.parse(input)), coach.id, Seat.bound, Catalog(Contract.json("gym/catalog-3.json")), "https://windmill.works")
        val written = (decide(run, reader(listOf(row(coach)))) as Decision.Write).plan.operations.single { it.entity.type == CoachMessage.type }.values["calls"]
        assertEquals(Json.Arr(listOf(AbilityCall("same", "create_exercise", naming(input, "turnAAAAAAAAAAA1-1"), AbilityCall.Outcome.Ok, created).json)), written)
    }

    // A re-run the calls have no room for is refused `coach-turn-volume` with its writes dropped, and the record that answered stands, whatever it created.
    @Test fun aRerunWithNoRoomLeavesTheRecordThatAnswered() = phones { a, _ ->
        val turn = a.open()
        result(a.call(turn, "list_notes", "{}", "same"))
        val current = a.message(turn.coach).callsBytes
        val steering = bytes(AbilityCall("fill", "list_sessions", Json.parse(cursor(1, "")), AbilityCall.Outcome.Ok).json)
        result(a.call(turn, "list_sessions", cursor(1, "x".repeat(CoachRules.maxCallsBytes - 20 - current - 1 - steering)), "fill"))
        val calls = a.calls(turn)
        assertEquals(CoachRules.maxCallsBytes - 20, a.message(turn.coach).callsBytes)
        val rerun = a.call(turn, "create_exercise", """{"id":"x","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}""", "same")
        assertEquals(Outcome.Unchanged(refused(AbilityRefusal.volume)), rerun)
        assertEquals(calls, a.calls(turn))
        assertEquals(emptyList<Exercise>(), a.stored(Exercise))
    }

    @Test fun aRerunOfARefusedCallLandsItsWritesWithItsRecord() = phones { a, _ ->
        val turn = a.open()
        val note = """{"id":"x","title":"Tone","body":"Blunt."}"""
        assertEquals(refused(AbilityRefusal.seatRequired), answered(a.call(turn, "save_note", note, seat = Seat.anon)))
        assertEquals(emptyList<Note>(), a.stored(Note))
        assertTrue(a.call(turn, "save_note", note) is Outcome.Committed)
        assertEquals(listOf(AbilityCall("call-1", "save_note", naming(note, seeded(turn, 1)), AbilityCall.Outcome.Ok, listOf(ref(Note.type, seeded(turn, 1))))), a.calls(turn))
        assertEquals(listOf("Tone"), a.stored(Note).map { it.title })
    }

    @Test fun aRefusedCallRecordsItsRefusalAlone() = phones { a, _ ->
        val turn = a.open()
        val gone = a.call(turn, "last_time", """{"exerciseId":"no-such-movement"}""", "call-1")
        assertEquals(refused(AbilityRefusal.refused), answered(gone))
        assertEquals(listOf(turn.coach.record), (gone as Outcome.Committed).receipt.ids)
        assertEquals(refused(AbilityRefusal.invalidInput), answered(a.call(turn, "get_sessions", """{"sessionIds":["a"]}""", "call-2")))
        assertEquals(refused(AbilityRefusal.notOffered), answered(a.call(turn, "log_set", "{}", "call-3")))
        assertEquals(refused(AbilityRefusal.notOffered), answered(a.call(turn, "share_session", """{"sessionId":"sesAAAAAAAAAAAA1"}""", "call-4")))
        assertEquals(refused(AbilityRefusal.notOffered), answered(a.call(turn, "no_such_ability", "{}", "call-5")))
        assertEquals(refused(AbilityRefusal.notOffered), answered(a.call(turn, "get_record", """{"exerciseId":"bench-press"}""", "call-6")))
        assertEquals(refused(AbilityRefusal.seatRequired), answered(a.call(turn, "save_note", """{"id":"x","title":"Tone","body":"Blunt."}""", "call-7", Seat.anon)))
        assertEquals(emptyList<Note>(), a.stored(Note))
        fun call(callId: String, name: String, input: String?, code: AbilityRefusal) = AbilityCall(callId, name, input?.let(Json::parse), AbilityCall.Outcome.Refused(code))
        val expected = listOf(call("call-1", "last_time", """{"exerciseId":"no-such-movement"}""", AbilityRefusal.refused),
            call("call-2", "get_sessions", null, AbilityRefusal.invalidInput), call("call-3", "log_set", null, AbilityRefusal.notOffered),
            call("call-4", "share_session", null, AbilityRefusal.notOffered), call("call-5", "no_such_ability", null, AbilityRefusal.notOffered),
            call("call-6", "get_record", null, AbilityRefusal.notOffered), call("call-7", "save_note", null, AbilityRefusal.seatRequired))
        assertEquals(expected, a.calls(turn))
        assertEquals(Json.parse("""{"read":{"sets":0,"sessions":0,"weeks":0},"results":[]}"""), AbilityCall.receipt(a.calls(turn)))
    }

    @Test fun aCallOnAMessageNotRunningIsRefusedAndRecordsNothing() = phones { a, b ->
        val turn = a.open()
        val absent = Id("turnAAAAAAAAAAA1", CoachMessage)
        fun refusal(on: Id<CoachMessage>, phone: Phone = a) = (phone.run(AbilityRequest("call-1", "list_notes", Json.objectOf()), on, Seat.bound) as Outcome.Refused).refusal
        fun refusalOfANote(on: Id<CoachMessage>) =
            (a.run(AbilityRequest("call-2", "save_note", Json.parse("""{"id":"tn7Qm2Kx9Lp4Wz8R-4","title":"Tone","body":"Blunt."}""")), on, Seat.bound) as Outcome.Refused).refusal
        val before = a.engine.engine.snapshot()
        assertEquals(GymRefusal.Gone(absent.ref, Refused.Path.predicted), refusal(absent))
        assertEquals(GymRefusal.Gone(turn.lifter.ref, Refused.Path.predicted), refusal(turn.lifter))
        assertEquals(GymRefusal.Gone(absent.ref, Refused.Path.predicted), refusalOfANote(absent))
        assertEquals(before, a.engine.engine.snapshot())

        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
        val ended = a.engine.engine.snapshot()
        val finished = GymRefusal.Other(Refused(RefusalCode(Gym.Codes.messageFinal), turn.coach.ref, path = Refused.Path.predicted))
        assertEquals(finished, refusal(turn.coach))
        assertEquals(finished, refusalOfANote(turn.coach))
        assertEquals(ended, a.engine.engine.snapshot())
        assertEquals(emptyList<AbilityCall>(), a.calls(turn))
        assertEquals(emptyList<Note>(), a.stored(Note))

        a.engine.sync()
        assertEquals(finished, refusal(turn.coach, b))
    }

    // Coach §4.3 step 2: a result past TOOL_RESULT_BYTES is refused before anything commits: the routine is not created, its record carries the refusal alone, and three workouts of sixty sets the phone cannot send count nothing on the receipt, where one it can send counts every row.
    @Test fun aResultPastItsBoundIsRefusedBeforeItsWriteCommits() = phones { a, _ ->
        val sessions = (0 until 3).map(::workout)
        a.seed(sessions, sessions.flatMapIndexed { n, session -> sixtySets(session, n * 100) })
        val turn = a.open()
        val ramp = (0 until 20).joinToString(",") { """{"reps":${1 + it},"weightKg":${it * 2.5}}""" }
        val entries = (0 until 50).joinToString(",") { """{"exerciseId":"bench-press","sets":[$ramp],"restSeconds":${15 + it}}""" }
        val input = """{"id":"x","name":"Ramp","position":0,"entries":[$entries]}"""
        val routine = a.call(turn, "create_routine", input)
        assertEquals(refused(AbilityRefusal.resultTooLarge), answered(routine))
        assertEquals(listOf(turn.coach.record), (routine as Outcome.Committed).receipt.ids)
        assertEquals(emptyList<Routine>(), a.stored(Routine))
        assertEquals(listOf(AbilityCall("call-1", "create_routine", naming(input, seeded(turn, 1)), AbilityCall.Outcome.Refused(AbilityRefusal.resultTooLarge))), a.calls(turn))

        val all = sessions.joinToString(",") { "\"${it.id}\"" }
        assertEquals(refused(AbilityRefusal.resultTooLarge), answered(a.call(turn, "get_sessions", """{"sessionIds":[$all],"review":false}""", "call-2")))
        assertEquals(RecordedRead.Ids(ReadServed.none), a.calls(turn).last().read)
        assertEquals(Json.parse("""{"read":{"sets":0,"sessions":0,"weeks":0},"results":[]}"""), AbilityCall.receipt(a.calls(turn)))

        val one = result(a.call(turn, "get_session", workoutRead(sessions[0].id), "call-3"))
        assertTrue(bytes(one) <= CoachRules.maxResultBytes)
        assertEquals(Json.parse("""{"sets":60,"sessions":1,"weeks":1}"""), one.member("read"))
        assertEquals(Json.parse("""{"read":{"sets":60,"sessions":1,"weeks":1},"results":[]}"""), AbilityCall.receipt(a.calls(turn)))
    }

    // The bound is on the result's UTF-8 bytes: a workout whose notes bring it to the byte is answered, and one byte more is refused however few characters it holds.
    @Test fun theResultBoundMeasuresBytesNotCharacters() = phones { a, _ ->
        fun logged(n: Int, noteBytes: Int): Session {
            val session = workout(n)
            val sets = (0 until 5).map { at ->
                val bytes = noteBytes / 5 + if (at < noteBytes % 5) 1 else 0
                ImportedSet(Id("set" + digits(n * 10 + at), TrainingSet), Id("bench-press", Exercise), 60.0, 5, Instant(session.startedAt.ms + 60_000L * (at + 1)),
                    note = "é".repeat(bytes / 2) + "x".repeat(bytes % 2))
            }
            assertTrue(a.runner.run(ImportSession(session.id, session.startedAt, session.finishedAt!!, sets)) is Outcome.Committed)
            return session
        }
        val empty = logged(0, 0)
        val turn = a.open()
        val baseline = bytes(result(a.call(turn, "get_session", workoutRead(empty.id), "call-1")))
        val atTheBound = result(a.call(turn, "get_session", workoutRead(logged(1, CoachRules.maxResultBytes - baseline).id), "call-2"))
        assertEquals(CoachRules.maxResultBytes, bytes(atTheBound))
        assertTrue(atTheBound.jcs.length < CoachRules.maxResultBytes)
        assertEquals(refused(AbilityRefusal.resultTooLarge), answered(a.call(turn, "get_session", workoutRead(logged(2, CoachRules.maxResultBytes - baseline + 1).id), "call-3")))
        assertEquals(RecordedRead.Ids(ReadServed.none), a.calls(turn).last().read)
    }

    // Coach §9.2 on the calls bound: reads the calls have no room for lose their input, then hold counts alone, never a refusal the server would not give; the receipt sums the counts with the identities under `truncated`.
    @Test fun readsPastTheCallsBoundDegradeToCountsAndAreNeverRefused() = phones { a, _ ->
        val sessions = (0 until 10).map(::workout)
        a.seed(sessions, sessions.flatMapIndexed { n, session -> sixtySets(session, n * 100, pad = 64) })
        val turn = a.open()
        for (session in sessions) {
            val answer = result(a.call(turn, "get_session", workoutRead(session.id), "read-${session.id}"))
            assertEquals(Json.parse("""{"sets":60,"sessions":1,"weeks":1}"""), answer.member("read"))
        }
        val message = a.message(turn.coach)
        val calls = message.calls
        assertTrue(message.callsBytes <= CoachRules.maxCallsBytes)
        assertEquals(sessions.size, calls.size)
        assertTrue(calls.all { it.outcome == AbilityCall.Outcome.Ok })
        assertEquals(RecordedRead.Counts(ReadTally(60, 1, 1)), calls.last().read)
        assertNull(calls.last().input)
        assertNotNull(calls.first().input)
        assertTrue(calls.first().read is RecordedRead.Ids)
        val counted = calls.count { it.read is RecordedRead.Counts }
        assertTrue("some reads hold counts, some identities: $counted", counted in 1 until calls.size)
        assertEquals(Json.parse("""{"read":{"sets":600,"sessions":10,"weeks":10},"results":[],"truncated":true}"""), AbilityCall.receipt(calls))
    }

    @Test fun aReadOfRowsAnEarlierCallHoldsRecordsNothingNew() = phones { a, _ ->
        val session = workout(0)
        a.seed(listOf(session), emptyList())
        val turn = a.open()
        result(a.call(turn, "list_exercises", "{}", "call-1"))
        result(a.call(turn, "save_note", """{"id":"x","title":"Tone","body":"Blunt."}""", "call-2"))
        result(a.call(turn, "list_sessions", page, "call-3"))
        result(a.call(turn, "list_sessions", page, "call-4"))
        val once = ReadServed.none.saw(session)
        assertEquals(listOf(RecordedRead.Ids(ReadServed.none), RecordedRead.Ids(ReadServed.none), RecordedRead.Ids(once), RecordedRead.Ids(ReadServed.none)), a.calls(turn).map { it.read })
        assertEquals(Json.parse("""{"read":{"sets":0,"sessions":1,"weeks":1},"results":[{"t":"note","id":"${seeded(turn, 1)}"}]}"""), AbilityCall.receipt(a.calls(turn)))
    }

    @Test fun aCallPastTheCallsBoundLosesItsInput() = phones { a, _ ->
        val turn = a.open()
        val long = cursor(1, "x".repeat(20_000))
        result(a.call(turn, "list_sessions", long, "call-1"))
        result(a.call(turn, "list_sessions", long, "call-2"))
        assertEquals(listOf(Json.parse(long), null), a.calls(turn).map { it.input })
        assertTrue(a.message(turn.coach).callsBytes <= CoachRules.maxCallsBytes)
    }

    // The calls are steered to the byte where a write's record fits only without the id it would create: that call is refused `coach-turn-volume`, recorded so, and writes nothing; the next cannot be recorded at all and is refused as the message's own bound, writing nothing.
    @Test fun aTurnPastItsCallsBoundRefusesVolumeThenRecordsNothing() = phones { a, _ ->
        val turn = a.open()
        result(a.call(turn, "list_sessions", page, "fill-1"))
        val current = a.message(turn.coach).callsBytes
        val created = listOf(ref(Exercise.type, seeded(turn, 1)))
        val trimmed = bytes(AbilityCall("fill-3", "create_exercise", null, AbilityCall.Outcome.Ok, created).json)
        val bare = bytes(AbilityCall("fill-3", "create_exercise", null, AbilityCall.Outcome.Refused(AbilityRefusal.volume)).json)
        assertTrue(bare < trimmed)
        val target = CoachRules.maxCallsBytes - 1 - bare - (trimmed - bare) / 2
        val steering = bytes(AbilityCall("fill-2", "list_sessions", Json.parse(cursor(1, "")), AbilityCall.Outcome.Ok).json)
        result(a.call(turn, "list_sessions", cursor(1, "x".repeat(target - current - 1 - steering)), "fill-2"))
        assertEquals(target, a.message(turn.coach).callsBytes)

        val volume = a.call(turn, "create_exercise", """{"id":"x","name":"Cable fly","pattern":"isolation","equipment":"cable","stepKg":null}""", "fill-3")
        assertEquals(refused(AbilityRefusal.volume), answered(volume))
        assertEquals(listOf(turn.coach.record), (volume as Outcome.Committed).receipt.ids)
        assertEquals(emptyList<Exercise>(), a.stored(Exercise))
        assertEquals(AbilityCall("fill-3", "create_exercise", null, AbilityCall.Outcome.Refused(AbilityRefusal.volume)), a.calls(turn).last())
        assertTrue(a.message(turn.coach).callsBytes <= CoachRules.maxCallsBytes)

        val full = a.engine.engine.snapshot()
        val unrecorded = a.call(turn, "list_sessions", page, "fill-4") as Outcome.Refused
        assertEquals(GymRefusal.Other(Refused(RefusalCode.tooLarge, turn.coach.ref, path = Refused.Path.predicted)), unrecorded.refusal)
        assertEquals(listOf("fill-1", "fill-2", "fill-3"), a.calls(turn).map { it.callId })
        assertEquals(full, a.engine.engine.snapshot())
    }

    // A note past the server's bounds is malformed input, `invalid-arguments`, as its tool answers, and holds its ordinal; a note out of the schema's shape is the gate's `invalid-input`, and holds none; one within both saves.
    @Test fun aNotePastTheServersBoundsIsMalformedInput() = phones { a, _ ->
        val turn = a.open()
        fun note(n: Int, title: String, body: String) = answered(a.call(turn, "save_note", """{"id":"x","title":"$title","body":"$body"}""", "note-$n"))
        assertEquals(refused(AbilityRefusal.invalidArguments), note(1, "Bound", "é".repeat(250) + "x"))
        assertEquals(refused(AbilityRefusal.invalidArguments), note(2, "q̇".repeat(60), ""))
        assertEquals(refused(AbilityRefusal.invalidArguments), note(3, " ", "Blunt."))
        assertEquals(refused(AbilityRefusal.invalidInput), answered(a.call(turn, "save_note", """{"id":"x","title":"No body"}""", "note-4")))
        assertEquals(emptyList<Note>(), a.stored(Note))
        val saved = Json.objectOf("saved" to Json.of(true), "note" to Json.objectOf("id" to Json.of(seeded(turn, 4)), "position" to Json.of(0),
            "title" to Json.of("Bound"), "body" to Json.of("é".repeat(250))))
        assertEquals(AbilityOutcome.Result(saved.jcs.encodeToByteArray()), note(5, "Bound", "é".repeat(250)))
    }

    // The gate draws three codes for a call its input sinks: the shape the schema states, a bound it does not (`invalid-arguments`, whichever way the input fails to read), and a rule. A call the bounds refuse records its input under the id its turn seeded.
    @Test fun theGateTurnsEveryInputItCannotReadIntoInvalidArguments() {
        val document = Contract.json("gym/catalog-3.json")
        val open = Catalog(Json.objectOf("catalog" to document.member("catalog"), "abilities" to Json.Arr(document.member("abilities").arr().map { entry ->
            if (entry.member("name").str() !in listOf("get_sessions", "get_last_times", "create_exercise", "last_time", "share_log", "propose_routine_change")) entry
            else Json.Obj(entry.obj().toList().filter { it.first != "input" } + ("input" to Json.objectOf()))
        })))
        phones(open) { a, _ ->
            val turn = a.open()
            val malformed = listOf(
                "get_sessions" to "{}",
                "get_sessions" to """{"sessionIds":"x"}""",
                "get_sessions" to """{"sessionIds":[1]}""",
                "get_sessions" to """{"sessionIds":["a","a"],"review":false}""",
                "get_last_times" to """{"exerciseIds":[null]}""",
                "last_time" to """{"exerciseId":1}""",
                "create_exercise" to """{"name":"Fly","pattern":"core"}""",
                "create_exercise" to """{"name":"Fly","pattern":"core","equipment":"cable","stepKg":"x"}""",
                "create_exercise" to """{"name":"${"F".repeat(241)}","pattern":"core","equipment":"cable","stepKg":null}""",
                "propose_routine_change" to """{"routineId":"tn7Qm2Kx9Lp4Wz8R-1","entries":{}}""",
            )
            var minted = 0
            malformed.forEachIndexed { n, (name, input) ->
                assertEquals("$name $input", refused(AbilityRefusal.invalidArguments), answered(a.call(turn, name, input, "call-$n")))
                val recorded = if (name in AbilityRequest.creates) naming(input, seeded(turn, ++minted)) else Json.parse(input)
                assertEquals("$name $input", recorded, a.calls(turn).last().input)
            }
            assertEquals(refused(AbilityRefusal.notOffered), answered(a.call(turn, "share_log", "{}", "call-shares")))
            assertEquals(emptyList<Exercise>(), a.stored(Exercise))
        }
    }

    @Test fun theGateAnswersTheShapeTheCursorAndTheRule() = phones { a, _ ->
        val turn = a.open()
        assertEquals(refused(AbilityRefusal.invalidArguments), answered(a.call(turn, "list_sessions", """{"before":null,"beforeId":"sesAAAAAAAAAAAA1","limit":20}""", "call-1")))
        assertEquals(refused(AbilityRefusal.invalidArguments), answered(a.call(turn, "list_sessions", """{"before":null,"beforeId":null,"limit":0}""", "call-2")))
        assertEquals(refused(AbilityRefusal.invalidArguments), answered(a.call(turn, "list_sessions", """{"before":null,"beforeId":null,"limit":201}""", "call-3")))
        assertEquals(refused(AbilityRefusal.invalidInput), answered(a.call(turn, "list_sessions", """{"limit":20}""", "call-4")))
        assertEquals(refused(AbilityRefusal.invalidInput), answered(a.call(turn, "create_exercise", """{"id":1,"name":"Fly","pattern":"core","equipment":"cable","stepKg":null}""", "call-5")))
        assertEquals(emptyList<Exercise>(), a.stored(Exercise))
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "list_bodyweight", """{"from":"not a day","to":null}""", "call-6")))
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "list_bodyweight", """{"from":null,"to":"2026-02-30"}""", "call-7")))
    }

    // An input nested past the bound is `invalid-arguments` before anything reads it, so no record holds it: a store the engine could not read back would stop the app opening. No catalog/3 schema admits such an input, so a catalog that states none stands in for one that might.
    @Test fun anInputNestedPastItsBoundIsMalformedAndNoRecordHoldsIt() {
        val document = Contract.json("gym/catalog-3.json")
        val open = Catalog(Json.objectOf("catalog" to document.member("catalog"), "abilities" to Json.Arr(document.member("abilities").arr().map { entry ->
            if (entry.member("name").str() != "create_routine") entry else Json.Obj(entry.obj().toList().filter { it.first != "input" } + ("input" to Json.objectOf()))
        })))
        phones(open) { a, b ->
            val turn = a.open()
            fun nested(depth: Int) = "{\"a\":".repeat(depth) + "1" + "}".repeat(depth)
            fun routine(n: Int, extra: Int) = """{"id":"x","name":"Open $n","position":0,"entries":[{"exerciseId":"plank"}],"extra":${nested(extra)}}"""
            val atTheBound = routine(1, CoachRules.maxInputDepth - 1)
            assertEquals(CoachRules.maxInputDepth, Json.parse(atTheBound).depth)
            result(a.call(turn, "create_routine", atTheBound, "at-the-bound"))
            assertEquals(naming(atTheBound, seeded(turn, 1)), a.calls(turn).single().input)
            for ((n, depth) in listOf(CoachRules.maxInputDepth, 100, 124, 126).withIndex()) {
                val callId = "past-$n"
                assertEquals(refused(AbilityRefusal.invalidArguments), answered(a.call(turn, "create_routine", routine(n + 2, depth), callId)))
                assertEquals(AbilityCall(callId, "create_routine", null, AbilityCall.Outcome.Refused(AbilityRefusal.invalidArguments)), a.calls(turn).last())
            }
            val arrays = "[".repeat(CoachRules.maxInputDepth) + "]".repeat(CoachRules.maxInputDepth)
            val ofArrays = """{"id":"x","name":"Of arrays","position":0,"entries":[{"exerciseId":"plank"}],"extra":{"a":$arrays}}"""
            assertEquals(refused(AbilityRefusal.invalidArguments), answered(a.call(turn, "create_routine", ofArrays, "past-of-arrays")))
            assertEquals(listOf("Open 1"), a.stored(Routine).map { it.name })
            a.engine.sync()
            assertEquals(emptyList<Any>(), a.engine.notices("gym"))
            assertEquals(a.calls(turn), b.calls(turn))
            assertEquals(a.engine.engine.snapshot(), Json.parse(a.engine.engine.snapshot().jcs))
        }
    }

    // A new routine meets its movements' floors as the log will, so it is refused here rather than taken back at the sync.
    @Test fun aNewRoutineMeetsItsMovementsFloorsOnThePhone() = phones { a, b ->
        val turn = a.open()
        val below = """{"id":"x","name":"Below","position":0,"entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":-5}]}]}"""
        assertEquals(refused(AbilityRefusal.loadFloor), answered(a.call(turn, "create_routine", below, "call-1")))
        assertEquals(emptyList<Routine>(), a.stored(Routine))
        assertEquals(AbilityCall("call-1", "create_routine", naming(below, seeded(turn, 1)), AbilityCall.Outcome.Refused(AbilityRefusal.loadFloor)), a.calls(turn).single())
        result(a.call(turn, "create_routine", """{"id":"x","name":"Assisted","position":0,"entries":[{"exerciseId":"plank","sets":[{"reps":5,"weightKg":-5}]}]}""", "call-2"))
        result(a.call(turn, "create_routine", """{"id":"x","name":"At the floor","position":1,"entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":0}]}]}""", "call-3"))
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(listOf("Assisted", "At the floor"), b.stored(Routine).map { it.name })
        assertEquals(listOf("call-1", "call-2", "call-3"), b.calls(turn).map { it.callId })
    }

    // Another phone's running message is that phone's to write: its calls would replace the ones its own phone records, so this phone refuses and records nothing.
    @Test fun anotherPhoneCannotWriteOnThisPhonesRunningMessage() = phones { a, b ->
        val turn = a.open()
        a.engine.sync()
        val before = b.engine.engine.snapshot()
        val theirs = GymRefusal.Other(Refused(RefusalCode(Gym.Codes.messageFinal), turn.coach.ref, path = Refused.Path.predicted))
        assertEquals(theirs, (b.call(turn, "list_notes", "{}", "b-1") as Outcome.Refused).refusal)
        assertEquals(theirs, (b.call(turn, "save_note", """{"id":"x","title":"Tone","body":"Blunt."}""", "b-2") as Outcome.Refused).refusal)
        assertEquals(before, b.engine.engine.snapshot())
        result(a.call(turn, "list_notes", "{}", "a-1"))
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(listOf("a-1"), b.calls(turn).map { it.callId })
        assertEquals(emptyList<Note>(), a.stored(Note))
    }

    // A call's record holds no U+0000, and the engine's bound on `calls` is no refusal of the call: the record goes without its input, and the turn goes on.
    @Test fun aCallHoldingANulRecordsWithoutItsInputAndTheTurnGoesOn() = phones { a, _ ->
        val turn = a.open()
        assertEquals(Json.parse("""{"sessions":[]}"""), result(a.call(turn, "list_sessions", cursor(1, "a\\u0000b"), "call-1")))
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "last_time", """{"exerciseId":"a\u0000b"}""", "call-2")))
        assertEquals(refused(AbilityRefusal.invalidArguments), answered(a.call(turn, "save_note", """{"id":"x","title":"a\u0000b","body":""}""", "call-3")))
        assertEquals(refused(AbilityRefusal.refused), answered(a.call(turn, "create_routine", """{"id":"x","name":"a\u0000b","position":0,"entries":[{"exerciseId":"bench-press"}]}""", "call-4")))
        assertEquals(listOf(AbilityCall.Outcome.Ok, AbilityCall.Outcome.Refused(AbilityRefusal.refused), AbilityCall.Outcome.Refused(AbilityRefusal.invalidArguments), AbilityCall.Outcome.Refused(AbilityRefusal.refused)), a.calls(turn).map { it.outcome })
        assertEquals(listOf(null, null, null, null), a.calls(turn).map { it.input })
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
    }

    // The server's `ORDER BY started_at DESC, id DESC` decides a same-millisecond tie by the higher id in the Coach reads alone; the UI's last time keeps the lower, as the training-reads vectors pin it.
    @Test fun aSameMillisecondTieGoesToTheHigherIdAsTheServerOrders() = phones { a, _ ->
        val at = Instant(1_799_000_000_000)
        val sessions = listOf("sesTIE0000000001", "sesTIE0000000002").map { Session(Id(it, Session), at, Instant(at.ms + 3_600_000), "finish") }
        val sets = listOf("setTIE0000000001", "setTIE0000000002").mapIndexed { n, id ->
            TrainingSet(Id(id, TrainingSet), sessions[n].id, Id("bench-press", Exercise), 60.0, 5, completedAt = Instant(at.ms + 60_000), setNumber = 1)
        }
        a.seed(sessions, sets)
        val turn = a.open()
        val last = result(a.call(turn, "last_time", """{"exerciseId":"bench-press"}""", "call-1"))
        assertEquals("sesTIE0000000002", last.member("session").member("id").str())
        assertEquals(listOf("setTIE0000000002"), last.member("sets").arr().map { it.member("id").str() })
        val lasts = result(a.call(turn, "get_last_times", """{"exerciseIds":["bench-press"]}""", "call-2"))
        assertEquals(listOf("sesTIE0000000002"), lasts.member("exercises").arr().map { it.member("session").member("id").str() })
        val listed = result(a.call(turn, "list_sessions", page, "call-3"))
        assertEquals(listOf("sesTIE0000000002", "sesTIE0000000001"), listed.member("sessions").arr().map { it.member("id").str() })
        val second = result(a.call(turn, "list_sessions", cursor(at.ms, "sesTIE0000000002"), "call-4"))
        assertEquals(listOf("sesTIE0000000001"), second.member("sessions").arr().map { it.member("id").str() })
        assertEquals("sesTIE0000000001", a.runner.read(Session.scope) { TrainingLog(it).lastTime(Id("bench-press", Exercise)).session?.id?.record?.string })
    }

    // `last_time` names the day of the program the workout ran under; `get_last_times` says only whether the movement was trained.
    @Test fun theLastTimesSayWhatEachListHolds() = phones { a, _ ->
        val turn = a.open()
        result(a.call(turn, "create_routine", """{"id":"x","name":"Push","position":0,"entries":[{"exerciseId":"bench-press"}]}""", "call-1"))
        val session = workout(0)
        val set = ImportedSet(Id("setAAAAAAAAAAAA1", TrainingSet), Id("bench-press", Exercise), 60.0, 5, Instant(session.startedAt.ms + 60_000))
        assertTrue(a.runner.run(ImportSession(session.id, session.startedAt, session.finishedAt!!, listOf(set), Id(seeded(turn, 1), Routine))) is Outcome.Committed)
        assertEquals("Push", result(a.call(turn, "last_time", """{"exerciseId":"bench-press"}""", "call-2")).member("routine").str())
        val lasts = result(a.call(turn, "get_last_times", """{"exerciseIds":["bench-press","back-squat","no-such-movement"]}""", "call-3"))
        assertEquals(listOf("bench-press" to true, "back-squat" to false), lasts.member("exercises").arr().map { it.member("exerciseId").str() to it.member("trained").bool() })
        assertNull(lasts.member("exercises").arr()[0]["routine"])
        assertEquals(Json.parse("""["no-such-movement"]"""), lasts.member("missingExerciseIds"))
    }

    // A workout's sets read as performed, then by their number, then by id; a movement's last sets by their number, then by id.
    @Test fun setsReadInTheOrderEachListHolds() {
        val session = Session(Id("sesAAAAAAAAAAAA1", Session), Instant(1_000), Instant(90_000), "finish")
        fun set(id: String, at: Long, number: Int) = TrainingSet(Id(id, TrainingSet), session.id, Id("bench-press", Exercise), 60.0, 5, completedAt = Instant(at), setNumber = number)
        val sets = listOf(set("setAAAAAAAAAAAA3", 3_000, 1), set("setAAAAAAAAAAAA1", 2_000, 3), set("setAAAAAAAAAAAA2", 2_000, 2), set("setAAAAAAAAAAAA0", 2_000, 2))
        val read = reader(listOf(row(session)) + sets.map { setRow(it) }, moment = Moment(Instant(100_000), FixedZone(0)))
        fun ids(decision: Decision<AbilityAnswer, GymRefusal>) = (decision as Decision.Unchanged).result.payload.member("sets").arr().map { it.member("id").str() }
        assertEquals(listOf("setAAAAAAAAAAAA0", "setAAAAAAAAAAAA2", "setAAAAAAAAAAAA1", "setAAAAAAAAAAAA3"), ids(decide(LogRead(LogRead.Query.Workout(session.id, false)), read)))
        assertEquals(listOf("setAAAAAAAAAAAA3", "setAAAAAAAAAAAA0", "setAAAAAAAAAAAA2", "setAAAAAAAAAAAA1"), ids(decide(LogRead(LogRead.Query.LastTimeOf(Id("bench-press", Exercise))), read)))
    }

    // A note's position counts the stored notes, one inside its delete window included, so the delete moves nothing until it lands.
    @Test fun aNotesPositionCountsANoteInsideItsDeleteWindow() = phones { a, _ ->
        val turn = a.open()
        result(a.call(turn, "save_note", """{"id":"x","title":"First","body":""}""", "call-1"))
        result(a.call(turn, "save_note", """{"id":"x","title":"Second","body":""}""", "call-2"))
        assertTrue(a.runner.run(deleteNote(Id(seeded(turn, 1), Note))) is Outcome.Committed)
        assertEquals(Json.parse("""{"notes":[{"position":1,"title":"Second","body":""}]}"""), result(a.call(turn, "list_notes", "{}", "call-3")))
        a.engine.advance(Constants.HOLD_MS)
        assertEquals(Json.parse("""{"notes":[{"position":0,"title":"Second","body":""}]}"""), result(a.call(turn, "list_notes", "{}", "call-4")))
    }

    @Test fun aPageReadsTwentyWorkoutsUnlessItAsksAndTwoHundredAtMost() = phones { a, _ ->
        a.seed((0 until 25).map(::workout), emptyList())
        val turn = a.open()
        fun listed(input: String, callId: String) = result(a.call(turn, "list_sessions", input, callId)).member("sessions").arr().map { it.member("id").str() }
        assertEquals((24 downTo 5).map { "ses" + digits(it) }, listed(page, "call-1"))
        assertEquals((24 downTo 22).map { "ses" + digits(it) }, listed("""{"before":null,"beforeId":null,"limit":3}""", "call-2"))
        assertEquals((24 downTo 0).map { "ses" + digits(it) }, listed("""{"before":null,"beforeId":null,"limit":200}""", "call-3"))
    }

    // `list_exercises` lists names as the server's en_US.UTF-8 collation does: letters without case or accents first, then accents, then lowercase before uppercase; and a name the call gives decomposed is stored composed (§3.3).
    @Test fun theCatalogueListsNamesAsTheServersCollationOrders() = phones { a, _ ->
        val turn = a.open()
        val names = listOf("Zed row", "apple curl", "éclair fly", "Étude press", "Bench", "bench press", "bench", "BENCH", "bénch")
        names.forEachIndexed { n, name ->
            val created = result(a.call(turn, "create_exercise", """{"id":"x","name":"$name","pattern":"carry","equipment":"cable","stepKg":null}""", "create-$n"))
            assertEquals(if (name == "éclair fly") "éclair fly" else name, created.member("name").str())
        }
        val listed = result(a.call(turn, "list_exercises", "{}", "list"))
        val custom = listed.member("exercises").arr().filter { it["custom"] == Json.of(true) }.map { it.member("name").str() }
        assertEquals(listOf("apple curl", "bench", "Bench", "BENCH", "bénch", "bench press", "éclair fly", "Étude press", "Zed row"), custom)
    }

    // gym Coach on the AI service §4.3: a share the Share door made is recorded on the Coach message as any call is, what it answered or its refusal, and creates no record here; a message its writer ended records none.
    @Test fun aShareTheDoorMadeIsRecordedAsAnyCall() = phones { a, _ ->
        val turn = a.open()
        val made = AbilityOutcome.Result("""{"expiresAt":1,"token":"tok","url":"u"}""".encodeToByteArray())
        val shared = AbilityRequest("call-1", "share_session", Json.parse("""{"sessionId":"sesAAAAAAAAAAAA1"}"""))
        assertEquals(made, answered(a.runner.run(RecordShareCall(shared, turn.coach, made))))
        val revoked = AbilityRequest("call-2", "revoke_share", Json.parse("""{"sessionId":"sesAAAAAAAAAAAA2"}"""))
        assertEquals(refused(AbilityRefusal.refused), answered(a.runner.run(RecordShareCall(revoked, turn.coach, refused(AbilityRefusal.refused)))))
        assertEquals(listOf(AbilityCall("call-1", "share_session", shared.input, AbilityCall.Outcome.Ok),
            AbilityCall("call-2", "revoke_share", revoked.input, AbilityCall.Outcome.Refused(AbilityRefusal.refused))), a.calls(turn))
        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.completed, "Shared.")) is Outcome.Committed)
        val ended = a.runner.run(RecordShareCall(shared.copy(callId = "call-3"), turn.coach, made)) as Outcome.Refused
        assertEquals(GymRefusal.Other(Refused(RefusalCode(Gym.Codes.messageFinal), turn.coach.ref, path = Refused.Path.predicted)), ended.refusal)
    }

    @Test fun anOutcomeReadsAsItsBytes() {
        val bytes = """{"a":1}""".encodeToByteArray()
        assertEquals(AbilityOutcome.Result(bytes), AbilityOutcome.Result("""{"a":1}""".encodeToByteArray(), Sha256.hex(bytes)))
        assertNotEquals(AbilityOutcome.Result(bytes), AbilityOutcome.Result("""{"a":2}""".encodeToByteArray()))
    }
}
