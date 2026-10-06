import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// The gym's rule book, every gym feature's entities and rules, pinned by packages/api-contract/gym/domain/rules.json.
public enum GymRules {
  public static let book = RuleBook(registry: SyncSchema.registry,
    entities: [Note.self, WeighIn.self, Routine.self, Exercise.self, ExerciseName.self, Session.self, TrainingSet.self, GymPreferences.self, Proposal.self],
    rules: NoteRules.rules + WeighInRules.rules + RoutineRules.rules + ExerciseRules.rules + SetRules.rules + SessionRules.rules + PreferencesRules.rules + ProposalRules.rules +
      ImportSessionCommand.specs.map { .local($0) } + CorrectSessionCommand.specs.map { .local($0) } + [
        .local("routine.order", subject: Routine.type),
        .serverDecided("routine.exercise", codes: [Gym.Codes.unknownExercise], subject: Routine.type),
        .serverDecided("proposal.exercise", codes: [Gym.Codes.unknownExercise], subject: Proposal.type),
        .serverDecided("set.session", codes: [Gym.Codes.sessionFinished], subject: TrainingSet.type),
        .serverDecided("set.exercise", codes: [Gym.Codes.unknownExercise], subject: TrainingSet.type),
        .serverDecided("session.open", codes: [Gym.Codes.sessionOpen], subject: Session.type),
        .serverDecided("session.instant", codes: [Gym.Codes.badInstant], subject: Session.type),
        .serverDecided("session.overlap", codes: [Gym.Codes.sessionOverlap], subject: Session.type),
        .serverDecided("session.payload", codes: [Gym.Codes.payloadConflict], subject: Session.type),
        .serverDecided("proposal.settled", codes: [Gym.Codes.proposalSettled], subject: Proposal.type),
        .serverDecided("proposal.superseded", codes: [Gym.Codes.proposalSuperseded], subject: Proposal.type),
      ])
}

// The gym's one refusal: every code its rules declare, mapped from the code, the subject, the path and a cap's detail.
public enum GymRefusal: ProductRefusal, Equatable {
  case invalid(Violation)
  case stale(RecordRef, Refused.Path)
  case gone(RecordRef, Refused.Path)
  case taken(RecordRef, Refused.Path)
  case full(type: String, cap: Int, Refused.Path)
  // A weigh-in's day past the server's UTC tomorrow.
  case future(RecordRef, Refused.Path)
  case sessionFinished(Refused)
  case sessionOpen(Refused)
  case sessionOverlap(Refused)
  case payloadConflict(Refused)
  case unknownExercise(Refused)
  case badInstant(Refused)
  case proposalSettled(Refused)
  case proposalSuperseded(Refused)
  case other(Refused)

  public init(_ v: Violation) {
    self = .invalid(v)
  }

  public init(_ r: Refused) {
    switch (r.code, r.subject, r.cap) {
    case (.stale, let s?, _): self = .stale(s, r.path)
    case (.unknownRecord, let s?, _), (.recordDead, let s?, _): self = .gone(s, r.path)
    case (.idTaken, let s?, _), (.idSpent, let s?, _): self = .taken(s, r.path)
    case (.cap, _, let c?): self = .full(type: c.type, cap: c.cap, r.path)
    case (Gym.Codes.badInstant, let s?, _) where s.type == WeighIn.type: self = .future(s, r.path)
    case (Gym.Codes.badInstant, _, _): self = .badInstant(r)
    case (Gym.Codes.sessionFinished, _, _): self = .sessionFinished(r)
    case (Gym.Codes.sessionOpen, _, _): self = .sessionOpen(r)
    case (Gym.Codes.sessionOverlap, _, _): self = .sessionOverlap(r)
    case (Gym.Codes.payloadConflict, _, _): self = .payloadConflict(r)
    case (Gym.Codes.unknownExercise, _, _): self = .unknownExercise(r)
    case (Gym.Codes.proposalSettled, _, _): self = .proposalSettled(r)
    case (Gym.Codes.proposalSuperseded, _, _): self = .proposalSuperseded(r)
    default: self = .other(r)
    }
  }

  public var isGeneric: Bool {
    guard case .other = self else { return false }
    return true
  }
}
