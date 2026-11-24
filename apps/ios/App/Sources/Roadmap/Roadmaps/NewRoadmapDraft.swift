import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncCore

// New Roadmap's draft (Roadmap · iOS 01.6, 01.8, 01.8b, 01.8c): a name, and a plan read from a copied text or a `.md` or
// `.txt` file by the plan grammar, off the main actor, before anything is planted. Create plants a blank roadmap, or the
// plan, by the domain's `CreateRoadmap` on the phone's copy, then marks the steps the plan brings done, and the room opens
// it; the engine keeps no Undo of a birth. The name comes from the plan's first line unless one was typed, and Clear
// returns to Start from.
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

  // Why no plan was read from a file, as Start from's footer says it: the file could not be opened, or is past the bound,
  // each by its name, or the system's importer handed back none.
  enum Unread: Equatable {
    case unopened(String)
    case tooLarge(String)
    case importer
  }

  // What reading a chosen file came to.
  enum FileText: Sendable {
    case text(String)
    case tooLarge
    case failed(any Error)
  }

  // The most of a file the phone reads, in bytes: a plan of the roadmap's cap of steps fits many times over.
  nonisolated static let fileBound = 2_000_000

  unowned let room: RoadmapModel
  // The field holds no more of a name than the domain takes.
  var name = "" {
    didSet { if name != RoadmapSpecs.title.holding(name) { name = RoadmapSpecs.title.holding(name) } }
  }
  private(set) var read: Read?
  // The name a plan gave the field, which Clear takes back where it still stands.
  private(set) var named: String?
  // Why the file chosen last was not read.
  private(set) var unread: Unread?

  init(in room: RoadmapModel) {
    self.room = room
  }

  // The door Create plants by, as its events name it.
  var door: String { read?.source.rawValue ?? "blank" }

  // What Create plants under the name the field holds: the plan read back, or with none the empty plan, whose one step
  // the name names, as a blank roadmap's. A field still holding the name the plan gave plants the plan under its own, as
  // the web does with no name typed, so a file's title keeps its padding. None while neither the field nor the plan names
  // it.
  var planting: RoadmapPlan.Planting? {
    (read?.plan ?? RoadmapPlan(reading: "", over: Self.genesis)).planting(named: name == named ? "" : name)
  }

  // Create needs a name: the field's, or a plan's own.
  var creates: Bool { planting != nil }

  // The plan's steps in the states they will land in: as Create would plant them, or, before the plan is named, as it
  // stands.
  var landing: [RoadmapPlan.Landing] { planting?.landing ?? read?.plan.landing ?? [] }

  // The legend a new roadmap starts from, which a plan is read over.
  static let genesis = RoadmapRules.genesisKinds.map { RoadmapPlan.Kind(id: $0.id.description, hue: $0.hue, label: $0.label, description: $0.description) }

  // A plan read back from the text the Paste button handed over, or a file's, the grammar run off the main actor: an
  // empty field takes the plan's name. A draft the sheet left meanwhile reads nothing.
  func read(_ text: String, from source: Source) async {
    let genesis = Self.genesis
    let plan = await Task.detached { RoadmapPlan(reading: text, over: genesis) }.value
    guard room.newRoadmap === self else { return }
    read = Read(plan: plan, source: source)
    unread = nil
    if RoadmapModel.name(typed: name).isEmpty {
      name = plan.title
      named = name
    }
    room.telemetry.event("roadmap_board_create", properties: ["step": "read", "door": source.rawValue])
  }

  // A file the importer handed back, read off the main actor as the web reads one (`File.text()`): its bytes as UTF-8, a
  // sequence that is none read as U+FFFD, and a leading byte order mark dropped. One past the bound is not read; one that
  // cannot be opened, and an importer that handed back none, report with the error's domain and code alone. Each is said
  // in Start from's footer, a file by its name, which no event or report carries.
  func read(file chosen: Result<URL, any Error>) async {
    let file: URL
    switch chosen {
    case .success(let chosen): file = chosen
    case .failure(let error): return unread(.importer, failing: error)
    }
    switch await Task.detached(operation: { Self.text(of: file) }).value {
    case .text(let text): await read(text, from: .file)
    case .tooLarge:
      unread = .tooLarge(file.lastPathComponent)
      room.telemetry.event("roadmap_board_create", properties: ["step": "unread", "door": Source.file.rawValue, "reason": "too_large"])
    case .failed(let error): unread(.unopened(file.lastPathComponent), failing: error)
    }
  }

  // A file that was not read for a failure: said in the footer, told, and reported.
  func unread(_ why: Unread, failing error: any Error) {
    unread = why
    room.telemetry.event("roadmap_board_create", properties: ["step": "unread", "door": Source.file.rawValue])
    room.telemetry.failure("roadmap_file", kind: "unexpected", properties: Self.labels(of: error))
  }

  // A file's text, its size held to the bound before and after it is read.
  nonisolated static func text(of file: URL) -> FileText {
    let reachable = file.startAccessingSecurityScopedResource()
    defer { if reachable { file.stopAccessingSecurityScopedResource() } }
    do {
      if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > fileBound { return .tooLarge }
      let data = try Data(contentsOf: file)
      guard data.count <= fileBound else { return .tooLarge }
      let text = String(decoding: data, as: UTF8.self)
      return .text(text.hasPrefix("\u{FEFF}") ? String(text.unicodeScalars.dropFirst()) : text)
    } catch {
      return .failed(error)
    }
  }

  // A file's failure as its report carries it: the error's domain and its code as a bucket, never its message or a name.
  nonisolated static func labels(of error: any Error) -> [String: String] {
    let error = error as NSError
    let domain = switch error.domain {
    case NSCocoaErrorDomain: "cocoa"
    case NSPOSIXErrorDomain: "posix"
    default: "other"
    }
    let code = switch (error.domain, error.code) {
    case (NSCocoaErrorDomain, NSFileNoSuchFileError), (NSCocoaErrorDomain, NSFileReadNoSuchFileError), (NSPOSIXErrorDomain, Int(ENOENT)): "missing"
    case (NSCocoaErrorDomain, NSFileReadNoPermissionError), (NSPOSIXErrorDomain, Int(EACCES)), (NSPOSIXErrorDomain, Int(EPERM)): "permission"
    case (NSCocoaErrorDomain, NSFileReadCorruptFileError), (NSCocoaErrorDomain, NSFileReadUnknownError): "unreadable"
    case (NSCocoaErrorDomain, NSUserCancelledError): "cancelled"
    default: "other"
    }
    return ["error_domain": domain, "error_code": code]
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
