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

  // A step as the room shows it wherever it stands, on its Board row, on its own page and on a row of another step's
  // page: the domain's step and card, the kind that names its colour, and what the room offers on it.
  struct Row: Identifiable {
    let step: RoadmapDomain.Step
    let card: BoardRead.Card
    // The kind that owns the step's hue in the roadmap's legend; none where no kind wears it.
    let kind: Kind?
    // The step's pointer opens a roadmap that stands, which the domain asks of whoever completes the step.
    let opensStanding: Bool
    // Complete is offered on an Up next step that opens no roadmap, and Reset on a Done one.
    let completes: Bool
    let resets: Bool
    // Delete is offered on every step but the one the roadmap keeps.
    let deletes: Bool

    var id: String { step.id }
  }

  // One of the Board's groups that holds a step, with its rows in the domain's order.
  struct Group: Identifiable {
    let id: BoardRead.Column.Name
    let rows: [Row]
  }

  // A step on its own page: its row, and the rows of the steps it requires and of the steps it opens, each in the
  // roadmap's order.
  struct OpenStep {
    let row: Row
    let requires: [Row]
    let opens: [Row]
    // The steps it opened that stand Up next: Reset returns each to Locked, and the ones already done stay Done.
    let relocks: Int
  }

  // A screen on the room's stack over the Board: All Roadmaps, or a step's page with the row that opened it as its
  // event names it, a Board row, the web's card, or a row of another step's page.
  enum Visit: Hashable {
    enum Door: String {
      case card, step
    }

    case roadmaps
    case step(String, by: Door)
  }

  // The roadmap the room has open: its row in the person's list, its records as the domain reads them, and its Board.
  struct OpenRoadmap {
    let id: ID<RoadmapEntry>
    let listed: ListedRoadmap
    let tree: RoadmapTree
    let graph: FollowGraph
    let board: BoardRead
    // Every step by its id: the one row its Board group, its own page and a row of another step's page all show.
    let rows: [[UInt8]: Row]
    // Up next first; a group with no step is left out.
    let groups: [Group]
    // The steps that follow each step, read through any step that is gone, in the roadmap's order.
    let followers: [[UInt8]: [String]]
    // A roadmap keeps one starting step: its one present step that follows nothing, where it has only one.
    let keptStep: String?

    // Nil for a roadmap that does not stand or is not read yet.
    init?(_ listed: ListedRoadmap, in account: RoadmapAccount) {
      guard let graph = account.graph(listed.id) else { return nil }
      let (tree, board, legend) = (graph.tree, BoardRead(graph), LegendRead(graph.tree))
      let openings = Dictionary(account.openings(of: listed.id).map { (Array($0.opening.node.utf8), $0.opening) }) { first, _ in first }
      let owners = Dictionary(legend.hues.compactMap { (hue: LegendRead.Hue) -> ([UInt8], Kind)? in
        legend.kinds.first { $0.id.utf8.elementsEqual(hue.owner.utf8) }.map { (Array(hue.name.utf8), $0) }
      }) { first, _ in first }
      var followers: [[UInt8]: [String]] = [:]
      var starting: [String] = []
      for step in graph.ids {
        let followed = graph.followed(step)
        if followed.isEmpty { starting.append(step) }
        for prerequisite in followed { followers[Array(prerequisite.id.utf8), default: []].append(step) }
      }
      let kept = starting.count == 1 ? starting[0] : nil
      let rows = Dictionary(board.cards.compactMap { (card: BoardRead.Card) -> ([UInt8], Row)? in
        guard let held = tree.step(card.id) else { return nil }
        let opening = openings[Array(card.id.utf8)]
        return (Array(card.id.utf8), Row(
          step: held, card: card, kind: owners[Array(held.color.utf8)],
          opensStanding: opening.map { $0.kind == .pointer && account.location(of: $0.tree).standing == .standing } ?? false,
          completes: card.column == .upNext && opening == nil, resets: card.column == .done && opening == nil,
          deletes: kept.map { !$0.utf8.elementsEqual(card.id.utf8) } ?? true))
      }) { first, _ in first }
      id = ID(RecordID(listed.id))
      self.listed = listed
      self.tree = tree
      self.graph = graph
      self.board = board
      self.rows = rows
      self.followers = followers
      keptStep = kept
      groups = [BoardRead.Column.Name.upNext, .locked, .done].compactMap { (name: BoardRead.Column.Name) -> Group? in
        let held = (board.columns.first { $0.name == name }?.ids ?? []).compactMap { (step: String) -> Row? in rows[Array(step.utf8)] }
        return held.isEmpty ? nil : Group(id: name, rows: held)
      }
    }

    var everyStepDone: Bool { board.overall.total > 0 && board.overall.done == board.overall.total }

    func step(_ id: String) -> Row? { rows[Array(id.utf8)] }

    // How many steps follow a step, each read through it once it is gone: what the delete question says the delete costs.
    func followers(of step: String) -> Int { followers[Array(step.utf8)]?.count ?? 0 }

    // A step's page; none for a step the roadmap does not hold.
    func page(of step: String) -> OpenStep? {
      guard let row = self.step(step) else { return nil }
      let opens = (followers[Array(step.utf8)] ?? []).compactMap { (follower: String) -> Row? in self.step(follower) }
      return OpenStep(row: row, requires: graph.followed(step).compactMap { (followed: Followed) -> Row? in self.step(followed.id) },
                      opens: opens, relocks: row.resets ? opens.count { $0.card.column == .upNext } : 0)
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

  // The gesture a write to a step came by, as its event names it: a Board row's swipe or its long-press menu, the
  // step's page, or the form that edits the step.
  enum Door: String {
    case swipe, menu, page, form
  }

  // What the write door answers: what an act wrote with its receipt, nothing where it changed nothing, the domain's
  // refusal, or a commit that failed.
  enum Written<Result> {
    case committed(Result, ActReceipt)
    case unchanged
    case refused(RoadmapRefusal)
    case failed

    var committed: (result: Result, receipt: ActReceipt)? {
      guard case .committed(let result, let receipt) = self else { return nil }
      return (result, receipt)
    }
  }

  // Where a gesture on a roadmap is made, as its event names it: the title menu, All Roadmaps, or the room that holds
  // no roadmap.
  enum Place: String {
    case menu, list, empty
  }

  // What else a roadmap's delete takes: the server deletes each step of the person's other roadmaps whose pointer opens
  // it. The steps are counted, and the roadmaps that hold them named as each is known, a roadmap a step owns by that
  // step: those the list holds first, in its order.
  struct Openers: Equatable {
    let steps: Int
    let roadmaps: [String?]
  }

  // The question a delete asks before anything is written, standing where it was asked.
  enum Question {
    // A step's, on its Board row or on its page: the step, the gesture that asked, and how many steps follow the
    // step, which is what the delete costs.
    case step(Row, by: Door, followers: Int)
    // A roadmap's, under the title whose menu asked or on its row in All Roadmaps: the roadmap, and what else goes.
    case roadmap(ListedRoadmap, from: Place, openers: Openers?)
  }

  // The one band at the room's foot: a receipt with its Undo, or a limit that refused a gesture.
  struct Band: Equatable {
    enum Says: Equatable {
      // A step completed, the labels of the steps it brought up next, and whether it was completed in place, on its
      // own page, which names it already.
      case completed(step: String, upNext: [String], inPlace: Bool)
      // A step reset, and how many steps it returned to Locked.
      case reset(step: String, locked: Int)
      case deleted(step: String)
      // A step the form made, and the group it landed in.
      case created(step: String, in: BoardRead.Column.Name)
      // A step the form saved a change to.
      case saved(step: String)
      // A roadmap deleted, by its title.
      case deletedRoadmap(String?)
      case refused(Limit)
    }

    // A receipt's Undo: the gesture its act wrote, whether the engine holds that act, and the act it takes back.
    struct Undo: Equatable {
      // A step's act, by its name in the room's events, or a roadmap's delete, with the roadmap where the room had it
      // open, which its Undo opens again.
      enum Act: Equatable {
        case step(String)
        case roadmapDelete(reopens: String?)
      }

      let gesture: String
      let held: Bool
      let act: Act
    }

    let says: Says
    let undo: Undo?
    // The steps the act brought to where they stand, washed while the band stands: those a completion brought up next,
    // and a step the form made.
    let arrived: [String]
    let lasts: Duration

    // A receipt: a removal the engine holds offers its Undo for the engine's hold, any other act for six seconds.
    init(_ says: Says, of receipt: ActReceipt, act: Undo.Act, arrived: [String] = []) {
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
  // A step that goes while its page is open, deleted here or by another device, takes the stack back to the Board, and
  // so does the last roadmap going while All Roadmaps is open. The form closes once its roadmap is not the open one, or
  // the step it edits is gone.
  private(set) var phase = Phase.unread {
    didSet {
      if let draft, draft.open == nil { self.draft = nil }
      guard !path.isEmpty else { return }
      if case .open(let open) = phase, path.allSatisfy({ (visit: Visit) -> Bool in
        guard case .step(let step, _) = visit else { return true }
        return open.step(step) != nil
      }) { return }
      path = []
    }
  }
  // The screens open over the Board, the one on screen last. A screen pushed is told once: All Roadmaps, or a step's
  // page with the group its step stands in.
  var path: [Visit] = [] {
    didSet {
      guard path.count > oldValue.count, let pushed = path.last else { return }
      switch pushed {
      case .roadmaps: telemetry.event("roadmap_sheet", properties: ["step": "open"])
      case .step(let step, let door):
        guard case .open(let open) = phase, let row = open.step(step) else { return }
        telemetry.event("roadmap_board_step_open", properties: ["surface": "document", "column": row.card.column.rawValue, "door": door.rawValue])
      }
    }
  }
  // The person's own roadmaps, the most recent first.
  private(set) var roadmaps: [ListedRoadmap] = []
  private(set) var band: Band?
  private(set) var question: Question?
  // The New Roadmap sheet stands open.
  private(set) var naming = false
  // The draft the step form stands open on, New Step's or Edit's.
  var draft: StepDraft?
  // The Board's groups that stand folded: Done at rest, until every step is done.
  var folded: Set<BoardRead.Column.Name> = [.done]
  // Every roadmap the phone holds as the domain last read them together, which says what opens what.
  @ObservationIgnored var account = RoadmapAccount([])
  // A roadmap the room made, or brought back by Undo, which it opens once the list holds it.
  @ObservationIgnored var arriving: String?
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
    account = RoadmapAccount(trees)
    roadmaps = account.list()
    if let arrived = arriving, roadmaps.contains(where: { $0.id.utf8.elementsEqual(arrived.utf8) }) {
      phone.set(arrived, forKey: Self.lastOpen)
      arriving = nil
    }
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
    // Another roadmap opens with its Board at rest: Done folded, unless every step is done. On the one shown, Done opens
    // by itself once every step is done, and rests folded again once one is not.
    if case .open(let shown) = phase, shown.listed.id.utf8.elementsEqual(listed.id.utf8) {
      if open.everyStepDone && !shown.everyStepDone { folded.remove(.done) }
      if !open.everyStepDone && shown.everyStepDone { folded.insert(.done) }
    } else {
      folded = open.everyStepDone ? [] : [.done]
    }
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

  // The room's write door: one act of the domain, run on roadmap's runner, answering what it came to.
  func write<A: ActAction>(_ act: A, as name: String) -> Written<A.Result> where A.Refusal == RoadmapRefusal {
    told(as: name) {
      switch try runner.runAct(act) {
      case .committed(let result, let receipt): .committed(result, receipt)
      case .unchanged: .unchanged
      case .refused(let refusal): .refused(refusal)
      }
    }
  }

  // The same door for a gesture that is several acts, each reading what the ones before it wrote: one write, one
  // receipt and one Undo, or nothing written where the domain refuses any of them.
  func write(_ acts: [AnyActAction<RoadmapRefusal>], as name: String) -> Written<Void> {
    told(as: name) {
      switch try runner.runComposed(acts) {
      case .committed(_, let receipt): .committed((), receipt)
      case .unchanged: .unchanged
      case .refused(_, let refusal): .refused(refusal)
      }
    }
  }

  // What the door tells of a write, whoever asked for it: a refusal by its kind, said in the band where it is a limit,
  // and a commit that failed, which is reported and shows nothing, since the phone's copy stands as it was.
  func told<Result>(as name: String, _ run: () throws -> Written<Result>) -> Written<Result> {
    do {
      let written = try run()
      if case .refused(let refusal) = written {
        telemetry.event("roadmap_write_refused", properties: ["write": name, "refusal": refusal.label])
        if case .full = refusal { show(Band(refused: .full)) }
      }
      return written
    } catch {
      report(error, write: name)
      return .failed
    }
  }

  // Complete: the step's mark in the person's overlay. Its receipt names the steps it brought up next. The step's
  // page tells its acts as the web's step page does.
  func complete(_ row: Row, by door: Door) {
    guard case .open(let open) = phase else { return }
    let mark = MarkStep.complete(tree: open.id, step: ID(RecordID(row.id)), opensStanding: row.opensStanding)
    guard let written = write(mark, as: "mark").committed else { return }
    if door == .page { telemetry.event("roadmap_board_step_action", properties: ["surface": "document", "action": "complete"]) }
    else { telemetry.event("roadmap_board_complete", properties: ["door": door.rawValue]) }
    let upNext = open.graph.unlocks(row.id)
    show(Band(.completed(step: row.step.label, upNext: upNext.compactMap { open.tree.step($0)?.label }, inPlace: door == .page),
              of: written.receipt, act: .step("complete"), arrived: upNext))
  }

  // Reset, on a Done step's page: the mark comes off and nothing is asked. Its receipt counts the steps it locked again.
  func reset(_ step: OpenStep) {
    guard case .open(let open) = phase else { return }
    guard let written = write(MarkStep.reset(tree: open.id, step: ID(RecordID(step.row.id))), as: "mark").committed else { return }
    telemetry.event("roadmap_board_step_action", properties: ["surface": "document", "action": "reset"])
    show(Band(.reset(step: step.row.step.label, locked: step.relocks), of: written.receipt, act: .step("reset")))
  }

  // Delete asks once, on the step.
  func askDelete(_ row: Row, by door: Door) {
    guard case .open(let open) = phase else { return }
    if door == .page { telemetry.event("roadmap_board_step_action", properties: ["surface": "document", "action": "delete"]) }
    question = .step(row, by: door, followers: open.followers(of: row.id))
  }

  // The question's answer: Delete Step or Delete Roadmap deletes what was asked of; closed any other way, nothing is
  // written.
  func answer(delete confirmed: Bool) {
    guard let asked = question else { return }
    question = nil
    switch asked {
    case .step(let row, let door, _):
      telemetry.event("roadmap_board_delete", properties: ["step": confirmed ? "confirm" : "cancel", "view": "board"])
      if confirmed { delete(row, by: door) }
    case .roadmap(let roadmap, let place, let openers):
      telemetry.event("roadmap_deletion", properties: ["step": confirmed ? "confirm" : "cancel"])
      if confirmed { delete(roadmap, from: place, taking: openers) }
    }
  }

  // Delete: the step alone goes, held by the engine, and its receipt keeps Undo for the hold. The room stands on the
  // Board once it is written, the form that asked closed.
  func delete(_ row: Row, by door: Door) {
    guard case .open(let open) = phase else { return }
    if let kept = open.keptStep, kept.utf8.elementsEqual(row.id.utf8) {
      telemetry.event("roadmap_write_refused", properties: ["write": "DeleteNode", "refusal": "startingStep"])
      show(Band(refused: .keepsStartingStep))
      return
    }
    guard let written = write(DeleteStep(tree: open.id, step: ID(RecordID(row.id))), as: "DeleteNode").committed else { return }
    path = []
    draft = nil
    telemetry.event("roadmap_board_delete", properties: ["step": "held", "door": door.rawValue, "view": "board"])
    show(Band(.deleted(step: row.step.label), of: written.receipt, act: .step("delete")))
  }

  // New Step, at the Board's foot and on a roadmap with no step, raises the form on a new draft, whose step takes its
  // id now.
  func newStep(from door: StepDraft.Door) {
    guard case .open(let open) = phase else { return }
    draft = StepDraft(new: runner.mint(RoadmapStep.self, in: open.id.tree), of: open.id, by: door, in: self)
    telemetry.event("roadmap_board_create", properties: ["step": "open", "door": door.rawValue, "view": "board"])
  }

  // Edit, in a step page's bar, raises the form over the page on a draft of the step.
  func edit(_ step: OpenStep) {
    guard case .open(let open) = phase else { return }
    draft = StepDraft(editing: step, of: open.id, in: self)
    telemetry.event("roadmap_step_edit", properties: ["step": "open", "door": StepDraft.Door.page.rawValue])
  }

  // A roadmap chosen in the title menu or in All Roadmaps is the open one, on its Board, and the one the phone
  // remembers. Choosing the open one only returns to its Board.
  func open(_ roadmap: String, from place: Place) {
    path = []
    if case .open(let shown) = phase, shown.listed.id.utf8.elementsEqual(roadmap.utf8) { return }
    guard roadmaps.contains(where: { $0.id.utf8.elementsEqual(roadmap.utf8) }) else { return }
    arriving = nil
    phone.set(roadmap, forKey: Self.lastOpen)
    telemetry.event("roadmap_sheet", properties: ["step": "switch", "door": place.rawValue])
    observe()
  }

  // The first search of All Roadmaps in one visit is told.
  func searchedRoadmaps() {
    telemetry.event("roadmap_sheet", properties: ["step": "search"])
  }

  // New Roadmap, in the title menu, on All Roadmaps and in the room that holds no roadmap, opens the one sheet that
  // names it.
  func nameRoadmap(from place: Place) {
    naming = true
    telemetry.event("roadmap_sheet", properties: ["step": "new", "door": place.rawValue])
  }

  // Cancel, or the sheet sent away: nothing is written.
  func cancelNaming() {
    guard naming else { return }
    naming = false
    telemetry.event("roadmap_board_create", properties: ["step": "cancel", "door": "blank"])
  }

  // A name as the web's room takes one before the domain reads it (`NewTreeBirth.plant`, `ReplicaSession.renameTree`):
  // without the blanks around it.
  static func name(typed: String) -> String { typed.trimmingCharacters(in: .whitespacesAndNewlines) }

  // Create: a blank roadmap starts with one step, named as the roadmap and in the first kind's colour, as the web's
  // birth plants it (`NewTreeBirth.plant`). The room opens it on its Board once the phone's copy holds it; the engine
  // keeps no Undo of a birth. A name the domain refuses leaves the sheet open.
  func create(named typed: String) {
    let title = Self.name(typed: typed)
    let start = ImportedStep(key: "start", RoadmapStep.Changes(label: title, icon: "sparkles", color: RoadmapRules.genesisKinds[0].hue))
    guard let written = write(CreateRoadmap(title: title, steps: ImportedSteps(steps: [start])), as: "createRoadmap").committed else { return }
    forget(written.receipt.gestureId)
    naming = false
    path = []
    arriving = written.result.tree.description
    telemetry.event("birth")
  }

  // Rename, committed in the bar's field: the open roadmap's name as the domain takes it. A name of blanks alone is
  // written as no name, and the roadmap then reads as one without a title. The room offers no Undo of a rename.
  func rename(to typed: String) {
    guard case .open(let open) = phase, let written = write(WriteRoadmap(tree: open.id, title: Self.name(typed: typed)), as: "title").committed else { return }
    forget(written.receipt.gestureId)
    telemetry.event("roadmap_sheet", properties: ["step": "rename"])
  }

  // What goes with a roadmap, read as the web's switcher reads it for a roadmap kept on the device (`OpenedTrees.openersOf`,
  // `deleteCost`): the pointers of every other roadmap that stands outside its branch. None where no step opens it.
  func openers(of roadmap: String) -> Openers? {
    let listed = roadmaps.map(\.id)
    let owned = account.trees.map(\.id).filter { (tree: String) -> Bool in !listed.contains { $0.utf8.elementsEqual(tree.utf8) } }
    let holders = (listed + owned).compactMap { (tree: String) -> (title: String?, steps: Int)? in
      let location = account.location(of: tree)
      guard let root = location.place?.root, !root.utf8.elementsEqual(roadmap.utf8) else { return nil }
      let steps = account.openings(of: tree).count { $0.opening.kind == .pointer && $0.opening.tree.utf8.elementsEqual(roadmap.utf8) }
      return steps == 0 ? nil : (location.title, steps)
    }
    guard !holders.isEmpty else { return nil }
    return Openers(steps: holders.reduce(0) { (sum: Int, holder: (title: String?, steps: Int)) -> Int in sum + holder.steps }, roadmaps: holders.map(\.title))
  }

  // Delete Roadmap asks once, with what else goes.
  func askDelete(_ roadmap: ListedRoadmap, from place: Place) {
    telemetry.event("roadmap_deletion", properties: ["step": "ask", "door": place.rawValue])
    question = .roadmap(roadmap, from: place, openers: openers(of: roadmap.id))
  }

  // Delete Roadmap: the roadmap's entry goes, held by the engine, and its receipt keeps Undo for the hold. Once the
  // list is read without it the room opens the most recent other roadmap, or holds none.
  func delete(_ roadmap: ListedRoadmap, from place: Place, taking openers: Openers?) {
    guard let written = write(DeleteRoadmap(tree: ID(RecordID(roadmap.id))), as: "deleteRoadmap").committed else { return }
    telemetry.event("roadmap_deletion", properties: ["step": "held", "door": place.rawValue, "openers": openers == nil ? "none" : "some"])
    var wasOpen = false
    if case .open(let shown) = phase { wasOpen = shown.listed.id.utf8.elementsEqual(roadmap.id.utf8) }
    show(Band(.deletedRoadmap(roadmap.title), of: written.receipt, act: .roadmapDelete(reopens: wasOpen ? roadmap.id : nil)))
  }

  // The band's Undo: a removal the engine holds is cancelled while it is held, and any other act is taken back by the
  // kit's Undo of it. The engine then keeps nothing more of the act, nor of its Undo, which the room never redoes. A
  // roadmap brought back is the open one again where it was.
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
      switch undo.act {
      case .step(let act): telemetry.event("roadmap_board_undo", properties: ["act": act, "outcome": taken ? "ok" : "unavailable"])
      case .roadmapDelete(let reopens):
        telemetry.event("roadmap_deletion", properties: ["step": "undo", "outcome": taken ? "cancelled" : "released"])
        if taken, let reopens { arriving = reopens }
      }
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
    if let undo { forget(undo.gesture) }
  }

  // The engine keeps nothing more of an act the room offers no Undo of, or offers one of no longer.
  func forget(_ gesture: String) {
    do { try runner.release(gesture) }
    catch { report(error, write: "release") }
  }

  // Every failed write reports under the room's one operation, with the write it was.
  func report(_ error: any Error, write name: String) {
    guard Store.failureKind(error) == nil else { return }
    telemetry.failure("roadmap_write", kind: (error as? CommitFailure)?.kind == .storeFailure ? "storage" : "unexpected", properties: ["write": name])
  }
}

extension TextSpec {
  // As much of a typed text as the domain takes, so a field stops at its limit.
  func holding(_ typed: String) -> String {
    var held = String(typed.prefix(max))
    while measure(held) > max { held.removeLast() }
    return held
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
