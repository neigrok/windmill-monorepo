package works.windmill.gym.coach

import works.windmill.domain.kit.AbilityClass
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Repository
import works.windmill.gym.coach.turn.TurnPhone
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.coach.ReadServed
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

// An answer as a screen test hands it to the room, on this phone unless it says otherwise.
internal fun coachReply(text: String = "", state: MessageState = MessageState.completed, id: String = "coach-message", calls: List<CoachCall> = emptyList(),
    read: ReadTally = ReadTally(), created: List<RecordRef> = emptyList(), routines: List<CreatedRoutine> = emptyList(), truncated: Boolean = false, onThisPhone: Boolean = true,
    savedNotes: List<SavedNote> = emptyList(), madeMovements: List<MadeMovement> = emptyList(), logStood: Boolean = true) =
    CoachReply(id, text, state, truncated, onThisPhone, calls, CoachReceipt(read, created), routines, savedNotes, madeMovements, logStood)

internal fun coachCall(name: String, phrase: String? = name, outcome: AbilityCall.Outcome = AbilityCall.Outcome.Ok,
    read: RecordedRead = RecordedRead.Ids(ReadServed.none), detail: String? = null) =
    CoachCall(name, phrase, outcome, read, TurnPhone.catalog().ability(name)?.kind == AbilityClass.read, name, detail)

// A conversation the engine holds, as a turn that ended whole left it: its thread's id.
internal fun EngineRoomFixture.heldConversation(question: String, answer: String = "An answer"): String {
    val runner = ActionRunner(engine, engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
    val turn = (runner.run(OpenTurn(null, question)) as Outcome.Committed).result
    check(runner.run(EndTurn(turn.coach, MessageState.completed, answer)) is Outcome.Committed)
    return checkNotNull(turn.thread.record.string)
}

internal fun EngineRoomFixture.heldThreads(): List<CoachThread> = engine.read(ScopeRef(Gym.scope)) { read ->
    Repository.decode(CoachThread, read.drawn(CoachThread.type))
}
