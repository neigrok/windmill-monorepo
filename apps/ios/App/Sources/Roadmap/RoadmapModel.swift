import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncStore

// The Roadmap room's model reads the engine's views of the person's roadmaps through the domain and writes the domain's
// acts through roadmap's runner. What an act may do, what it refuses and what its Undo restores are the domain's and the kit's.
@Observable @MainActor
final class RoadmapModel {
  // The engine's live view of every record of one type in one scope as `drawn` folds it, visible or not.
  typealias Records = @MainActor (ScopeRef, String) throws -> RecordsView
  // How the room waits out a band's time.
  typealias Wait = @Sendable (Duration) async throws -> Void

  struct ViewKey: Hashable {
    let scope: ScopeRef
    let type: String
  }

  // A step as the Board draws it: the domain's step and card, the kind that names its colour, and what the room offers on it.
  struct Row: Identifiable {
    let step: RoadmapDomain.Step
    let card: BoardRead.Card
    // The kind that owns the step's hue in the roadmap's legend; none where no kind wears it.
    let kind: Kind?
    // The step's pointer opens a roadmap that stands, which the domain asks of whoever completes the step.
    let opensStanding: Bool
    // Complete is offered on an Up next step that opens no roadmap.
    let completes: Bool
    // Delete is offered on every step but the one the roadmap keeps.
    let deletes: Bool

    var id: String { step.id }
  }

  // One of the Board's groups that holds a step, with its rows in the domain's order.
  struct Group: Identifiable {
    let id: BoardRead.Column.Name
    let rows: [Row]
  }

  // The roadmap the room has open: its row in the person's list, its records as the domain reads them, and its Board.
  struct OpenRoadmap {
    let id: ID<RoadmapEntry>
    let listed: ListedRoadmap
    let tree: RoadmapTree
    let graph: FollowGraph
    let board: BoardRead
    // Up next first; a group with no step is left out.
    let groups: [Group]
    // A roadmap keeps one starting step: its one present step that follows nothing, where it has only one.
    let keptStep: String?

    // Nil for a roadmap that does not stand or is not read yet.
    init?(_ listed: ListedRoadmap, in account: RoadmapAccount) {
      guard let graph = account.graph(listed.id) else { return nil }
      let (tree, board, legend) = (graph.tree, BoardRead(graph), LegendRead(graph.tree))
      let cards = Dictionary(board.cards.map { (Array($0.id.utf8), $0) }) { first, _ in first }
      let openings = Dictionary(account.openings(of: listed.id).map { (Array($0.opening.node.utf8), $0.opening) }) { first, _ in first }
      let owners = Dictionary(legend.hues.compactMap { (hue: LegendRead.Hue) -> ([UInt8], Kind)? in
        legend.kinds.first { $0.id.utf8.elementsEqual(hue.owner.utf8) }.map { (Array(hue.name.utf8), $0) }
      }) { first, _ in first }
      let starting = graph.ids.filter { graph.followed($0).isEmpty }
      let kept = starting.count == 1 ? starting[0] : nil
      id = ID(RecordID(listed.id))
      self.listed = listed
      self.tree = tree
      self.graph = graph
      self.board = board
      keptStep = kept
      groups = [BoardRead.Column.Name.upNext, .locked, .done].compactMap { (name: BoardRead.Column.Name) -> Group? in
        let rows = (board.columns.first { $0.name == name }?.ids ?? []).compactMap { (step: String) -> Row? in
          guard let card = cards[Array(step.utf8)], let held = tree.step(step) else { return nil }
          let opening = openings[Array(step.utf8)]
          return Row(step: held, card: card, kind: owners[Array(held.color.utf8)],
                     opensStanding: opening.map { $0.kind == .pointer && account.location(of: $0.tree).standing == .standing } ?? false,
                     completes: card.column == .upNext && opening == nil,
                     deletes: kept.map { !$0.utf8.elementsEqual(step.utf8) } ?? true)
        }
        return rows.isEmpty ? nil : Group(id: name, rows: rows)
      }
    }

    var everyStepDone: Bool { board.overall.total > 0 && board.overall.done == board.overall.total }

    // The steps that follow a step, each read through it once it is gone: what the delete question says the delete costs.
    func followers(of step: String) -> Int {
      graph.ids.count { (other: String) -> Bool in
        !other.utf8.elementsEqual(step.utf8) && graph.followed(other).contains { $0.id.utf8.elementsEqual(step.utf8) }
      }
    }
  }

  // What the room shows: nothing while the phone's copy is not read yet, a roadmap, no roadmap, or a failed read.
  enum Phase {
    case unread, empty, open(OpenRoadmap), failed
  }

  // A limit the room refuses a gesture at, said where the gesture is made. Any other refusal shows nothing.
  enum Limit: Equatable {
    case keepsStartingStep, full
  }

  // The gesture a write came by, as its event names it.
  enum Door: String {
    case swipe, menu
  }

  // The one band at the room's foot: a receipt with its Undo, or a limit that refused a gesture.
  struct Band: Equatable {
    enum Says: Equatable {
      // A step completed, and the labels of the steps it brought up next.
      case completed(step: String, upNext: [String])
      case deleted(step: String)
      case refused(Limit)
    }

    // A receipt's Undo: the gesture its act wrote, whether the engine holds that act, and the act's name in the room's events.
    struct Undo: Equatable {
      let gesture: String
      let held: Bool
      let act: String
    }

    let says: Says
    let undo: Undo?
    // The steps the act brought into Up next, washed while the band stands.
    let arrived: [String]
    let lasts: Duration

    // A receipt: a removal the engine holds offers its Undo for the engine's hold, any other act for six seconds.
    init(_ says: Says, of receipt: ActReceipt, act: String, arrived: [String] = []) {
      let held = receipt.releaseAt != nil
      self.says = says
      undo = Undo(gesture: receipt.gestureId, held: held, act: act)
      self.arrived = arrived
      lasts = held ? .milliseconds(Constants.holdMs) : RoadmapModel.bandLasts
    }

    // A gesture refused at a limit.
    init(refused limit: Limit) {
      says = .refused(limit); undo = nil; arrived = []; lasts = RoadmapModel.bandLasts
    }
  }

  // The types the domain reads one roadmap from, in its tree scope and in its owner's overlay.
  static let treeTypes = [RoadmapMeta.type, RoadmapStep.type, RoadmapLink.type, RoadmapKind.type]
  static let overlayTypes = [StepMark.type, StepPointer.type]
  // Where the phone keeps the id of the roadmap last open.
  static let lastOpen = "roadmapLastOpen"
  static let bandLasts = Duration.seconds(6)

  let records: Records
  // Roadmap's runner, which holds a removal for the engine's hold.
  let runner: ActionRunner
  // What this phone remembers under any account or none.
  let phone: UserDefaults
  let telemetry: any Telemetry
  let wait: Wait
  private(set) var phase = Phase.unread
  // The person's own roadmaps, the most recent first.
  private(set) var roadmaps: [ListedRoadmap] = []
  private(set) var band: Band?
  // The Board's groups that stand folded: Done at rest, until every step is done.
  var folded: Set<BoardRead.Column.Name> = [.done]
  // Every view the room asked the engine for, kept so each stays live.
  @ObservationIgnored var views: [ViewKey: RecordsView] = [:]
  // The observation now live; one begun later ends the one before it.
  @ObservationIgnored var watch = 0
  @ObservationIgnored var reportedFailures: Set<String> = []
  @ObservationIgnored var bandTime: Task<Void, Never>?

  init(records: @escaping Records, runner: ActionRunner, phone: UserDefaults, telemetry: any Telemetry = NoopTelemetry(),
       wait: @escaping Wait = { try await Task.sleep(for: $0) }) {
    self.records = records; self.runner = runner; self.phone = phone; self.telemetry = telemetry; self.wait = wait
  }

  // The room came to the front.
  func roomOpened() {
    telemetry.event("roadmap_room_opened")
    if watch == 0 { observe() }
  }

  // Try Again on a failed read: every view is asked for anew.
  func retry() {
    views = [:]; phase = .unread
    observe()
  }

  // Reads what the views hold, and again once any of them changes.
  func observe() {
    watch += 1
    let current = watch
    do { try read() }
    catch { fail(error) }
    withObservationTracking {
      for view in views.values { _ = view.state }
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.watch == current else { return }
        self.observe()
      }
    }
  }

  // Every listed roadmap is read with its tree scope and their overlay of it; while a view has yet to load, what is shown stays.
  func read() throws {
    guard let list = try snapshot(RoadmapEntry.scope, RoadmapEntry.type) else { return }
    var trees: [RoadmapTree] = []
    var scopes: Set<ScopeRef> = [RoadmapEntry.scope]
    var loaded = true
    for listed in list.records {
      let id = ID<RoadmapEntry>(listed.id)
      scopes.formUnion([id.tree, id.overlay])
      let tree = try Self.treeTypes.compactMap { try snapshot(id.tree, $0) }
      let overlay = try Self.overlayTypes.compactMap { try snapshot(id.overlay, $0) }
      loaded = loaded && tree.count == Self.treeTypes.count && overlay.count == Self.overlayTypes.count
      guard loaded else { continue }
      trees.append(try RoadmapTree(id: id, listed: listed, tree: tree.flatMap(\.records), overlay: overlay.flatMap(\.records),
                                   read: list.firstPullComplete && (tree + overlay).allSatisfy(\.firstPullComplete)))
    }
    views = views.filter { scopes.contains($0.key.scope) }
    guard loaded else { return }
    let account = RoadmapAccount(trees)
    roadmaps = account.list()
    // The room opens the roadmap last open, else the most recent.
    let last = phone.string(forKey: Self.lastOpen) ?? ""
    guard let listed = roadmaps.first(where: { $0.id.utf8.elementsEqual(last.utf8) }) ?? roadmaps.first else {
      phase = list.firstPullComplete ? .empty : .unread
      return
    }
    guard let open = OpenRoadmap(listed, in: account) else {
      phase = .unread
      return
    }
    if !listed.id.utf8.elementsEqual(last.utf8) { phone.set(listed.id, forKey: Self.lastOpen) }
    // Done opens by itself once every step is done, and rests folded again once one is not.
    var wasDone = false
    if case .open(let shown) = phase { wasDone = shown.everyStepDone }
    if open.everyStepDone && !wasDone { folded.remove(.done) }
    if !open.everyStepDone && wasDone { folded.insert(.done) }
    phase = .open(open)
  }

  // What the view of one type in one scope holds, nil until it has loaded.
  func snapshot(_ scope: ScopeRef, _ type: String) throws -> RecordsView.Snapshot? {
    let key = ViewKey(scope: scope, type: type)
    let view = try views[key] ?? records(scope, type)
    views[key] = view
    guard case .loaded(let snapshot) = view.state else { return nil }
    return snapshot
  }

  // Each kind of failed read reports once a launch, since a read runs with every change; the engine reports a view's own.
  func fail(_ error: any Error) {
    phase = .failed
    let kind = error is DecodeError ? "decode" : "unexpected"
    guard reportedFailures.insert(kind).inserted else { return }
    telemetry.failure("roadmap_read", kind: kind)
  }

  // The room's write door: one act of the domain, run on roadmap's runner, answering what it wrote. An act the domain
  // refuses or that changes nothing answers nil; a refusal is told, and said in the band where it is a limit. A commit
  // that failed is reported and shows nothing: the phone's copy stands as it was.
  func write<A: ActAction>(_ act: A, as name: String) -> (result: A.Result, receipt: ActReceipt)? where A.Refusal == RoadmapRefusal {
    do {
      switch try runner.runAct(act) {
      case .committed(let result, let receipt): return (result, receipt)
      case .unchanged: return nil
      case .refused(let refusal):
        telemetry.event("roadmap_write_refused", properties: ["write": name, "refusal": refusal.label])
        if case .full = refusal { show(Band(refused: .full)) }
        return nil
      }
    } catch {
      report(error, write: name)
      return nil
    }
  }

  // Complete: the step's mark in the person's overlay. Its receipt names the steps it brought up next.
  func complete(_ row: Row, by door: Door) {
    guard case .open(let open) = phase else { return }
    let mark = MarkStep.complete(tree: open.id, step: ID(RecordID(row.id)), opensStanding: row.opensStanding)
    guard let written = write(mark, as: "mark") else { return }
    telemetry.event("roadmap_board_complete", properties: ["door": door.rawValue])
    let upNext = open.graph.unlocks(row.id)
    show(Band(.completed(step: row.step.label, upNext: upNext.compactMap { open.tree.step($0)?.label }), of: written.receipt,
              act: "complete", arrived: upNext))
  }

  // Delete, once its question is answered: the step alone goes, held by the engine, and its receipt keeps Undo for the hold.
  func delete(_ row: Row, by door: Door) {
    guard case .open(let open) = phase else { return }
    if let kept = open.keptStep, kept.utf8.elementsEqual(row.id.utf8) {
      telemetry.event("roadmap_write_refused", properties: ["write": "DeleteNode", "refusal": "startingStep"])
      show(Band(refused: .keepsStartingStep))
      return
    }
    guard let written = write(DeleteStep(tree: open.id, step: ID(RecordID(row.id))), as: "DeleteNode") else { return }
    telemetry.event("roadmap_board_delete", properties: ["step": "held", "door": door.rawValue, "view": "board"])
    show(Band(.deleted(step: row.step.label), of: written.receipt, act: "delete"))
  }

  // The band's Undo: a removal the engine holds is cancelled while it is held, and any other act is taken back by the
  // kit's Undo of it. The engine then keeps nothing more of the act, nor of its Undo, which the room never redoes.
  func undo() {
    guard let undo = band?.undo else { return }
    bandTime?.cancel()
    band = nil
    do {
      var taken = false
      if undo.held {
        taken = try runner.cancelHeld(undo.gesture)
      } else {
        switch try runner.undo(undo.gesture) {
        case .cancelled(_, let inverse, _), .pending(_, let inverse, _), .settled(_, let inverse, _, _, _):
          taken = true
          try runner.release(inverse)
        case .unavailable: break
        }
      }
      try runner.release(undo.gesture)
      telemetry.event("roadmap_board_undo", properties: ["act": undo.act, "outcome": taken ? "ok" : "unavailable"])
    } catch {
      report(error, write: "undo")
    }
  }

  // A band stands in place of the one showing, until its time is over.
  func show(_ band: Band) {
    endBand()
    self.band = band
    bandTime = Task { [weak self, wait] in
      guard (try? await wait(band.lasts)) != nil, !Task.isCancelled else { return }
      self?.endBand()
    }
  }

  // The band leaves with its Undo untaken: its time is over, a newer one replaces it, the person sent it away or left
  // the app. The engine keeps nothing more for an Undo no one can ask.
  func endBand() {
    bandTime?.cancel()
    let undo = band?.undo
    band = nil
    guard let undo else { return }
    do { try runner.release(undo.gesture) }
    catch { report(error, write: "release") }
  }

  // Every failed write reports under the room's one operation, with the write it was.
  func report(_ error: any Error, write name: String) {
    guard Store.failureKind(error) == nil else { return }
    telemetry.failure("roadmap_write", kind: (error as? CommitFailure)?.kind == .storeFailure ? "storage" : "unexpected", properties: ["write": name])
  }
}

extension RoadmapRefusal {
  // The refusal's kind as an event carries it, in the web's words.
  var label: String {
    switch self {
    case .invalid: "invalid"
    case .gone: "gone"
    case .taken: "taken"
    case .tooLarge: "tooLarge"
    case .full: "full"
    case .roadmapGone: "roadmapGone"
    case .unreachable: "unreachable"
    case .notARoot: "notARoot"
    case .stepOpensARoadmap: "stepOpensARoadmap"
    case .depthLimit: "depthLimit"
    case .other: "other"
    }
  }
}
