import SyncCore

public struct GymServerRules: ServerRules {
  static let staleMs: Int64 = 14_400_000
  static let dayMs: Int64 = 86_400_000

  public init() {}

  public func elsewhere(_ key: RecordKey, product: JSON.Object) -> Bool {
    key.type == "exercise" && product["seeds"]?[key.id.description] != nil
  }

  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
    switch command.name {
    case "gym.start": entry("starts", command.string("id"), in: context) != nil
    case "gym.importSession": entry("imports", command.string("id"), in: context) != nil
    case "gym.correctSession": entry("corrections", command.string("requestId"), in: context) != nil
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

  func sessionFields(_ command: CheckedCommand, in context: RuleContext) -> [String: JSON] {
    var fields: [String: JSON] = ["startedAt": command.args["startedAt"]!]
    if let id = command.args["routineId"]?.stringValue {
      let routine = context.idState(of: key("routine", id)).row
      let readable = routine?.isAlive == true
      fields["routineId"] = readable ? .string(id) : .null
      fields["plan"] = readable ? .object(["routine": value(routine, "name") ?? .null, "entries": value(routine, "entries") ?? .null]) : .null
      if readable { fields["historyRoutineId"] = .string(id) }
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
      "weightKg": set["weightKg"]!, "reps": set["reps"]!, "kind": set["kind"] ?? "working",
      "note": set["note"] ?? "", "completedAt": set["completedAt"]!]
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
      var fields = setFields(id, set: set)
      fields["kind"] = "working"
      var delta = PlannedDelta.serverCreate(setKey, fields: fields)
      delta.serials = ["setNumber": set["setNumber"]!]
      deltas.append(delta)
      claims.append(WriteClaim(key: setKey, born: .minted, fields: fields.keys.sorted()))
    }
    let named = Set(sets.map { $0["id"]! })
    deltas += standing.filter { !named.contains($0.key.id.json) }.map { .serverDelete($0.key, born: $0.lattice.born) }
    store(["sessionId": .string(id), "args": .object(command.args)], table: "corrections", id: request, scope: context.scope, in: &product)
    return CommandOutcome(deltas: deltas, write: claims, product: product)
  }

  func finish(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let session = try alive(key("session", command.string("sessionId")), in: context)
    let finished = command.args["finishedAt"]!.integerValue
    guard finished > 0, finished >= value(session, "startedAt")!.integerValue else { throw refuse("bad-instant") }
    let stored = value(session, "finishedAt")
    if let stored, !stored.isNull, value(session, "closedBy") != "stale" { return CommandOutcome(product: context.product) }
    let at = stored.flatMap { $0.isNull ? nil : $0.integerValue }.map { finished > $0 + Self.staleMs ? $0 : max($0, finished) } ?? finished
    return CommandOutcome(deltas: [.serverUpdate(session.key, born: session.lattice.born, fields: ["finishedAt": JSON(at), "closedBy": "finish"])],
      write: [WriteClaim(key: session.key, fields: ["finishedAt", "closedBy"])], product: context.product)
  }

  func applyProposal(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let proposal = try alive(key("proposal", command.string("proposalId")), in: context)
    let state = proposalState(proposal)
    if state == "applied" { return CommandOutcome(product: context.product) }
    try unsettled(proposal, in: context)
    let routineId = value(proposal, "routineId")!.stringValue!
    guard value(context.idState(of: key("routine", routineId)).row, "revision") == value(proposal, "baseRevision") else {
      throw refuse("proposal-superseded", detail: ["reason": "routine-changed"])
    }
    let routine = try alive(key("routine", routineId), in: context)
    let settle = PlannedDelta.serverUpdate(proposal.key, born: proposal.lattice.born, fields: ["state": "applied", "settledAt": JSON(context.serverNow)])
    if value(proposal, "intent") == "remove" {
      return CommandOutcome(deltas: [settle, .serverDelete(routine.key, born: routine.lattice.born)], product: context.product)
    }
    let entries = value(proposal, "changes")!.arrayValue.filter { $0["kind"] != "removed" }.map { change in
      var fields = change["after"]?.objectValue ?? JSON.Object()
      fields["exerciseId"] = change["exerciseId"]
      return JSON.object(fields)
    }
    return CommandOutcome(deltas: [settle, .serverUpdate(routine.key, born: routine.lattice.born,
      fields: ["name": value(proposal, "proposedName")!, "entries": .array(entries)])],
      write: [WriteClaim(key: proposal.key, fields: ["state", "settledAt"]), WriteClaim(key: routine.key, fields: ["name", "entries"])], product: context.product)
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

  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
    let metadata = ["routine": ["revision", "createdEntries"], "proposal": ["baseRevision", "baseName", "changeCount"], "note": ["updatedAt"]]
    for delta in context.deltas {
      guard delta.key.type != "routineCreation", !(metadata[delta.key.type] ?? []).contains(where: { delta.fields[$0] != nil }) else {
        throw Refusal(.invalid)
      }
    }
    var appended: [PlannedDelta] = []
    var numbered = context.storedRecords(ofType: "set")
    var staged = Dictionary(uniqueKeysWithValues: ["set", "session", "routine", "routineCreation", "proposal", "note", "exercise", "exerciseName"].flatMap {
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
        guard change.diesHere, let before else { continue }
        let last = records("set").filter { $0.isAlive && value($0, "sessionId") == row.key.id.json }
          .compactMap { value($0, "completedAt")?.integerValue }.max() ?? value(before, "startedAt")?.integerValue ?? 0
        if isOpen(before), context.serverNow - last < Self.staleMs { throw refuse("session-open") }
        for set in records("set") where set.isAlive && value(set, "sessionId") == row.key.id.json {
          append(.serverDelete(set.key, born: set.lattice.born))
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
        guard let seed = context.product["seeds"]?[row.key.id.description] else { throw Refusal(.invalid) }
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
        let count = try checkProposal(row, routine: routine, knownExercise: knownExercise)
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
      default: continue
      }
    }
    return appended
  }

  func checkProposal(_ proposal: Row, routine: Row, knownExercise: (JSON?) -> Bool) throws(Refusal) -> Int {
    let changes = value(proposal, "changes")!.arrayValue
    let base = value(routine, "entries")!.arrayValue
    var proposed: [JSON] = []
    for change in changes where change["kind"] != "removed" {
      guard var entry = change["after"]?.objectValue else { throw Refusal(.invalid) }
      entry["exerciseId"] = change["exerciseId"]
      proposed.append(.object(entry))
    }
    if value(proposal, "intent") == "remove" {
      guard proposed.isEmpty else { throw Refusal(.invalid) }
    } else {
      guard !proposed.isEmpty, proposed.count <= 50,
            !isBlank(value(proposal, "proposedName")?.stringValue ?? ""),
            proposed.allSatisfy({ $0["sets"].map { !$0.arrayValue.isEmpty } ?? true }) else { throw Refusal(.invalid) }
    }
    func targets(_ entry: JSON) -> JSON {
      var result = JSON.Object()
      result["sets"] = entry["sets"]
      result["restSeconds"] = entry["restSeconds"]
      return .object(result)
    }
    var matched = Set<Int>()
    var expected: [JSON] = []
    var highest = -1
    var reordered = false
    for entry in proposed {
      let index = base.indices.first { !matched.contains($0) && base[$0]["exerciseId"] == entry["exerciseId"] }
      let after = targets(entry)
      var change: JSON.Object = ["exerciseId": entry["exerciseId"]!, "after": after]
      if let index {
        matched.insert(index)
        if index < highest { reordered = true }
        highest = max(highest, index)
        let before = targets(base[index])
        change["before"] = before
        change["kind"] = before == after ? "kept" : "retargeted"
      } else { change["kind"] = "added" }
      expected.append(.object(change))
    }
    for index in base.indices where !matched.contains(index) {
      expected.append(["kind": "removed", "exerciseId": base[index]["exerciseId"]!, "before": targets(base[index])])
    }
    guard changes == expected else { throw Refusal(.invalid) }
    guard proposed.allSatisfy({ knownExercise($0["exerciseId"]) }) else { throw refuse("unknown-exercise") }
    return changes.filter { $0["kind"] != "kept" }.count
      + (value(routine, "name") == value(proposal, "proposedName") ? 0 : 1) + (reordered ? 1 : 0)
  }

  func changed(_ change: RecordChange, field: String) -> Bool {
    change.after.isAlive && change.before.isAlive && value(change.before.row, field) != value(change.after, field)
  }

  func blankNamed(_ change: RecordChange, field: String) -> Bool {
    guard let name = value(change.after, field)?.stringValue, isBlank(name) else { return false }
    return (change.after.isAlive && !change.before.isAlive) || changed(change, field: field)
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
  var arrayValue: [JSON] { (try? asArray()) ?? [] }
  var objectValue: Object? { try? asObject() }
}
