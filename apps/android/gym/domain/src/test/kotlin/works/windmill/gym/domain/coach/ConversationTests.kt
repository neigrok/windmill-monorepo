package works.windmill.gym.domain.coach

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.RegistryCheck
import works.windmill.domain.testing.withActionContext
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.TrainingSet
import works.windmill.sync.api.RecordRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

// A Coach conversation on the real engine, over a model server shared by every phone, and the pure reads over its messages. The shared vectors hold OpenTurn, EndTurn, a call's record and a read's week.
class ConversationTests {
    private class Phone(val engine: SteppedEngine, context: ActionContext) {
        val runner = ActionRunner(engine.replica, SyncSchema.registry, FixedZone(0), context)
        fun thread(id: Id<CoachThread>): CoachThread? = runner.read(CoachThread.scope) { it.repository(CoachThread).find(id, ViewMode.stored) }
        fun threads(): List<CoachThread> = runner.read(CoachThread.scope) { it.repository(CoachThread).all(ViewMode.stored) }
        fun messages(): List<CoachMessage> = runner.read(CoachMessage.scope) { it.repository(CoachMessage).all(ViewMode.stored) }
        fun message(id: Id<CoachMessage>): CoachMessage = messages().single { it.id == id }
        fun device(key: String): Json? = runner.read(CoachMessage.scope) { it.device(key) }
        fun open(question: String = "How heavy today?", thread: Id<CoachThread>? = null, pictures: List<Picture> = emptyList()): OpenTurn.Turn =
            (runner.run(OpenTurn(thread, question, pictures)) as Outcome.Committed).result
    }

    private fun twoPhones(body: (Phone, Phone) -> Unit) = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, 1_800_000_000_000L, rules = GymServerRules()).use { engine ->
            withActionContext { context ->
                val second = engine.device()
                body(Phone(engine, context), Phone(second, context))
            }
        }
    }

    // What the executor does for a call's record, without a call to run.
    private class RecordCall(val message: Id<CoachMessage>, val call: AbilityCall) : Action<RecordCall.Loaded, AbilityCall?, GymRefusal> {
        data class Loaded(val message: CoachMessage, val moment: Moment)
        override val scope = CoachMessage.scope
        override val refusals = GymRefusal
        override fun load(read: Reader) = Loaded(read.repository(CoachMessage).find(message, ViewMode.drawn)!!, read.moment)
        override fun decide(loaded: Loaded, ids: IDSource): Decision<AbilityCall?, GymRefusal> {
            val recorded = loaded.message.recorded(call) ?: return Decision.Unchanged(null)
            val plan = Plan()
            plan.update(Valid(loaded.message.copy(calls = loaded.message.calls + recorded), CoachMessage, listOf("calls"), loaded.moment), listOf("calls"))
            return Decision.Write(plan, recorded)
        }
    }

    private fun picture(n: Int, localOnly: Boolean = true) = Picture("picture0000000$n", "image/jpeg", localOnly)
    private fun row(picture: Picture) = CoachPictureRow(picture.id, picture.mediaType, 1200, 900, 345_678)
    private fun gone(type: String, id: Id<*>) = GymRefusal.Gone(RecordRef(type, id.record), Refused.Path.predicted)

    @Test fun theEntitiesAgreeWithTheRegistry() {
        val threadId = Id("thrdAAAAAAAAAAA1", CoachThread)
        RegistryCheck.entity(CoachThread, CoachThread(threadId, "How heavy today?"), CoachRules.book)
        val served = ReadServed.none.saw(1_799_020_800_000L)
        val call = AbilityCall("call-1", "list_sessions", Json.objectOf(), AbilityCall.Outcome.Ok, listOf(RecordRef("proposal", RecordID("propA"))), RecordedRead.Ids(served))
        val counted = AbilityCall("call-2", "get_session", null, AbilityCall.Outcome.Ok, read = RecordedRead.Counts(ReadTally(600, 1, 1)))
        val sample = CoachMessage(Id("turnAAAAAAAAAAA1", CoachMessage), threadId, CoachMessage.Role.coach, "rp_00000000000000000000000000000001", "Add 5 kg.",
            MessageState.completed, true, AbilityCall.receipt(listOf(call, counted)), listOf(call, counted), listOf(picture(1)), Instant(1_800_000_000_000))
        RegistryCheck.entity(CoachMessage, sample, CoachRules.book)
        assertEquals(sample, CoachMessage.decode(Fields(CoachMessage.type, sample.id.record, sample.fields())))
        val lifter = CoachMessage(sample.id, threadId, CoachMessage.Role.lifter, text = "How heavy today?", at = Instant(1_800_000_000_000))
        assertEquals(listOf("at", "role", "text", "threadId"), lifter.fields().keys.sorted())
        assertEquals(listOf(0, 1, 2, 2, 2, 2), MessageState.entries.map { it.rank })
        assertEquals(listOf(false, false, true, true, true, true), MessageState.entries.map { it.isWritersTerminal })
        assertThrows(IllegalArgumentException::class.java) { EndTurn(sample.id, MessageState.running) }
    }

    @Test fun aRecordThatCannotBeReadIsADecodeErrorAndAStateItDoesNotKnowReadsRunning() {
        val fields = mapOf("threadId" to Json.of("thrdAAAAAAAAAAA1"), "at" to Json.of(1), "role" to Json.of("coach"))
        fun decoding(values: Map<String, Json>) = CoachMessage.decode(Fields(CoachMessage.type, RecordID("turnAAAAAAAAAAA1"), values))
        fun refused(values: Map<String, Json>) = assertThrows(DecodeError::class.java) { decoding(values) }.let { "${it.field}: ${it.reason}" }
        assertEquals(MessageState.running, decoding(fields + ("state" to Json.of("paused"))).state)
        assertEquals(emptyList<AbilityCall>(), decoding(fields + ("calls" to Json.Null)).calls)
        assertEquals("role: not a role", refused(fields + ("role" to Json.of("agent"))))
        assertEquals("calls: not an array", refused(fields + ("calls" to Json.of("x"))))
        val call = mapOf("callId" to Json.of("c"), "name" to Json.of("n"), "outcome" to Json.of("ok"), "created" to Json.Arr(emptyList()), "read" to ReadServed.none.json)
        fun refusedCall(values: Map<String, Json>) = assertThrows(DecodeError::class.java) { AbilityCall.decode(Json.Obj(values.toList())) }.let { "${it.field}: ${it.reason}" }
        assertEquals("calls.outcome: not an outcome", refusedCall(call + ("outcome" to Json.of("maybe"))))
        assertEquals("calls.created: absent", refusedCall(call - "created"))
        assertEquals("calls.created: not an id", refusedCall(call + ("created" to Json.array(Json.objectOf("t" to Json.of("note"), "id" to Json.of(1))))))
        assertEquals("calls.read: absent", refusedCall(call - "read"))
        assertEquals("calls.read.sessions: absent", refusedCall(call + ("read" to Json.objectOf())))
        assertEquals("calls.read.sets: not an id", refusedCall(call + ("read" to Json.objectOf("sessions" to Json.array(), "sets" to Json.array(Json.of(1)), "weeks" to Json.array()))))
        assertEquals("calls.read.weeks: not an integer", refusedCall(call + ("read" to Json.objectOf("sessions" to Json.array(), "sets" to Json.array(), "weeks" to Json.array(Json.of(1.5))))))
    }

    @Test fun aTurnOpensInOneGestureSyncsWithoutItsDeviceRowsAndEndsWithItsReceipt() = twoPhones { a, b ->
        val keep = picture(1)
        a.runner.run(KeepPicture(row(keep)))
        val turn = a.open(pictures = listOf(keep))
        assertEquals(listOf(CoachThread(turn.thread, "How heavy today?")), a.threads())
        val coach = a.message(turn.coach)
        assertEquals(CoachMessage(turn.coach, turn.thread, CoachMessage.Role.coach, a.engine.engine.activeReplica(), at = coach.at), coach)
        assertEquals(CoachMessage(turn.lifter, turn.thread, CoachMessage.Role.lifter, text = "How heavy today?", pictures = listOf(keep), at = coach.at), a.message(turn.lifter))
        assertEquals(turn.coach.json, a.device(EndTurn.runningTurnKey))

        a.engine.sync()
        assertEquals(a.messages(), b.messages())
        assertEquals(a.threads(), b.threads())
        assertNull(b.device(EndTurn.runningTurnKey))
        assertNull(b.device(CoachPictureRow.key(keep.id)))

        val served = ReadServed.none.saw(1_799_020_800_000L)
        val read = AbilityCall("call-1", "get_stats", Json.objectOf(), AbilityCall.Outcome.Ok, read = RecordedRead.Ids(served))
        assertEquals(read, (a.runner.run(RecordCall(turn.coach, read)) as Outcome.Committed).result)
        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
        val receipt = Json.objectOf("read" to ReadTally(0, 0, 1).json, "results" to Json.Arr(emptyList()))
        assertEquals(coach.copy(state = MessageState.completed, text = "Add 5 kg.", receipt = receipt, calls = listOf(read)), a.message(turn.coach))
        assertNull(a.device(EndTurn.runningTurnKey))
        assertEquals(keep.let(::row).json, a.device(CoachPictureRow.key(keep.id)))
        assertEquals(Outcome.Unchanged(Unit), a.runner.run(EndTurn(turn.coach, MessageState.stopped)))

        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(a.messages(), b.messages())
        assertEquals(MessageState.completed, b.message(turn.coach).state)
    }

    @Test fun aRefusedOpenOrEndWritesNothing() = twoPhones { a, _ ->
        val before = a.engine.engine.snapshot()
        val long = "é".repeat(4000) + "x"
        val tooLong = (a.runner.run(OpenTurn(question = long)) as Outcome.Refused).refusal as GymRefusal.Invalid
        assertEquals(Violation(CoachRules.question, Path("text"), Violation.Reason.TooLong(8_000, MeasureUnit.bytes, 8_001)).json, tooLong.violation.json)
        val blank = (a.runner.run(OpenTurn(question = " ")) as Outcome.Refused).refusal as GymRefusal.Invalid
        assertEquals(Violation(CoachRules.question, Path("text"), Violation.Reason.Blank).json, blank.violation.json)
        val absent = Id("thrdAAAAAAAAAAA1", CoachThread)
        assertEquals(gone(CoachThread.type, absent), (a.runner.run(OpenTurn(absent, "And then?")) as Outcome.Refused).refusal)
        assertEquals(before, a.engine.engine.snapshot())

        val turn = a.open()
        val opened = a.engine.engine.snapshot()
        val longAnswer = "é".repeat(65_536) + "x"
        val answer = (a.runner.run(EndTurn(turn.coach, MessageState.completed, longAnswer)) as Outcome.Refused).refusal as GymRefusal.Invalid
        assertEquals(Violation("message.text", Path("text"), Violation.Reason.TooLong(131_072, MeasureUnit.bytes, 131_073)).json, answer.violation.json)
        assertEquals(gone(CoachMessage.type, turn.lifter), (a.runner.run(EndTurn(turn.lifter, MessageState.completed)) as Outcome.Refused).refusal)
        assertEquals(opened, a.engine.engine.snapshot())
    }

    @Test fun theTextStreamsOnlyOntoThisReplicasRunningMessage() = twoPhones { a, b ->
        val turn = a.open()
        assertTrue(a.runner.run(StreamTurnText(turn.coach, "Add")) is Outcome.Committed)
        assertEquals("Add", a.message(turn.coach).text)
        assertEquals(Outcome.Unchanged(Unit), a.runner.run(StreamTurnText(turn.coach, "Add")))
        a.engine.sync()
        assertEquals("Add", b.message(turn.coach).text)

        val onAnother = b.engine.engine.snapshot()
        assertEquals(Outcome.Unchanged(Unit), b.runner.run(StreamTurnText(turn.coach, "Not mine")))
        assertEquals(onAnother, b.engine.engine.snapshot())

        val longest = "é".repeat(65_536)
        assertTrue(a.runner.run(StreamTurnText(turn.coach, longest)) is Outcome.Committed)
        val over = (a.runner.run(StreamTurnText(turn.coach, longest + "x")) as Outcome.Refused).refusal as GymRefusal.Invalid
        assertEquals("message.text", over.violation.rule)
        assertEquals(longest, a.message(turn.coach).text)

        assertTrue(a.runner.run(StreamTurnText(turn.coach, "Add 5")) is Outcome.Committed)
        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.stopped)) is Outcome.Committed)
        assertEquals(Outcome.Unchanged(Unit), a.runner.run(StreamTurnText(turn.coach, "Late words")))
        assertEquals("Add 5", a.message(turn.coach).text)

        val absent = Id("turnAAAAAAAAAAA1", CoachMessage)
        assertEquals(gone(CoachMessage.type, absent), (a.runner.run(StreamTurnText(absent, "Add")) as Outcome.Refused).refusal)
        assertEquals(gone(CoachMessage.type, turn.lifter), (a.runner.run(StreamTurnText(turn.lifter, "Add")) as Outcome.Refused).refusal)
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals("Add 5", b.message(turn.coach).text)
    }

    @Test fun aWithdrawnTurnInANewThreadTakesTheThreadThePicturesAndTheRunningTurn() = twoPhones { a, b ->
        val kept = picture(1)
        a.runner.run(KeepPicture(row(kept)))
        val unsent = a.open(pictures = listOf(kept))
        assertEquals(listOf(kept.id), (a.runner.run(WithdrawTurn(unsent)) as Outcome.Committed).result)
        assertEquals(emptyList<CoachThread>(), a.threads())
        assertEquals(emptyList<CoachMessage>(), a.messages())
        assertNull(a.device(EndTurn.runningTurnKey))
        assertNull(a.device(CoachPictureRow.key(kept.id)))

        val sent = a.open("Sent first")
        a.engine.sync()
        assertEquals(2, b.messages().size)
        assertEquals(emptyList<String>(), (a.runner.run(WithdrawTurn(sent)) as Outcome.Committed).result)
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(emptyList<CoachThread>(), b.threads())
        assertEquals(emptyList<CoachMessage>(), b.messages())

        val withdrawn = a.engine.engine.snapshot()
        assertEquals(gone(CoachThread.type, sent.thread), (a.runner.run(WithdrawTurn(sent)) as Outcome.Refused).refusal)
        assertEquals(withdrawn, a.engine.engine.snapshot())
    }

    @Test fun aWithdrawnTurnInAThreadHoldingEarlierTurnsLeavesThem() = twoPhones { a, b ->
        val earlierPicture = picture(1)
        a.runner.run(KeepPicture(row(earlierPicture)))
        val earlier = a.open(pictures = listOf(earlierPicture))
        assertTrue(a.runner.run(EndTurn(earlier.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
        val latePicture = picture(2)
        val inTheStore = picture(3, localOnly = false)
        a.runner.run(KeepPicture(row(latePicture)))
        val late = a.open("And now?", earlier.thread, listOf(latePicture))
        assertEquals(listOf(latePicture.id), (a.runner.run(WithdrawTurn(late)) as Outcome.Committed).result)
        assertEquals(listOf(CoachThread(earlier.thread, "How heavy today?")), a.threads())
        assertEquals(listOf(earlier.coach, earlier.lifter).sorted(), a.messages().map { it.id })
        assertEquals(row(earlierPicture).json, a.device(CoachPictureRow.key(earlierPicture.id)))
        assertNull(a.device(CoachPictureRow.key(latePicture.id)))
        assertNull(a.device(EndTurn.runningTurnKey))

        val held = a.open("And this?", earlier.thread, listOf(inTheStore))
        assertEquals(emptyList<String>(), (a.runner.run(WithdrawTurn(held)) as Outcome.Committed).result)
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(a.messages(), b.messages())
    }

    @Test fun aDeletedConversationTakesEveryMessageAndPictureAndADeleteOfNothingChangesNothing() = twoPhones { a, b ->
        val first = picture(1)
        val second = picture(2)
        a.runner.run(KeepPicture(row(first)))
        a.runner.run(KeepPicture(row(second)))
        val turn = a.open(pictures = listOf(first))
        assertTrue(a.runner.run(EndTurn(turn.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
        val next = a.open("And now?", turn.thread, listOf(second))
        assertTrue(a.runner.run(EndTurn(next.coach, MessageState.completed, "Rest.")) is Outcome.Committed)
        val other = a.open("Another conversation")
        assertTrue(a.runner.run(EndTurn(other.coach, MessageState.completed, "Yes.")) is Outcome.Committed)
        a.engine.sync()
        assertEquals(4 + 2, b.messages().size)

        val removed = (a.runner.run(DeleteConversation(turn.thread)) as Outcome.Committed).result
        assertEquals(setOf(first.id, second.id), removed.toSet())
        assertEquals(2, removed.size)
        assertNull(a.thread(turn.thread))
        assertEquals(listOf(other.coach, other.lifter).sorted(), a.messages().map { it.id })
        assertNull(a.device(CoachPictureRow.key(first.id)))
        assertNull(a.device(CoachPictureRow.key(second.id)))
        assertEquals(Outcome.Unchanged(emptyList<String>()), a.runner.run(DeleteConversation(turn.thread)))
        a.engine.sync()
        assertEquals(emptyList<Any>(), a.engine.notices("gym"))
        assertEquals(a.threads(), b.threads())
        assertEquals(a.messages(), b.messages())
        assertEquals(Outcome.Unchanged(emptyList<String>()), b.runner.run(DeleteConversation(turn.thread)))
    }

    // Coach §9.1: the state merges by rank whatever its stamp. A device created first sends first, so the phone made second is the writer whose older answer lands after the other's newer interrupted.
    @Test fun aWritersTerminalBeatsAnotherDevicesInterruptedWhicheverLandsFirst() = twoPhones { other, writer ->
        val first = writer.open()
        writer.engine.sync()
        val read = AbilityCall("call-1", "get_stats", Json.objectOf(), AbilityCall.Outcome.Ok, read = RecordedRead.Ids(ReadServed.none.saw(1_799_020_800_000L)))
        assertTrue(writer.runner.run(RecordCall(first.coach, read)) is Outcome.Committed)
        assertTrue(writer.runner.run(EndTurn(first.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
        writer.engine.advance(1_000)
        assertTrue(other.runner.run(EndTurn(first.coach, MessageState.interrupted)) is Outcome.Committed)
        assertEquals(MessageState.interrupted, other.message(first.coach).state)
        other.engine.sync()
        assertEquals(emptyList<Any>(), writer.engine.notices("gym"))
        assertEquals(emptyList<Any>(), other.engine.notices("gym"))
        assertEquals(MessageState.completed, writer.message(first.coach).state)
        assertEquals("Add 5 kg.", writer.message(first.coach).text)
        assertEquals(listOf(read), writer.message(first.coach).calls)
        assertEquals(writer.message(first.coach), other.message(first.coach))

        val second = writer.open("And now?", first.thread)
        writer.engine.sync()
        assertTrue(writer.runner.run(EndTurn(second.coach, MessageState.stopped, "Stopped.")) is Outcome.Committed)
        writer.engine.sync()
        assertEquals(MessageState.stopped, other.message(second.coach).state)
        assertEquals(Outcome.Unchanged(Unit), other.runner.run(EndTurn(second.coach, MessageState.interrupted)))
        assertEquals(writer.message(second.coach), other.message(second.coach))
    }

    @Test fun aServerRefusalOfAnotherDevicesInterruptedAfterAWritersTerminalIsItsNoticeAlone() = twoPhones { writer, other ->
        val turn = writer.open()
        writer.engine.sync()
        assertTrue(writer.runner.run(EndTurn(turn.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
        assertTrue(other.runner.run(EndTurn(turn.coach, MessageState.interrupted)) is Outcome.Committed)
        writer.engine.sync()
        assertEquals(emptyList<Any>(), writer.engine.notices("gym"))
        val notice = other.engine.notices("gym").single()
        assertEquals(RefusalCode(Gym.Codes.messageFinal), notice.code)
        assertEquals(MessageState.completed, other.message(turn.coach).state)
        assertEquals("Add 5 kg.", other.message(turn.coach).text)
    }

    @Test fun aSignedOutPhoneHoldsItsConversationWithoutAServerToAsk() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, 1_800_000_000_000L, account = null, rules = GymServerRules()).use { engine ->
            withActionContext { context ->
                val phone = Phone(engine, context)
                val turn = phone.open()
                assertEquals(engine.engine.activeReplica(), phone.message(turn.coach).replica)
                assertTrue(phone.runner.run(StreamTurnText(turn.coach, "Add")) is Outcome.Committed)
                assertTrue(phone.runner.run(EndTurn(turn.coach, MessageState.completed, "Add 5 kg.")) is Outcome.Committed)
                engine.sync()
                assertEquals(emptyList<Any>(), engine.notices("gym"))
                assertEquals(MessageState.completed, phone.message(turn.coach).state)
                assertEquals(Json.objectOf(), engine.server.snapshot()["rows"] ?: Json.objectOf())
            }
        }
    }

    @Test fun aMessagesBoundsAreMeasuredInBytesOfItsJcs() {
        val message = CoachMessage(Id("turnAAAAAAAAAAA1", CoachMessage), Id("thrdAAAAAAAAAAA1", CoachThread), CoachMessage.Role.coach, "rp_00000000000000000000000000000001", at = Instant(1))
        val moment = Moment(Instant(1), FixedZone(0))
        val empty = AbilityCall("c", "n", Json.objectOf("pad" to Json.of("")), AbilityCall.Outcome.Ok)
        val room = CoachRules.maxCallsBytes - message.copy(calls = listOf(empty)).callsBytes
        val full = empty.copy(input = Json.objectOf("pad" to Json.of("é".repeat(room / 2) + "x".repeat(room % 2))))
        assertEquals(CoachRules.maxCallsBytes, message.copy(calls = listOf(full)).callsBytes)
        Valid(message.copy(calls = listOf(full)), CoachMessage, listOf("calls"), moment)
        val over = empty.copy(input = Json.objectOf("pad" to Json.of("é".repeat(room / 2) + "x".repeat(room % 2 + 1))))
        val violation = assertThrows(Violation::class.java) { Valid(message.copy(calls = listOf(over)), CoachMessage, listOf("calls"), moment) }
        assertEquals(Violation("message.calls", Path("calls"), Violation.Reason.TooLong(32_768, MeasureUnit.bytes, 32_769)).json, violation.json)
    }

    @Test fun aPictureRowHoldsItsMetadataAlone() = twoPhones { a, _ ->
        val kept = CoachPictureRow("picture00000001", "image/jpeg", 4032, 3024, 5_242_880)
        assertTrue(a.runner.run(KeepPicture(kept)) is Outcome.Committed)
        val stored = a.device("picture:picture00000001")
        assertEquals(Json.objectOf("mediaType" to Json.of("image/jpeg"), "width" to Json.of(4032), "height" to Json.of(3024), "bytes" to Json.of(5_242_880)), stored)
        assertEquals(kept, CoachPictureRow.decode(kept.id, stored))
        assertNull(CoachPictureRow.decode(kept.id, null))
        assertNull(CoachPictureRow.decode(kept.id, Json.of("base64")))
        assertNull(CoachPictureRow.decode(kept.id, Json.objectOf("mediaType" to Json.of("image/jpeg"))))
    }

    @Test fun aReadPastTheCallsBoundIsRecordedAsCountsOnARealMessageAndTheReceiptSaysSo() {
        fun served(workout: Int): ReadServed {
            val startedAt = Instant(1_700_000_000_000 + workout * 7L * 86_400_000)
            val id = Id("ses" + workout.toString().padStart(13, '0'), Session)
            val session = Session(id, startedAt, Instant(startedAt.ms + 3_600_000), "finish")
            return (0 until 600).fold(ReadServed.none.saw(session)) { read, n ->
                read.saw(TrainingSet(Id("set" + (workout * 600 + n).toString().padStart(13, '0'), TrainingSet), id, Id("bench-press", Exercise), 60.0, 5, completedAt = startedAt, setNumber = n + 1))
            }
        }
        var message = CoachMessage(Id("turnAAAAAAAAAAA1", CoachMessage), Id("thrdAAAAAAAAAAA1", CoachThread), CoachMessage.Role.coach, "rp_00000000000000000000000000000001", at = Instant(1))
        for (workout in 0 until 3) {
            val call = AbilityCall("call-$workout", "get_session", Json.objectOf("sessionId" to Json.of("ses$workout")), AbilityCall.Outcome.Ok, read = RecordedRead.Ids(served(workout)))
            message = message.copy(calls = message.calls + message.recorded(call)!!)
        }
        assertEquals(listOf(RecordedRead.Ids(served(0)), RecordedRead.Ids(served(1)), RecordedRead.Counts(ReadTally(600, 1, 1))), message.calls.map { it.read })
        assertEquals(listOf(false, false, true), message.calls.map { it.input == null })
        assertTrue(message.callsBytes <= CoachRules.maxCallsBytes)
        assertEquals(message.calls[2], AbilityCall.decode(message.calls[2].json))
        val again = AbilityCall("call-3", "get_session", Json.objectOf(), AbilityCall.Outcome.Ok, read = RecordedRead.Ids(served(0)))
        assertEquals(again.copy(read = RecordedRead.Ids(ReadServed.none)), message.recorded(again))
        assertEquals(Json.objectOf("read" to ReadTally(1800, 3, 3).json, "results" to Json.Arr(emptyList()), "truncated" to Json.of(true)), AbilityCall.receipt(message.calls))
    }

    @Test fun aReadHoldsEachRowOnceInOrderAndServesNoSharedState() {
        val monday = 1_799_020_800_000L
        val mondayBefore = monday - 604_800_000
        val late = Session(Id("sesB", Session), Instant(monday + 5_000))
        val early = Session(Id("sesA", Session), Instant(mondayBefore + 5_000))
        val set = TrainingSet(Id("set1", TrainingSet), late.id, Id("bench-press", Exercise), 60.0, 5, completedAt = Instant(monday + 6_000))
        val read = ReadServed.none.saw(late).saw(early).saw(late).saw(set).saw(set)
        assertEquals(Json.objectOf("sessions" to Json.array(Json.of("sesA"), Json.of("sesB")), "sets" to Json.array(Json.of("set1")),
            "weeks" to Json.array(Json.of(mondayBefore), Json.of(monday))), read.json)
        assertEquals(ReadTally(1, 2, 2), read.tally)
        assertEquals(read, ReadServed.decode(read.json))
        assertTrue(ReadServed.none.isEmpty)
        assertEquals(read, read.saw(read))
        assertEquals(read, ReadServed.none.saw(read))
        val rest = read.without(ReadServed.none.saw(early))
        assertEquals(listOf(late.id), rest.sessions)
        assertEquals(listOf(set.id), rest.sets)
        assertEquals(listOf(monday), rest.weeks)
        assertTrue(read.without(read).isEmpty)
    }

    @Test fun messagesReadInTheOrderTheyWereSaid() {
        val thread = Id("thrdAAAAAAAAAAA1", CoachThread)
        val coachFirstById = CoachMessage(Id("aaaaaaaa", CoachMessage), thread, CoachMessage.Role.coach, at = Instant(5))
        val lifterLaterById = CoachMessage(Id("zzzzzzzz", CoachMessage), thread, CoachMessage.Role.lifter, at = Instant(5))
        val earlier = CoachMessage(Id("mmmmmmmm", CoachMessage), thread, CoachMessage.Role.coach, at = Instant(1))
        val sameMoment = CoachMessage(Id("bbbbbbbb", CoachMessage), thread, CoachMessage.Role.coach, at = Instant(5))
        assertEquals(listOf(earlier, lifterLaterById, coachFirstById, sameMoment), listOf(sameMoment, coachFirstById, lifterLaterById, earlier).inOrder)
    }

    private fun conversation(vararg turns: Triple<String, String, MessageState>): List<CoachMessage> {
        val thread = Id("thrdAAAAAAAAAAA1", CoachThread)
        return turns.flatMapIndexed { n, (question, answer, state) -> listOf(
            CoachMessage(Id("lifter%04d".format(n), CoachMessage), thread, CoachMessage.Role.lifter, text = question, at = Instant(n * 10L)),
            CoachMessage(Id("coach%04d".format(n), CoachMessage), thread, CoachMessage.Role.coach, text = answer, state = state, at = Instant(n * 10L)),
        ) }
    }

    @Test fun theHistoryTakesTheNewestCompletedTurnsOldestFirstWithinItsBounds() {
        val messages = conversation(Triple("q0", "a0", MessageState.completed), Triple("q1", "partial", MessageState.interrupted),
            Triple("q2", "a2", MessageState.completed), Triple("q3", "", MessageState.running))
        val sending = messages.last().id
        assertEquals(listOf("q0", "a0", "q2", "a2"), messages.history(sending).map { it.text })
        assertEquals(listOf(CoachMessage.Role.lifter, CoachMessage.Role.coach, CoachMessage.Role.lifter, CoachMessage.Role.coach), messages.history(sending).map { it.role })
        assertEquals(listOf("q2", "a2"), messages.history(sending, turns = 1).map { it.text })
        assertEquals(emptyList<String>(), messages.history(sending, turns = 0).map { it.text })
        assertEquals(listOf("q2", "a2"), messages.history(sending, bytes = 4).map { it.text })
        assertEquals(emptyList<String>(), messages.history(sending, bytes = 3).map { it.text })

        val wide = conversation(Triple("é", "é", MessageState.completed), Triple("éé", "éé", MessageState.completed))
        assertEquals(listOf("éé", "éé"), wide.history(Id("none0000", CoachMessage), bytes = 8).map { it.text })
        assertEquals(emptyList<String>(), wide.history(Id("none0000", CoachMessage), bytes = 7).map { it.text })

        val many = conversation(*Array(30) { Triple("q$it", "a$it", MessageState.completed) })
        assertEquals((6 until 30).flatMap { listOf("q$it", "a$it") }, many.history(Id("none0000", CoachMessage)).map { it.text })
        val inFlight = many.last().id
        assertEquals((5 until 29).flatMap { listOf("q$it", "a$it") }, many.history(inFlight).map { it.text })
    }

    // Coach §4.1 step 5: the message being sent and the lifter message before it, no further back.
    @Test fun theContextPicturesAreThoseOfTheMessageBeingSentAndTheOneBeforeIt() {
        val first = picture(1)
        val second = picture(2)
        val third = picture(3)
        fun asked(vararg pictures: Picture?) = conversation(*Array(pictures.size) { Triple("q$it", "a$it", MessageState.completed) }).mapIndexed { index, message ->
            if (message.role == CoachMessage.Role.lifter) message.copy(pictures = listOfNotNull(pictures[index / 2])) else message
        }
        fun sending(messages: List<CoachMessage>) = messages.last { it.role == CoachMessage.Role.lifter }.id

        val allThree = asked(first, second, third)
        assertEquals(listOf(third, second), allThree.contextPictures(sending(allThree)))
        assertEquals(listOf(third), allThree.contextPictures(sending(allThree), limit = 1))
        val previousOnly = asked(first, second, null)
        assertEquals(listOf(second), previousOnly.contextPictures(sending(previousOnly)))
        val noneNearby = asked(first, null, null)
        assertEquals(emptyList<Picture>(), noneNearby.contextPictures(sending(noneNearby)))
        val alone = asked(first)
        assertEquals(listOf(first), alone.contextPictures(sending(alone)))
        assertEquals(emptyList<Picture>(), allThree.contextPictures(Id("none0000", CoachMessage)))
    }
}
