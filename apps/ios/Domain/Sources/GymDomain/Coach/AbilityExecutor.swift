import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// The replica executor (Coach D-6, §4.3 step 2): one ability call of a turn, run on this phone's replica as one gesture
// that re-checks the call's shape, commits the ability's writes and records the call on the Coach message — or, when
// the call is refused, records the refusal alone.

public struct AbilityRequest: Sendable, Equatable {
  public let callId: String
  public let name: String
  public let input: JSON

  public init(callId: String, name: String, input: JSON) {
    self.callId = callId
    self.name = name
    self.input = input
  }
}

// What the phone posts for a call (Coach §6.4): the result's canonical bytes with their digest, or the code it refused with.
public enum AbilityOutcome: Sendable, Equatable {
  case result(jcs: [UInt8], sha256: String)
  case refused(AbilityRefusal)
}

public struct AbilityExecutor: Sendable {
  // Shares are server records; a phone turn's gate runs them on the server executor and never sends them here.
  public static let serverRun: Set<String> = ["share_session", "share_log", "revoke_share"]

  let runner: ActionRunner
  let appBaseUrl: String

  public init(runner: ActionRunner, appBaseUrl: String) {
    self.runner = runner
    self.appBaseUrl = appBaseUrl
  }

  // The call's outcome, committed with its record on the Coach message; a refusal here means the message is not a running
  // Coach message of this replica, so nothing was recorded and the turn is over.
  public func run(_ request: AbilityRequest, on message: ID<CoachMessage>, seat: Seat) throws -> Outcome<AbilityOutcome, GymRefusal> {
    try runner.run(RunAbility(request, on: message, seat: seat, appBaseUrl: appBaseUrl))
  }
}

// MARK: - One call as an action

// Any ability as a decider the run composes: its load and its decision, each over the loaded value it declares.
struct AbilityRun: Sendable {
  let load: @Sendable (Reader) throws -> Any
  let decide: @Sendable (Any, IDSource) -> Decision<AbilityAnswer, GymRefusal>

  init<D: Decider>(_ decider: D) where D.Result == AbilityAnswer, D.Refusal == GymRefusal {
    load = { try decider.load($0) }
    decide = { loaded, ids in decider.decision(loaded as! D.Loaded, ids: ids) }
  }
}

public struct RunAbility: Action {
  public struct Loaded {
    let message: CoachMessage?
    let ability: Any?
    let moment: Moment
  }

  enum Gate {
    case run(AbilityRun)
    case refuse(AbilityRefusal)
  }

  let request: AbilityRequest
  let message: ID<CoachMessage>
  let gate: Gate

  public init(_ request: AbilityRequest, on message: ID<CoachMessage>, seat: Seat, appBaseUrl: String) {
    self.request = request
    self.message = message
    gate = RunAbility.gate(request, seat: seat, appBaseUrl: appBaseUrl)
  }

  public var scope: ScopeRef { Gym.scope }

  public func load(_ read: Reader) throws -> Loaded {
    let message = try read.repository(CoachMessage.self).find(message, in: .drawn)
    guard message?.role == .coach, message?.state == .running, case .run(let ability) = gate else {
      return Loaded(message: message, ability: nil, moment: read.moment)
    }
    return Loaded(message: message, ability: try ability.load(read), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<AbilityOutcome, GymRefusal> {
    guard let message = loaded.message, message.role == .coach else {
      return .refuse(GymRefusal(Refused(.unknownRecord, subject: self.message.ref, path: .predicted)))
    }
    guard message.state == .running else { return .refuse(GymRefusal(Refused(Gym.Codes.messageFinal, subject: self.message.ref, path: .predicted))) }
    let refusing = { (code: AbilityRefusal, input: JSON?) throws(Violation) -> Decision<AbilityOutcome, GymRefusal> in
      try recording(AbilityCall(callId: request.callId, name: request.name, input: input, outcome: .refused(code)), answering: .refused(code),
                    plan: Plan(), on: message, at: loaded.moment)
    }
    switch (gate, loaded.ability) {
    case (.refuse(let code), _):
      return try refusing(code, nil)
    case (.run(let ability), let value?):
      switch ability.decide(value, ids) {
      case .refuse:
        return try refusing(.refused, request.input)
      case .unchanged(let answer):
        return try answering(answer, plan: Plan(), on: message, at: loaded.moment)
      case .write(let plan, let answer):
        return try answering(answer, plan: plan, on: message, at: loaded.moment)
      }
    case (.run, nil):
      preconditionFailure("an admitted call loaded nothing")
    }
  }

  // Coach §4.3 step 2, §6.4: the result as the server answers it, with the tally of what the call served when it served
  // anything, measured before anything commits; past `TOOL_RESULT_BYTES` the call is refused `result-too-large`, its
  // writes dropped, so no result the phone cannot send is ever written.
  func answering(_ answer: AbilityAnswer, plan: Plan, on message: CoachMessage, at moment: Moment) throws(Violation) -> Decision<AbilityOutcome, GymRefusal> {
    var payload = answer.payload
    if !answer.served.isEmpty, case .object(var members) = payload {
      members["read"] = answer.served.tally.json
      payload = .object(members)
    }
    let bytes = payload.jcs
    guard bytes.count <= CoachRules.maxResultBytes else {
      return try recording(AbilityCall(callId: request.callId, name: request.name, input: request.input, outcome: .refused(.resultTooLarge)),
                           answering: .refused(.resultTooLarge), plan: Plan(), on: message, at: moment)
    }
    let call = AbilityCall(callId: request.callId, name: request.name, input: request.input, outcome: .ok, created: answer.created,
                           read: .ids(answer.served))
    return try recording(call, answering: .result(jcs: bytes, sha256: SHA256Hex.of(bytes)), plan: plan, on: message, at: moment)
  }

  // The call on the Coach message, in the same gesture as the ability's writes (kit §9.3), in the fullest form the
  // message's calls hold (`CoachMessage.recorded`): refused `coach-turn-volume`, writes dropped, when only a bare record
  // fits the bound; and refused unrecorded, as the message's own bound, when not even that fits.
  func recording(_ call: AbilityCall, answering outcome: AbilityOutcome, plan: Plan, on message: CoachMessage, at moment: Moment)
    throws(Violation) -> Decision<AbilityOutcome, GymRefusal>
  {
    guard let recorded = message.recorded(call) else { return .refuse(GymRefusal(Refused(.tooLarge, subject: message.id.ref, path: .predicted))) }
    var next = message
    next.calls.append(recorded)
    var written = recorded.outcome == call.outcome ? plan : Plan()
    written.update(try Valid(next, fields: ["calls"], at: moment), fields: ["calls"])
    return .write(written, recorded.outcome == call.outcome ? outcome : .refused(.volume))
  }

  // Coach §5 on the phone: G-1 offered, G-2 the seat, the server's own abilities, G-3 the shape at every depth, then the
  // ability's decider from its input. Three codes for a call its input sinks, the server's own: the gate's G-3 shape
  // check refuses `invalid-input`; an input past a bound the schema does not state, which the server's tool refuses as
  // malformed, is `invalid-arguments`; what a rule refuses in deciding is `refused`.
  static func gate(_ request: AbilityRequest, seat: Seat, appBaseUrl: String) -> Gate {
    guard let ability = Catalog.ability(named: request.name), ability.agent != .withheld, ability.declared,
          !AbilityExecutor.serverRun.contains(request.name) else { return .refuse(.notOffered) }
    guard ability.admits(seat) else { return .refuse(.seatRequired) }
    guard JSONSchema(ability.input).fault(in: request.input) == nil else { return .refuse(.invalidInput) }
    do {
      return .run(try decider(for: request, appBaseUrl: appBaseUrl))
    } catch {
      return .refuse(.invalidArguments)
    }
  }

  static func decider(for request: AbilityRequest, appBaseUrl: String) throws -> AbilityRun {
    let f = try Fields(request.input)
    switch request.name {
    case "list_routines": return AbilityRun(ProgramRead(routineId: try f.optionalRef("routineId", Routine.self)))
    case "list_exercises": return AbilityRun(CatalogueRead())
    case "list_sessions":
      let beforeId = try f.optionalString("beforeId")
      guard beforeId == nil || f.json("before") != nil else { throw DecodeError(type: "list_sessions", field: "beforeId", reason: "without before") }
      return AbilityRun(LogRead(.sessions(before: try f.optionalInstant("before") ?? Instant(ms: SessionRules.maxInstantMs), beforeId: beforeId ?? "",
                                       limit: min(LogRead.maxPage, try f.optionalInt("limit") ?? LogRead.defaultPage))))
    case "get_session": return AbilityRun(LogRead(.session(try f.ref("sessionId", Session.self), review: try f.bool("review", default: false))))
    case "get_sessions":
      return AbilityRun(LogRead(.workouts(try f.json("sessionIds")!.asArray().map { ID(RecordID(try $0.asString())) }, review: try f.bool("review", default: false))))
    case "last_time": return AbilityRun(LogRead(.lastTime(try f.ref("exerciseId", Exercise.self))))
    case "get_last_times": return AbilityRun(LogRead(.lastTimes(try f.json("exerciseIds")!.asArray().map { ID(RecordID(try $0.asString())) })))
    case "get_stats": return AbilityRun(LogRead(.stats(try f.optionalRef("exerciseId", Exercise.self))))
    case "list_notes": return AbilityRun(NotesRead())
    case "list_bodyweight": return AbilityRun(BodyweightRead(from: try f.optionalString("from"), to: try f.optionalString("to")))
    case "create_routine":
      return AbilityRun(CreateRoutineCall(Routine(id: try given("id", f, Routine.self), name: try f.string("name"), position: try f.int("position"),
                                               entries: try f.list("entries", of: RoutineEntry.self))))
    case "create_exercise":
      let equipment = try f.string("equipment")
      return AbilityRun(CreateExerciseCall(Exercise(id: try given("id", f, Exercise.self), name: try f.string("name"), pattern: try f.string("pattern"),
                                                 equipment: equipment, stepKg: try f.optionalDouble("stepKg") ?? ExerciseRules.defaultStepKg(equipment: equipment))))
    case "save_note":
      // The server's note bounds (backend Note.cpp, its tool's `invalid-arguments`): a blank title, a title past 60 code
      // points or a body past 500 UTF-8 bytes, both measured after the trim, the same measures NoteRules keep. What the
      // store refuses beyond them (ten notes, a taken id) stays `refused`.
      let note = Note(id: try given("id", f, Note.self), title: try f.string("title"), body: try f.string("body"))
      do {
        _ = try NoteRules.title.apply(note.title, at: "title")
        _ = try NoteRules.body.apply(note.body, at: "body")
      } catch {
        throw DecodeError(type: Note.type, field: error.path.text, reason: "past the note's bounds")
      }
      return AbilityRun(SaveNoteAbility(note))
    case "propose_routine_change":
      let proposing = ProposeRoutine(id: try given("id", f, Proposal.self), routineId: try f.ref("routineId", Routine.self),
                                     name: try f.optionalString("name"), entries: try f.list("entries", of: RoutineEntry.self),
                                     summary: try f.string("summary", default: ""))
      return AbilityRun(ProposeRoutineCall(proposing, appBaseUrl: appBaseUrl))
    case "propose_routine_removal":
      let proposing = ProposeRoutine(id: try given("id", f, Proposal.self), routineId: try f.ref("routineId", Routine.self), name: nil, entries: [],
                                     summary: try f.string("summary", default: ""), removing: true)
      return AbilityRun(ProposeRoutineCall(proposing, appBaseUrl: appBaseUrl))
    default: throw DecodeError(type: request.name, field: "name", reason: "no replica ability")
    }
  }

  // Coach G-7, kit §4 "given": the id the turn minted for the call's new record, in the shape the registry admits.
  static func given<E: Entity>(_ field: String, _ f: Fields, _ type: E.Type) throws -> ID<E> {
    let id = try f.string(field)
    guard let pattern = SyncSchema.registry.type(E.type)?.idPattern, pattern.matches(id) else {
      throw DecodeError(type: E.type, field: field, reason: "not an id the registry admits")
    }
    return ID(RecordID(id))
  }
}
