package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

sealed interface GymRefusal {
    data class Invalid(val violation: Violation) : GymRefusal
    data class Stale(val subject: RecordRef, val path: Refused.Path) : GymRefusal
    data class Gone(val subject: RecordRef, val path: Refused.Path) : GymRefusal
    data class Taken(val subject: RecordRef, val path: Refused.Path) : GymRefusal
    data class Full(val type: String, val cap: Long, val path: Refused.Path) : GymRefusal
    data class Future(val subject: RecordRef, val path: Refused.Path) : GymRefusal
    data class SessionFinished(val refused: Refused) : GymRefusal
    data class SessionOpen(val refused: Refused) : GymRefusal
    data class SessionOverlap(val refused: Refused) : GymRefusal
    data class PayloadConflict(val refused: Refused) : GymRefusal
    data class UnknownExercise(val refused: Refused) : GymRefusal
    data class BadInstant(val refused: Refused) : GymRefusal
    data class ProposalSettled(val refused: Refused) : GymRefusal
    data class ProposalSuperseded(val refused: Refused) : GymRefusal
    data class Other(val refused: Refused) : GymRefusal
    companion object : Refusals<GymRefusal> {
        override fun of(violation: Violation): GymRefusal = Invalid(violation)
        override fun of(refused: Refused): GymRefusal {
            val subject = refused.subject
            return when (refused.code.text) {
                "stale" -> subject?.let { Stale(it, refused.path) } ?: Other(refused)
                "unknown-record", "record-dead" -> subject?.let { Gone(it, refused.path) } ?: Other(refused)
                "id-taken", "id-spent" -> subject?.let { Taken(it, refused.path) } ?: Other(refused)
                "cap" -> refused.cap?.let { Full(it.first, it.second, refused.path) } ?: Other(refused)
                Gym.Codes.badInstant -> if (subject?.type == WeighIn.type) Future(subject, refused.path) else BadInstant(refused)
                Gym.Codes.sessionFinished -> SessionFinished(refused)
                Gym.Codes.sessionOpen -> SessionOpen(refused)
                Gym.Codes.sessionOverlap -> SessionOverlap(refused)
                Gym.Codes.payloadConflict -> PayloadConflict(refused)
                Gym.Codes.unknownExercise -> UnknownExercise(refused)
                Gym.Codes.proposalSettled -> ProposalSettled(refused)
                Gym.Codes.proposalSuperseded -> ProposalSuperseded(refused)
                else -> Other(refused)
            }
        }
        override fun isGeneric(refusal: GymRefusal): Boolean = refusal is Other
    }
}

object GymRules {
    val book = RuleBook(SyncSchema.registry, listOf(Note, WeighIn, Routine, RoutineCreation, Exercise, ExerciseName, Session, TrainingSet, Preferences, Proposal),
        NoteRules.rules + WeighInRules.rules + RoutineRules.rules + ExerciseRules.rules + SetRules.rules + PreferencesRules.rules + ProposalRules.rules +
        GymCommand.specs.values.flatten().map(Rule::local) + listOf(
            Rule.local("routine.order", Routine.type),
            Rule.local("set.identity", TrainingSet.type),
            Rule.local("set.setNumber", TrainingSet.type),
            Rule.local("session.startedAt", Session.type),
            Rule.local("session.finishedAt", Session.type),
            Rule.local("session.sets", Session.type),
            Rule.local("session.requestId", Session.type),
            Rule.serverDecided("routine.exercise", listOf(RefusalCode(Gym.Codes.unknownExercise)), Routine.type),
            Rule.serverDecided("proposal.exercise", listOf(RefusalCode(Gym.Codes.unknownExercise)), Proposal.type),
            Rule.serverDecided("set.session", listOf(RefusalCode(Gym.Codes.sessionFinished)), TrainingSet.type),
            Rule.serverDecided("set.exercise", listOf(RefusalCode(Gym.Codes.unknownExercise)), TrainingSet.type),
            Rule.serverDecided("session.open", listOf(RefusalCode(Gym.Codes.sessionOpen)), Session.type),
            Rule.serverDecided("session.instant", listOf(RefusalCode(Gym.Codes.badInstant)), Session.type),
            Rule.serverDecided("session.overlap", listOf(RefusalCode(Gym.Codes.sessionOverlap)), Session.type),
            Rule.serverDecided("session.payload", listOf(RefusalCode(Gym.Codes.payloadConflict)), Session.type),
            Rule.serverDecided("proposal.settled", listOf(RefusalCode(Gym.Codes.proposalSettled)), Proposal.type),
            Rule.serverDecided("proposal.superseded", listOf(RefusalCode(Gym.Codes.proposalSuperseded)), Proposal.type),
        ))
}
