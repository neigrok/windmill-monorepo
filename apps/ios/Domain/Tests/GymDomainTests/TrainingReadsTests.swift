import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct TrainingReadsTests {
  @Test func historyUsesCurrentEquipmentAndQuantityWithoutChangingRecordedSets() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let session = phone.runner.mint(Session.self)
    let exercise = ID<Exercise>("dumbbell-bench-press")
    #expect(try phone.runner.run(StartSession(id: session)).receipt != nil)
    let set = TrainingSet(id: phone.runner.mint(TrainingSet.self), sessionId: session, exerciseId: exercise,
                          weightKg: 16, reps: 8, completedAt: Instant(ms: 1_800_000_000_001))
    #expect(try phone.runner.run(AppendSet(set)).receipt != nil)
    #expect(try phone.runner.run(FinishSession(id: session, finishedAt: Instant(ms: 1_800_000_000_002))).receipt != nil)
    for (equipment, quantity, expected) in [("dumbbell", 2, 256), ("dumbbell", 1, 128), ("barbell", 1, 128), ("bodyweight", 1, 128)] {
      _ = try phone.runner.run(UpdateExercise(exercise, name: "My press", equipment: equipment, loadCount: quantity))
      let result = try phone.runner.read(Gym.scope) { read -> JSON in
        let history = try TrainingHistory(read)
        let catalog = try history.exercises().asArray()
        let movement = catalog.first { $0["id"] == exercise.json }
        return ["summary": try history.history()["summary"] ?? .null,
                "sessions": .array(try history.sessions().asArray().map { $0["tonnageKg"] ?? .null }),
                "equipment": movement?["equipment"] ?? .null, "loadCount": movement?["loadCount"] ?? .null]
      }
      #expect(result == ["summary": ["sessions": 1, "sets": 1, "reps": 8, "tonnageKg": JSON(expected)],
                         "sessions": [JSON(expected)], "equipment": .string(equipment),
                         "loadCount": equipment == "dumbbell" ? JSON(quantity) : .null])
      #expect(try phone.runner.read(Gym.scope) { try TrainingLog($0).sets } == [set])
    }
  }

  @Test func equipmentVolumeCountsExternalLoadAndPreservesEnteredEstimates() {
    let session = Session(id: ID("volume-session"), startedAt: Instant(ms: 1), finishedAt: Instant(ms: 10))
    let catalogue = Catalogue(exercises: [
      Exercise(id: ID("pair"), name: "Press", pattern: "press", equipment: "dumbbell", stepKg: 2),
      Exercise(id: ID("single"), name: "Row", pattern: "pull", equipment: "dumbbell", stepKg: 2, loadCount: 1),
      Exercise(id: ID("bar"), name: "Press", pattern: "press", equipment: "barbell", stepKg: 2.5),
      Exercise(id: ID("body"), name: "Pull up", pattern: "pull", equipment: "bodyweight", stepKg: 2.5),
    ])
    let sets = [
      TrainingSet(id: ID("pair-set"), sessionId: session.id, exerciseId: ID("pair"), weightKg: 16, reps: 10, completedAt: Instant(ms: 2)),
      TrainingSet(id: ID("single-set"), sessionId: session.id, exerciseId: ID("single"), weightKg: 16, reps: 10, completedAt: Instant(ms: 3)),
      TrainingSet(id: ID("bar-set"), sessionId: session.id, exerciseId: ID("bar"), weightKg: 32, reps: 10, completedAt: Instant(ms: 4)),
      TrainingSet(id: ID("weighted"), sessionId: session.id, exerciseId: ID("body"), weightKg: 10, reps: 5, completedAt: Instant(ms: 5)),
      TrainingSet(id: ID("assisted"), sessionId: session.id, exerciseId: ID("body"), weightKg: -10, reps: 5, completedAt: Instant(ms: 6)),
      TrainingSet(id: ID("unweighted"), sessionId: session.id, exerciseId: ID("body"), weightKg: 0, reps: 5, completedAt: Instant(ms: 7)),
    ]
    #expect(sets.map { $0.volumeKg(on: catalogue.find($0.exerciseId)) } == [320, 160, 320, 50, 0, 0])
    let readout = SessionReadout(session: session, sets: sets, catalogue: catalogue)
    #expect(readout.volumeKg == 850)
    #expect(readout.workingSetCount == 6 && readout.movementCount == 4)
    #expect(sets[0].e1rm == GymEstimate.value(weightKg: 16, reps: 10))
    #expect(SeedExercises.all.filter { $0.equipment == "dumbbell" && $0.loadCount == 1 }.map(\.id) ==
      [ID("goblet-squat"), ID("dumbbell-row"), ID("suitcase-carry"), ID("overhead-triceps-extension")])
  }

  @Test(arguments: try Contract.vectors("gym/domain/training-reads.json"))
  func vector(_ vector: Vector) throws {
    let result = try ProductCorpus(GymRules.book).read(vector, in: Session.scope) { read in
      let input = try vector.input.member("input")
      let fields = try Fields(input)
      let operation = try vector.input.member("read").asString()
      let log = try TrainingLog(read)
      switch operation {
      case "TrainingHistory":
        let history = try TrainingHistory(read)
        let args = try input.member("args").asArray()
        let query = args.first ?? [:]
        switch try fields.string("method") {
        case "exercises": return history.exercises()
        case "preferences": return try history.preferences()
        case "notes": return try history.notes()
        case "bodyweight": return try history.bodyweight()
        case "routines": return history.routines()
        case "routine": return history.routine(ID(RecordID(try query.asString())))
        case "proposals": return try history.proposals(query)
        case "proposal": return history.proposal(ID(RecordID(try query.asString())))
        case "sessions": return try history.sessions(query)
        case "session": return history.session(ID(RecordID(try query.asString())))
        case "review": return history.review(ID(RecordID(try query.asString())))
        case "history": return try history.history(query)
        case "progress": return history.progress()
        case "stats": return history.stats()
        case "lastTime": return history.lastTime(ID(RecordID(try query.asString())))
        case "lastSets": return history.lastSets()
        case "record": return history.record(ID(RecordID(try query.asString())))
        default: throw ContractError("unknown training history \(vector)")
        }
      case "GymEstimate": return .of(GymEstimate.value(weightKg: try fields.double("weightKg"), reps: try fields.int("reps"),
                                                         rpe: try fields.optionalDouble("rpe")))
      case "GymEstimateScore":
        let left = try Fields(input.member("left")), right = try Fields(input.member("right"))
        guard let a = GymEstimate.score(weightKg: try left.double("weightKg"), reps: try left.int("reps"), rpe: try left.optionalDouble("rpe")),
              let b = GymEstimate.score(weightKg: try right.double("weightKg"), reps: try right.int("reps"), rpe: try right.optionalDouble("rpe")) else { return .null }
        return JSON(a == b ? 0 : a < b ? -1 : 1)
      case "GymVolume":
        let parts = try input.member("parts").asArray().map { value in
          let fields = try Fields(value)
          return VolumePart(id: try fields.string("id"), weightKg: try fields.optionalDouble("weightKg"),
                            reps: try fields.optionalInt("reps"), loadCount: try fields.optionalInt("loadCount"))
        }
        return .of(GymVolume.total(parts))
      case "TrainingLog":
        let id = try fields.ref("sessionId", Session.self)
        return ["drawnSessions": .array(log.drawnSessions.map { $0.id.json }), "open": log.open?.id.json ?? .null,
                "liveHint": .bool(log.liveHint), "sets": .array(log.sets(session: id).map { $0.id.json }),
                "volumeKg": .of(log.volumeKg(session: id)), "topE1rm": .of(log.topE1rm(session: id))]
      case "SessionReadout":
        guard let facts = log.readout(session: try fields.ref("sessionId", Session.self)) else { return .null }
        return ["sessionId": facts.sessionId.json, "name": .of(facts.name), "durationMs": facts.durationMs.map(JSON.init) ?? .null,
                "workingSetCount": JSON(facts.workingSetCount), "movementCount": JSON(facts.movementCount), "volumeKg": .of(facts.volumeKg), "topE1rm": .of(facts.topE1rm)]
      case "LastTime":
        let last = log.lastTime(for: try fields.ref("exerciseId", Exercise.self))
        return ["sessionId": last.session?.id.json ?? .null, "routine": .of(last.routine), "sets": .array(last.sets.map { $0.id.json }), "isFirstTime": .bool(last.isFirstTime)]
      case "Prefill":
        let last = log.lastTime(for: try fields.ref("exerciseId", Exercise.self))
        let today = try fields.optionalRef("todaySessionId", Session.self).map { log.sets(session: $0).filter { $0.exerciseId == last.exerciseId } } ?? []
        let prefill = Prefill.of(todaySets: today, planEntry: try fields.optionalValue("planEntry", of: RoutineEntry.self), lastTime: last)
        return ["weightKg": .of(prefill.weightKg), "reps": JSON(prefill.reps)]
      case "RestTarget":
        guard let target = RestTarget.of(try fields.optionalValue("planEntry", of: RoutineEntry.self), rest: try restSettings(read)) else { return .null }
        return ["seconds": JSON(target.seconds), "reached": .bool(target.isReached(sinceMs: Int64(try fields.int("sinceMs"))))]
      case "StatsProgress": return log.progress.json
      case "BodyweightReps":
        let progress = log.progress.movement(try fields.ref("exerciseId", Exercise.self))
        let series = try fields.bool("window", default: false) ? progress.window(now: read.moment.now, zone: read.moment.zone) : progress
        let best = series.bodyweightReps
        return ["sessions": .array(series.sessions.map { point in
          ["sessionId": point.id.json, "mostReps": point.fact.mostReps.json,
           "bodyweightReps": point.fact.bodyweightReps?.json ?? .null]
        }), "best": best.map { ["sessionId": $0.id.json, "fact": $0.fact.bodyweightReps!.json] } ?? .null]
      case "ProgressCompleteness": return ["isComplete": .bool(log.progress.isComplete)]
      case "Consistency": return .of(log.progress.consistency(now: read.moment.now, zone: read.moment.zone))
      case "MovementProgress":
        let progress = log.progress.movement(try fields.ref("exerciseId", Exercise.self))
        let series = try fields.bool("window", default: false) ? progress.window(now: read.moment.now, zone: read.moment.zone) : progress
        return ["sessions": .array(series.sessions.map { $0.id.json }), "estimates": .array(series.estimates.map { $0.id.json }),
                "latest": series.latest?.id.json ?? .null, "best": series.best?.id.json ?? .null, "heaviest": series.heaviest?.id.json ?? .null,
                "mostReps": series.mostReps?.id.json ?? .null, "records": .array(series.records.map { $0.id.json }),
                "hasChart": .bool(series.hasChart(in: read.moment.zone)),
                "gaps": .array(series.gaps(in: read.moment.zone).map { ["before": $0.before.id.json, "after": $0.after.id.json] })]
      case "ProgressRecords":
        let records = ProgressRecords(log.progress)
        return ["movements": .object(JSON.Object(uniqueKeysWithValues: records.movements.map { id, run in
          (id.description, JSON.array(run.map { ["session": $0.point.id.json, "previous": $0.previous.id.json, "estimate": .of($0.estimate), "gain": .of($0.gain)] }))
        })), "sessions": .array(records.sessions.sorted().map(\.json))]
      case "Readout":
        switch try fields.string("operation") {
        case "weight": return .string(Readout.weight(try fields.double("value")))
        case "estimate": return .string(Readout.estimate(try fields.double("value")))
        case "target": return .string(Readout.target(try fields.optionalList("sets", of: SetTarget.self)))
        case "loadUnit": return .string(Readout.loadUnit(equipment: try fields.optionalString("equipment"), loadCount: try fields.int("loadCount")))
        case "ladder": return .string(Readout.ladder(try fields.list("sets", of: SetTarget.self)))
        case "tonnes": return .of(Readout.tonnes(try fields.double("value")))
        case "duration": return .string(Readout.duration(try fields.instant("value").ms))
        case "briefDay": return .string(Readout.briefDay(try fields.instant("value"), now: read.moment.now, zone: read.moment.zone))
        case "ago": return .string(Readout.ago(try fields.instant("value"), now: read.moment.now, zone: read.moment.zone))
        default: throw ContractError("unknown readout \(vector)")
        }
      default: throw ContractError("unknown training read \(vector)")
      }
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}
