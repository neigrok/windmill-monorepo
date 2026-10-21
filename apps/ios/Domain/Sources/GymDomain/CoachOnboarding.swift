import DomainKit
import SyncCore
import SyncAPI
import SyncSchema

public struct CoachRoutine: Equatable, Sendable {
  public let name: String
  public let entries: [RoutineEntry]
  public init(name: String, entries: [RoutineEntry]) { self.name = name; self.entries = entries }
}

public struct ImportCoachRoutines: Action {
  public struct Loaded {
    let replica: String
    let receipts: JSON.Object
    let routines: [Routine]
    let moment: Moment
  }
  public static let receiptKey = "rack:coachOnboarding"
  public let replica: String
  public let requestId: String
  public let resultId: String
  public let routines: [CoachRoutine]
  public var scope: ScopeRef { Gym.scope }

  public init(replica: String, requestId: String, resultId: String, routines: [CoachRoutine]) {
    self.replica = replica; self.requestId = requestId; self.resultId = resultId; self.routines = routines
  }

  public func load(_ read: Reader) throws -> Loaded {
    Loaded(replica: read.replica,
      receipts: try read.device(Self.receiptKey)?.asObject() ?? [:],
      routines: try read.repository(Routine.self).all(in: .stored), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<[ID<Routine>], GymRefusal> {
    guard loaded.replica == replica else {
      throw Violation(rule: "coach.seat", path: "replica", reason: .custom("seatChanged"))
    }
    guard !requestId.isEmpty, requestId.utf8.count <= 64, !resultId.isEmpty, resultId.utf8.count <= 128 else {
      throw Violation(rule: "coach.result", path: "resultId", reason: .custom("invalidResult"))
    }
    if let receipt = loaded.receipts[requestId] {
      guard receipt["resultId"] == .string(resultId), case .array(let values)? = receipt["routines"],
            values.allSatisfy({ if case .string = $0 { return true }; return false }) else {
        throw Violation(rule: "coach.result", path: "resultId", reason: .custom("resultConflict"))
      }
      return .unchanged(values.compactMap { if case .string(let id) = $0 { return ID<Routine>(RecordID(id)) }; return nil })
    }
    guard (1...3).contains(routines.count) else {
      throw Violation(rule: "coach.routines", path: "routines", reason: .custom("invalidCount"))
    }
    let seeds = Set(SeedExercises.all.map(\.id))
    var plan = Plan()
    var created: [ID<Routine>] = []
    let position = (loaded.routines.map(\.position).max() ?? -1) + 1
    for (index, routine) in routines.enumerated() {
      guard (1...6).contains(routine.entries.count), routine.entries.allSatisfy({ seeds.contains($0.exerciseId) && ($0.sets?.count ?? 0) <= 8 }) else {
        throw Violation(rule: "coach.entries", path: "routines", reason: .custom("invalidEntries"))
      }
      let id = ids.mint(Routine.self)
      plan.create(try Valid(Routine(id: id, name: routine.name, position: position + index, entries: routine.entries), at: loaded.moment))
      created.append(id)
    }
    var receipts = loaded.receipts
    receipts[requestId] = ["resultId": .string(resultId), "routines": .array(created.map(\.json))]
    plan.device(Self.receiptKey, .object(receipts))
    return .write(plan, created)
  }
}
