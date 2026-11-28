import DomainKit
import SyncAPI
import SyncCore

// Roadmap Coach §6, INV-2: the tool host over the phone's copy. A call runs in one task with no suspension in it: it reads
// the standing roadmap as the room shows it now (D-2), decides through the ability, and hands the write at once to the
// room's act runner, the door every gesture of the room goes through, which decides each act again over the copy as it
// commits. So no change the room shows comes between the check and the write, and the write is saved, sent, merged and
// refused as the person's own. The door then says what it wrote: an act it refused is `roadmap-not-ready`, one that
// changed nothing `no-change`, never a success, and such a write leaves nothing to undo. A write that landed answers with
// its receipt (D-4), which carries its act's Undo as the runner handed it out. The iPhone's room keeps no stack of Undos, so
// a structure act, a mark and a new subtask alike keep theirs here, off the room's band, which offers a receipt's Undo
// where the conversation shows it.
//
// A call tells no product event and reports nothing: the turn's engine tells each call it runs and reports, once, anything
// that throws out of one, the standing roadmap's read, the ability or the door, a write the phone could not store among
// them (§13). An Undo runs outside a turn, so the host tells what each came to, and what an Undo throws reaches its caller,
// whose wiring reports it under the room's own write-failure operation (§13).

// D-4: one direct write, for the conversation's receipt: the ability, the roadmap and the step it wrote, and the Undo of
// its act, the handle the room's act runner answered with the checks its plans named, held in this process's memory.
public struct WriteReceipt: Equatable, Sendable {
  // What an Undo came to once the engine settled it: the write taken back, `skipped` where a later write stood in its way,
  // or `unavailable` where the engine no longer holds the write or a check its act named refuses what stands.
  public enum Undo: String, Sendable {
    case undone, skipped, unavailable
  }

  public let ability: String
  public let treeId: String
  public let nodeId: String
  let undo: UndoHandle
}

public final class RoadmapToolHost {
  // An Undo the engine still settles: the receipt it takes back, and the request the engine answers.
  struct Settling {
    let receipt: WriteReceipt
    let request: String
  }

  let runner: ActionRunner
  let about: String?
  let standing: () throws -> StandingRoadmaps
  let told: (_ receipt: WriteReceipt, _ undo: WriteReceipt.Undo) -> Void
  // Each act the host keeps the engine holding: a landed write's, until its Undo is asked or its receipt forgotten, and an
  // Undo's own, until the engine has settled it.
  var held: [String] = []
  var settling: [Settling] = []

  // `runner` is the room's act runner over the phone's copy; `about` the roadmap the conversation is about, none for all of
  // the person's; `standing` reads the standing roadmap, by default the copy's through the runner; and `told` hears what
  // each Undo came to, by the receipt it takes back.
  public init(runner: ActionRunner, about: String?, standing: (() throws -> StandingRoadmaps)? = nil,
              told: @escaping (_ receipt: WriteReceipt, _ undo: WriteReceipt.Undo) -> Void) {
    self.runner = runner
    self.about = about
    self.standing = standing ?? { try StandingRoadmaps(reading: runner) }
    self.told = told
  }

  // One call of an ability the catalog runs on the copy: the answer the model reads, what it read or wrote or the refusal,
  // and, for a write that landed, its receipt. An input outside the ability's schema never reaches it.
  public func run(_ name: String, _ input: JSON) throws -> (answer: Result<JSON, CoachRefusal>, receipt: WriteReceipt?) {
    guard let ability = Catalog.roadmap.ability(named: name), ability.agent == .runs, RoadmapAbilities.names.contains(name) else {
      preconditionFailure("the tool host runs no \(name)")
    }
    guard JSONSchema(ability.input).fault(in: input) == nil else { return (.failure(CoachRefusal(.invalidInput)), nil) }
    switch RoadmapAbilities.answer(name, input, over: try standing(), about: about, ids: mintStep) {
    case .result(let read): return (.success(read), nil)
    case .refused(let refusal): return (.failure(refusal), nil)
    case .writes(let acts, let result):
      let named = try input.text(ifAny: "nodeId")
      switch try runner.runComposed(acts.map(\.part)) {
      case .committed(_, let committed):
        hold(committed.undo.actId)
        let receipt = WriteReceipt(ability: name, treeId: try input.text("treeId"), nodeId: try result.text(ifAny: "nodeId") ?? named ?? "",
                                   undo: committed.undo)
        return (.success(result), receipt)
      case .unchanged: return (.failure(CoachRefusal(.noChange, named)), nil)
      case .refused: return (.failure(CoachRefusal(.roadmapNotReady, named)), nil)
      }
    }
  }

  // Takes back one direct write by the kit's Undo of its act, asked with the receipt's handle and so with every check the
  // act's plans named, which spares anything written since: a later write of the same field, the person's change of an item
  // it added, or a mark the person set since; a completion's first date is not restored. One a check refuses where it is
  // asked takes nothing back and is unavailable, as the room's own Undo is. What it came to is told once the engine has
  // settled it: at once, or as the copy changes (`follow`). An Undo asked again while the engine settles the first asks
  // nothing.
  public func undo(_ receipt: WriteReceipt) throws {
    guard !settling.contains(where: { $0.receipt == receipt }) else { return }
    try settle(receipt, try runner.undo(receipt.undo))
    try letGo(receipt.undo.actId)
  }

  // The copy changed: each Undo the engine has settled since it was asked is told. One the host could not finish stays to
  // be told, and an act it could not let go of stays held.
  public func follow() throws {
    for each in settling {
      let result = try runner.inverseResult(each.request)
      if case .pending = result { continue }
      settling.removeAll { $0.receipt == each.receipt }
      try settle(each.receipt, result)
    }
  }

  // A receipt whose Undo is offered no longer: the engine keeps nothing more of its act.
  public func forget(_ receipt: WriteReceipt) throws {
    try letGo(receipt.undo.actId)
  }

  // The conversation is over: the engine keeps nothing more of any act the host holds, and an Undo it still settles is
  // told no more.
  public func close() throws {
    settling = []
    for act in held { try letGo(act) }
  }

  // An Undo the engine answered: one it still settles waits, its own act held until it has, as the engine forgets an Undo
  // whose act it let go of; one it settled is told first, and its act let go of last.
  func settle(_ receipt: WriteReceipt, _ result: InverseResult) throws {
    let finish = { (undo: WriteReceipt.Undo, inverse: String) throws in
      self.told(receipt, undo)
      self.hold(inverse)
      try self.letGo(inverse)
    }
    switch result {
    case .unavailable: told(receipt, .unavailable)
    case .pending(let request, let inverse, _):
      hold(inverse)
      settling.append(Settling(receipt: receipt, request: request))
    case .cancelled(_, let inverse, let changed): try finish(changed ? .undone : .skipped, inverse)
    case .settled(_, let inverse, _, let applied, _): try finish(applied > 0 ? .undone : .skipped, inverse)
    }
  }

  func hold(_ act: String) {
    if !held.contains(act) { held.append(act) }
  }

  // Lets the engine forget an act; one it could not let go of stays held, for `close`.
  func letGo(_ act: String) throws {
    try runner.release(act)
    held.removeAll { $0 == act }
  }

  // §6 rule 6: a new step's id, minted as the room's controls mint one, from the engine's source, in the conversation's
  // roadmap, the one a direct write may name.
  func mintStep() -> String {
    guard let about else { preconditionFailure("a direct write names the conversation's roadmap") }
    return runner.mint(RoadmapStep.self, in: ID<RoadmapEntry>(RecordID(about)).tree).description
  }
}
