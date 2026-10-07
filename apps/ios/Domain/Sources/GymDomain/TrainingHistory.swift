import DomainKit
import SyncAPI
import SyncCore

public struct TrainingHistory {
  public let log: TrainingLog
  let read: Reader
  let catalogue: Catalogue
  let routineValues: [Routine]
  let proposalValues: [Proposal]
  let routineCreated: [ID<Routine>: Int64]
  let proposalCreated: [ID<Proposal>: Int64]

  public init(_ read: Reader) throws {
    self.read = read; log = try TrainingLog(read); catalogue = try Catalogue(read)
    routineValues = try read.repository(Routine.self).all(in: .drawn).filter { !$0.entries.isEmpty }
    let proposals = try read.repository(Proposal.self).all(in: .drawn)
    routineCreated = try Dictionary(uniqueKeysWithValues: routineValues.compactMap { value in
      try read.repository(Routine.self).record(value.id, in: .drawn)?.rc.map { (value.id, $0) }
    })
    let created = try Dictionary(uniqueKeysWithValues: proposals.compactMap { value in
      try read.repository(Proposal.self).record(value.id, in: .drawn)?.rc.map { (value.id, $0) }
    })
    proposalCreated = created
    proposalValues = proposals.sorted { a, b in
      let left = created[a.id] ?? 0, right = created[b.id] ?? 0
      return left == right ? b.id < a.id : left > right
    }
  }

  var finished: [Session] { log.drawnSessions.filter { !$0.isOpen } }
  static func before(_ a: String, _ b: String) -> Bool { a.utf8.lexicographicallyPrecedes(b.utf8) }

  func exerciseDocument(_ value: Exercise) -> JSON {
    .object(omittingNil: ["id": value.id.json, "name": .string(value.name), "pattern": .string(value.pattern),
      "equipment": .string(value.equipment), "stepKg": .of(value.stepKg), "custom": .bool(!SeedExercises.all.contains { $0.id == value.id }),
      "aliases": value.aliases.isEmpty ? nil : .array(value.aliases.map(JSON.string))])
  }

  public func exercises() -> JSON {
    .array(catalogue.exercises.sorted { a, b in
      if a.pattern != b.pattern { return Self.before(a.pattern, b.pattern) }
      if a.name != b.name { return Self.before(a.name, b.name) }
      return a.id < b.id
    }.map(exerciseDocument))
  }

  func sessionDocument(_ value: Session) -> JSON {
    .object(omittingNil: ["id": value.id.json, "startedAt": .of(value.startedAt), "finishedAt": value.finishedAt.map(JSON.of),
      "routineId": value.routineId?.json, "plan": value.plan?.json, "routineName": value.displayName.map(JSON.string)])
  }

  func setDocument(_ value: TrainingSet) -> JSON {
    .object(omittingNil: ["id": value.id.json, "exerciseId": value.exerciseId.json, "setNumber": value.setNumber.map(JSON.init),
      "weightKg": .of(value.weightKg), "reps": JSON(value.reps), "kind": .string(value.kind), "note": .string(value.note),
      "completedAt": .of(value.completedAt), "rpe": value.rpe.map(JSON.of)])
  }

  public func session(_ id: ID<Session>) -> JSON {
    guard let value = log.drawnSessions.first(where: { $0.id == id }) else { return .null }
    return ["session": sessionDocument(value), "sets": .array(log.sets(session: id).map(setDocument))]
  }

  static func serialOrder(_ a: TrainingSet, _ b: TrainingSet) -> Bool {
    let left = a.setNumber ?? 0, right = b.setNumber ?? 0
    return left == right ? a.id < b.id : left < right
  }

  func top(_ sets: [TrainingSet]) -> TrainingSet? {
    sets.sorted { a, b in
      if a.weightKg != b.weightKg { return a.weightKg > b.weightKg }
      if a.reps != b.reps { return a.reps > b.reps }
      return a.id < b.id
    }.first
  }

  func tonnage(_ sets: [TrainingSet]) -> Double {
    sets.filter { $0.kind == "working" }.reduce(0) { $0 + max(0, Quantum(1)!.rounded($1.weightKg * 100)) * Double($1.reps) } / 100
  }

  func summary(_ value: Session) -> JSON {
    let sets = log.sets(session: value.id), worked = log.sets(session: value.id).filter { $0.kind == "working" }
    var result = sessionDocument(value).historyFields
    result["setCount"] = JSON(sets.count); result["workingSetCount"] = JSON(worked.count)
    result["tonnageKg"] = .of(tonnage(sets))
    result["exercises"] = .array(Set(sets.compactMap { catalogue.find($0.exerciseId)?.name }).sorted(by: Self.before).map(JSON.string))
    result["record"] = .bool(worked.count >= 4 && recordFor(value) != nil); result["closedItself"] = .bool(value.closedBy.map { $0 == "stale" } ?? (value.finishedAt == SessionRules.lastActivity(value, sets: sets)))
    if let top = top(worked) { result["topSet"] = ["weightKg": .of(top.weightKg), "reps": JSON(top.reps)] }
    if let estimate = log.topE1rm(session: value.id) { result["topE1rm"] = .of(estimate) }
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  public func sessions(_ query: JSON = [:]) throws -> JSON {
    let fields = try Fields(query)
    let before = try fields.optionalInstant("before")?.ms ?? SessionRules.maxInstantMs
    let beforeId = try fields.optionalString("beforeId") ?? ""
    let count = try fields.optionalInt("limit") ?? 50
    let limit = min(200, count > 0 ? count : 50)
    return .array(log.drawnSessions.filter { $0.startedAt.ms < before || ($0.startedAt.ms == before && Self.before(beforeId, $0.id.record.string ?? "")) }.prefix(limit).map(summary))
  }

  public func lastTime(_ id: ID<Exercise>) -> JSON {
    let last = log.lastTime(for: id)
    return .object(omittingNil: ["exerciseId": id.json, "session": last.session.map(sessionDocument),
      "sets": last.session == nil ? nil : .array(last.sets.sorted(by: Self.serialOrder).map(setDocument)), "routine": last.routine.map(JSON.string)])
  }

  public func lastSets() -> JSON {
    .array(Set(finished.flatMap { log.sets(session: $0.id) }.filter { $0.kind != "warmup" }.map(\.exerciseId)).sorted().compactMap { id in
      let last = log.lastTime(for: id)
      return last.sets.sorted(by: Self.serialOrder).last.map { ["exerciseId": id.json, "weightKg": .of($0.weightKg), "reps": JSON($0.reps), "at": .of(last.session!.startedAt)] }
    })
  }

  public func progress() -> JSON { log.progress.json }

  func point(_ value: MovementProgress.Point, estimate: Bool) -> JSON {
    let fact = estimate ? value.fact.estimate!.performed : value.fact.heaviest
    let e1rm = estimate ? value.fact.estimate!.e1rm : GymEstimate.value(weightKg: fact.weightKg, reps: fact.reps, rpe: fact.rpe)
    return .object(omittingNil: ["at": .of(value.startedAt), "weightKg": .of(fact.weightKg), "reps": JSON(fact.reps), "e1rm": e1rm.map(JSON.of)])
  }

  public func record(_ id: ID<Exercise>) -> JSON {
    guard let exercise = catalogue.find(id) else { return .null }
    let series = log.progress.movement(id)
    let routines = routineValues.filter { $0.entries.contains { $0.exerciseId == id } }.sorted { $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position }
    var result: [String: JSON] = ["exercise": exerciseDocument(exercise), "sessionCount": JSON(series.sessions.count), "routineCount": JSON(routines.count)]
    if !routines.isEmpty { result["routines"] = .array(routines.map { .string($0.name) }) }
    if let best = series.best { result["bestE1rm"] = point(best, estimate: true) }
    if let heavy = series.heaviest { result["heaviest"] = point(heavy, estimate: false) }
    let window = series.window(now: read.moment.now, zone: read.moment.zone).estimates
    if !window.isEmpty { result["e1rmSeries"] = .array(window.map { point($0, estimate: true) }) }
    if !series.records.isEmpty { result["records"] = .array(series.records.reversed().map { point($0, estimate: true) }) }
    let recent = finished.filter { log.sets(session: $0.id).contains { $0.exerciseId == id && $0.kind != "warmup" } }.prefix(10)
    if !recent.isEmpty {
      result["recentDays"] = .array(recent.map { session in
        ["sessionId": session.id.json, "startedAt": .of(session.startedAt),
         "sets": .array(log.sets(session: session.id).filter { $0.exerciseId == id && $0.kind != "warmup" }.sorted(by: Self.serialOrder).map(setDocument))]
      })
    }
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  func historyWorkout(_ value: Session) -> JSON {
    let sets = log.sets(session: value.id), worked = log.sets(session: value.id).filter { $0.kind == "working" }
    var result: [String: JSON] = ["id": value.id.json, "startedAt": .of(value.startedAt), "routineName": .string(value.name ?? ""),
      "setCount": JSON(sets.count), "workingSetCount": JSON(worked.count), "reps": JSON(worked.reduce(0) { $0 + $1.reps }),
      "tonnageKg": .of(tonnage(worked))]
    if let finish = value.finishedAt { result["finishedAt"] = .of(finish) }
    if let routine = value.historyRoutineId { result["routineId"] = routine.json }
    result["sets"] = .array(sets.map { set in
      var doc = setDocument(set).historyFields; doc.removeValue(forKey: "kind"); doc.removeValue(forKey: "note")
      doc["exercise"] = .string(catalogue.find(set.exerciseId)?.name ?? ""); return .object(JSON.Object(uniqueKeysWithValues: doc.map { ($0.key, $0.value) }))
    })
    result["movements"] = .array(Set(sets.map(\.exerciseId)).sorted().map { id in
      let held = worked.filter { $0.exerciseId == id }
      return ["exerciseId": id.json, "sets": JSON(held.count), "reps": JSON(held.reduce(0) { $0 + $1.reps }), "tonnageKg": .of(tonnage(held))]
    })
    result["exerciseNames"] = .array(Set(sets.map { catalogue.find($0.exerciseId)?.name ?? "" }).sorted(by: Self.before).map(JSON.string))
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  public func history(_ query: JSON = [:]) throws -> JSON {
    let f = try Fields(query)
    let from = try f.optionalInstant("from")?.ms ?? 0, until = try f.optionalInstant("until")?.ms ?? SessionRules.maxInstantMs
    let before = try f.optionalInstant("before")?.ms ?? SessionRules.maxInstantMs, beforeId = try f.optionalString("beforeId") ?? ""
    let count = try f.optionalInt("limit") ?? 50, exercise = try f.optionalString("exercise") ?? "", routine = try f.optionalString("routine") ?? ""
    let limit = min(200, count > 0 ? count : 50)
    let scoped = finished.filter { session in
      session.startedAt.ms >= from && session.startedAt.ms < until &&
      (exercise.isEmpty || log.sets(session: session.id).contains { $0.exerciseId.record.string == exercise }) &&
      (routine.isEmpty || session.historyRoutineId?.record.string == routine)
    }
    let after = scoped.filter { $0.startedAt.ms < before || ($0.startedAt.ms == before && Self.before(beforeId, $0.id.record.string ?? "")) }
    let page = Array(after.prefix(limit)), allSets = scoped.flatMap { log.sets(session: $0.id) }
    let worked = allSets.filter { $0.kind == "working" }
    let months = Dictionary(grouping: scoped) { String(LocalDay($0.startedAt, in: read.moment.zone).text.prefix(7)) }
    let exercises: [JSON] = Set(allSets.map(\.exerciseId)).map { id in
      let known = catalogue.find(id)
      return .object(omittingNil: ["id": id.json, "name": .string(known?.name ?? ""), "equipment": known.map { .string($0.equipment) },
        "sessions": JSON(scoped.filter { log.sets(session: $0.id).contains { $0.exerciseId == id } }.count)])
    }
    let routines: [JSON] = Set(scoped.compactMap(\.historyRoutineId)).map { id in
      let held = scoped.filter { $0.historyRoutineId == id }
      return ["id": id.json, "name": .string(held.first!.name ?? ""), "sessions": JSON(held.count)]
    }
    let facetOrder = { (a: JSON, b: JSON) in
      let left = a.historyFields["name"]!.historyString, right = b.historyFields["name"]!.historyString
      return left == right ? Self.before(a.historyFields["id"]!.historyString, b.historyFields["id"]!.historyString) : Self.before(left, right)
    }
    var result: [String: JSON] = ["sessions": .array(page.map(historyWorkout)),
      "summary": ["sessions": JSON(scoped.count), "sets": JSON(worked.count), "reps": JSON(worked.reduce(0) { $0 + $1.reps }), "tonnageKg": .of(tonnage(worked))],
      "months": .array(months.keys.sorted(by: >).map { ["month": .string($0), "sessions": JSON(months[$0]!.count)] }),
      "exercises": .array(exercises.sorted(by: facetOrder)), "routines": .array(routines.sorted(by: facetOrder)), "next": .null]
    if after.count > limit, let last = page.last { result["next"] = ["before": .of(last.startedAt), "beforeId": last.id.json] }
    if try f.optionalString("projection") == "progress" { result["progress"] = StatsProgress(log: TrainingLog(sessions: scoped, sets: allSets, moment: read.moment, firstPullComplete: log.firstPullComplete)).json }
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  public func stats() -> JSON {
    let week = { (at: Instant) -> Int64 in
      let day = LocalDay(at, offsetSeconds: 0)
      return Int64(LocalDay("1970-01-01")!.days(until: day.adding(days: 1 - day.weekday))) * 86_400_000
    }
    var weeks: [JSON] = []
    if let oldest = finished.last, let newest = finished.first {
      var start = week(oldest.startedAt)
      while start <= week(newest.startedAt) {
        let held = finished.filter { week($0.startedAt) == start }
        weeks.append(["startedAt": JSON(start), "sessions": JSON(held.count), "workingSets": JSON(held.reduce(0) { sum, session in sum + log.sets(session: session.id).filter { $0.kind == "working" }.count })])
        start += 604_800_000
      }
    }
    let movements: [JSON] = Set(log.progress.sessions.flatMap { $0.movements.map(\.exerciseId) }).map { id in
      let series = log.progress.movement(id)
      return .object(omittingNil: ["exerciseId": id.json, "lastTrainedAt": .of(series.sessions.last!.startedAt),
        "points": .array(series.sessions.map { point($0, estimate: false) }), "bestE1rm": series.best.map { point($0, estimate: true) },
        "heaviest": series.heaviest.map { point($0, estimate: false) }])
    }.sorted { a, b in
      let left = a.historyFields["lastTrainedAt"]!.historyNumber, right = b.historyFields["lastTrainedAt"]!.historyNumber
      return left == right ? Self.before(a.historyFields["exerciseId"]!.historyString, b.historyFields["exerciseId"]!.historyString) : left > right
    }
    return ["weeks": .array(weeks), "movements": .array(movements)]
  }

  func proposalHead(_ value: Proposal) -> JSON {
    .object(omittingNil: ["id": value.id.json, "routineId": value.routineId.json, "intent": .string(value.intent), "state": .string(value.state),
      "summary": .string(value.summary), "createdAt": proposalCreated[value.id].map(JSON.init), "changeCount": value.changeCount.map(JSON.init), "settledAt": value.settledAt.map(JSON.of),
      "source": .object(omittingNil: ["door": .string(value.door), "connection": value.connection.isEmpty ? nil : .string(value.connection),
        "agent": value.agent.isEmpty ? nil : .string(value.agent), "thread": value.threadId.map(JSON.string)])])
  }

  public func proposals(_ query: JSON = [:]) throws -> JSON {
    let f = try Fields(query)
    let routine = try f.optionalString("routineId"), state = try f.optionalString("state")
    return .array(proposalValues.filter { (routine == nil || $0.routineId.record.string == routine) && (state != "pending" || $0.state == "pending") }.map(proposalHead))
  }

  public func proposal(_ id: ID<Proposal>) -> JSON {
    guard let value = proposalValues.first(where: { $0.id == id }) else { return .null }
    var result = proposalHead(value).historyFields
    result["name"] = .string(value.proposedName)
    result["changes"] = .array(value.changes.enumerated().map { index, change in
      var doc = change.json.historyFields; doc["position"] = JSON(index + 1)
      if change.kind == "removed" { doc["loggedSets"] = JSON(log.drawnSessions.flatMap { log.sets(session: $0.id) }.filter { $0.exerciseId == change.exerciseId }.count) }
      return .object(JSON.Object(uniqueKeysWithValues: doc.map { ($0.key, $0.value) }))
    })
    if let name = value.baseName { result["baseName"] = .string(name) }
    if let revision = value.baseRevision { result["baseRevision"] = JSON(revision) }
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  func routineDocument(_ value: Routine) -> JSON {
    .object(omittingNil: ["id": value.id.json, "name": .string(value.name), "position": JSON(value.position), "revision": value.revision.map(JSON.init),
      "entries": .array(value.entries.enumerated().map { index, entry in var doc = entry.json.historyFields; doc["position"] = JSON(index + 1); return .object(JSON.Object(uniqueKeysWithValues: doc.map { ($0.key, $0.value) })) }),
      "lastTrainedAt": log.drawnSessions.first { $0.routineId == value.id }.map { .of($0.startedAt) },
      "pendingProposal": proposalValues.first { $0.routineId == value.id && $0.state == "pending" }.map(proposalHead)])
  }

  public func routines() -> JSON {
    .array(routineValues.sorted { a, b in
      let left = log.drawnSessions.first { $0.routineId == a.id }?.startedAt.ms ?? -1, right = log.drawnSessions.first { $0.routineId == b.id }?.startedAt.ms ?? -1
      if left != right { return left > right }
      return a.position == b.position ? a.id < b.id : a.position < b.position
    }.map(routineDocument))
  }

  public func routine(_ id: ID<Routine>) -> JSON {
    guard let value = routineValues.first(where: { $0.id == id }) else { return .null }
    var result = routineDocument(value).historyFields
    var history: [JSON] = proposalValues.filter { $0.routineId == id }.prefix(20).map { .object(omittingNil: ["kind": .string("proposal"), "at": proposalCreated[$0.id].map(JSON.init), "proposal": proposalHead($0)]) }
    history.append(.object(omittingNil: ["kind": .string("created"), "at": routineCreated[id].map(JSON.init), "by": value.createdDoor.map(JSON.string), "movements": value.createdEntries.map(JSON.init)]))
    result["history"] = .array(history)
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  public func preferences() throws -> JSON {
    let value = try read.repository(GymPreferences.self).find(ID("prefs"), in: .drawn) ?? GymPreferences()
    let rest = try restSettings(read)
    var result = value.fields; result["restSeconds"] = rest.seconds.map(JSON.init) ?? .null; result["restSound"] = .bool(rest.sound)
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }

  public func notes() throws -> JSON {
    let stored = try read.repository(Note.self).all(in: .stored)
    return .array(try read.repository(Note.self).all(in: .drawn).map { note in
      .object(omittingNil: ["id": note.id.json, "title": .string(note.title), "body": .string(note.body),
        "position": stored.firstIndex { $0.id == note.id }.map(JSON.init), "updatedAt": note.updatedAt.map(JSON.of)])
    })
  }

  public func bodyweight() throws -> JSON {
    let values = try read.repository(WeighIn.self).all(in: .drawn)
    let entries: [JSON] = try Bodyweight(read).entries.map { entry in
      .object(omittingNil: ["dateLocal": .string(entry.day.text), "weightKg": .of(entry.kg), "recordedAt": values.first { $0.day == entry.day }?.recordedAt.map(JSON.of)])
    }
    return .object(omittingNil: ["entries": .array(entries), "latest": entries.last])
  }

  func recordFor(_ value: Session) -> JSON? {
    guard log.firstPullComplete else { return nil }
    let previous = finished.filter { $0.startedAt < value.startedAt || ($0.startedAt == value.startedAt && $0.id < value.id) }
    let prior = StatsProgress(log: TrainingLog(sessions: previous, sets: log.sets, moment: read.moment))
    let current = StatsProgress(log: TrainingLog(sessions: [value], sets: log.sets, moment: read.moment))
    struct Candidate {
      let rank: Int, kind: String, exercise: ID<Exercise>, fact: PerformedFact, amount: Double, before: Double, beforeAt: Instant
      var score: Double { GymEstimate.score(weightKg: fact.weightKg, reps: fact.reps, rpe: fact.rpe) ?? 0 }
    }
    var candidates: [Candidate] = []
    for fact in current.sessions.flatMap(\.movements) {
      if let now = fact.estimate, let before = prior.movement(fact.exerciseId).best, now.score > before.fact.estimate!.score {
        candidates.append(Candidate(rank: 0, kind: "e1rm", exercise: fact.exerciseId, fact: now.performed, amount: now.e1rm, before: before.fact.estimate!.e1rm, beforeAt: before.startedAt))
      }
      let today = log.sets(session: value.id).filter { $0.exerciseId == fact.exerciseId && $0.kind == "working" }
      let priors = previous.flatMap { session in log.sets(session: session.id).filter { $0.exerciseId == fact.exerciseId && $0.kind == "working" }.map { (set: $0, session: session) } }
      let heavy = priors.sorted { a, b in
        if a.set.weightKg != b.set.weightKg { return a.set.weightKg > b.set.weightKg }
        if a.set.reps != b.set.reps { return a.set.reps > b.set.reps }
        if a.session.startedAt != b.session.startedAt { return a.session.startedAt < b.session.startedAt }
        return a.set.id < b.set.id
      }.first
      if let now = top(today), let before = heavy, now.weightKg > before.set.weightKg {
        candidates.append(Candidate(rank: 1, kind: "heaviest", exercise: fact.exerciseId, fact: PerformedFact(now), amount: now.weightKg, before: before.set.weightKg, beforeAt: before.session.startedAt))
      }
      for load in Set(today.map(\.weightKg)) {
        let now = top(today.filter { $0.weightKg == load })!
        let before = priors.filter { $0.set.weightKg == load }.sorted { a, b in
          if a.set.reps != b.set.reps { return a.set.reps > b.set.reps }
          if a.session.startedAt != b.session.startedAt { return a.session.startedAt < b.session.startedAt }
          return a.set.id < b.set.id
        }.first
        if let before, now.reps > before.set.reps {
          candidates.append(Candidate(rank: 2, kind: "reps-at-weight", exercise: fact.exerciseId, fact: PerformedFact(now), amount: Double(now.reps), before: Double(before.set.reps), beforeAt: before.session.startedAt))
        }
      }
    }
    guard let best = candidates.sorted(by: { a, b in
      if a.rank != b.rank { return a.rank < b.rank }
      if a.score != b.score { return a.score > b.score }
      if a.fact.weightKg != b.fact.weightKg { return a.fact.weightKg > b.fact.weightKg }
      return a.exercise < b.exercise
    }).first else { return nil }
    return ["kind": .string(best.kind), "exerciseId": best.exercise.json, "value": .of(best.amount), "weightKg": .of(best.fact.weightKg),
      "reps": JSON(best.fact.reps), "previous": .of(best.before), "previousAt": .of(best.beforeAt)]
  }

  public func review(_ id: ID<Session>) -> JSON {
    guard let value = log.drawnSessions.first(where: { $0.id == id }), let facts = log.readout(session: id) else { return .null }
    let stats: JSON = .object(omittingNil: ["durationMs": JSON(facts.durationMs ?? max(0, SessionRules.lastActivity(value, sets: log.sets).ms - value.startedAt.ms)),
      "workingSets": JSON(facts.workingSetCount), "topE1rm": facts.topE1rm.map(JSON.of)])
    var result: [String: JSON] = ["stats": stats, "slight": .bool(facts.workingSetCount < 4)]
    guard facts.workingSetCount >= 4 else { return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) })) }
    if let record = recordFor(value) { result["record"] = record }
    guard let previous = finished.first(where: { $0.routineId == value.routineId && value.routineId != nil && ($0.startedAt < value.startedAt || ($0.startedAt == value.startedAt && $0.id < value.id)) }) else { return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) })) }
    let best = { (sets: [TrainingSet]) -> JSON? in
      top(sets).map { top in ["weightKg": .of(top.weightKg), "reps": JSON(top.reps), "sets": JSON(sets.filter { $0.weightKg == top.weightKg }.count)] }
    }
    let worked = log.sets(session: id).filter { $0.kind == "working" }
    var ids: [ID<Exercise>] = []
    for set in worked where !ids.contains(set.exerciseId) { ids.append(set.exerciseId) }
    let movements: [JSON] = ids.map { exercise in
      let plan = value.plan?.entries.first { $0.exerciseId == exercise }
      return .object(omittingNil: ["exerciseId": exercise.json, "now": best(worked.filter { $0.exerciseId == exercise }) ?? .null,
        "before": best(log.sets(session: previous.id).filter { $0.exerciseId == exercise && $0.kind == "working" }),
        "planned": plan.map { .object(omittingNil: ["sets": $0.sets.map { .array($0.map(\.json)) }]) }])
    }
    result["against"] = .object(omittingNil: ["sessionId": previous.id.json, "startedAt": .of(previous.startedAt),
      "routine": previous.plan?.routine.isEmpty == false ? previous.plan.map { .string($0.routine) } : nil, "movements": .array(movements)])
    return .object(JSON.Object(uniqueKeysWithValues: result.map { ($0.key, $0.value) }))
  }
}

private extension JSON {
  var historyFields: [String: JSON] { Dictionary(uniqueKeysWithValues: try! asObject().members.map { ($0.key, $0.value) }) }
  var historyString: String { try! asString() }
  var historyNumber: Double { try! asDouble() }
}
