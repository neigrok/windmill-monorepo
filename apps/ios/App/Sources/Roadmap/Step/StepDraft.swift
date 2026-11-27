import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// The step form's draft (Roadmap · iOS 05.1 to 05.8, 07.6): what a person sets of a step before Create or Save writes it,
// as one gesture through the room's write door. A new step takes its id as the form opens; a draft of a step starts from
// what its page shows. What the form offers is read from the open roadmap as it stands: the six kinds, the steps a list
// may take and the ones that would close a loop, and the group the step would land in. What a name, a description, a
// link between steps and a link the step shares may be is the domain's, and so is every refusal of the save.
@Observable @MainActor
final class StepDraft: Identifiable {
  // A step's id as the domain's acts take it. The draft is itself identified, as the sheet it stands in asks, so inside
  // it `ID` alone names the draft's own identity and the kit's is written out.
  typealias StepID = DomainKit.ID<RoadmapStep>

  // The gesture that raised the form, as its events name it: the foot's +, New Step on a roadmap with no step or on a
  // Find that matched nothing, Edit on a step's page, or Edit in a Board row's long-press menu.
  enum Door: String {
    case foot, empty, find, page, menu
  }

  // The two sides a step is placed from, each a list of steps: the ones it requires, and the ones it opens.
  enum Side: String {
    case requires, opens
  }

  // What a footer of the form says in ink: a name typed and cleared, or a step that would close a loop in a list.
  enum Refusal: Equatable {
    case name
    case loop(StepID, Side)
  }

  // A link the step shares with everyone who reads it: its address and the title it is given.
  struct SharedLink: Equatable {
    let url: String
    let label: String
  }

  // What the form sets of a step.
  struct Fields: Equatable {
    var name = ""
    var description = ""
    var kind = StepDraft.newKind
    // In the order chosen: a new step is placed after the first step it requires.
    var requires: [StepID] = []
    var opens: [StepID] = []
    // In the step's order: a link added joins at the end.
    var links: [SharedLink] = []
    // The roadmap the step opens; none for an ordinary step, and none for one that owns a subtree, which no form changes.
    var roadmap: String?
  }

  // A list's steps as it groups them: the ones chosen as it opened, every other step it may take, and the ones that
  // would close a loop.
  struct Choices {
    let selected: [RoadmapModel.Row]
    let all: [RoadmapModel.Row]
    let blocked: [RoadmapModel.Row]
  }

  // A new draft starts on Sky, as the web's does (`DEFAULT_DRAFT_COLOR`).
  static let newKind = "sky"

  unowned let room: RoadmapModel
  // The roadmap the draft writes to.
  let tree: DomainKit.ID<RoadmapEntry>
  let step: StepID
  let isNew: Bool
  let door: Door
  // What the step held as the form opened; a new step's holds nothing a person set.
  let base: Fields
  private(set) var fields: Fields
  private(set) var refusal: Refusal?
  // The subtree the step owns, which the form names and changes nothing of.
  private(set) var subtree: RoadmapModel.Opened?
  // Discard draft? stands over Cancel.
  var asksDiscard = false

  init(new step: StepID, of tree: DomainKit.ID<RoadmapEntry>, by door: Door, in room: RoadmapModel) {
    self.room = room
    self.tree = tree
    self.step = step
    self.door = door
    isNew = true
    base = Fields()
    fields = base
  }

  // A step's name is edited from its label without the blanks around it, so an untouched name writes nothing.
  init(editing page: RoadmapModel.OpenStep, of tree: DomainKit.ID<RoadmapEntry>, by door: Door, in room: RoadmapModel) {
    self.room = room
    self.tree = tree
    step = StepID(RecordID(page.row.id))
    self.door = door
    isNew = false
    base = Fields(name: RoadmapModel.name(typed: page.row.step.label), description: page.row.step.description, kind: page.row.step.color,
                  requires: page.requires.map { StepID(RecordID($0.id)) }, opens: page.opens.map { StepID(RecordID($0.id)) },
                  links: page.row.step.links.map { SharedLink(url: $0.url, label: $0.label) },
                  roadmap: page.row.opening.flatMap { $0.owned ? nil : $0.tree })
    subtree = page.row.opening.flatMap { $0.owned ? $0 : nil }
    fields = base
  }

  // The roadmap the draft writes to, while the room has it open and, for a draft of a step, still holds the step.
  var open: RoadmapModel.OpenRoadmap? {
    guard case .open(let open) = room.phase, open.id == tree, isNew || open.step(step.description) != nil else { return nil }
    return open
  }

  // The name as it is written: without the blanks around it, as the web's editor takes one (`CreateStepRequest`,
  // `SaveFieldRequest`).
  var label: String { RoadmapModel.name(typed: fields.name) }

  // The draft keeps no more of a text than the domain takes. A name typed and then cleared is refused in its footer,
  // which leaves at the first character (05.6a): a step needs a name, as the web's editor rules (`StepDraft.validate`).
  var name: String {
    get { fields.name }
    set {
      let named = !label.isEmpty
      fields.name = RoadmapSpecs.label.holding(newValue)
      if named && label.isEmpty { refuse(.name) }
      if !label.isEmpty && refusal == .name { refusal = nil }
    }
  }

  var description: String {
    get { fields.description }
    set { fields.description = RoadmapSpecs.description.holding(newValue) }
  }

  var kind: String {
    get { fields.kind }
    set { fields.kind = newValue }
  }

  // The Roadmap row's choice, from the attach list.
  var roadmap: String? {
    get { fields.roadmap }
    set { fields.roadmap = newValue }
  }

  // Whether the draft holds anything a save would write.
  var isChanged: Bool {
    label != base.name || fields.description != base.description || fields.kind != base.kind
      || Set(fields.requires) != Set(base.requires) || Set(fields.opens) != Set(base.opens) || fields.links != base.links
      || fields.roadmap != base.roadmap
  }

  // The links the step shares, as the draft holds them: every one, whatever its address, so a save drops none.
  var links: [SharedLink] { fields.links }

  // Add Link is offered while the step holds fewer links than the domain takes.
  var takesLink: Bool { fields.links.count < RoadmapSpecs.links.max }

  // Add, in the link form: the address with its title, without the blanks around it, joins the draft.
  func add(link address: LinkAddress, titled typed: String) {
    guard takesLink else { return }
    fields.links.append(SharedLink(url: address.url.absoluteString, label: RoadmapModel.name(typed: typed)))
  }

  // A link's swipe in the form: it leaves the draft.
  func removeLink(at place: Int) {
    guard fields.links.indices.contains(place) else { return }
    fields.links.remove(at: place)
  }

  // Create is offered once the step has a name, and Save once a named step is changed.
  var commits: Bool { !label.isEmpty && (isNew || isChanged) }

  // The write's name in the room's events and reports: the web's word for the gesture.
  var write: String { isNew ? "CreateNode" : "EditNode" }

  // The six kinds, as the open roadmap's legend lists them for every step.
  var kinds: [RoadmapLegend.Choice] { open?.legend.choices ?? [] }

  // The steps the draft requires that are not done, in the order chosen.
  var unmet: [RoadmapModel.Row] {
    guard let open else { return [] }
    return fields.requires.compactMap { (required: StepID) -> RoadmapModel.Row? in open.step(required.description) }
      .filter { $0.card.column != .done }
  }

  // The group the step would stand in once written, as the web's editor reads it (`StepDraft.placement`): a done step
  // stays Done, and any other is Locked while a step it requires is not done.
  var group: BoardRead.Column.Name {
    if !isNew, open?.step(step.description)?.card.column == .done { return .done }
    return unmet.isEmpty ? .upNext : .locked
  }

  // Whether the form says where the step will land: always of a new step, and of a step only where the change would
  // move it to another group (05.8).
  var moves: Bool { isNew || open?.step(step.description)?.card.column != group }

  // The steps a list holds checked, in the order chosen.
  func chosen(_ side: Side) -> [StepID] { side == .requires ? fields.requires : fields.opens }

  // The names of the steps a list holds checked, in the roadmap's order: what its row says on the form.
  func names(_ side: Side) -> [String] {
    guard let open else { return [] }
    let held = Set(chosen(side))
    return open.tree.index.ids.filter { held.contains(StepID(RecordID($0))) }.compactMap { open.step($0)?.name }
  }

  // Whether the roadmap holds another step for a list to offer: with none, Requires and Opens stand disabled.
  var offersSteps: Bool {
    open?.tree.index.ids.contains { !$0.utf8.elementsEqual(step.description.utf8) } ?? false
  }

  // The steps a link with the draft's step would close a loop through, over the roadmap as the draft would leave it: a
  // step cannot require what comes after the steps it opens, nor open what comes before the steps it requires. The
  // domain reads them (`EffectsRead.loops`, over the draft's sides), as the web's editor does (`blockedPrerequisites`),
  // which has no Opens.
  func blocked(_ side: Side) -> Set<StepID> {
    let links = EffectsRead.Links(requires: chosen(.requires).map(\.description), opens: chosen(.opens).map(\.description))
    guard let loops = open?.effects(of: [step.description], links: links).loops else { return [] }
    return Set((side == .requires ? loops.requires : loops.opens).filter { !$0.utf8.elementsEqual(step.description.utf8) }.map { StepID(RecordID($0)) })
  }

  // A list as it groups its steps (05.3, 05.4): the ones chosen as it opened, which a search never hides; every other
  // step it may take, done first, then up next, then locked, each in the roadmap's order, as the web's picker lists
  // them; and the ones that would close a loop. A search keeps the steps whose name holds the words typed, in any case.
  func choices(of side: Side, chosenAtOpening: [StepID], finding query: String) -> Choices {
    guard let open else { return Choices(selected: [], all: [], blocked: []) }
    let others = open.tree.index.ids.filter { !$0.utf8.elementsEqual(step.description.utf8) }
      .compactMap { (other: String) -> RoadmapModel.Row? in open.step(other) }
    let ordered = [BoardRead.Column.Name.done, .upNext, .locked].flatMap { (column: BoardRead.Column.Name) -> [RoadmapModel.Row] in
      others.filter { $0.card.column == column }
    }
    let opened = Set(chosenAtOpening)
    let loops = blocked(side)
    let sought = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let found = { (row: RoadmapModel.Row) -> Bool in sought.isEmpty || row.name.lowercased().contains(sought) }
    let id = { (row: RoadmapModel.Row) -> StepID in StepID(RecordID(row.id)) }
    return Choices(selected: ordered.filter { opened.contains(id($0)) },
                   all: ordered.filter { !opened.contains(id($0)) && !loops.contains(id($0)) && found($0) },
                   blocked: ordered.filter { !opened.contains(id($0)) && loops.contains(id($0)) && found($0) })
  }

  // A tap on a step in a list takes it or drops it in place. A step that would close a loop is not taken, and its
  // group's footer names it (05.6b).
  func toggle(_ row: RoadmapModel.Row, in side: Side) {
    let tapped = StepID(RecordID(row.id))
    var held = chosen(side)
    if let place = held.firstIndex(of: tapped) {
      held.remove(at: place)
    } else if blocked(side).contains(tapped) {
      refuse(.loop(tapped, side))
      return
    } else {
      held.append(tapped)
    }
    if case .loop = refusal { refusal = nil }
    if side == .requires { fields.requires = held } else { fields.opens = held }
  }

  // A list left takes the loop it refused with it: the form itself says only what a save was refused.
  func listClosed() {
    if case .loop = refusal { refusal = nil }
  }

  // The form's own refusal stands in its footer and is told by its kind, as a write the room refuses is.
  func refuse(_ refused: Refusal) {
    refusal = refused
    room.telemetry.event("roadmap_write_refused", properties: ["write": write, "refusal": refused == .name ? "noName" : "loop"])
  }

  // The draft's one save, as the acts of the domain it is, each reading what the ones before it wrote. A new step is
  // created after the first step it requires, linked from each, then leads to each step it opens, and last opens the
  // roadmap chosen. A step is changed in the fields that differ, as the web's edit is (`editGesture`), its shared links
  // written whole where one was added or removed; the steps it opens no more let go of it; it takes and drops what it
  // requires; it leads to the steps it newly opens, so the domain reads every loop over the links as they will stand; and
  // last it opens another roadmap, or none.
  var acts: [AnyActAction<RoadmapRefusal>] {
    let (tree, step) = (tree, step)
    let leads = { (follower: StepID) -> AnyActAction<RoadmapRefusal> in
      AnyActAction(ChangePrerequisites(tree: tree, step: follower, add: [step]))
    }
    let shared = fields.links.map { (link: SharedLink) -> RoadmapDomain.Step.Link in RoadmapDomain.Step.Link(url: link.url, label: link.label) }
    if isNew {
      let made = RoadmapStep.Changes(label: label, color: fields.kind, description: fields.description, links: shared.isEmpty ? nil : shared)
      let create: [AnyActAction<RoadmapRefusal>] = [AnyActAction(CreateStep(tree: tree, step: made, prerequisites: fields.requires, id: step))]
      let opens = fields.roadmap.map { [AnyActAction<RoadmapRefusal>(PointStep.set(tree: tree, step: step, opens: DomainKit.ID(RecordID($0))))] } ?? []
      return create + fields.opens.map(leads) + opens
    }
    var acts: [AnyActAction<RoadmapRefusal>] = []
    let changes = RoadmapStep.Changes(label: label == base.name ? nil : label, color: fields.kind == base.kind ? nil : fields.kind,
                                      description: fields.description == base.description ? nil : fields.description,
                                      links: fields.links == base.links ? nil : shared)
    if changes.label != nil || changes.color != nil || changes.description != nil || changes.links != nil {
      acts.append(AnyActAction(ChangeStep(tree: tree, step: step, changes: changes)))
    }
    for follower in base.opens where !fields.opens.contains(follower) {
      acts.append(AnyActAction(ChangePrerequisites(tree: tree, step: follower, remove: [step])))
    }
    let taken = fields.requires.filter { !base.requires.contains($0) }
    let dropped = base.requires.filter { !fields.requires.contains($0) }
    if !taken.isEmpty || !dropped.isEmpty { acts.append(AnyActAction(ChangePrerequisites(tree: tree, step: step, add: taken, remove: dropped))) }
    acts += fields.opens.filter { !base.opens.contains($0) }.map(leads)
    guard fields.roadmap != base.roadmap else { return acts }
    let pointer = fields.roadmap.map { PointStep.set(tree: tree, step: step, opens: DomainKit.ID(RecordID($0))) } ?? PointStep.clear(tree: tree, step: step)
    return acts + [AnyActAction(pointer)]
  }

  // Create or Save: the draft's one write. Written, the form closes and the band holds its Undo; a new step's group
  // opens on the Board, which shows the step washed, clearing what of its query hides it once the phone's copy holds
  // the step. A save the roadmap already holds closes the form too. Refused, the
  // form stays: a loop the domain found is named in the footer by the first step chosen that closes one, and any other
  // refusal is the door's to tell. A commit that failed leaves the form as it was.
  func save() {
    guard commits, open != nil else { return }
    let lands = group
    switch room.write(acts, as: write) {
    case .committed(_, let receipt):
      room.draft = nil
      if fields.roadmap != base.roadmap {
        let step = fields.roadmap == nil ? "detach" : base.roadmap == nil ? "attach" : "change"
        room.telemetry.event("roadmap_tree_attach", properties: ["step": step, "door": "form"])
      }
      if isNew {
        room.folded.remove(lands)
        room.reading.reveal(step.description)
        room.telemetry.event("roadmap_board_create", properties: ["step": "saved", "column": lands.rawValue])
        room.show(RoadmapModel.Band(.created(step: label, in: lands), of: receipt, act: .step("create"), arrived: [step.description]))
      } else {
        room.telemetry.event("roadmap_board_edit", properties: [
          "step": "saved", "name": String(label != base.name), "description": String(fields.description != base.description),
          "kind": String(fields.kind != base.kind), "prerequisites": String(Set(fields.requires) != Set(base.requires)),
          "opens": String(Set(fields.opens) != Set(base.opens)), "links": String(fields.links != base.links),
          "roadmap": String(fields.roadmap != base.roadmap),
        ])
        room.show(RoadmapModel.Band(.saved(step: label), of: receipt, act: .step("edit")))
      }
    case .unchanged: room.draft = nil
    case .refused(.invalid(let violation)) where violation.rule == RoadmapChecks.cycle:
      for side in [Side.requires, .opens] {
        let loops = blocked(side)
        guard let closing = chosen(side).first(where: { loops.contains($0) }) else { continue }
        refusal = .loop(closing, side)
        break
      }
    case .refused, .failed: break
    }
  }

  // Cancel, or the sheet sent away: a changed draft asks once, and an unchanged one closes with nothing written.
  func cancel() {
    guard !isChanged else {
      asksDiscard = true
      return
    }
    close(told: "cancel")
  }

  // Discard, the question's one answer: the draft goes with nothing written.
  func discard() {
    close(told: "discard")
  }

  // The form closes unwritten, told as the web tells its composer's leaving, or its editor's for a draft of a step.
  func close(told left: String) {
    room.draft = nil
    room.telemetry.event(isNew ? "roadmap_board_create" : "roadmap_step_edit", properties: ["step": left, "door": door.rawValue])
  }
}
