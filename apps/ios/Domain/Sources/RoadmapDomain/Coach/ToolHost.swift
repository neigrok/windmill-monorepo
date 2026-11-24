import DomainKit
import SyncAPI
import SyncCore

// Roadmap Coach §6, INV-2: the tool host over the phone's copy. A call runs in one task with no suspension in it: it reads
// the standing roadmap as the room shows it now (D-2), decides through the ability, and hands the write at once to the
// room's act runner, the door every gesture of the room goes through, which decides each act again over the copy as it
// commits. So no change the room shows comes between the check and the write, and the write is saved, sent, merged and
// refused as the person's own. The door then says what it wrote: an act it refused is `roadmap-not-ready`, one that
// changed nothing `no-change`, never a success, and such a write leaves nothing to undo. A write that landed answers with
// its receipt (D-4), which carries its Undo. The iPhone's room keeps no stack of Undos, so a structure act, a mark and a
// new subtask alike keep theirs here, off the room's band, which offers a receipt's Undo where the conversation shows it.
//
// A call tells no product event and reports nothing: the turn's engine tells each call it runs and reports, once, anything
// that throws out of one, the standing roadmap's read, the ability or the door (§13). An Undo runs outside a turn, so the
// host tells what each came to.

// D-4: one direct write, for the conversation's receipt: the ability, the roadmap and the step it wrote, and the act its
// Undo takes back, held in this process's memory.
public struct WriteReceipt: Equatable, Sendable {
  // What an Undo came to once the engine settled it: the write taken back, `skipped` where a later write stood in its way,
  // or `unavailable` where the engine no longer holds the write.
  public enum Undo: String, Sendable {
    case undone, skipped, unavailable
  }

  public let ability: String
  public let treeId: String
  public let nodeId: String
  let act: String
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
  let told: (WriteReceipt, WriteReceipt.Undo) -> Void
  var settling: [Settling] = []

  // `runner` is the room's act runner over the phone's copy; `about` the roadmap the conversation is about, none for all of
  // the person's; `standing` reads the standing roadmap, by default the copy's through the runner; and `told` hears what
  // each Undo came to.
  public init(runner: ActionRunner, about: String?, standing: (() throws -> StandingRoadmaps)? = nil,
              told: @escaping (WriteReceipt, WriteReceipt.Undo) -> Void) {
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
      case .committed(_, let act):
        let receipt = WriteReceipt(ability: name, treeId: try input.text("treeId"), nodeId: try result.text(ifAny: "nodeId") ?? named ?? "",
                                   act: act.gestureId)
        return (.success(result), receipt)
      case .unchanged: return (.failure(CoachRefusal(.noChange, named)), nil)
      case .refused: return (.failure(CoachRefusal(.roadmapNotReady, named)), nil)
      }
    }
  }

  // Takes back one direct write by the kit's Undo of its act, which spares anything written since: a later write of the
  // same field, the person's change of an item it added, or a mark the person set since; a completion's first date is not
  // restored. What it came to is told once the engine has settled it: at once, or as the copy changes (`follow`).
  public func undo(_ receipt: WriteReceipt) throws {
    let asked = try runner.undo(receipt.act)
    try runner.release(receipt.act)
    try settle(receipt, asked)
  }

  // The copy changed: each Undo the engine has settled since it was asked is told.
  public func follow() throws {
    let waiting = settling
    settling = []
    for each in waiting { try settle(each.receipt, runner.inverseResult(each.request)) }
  }

  // A receipt whose Undo is offered no longer: the engine keeps nothing more of its act.
  public func forget(_ receipt: WriteReceipt) throws {
    try runner.release(receipt.act)
  }

  // An Undo the engine answered: one it still settles waits, its act kept until it has, as the engine forgets an Undo whose
  // act it let go of; one it settled is told and let go of.
  func settle(_ receipt: WriteReceipt, _ result: InverseResult) throws {
    switch result {
    case .pending(let request, _, _):
      settling.append(Settling(receipt: receipt, request: request))
    case .cancelled(_, let inverse, let changed):
      try runner.release(inverse)
      told(receipt, changed ? .undone : .skipped)
    case .settled(_, let inverse, _, let applied, _):
      try runner.release(inverse)
      told(receipt, applied > 0 ? .undone : .skipped)
    case .unavailable:
      told(receipt, .unavailable)
    }
  }

  // §6 rule 6: a new step's id, minted as the room's controls mint one, from the engine's source, in the conversation's
  // roadmap, the one a direct write may name.
  func mintStep() -> String {
    guard let about else { preconditionFailure("a direct write names the conversation's roadmap") }
    return runner.mint(RoadmapStep.self, in: ID<RoadmapEntry>(RecordID(about)).tree).description
  }
}
