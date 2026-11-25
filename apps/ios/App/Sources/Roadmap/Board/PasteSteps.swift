import SwiftUI
import UIKit
import DomainKit
import RoadmapDomain
import SyncCore

// Paste Steps (Roadmap · iOS 02.16 to 02.18, 02.16b, 02.16c), in the foot's + menu: the copied text read into the open
// roadmap by the plan grammar, which binds a heading to a kind the roadmap has or adds one and renames none, and read back
// before anything is written, each step in the state it will land in under the roadmap's starting step. Add writes them
// as one act, the domain's `ImportSteps` with the marks the plan brings done (R-15) and `CreateKind` for each kind it
// adds, whose one Undo takes the paste back whole; Cancel writes nothing. An Add the domain refuses leaves the sheet open
// and says why under its counts. The room looks at the clipboard before it reads it, which asks the person nothing, so a
// clipboard with no text says so in the band; a read the person did not allow says so with Settings. The text is read by
// the grammar off the main actor.
@Observable @MainActor
final class PastedSteps: Identifiable {
  unowned let room: RoadmapModel
  // The roadmap the steps land in.
  let tree: DomainKit.ID<RoadmapEntry>
  let plan: RoadmapPlan
  let graft: RoadmapPlan.Graft
  // Each step in the state it will land in.
  let landing: [RoadmapPlan.Landing]
  // What the domain refused Add for, which the sheet says; the same write would be refused again.
  private(set) var refusal: RoadmapRefusal?

  init(_ plan: RoadmapPlan, grafted graft: RoadmapPlan.Graft, into open: RoadmapModel.OpenRoadmap, in room: RoadmapModel) {
    self.room = room
    self.plan = plan
    self.graft = graft
    tree = open.id
    landing = graft.landing(in: open.tree)
  }

  // Add: the steps as one write. Written, the sheet closes and the band says how many arrived, washed on the Board, with
  // Undo for six seconds; refused, the sheet stays open and says why; a commit that failed closes it, reported.
  func add() {
    guard let open = room.shown, open.id == tree else {
      room.pasting = nil
      return
    }
    switch room.write(graft.acts(in: tree), as: "ImportSubgraph") {
    case .committed(let result, let receipt):
      room.pasting = nil
      let planted = result.first as? [(key: String, id: DomainKit.ID<RoadmapStep>)] ?? []
      room.telemetry.event("roadmap_board_create", properties: ["step": "saved", "door": "paste", "view": room.view(of: open).rawValue,
                                                                "count": RoadmapModel.bucket(landing.count)])
      room.show(RoadmapModel.Band(.added(steps: landing.count), of: receipt, act: .step("graft"), arrived: planted.map(\.id.description)))
    case .refused(let refusal):
      self.refusal = refusal
      room.telemetry.event("roadmap_board_create", properties: ["step": "refused", "door": "paste", "refusal": refusal.label])
    case .unchanged, .failed:
      room.pasting = nil
    }
  }

  // Cancel, or the sheet sent away: nothing is written.
  func cancel() {
    guard room.pasting === self else { return }
    room.pasting = nil
    room.telemetry.event("roadmap_board_create", properties: ["step": "cancel", "door": "paste"])
  }
}

// Where Paste Steps reads the copied text: whether the clipboard holds text, which asks the person nothing, and the
// text, which the system may ask them to allow and answers nil where they did not. The system's is read off the main
// actor, which the system's question would otherwise hold until it is answered.
struct Clipboard {
  let holdsText: @MainActor () -> Bool
  let text: @Sendable () async -> String?

  static let system = Clipboard(holdsText: { UIPasteboard.general.hasStrings },
                                text: { await Task.detached { UIPasteboard.general.string }.value })
}

extension RoadmapModel {
  // Paste Steps, in the foot's + menu: the copied text read back over the roadmap open once it is read, or the band says
  // why there is none.
  func pasteSteps() async {
    guard shown != nil else { return }
    guard clipboard.holdsText() else { return unread(.noText, reason: "empty") }
    guard let text = await clipboard.text() else { return unread(.pasteRefused, reason: "denied") }
    guard let read = shown else { return }
    let kinds = read.legend.entries.map { (entry: RoadmapLegend.Entry) -> RoadmapPlan.Kind in
      RoadmapPlan.Kind(id: entry.kind?.id ?? "hue:\(entry.hue)", hue: entry.hue, label: entry.kind?.label ?? "", description: entry.kind?.description ?? "")
    }
    let under = read.graph.starting.first, held = read.tree.nodes.map(\.id)
    let parsed = await Task.detached { () -> (plan: RoadmapPlan, graft: RoadmapPlan.Graft?) in
      let plan = RoadmapPlan(reading: text, over: kinds, into: true)
      return (plan, plan.graft(under: under, held: held, liveKinds: kinds))
    }.value
    guard let open = shown, open.id == read.id else { return }
    guard let graft = parsed.graft else { return unread(.noText, reason: "empty") }
    pasting = PastedSteps(parsed.plan, grafted: graft, into: open, in: self)
    telemetry.event("roadmap_board_create", properties: ["step": "open", "door": "paste", "view": view(of: open).rawValue])
  }

  // What the band says of a paste that read nothing, and why, told once.
  func unread(_ says: Band.Says, reason: String) {
    show(Band(told: says))
    telemetry.event("roadmap_board_create", properties: ["step": "unread", "door": "paste", "reason": reason])
  }

  // Settings, on the band of a paste not allowed: Windmill's page in Settings, where that choice lives.
  func openedSettings() {
    endBand()
    telemetry.event("roadmap_board_create", properties: ["step": "settings", "door": "paste"])
  }
}

// Paste Steps' read-back (02.17): a medium sheet over the roadmap with the plan's counts, then each step in the state it
// will land in. Add writes them, Cancel writes nothing.
struct PasteStepsSheet: View {
  let pasted: PastedSteps

  var body: some View {
    NavigationStack {
      List {
        Section {
          PlanCounts(steps: pasted.landing.count, branches: pasted.plan.readout.branches, done: pasted.graft.done.count,
                     notes: pasted.plan.imperfections.notes)
        } footer: {
          if let refusal = pasted.refusal {
            Text(refusal.pasteWords).foregroundStyle(RoadmapPalette.ink).accessibilityIdentifier("roadmap-paste-refused")
          }
        }
        Section {
          ForEach(pasted.landing.indices, id: \.self) { index in PlannedStepRow(landing: pasted.landing[index]) }
        }
      }.listStyle(.insetGrouped).listSectionSpacing(.compact).scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("Paste Steps").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { pasted.cancel() }.accessibilityIdentifier("roadmap-paste-cancel")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Add") { pasted.add() }.fontWeight(.semibold).disabled(pasted.refusal != nil).accessibilityIdentifier("roadmap-paste-add")
          }
        }.roomBar(.roadmap)
    }.tint(RoadmapPalette.accent).presentationDetents([.medium]).presentationDragIndicator(.visible)
  }
}

extension RoadmapRefusal {
  // Why Paste Steps' Add was refused, in the room's words: the band's for a roadmap at its cap, a roadmap changed elsewhere
  // since the steps were read, its starting step or its kinds among what changed, or steps the domain cannot take.
  @MainActor var pasteWords: String {
    switch self {
    case .full: RoadmapModel.Band.Says.refused(.full).words
    case .gone, .roadmapGone, .taken, .stepOpensARoadmap: String(localized: "This roadmap changed elsewhere.")
    default: String(localized: "These steps can’t be added.")
    }
  }
}
