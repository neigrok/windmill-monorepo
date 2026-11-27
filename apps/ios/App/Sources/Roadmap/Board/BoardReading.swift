import Foundation
import Observation
import RoadmapDomain
import SyncEngine

// What the Board asks of the open roadmap beyond its groups at rest (Roadmap · iOS 02.5 to 02.9): how Up next and Locked
// are ordered, the kinds it shows, a branch it stays in, and the words Find looks for. Which steps a query keeps and in
// what order is the domain's `BoardRead`. A kind the filter shows stays shown once no step wears it, so the Board then
// shows nothing and says so (02.6b) until the filter is cleared. It lasts the visit, as the web's room keeps its query:
// another roadmap opening, or a launch, starts it over, and nothing of it is stored. The words typed change at every
// key, so only the Board's list reads them. The room tells it each read of the open roadmap and the view it shows: Find
// is the Board's, so it ends once the Graph is shown, and a step the form made is shown once the phone's copy holds it.
@Observable @MainActor
final class BoardReading {
  // The Board under the query: its groups with the steps kept, what its first rows say narrows it, and what narrows it
  // where nothing is left to show.
  struct Shown {
    let groups: [RoadmapModel.Group]
    // The kinds the filter shows, by their names, and the step whose branch the Board stays in.
    let kinds: [String]
    let branch: RoadmapModel.Row?
    // What a Board left with nothing offers to clear: Find's words, the kinds, or both; none where neither narrows.
    let recovery: BoardRead.Recovery?
    // Find narrows the Board, so each group that holds a match opens.
    let finding: Bool
  }

  // Where a Clear was pressed: the first row that says what is shown, or the Board left with nothing to show.
  enum Place: String {
    case row, empty
  }

  let telemetry: any Telemetry
  private(set) var sort = BoardQuery.Sort.roadmap
  // The hues the filter shows; none shows every kind.
  private(set) var kinds: [String] = []
  // The step whose branch the Board stays in: it, what it needs and what it opens.
  private(set) var branch: String?
  // Find is up, with its field at the foot. Closed, by its own close or by the Board leaving the screen, it tells the
  // words it last looked for where no search told them, and then looks for nothing.
  var finds = false {
    didSet {
      guard oldValue, !finds else { return }
      searched()
      (finding, looked, told) = ("", "", "")
    }
  }
  // The words Find looks for, as typed.
  var finding = "" {
    didSet {
      if needle.isEmpty { foldedWhileFinding = [] }
      else { looked = needle }
    }
  }
  // The groups a header folded while Find narrows: the person's own fold of the Board at rest stays as it was.
  var foldedWhileFinding: Set<BoardRead.Column.Name> = []
  // The words Find last looked for, kept as the field empties, which the system's close may do before it closes Find;
  // and the words last told as searched, so a search is told once.
  @ObservationIgnored var looked = ""
  @ObservationIgnored var told = ""
  // The view the room shows of the open roadmap: Find is the Board's, so it ends once the Board is not shown.
  @ObservationIgnored private(set) var lens = RoadmapModel.Lens.board {
    didSet { if lens != .board { finds = false } }
  }
  // The step the form made, which the Board shows once the phone's copy holds it, whether it then draws a list or
  // nothing left to show.
  @ObservationIgnored private(set) var made: String?

  init(telemetry: any Telemetry) {
    self.telemetry = telemetry
  }

  // What Find looks for without the blanks around it, as the Board says it; the domain's read trims the words itself.
  var needle: String { finding.trimmingCharacters(in: .whitespacesAndNewlines) }

  // The Sort and filter tool says so in its symbol while it narrows: another order, or a kind filter. A branch is the
  // first row's alone.
  var narrows: Bool { sort != .roadmap || !kinds.isEmpty }

  // The Board as the query keeps it. With nothing asked it is the open roadmap's own groups; otherwise the domain reads
  // the roadmap under the query, and each step kept is the row the open roadmap holds for it.
  func shown(in open: RoadmapModel.OpenRoadmap) -> Shown {
    let query = BoardQuery(sort: sort, kinds: kinds, search: finding, branch: branch)
    guard narrows || !needle.isEmpty || branch != nil else {
      return Shown(groups: open.groups, kinds: [], branch: nil, recovery: nil, finding: false)
    }
    let read = BoardRead(open.graph, query)
    let groups = [BoardRead.Column.Name.upNext, .locked, .done].compactMap { (name: BoardRead.Column.Name) -> RoadmapModel.Group? in
      let rows = (read.columns.first { $0.name == name }?.ids ?? []).compactMap { (step: String) -> RoadmapModel.Row? in open.step(step) }
      return rows.isEmpty ? nil : RoadmapModel.Group(id: name, rows: rows)
    }
    let names = kinds.map { (hue: String) -> String in open.legend.wearer(of: hue)?.name ?? RoadmapModel.Row.hue(hue) ?? hue }
    return Shown(groups: groups, kinds: names, branch: read.branch.flatMap { open.step($0) }, recovery: read.recovery, finding: !needle.isEmpty)
  }

  // The Sort picker's choice: how Up next and Locked are ordered. Done stays newest completed first.
  func pick(_ sort: BoardQuery.Sort) {
    guard sort != self.sort else { return }
    self.sort = sort
    telemetry.event("roadmap_board_sort", properties: ["sort": sort.rawValue])
  }

  // A kind's toggle under Filter by Kind: shown or not. With none ticked every kind is shown.
  func toggle(_ hue: String) {
    kinds = kinds.contains(hue) ? kinds.filter { $0 != hue } : kinds + [hue]
    telemetry.event("roadmap_board_filter", properties: ["count": RoadmapModel.bucket(kinds.count)])
  }

  // Clear on the first row, or Clear Filters on a Board the filter left with nothing: every kind is shown again.
  func clearKinds(from place: Place) {
    kinds = []
    telemetry.event("roadmap_board_clear", properties: ["what": "kinds", "from": place.rawValue])
  }

  // View Branch on a step's page: the Board stays in that step's branch.
  func view(branch step: String) {
    branch = step
  }

  // Clear on the branch's row.
  func clearBranch() {
    branch = nil
    telemetry.event("roadmap_board_branch", properties: ["action": "clear"])
  }

  // Find's search key, or Find closed on words it looked for: a search is told once, by no word of it.
  func searched() {
    guard !looked.isEmpty, looked != told else { return }
    told = looked
    telemetry.event("roadmap_board_search")
  }

  // Create in the step form: the step it made is shown once the phone's copy holds it.
  func reveal(_ step: String) {
    made = step
  }

  // The room read the open roadmap, which it shows in `lens`. A step the form made that the copy now holds is shown: each
  // part of the query that alone hides it is cleared, as the domain reads them (`BoardRead.revealing`, which the web's room
  // reads too), and the order stays.
  func read(_ open: RoadmapModel.OpenRoadmap, shown lens: RoadmapModel.Lens) {
    self.lens = lens
    guard let step = made, open.step(step) != nil else { return }
    made = nil
    for part in BoardRead(open.graph, BoardQuery(kinds: kinds, search: needle, branch: branch, reveal: step)).revealing ?? [] {
      switch part {
      case .kinds: kinds = []
      case .search: finding = ""
      case .branch: branch = nil
      }
    }
  }

  // Another roadmap opened: the Board asks nothing of it yet, and Find ends.
  func forget() {
    (sort, kinds, branch, finds, foldedWhileFinding, made) = (.roadmap, [], nil, false, [], nil)
  }
}
