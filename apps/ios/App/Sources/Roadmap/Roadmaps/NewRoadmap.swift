import SwiftUI
import RoadmapDomain

// New Roadmap (Roadmap · iOS 01.6): a large sheet that names a roadmap, committed from its bar. Create plants it blank
// with its one starting step and the room opens it; Cancel, or the sheet sent away, writes nothing. The field holds no
// more of a name than the domain takes.
struct NewRoadmap: View {
  let roadmap: RoadmapModel
  @State private var name = ""

  var body: some View {
    NavigationStack {
      Form {
        TextField("Name your roadmap", text: $name).foregroundStyle(RoadmapPalette.ink).listRowBackground(RoadmapPalette.card)
          .accessibilityIdentifier("roadmap-new-name")
      }.scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("New Roadmap").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { roadmap.cancelNaming() }.accessibilityIdentifier("roadmap-new-cancel")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Create") { roadmap.create(named: name) }.fontWeight(.semibold)
              .disabled(RoadmapModel.name(typed: name).isEmpty).accessibilityIdentifier("roadmap-new-create")
          }
        }.roomBar(.roadmap)
        .onChange(of: name) { _, typed in
          var held = String(typed.prefix(RoadmapSpecs.title.max))
          while RoadmapSpecs.title.measure(held) > RoadmapSpecs.title.max { held.removeLast() }
          name = held
        }
    }.tint(RoadmapPalette.accent).presentationDetents([.large]).presentationDragIndicator(.visible)
  }
}
