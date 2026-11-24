import SwiftUI
import UIKit
import DomainKit
import RoadmapDomain
import SyncCore

// Paste Steps (Roadmap · iOS 02.16 to 02.18, 02.16b, 02.16c), in the foot's + menu: the copied text read into the open
// roadmap by the plan grammar, which binds a heading to a kind the roadmap has or adds one and renames none, and read back
// before anything is written, each step in the state it will land in under the roadmap's starting step. Add writes them
// as one act, the domain's `ImportSteps` with the marks the plan brings done (R-15) and `CreateKind` for each kind it
// adds, whose one Undo takes the paste back whole; Cancel writes nothing. The room looks at the clipboard before it
// reads it, which asks the person nothing, so a clipboard with no text says so in the band; a read the person did not
// allow says so with Settings.
@MainActor
final class PastedSteps: Identifiable {
  unowned let room: RoadmapModel
  // The roadmap the steps land in.
  let tree: DomainKit.ID<RoadmapEntry>
  let plan: RoadmapPlan
  let graft: RoadmapPlan.Graft
  // Each step in the state it will land in.
  let landing: [RoadmapPlan.Landing]

  init(_ plan: RoadmapPlan, grafted graft: RoadmapPlan.Graft, into open: RoadmapModel.OpenRoadmap, in room: RoadmapModel) {
    self.room = room
    self.plan = plan
    self.graft = graft
    tree = open.id
    landing = graft.landing(in: open.tree)
  }

  // Add: the steps as one write. Written, the band says how many arrived, washed on the Board, with Undo for six seconds;
  // refused at the roadmap's cap, the band says so. Either way the sheet closes.
  func add() {
    room.pasting = nil
    guard let open = room.shown, open.id == tree, let written = room.write(graft.acts(in: tree), as: "ImportSubgraph").committed else { return }
    let planted = written.result.first as? [(key: String, id: DomainKit.ID<RoadmapStep>)] ?? []
    room.telemetry.event("roadmap_board_create", properties: ["step": "saved", "door": "paste", "view": room.view(of: open).rawValue,
                                                              "count": RoadmapModel.bucket(landing.count)])
    room.show(RoadmapModel.Band(.added(steps: landing.count), of: written.receipt, act: .step("graft"), arrived: planted.map(\.id.description)))
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
    guard let open = shown else { return }
    let kinds = open.legend.entries.map { (entry: RoadmapLegend.Entry) -> RoadmapPlan.Kind in
      RoadmapPlan.Kind(id: entry.kind?.id ?? "hue:\(entry.hue)", hue: entry.hue, label: entry.kind?.label ?? "", description: entry.kind?.description ?? "")
    }
    let plan = RoadmapPlan(reading: text, over: kinds, into: true)
    guard let graft = plan.graft(under: open.starting.first, held: open.tree.nodes.map(\.id), liveKinds: kinds) else { return unread(.noText, reason: "empty") }
    pasting = PastedSteps(plan, grafted: graft, into: open, in: self)
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
            Button("Add") { pasted.add() }.fontWeight(.semibold).accessibilityIdentifier("roadmap-paste-add")
          }
        }.roomBar(.roadmap)
    }.tint(RoadmapPalette.accent).presentationDetents([.medium]).presentationDragIndicator(.visible)
  }
}
