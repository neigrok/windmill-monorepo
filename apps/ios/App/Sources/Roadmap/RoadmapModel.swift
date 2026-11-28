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

  // What the room reads of sync beside the records: whether the phone has a connection, which the bar's subtitle says
  // (10.1), roadmap's notices of the person's changes that could not land, which Set Aside lists, and the dismissal of
  // one, which its Discard is. A room that reads none, a reader's cover or a test that tells nothing of them, stands
  // online with no notice.
  struct Sync {
    let online: @MainActor () -> Bool
    let notices: @MainActor () -> [Notice]
    let dismiss: @MainActor (String) throws -> Bool

    static let none = Sync(online: { true }, notices: { [] }, dismiss: { _ in false })
  }

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
    // The roadmap the step opens, or the subtree it owns, as the room shows it; none for an ordinary step.
    let opening: Opened?

    var id: String { step.id }
  }

  // One of the Board's groups that holds a step, with its rows in the domain's order.
  struct Group: Identifiable {
    let id: BoardRead.Column.Name
    let rows: [Row]
  }

  // A step on its own page: its row, the rows of the steps it requires and of the steps it opens, each in the
  // roadmap's order, and the person's workspace of it.
  struct OpenStep {
    let row: Row
    let requires: [Row]
    let opens: [Row]
    // How many steps Reset returns to Locked, where the room offers Reset: the domain's `EffectsRead.relocks`.
    let relocks: Int
    let workspace: StepWorkspace
  }

  // The room's two views of the open roadmap.
  enum Lens: String, CaseIterable {
    case board, graph
  }

  // A screen on the room's stack over the Board: All Roadmaps; a roadmap's Activity; a step's page with what opened it as
  // its event names it, a Board row, the web's card, a row of another step's page, the Graph's bar of the selected step,
  // a row of Activity, or the band's Show of a line told once; a step's note over its page; a step's History; the list a
  // roadmap is attached to a step from; the roadmap a step opens, gone into by a Board row's swipe, the step page's
  // Roadmap row or its foot's button; or the public gallery, from All Roadmaps.
  enum Visit: Hashable {
    enum Door: String {
      case card, step, graph, activity, link, swipe, foot, band
    }

    case roadmaps
    case activity(of: String)
    case step(String, by: Door)
    case note(of: String)
    case history(of: String)
    case attach(to: String)
    case roadmap(String, by: Door)
    case gallery

    // The step whose page, note, History or attach list the screen is.
    var step: String? {
      switch self {
      case .roadmaps, .activity, .roadmap, .gallery: nil
      case .step(let step, _), .note(let step), .history(let step), .attach(let step): step
      }
    }

    // The roadmap the screen has gone into.
    var roadmap: String? {
      guard case .roadmap(let roadmap, _) = self else { return nil }
      return roadmap
    }

    // Whether the screen still has what it shows in the roadmap the room has open: Activity its roadmap, a step's screens
    // their step, and a roadmap gone into a step that still leads into it.
    func stands(in open: OpenRoadmap) -> Bool {
      switch self {
      case .roadmaps, .gallery: true
      case .activity(let roadmap): open.listed.id.utf8.elementsEqual(roadmap.utf8)
      case .step(let step, _), .note(let step), .history(let step), .attach(let step): open.step(step) != nil
      case .roadmap(let roadmap, _): open.rows.values.contains { $0.opening.map { $0.leads && $0.tree.utf8.elementsEqual(roadmap.utf8) } == true }
      }
    }
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
    // The person's workspace of each step that has one.
    let workspaces: [ID<RoadmapStep>: StepWorkspace]
    // Its kinds as the room shows them, wherever a kind is listed, chosen or filtered by.
    let legend: RoadmapLegend
    // Its guide and the guides of the roadmaps above it, as the domain reads them.
    let guides: [Guide]
    // The person owns it: a reader's cover offers no act on it and holds no mark of theirs.
    let owned: Bool

    // Nil for a roadmap that does not stand or is not read yet. A roadmap the person does not own, on a reader's cover,
    // offers no Complete, Reset or Delete on any step.
    init?(_ listed: ListedRoadmap, in account: RoadmapAccount, workspaces: [ID<RoadmapStep>: StepWorkspace] = [:], owned: Bool = true) {
      guard let graph = account.graph(listed.id) else { return nil }
      let (tree, board, legend) = (graph.tree, BoardRead(graph), RoadmapLegend(graph.tree))
      let openings = Dictionary(account.openings(of: listed.id).map { (Array($0.opening.node.utf8), $0) }) { first, _ in first }
      let owners = Dictionary(legend.entries.compactMap { (entry: RoadmapLegend.Entry) -> ([UInt8], Kind)? in
        entry.kind.map { (Array(entry.hue.utf8), $0) }
      }) { first, _ in first }
      let kept = EffectsRead(graph, ids: [String]()).kept
      let rows = Dictionary(board.cards.compactMap { (card: BoardRead.Card) -> ([UInt8], Row)? in
        guard let held = tree.step(card.id) else { return nil }
        let read = openings[Array(card.id.utf8)]
        let opening = read.map { Opened($0, in: account, of: held) }
        return (Array(card.id.utf8), Row(
          step: held, card: card, kind: owners[Array(held.color.utf8)],
          opensStanding: read.map { $0.opening.kind == .pointer && account.location(of: $0.opening.tree).standing == .standing } ?? false,
          completes: owned && card.column == .upNext && read == nil, resets: owned && card.column == .done && read == nil,
          deletes: owned && (kept.map { !$0.utf8.elementsEqual(card.id.utf8) } ?? true), opening: opening))
      }) { first, _ in first }
      id = ID(RecordID(listed.id))
      self.listed = listed
      self.tree = tree
      self.graph = graph
      self.board = board
      self.rows = rows
      self.workspaces = workspaces
      self.legend = legend
      guides = account.guides(listed.id)
      self.owned = owned
      groups = [BoardRead.Column.Name.upNext, .locked, .done].compactMap { (name: BoardRead.Column.Name) -> Group? in
        let held = (board.columns.first { $0.name == name }?.ids ?? []).compactMap { (step: String) -> Row? in rows[Array(step.utf8)] }
        return held.isEmpty ? nil : Group(id: name, rows: held)
      }
    }

    var everyStepDone: Bool { board.overall.total > 0 && board.overall.done == board.overall.total }

    // Each step that opens a roadmap, with the line the Graph draws under its caption, empty where it draws none (04.6).
    var graphLines: [String: String] {
      Dictionary(rows.values.compactMap { (row: Row) -> (String, String)? in row.opening.map { (row.id, $0.line ?? "") } }) { first, _ in first }
    }

    // The Up next steps in the Board's order, Roadmap Order: what the Graph's *Next* leads with and lists.
    var upNext: [Row] { groups.first { $0.id == .upNext }?.rows ?? [] }

    func step(_ id: String) -> Row? { rows[Array(id.utf8)] }

    // What a delete of these steps, a Reset of one or a draft's links of one would do, as the domain reads it.
    func effects(of steps: some Sequence<String>, links: EffectsRead.Links? = nil) -> EffectsRead { EffectsRead(graph, ids: Array(steps), links: links) }

    // The owner's Done mark on a step its opening sets aside, until it is detached: the steps it alone would open, which
    // stand Locked meanwhile, as the domain reads it; none on a reader's cover or where the step holds no such mark.
    func setAside(of row: Row) -> [String]? { owned ? effects(of: [row.id]).setAside : nil }

    // A step's page; none for a step the roadmap does not hold.
    func page(of step: String) -> OpenStep? {
      guard let row = self.step(step) else { return nil }
      let read = effects(of: [step])
      return OpenStep(row: row, requires: graph.followed(step).compactMap { (followed: Followed) -> Row? in self.step(followed.id) },
                      opens: read.follow.compactMap { (follower: String) -> Row? in self.step(follower) },
                      relocks: row.resets ? read.relocks.count : 0, workspace: workspaces[ID(RecordID(step))] ?? StepWorkspace())
    }
  }

  // What the room shows: its bar alone while the phone's copy is not read yet, a roadmap, no roadmap, or a failed read.
  enum Phase {
    case unread, empty, open(OpenRoadmap), failed
  }

  // Whom the room shows roadmaps to, given as it is made: their owner, whose own list it reads and who writes, with what a
  // link raises over the room (`RoadmapLinks`, none where the room follows no link); the owner in a roadmap gone into from
  // another room (`outside`), whose read of the phone's copy it shows, and whether it is the subtree a step owns; or a
  // reader of one roadmap someone else shared, which a cover reads into the room (`SharedRead`) and where every act refuses.
  enum Role {
    case owner(RoadmapLinks?)
    case inside(String, subtree: Bool)
    case reader(SharedRead)
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
    case committed(Result, Receipt<ActReceipt>)
    case unchanged
    case refused(RoadmapRefusal)
    case failed

    var committed: (result: Result, receipt: Receipt<ActReceipt>)? {
      guard case .committed(let result, let receipt) = self else { return nil }
      return (result, receipt)
    }
  }

  // Where a gesture on a roadmap is made, as its event names it: the title menu, All Roadmaps, the room that holds no
  // roadmap, or the public gallery's Open Your Copy.
  enum Place: String {
    case menu, list, empty, gallery
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
    // Several steps', on the bottom toolbar's Delete N Steps: the steps chosen, and how many steps outside them follow
    // one of them.
    case steps([Row], followers: Int)
    // A roadmap's, under the title whose menu asked or on its row in All Roadmaps: the roadmap, and what else goes.
    case roadmap(ListedRoadmap, from: Place, openers: Openers?)
  }

  // The one band at the room's foot: a receipt with its Undo, a limit that refused a gesture, or what the room tells once.
  struct Band: Equatable {
    enum Says: Equatable {
      // A step completed, the labels of the steps it brought up next, and whether it was completed in place, on its
      // own page, which names it already.
      case completed(step: String, upNext: [String], inPlace: Bool)
      // A step reset, and how many steps it returned to Locked.
      case reset(step: String, locked: Int)
      case deleted(step: String)
      // Several steps deleted at once, or recolored at once, by how many.
      case deletedSteps(count: Int)
      case recolored(count: Int)
      // A kind removed in the Kinds sheet, by its name.
      case removedKind(String)
      // A step the form made, and the group it landed in.
      case created(step: String, in: BoardRead.Column.Name)
      // A step the form saved a change to.
      case saved(step: String)
      // The roadmap's guide saved, or saved blank and so removed.
      case savedGuide(cleared: Bool)
      // A roadmap deleted, by its title.
      case deletedRoadmap(String?)
      // The copy a fork made, opened once it arrived, by how many steps it planted.
      case forked(steps: Int)
      // A gallery row's fork that forked nothing, with no connection or for another reason.
      case unforked(offline: Bool)
      // A subtask checked, by its words.
      case checked(ID<Subtask>, label: String)
      // A subtask or a link of a step's workspace deleted, by its words or its title.
      case deletedFromWorkspace(String)
      // A roadmap attached to a step, or changed for another, and one detached, with whether the step's Done mark is back.
      case attached
      case detached(markBack: Bool)
      case refused(Limit)
      // An Undo that brought back nothing of what its receipt said.
      indirect case unrestored(Says)
      // A roadmap planted from a plan, by how many steps it holds and how many of them the plan brought done.
      case planted(steps: Int, done: Int)
      // Steps pasted into the open roadmap, by how many.
      case added(steps: Int)
      // Paste Steps found no text to read back on the clipboard.
      case noText
      // The system was not allowed to hand Paste Steps the copied text.
      case pasteRefused
      // A change of the person's that met one made elsewhere, told once with Show (10.2, 10.4).
      case landed(Landed.Line)
      // A direct write of Coach's, by its receipt (11.3), and its Undo taken (11.4).
      case coachWrote(CoachReceipt)
      case coachUndone
      // A Coach conversation deleted in History, by its title (11.7).
      case deletedConversation(String)
    }

    // A receipt's Undo: the gesture its act wrote, whether the engine holds that act, the act it takes back, and the kit's
    // Undo of that act, with the checks it is asked with.
    struct Undo: Equatable {
      // An act on a roadmap's steps, kinds or guide, or on a workspace, by its name in the room's events, a roadmap's
      // delete, with the roadmap where the room had it open, which its Undo opens again, or a Coach conversation's delete.
      enum Act: Equatable {
        case step(String)
        case workspace(String)
        case roadmapDelete(reopens: String?)
        case conversation

        // An act on steps or kinds keeps the kit's Undo of it past the engine's hold, so a step's delete is restored once
        // its hold has ended too; a roadmap's delete and a removal from a workspace are undone by their hold alone.
        var outlivesHold: Bool {
          guard case .step = self else { return false }
          return true
        }
      }

      let gesture: String
      let held: Bool
      let act: Act
      let handle: UndoHandle
    }

    let says: Says
    let undo: Undo?
    // A direct write of Coach's, whose Undo the tool host that wrote it takes (11.3).
    var coach: CoachWrite?
    // The steps the act brought to where they stand, washed while the band stands: those a completion brought up next,
    // and a step the form made.
    let arrived: [String]
    let lasts: Duration

    // A receipt: a removal the engine holds offers its Undo for the engine's hold, any other act for six seconds.
    init(_ says: Says, of receipt: Receipt<ActReceipt>, act: Undo.Act, arrived: [String] = []) {
      let held = receipt.releaseAt != nil
      self.says = says
      undo = Undo(gesture: receipt.gestureId, held: held, act: act, handle: receipt.undo)
      self.arrived = arrived
      lasts = held ? .milliseconds(Constants.holdMs) : RoadmapModel.bandLasts
    }

    // A gesture refused at a limit.
    init(refused limit: Limit) {
      self.init(told: .refused(limit))
    }

    // What the band tells once with no Undo, for six seconds.
    init(told says: Says) {
      self.says = says; undo = nil; arrived = []; lasts = RoadmapModel.bandLasts
    }

    // An Undo that brought nothing back: the receipt's words give way to what could not come back, with no Undo, for six
    // seconds.
    init(unrestored receipt: Says) {
      self.init(told: .unrestored(receipt))
    }

    // A fork's copy opened: said once, with no Undo, since the copy is the person's own and Delete Roadmap removes it.
    init(forked steps: Int) {
      says = .forked(steps: steps); undo = nil; arrived = []; lasts = RoadmapModel.bandLasts
    }

    // Coach's direct write: its receipt, or the Board's own sentence of a completion (11.18), with Undo for six seconds.
    init(_ says: Says, coach write: CoachWrite, arrived: [String] = []) {
      self.says = says; undo = nil; coach = write; self.arrived = arrived; lasts = RoadmapModel.bandLasts
    }

    // A landing line offered, its step washed while the band stands, with no Undo, for six seconds once it is seen.
    init(landed line: Landed.Line) {
      says = .landed(line); undo = nil; arrived = [line.step]; lasts = RoadmapModel.bandLasts
    }
  }

  // The types the domain reads one roadmap from, in its tree scope and in its owner's overlay.
  static let treeTypes = [RoadmapMeta.type, RoadmapStep.type, RoadmapLink.type, RoadmapKind.type]
  static let overlayTypes = [StepMark.type, StepPointer.type, Subtask.type, WorkspaceLink.type, StepNote.type]
  // Where the phone keeps the id of the roadmap last open, and the view each roadmap was last switched to.
  static let lastOpen = "roadmapLastOpen"
  static let lastLens = "roadmapLastLens"
  static let bandLasts = Duration.seconds(6)

  let records: Records
  // Roadmap's runner, which holds a removal for the engine's hold.
  let runner: ActionRunner
  // What this phone remembers under any account or none.
  let phone: UserDefaults
  let telemetry: any Telemetry
  let wait: Wait
  // Where Paste Steps reads the copied text from.
  let clipboard: Clipboard
  // The file a launch hands New Roadmap's A File in place of the system's importer, and the one Export writes in place of
  // the system's exporter, none in the app.
  let handedFile: @MainActor () -> URL?
  let exportFile: @MainActor () -> URL?
  // The Graph of the open roadmap: its picture, its camera and its captions.
  let graph: RoadmapGraph
  // What the Board measures of itself, where a launch asks for it.
  let boardFrames: BoardFrames
  // A step that goes while its page, its note or its History is open, deleted here or by another device, takes the stack
  // back to the Board, and so does the roadmap whose Activity is open no longer being the open one, or the last roadmap
  // going while All Roadmaps is open. The form closes once its roadmap is not the open one, or the step it edits is gone,
  // and a selected step that is gone is selected no longer. A note open on its screen follows what the phone's copy now
  // holds of it, and the Board's reading what the room shows. The Guide sheet closes once its roadmap is not the open one,
  // and its draft follows the guide the copy holds.
  private(set) var phase = Phase.unread {
    didSet {
      if let draft, draft.open == nil { self.draft = nil }
      if let guide, guide.open == nil { self.guide = nil }
      if share?.gone == true { share = nil }
      share?.follow()
      if let selected, shown?.step(selected) == nil { self.selected = nil }
      note?.follow()
      guide?.follow()
      if let shown { reading.read(shown, shown: view(of: shown)) }
      if !removedKinds.isEmpty { removedKinds = removedKinds.filter { shown?.legend.entry($0.key) != nil } }
      activities = [:]
      guard !path.isEmpty else { return }
      if case .open(let open) = phase, path.allSatisfy({ $0.stands(in: open) }) { return }
      path = []
    }
  }
  // The screens open over the Board, the one on screen last. A screen pushed is told once: All Roadmaps, a step's page
  // with the group its step stands in, a step's note, which opens on a draft, and Activity or a step's History with what
  // its read came to. A note's screen that leaves the stack, by Done, by Back or with its step, saves its draft.
  var path: [Visit] = [] {
    didSet {
      if let inside, !path.contains(where: { $0.roadmap != nil }) { cameBack(from: inside) }
      if let note, !path.contains(.note(of: note.step.description)) {
        note.save()
        self.note = nil
      }
      guard path.count > oldValue.count, let pushed = path.last else { return }
      switch pushed {
      case .roadmap(let tree, let door): wentIn(tree, by: door)
      case .attach: telemetry.event("roadmap_tree_attach", properties: ["step": "open", "door": "page"])
      case .roadmaps: telemetry.event("roadmap_sheet", properties: ["step": "open"])
      case .gallery: telemetry.event("roadmap_gallery", properties: ["step": "open"])
      case .step(let step, let door):
        guard case .open(let open) = phase, let row = open.step(step) else { return }
        telemetry.event("roadmap_board_step_open", properties: ["surface": "document", "column": row.card.column.rawValue, "door": door.rawValue])
      case .note(let step):
        guard case .open(let open) = phase, open.step(step) != nil else { return }
        note = StepNoteDraft(of: ID(RecordID(step)), in: open.id, room: self)
        telemetry.event("roadmap_board_step_action", properties: ["surface": "document", "action": "editNote"])
      case .activity, .history:
        guard let shown, pushed.stands(in: shown), let read = activity(of: pushed.step) else { return }
        telemetry.event("roadmap_activity", properties: ["step": "open", "surface": pushed.step == nil ? "activity" : "history",
                                                         "read": read.rows.isEmpty ? "empty" : "loaded"])
      }
    }
  }
  // The person's own roadmaps, the most recent first.
  private(set) var roadmaps: [ListedRoadmap] = []
  // The band every screen on the stack stands on: one for the stack, kept by the root's room, which a roadmap gone into
  // shows, ends and undoes as its own, so going in or back takes no Undo away while it stands.
  var band: Band? { root.stackBand }
  private(set) var stackBand: Band?
  // The delete question standing where it was asked.
  var question: Question?
  // The view the switch row chose of the open roadmap: its own on this phone, the Board until it is switched (the
  // web's `ViewPrefs`). The Board's reading follows the view the room then shows.
  private(set) var lens = Lens.board {
    didSet { if let shown { reading.read(shown, shown: view(of: shown)) } }
  }
  // The step selected on the Graph, which leads its captions.
  private(set) var selected: String? {
    didSet { graph.attend(to: selected) }
  }
  // The New Roadmap sheet stands open on its draft.
  var newRoadmap: NewRoadmapDraft?
  // Paste Steps' sheet stands open on the steps it read back.
  var pasting: PastedSteps?
  // The draft the step form stands open on, New Step's or Edit's.
  var draft: StepDraft?
  // The draft the note's screen stands open on.
  private(set) var note: StepNoteDraft?
  // The Guide sheet stands open over the open roadmap, reading its guide or writing a draft of it.
  var guide: GuideSheet?
  // The Share sheet stands open over the open root, and the system's exporter over the open roadmap with its file.
  var share: ShareSheet?
  var exporting: RoadmapMarkdown?
  // The Board's groups that stand folded: Done at rest, until every step is done.
  var folded: Set<BoardRead.Column.Name> = [.done]
  // What the Board asks of the open roadmap: its order, the kinds it shows, a branch and Find's words.
  let reading: BoardReading
  // The steps chosen while the Board selects several.
  var selection: BoardSelection?
  // The Kinds sheet stands open, from where it was raised.
  var kindsDoor: KindsDoor?
  // The kinds removed that the phone's copy is still read with, each by the gesture of its delete: the sheet lets a row
  // go as its delete is written, as the system's edit mode asks, and the copy follows a moment later. A read without the
  // kind ends it, and so does the delete's Undo, which may come before that read.
  var removedKinds: [RoadmapLegend.Subject: String] = [:]
  // What the root's room tells once of a change that met one made elsewhere, and keeps of what could not land
  // (`Landing/`).
  let landed = Landed()
  // The room stands before the person, on screen in an app in the foreground with no sheet of the shell's over it: only
  // then is a line offered to the band.
  var faces = false {
    didSet { if faces { offerLanding() } }
  }
  // Every roadmap the phone holds as the domain last read them together, which says what opens what.
  @ObservationIgnored var account = RoadmapAccount([])
  // A roadmap the room made, or brought back by Undo, which it opens once the list holds it.
  @ObservationIgnored var arriving: String?
  // The open roadmap's Activity, and each step's History, by the step, as the domain read them from the phone's copy:
  // read once for each read of the copy, however often the screens that show them are drawn.
  @ObservationIgnored var activities: [String?: ActivityRead] = [:]
  // The phone's midnights while the room stands, which whatever reads `moment` is drawn again at.
  private(set) var midnights = 0
  // The observer that counts them, which ends with the room, a cover's when the cover goes.
  @ObservationIgnored var dayChanges: NotificationWatch?
  // Every view the room asked the engine for, kept so each stays live.
  @ObservationIgnored var views: [ViewKey: RecordsView] = [:]
  // Each of the person's roadmaps' overlay records as the last read held them, which a roadmap gone into reads its
  // workspace from.
  @ObservationIgnored var overlays: [ID<RoadmapEntry>: [Record]] = [:]
  // The room of the roadmap gone into from this one, while its visit stands on this room's stack, and the room this one
  // was gone into from.
  var inside: RoadmapModel?
  @ObservationIgnored weak var outside: RoadmapModel?
  // The observation now live; one begun later ends the one before it.
  @ObservationIgnored var watch = 0
  @ObservationIgnored var reportedFailures: Set<String> = []
  @ObservationIgnored var bandTime: Task<Void, Never>?
  let role: Role
  let sync: Sync

  // Coach in the room, where it is switched on (`AppSettings.roadmapCoach`): the root's, which a roadmap gone into asks too.
  var coach: RoadmapCoach? {
    get { root === self ? ownCoach : root.coach }
    set { ownCoach = newValue }
  }
  @ObservationIgnored private var ownCoach: RoadmapCoach?

  init(records: @escaping Records, runner: ActionRunner, phone: UserDefaults, telemetry: any Telemetry = NoopTelemetry(),
       wait: @escaping Wait = { try await Task.sleep(for: $0) }, graph: RoadmapGraph? = nil, boardFrames: BoardFrames = BoardFrames(),
       role: Role = .owner(nil), sync: Sync = .none, clipboard: Clipboard = .system, handedFile: @escaping @MainActor () -> URL? = { nil },
       exportFile: @escaping @MainActor () -> URL? = { nil }) {
    self.records = records; self.runner = runner; self.phone = phone; self.telemetry = telemetry; self.wait = wait
    self.role = role; self.sync = sync; self.clipboard = clipboard; self.handedFile = handedFile; self.exportFile = exportFile
    self.graph = graph ?? RoadmapGraph(telemetry: telemetry)
    self.boardFrames = boardFrames
    reading = BoardReading(telemetry: telemetry)
    dayChanges = NotificationWatch(.NSCalendarDayChanged) { [weak self] in self?.midnights += 1 }
  }

  // The engine's now in the phone's zone, by which Activity and a step's History place each row's day; the phone's own
  // clock where the store cannot say it. It reads the midnights passed, so a screen laid out by it is drawn again at one.
  var moment: Moment {
    _ = midnights
    return (try? runner.moment()) ?? Moment(now: Instant(ms: Int64((Date().timeIntervalSince1970 * 1_000).rounded())), zone: DeviceZone())
  }

  // The open roadmap's Activity, or a step's History, read once for each read of the phone's copy.
  func activity(of step: String? = nil) -> ActivityRead? {
    guard let shown else { return nil }
    if let read = activities[step] { return read }
    let read = ActivityRead(shown.graph, step: step)
    activities[step] = read
    return read
  }

  // Activity, from the title menu: the open roadmap's, pushed over its Board.
  func showActivity() {
    guard let shown else { return }
    path = [.activity(of: shown.listed.id)]
  }

  // 01.13b: a fold of steps added at once opened in place, told with how many it holds as a bucket.
  func unfolded(_ steps: Int) {
    telemetry.event("roadmap_activity", properties: ["step": "unfold", "surface": "activity", "count": Self.bucket(steps)])
  }

  // 01.5b: the room's first read has run half a second and its spinner shows; then how that wait ended: read, failed,
  // or left, the room put away first.
  func firstReadWaits() {
    telemetry.event("roadmap_first_read", properties: ["step": "shown"])
  }

  func firstReadEnded() {
    let outcome = switch phase {
    case .unread: "left"
    case .failed: "failed"
    case .open, .empty: "read"
    }
    telemetry.event("roadmap_first_read", properties: ["step": "ended", "outcome": outcome])
  }

  // The room is its owner's, who writes, in their own roadmaps and in one gone into; a reader's writes nothing.
  var owns: Bool {
    if case .reader = role { return false }
    return true
  }

  // What a link raises over the owner's room; none on a reader's.
  var links: RoadmapLinks? {
    guard case .owner(let links) = role else { return nil }
    return links
  }

  // The roadmap the room has open, where it has one.
  var shown: OpenRoadmap? {
    guard case .open(let open) = phase else { return nil }
    return open
  }

  // What the room shows of a roadmap: the view the switch row chose, and of a roadmap with no step the Board, which
  // asks for the first, under either choice.
  func view(of open: OpenRoadmap) -> Lens {
    open.board.overall.total == 0 ? .board : lens
  }

  // Whether a foot draws the band: not while the screen's foot is away, and on the room's own screens not while the room
  // raises a sheet or a cover over them, where no one could see it; a foot in a sheet the room raised stands in front.
  func drawsBand(away: Bool, inSheet: Bool) -> Bool {
    !away && (inSheet || !root.raisesSheet)
  }

  // The room raises a sheet or a cover over its screens: New Roadmap, Share, Set Aside, a shared roadmap's cover, and of
  // any room on the stack Paste Steps, the step form, Kinds, the Guide or the system's exporter.
  var raisesSheet: Bool {
    newRoadmap != nil || share != nil || landed.listOpen || links?.cover != nil
      || rooms.contains { $0.pasting != nil || $0.draft != nil || $0.kindsDoor != nil || $0.guide != nil || $0.exporting != nil }
  }

  // The bar's subtitle: the roadmap's progress, and Offline joined to it while the phone has no connection (10.1), the
  // one sign of it, since every change is written on the phone first.
  func subtitle(of open: OpenRoadmap) -> String {
    let progress = open.board.overall.progress
    guard !root.sync.online() else { return progress }
    return String(localized: "\(progress) · Offline", comment: "The bar's subtitle while the phone has no connection: the roadmap's progress")
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

  // Reads what the views and the person's own room's notices hold, and again once any of them changes.
  func observe() {
    watch += 1
    let current = watch
    do { try read() }
    catch { fail(error) }
    if case .owner = role { readSetAside() }
    if root === self, let coach {
      // Coach's records are read with the room's, so a conversation shows what the copy holds of it as it changes.
      for type in [CoachThread.type, CoachMessage.type, CoachProposal.type, CoachWriteFate.type] { _ = try? snapshot(CoachThread.scope, type) }
      coach.revision += 1
      coach.follow()
    }
    inside?.observe()
    links?.followPending(in: self)
    withObservationTracking {
      for view in views.values { _ = view.state }
      if case .owner = role { _ = sync.notices() }
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.watch == current else { return }
        self.observe()
      }
    }
  }

  // Every listed roadmap is read with its tree scope and their overlay of it; while a view has yet to load, what is shown stays.
  func read() throws {
    if case .reader(let shared) = role { return try shared.read(into: self) }
    if case .inside(let tree, _) = role { return try readInside(tree) }
    guard let list = try snapshot(RoadmapEntry.scope, RoadmapEntry.type) else { return }
    var trees: [RoadmapTree] = []
    var overlays: [ID<RoadmapEntry>: [Record]] = [:]
    var scopes: Set<ScopeRef> = [RoadmapEntry.scope]
    var loaded = true
    for listed in list.records {
      let id = ID<RoadmapEntry>(listed.id)
      scopes.formUnion([id.tree, id.overlay])
      let tree = try Self.treeTypes.compactMap { try snapshot(id.tree, $0) }
      let overlay = try Self.overlayTypes.compactMap { try snapshot(id.overlay, $0) }
      loaded = loaded && tree.count == Self.treeTypes.count && overlay.count == Self.overlayTypes.count
      guard loaded else { continue }
      overlays[id] = overlay.flatMap(\.records)
      trees.append(try RoadmapTree(id: id, listed: listed, tree: tree.flatMap(\.records), overlay: overlays[id],
                                   read: list.firstPullComplete && (tree + overlay).allSatisfy(\.firstPullComplete)))
    }
    views = views.filter { scopes.contains($0.key.scope) }
    guard loaded else { return }
    self.overlays = overlays
    account = RoadmapAccount(trees)
    landed.remembered.merge(trees.map { ($0.id, $0) }) { _, read in read }
    let listed = roadmaps
    roadmaps = account.list()
    // §6 The landing note of a roadmap gone from the person's list goes whole, so a roadmap that never opens again keeps
    // no name of its steps on the phone, and no Undo of letting it go.
    for gone in listed where !roadmaps.contains(where: { $0.id.utf8.elementsEqual(gone.id.utf8) }) {
      if let written = write(ClearLanding(tree: ID(RecordID(gone.id))), as: "clearLanding").committed { forget(written.receipt.gestureId) }
    }
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
    let workspaces = try StepWorkspace.read(overlays[ID(RecordID(listed.id))] ?? [])
    guard let open = OpenRoadmap(listed, in: account, workspaces: workspaces) else {
      phase = .unread
      return
    }
    if !listed.id.utf8.elementsEqual(last.utf8) { phone.set(listed.id, forKey: Self.lastOpen) }
    present(open, in: (phone.dictionary(forKey: Self.lastLens)?[listed.id] as? String).flatMap { Lens(rawValue: $0) } ?? .board)
    if links?.arrived(listed.id) == true {
      path = []
      show(Band(forked: open.board.overall.total))
    }
  }

  // A roadmap gone into, as the room it was gone into from last read the phone's copy: the room shows it while it stands
  // and is read, in the view the phone last switched it to.
  func readInside(_ tree: String) throws {
    guard let outside else { return }
    (account, roadmaps, overlays) = (outside.account, outside.roadmaps, outside.overlays)
    guard let listed = account.listing(tree),
          let open = OpenRoadmap(listed, in: account, workspaces: try StepWorkspace.read(overlays[ID(RecordID(tree))] ?? [])) else {
      phase = .unread
      return
    }
    present(open, in: (phone.dictionary(forKey: Self.lastLens)?[tree] as? String).flatMap { Lens(rawValue: $0) } ?? .board)
  }

  // A roadmap read to be shown. Another opens with its Board at rest, Done folded unless every step is done, asking nothing
  // and choosing no steps, in the view it lands on, and with no step selected; one that opens on its Graph is told. On the
  // one shown, Done opens by itself once every step is done, and rests folded again once one is not.
  func present(_ open: OpenRoadmap, in lens: Lens) {
    let again = shown.map { $0.listed.id.utf8.elementsEqual(open.listed.id.utf8) } ?? false
    if let shown, again {
      if open.everyStepDone && !shown.everyStepDone { folded.remove(.done) }
      if !open.everyStepDone && shown.everyStepDone { folded.insert(.done) }
    } else {
      folded = open.everyStepDone ? [] : [.done]
      self.lens = lens
      selected = nil
      reading.forget()
      selection = nil
      kindsDoor = nil
    }
    phase = .open(open)
    if !again { root.landed.keep(Set(root.rooms.compactMap { $0.shown?.id })) }
    hearLanding(of: open)
    guard view(of: open) == .graph else { return }
    if !again { viewOpened(open) }
    graph.follow(open.graph, of: open.listed.id, opened: open.graphLines)
  }

  // The switch row's choice: the open roadmap's view, kept for it on this phone. The Graph then follows the roadmap as
  // the phone's copy reads it, and the time to its first frame runs from the tap.
  func show(_ lens: Lens) {
    guard let shown, lens != self.lens else { return }
    self.lens = lens
    if owns {
      phone.set((phone.dictionary(forKey: Self.lastLens) ?? [:]).merging([shown.listed.id: lens.rawValue]) { _, chosen in chosen }, forKey: Self.lastLens)
    }
    viewOpened(shown)
    guard view(of: shown) == .graph else { return boardFrames.opened() }
    graph.opened()
    graph.follow(shown.graph, of: shown.listed.id, opened: shown.graphLines)
  }

  // The view the open roadmap came to, told as the web tells its switch (§11): the switch row's choice, and a roadmap
  // opening on its Graph, which comes up with the roadmap's size as a bucket.
  func viewOpened(_ open: OpenRoadmap) {
    guard view(of: open) == .graph else {
      telemetry.event("roadmap_view_switch", properties: ["view": lens.rawValue])
      return
    }
    telemetry.event("roadmap_view_switch", properties: ["view": lens.rawValue, "steps": RoadmapGraph.bucket(open.board.overall.total)])
  }

  // A tap on the Graph: the step it took is the selected one, and a tap on empty canvas selects none. A tap that selects
  // another step ends a glide under way where it has got to, so the camera does not go on to the step left.
  func select(_ step: String?) {
    let row = step.flatMap { shown?.step($0) }
    if let row, row.id != selected {
      telemetry.event("roadmap_graph_select", properties: ["column": row.card.column.rawValue])
      graph.halt()
    }
    selected = row?.id
  }

  // Roadmap · iOS 04.3: *Next*'s menu opened over the Up next steps, and a step picked from it while it stands, which
  // is selected and brought to the centre of the canvas. Each is told as the web's What's next is, with the steps Up
  // next as a bucket.
  func nextOpened() {
    telemetry.event("roadmap_whats_next", properties: ["step": "open", "count": Self.bucket(shown?.upNext.count ?? 0)])
  }

  func pick(_ row: Row) {
    guard let row = shown?.step(row.id) else { return }
    telemetry.event("roadmap_whats_next", properties: ["step": "pick", "count": Self.bucket(shown?.upNext.count ?? 0)])
    selected = row.id
    graph.bring(row.id)
  }

  // Roadmap · iOS 04.5: Fit shows the whole roadmap and nothing else, until a tap on the canvas brings the bars back.
  func fit() {
    telemetry.event("roadmap_graph_fit", properties: ["step": "open"])
    graph.fit()
  }

  func unfit() {
    telemetry.event("roadmap_graph_fit", properties: ["step": "close"])
    graph.unfit()
  }

  // A count as an event carries it, in the web's buckets (`countBucket`).
  static func bucket(_ count: Int) -> String {
    if count <= 1 { return String(max(0, count)) }
    if count <= 5 { return "2-5" }
    return count <= 20 ? "6-20" : "21+"
  }

  // What the view of one type in one scope holds, nil until it has loaded.
  func snapshot(_ scope: ScopeRef, _ type: String) throws -> RecordsView.Snapshot? {
    let key = ViewKey(scope: scope, type: type)
    let view = try views[key] ?? records(scope, type)
    views[key] = view
    guard case .loaded(let snapshot) = view.state else { return nil }
    return snapshot
  }

  // A read of the phone's copy that failed: the room says so and offers Try Again.
  func fail(_ error: any Error) {
    phase = .failed
    report(read: error)
  }

  // Each kind of failed read reports once a launch, since a read runs with every change; the engine reports a view's own.
  func report(read error: any Error) {
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
  func write(_ acts: [AnyActAction<RoadmapRefusal>], as name: String) -> Written<[any Sendable]> {
    told(as: name) {
      switch try runner.runComposed(acts) {
      case .committed(let results, let receipt): .committed(results, receipt)
      case .unchanged: .unchanged
      case .refused(_, let refusal): .refused(refusal)
      }
    }
  }

  // The same door for a draft's one save. The kit saves a draft that keeps an Undo as an act of one segment and answers
  // that segment's receipt, which the door answers as the act's again.
  func write<E: Draftable>(_ draft: inout Draft<E>, as name: String) -> Written<Void> {
    told(as: name) {
      switch runner.save(&draft, SaveDraft<E, RoadmapRefusal>.self) {
      case .saved(let receipt?): return .committed((), receipt.act(in: draft.scope))
      case .saved(nil): return .unchanged
      case .refused(let refusal): return .refused(refusal)
      case .failed(let error): throw error
      }
    }
  }

  // What the door tells of a write, whoever asked for it: a refusal by its kind, said in the band where it is a limit,
  // and a commit that failed, which is reported and shows nothing, since the phone's copy stands as it was.
  func told<Result>(as name: String, _ run: () throws -> Written<Result>) -> Written<Result> {
    guard owns else { return .unchanged }
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
    question = .step(row, by: door, followers: open.effects(of: [row.id]).follow.count)
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
    case .steps(let rows, _):
      telemetry.event("roadmap_board_delete", properties: ["step": confirmed ? "confirm" : "cancel", "view": "board"])
      if confirmed { selection?.delete(rows) }
    case .roadmap(let roadmap, let place, let openers):
      telemetry.event("roadmap_deletion", properties: ["step": confirmed ? "confirm" : "cancel"])
      if confirmed { delete(roadmap, from: place, taking: openers) }
    }
  }

  // Delete: the step alone goes, held by the engine, and its receipt keeps Undo for the hold. The room stands on the
  // Board once it is written, the form that asked closed.
  func delete(_ row: Row, by door: Door) {
    guard case .open(let open) = phase else { return }
    if open.effects(of: [row.id]).takesEveryStart {
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

  // New Step, at the Board's foot, on a roadmap with no step and on a Find that matched nothing, raises the form on a
  // new draft, whose step takes its id now, named as Find's words where Find asked. A roadmap already at the steps the
  // rule book's registry lets it hold refuses where the gesture is made, in the band, and no form opens (10.6a). A read of
  // how many it holds that fails opens none either, and reports as the room's failed reads do.
  func newStep(from door: StepDraft.Door, named typed: String = "") {
    guard case .open(let open) = phase else { return }
    do {
      if try runner.read(open.id.tree, { (scope: Reader) throws -> Capacity in try scope.repository(RoadmapStep.self).capacity() }).isFull {
        telemetry.event("roadmap_write_refused", properties: ["write": "CreateNode", "refusal": "full"])
        show(Band(refused: .full))
        return
      }
    } catch {
      report(read: error)
      return
    }
    let made = StepDraft(new: runner.mint(RoadmapStep.self, in: open.id.tree), of: open.id, by: door, in: self)
    if !typed.isEmpty { made.name = typed }
    draft = made
    telemetry.event("roadmap_board_create", properties: ["step": "open", "door": door.rawValue, "view": view(of: open).rawValue])
  }

  // Edit, in a step page's bar or a Board row's long-press menu, raises the form over the screen on a draft of the step.
  func edit(_ step: OpenStep, from door: StepDraft.Door = .page) {
    guard case .open(let open) = phase else { return }
    draft = StepDraft(editing: step, of: open.id, by: door, in: self)
    telemetry.event("roadmap_step_edit", properties: ["step": "open", "door": door.rawValue])
  }

  // Open in Graph, in a Board row's long-press menu or a step page's … menu: the room shows the Graph with the step
  // selected and brought into view, whose picture may still be laid out (02.4, 03.7).
  func openInGraph(_ step: String, from door: Door) {
    guard let row = shown?.step(step) else { return }
    path = []
    telemetry.event("roadmap_board_step_action", properties: ["surface": door == .page ? "document" : "board", "action": "openInGraph"])
    show(.graph)
    selected = row.id
    graph.bring(row.id)
  }

  // View Branch, in a step page's … menu: the room returns to the Board, which stays in the step's branch (02.9, 03.7).
  func viewBranch(of step: String) {
    guard shown?.step(step) != nil else { return }
    path = []
    telemetry.event("roadmap_board_step_action", properties: ["surface": "document", "action": "viewBranch"])
    reading.view(branch: step)
    show(.board)
  }

  // Select in a row's long-press menu, with that row chosen, or Select Steps in the Board's tool, with none: the Board
  // selects several (02.10). A choice that starts on every starting step says at once why Delete is dimmed (02.12).
  func startSelecting(_ step: String?, from door: BoardSelection.Door) {
    guard let shown, selection == nil else { return }
    let started = BoardSelection(Set(step.map { [$0] } ?? []), of: shown.id, in: self)
    selection = started
    telemetry.event("roadmap_board_select", properties: ["step": "start", "door": door.rawValue])
    if started.takesEveryStart { started.refuseDelete() }
  }

  // The checkmark, or an act on the steps chosen, ends the selection.
  func endSelecting(via way: BoardSelection.Ending) {
    guard selection != nil else { return }
    selection = nil
    telemetry.event("roadmap_board_select", properties: ["step": "end", "via": way.rawValue])
  }

  // A roadmap chosen in the title menu or in All Roadmaps is the open one, in the view it was last switched to, and
  // the one the phone remembers; the time to a Graph's first frame runs from the tap. Choosing the open one only
  // returns to the view it shows.
  func open(_ roadmap: String, from place: Place) {
    path = []
    if case .open(let shown) = phase, shown.listed.id.utf8.elementsEqual(roadmap.utf8) { return }
    guard roadmaps.contains(where: { $0.id.utf8.elementsEqual(roadmap.utf8) }) else { return }
    arriving = nil
    links?.forkArriving = nil
    phone.set(roadmap, forKey: Self.lastOpen)
    telemetry.event("roadmap_sheet", properties: ["step": "switch", "door": place.rawValue])
    observe()
    if shown.map({ view(of: $0) == .graph }) ?? false { graph.opened() }
  }

  // The first search of All Roadmaps in one visit is told.
  func searchedRoadmaps() {
    telemetry.event("roadmap_sheet", properties: ["step": "search"])
  }

  // New Roadmap, in the title menu, on All Roadmaps and in the room that holds no roadmap, opens the one sheet that
  // names it, on a new draft.
  func nameRoadmap(from place: Place) {
    newRoadmap = NewRoadmapDraft(in: self)
    telemetry.event("roadmap_sheet", properties: ["step": "new", "door": place.rawValue])
  }

  // A name as the web's room takes one before the domain reads it (`NewTreeBirth.plant`, `ReplicaSession.renameTree`):
  // without the kit's whitespace around it, which is ECMAScript's.
  static func name(typed: String) -> String { TextSpec.trimmed(typed) }

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

  // The band's Undo: a removal the engine holds is cancelled while it is held, and any other act, or a step's delete whose
  // hold has ended, is taken back by the kit's Undo of it. The engine then keeps nothing more of the act, nor of its Undo,
  // which the room never redoes. A roadmap brought back is the open one again where it was. An Undo that brought nothing
  // back, a roadmap's delete or a workspace removal past its hold, an act the engine keeps no Undo of, one whose every
  // restore a write elsewhere stood in the way of, or one the domain refuses where it is asked, as a kind's removal whose
  // hue another kind has come to wear, says so in the band's place, with a warning (02.10d, 06.5c).
  func undo() {
    guard root === self else { return root.undo() }
    if let write = band?.coach {
      bandTime?.cancel()
      stackBand = nil
      return coach?.undo(write) ?? ()
    }
    guard let receipt = band, let undo = receipt.undo else { return }
    bandTime?.cancel()
    stackBand = nil
    do {
      var taken = false
      if undo.held { taken = try runner.cancelHeld(undo.gesture) }
      if !taken && (!undo.held || undo.act.outlivesHold) {
        switch try runner.undo(undo.handle) {
        case .cancelled(_, let inverse, let changed), .pending(_, let inverse, let changed), .settled(_, let inverse, let changed, _, _):
          taken = changed
          try runner.release(inverse)
        case .unavailable: break
        }
      }
      try runner.release(undo.gesture)
      if taken { for room in rooms { room.removedKinds = room.removedKinds.filter { $0.value != undo.gesture } } }
      switch undo.act {
      case .step(let act): telemetry.event("roadmap_board_undo", properties: ["act": act, "outcome": taken ? "ok" : "unavailable"])
      case .workspace(let act):
        telemetry.event("roadmap_board_workspace", properties: ["action": "undo", "act": act, "outcome": taken ? "ok" : "unavailable"])
      case .roadmapDelete(let reopens):
        telemetry.event("roadmap_deletion", properties: ["step": "undo", "outcome": taken ? "cancelled" : "released"])
        if taken, let reopens { arriving = reopens }
      // Roadmap Coach §13 names no event of a conversation's delete or its Undo.
      case .conversation: break
      }
      if !taken { show(Band(unrestored: receipt.says)) }
    } catch {
      report(error, write: "undo")
    }
    offerLanding()
  }

  // A band stands in place of the one showing, until its time is over. A landing line's time runs once its band is drawn
  // (`seen`).
  func show(_ band: Band) {
    guard root === self else { return root.show(band) }
    letBandGo()
    stackBand = band
    if case .landed = band.says { return }
    time(band)
  }

  // The band's time: it leaves once its time is over.
  func time(_ band: Band) {
    bandTime?.cancel()
    bandTime = Task { [weak self, wait] in
      guard (try? await wait(band.lasts)) != nil, !Task.isCancelled else { return }
      self?.endBand()
    }
  }

  // The band leaves with its Undo untaken: its time is over, the person sent it away, or the screen took it, and a line
  // waiting takes its place.
  func endBand() {
    guard root === self else { return root.endBand() }
    letBandGo()
    offerLanding()
  }

  // The band leaves, as a newer one replaces it or the app leaves the front: the engine keeps nothing more for an Undo no
  // one can ask.
  func letBandGo() {
    bandTime?.cancel()
    let undo = stackBand?.undo
    let write = stackBand?.coach
    stackBand = nil
    if let undo { forget(undo.gesture) }
    if let write { coach?.forget(write) }
  }

  // Coach's direct write (11.3, 11.18): the band is its receipt, a completion in the Board's own words, with its Undo.
  func offer(_ write: CoachWrite) {
    guard root === self else { return root.offer(write) }
    guard write.facts.change == .completed, case .open(let open) = phase, open.id.description == write.receipt.treeId else {
      return show(Band(.coachWrote(write.facts), coach: write))
    }
    let upNext = open.graph.unlocks(write.receipt.nodeId)
    show(Band(.completed(step: write.facts.label, upNext: upNext.compactMap { open.tree.step($0)?.label }, inPlace: false), coach: write, arrived: upNext))
  }

  // The engine lets go of every delete it holds, as the app leaves the front or the account changes: a note open on the
  // screen of any room on the stack is saved as it stands, the deepest first, and the band goes with its Undo.
  func flush() {
    for room in rooms.reversed() { room.note?.save() }
    root.letBandGo()
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
  // A roadmap at its cap, the one limit a write meets that the band words.
  var isFull: Bool {
    guard case .full = self else { return false }
    return true
  }

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

// One observation of the notification center on the main queue, which ends as its holder lets it go.
nonisolated final class NotificationWatch {
  let token: any NSObjectProtocol

  init(_ name: Notification.Name, _ heard: @escaping @MainActor () -> Void) {
    token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in MainActor.assumeIsolated(heard) }
  }

  deinit { NotificationCenter.default.removeObserver(token) }
}
