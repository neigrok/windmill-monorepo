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
  public init(resultId: String, fingerprint: String, routines: [ID<Routine>], movements: [ID<Exercise>]) {
    self.resultId = resultId; self.fingerprint = fingerprint; self.routines = routines; self.movements = movements
  }
}

public struct ImportCoachRoutineBatch: Action {
  public struct Loaded {
    let replica: String
    let receipt: CoachImportReceipt?
    let earlierImport: [ID<Routine>]?
    let routines: [Routine]
    let catalogue: Catalogue
    let visibleExercises: Set<ID<Exercise>>
    let moment: Moment
  }
  public static let receiptPrefix = "rack:coachImport"
  // Earlier versions kept every import under this one key, a map of request id to `{resultId, routines}`.
  public static let earlierReceiptKey = "rack:coachOnboarding"
  public static func receiptKey(for resultId: String) -> String {
    receiptPrefix + SHA256Hex.of(Array(resultId.utf8)).prefix(48)
  }
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

  // A result's drafts normalized by their checks; the fingerprint hashes that payload, the receipt key the result id.
  public init(replica: String, resultId: String, drafts: [CoachRoutineImport], movements drafted: [Exercise] = [], at moment: Moment) throws(Violation) {
    var routines: [CoachRoutineImport] = []
    for draft in drafts {
      let checked = try Valid(Routine(id: draft.id, name: draft.name, entries: draft.entries), at: moment).value
      routines.append(CoachRoutineImport(id: draft.id, name: checked.name, entries: checked.entries))
    }
    var movements: [Exercise] = []
    for movement in drafted { movements.append(try Valid(movement, at: moment).value) }
    let payload: JSON = [
      "routines": .array(routines.map { ["name": .string($0.name), "entries": .array($0.entries.map(\.json))] }),
      "movements": .array(movements.sorted { $0.id < $1.id }.map {
        ["id": $0.id.json, "fields": .object(JSON.Object(uniqueKeysWithValues: $0.fields.map { ($0.key, $0.value) })), "loadCount": JSON($0.loadCount)]
      }),
    ]
    self.init(replica: replica, resultId: resultId, fingerprint: SHA256Hex.of(payload.jcs), receiptKey: Self.receiptKey(for: resultId),
              routines: routines, movements: movements)
  }

  // Engine §7.7 write map step 1 for gym: a joined routine or movement id, rewritten in every import receipt.
  public static let rewriteDeviceValue: @Sendable (String, String, JSON, String, RecordID, RecordID) -> JSON = { product, key, value, type, from, to in
    guard product == "gym", key.hasPrefix(receiptPrefix), let receipt = try? CoachImportReceipt(value) else { return value }
    switch type {
    case Gym.Types.routine:
      return CoachImportReceipt(resultId: receipt.resultId, fingerprint: receipt.fingerprint,
        routines: receipt.routines.map { $0.record == from ? ID(to) : $0 }, movements: receipt.movements).json
    case Gym.Types.exercise:
      return CoachImportReceipt(resultId: receipt.resultId, fingerprint: receipt.fingerprint,
        routines: receipt.routines, movements: receipt.movements.map { $0.record == from ? ID(to) : $0 }).json
    default:
      return value
    }
  }

  public func load(_ read: Reader) throws -> Loaded {
    let saved = try Self.validReceiptKey(receiptKey) ? read.device(receiptKey) : nil
    let earlier = try read.device(Self.earlierReceiptKey)?.asObject().members.map(\.value).first { $0["resultId"] == .string(resultId) }
    return Loaded(replica: read.replica, receipt: try saved.map(CoachImportReceipt.init),
      earlierImport: try earlier.map { try $0.member("routines").asArray().map { ID(RecordID(try $0.asString())) } },
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
    if let routines = loaded.earlierImport {
      return .unchanged(CoachImportReceipt(resultId: resultId, fingerprint: fingerprint, routines: routines, movements: []))
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
      for (line, entry) in routine.entries.enumerated() {
        guard let movement = movements.first(where: { $0.id == entry.exerciseId }) ?? loaded.catalogue.find(entry.exerciseId) else { continue }
        try RoutineRules.floored(entry.sets, of: movement, at: Path("routines") + index + "entries" + line)
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
