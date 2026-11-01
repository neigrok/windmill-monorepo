import SyncCore

public struct GymServerRules: ServerRules {
  static let staleMs: Int64 = 14_400_000
  static let dayMs: Int64 = 86_400_000
  // Gym Coach §9.1 and Appendix A: a lifter message's text bound, the states a writer ends a turn in, the registers only
  // a Coach message carries, and the registers final once the writer has ended its turn.
  static let maxQuestionBytes = 8000
  static let writerTerminal: Set<JSON> = ["completed", "declined", "failed", "stopped"]
  static let coachRegisters: Set<String> = ["replica", "state", "truncated", "receipt", "calls"]
  static let finalRegisters: Set<String> = ["state", "text", "receipt", "calls"]

  public init() {}

  public func elsewhere(_ key: RecordKey, product: JSON.Object) -> Bool {
    key.type == "exercise" && product["seeds"]?[key.id.description] != nil
  }

  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
    switch command.name {
    case "gym.start": entry("starts", command.string("id"), in: context) != nil
    case "gym.importSession": entry("imports", command.string("id"), in: context) != nil
    case "gym.correctSession": entry("corrections", command.string("requestId"), in: context) != nil
    case "gym.applyProposal": entry("proposalApplies", command.string("proposalId"), in: context) != nil
    case "gym.applyWorkoutProposal": entry("workoutProposalApplies", command.string("proposalId"), in: context) != nil
    default: false
    }
  }

  public func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    switch command.name {
    case "gym.start": try start(command, in: context)
    case "gym.importSession": try importSession(command, in: context)
    case "gym.correctSession": try correctSession(command, in: context)
    case "gym.finish": try finish(command, in: context)
    case "gym.applyProposal": try applyProposal(command, in: context)
    case "gym.dismissProposal": try dismissProposal(command, in: context)
    case "gym.applyWorkoutProposal": try applyWorkoutProposal(command, in: context)
    case "gym.dismissWorkoutProposal": try dismissWorkoutProposal(command, in: context)
    case "gym.closeStale": CommandOutcome(deltas: staleClose(in: context), product: context.product)
    default: throw Refusal(.invalid)
    }
  }

  func start(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let called = command.string("id")
    let deltas = staleClose(in: context)
    var product = context.product
    ensureBook("starts", scope: context.scope, in: &product)
    let own = context.idState(of: key("session", called)).row
    let resolved = entry("starts", called, in: context)?.stringValue ?? own?.key.id.description
    if let resolved {
      guard let session = context.idState(of: key("session", resolved)).row, session.isAlive else {
        return CommandOutcome(deltas: deltas, product: product)
      }
      return CommandOutcome(deltas: deltas, write: [claim(session, from: resolved == called ? nil : called)], product: product)
    }
    let closed = Set(deltas.map(\.key))
    if let open = context.storedRecords(ofType: "session").first(where: { isOpen($0) && !closed.contains($0.key) }) {
      guard command.args["joinOpenSession"] == true else { throw refuse("session-open") }
      store(.string(open.key.id.description), table: "starts", id: called, scope: context.scope, in: &product)
      return CommandOutcome(deltas: deltas, write: [claim(open, from: called)], product: product)
    }
    let fields = sessionFields(command, in: context)
    store(.string(called), table: "starts", id: called, scope: context.scope, in: &product)
    let session = key("session", called)
    return CommandOutcome(deltas: deltas + [.serverCreate(session, fields: fields)],
                          write: [WriteClaim(key: session, born: .minted, fields: fields.keys.sorted())], product: product)
  }

  // The session registers a start or an import takes from the routine it names: its id, the plan and the routine revision
  // the plan froze at. A routine the owner cannot read leaves the session with neither.
  func sessionFields(_ command: CheckedCommand, in context: RuleContext) -> [String: JSON] {
    var fields: [String: JSON] = ["startedAt": command.args["startedAt"]!]
    if let id = command.args["routineId"]?.stringValue {
      let routine = context.idState(of: key("routine", id)).row
      let readable = routine?.isAlive == true
      fields["routineId"] = readable ? .string(id) : .null
      fields["plan"] = readable ? .object(["routine": value(routine, "name") ?? .null, "entries": value(routine, "entries") ?? .null]) : .null
      if readable { fields["historyRoutineId"] = .string(id) }
      if readable, let revision = value(routine, "revision"), !revision.isNull { fields["routineRevision"] = revision }
    }
    return fields
  }

  func importSession(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let called = command.string("id")
    let sets = command.args["sets"]!.arrayValue
    let deltas = staleClose(in: context)
    var product = context.product
    ensureBook("imports", scope: context.scope, in: &product)
    if let receipt = entry("imports", called, in: context) {
      guard receipt == .object(command.args) else { throw refuse("payload-conflict") }
      return CommandOutcome(deltas: deltas, write: replayWrite(called, sets: sets, in: context), product: product)
    }
    switch context.idState(of: key("session", called)) {
    case .alive, .dead: throw refuse("payload-conflict")
    case .foreign: throw Refusal(.idTaken)
    case .none: break
    }
    try checkSets(sets, command: command, correction: false, in: context)
    var fields = sessionFields(command, in: context)
    fields["finishedAt"] = command.args["finishedAt"]
    fields["closedBy"] = "finish"
    let session = key("session", called)
    var written: [PlannedDelta] = [.serverCreate(session, fields: fields)]
    var claims = [WriteClaim(key: session, born: .minted, fields: fields.keys.sorted())]
    for set in sets {
      let setKey = key("set", set["id"]!.stringValue!)
      let fields = setFields(called, set: set)
      written.append(.serverCreate(setKey, fields: fields))
      claims.append(WriteClaim(key: setKey, born: .minted, fields: fields.keys.sorted()))
    }
    store(.object(command.args), table: "imports", id: called, scope: context.scope, in: &product)
    return CommandOutcome(deltas: deltas + written, write: claims, product: product)
  }

  func checkSets(_ sets: [JSON], command: CheckedCommand, correction: Bool, in context: RuleContext) throws(Refusal) {
    let ids = sets.map { $0["id"]! }
    guard Set(ids).count == ids.count else { throw Refusal(.invalid) }
    if correction {
      guard !sets.isEmpty else { throw Refusal(.invalid) }
      let numbers = sets.map { JSON.array([$0["exerciseId"]!, $0["setNumber"]!]) }
      guard Set(numbers).count == numbers.count,
            sets.allSatisfy({ (1...2_147_483_647).contains($0["setNumber"]!.integerValue) }) else { throw Refusal(.invalid) }
    }
    let start = command.args["startedAt"]!.integerValue
    let end = command.args["finishedAt"]!.integerValue
    guard end >= start, end <= context.serverNow,
          sets.allSatisfy({ let at = $0["completedAt"]!.integerValue; return at >= start && at <= end }) else {
      throw refuse("bad-instant")
    }
    let id = command.string(correction ? "sessionId" : "id")
    if let crossed = crossing(id, start: start, end: end, in: context) {
      throw refuse("session-overlap", detail: ["sessionId": crossed.key.id.json])
    }
  }

  func crossing(_ id: String, start: Int64, end: Int64, in context: RuleContext) -> Row? {
    let crossed = context.storedRecords(ofType: "session").filter { session in
      guard session.isAlive, session.key.id.description != id, let finished = value(session, "finishedAt"), !finished.isNull else { return false }
      let otherStart = value(session, "startedAt")!.integerValue
      return otherStart < max(end, start + 1) && start < max(finished.integerValue, otherStart + 1)
    }
    return crossed.sorted {
      let a = value($0, "startedAt")!.integerValue
      let b = value($1, "startedAt")!.integerValue
      return a == b ? $0.key < $1.key : a < b
    }.first
  }

  func setFields(_ session: String, set: JSON) -> [String: JSON] {
    var fields: [String: JSON] = ["sessionId": .string(session), "exerciseId": set["exerciseId"]!,
      "weightKg": set["weightKg"]!, "reps": set["reps"]!, "note": set["note"] ?? "", "completedAt": set["completedAt"]!]
    fields["rpe"] = set["rpe"]
    return fields
  }

  func replayWrite(_ session: String, sets: [JSON], in context: RuleContext) -> [WriteClaim] {
    ([key("session", session)] + sets.map { key("set", $0["id"]!.stringValue!) }).compactMap {
      guard let row = context.idState(of: $0).row, row.isAlive else { return nil }
      return claim(row)
    }
  }

  func correctSession(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let id = command.string("sessionId")
    let session = try alive(key("session", id), in: context)
    let request = command.string("requestId")
    let sets = command.args["sets"]!.arrayValue
    var product = context.product
    ensureBook("corrections", scope: context.scope, in: &product)
    if let receipt = entry("corrections", request, in: context) {
      guard receipt["sessionId"] == .string(id), receipt["args"] == .object(command.args) else { throw refuse("payload-conflict") }
      return CommandOutcome(write: replayWrite(id, sets: sets, in: context), product: product)
    }
    guard !isOpen(session) else { throw refuse("session-open") }
    try checkSets(sets, command: command, correction: true, in: context)
    let standing = context.storedRecords(ofType: "set").filter { $0.isAlive && value($0, "sessionId") == .string(id) }
    let named = Set(sets.map { $0["id"]! })
    let preserve = command.args["preserveOtherSets"] == .bool(true)
    if preserve {
      for prior in standing where !named.contains(prior.key.id.json) {
        let completed = value(prior, "completedAt")!.integerValue
        guard completed >= command.args["startedAt"]!.integerValue, completed <= command.args["finishedAt"]!.integerValue else { throw refuse("bad-instant") }
        guard !sets.contains(where: { $0["exerciseId"] == value(prior, "exerciseId") && $0["setNumber"] == prior.serials["setNumber"] }) else { throw Refusal(.invalid) }
      }
    }
    let fields: [String: JSON] = ["startedAt": command.args["startedAt"]!, "finishedAt": command.args["finishedAt"]!,
      "closedBy": "finish", "displayName": command.args["routineName"]!]
    var deltas: [PlannedDelta] = [.serverUpdate(session.key, born: session.lattice.born, fields: fields)]
    var claims = [WriteClaim(key: session.key, fields: fields.keys.sorted())]
    for set in sets {
      let setKey = key("set", set["id"]!.stringValue!)
      if let prior = standing.first(where: { $0.key == setKey }) {
        guard value(prior, "exerciseId") == set["exerciseId"] else { throw Refusal(.invalid) }
        var fields = ["weightKg": set["weightKg"]!, "reps": set["reps"]!, "completedAt": set["completedAt"]!]
        fields["rpe"] = set["rpe"]
        fields["note"] = set["note"]
        var delta = PlannedDelta.serverUpdate(setKey, born: prior.lattice.born, fields: fields)
        delta.serials = ["setNumber": set["setNumber"]!]
        deltas.append(delta)
        claims.append(WriteClaim(key: setKey, fields: fields.keys.sorted()))
        continue
      }
      let fields = setFields(id, set: set)
      var delta = PlannedDelta.serverCreate(setKey, fields: fields)
      delta.serials = ["setNumber": set["setNumber"]!]
      deltas.append(delta)
      claims.append(WriteClaim(key: setKey, born: .minted, fields: fields.keys.sorted()))
    }
    if !preserve { deltas += standing.filter { !named.contains($0.key.id.json) }.map { .serverDelete($0.key, born: $0.lattice.born) } }
    store(["sessionId": .string(id), "args": .object(command.args)], table: "corrections", id: request, scope: context.scope, in: &product)
    return CommandOutcome(deltas: deltas, write: claims, product: product)
  }

  func finish(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let session = try alive(key("session", command.string("sessionId")), in: context)
    let finished = command.args["finishedAt"]!.integerValue
    guard finished > 0, finished >= value(session, "startedAt")!.integerValue else { throw refuse("bad-instant") }
    let stored = value(session, "finishedAt")
    if let stored, !stored.isNull, value(session, "closedBy") != "stale" { return CommandOutcome(product: context.product) }
    // A finish lands no earlier than the last set: a clamped future finishedAt reads serverNow, which a set stamped by a
    // clock ahead of the server can outrun.
    let landing = max(finished, lastActivity(session, in: context))
    let at = stored.flatMap { $0.isNull ? nil : $0.integerValue }.map { landing > $0 + Self.staleMs ? $0 : max($0, landing) } ?? landing
    return CommandOutcome(deltas: [.serverUpdate(session.key, born: session.lattice.born, fields: ["finishedAt": JSON(at), "closedBy": "finish"])],
      write: [WriteClaim(key: session.key, fields: ["finishedAt", "closedBy"])], product: context.product)
  }

  func applyProposal(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let id = command.string("proposalId")
    var product = context.product
    ensureBook("proposalApplies", scope: context.scope, in: &product)
    if entry("proposalApplies", id, in: context) != nil { return CommandOutcome(product: product) }
    let proposal = try alive(key("proposal", id), in: context)
    let state = proposalState(proposal)
    if state == "applied" {
      store(true, table: "proposalApplies", id: id, scope: context.scope, in: &product)
      return CommandOutcome(product: product)
    }
    try unsettled(proposal, in: context)
    let routineId = value(proposal, "routineId")!.stringValue!
    guard value(context.idState(of: key("routine", routineId)).row, "revision") == value(proposal, "baseRevision") else {
      throw refuse("proposal-superseded", detail: ["reason": "routine-changed"])
    }
    let routine = try alive(key("routine", routineId), in: context)
    store(true, table: "proposalApplies", id: id, scope: context.scope, in: &product)
    let settle = PlannedDelta.serverUpdate(proposal.key, born: proposal.lattice.born, fields: ["state": "applied", "settledAt": JSON(context.serverNow)])
    if value(proposal, "intent") == "remove" {
      return CommandOutcome(deltas: [settle, .serverDelete(routine.key, born: routine.lattice.born)], product: product)
    }
    let entries = try document(value(proposal, "changes")!.arrayValue)
    return CommandOutcome(deltas: [settle, .serverUpdate(routine.key, born: routine.lattice.born,
      fields: ["name": value(proposal, "proposedName")!, "entries": .array(entries)])],
      write: [WriteClaim(key: proposal.key, fields: ["state", "settledAt"]), WriteClaim(key: routine.key, fields: ["name", "entries"])], product: product)
  }

  func dismissProposal(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let proposal = try alive(key("proposal", command.string("proposalId")), in: context)
    if proposalState(proposal) == "dismissed" { return CommandOutcome(product: context.product) }
    try unsettled(proposal, in: context)
    return CommandOutcome(deltas: [.serverUpdate(proposal.key, born: proposal.lattice.born,
      fields: ["state": "dismissed", "settledAt": JSON(context.serverNow)])],
      write: [WriteClaim(key: proposal.key, fields: ["state", "settledAt"])], product: context.product)
  }

  func unsettled(_ proposal: Row, in context: RuleContext) throws(Refusal) {
    let state = proposalState(proposal)
    if state == "applied" || state == "dismissed" { throw refuse("proposal-settled", detail: ["state": .string(state)]) }
    guard state == "superseded" else { return }
    if let replaced = value(proposal, "supersededBy"), !replaced.isNull {
      throw refuse("proposal-superseded", detail: ["reason": "replaced"])
    }
    if value(context.idState(of: key("routine", value(proposal, "routineId")!.stringValue!)).row, "revision") != value(proposal, "baseRevision") {
      throw refuse("proposal-superseded", detail: ["reason": "routine-changed"])
    }
    throw refuse("proposal-superseded", detail: ["reason": "superseded"])
  }

  // Why a workout proposal cannot apply, first match wins: a newer proposal replaced it; its workout finished; the plan
  // moved past its base; a movement it changes has been logged since. None: it applies.
  func workoutReason(_ proposal: Row, in context: RuleContext) -> String? {
    if let replaced = value(proposal, "supersededBy"), !replaced.isNull { return "replaced" }
    guard let session = context.idState(of: key("session", value(proposal, "sessionId")?.stringValue ?? "")).row else { return "workout-finished" }
    let sets = context.storedRecords(ofType: "set")
    if closed(session, sets: sets, now: context.serverNow) { return "workout-finished" }
    if proposalState(proposal) == "superseded" || planRevision(session) != value(proposal, "baseRevision") { return "workout-changed" }
    let proposed = (try? document(value(proposal, "changes")?.arrayValue ?? [])) ?? []
    let logged = loggedMovements(sets, session: session.key.id.json)
    return changedLoggedMovement(before: value(session, "plan")?["entries"]?.arrayValue ?? [], after: proposed, logged: logged) == nil ? nil : "workout-moved"
  }

  func applyWorkoutProposal(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let id = command.string("proposalId")
    var product = context.product
    ensureBook("workoutProposalApplies", scope: context.scope, in: &product)
    if entry("workoutProposalApplies", id, in: context) != nil { return CommandOutcome(product: product) }
    let proposal = try alive(key("workoutProposal", id), in: context)
    let state = proposalState(proposal)
    if state == "applied" {
      store(true, table: "workoutProposalApplies", id: id, scope: context.scope, in: &product)
      return CommandOutcome(product: product)
    }
    if state == "dismissed" { throw refuse("proposal-settled", detail: ["state": .string(state)]) }
    if let reason = workoutReason(proposal, in: context) { throw refuse("proposal-superseded", detail: ["reason": .string(reason)]) }
    let session = try alive(key("session", value(proposal, "sessionId")?.stringValue ?? ""), in: context)
    let entries = try document(value(proposal, "changes")?.arrayValue ?? [])
    try checkLoadFloor(before: value(session, "plan")?["entries"]?.arrayValue ?? [], after: entries) {
      hasLoadFloor($0, product: context.product) { context.idState(of: $0).row }
    }
    let plan: JSON = ["routine": value(session, "plan")?["routine"] ?? .null, "entries": .array(entries)]
    store(true, table: "workoutProposalApplies", id: id, scope: context.scope, in: &product)
    return CommandOutcome(deltas: [
      .serverUpdate(proposal.key, born: proposal.lattice.born, fields: ["state": "applied", "settledAt": JSON(context.serverNow)]),
      .serverUpdate(session.key, born: session.lattice.born, fields: ["plan": plan]),
    ], write: [WriteClaim(key: proposal.key, fields: ["state", "settledAt"]), WriteClaim(key: session.key, fields: ["plan"])], product: product)
  }

  func dismissWorkoutProposal(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let proposal = try alive(key("workoutProposal", command.string("proposalId")), in: context)
    let state = proposalState(proposal)
    if state == "dismissed" { return CommandOutcome(product: context.product) }
    if state == "applied" { throw refuse("proposal-settled", detail: ["state": .string(state)]) }
    if state == "superseded" { throw refuse("proposal-superseded", detail: ["reason": .string(workoutReason(proposal, in: context) ?? "workout-changed")]) }
    return CommandOutcome(deltas: [.serverUpdate(proposal.key, born: proposal.lattice.born,
      fields: ["state": "dismissed", "settledAt": JSON(context.serverNow)])],
      write: [WriteClaim(key: proposal.key, fields: ["state", "settledAt"])], product: context.product)
  }

  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
    let metadata = ["routine": ["revision", "createdEntries"], "proposal": ["baseRevision", "baseName", "changeCount"], "note": ["updatedAt"],
                    "session": ["planRevision", "routineRevision"], "workoutProposal": ["baseRevision", "changeCount"]]
    for delta in context.deltas {
      guard delta.key.type != "routineCreation", !(metadata[delta.key.type] ?? []).contains(where: { delta.fields[$0] != nil }) else {
        throw Refusal(.invalid)
      }
    }
    var appended: [PlannedDelta] = []
    var numbered = context.storedRecords(ofType: "set")
    var staged = Dictionary(uniqueKeysWithValues: ["set", "session", "routine", "routineCreation", "proposal", "workoutProposal", "note", "exercise", "exerciseName", "thread", "message"].flatMap {
      context.records(ofType: $0)
    }.map { ($0.key, $0) })
    let newlyCreated = Set(changes.filter { $0.after.isAlive && !$0.before.isAlive }.map(\.key))
    var checkedProposals = Set<RecordKey>()
    func records(_ type: String) -> [Row] {
      staged.values.filter { $0.key.type == type }.sorted { $0.key < $1.key }
    }
    func append(_ delta: PlannedDelta) {
      appended.append(delta)
      var row = staged[delta.key] ?? Row(key: delta.key, seq: 0)
      if let life = delta.life { row.lattice.life = Life(life.state, row.lattice.life?.stamp ?? .unset) }
      for (field, register) in delta.fields {
        row.lattice.fields[field] = Register(register.value, row.lattice.fields[field]?.stamp ?? .unset)
      }
      staged[row.key] = row
    }
    func knownExercise(_ id: JSON?) -> Bool {
      guard let id = id?.stringValue else { return false }
      return context.product["seeds"]?[id] != nil || staged[key("exercise", id)]?.isAlive == true
    }
    func floored(_ id: JSON?) -> Bool {
      hasLoadFloor(id, product: context.product) { staged[$0] }
    }
    for change in changes where change.key.type == "routine" && change.after.isAlive {
      let created = !change.before.isAlive
      guard created || changed(change, field: "name") || changed(change, field: "entries") else { continue }
      var revision: Int64 = 1
      if !created {
        guard let prior = value(change.before.row, "revision"), let stored = try? prior.asInteger(), stored < 2_147_483_647 else {
          throw Refusal(.invalid)
        }
        revision = stored + 1
      }
      var fields: [String: JSON] = ["revision": JSON(revision)]
      if created { fields["createdEntries"] = JSON(value(change.after, "entries")?.arrayValue.count ?? 0) }
      append(.serverUpdate(change.key, born: change.after.lattice.born, fields: fields))
    }
    for change in changes {
      let row = change.after
      let before = change.before.row
      let created = row.isAlive && !change.before.isAlive
      switch row.key.type {
      case "set":
        if row.isAlive, let number = row.serials["setNumber"], !(1...2_147_483_647).contains(number.integerValue) { throw Refusal(.invalid) }
        if !created {
          if before != nil, context.deltas.contains(where: { $0.key == row.key && $0.fields["completedAt"] != nil }) { throw Refusal(.invalid) }
          continue
        }
        if let sessionId = value(row, "sessionId")?.stringValue,
           let session = staged[key("session", sessionId)], session.isAlive, !change.createdBy.contains(.command) {
          let finished = value(session, "finishedAt")
          if let finished, !finished.isNull {
            let completed = value(row, "completedAt")?.integerValue ?? 0
            guard value(session, "closedBy") == "stale", completed <= finished.integerValue + Self.staleMs else { throw refuse("session-finished") }
            if completed > finished.integerValue {
              append(.serverUpdate(session.key, born: session.lattice.born, fields: ["finishedAt": JSON(completed)]))
            }
          }
        }
        guard knownExercise(value(row, "exerciseId")) else { throw refuse("unknown-exercise") }
        if case .none = change.before {
          var set = row
          if set.serials["setNumber"] == nil {
            let highest = numbered.filter {
              $0.key != set.key && $0.isAlive && value($0, "sessionId") == value(set, "sessionId") && value($0, "exerciseId") == value(set, "exerciseId")
            }.compactMap { $0.serials["setNumber"]?.integerValue }.max() ?? 0
            guard highest < 2_147_483_647 else { throw Refusal(.invalid) }
            set.serials["setNumber"] = JSON(highest + 1)
          }
          numbered.append(set)
        }
      case "session":
        if created {
          guard change.createdBy.allSatisfy({ $0 == .command }) else { throw Refusal(.invalid) }
          continue
        }
        guard let before else { continue }
        // A session's death kills its sets and workout proposals.
        if change.diesHere {
          if isOpen(before), !closed(before, sets: records("set"), now: context.serverNow) { throw refuse("session-open") }
          for set in records("set") where set.isAlive && value(set, "sessionId") == row.key.id.json {
            append(.serverDelete(set.key, born: set.lattice.born))
          }
          for proposal in records("workoutProposal") where proposal.isAlive && value(proposal, "sessionId") == row.key.id.json {
            append(.serverDelete(proposal.key, born: proposal.lattice.born))
          }
          continue
        }
        guard row.isAlive else { continue }
        // A plan write is held to the plan revision rules; a net plan change, a delta's or an apply's, keeps its logged
        // movements, moves planRevision and supersedes the workout's pending proposals, every door's.
        if context.deltas.contains(where: { $0.key == row.key && $0.fields["plan"] != nil }) {
          if context.origin.isReplica,
             !context.guards.contains(where: { $0.key == row.key && $0.field == "plan" && $0.stamp == before.lattice.fields["plan"]?.stamp }) {
            throw Refusal(.invalid)
          }
          guard let prior = value(before, "plan"), !prior.isNull, let plan = value(row, "plan"), !plan.isNull, plan["routine"] == prior["routine"] else {
            throw Refusal(.invalid)
          }
          if closed(before, sets: records("set"), now: context.serverNow) { throw refuse("session-finished") }
          try checkPlanShape(before: prior["entries"]?.arrayValue ?? [], after: plan["entries"]?.arrayValue ?? [], knownExercise: knownExercise)
        }
        guard (value(before, "plan") ?? .null) != (value(row, "plan") ?? .null) else { continue }
        try checkLoggedKept(before: value(before, "plan")?["entries"]?.arrayValue ?? [], after: value(row, "plan")?["entries"]?.arrayValue ?? [],
                            session: row.key.id.json, sets: records("set"))
        guard let revision = try? planRevision(before).asInteger(), revision < 2_147_483_647 else { throw Refusal(.invalid) }
        append(.serverUpdate(row.key, born: row.lattice.born, fields: ["planRevision": JSON(revision + 1)]))
        for proposal in records("workoutProposal") where proposal.isAlive && value(proposal, "sessionId") == row.key.id.json && proposalState(proposal) == "pending" {
          append(.serverUpdate(proposal.key, born: proposal.lattice.born, fields: ["state": "superseded", "settledAt": JSON(context.serverNow)]))
        }
      case "routine":
        if change.diesHere {
          for proposal in records("proposal") where proposal.isAlive && value(proposal, "routineId") == row.key.id.json {
            append(.serverDelete(proposal.key, born: proposal.lattice.born))
          }
          for session in records("session") where session.isAlive && value(session, "routineId") == row.key.id.json {
            append(.serverUpdate(session.key, born: session.lattice.born, fields: ["routineId": .null]))
          }
          continue
        }
        guard row.isAlive else { continue }
        if blankNamed(change, field: "name") { throw Refusal(.invalid) }
        if created || changed(change, field: "entries") {
          guard let entries = value(row, "entries"), case .array(let lines) = entries, !lines.isEmpty,
                lines.allSatisfy({ $0["sets"].map { !$0.arrayValue.isEmpty } ?? true }) else { throw Refusal(.invalid) }
          guard lines.allSatisfy({ knownExercise($0["exerciseId"]) }) else { throw refuse("unknown-exercise") }
          try checkLoadFloor(before: created ? [] : value(before, "entries")?.arrayValue ?? [], after: lines, floored: floored)
        }
        if created, value(row, "createdDoor") == "ask" {
          let receipt = key("routineCreation", row.key.id.description)
          guard staged[receipt] == nil else { throw Refusal(.invalid) }
          let entries = value(row, "entries")!.arrayValue.enumerated().map { index, entry in
            var fields = entry.objectValue!
            fields["position"] = JSON(index + 1)
            return JSON.object(fields)
          }
          let snapshot: JSON = ["id": row.key.id.json, "name": value(row, "name") ?? .null,
            "position": value(row, "position") ?? 0, "revision": 1, "entries": .array(entries)]
          append(.serverUpdate(receipt, born: nil, fields: ["snapshot": snapshot]))
        }
        guard !created, changed(change, field: "name") || changed(change, field: "entries") else { continue }
        for proposal in records("proposal") {
          guard proposal.isAlive, value(proposal, "routineId") == row.key.id.json,
                proposalState(proposal) == "pending" else { continue }
          append(.serverUpdate(proposal.key, born: proposal.lattice.born, fields: ["state": "superseded", "settledAt": JSON(context.serverNow)]))
        }
      case "exercise":
        if change.diesHere { throw Refusal(.invalid) }
        if created, value(row, "stepKg") == nil { throw Refusal(.invalid) }
        if blankNamed(change, field: "name") { throw Refusal(.invalid) }
        if changed(change, field: "name"), let beforeName = value(before, "name"), let afterName = value(row, "name") {
          append(.serverUpdate(row.key, born: row.lattice.born, fields: ["aliases": renamed(value(row, "aliases"), before: beforeName, after: afterName)]))
        }
      case "exerciseName":
        guard let seed = context.product["seeds"]?[row.key.id.description] else {
          guard knownExercise(row.key.id.json), row.lattice.fields["name"] == nil else { throw Refusal(.invalid) }
          continue
        }
        if blankNamed(change, field: "name") { throw Refusal(.invalid) }
        let beforeName = value(before, "name") ?? seed["name"]!
        let afterName = value(row, "name") ?? seed["name"]!
        if beforeName != afterName {
          append(.serverUpdate(row.key, born: nil, fields: ["aliases": renamed(value(row, "aliases"), before: beforeName, after: afterName)]))
        }
      case "weighin":
        if row.isAlive, row.key.id.description > utcDay(context.serverNow + Self.dayMs) { throw refuse("bad-instant") }
      case "note":
        if blankNamed(change, field: "title") { throw Refusal(.invalid) }
        if created || changed(change, field: "title") || changed(change, field: "body") {
          append(.serverUpdate(row.key, born: row.lattice.born, fields: ["updatedAt": JSON(context.serverNow)]))
        }
      case "thread":
        if created, unset(row, "title") { throw Refusal(.invalid) }
        guard change.diesHere else { continue }
        for message in records("message") where message.isAlive && value(message, "threadId") == row.key.id.json {
          append(.serverDelete(message.key, born: message.lattice.born))
        }
        for proposal in records("proposal") + records("workoutProposal") where proposal.isAlive && value(proposal, "threadId") == row.key.id.json {
          append(.serverUpdate(proposal.key, born: proposal.lattice.born, fields: ["threadId": .null]))
        }
      case "message":
        guard row.isAlive else { continue }
        let written = Set(context.deltas.filter { $0.key == row.key }.flatMap(\.fields.keys))
        if created, unset(row, "role") || unset(row, "at") { throw Refusal(.invalid) }
        if value(row, "role") == "lifter" {
          if !written.isDisjoint(with: Self.coachRegisters) { throw Refusal(.invalid) }
          if (value(row, "text")?.stringValue ?? "").utf8.count > Self.maxQuestionBytes { throw Refusal(.invalid) }
        } else if created, unset(row, "replica") {
          throw Refusal(.invalid)
        }
        let ended = change.before.isAlive && Self.writerTerminal.contains(value(before, "state") ?? .null)
        if ended, !written.isDisjoint(with: Self.finalRegisters) { throw refuse("message-final") }
      case "proposal":
        guard created else { continue }
        if context.origin.isReplica {
          guard value(row, "door") == "ask", (value(row, "connection") ?? "") == "", (value(row, "agent") ?? "") == "" else { throw Refusal(.invalid) }
        }
        guard let routineId = value(row, "routineId")?.stringValue,
              let routine = staged[key("routine", routineId)], routine.isAlive else { throw Refusal(.unknownRecord) }
        if context.origin.isReplica {
          for field in ["entries", "name"] {
            guard context.guards.contains(where: { $0.key == routine.key && $0.field == field && $0.stamp == routine.lattice.fields[field]?.stamp }) else {
              throw Refusal(.invalid)
            }
          }
        }
        let count = try checkProposal(row, routine: routine, knownExercise: knownExercise, floored: floored)
        append(.serverUpdate(row.key, born: row.lattice.born, fields: ["baseRevision": value(routine, "revision") ?? .null,
          "baseName": value(routine, "name") ?? .null, "changeCount": JSON(count)]))
        for other in records("proposal") {
          guard (!newlyCreated.contains(other.key) || checkedProposals.contains(other.key)),
                other.key != row.key, other.isAlive, proposalState(other) == "pending",
                value(other, "routineId") == .string(routineId), value(other, "door") == value(row, "door"),
                (value(other, "connection") ?? "") == (value(row, "connection") ?? "") else { continue }
          append(.serverUpdate(other.key, born: other.lattice.born,
            fields: ["state": "superseded", "supersededBy": row.key.id.json, "settledAt": JSON(context.serverNow)]))
        }
        checkedProposals.insert(row.key)
      // A change to the open workout's plan an agent proposes (gym Coach §5 G-4): the whole plan, diffed against the plan
      // as it stands and held to the rules a lifter's own plan write is.
      case "workoutProposal":
        guard created else { continue }
        let sessionId = value(row, "sessionId")?.stringValue ?? ""
        let session = staged[key("session", sessionId)]
        if context.origin.isReplica {
          guard value(row, "door") == "ask", (value(row, "connection") ?? "") == "", (value(row, "agent") ?? "") == "" else { throw Refusal(.invalid) }
          guard context.guards.contains(where: { $0.key == key("session", sessionId) && $0.field == "plan" && $0.stamp == session?.lattice.fields["plan"]?.stamp }) else {
            throw Refusal(.invalid)
          }
        }
        guard let session, session.isAlive else { throw Refusal(.unknownRecord) }
        guard let plan = value(session, "plan"), !plan.isNull else { throw Refusal(.invalid) }
        if closed(session, sets: records("set"), now: context.serverNow) { throw refuse("session-finished") }
        let base = plan["entries"]?.arrayValue ?? []
        let lines = value(row, "changes")?.arrayValue ?? []
        let proposed = try document(lines)
        guard proposed.count <= 50, lines == diff(base, proposed) else { throw Refusal(.invalid) }
        try checkPlanShape(before: base, after: proposed, knownExercise: knownExercise)
        try checkLoggedKept(before: base, after: proposed, session: session.key.id.json, sets: records("set"))
        try checkLoadFloor(before: base, after: proposed, floored: floored)
        append(.serverUpdate(row.key, born: row.lattice.born, fields: ["baseRevision": planRevision(session), "changeCount": JSON(changeCount(base, lines))]))
        for other in records("workoutProposal") {
          guard (!newlyCreated.contains(other.key) || checkedProposals.contains(other.key)),
                other.key != row.key, other.isAlive, proposalState(other) == "pending",
                value(other, "sessionId") == .string(sessionId), value(other, "door") == value(row, "door"),
                (value(other, "connection") ?? "") == (value(row, "connection") ?? "") else { continue }
          append(.serverUpdate(other.key, born: other.lattice.born,
            fields: ["state": "superseded", "supersededBy": row.key.id.json, "settledAt": JSON(context.serverNow)]))
        }
        checkedProposals.insert(row.key)
      default: continue
      }
    }
    return appended
  }

  func checkProposal(_ proposal: Row, routine: Row, knownExercise: (JSON?) -> Bool, floored: (JSON?) -> Bool) throws(Refusal) -> Int {
    let changes = value(proposal, "changes")!.arrayValue
    let base = value(routine, "entries")!.arrayValue
    let proposed = try document(changes)
    if value(proposal, "intent") == "remove" {
      guard proposed.isEmpty else { throw Refusal(.invalid) }
    } else {
      guard !proposed.isEmpty, proposed.count <= 50,
            !isBlank(value(proposal, "proposedName")?.stringValue ?? ""),
            proposed.allSatisfy({ $0["sets"].map { !$0.arrayValue.isEmpty } ?? true }) else { throw Refusal(.invalid) }
    }
    guard changes == diff(base, proposed) else { throw Refusal(.invalid) }
    guard proposed.allSatisfy({ knownExercise($0["exerciseId"]) }) else { throw refuse("unknown-exercise") }
    try checkLoadFloor(before: base, after: proposed, floored: floored)
    return changeCount(base, changes) + (value(routine, "name") == value(proposal, "proposedName") ? 0 : 1)
  }

  // The document a diff proposes: every line but the removed ones, in order.
  func document(_ changes: [JSON]) throws(Refusal) -> [JSON] {
    var proposed: [JSON] = []
    for change in changes where change["kind"] != "removed" {
      guard var entry = change["after"]?.objectValue else { throw Refusal(.invalid) }
      entry["exerciseId"] = change["exerciseId"]
      proposed.append(.object(entry))
    }
    return proposed
  }

  // A.2's diff of a proposed document against its base: each proposed line matched to the first unmatched base line of
  // its movement, then the base lines left unmatched.
  func diff(_ base: [JSON], _ proposed: [JSON]) -> [JSON] {
    func targets(_ entry: JSON) -> JSON {
      var result = JSON.Object()
      result["sets"] = entry["sets"]
      result["restSeconds"] = entry["restSeconds"]
      return .object(result)
    }
    var matched = Set<Int>()
    var expected: [JSON] = []
    for entry in proposed {
      let index = base.indices.first { !matched.contains($0) && base[$0]["exerciseId"] == entry["exerciseId"] }
      let after = targets(entry)
      var change: JSON.Object = ["exerciseId": entry["exerciseId"] ?? .null, "after": after]
      if let index {
        matched.insert(index)
        let before = targets(base[index])
        change["before"] = before
        change["kind"] = before == after ? "kept" : "retargeted"
      } else { change["kind"] = "added" }
      expected.append(.object(change))
    }
    for index in base.indices where !matched.contains(index) {
      expected.append(["kind": "removed", "exerciseId": base[index]["exerciseId"] ?? .null, "before": targets(base[index])])
    }
    return expected
  }

  // R118's apply count of a diff: every line not kept, and one more when the kept and retargeted lines, matched to their
  // base lines in proposed order, take a base line before one already visited.
  func changeCount(_ base: [JSON], _ changes: [JSON]) -> Int {
    let count = changes.filter { $0["kind"] != "kept" }.count
    var matched = Set<Int>()
    var highest = -1
    for change in changes where change["kind"] == "kept" || change["kind"] == "retargeted" {
      guard let index = base.indices.first(where: { !matched.contains($0) && base[$0]["exerciseId"] == change["exerciseId"] }) else { continue }
      matched.insert(index)
      if index < highest { return count + 1 }
      highest = index
    }
    return count
  }

  // A.2's plan revision rules, shared by a plan write and a workout proposal: no empty set scheme, known movements, and no
  // second entry of a movement the plan held once or not at all.
  func checkPlanShape(before: [JSON], after: [JSON], knownExercise: (JSON?) -> Bool) throws(Refusal) {
    if after.contains(where: { $0["sets"].map { $0.arrayValue.isEmpty } ?? false }) { throw Refusal(.invalid) }
    guard after.allSatisfy({ knownExercise($0["exerciseId"]) }) else { throw refuse("unknown-exercise") }
    let count = { (entries: [JSON], exerciseId: JSON?) in entries.filter { $0["exerciseId"] == exerciseId }.count }
    if after.contains(where: { count(after, $0["exerciseId"]) > max(count(before, $0["exerciseId"]), 1) }) { throw Refusal(.invalid) }
  }

  // A.2's load floor over a write of targets: an entry whose sets no `before` entry of its movement holds takes its
  // movement's floor, so a scheme the write leaves as it stood keeps what it held.
  func checkLoadFloor(before: [JSON], after: [JSON], floored: (JSON?) -> Bool) throws(Refusal) {
    for entry in after {
      let held = before.contains { $0["exerciseId"] == entry["exerciseId"] && ($0["sets"] ?? .null) == (entry["sets"] ?? .null) }
      guard !held, floored(entry["exerciseId"]) else { continue }
      if (entry["sets"]?.arrayValue ?? []).contains(where: { ($0["weightKg"]?.doubleValue ?? 0) < 0 }) { throw Refusal(.invalid) }
    }
  }

  // A movement's load floor (A.2): a barbell or a pair of dumbbells carries 0 kg or more; every other loading keeps its
  // sign, an assisted machine's included. A movement the account cannot name has no floor here.
  func hasLoadFloor(_ exerciseId: JSON?, product: JSON.Object, row: (RecordKey) -> Row?) -> Bool {
    guard let id = exerciseId?.stringValue else { return false }
    let name = row(key("exerciseName", id)), seed = product["seeds"]?[id]
    let equipment = value(name, "equipment")?.stringValue ?? value(row(key("exercise", id)), "equipment")?.stringValue ?? seed?["equipment"]?.stringValue
    let loadCount = value(name, "loadCount")?.doubleValue ?? seed?["loadCount"]?.doubleValue ?? 2
    return equipment == "barbell" || (equipment == "dumbbell" && loadCount != 1)
  }

  // A.2's logged-movement rule over the intent's joined sets: a net plan change, whatever wrote it, and a workout
  // proposal's document keep every logged movement's entries.
  func checkLoggedKept(before: [JSON], after: [JSON], session: JSON, sets: [Row]) throws(Refusal) {
    if let logged = changedLoggedMovement(before: before, after: after, logged: loggedMovements(sets, session: session)) {
      throw refuse("plan-logged", detail: ["exerciseId": logged])
    }
  }

  // The movements of a session holding an alive set, among the rows given.
  func loggedMovements(_ sets: [Row], session: JSON) -> Set<JSON> {
    Set(sets.filter { $0.isAlive && value($0, "sessionId") == session }.compactMap { value($0, "exerciseId") })
  }

  // A.2's logged-movement rule: the first logged movement, in the order the two plans name movements, whose entries differ
  // between them. A movement with a logged set keeps its plan.
  func changedLoggedMovement(before: [JSON], after: [JSON], logged: Set<JSON>) -> JSON? {
    let entries = { (plan: [JSON], exerciseId: JSON) in plan.filter { $0["exerciseId"] == exerciseId } }
    return (before + after).compactMap { $0["exerciseId"] }.first { logged.contains($0) && entries(before, $0) != entries(after, $0) }
  }

  // A session that takes no plan revision: finished, or open 4 h or more past its last activity.
  func closed(_ session: Row, sets: [Row], now: Int64) -> Bool {
    if let finished = value(session, "finishedAt"), !finished.isNull { return true }
    let last = sets.filter { $0.isAlive && value($0, "sessionId") == session.key.id.json }
      .compactMap { value($0, "completedAt")?.integerValue }.max() ?? value(session, "startedAt")?.integerValue ?? 0
    return now - last >= Self.staleMs
  }

  func planRevision(_ session: Row) -> JSON {
    guard let revision = value(session, "planRevision"), !revision.isNull else { return 1 }
    return revision
  }

  func changed(_ change: RecordChange, field: String) -> Bool {
    change.after.isAlive && change.before.isAlive && value(change.before.row, field) != value(change.after, field)
  }

  func blankNamed(_ change: RecordChange, field: String) -> Bool {
    guard change.after.isAlive, let name = value(change.after, field)?.stringValue, isBlank(name) else { return false }
    return !change.before.isAlive || change.before.row?.lattice.fields[field] != change.after.lattice.fields[field]
  }

  func isBlank(_ name: String) -> Bool { name.unicodeScalars.allSatisfy(TextMerge.isWhitespace) }

  func renamed(_ aliases: JSON?, before: JSON, after: JSON) -> JSON {
    .array(Array(([before] + (aliases?.arrayValue ?? []).filter { $0 != before && $0 != after }).prefix(5)))
  }

  func staleClose(in context: RuleContext) -> [PlannedDelta] {
    guard let open = context.storedRecords(ofType: "session").first(where: isOpen),
          context.serverNow - lastActivity(open, in: context) >= Self.staleMs else { return [] }
    return [.serverUpdate(open.key, born: open.lattice.born,
      fields: ["finishedAt": JSON(lastActivity(open, in: context)), "closedBy": "stale"])]
  }

  func lastActivity(_ session: Row, in context: RuleContext) -> Int64 {
    context.storedRecords(ofType: "set").filter { $0.isAlive && value($0, "sessionId") == session.key.id.json }
      .compactMap { value($0, "completedAt")?.integerValue }.max() ?? value(session, "startedAt")?.integerValue ?? 0
  }

  func isOpen(_ session: Row) -> Bool { session.isAlive && (value(session, "finishedAt") ?? .null).isNull }
  func unset(_ row: Row, _ field: String) -> Bool { (value(row, field) ?? .null).isNull }
  func proposalState(_ proposal: Row) -> String { value(proposal, "state")?.stringValue ?? "pending" }
  func value(_ row: Row?, _ field: String) -> JSON? { row?.lattice.fields[field]?.value }
  func key(_ type: String, _ id: String) -> RecordKey { RecordKey(type, RecordID(id)) }
  func refuse(_ code: String, detail: JSON? = nil) -> Refusal { Refusal(RefusalCode(code), detail: detail) }

  func alive(_ key: RecordKey, in context: RuleContext) throws(Refusal) -> Row {
    switch context.idState(of: key) {
    case .none, .foreign: throw Refusal(.unknownRecord)
    case .dead: throw Refusal(.recordDead)
    case .alive(let row): return row
    }
  }

  func claim(_ row: Row, from: String? = nil) -> WriteClaim {
    WriteClaim(key: row.key, from: from.map { RecordID($0) }, born: row.lattice.born.map(WriteClaim.Born.stored))
  }

  func entry(_ table: String, _ id: String, in context: RuleContext) -> JSON? { context.product[table]?[context.scope.text]?[id] }

  func ensureBook(_ table: String, scope: ScopeKey, in product: inout JSON.Object) {
    var scopes = product[table]?.objectValue ?? JSON.Object()
    if scopes[scope.text] == nil { scopes[scope.text] = [:] }
    product[table] = .object(scopes)
  }

  func store(_ value: JSON?, table: String, id: String, scope: ScopeKey, in product: inout JSON.Object) {
    var scopes = product[table]?.objectValue ?? JSON.Object()
    var entries = scopes[scope.text]?.objectValue ?? JSON.Object()
    entries[id] = value
    scopes[scope.text] = .object(entries)
    product[table] = .object(scopes)
  }

  func utcDay(_ ms: Int64) -> String {
    let days = ms / Self.dayMs - (ms % Self.dayMs < 0 ? 1 : 0)
    let shifted = days + 719_468
    let era = shifted / 146_097 - (shifted % 146_097 < 0 ? 1 : 0)
    let dayOfEra = shifted - era * 146_097
    let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
    let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    let marchMonth = (5 * dayOfYear + 2) / 153
    let day = dayOfYear - (153 * marchMonth + 2) / 5 + 1
    let month = marchMonth < 10 ? marchMonth + 3 : marchMonth - 9
    let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
    let padded = { (number: Int64, width: Int) in
      let text = String(number.magnitude)
      return String(repeating: "0", count: max(0, width - text.count)) + text
    }
    let yearText = (0...9_999).contains(year) ? padded(year, 4) : (year < 0 ? "-" : "+") + padded(year, 6)
    return String("\(yearText)-\(padded(month, 2))-\(padded(day, 2))".prefix(10))
  }
}

private extension JSON {
  var stringValue: String? { try? asString() }
  var integerValue: Int64 { (try? asInteger()) ?? 0 }
  var doubleValue: Double? { try? asDouble() }
  var arrayValue: [JSON] { (try? asArray()) ?? [] }
  var objectValue: Object? { try? asObject() }
}
