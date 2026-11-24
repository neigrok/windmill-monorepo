import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// New Roadmap's draft (Roadmap · iOS 01.6, 01.8, 01.8b, 01.8c): a name, and a plan read from a copied text or a `.md` or
// `.txt` file by the plan grammar before anything is planted. Create plants a blank roadmap, or the plan, by the domain's
// `CreateRoadmap` on the phone's copy, then marks the steps the plan brings done, and the room opens it; the engine keeps
// no Undo of a birth. The name comes from the plan's first line unless one was typed, and Clear returns to Start from.
@Observable @MainActor
final class NewRoadmapDraft: Identifiable {
  // Where a plan came from, as its events name it: the system's Paste button, or a file the importer handed back.
  enum Source: String {
    case paste = "import", file
  }

  // A plan read back: the grammar's read and where it came from.
  struct Read {
    let plan: RoadmapPlan
    let source: Source
  }

  unowned let room: RoadmapModel
  // The field holds no more of a name than the domain takes.
  var name = "" {
    didSet { if name != RoadmapSpecs.title.holding(name) { name = RoadmapSpecs.title.holding(name) } }
  }
  private(set) var read: Read?
  // The name a plan gave the field, which Clear takes back where it still stands.
  private(set) var named: String?
  // The file the importer handed back that the phone could not read, by its name.
  private(set) var unread: String?

  init(in room: RoadmapModel) {
    self.room = room
  }

  // The door Create plants by, as its events name it.
  var door: String { read?.source.rawValue ?? "blank" }

  // What Create plants under the name the field holds: the plan read back, or with none the empty plan, whose one step
  // the name names, as a blank roadmap's. None while neither the field nor the plan names it.
  var planting: RoadmapPlan.Planting? { (read?.plan ?? RoadmapPlan(reading: "", over: Self.genesis)).planting(named: name) }

  // Create needs a name: the field's, or a plan's own.
  var creates: Bool { planting != nil }

  // The plan's steps in the states they will land in: as Create would plant them, or, before the plan is named, as it
  // stands.
  var landing: [RoadmapPlan.Landing] { planting?.landing ?? read?.plan.landing ?? [] }

  // The legend a new roadmap starts from, which a plan is read over.
  static let genesis = RoadmapRules.genesisKinds.map { RoadmapPlan.Kind(id: $0.id.description, hue: $0.hue, label: $0.label, description: $0.description) }

  // A plan read back from the text the Paste button handed over, or a file's: an empty field takes the plan's name.
  func read(_ text: String, from source: Source) {
    let plan = RoadmapPlan(reading: text, over: Self.genesis)
    read = Read(plan: plan, source: source)
    unread = nil
    if RoadmapModel.name(typed: name).isEmpty {
      name = plan.title
      named = name
    }
    room.telemetry.event("roadmap_board_create", properties: ["step": "read", "door": source.rawValue])
  }

  // A file the importer handed back, read as the web reads one (`File.text()`): its bytes as UTF-8, a sequence that is
  // none read as U+FFFD, and a leading byte order mark dropped. One that cannot be opened is said in Start from's footer by
  // its name, which no report carries, and nothing is read.
  func read(file chosen: Result<URL, any Error>) {
    guard case .success(let file) = chosen else { return }
    let reachable = file.startAccessingSecurityScopedResource()
    defer { if reachable { file.stopAccessingSecurityScopedResource() } }
    do {
      let text = String(decoding: try Data(contentsOf: file), as: UTF8.self)
      read(text.hasPrefix("\u{FEFF}") ? String(text.unicodeScalars.dropFirst()) : text, from: .file)
    } catch {
      unread = file.lastPathComponent
      room.telemetry.event("roadmap_board_create", properties: ["step": "unread", "door": Source.file.rawValue])
      room.telemetry.failure("roadmap_file", kind: "unexpected")
    }
  }

  // Clear: back to Start from, taking back the name the plan gave where it still stands.
  func clear() {
    guard let source = read?.source else { return }
    read = nil
    if name == named { name = "" }
    named = nil
    room.telemetry.event("roadmap_board_create", properties: ["step": "clear", "door": source.rawValue])
  }

  // Cancel, or the sheet sent away: nothing is written.
  func cancel() {
    room.newRoadmap = nil
    room.telemetry.event("roadmap_board_create", properties: ["step": "cancel", "door": door])
  }

  // Create: a blank roadmap starts with one step, named as the roadmap and in the first kind's colour, as the web's birth
  // plants it (`NewTreeBirth.plant`); a plan plants its steps, links and kinds, then the marks of the steps it brings
  // done (`ReplicaBirth.plant`). A creation the domain refuses leaves the sheet open, and one from a plan that no limit
  // refused reports.
  func create() {
    guard let planting else { return }
    let written = room.write(planting.creation, as: "createRoadmap")
    if read != nil, case .refused(let refusal) = written, !refusal.isFull {
      room.telemetry.failure("roadmap_plant", kind: "refusal", properties: ["refusal": refusal.label])
    }
    guard let created = written.committed else { return }
    room.forget(created.receipt.gestureId)
    let marked = mark(planting.done, of: created.result)
    room.newRoadmap = nil
    room.path = []
    room.arriving = created.result.tree.description
    let steps = planting.creation.steps.steps.count
    room.telemetry.event("birth", properties: ["door": door, "count": RoadmapModel.bucket(steps)])
    guard read != nil else { return }
    room.show(RoadmapModel.Band(told: .planted(steps: steps, done: marked)))
  }

  // The steps the plan brings done, each completed by the id the creation gave it, as one act the engine keeps no Undo
  // of. Answers how many were marked: none where the act was refused or failed, which reports, the roadmap standing.
  func mark(_ done: [String], of created: CreateRoadmap.Result) -> Int {
    let ids = Dictionary(created.steps.map { (Array($0.key.utf8), $0.id) }) { first, _ in first }
    let marks = done.compactMap { ids[Array($0.utf8)] }.map { AnyActAction(MarkStep.complete(tree: created.tree, step: $0)) }
    guard !marks.isEmpty else { return 0 }
    switch room.write(marks, as: "mark") {
    case .committed(_, let receipt):
      room.forget(receipt.gestureId)
      return marks.count
    case .unchanged: return marks.count
    case .refused, .failed:
      room.telemetry.failure("roadmap_plant", kind: "marks")
      return 0
    }
  }
}
