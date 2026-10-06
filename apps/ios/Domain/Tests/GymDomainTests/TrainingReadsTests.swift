import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import Testing

struct TrainingReadsTests {
  @Test(arguments: try Contract.vectors("gym/domain/training-reads.json"))
  func vector(_ vector: Vector) throws {
    let result = try ProductCorpus(GymRules.book).read(vector, in: Session.scope) { read in
      let input = try vector.input.member("input")
      let fields = try Fields(input)
      let operation = try vector.input.member("read").asString()
      let log = try TrainingLog(read)
      switch operation {
      case "GymEstimate": return .of(GymEstimate.value(weightKg: try fields.double("weightKg"), reps: try fields.int("reps"),
                                                         kind: try fields.string("kind", default: "working"), rpe: try fields.optionalDouble("rpe")))
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
      case "StatsProgress": return log.progress.json
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
      case "Readout":
        switch try fields.string("operation") {
        case "estimate": return .string(Readout.estimate(try fields.double("value")))
        case "target": return .string(Readout.target(try fields.optionalList("sets", of: SetTarget.self)))
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
