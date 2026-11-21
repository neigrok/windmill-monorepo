import Foundation
import Observation
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine

// The Roadmap room's model reads the engine's views of the person's roadmaps through the domain, and holds no rule of its own.
@Observable @MainActor
final class RoadmapModel {
  // The engine's live view of every record of one type in one scope as `drawn` folds it, visible or not.
  typealias Records = @MainActor (ScopeRef, String) throws -> RecordsView

  struct ViewKey: Hashable {
    let scope: ScopeRef
    let type: String
  }

  // The roadmap the room has open: its row in the person's list, its records and its Board.
  struct OpenRoadmap {
    let listed: ListedRoadmap
    let tree: RoadmapTree
    let board: BoardRead
  }

  // What the room shows: nothing while the phone's copy is not read yet, a roadmap, no roadmap, or a failed read.
  enum Phase {
    case unread, empty, open(OpenRoadmap), failed
  }

  // The types the domain reads one roadmap from, in its tree scope and in its owner's overlay.
  static let treeTypes = [RoadmapMeta.type, RoadmapStep.type, RoadmapLink.type, RoadmapKind.type]
  static let overlayTypes = [StepMark.type, StepPointer.type]
  // Where the phone keeps the id of the roadmap last open.
  static let lastOpen = "roadmapLastOpen"

  let records: Records
  // What this phone remembers under any account or none.
  let phone: UserDefaults
  let telemetry: any Telemetry
  private(set) var phase = Phase.unread
  // The person's own roadmaps, the most recent first.
  private(set) var roadmaps: [ListedRoadmap] = []
  // Every view the room asked the engine for, kept so each stays live.
  @ObservationIgnored var views: [ViewKey: RecordsView] = [:]
  // The observation now live; one begun later ends the one before it.
  @ObservationIgnored var watch = 0
  @ObservationIgnored var reportedFailures: Set<String> = []

  init(records: @escaping Records, phone: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) {
    self.records = records; self.phone = phone; self.telemetry = telemetry
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
    guard let graph = account.graph(listed.id) else {
      phase = .unread
      return
    }
    if !listed.id.utf8.elementsEqual(last.utf8) { phone.set(listed.id, forKey: Self.lastOpen) }
    phase = .open(OpenRoadmap(listed: listed, tree: graph.tree, board: BoardRead(graph)))
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
}
