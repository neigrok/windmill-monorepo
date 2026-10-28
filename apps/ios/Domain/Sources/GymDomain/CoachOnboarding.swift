import DomainKit
import SyncCore
import SyncAPI
import SyncSchema

public struct CoachRoutine: Equatable, Sendable {
  public let name: String
  public let entries: [RoutineEntry]
  public init(name: String, entries: [RoutineEntry]) { self.name = name; self.entries = entries }
}

public struct CoachRoutineImport: Equatable, Sendable {
  public let id: ID<Routine>
  public let name: String
  public let entries: [RoutineEntry]
  public init(id: ID<Routine>, name: String, entries: [RoutineEntry]) {
    self.id = id; self.name = name; self.entries = entries
  }
}

public struct CoachImportReceipt: Equatable, Sendable {
  public let resultId: String
  public let fingerprint: String
  public let routines: [ID<Routine>]
  public let movements: [ID<Exercise>]
  public var json: JSON {
    ["resultId": .string(resultId), "fingerprint": .string(fingerprint),
     "routines": .array(routines.map(\.json)), "movements": .array(movements.map(\.json))]
  }
  init(_ value: JSON) throws {
    resultId = try value.member("resultId").asString(); fingerprint = try value.member("fingerprint").asString()
    routines = try value.member("routines").asArray().map { ID(RecordID(try $0.asString())) }
    movements = try value.member("movements").asArray().map { ID(RecordID(try $0.asString())) }
  }
  init(resultId: String, fingerprint: String, routines: [ID<Routine>], movements: [ID<Exercise>]) {
    self.resultId = resultId; self.fingerprint = fingerprint; self.routines = routines; self.movements = movements
  }
}

public struct ImportCoachRoutineBatch: Action {
  public struct Loaded {
    let replica: String
    let receipt: CoachImportReceipt?
    let routines: [Routine]
    let catalogue: Catalogue
    let visibleExercises: Set<ID<Exercise>>
    let moment: Moment
  }
  public static let receiptPrefix = "rack:coachImport"
  public static func validReceiptKey(_ value: String) -> Bool {
    value.hasPrefix(receiptPrefix) && value.utf8.count == receiptPrefix.utf8.count + 48 &&
      value.utf8.dropFirst(receiptPrefix.utf8.count).allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  public let replica: String
  public let resultId: String
  public let fingerprint: String
  public let receiptKey: String
  public let routines: [CoachRoutineImport]
  public let movements: [Exercise]
  public var scope: ScopeRef { Gym.scope }
  public init(replica: String, resultId: String, fingerprint: String, receiptKey: String, routines: [CoachRoutineImport], movements: [Exercise] = []) {
    self.replica = replica; self.resultId = resultId; self.fingerprint = fingerprint; self.receiptKey = receiptKey; self.routines = routines; self.movements = movements
  }

  public func load(_ read: Reader) throws -> Loaded {
    let saved = try Self.validReceiptKey(receiptKey) ? read.device(receiptKey) : nil
    return Loaded(replica: read.replica, receipt: try saved.map(CoachImportReceipt.init),
      routines: try read.repository(Routine.self).all(in: .stored), catalogue: try Catalogue(read, in: .stored),
      visibleExercises: Set(try Catalogue(read).exercises.map(\.id)), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<CoachImportReceipt, GymRefusal> {
    guard loaded.replica == replica else {
      throw Violation(rule: "coach.import", path: "replica", reason: .custom("seatChanged"))
    }
    guard (1...128).contains(resultId.utf8.count), resultId.utf8.allSatisfy({ (33...126).contains($0) }),
          fingerprint.utf8.count == 64, fingerprint.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
      throw Violation(rule: "coach.import", path: "resultId", reason: .custom("invalidResult"))
    }
    guard Self.validReceiptKey(receiptKey) else {
      throw Violation(rule: "coach.import", path: "receiptKey", reason: .custom("invalidReceiptKey"))
    }
    if let receipt = loaded.receipt {
      guard receipt.resultId == resultId, receipt.fingerprint == fingerprint else {
        throw Violation(rule: "coach.import", path: "resultId", reason: .custom("payloadConflict"))
      }
      return .unchanged(receipt)
    }
    guard (1...3).contains(routines.count), routines.allSatisfy({ (1...6).contains($0.entries.count) && $0.entries.allSatisfy({ ($0.sets?.count ?? 0) <= 8 }) }) else {
      throw Violation(rule: "coach.import", path: "routines", reason: .custom("invalidCount"))
    }
    guard Set(routines.map(\.id)).count == routines.count, Set(movements.map(\.id)).count == movements.count else {
      throw Violation(rule: "coach.import", path: "routines", reason: .custom("duplicateIdentity"))
    }
    let included = Set(routines.flatMap(\.entries).map(\.exerciseId))
    guard movements.allSatisfy({ included.contains($0.id) }) else {
      throw Violation(rule: "coach.import", path: "movements", reason: .custom("unusedMovement"))
    }
    var plan = Plan()
    for movement in movements.sorted(by: { $0.id < $1.id }) {
      guard loaded.catalogue.find(movement.id) == nil else {
        return .refuse(GymRefusal(Refused(.idTaken, subject: movement.id.ref, path: .predicted)))
      }
      try plan.createRoutineMovement(Valid(movement, at: loaded.moment), at: loaded.moment)
    }
    let known = loaded.visibleExercises.union(movements.map(\.id))
    let firstPosition = Int64(loaded.routines.map(\.position).max() ?? -1) + 1
    for (index, routine) in routines.enumerated() {
      guard !loaded.routines.contains(where: { $0.id == routine.id }) else {
        return .refuse(GymRefusal(Refused(.idTaken, subject: routine.id.ref, path: .predicted)))
      }
      guard routine.entries.allSatisfy({ known.contains($0.exerciseId) }) else {
        return .refuse(GymRefusal(Refused(Gym.Codes.unknownExercise, subject: routine.id.ref, path: .predicted)))
      }
      let position = firstPosition + Int64(index)
      guard position <= 2_147_483_647 else {
        throw Violation(rule: "coach.import", path: "routines", reason: .custom("positionExhausted"))
      }
      plan.create(try Valid(Routine(id: routine.id, name: routine.name, position: Int(position), entries: routine.entries), at: loaded.moment))
    }
    let receipt = CoachImportReceipt(resultId: resultId, fingerprint: fingerprint, routines: routines.map(\.id), movements: movements.map(\.id))
    plan.device(receiptKey, receipt.json)
    return .write(plan, receipt)
  }
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
