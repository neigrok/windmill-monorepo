import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// Roadmap Coach §7: a proposal the person decides on the review. Apply writes its changes as the person's own act, whole or
// not at all: the device's row naming the proposal, the base and the changes checked again over the copy as it is now, and
// the folded result written one write a register, with the room's recolours first, under one gesture and one Undo across
// the roadmap's structure and the person's marks. The row is written in the act's own transaction, so a row found
// `applying` names an act that landed, and settling it makes the record `applied`, a write of its own after the act: an
// Undo in the act's hold cancels every entry of the act, and the record's state is none of them. Reject marks the record
// rejected. An Undo of an applied proposal is the kit's, and `ProposalUndone` marks the record once it took something back.

// §7 The device's own row naming a proposal it is applying, `applying:<proposal>`. Its `stamp` is null: the row is written in
// its act's own transaction, so its being there says the act landed.
public enum ApplyingRow {
  public static let prefix = "applying:"
  public static let value: JSON = ["stamp": .null]

  public static func key(_ proposal: ID<CoachProposal>) -> String { prefix + proposal.description }
}

// What a decision on a proposal reads of it: the record as the device draws it, whether the device holds the row of its
// Apply, the roadmap's pending proposal, and the moment.
public struct ProposalRead: Sendable {
  let proposal: CoachProposal?
  let applying: Bool
  let pending: CoachProposal?
  let moment: Moment

  init(_ id: ID<CoachProposal>, in account: Reader) throws {
    proposal = try account.repository(CoachProposal.self).find(id, in: .drawn)
    applying = try account.device(ApplyingRow.key(id)) != nil
    pending = try proposal?.treeId.map { try CoachProposal.pending(about: $0, in: account) } ?? nil
    moment = account.moment
  }

  // §7 Only a pending proposal moves. A proposal the device does not draw, or that names no roadmap, is gone; one whose Apply
  // has written its row is applied, and one that is not pending answers the state it stands in, nothing written; and a
  // pending one that is not its roadmap's pending one, where two devices each minted one before they synced, is replaced,
  // which the decision writes. Answers that decision, or none for a proposal the person's decision moves.
  func unmoved(_ id: ID<CoachProposal>) throws(Violation) -> ActDecision<CoachProposalState, RoadmapRefusal>? {
    guard let proposal, proposal.treeId != nil else { return .refuse(.gone(id.ref, .predicted)) }
    if applying { return .unchanged(.applied) }
    if proposal.state != .pending { return .unchanged(proposal.state) }
    if pending?.id != proposal.id { return try Self.marked(proposal, .replaced, at: moment) }
    return nil
  }

  // A proposal's record taking a terminal state, its one field, answering that state.
  static func marked(_ proposal: CoachProposal, _ state: CoachProposalState, at moment: Moment) throws(Violation) -> ActDecision<CoachProposalState, RoadmapRefusal> {
    var decided = proposal
    decided.state = state
    var plan = Plan()
    plan.update(try Valid(decided, fields: ["state"], at: moment), fields: ["state"])
    return .write(plan, in: Roadmap.scope, state)
  }
}

// One record's write in a chunk of the act's structure: its count and canonical bytes, as the import measures its units, and
// how it writes itself into the chunk's plan with its Undo.
struct RecordUnit: ChunkedUnit {
  let count = 1
  let bytes: Int
  let write: (inout Plan) throws(Violation) -> Void

  init(_ measured: JSON, _ write: @escaping (inout Plan) throws(Violation) -> Void) {
    bytes = measured.jcs.count
    self.write = write
  }
}

// §7 step 3: the act a fold's reduction writes, segment by segment, in order: the room's recolours of the kinds the copy
// holds, one command each; the structure, kinds and steps and then links, cut into chunks as an import's; the steps it
// removes, held as every step's delete is; the person's marks in their overlay; and the device's rows, the one naming the
// proposal and the landing note of its new steps and links (Roadmap on the sync engine §6).
struct AppliedAct {
  let proposal: ID<CoachProposal>
  let tree: ID<RoadmapEntry>
  let fold: ProposalFold
  let reduced: ProposalFold.Reduced
  let note: LandingNote
  let moment: Moment

  init(_ proposal: ID<CoachProposal>, of tree: ID<RoadmapEntry>, fold: ProposalFold, note: LandingNote, at moment: Moment) {
    self.proposal = proposal
    self.tree = tree
    self.fold = fold
    reduced = fold.reduced
    self.note = note
    self.moment = moment
  }

  // A kind's recolours are checked by the first alone: its Undo writes back the hue the copy holds.
  func plan() throws(Violation) -> ActPlan {
    var segments: [ScopedPlan] = []
    for (index, recolour) in reduced.recolours.enumerated() {
      let first = reduced.recolours.firstIndex { $0.kind.utf8.elementsEqual(recolour.kind.utf8) } == index
      segments.append(ScopedPlan(tree.tree, try RecolourKind.recolouring(kind(recolour.kind), to: recolour.hue, worn: recolour.wearers.map { ID(RecordID($0)) },
                                                                        in: tree, restored: true, checked: first)))
    }
    let units = reduced.kinds.map(kindUnit) + reduced.nodes.filter { $0.created || !$0.removed }.map(stepUnit) + reduced.links.map(linkUnit)
    for chunk in units.chunked() where !chunk.isEmpty {
      var plan = Plan()
      for unit in chunk { try unit.write(&plan) }
      segments.append(ScopedPlan(tree.tree, plan))
    }
    let removed = reduced.nodes.filter(\.removed)
    if !removed.isEmpty { segments.append(ScopedPlan(tree.tree, removing(removed))) }
    if !reduced.marks.isEmpty { segments.append(ScopedPlan(tree.overlay, try marking(reduced.marks))) }
    segments.append(ScopedPlan(Roadmap.scope, rows()))
    return ActPlan(segments)
  }

  // A kind and a step as the copy holds them.
  func kind(_ id: String) -> RoadmapKind {
    let held = fold.original.kinds.first { $0.id.utf8.elementsEqual(id.utf8) }
    return RoadmapKind(id: ID(RecordID(id)), hue: held?.hue ?? Roadmap.Defaults.Kind.hue, label: held?.label ?? Roadmap.Defaults.Kind.label,
                       description: held?.description ?? Roadmap.Defaults.Kind.description, ord: held.map(\.ord).flatMap { $0.isEmpty ? nil : $0 })
  }

  func step(_ id: String) -> RoadmapStep {
    let held = fold.original.step(id)
    return RoadmapStep(id: ID(RecordID(id)), label: held?.label ?? Roadmap.Defaults.Node.label, icon: held?.icon ?? Roadmap.Defaults.Node.icon,
                       color: held?.color ?? Roadmap.Defaults.Node.color, ord: held.map(\.ord).flatMap { $0.isEmpty ? nil : $0 },
                       description: held?.description ?? Roadmap.Defaults.Node.description, links: held?.links ?? [],
                       status: held.map(\.status).flatMap { $0.isEmpty ? nil : $0 }, branch: held?.branch.map { ID(RecordID($0)) })
  }

  func kindUnit(_ write: ProposalFold.Reduced.RecordWrite) -> RecordUnit {
    RecordUnit(["t": .string(RoadmapKind.type), "id": .string(write.id), "f": .object(JSON.Object(uniqueKeysWithValues: write.fields.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }))]) {
      (plan: inout Plan) throws(Violation) in
      var value = write.created ? RoadmapKind(id: ID(RecordID(write.id))) : kind(write.id)
      let before = value
      for (name, field) in write.fields {
        let text = (try? field.asString()) ?? ""
        switch name {
        case "hue": value.hue = text
        case "label": value.label = text
        case "description": value.description = text
        default: value.ord = text
        }
      }
      guard write.created else {
        plan = HeldRecord(present: before).reviving(try Valid(value, fields: Array(write.fields.keys).sorted(), at: moment), fields: Array(write.fields.keys).sorted(), into: plan)
        return
      }
      plan.create(try Valid(value, at: moment))
      plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(value.id)))
    }
  }

  // A step the act makes, with the Undo that deletes it again, but one it makes and removes, which the Undo leaves removed.
  func stepUnit(_ write: ProposalFold.Reduced.RecordWrite) -> RecordUnit {
    RecordUnit(["t": .string(RoadmapStep.type), "id": .string(write.id), "f": .object(JSON.Object(uniqueKeysWithValues: write.fields.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }))]) {
      (plan: inout Plan) throws(Violation) in
      var value = write.created ? RoadmapStep(id: ID(RecordID(write.id))) : step(write.id)
      let before = value
      for (name, field) in write.fields {
        switch name {
        case "label": value.label = (try? field.asString()) ?? ""
        case "icon": value.icon = (try? field.asString()) ?? ""
        case "color": value.color = (try? field.asString()) ?? Roadmap.Defaults.Node.color
        case "description": value.description = (try? field.asString()) ?? ""
        case "links":
          value.links = ((try? field.asArray()) ?? []).map { Step.Link(url: (try? $0.member("url").asString()) ?? "", label: (try? $0.member("label").asString()) ?? "") }
        default: value.ord = try? field.asString()
        }
      }
      guard write.created else {
        plan = HeldRecord(present: before).reviving(try Valid(value, fields: Array(write.fields.keys).sorted(), at: moment), fields: Array(write.fields.keys).sorted(), into: plan)
        return
      }
      plan.create(try Valid(value, at: moment))
      if !write.removed { plan.undoBy(.createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(value.id))) }
    }
  }

  // A link made, made alive again or removed, each with the Undo the room's own link writes take.
  func linkUnit(_ write: ProposalFold.Reduced.LinkWrite) -> RecordUnit {
    let link = RoadmapLink(from: ID(RecordID(write.from)), to: ID(RecordID(write.to)))
    return RecordUnit(["t": .string(RoadmapLink.type), "id": link.id.json]) { (plan: inout Plan) throws(Violation) in
      if write.alive { plan.create(try Valid(link, at: moment)) } else { plan.remove(link.id) }
      plan.undoBy(write.created ? .createdRecord(restoreCommand: Roadmap.Commands.restoreTree, record: .of(link.id))
                                : .restoring(link.id, life: true, by: Roadmap.Commands.restoreTree))
    }
  }

  // The steps the act removes, held, as the room's delete of a step: each the copy holds brought back by its Undo, and one the
  // act itself made left removed.
  func removing(_ removed: [ProposalFold.Reduced.RecordWrite]) -> Plan {
    var plan = Plan()
    for write in removed {
      let id = ID<RoadmapStep>(RecordID(write.id))
      plan.remove(id)
      if !write.created { plan.undoBy(.restoring(id, life: true, by: Roadmap.Commands.restoreTree)) }
    }
    return plan
  }

  // The person's marks, each written back by its Undo, as Complete and Reset write theirs.
  func marking(_ marks: [ProposalFold.Reduced.MarkWrite]) throws(Violation) -> Plan {
    var plan = Plan()
    for written in marks {
      let mark = StepMark(id: ID(RecordID(written.node)), status: written.status, outOfOrder: written.outOfOrder)
      plan.create(try Valid(mark, at: moment), fields: ["mark"])
      plan.undoBy(.restoring(mark.id, fields: ["mark"], by: Roadmap.Commands.restoreOverlay))
    }
    return plan
  }

  // The device's rows: the one naming the proposal, and the landing note taking the act's new steps and links, each link with
  // the name of the step it comes from, as the room's creates note theirs.
  func rows() -> Plan {
    var plan = Plan()
    plan.device(ApplyingRow.key(proposal), ApplyingRow.value)
    let made = reduced.nodes.filter { $0.created && !$0.removed }.map { ID<RoadmapStep>(RecordID($0.id)) }
    let linked = reduced.links.filter(\.alive).map { RoadmapLink(from: ID(RecordID($0.from)), to: ID(RecordID($0.to))) }
    guard !made.isEmpty || !linked.isEmpty else { return plan }
    let names = linked.map(\.from).unique.compactMap { (step: ID<RoadmapStep>) -> LandingNote.Name? in
      fold.tree.step(step.description).map { LandingNote.Name(id: step, name: $0.label) }
    }
    plan.note(note.adding(nodes: made, edges: linked, names: names), of: tree)
    return plan
  }
}

// §7 Apply, pressed by the person on the review: only a pending proposal moves; the roadmap must be the person's own and held
// whole; a base that moved, or changes that no longer fold over the copy as it is now, mark the proposal `stale` and write
// nothing to the roadmap; otherwise the act. It answers the state the proposal stands in, `applied` for the act, whose
// receipt carries its Undo. It reads the proposal's roadmap and the roadmaps that roadmap's reading reaches, none else.
public struct ApplyProposal: ActAction {
  public struct Loaded {
    let found: ProposalRead
    let standing: StandingRoadmaps?
    let note: LandingNote?
  }

  public let proposal: ID<CoachProposal>

  public init(_ proposal: ID<CoachProposal>) {
    self.proposal = proposal
  }

  public func load(_ read: ActReader) throws -> Loaded {
    let found = try read.inScope(Roadmap.scope) { try ProposalRead(proposal, in: $0) }
    guard let treeId = found.proposal?.treeId else { return Loaded(found: found, standing: nil, note: nil) }
    let tree = ID<RoadmapEntry>(RecordID(treeId))
    let note = try read.inScope(tree.tree) { (scope: Reader) throws -> LandingNote in try LandingNote(settledOver: DrawnSteps(of: tree, in: scope), in: scope) }
    return Loaded(found: found, standing: try StandingRoadmaps(reaching: treeId, reading: read), note: note)
  }

  public func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<CoachProposalState, RoadmapRefusal> {
    if let still = try loaded.found.unmoved(proposal) { return still }
    guard let pending = loaded.found.proposal, let treeId = pending.treeId, let standing = loaded.standing, let note = loaded.note else {
      return .refuse(.gone(proposal.ref, .predicted))
    }
    let tree = ID<RoadmapEntry>(RecordID(treeId))
    do throws(CoachRefusal) {
      guard try standing.open(treeId, about: treeId).tree.own else { return .refuse(.gone(tree.ref, .predicted)) }
    } catch {
      guard error.code == .roadmapUnavailable else { return .refuse(.gone(tree.ref, .predicted)) }
      return .refuse(RoadmapRefusal(Refused("roadmap-unavailable", subject: tree.ref, path: .predicted)))
    }
    if ProposalFold.baseMoved(pending.base, over: standing, treeId: treeId) { return try ProposalRead.marked(pending, .stale, at: loaded.found.moment) }
    guard case .success(let fold) = ProposalFold.over(standing, treeId: treeId, changes: pending.changes) else {
      return try ProposalRead.marked(pending, .stale, at: loaded.found.moment)
    }
    return .write(try AppliedAct(proposal, of: tree, fold: fold, note: note, at: loaded.found.moment).plan(), .applied)
  }
}

// §7 A row found `applying`, after a crash or written by another tab, is settled by its act, which landed with it: its
// proposal becomes `applied`, which outranks a state another device wrote meanwhile, and the row goes, with every other row
// found. It answers the proposals whose rows it settled, in id order.
public struct SettleApplying: ActAction {
  public init() {}

  public func load(_ read: ActReader) throws -> (rows: [(key: String, id: ID<CoachProposal>, proposal: CoachProposal?)], moment: Moment) {
    try read.inScope(Roadmap.scope) { account in
      let keys = try account.devices(prefix: ApplyingRow.prefix).members.map(\.key).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
      let rows = try keys.map { (key: String) throws -> (key: String, id: ID<CoachProposal>, proposal: CoachProposal?) in
        let id = ID<CoachProposal>(RecordID(String(key.dropFirst(ApplyingRow.prefix.count))))
        return (key, id, try account.repository(CoachProposal.self).find(id, in: .drawn))
      }
      return (rows, account.moment)
    }
  }

  public func decide(_ loaded: (rows: [(key: String, id: ID<CoachProposal>, proposal: CoachProposal?)], moment: Moment), ids: ActIDSource) throws(Violation)
    -> ActDecision<[ID<CoachProposal>], RoadmapRefusal> {
    guard !loaded.rows.isEmpty else { return .unchanged([]) }
    var plan = Plan()
    for row in loaded.rows {
      if var applied = row.proposal, applied.state != .applied {
        applied.state = .applied
        plan.update(try Valid(applied, fields: ["state"], at: loaded.moment), fields: ["state"])
      }
      plan.device(row.key, nil)
    }
    return .write(plan, in: Roadmap.scope, loaded.rows.map(\.id))
  }
}

// §7 Reject, on the card or the review: a pending proposal becomes `rejected`, and nothing is written to the roadmap.
public struct RejectProposal: ActAction {
  public let proposal: ID<CoachProposal>

  public init(_ proposal: ID<CoachProposal>) {
    self.proposal = proposal
  }

  public func load(_ read: ActReader) throws -> ProposalRead {
    try read.inScope(Roadmap.scope) { try ProposalRead(proposal, in: $0) }
  }

  public func decide(_ found: ProposalRead, ids: ActIDSource) throws(Violation) -> ActDecision<CoachProposalState, RoadmapRefusal> {
    if let still = try found.unmoved(proposal) { return still }
    guard let pending = found.proposal else { return .refuse(.gone(proposal.ref, .predicted)) }
    return try ProposalRead.marked(pending, .rejected, at: found.moment)
  }
}

// What an Undo came to as the device draws it: `undone` where it took something back, cancelled in its hold, drawn while it
// waits for the server or settled; `skipped` where it took nothing back; `unavailable` where there was none to ask.
public enum UndoOutcome: String, Sendable {
  case undone, skipped, unavailable

  public init(_ result: InverseResult) {
    switch result {
    case .unavailable: self = .unavailable
    case .cancelled(_, _, let changed): self = changed ? .undone : .skipped
    case .pending(_, _, let localChanged): self = localChanged ? .undone : .skipped
    case .settled(_, _, _, let appliedCount, _): self = appliedCount > 0 ? .undone : .skipped
    }
  }
}

// §7 step 5: an applied proposal undone. The kit's Undo of its act takes it back; this marks the record `undone` once that
// Undo took something back as the device draws it, so an undone proposal is not offered again, and a card never says Undone
// of changes that stand. It answers what the Undo came to, as `roadmap_proposal_undone` tells it.
public struct ProposalUndone: ActAction {
  public let proposal: ID<CoachProposal>
  public let outcome: UndoOutcome

  public init(_ proposal: ID<CoachProposal>, undo: InverseResult) {
    self.proposal = proposal
    outcome = UndoOutcome(undo)
  }

  public func load(_ read: ActReader) throws -> (proposal: CoachProposal?, moment: Moment) {
    try read.inScope(Roadmap.scope) { (try $0.repository(CoachProposal.self).find(proposal, in: .drawn), $0.moment) }
  }

  public func decide(_ loaded: (proposal: CoachProposal?, moment: Moment), ids: ActIDSource) throws(Violation) -> ActDecision<UndoOutcome, RoadmapRefusal> {
    guard var undone = loaded.proposal else { return .refuse(.gone(proposal.ref, .predicted)) }
    guard outcome == .undone, undone.state == .applied, !undone.undone else { return .unchanged(outcome) }
    undone.undone = true
    var plan = Plan()
    plan.update(try Valid(undone, fields: ["undone"], at: loaded.moment), fields: ["undone"])
    return .write(plan, in: Roadmap.scope, outcome)
  }
}
