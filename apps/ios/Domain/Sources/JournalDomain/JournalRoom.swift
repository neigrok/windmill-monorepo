import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct RetireJournalInvitation: Action {
  public typealias Refusal = JournalRefusal
  public let scope = Journal.scope
  public let field: String
  public init(_ field: String) { self.field = field }
  public func load(_ read: Reader) throws -> JournalWriteState { try JournalWriteState(read, day: read.moment.today) }
  public func decide(_ loaded: JournalWriteState, ids: IDSource) throws(Violation) -> Decision<Void, JournalRefusal> {
    guard loaded.state.fields[field] != nil else { throw Violation(rule: "journalState", path: Path(field), reason: .custom("unknownState")) }
    var plan = Plan()
    if var pending = loaded.pending.first(where: { $0.day == loaded.moment.today }) {
      pending.retirements[field] = "retired"; plan.device(pending.key, pending.json)
    } else {
      try JournalWriting.retire([field: "retired"], in: &plan, at: loaded.moment)
    }
    return .write(plan)
  }
}

public struct JournalRoom: Sendable {
  public enum Stance: Sendable { case unknown, empty, holding }
  public enum Backup: Sendable { case savedHere, pending, backedUp, refused }
  public struct Day: Sendable {
    public let day: LocalDay
    public let document: PageDocument
    public let backup: Backup
  }
  public let stance: Stance
  public let days: [Day]
  public let state: JournalState
  public let firstRunKnown: Bool
  public let isAnonymous: Bool
  public var scaleInvitationDue: Bool { firstRunKnown && state.scaleInvitationDue }
  public var keepDue: Bool { isAnonymous && firstRunKnown && state.keepDue }

  public init(_ read: Reader) throws {
    let complete = try read.firstPullComplete()
    isAnonymous = read.isAnonymous; firstRunKnown = isAnonymous || complete
    var state = try read.repository(JournalState.self).find(ID(RecordID("journalState")), in: .drawn) ?? JournalState()
    let stored = try read.repository(Page.self).all(in: .stored)
    stance = stored.isEmpty ? (firstRunKnown ? .empty : .unknown) : .holding
    let pages = try read.repository(Page.self).all(in: .drawn)
    var byDay: [LocalDay: Day] = [:]
    for page in pages {
      guard let day = page.id.day, page.document.isWritten else { continue }
      let record = try read.repository(Page.self).record(page.id, in: .drawn)
      let clean = complete && record?.isPending == false
      byDay[day] = Day(day: day, document: page.document, backup: isAnonymous ? .savedHere : clean ? .backedUp : .pending)
    }
    for (_, value) in try read.devices(prefix: "pendingClaim:").members {
      let pending = try PendingClaim(json: value)
      if pending.latest.isWritten {
        byDay[pending.day] = Day(day: pending.day, document: pending.latest, backup: pending.refusal == nil ? .savedHere : .refused)
      } else { byDay[pending.day] = nil }
      let retirements = pending.retirements
      if retirements["placeholder"] == "retired" { state.placeholder = "retired" }
      if retirements["privacyLine"] == "retired" { state.privacyLine = "retired" }
      if retirements["firstPage"] == "retired" { state.firstPage = "retired" }
      if retirements["scales"] == "retired" { state.scales = "retired" }
    }
    self.state = state
    days = byDay.values.sorted { $0.day < $1.day }
  }
}
