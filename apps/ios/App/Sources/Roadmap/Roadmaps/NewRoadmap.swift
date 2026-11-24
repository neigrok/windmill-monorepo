import SwiftUI
import UniformTypeIdentifiers
import RoadmapDomain

// New Roadmap (Roadmap · iOS 01.6, 01.8, 01.8c): a large sheet that names a roadmap, committed from its bar. A name alone
// plants it blank with its one starting step; Start from fills it instead, from a plan on the clipboard through the
// system's Paste button or from a `.md` or `.txt` file through the system's importer, each read back (01.8) before Create
// plants it. A file the phone could not read is said in Start from's footer, and nothing is planted. Cancel, or the sheet
// sent away, writes nothing.
struct NewRoadmap: View {
  let draft: NewRoadmapDraft
  @State private var choosingFile = false

  // Markdown by the identifier the app's Info.plist imports, which the SDK names only from iOS 27, and plain text.
  static let files = [UTType(importedAs: "net.daringfireball.markdown", conformingTo: .plainText), .plainText]
  // The first steps a plan read back shows.
  static let firstSteps = 6

  var body: some View {
    NavigationStack {
      Form {
        TextField("Name your roadmap", text: Binding(get: { draft.name }, set: { draft.name = $0 }))
          .foregroundStyle(RoadmapPalette.ink).listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-new-name")
        if let read = draft.read { readBack(read.plan) } else { startFrom }
      }.scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("New Roadmap").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { draft.cancel() }.accessibilityIdentifier("roadmap-new-cancel")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Create") { draft.create() }.fontWeight(.semibold).disabled(!draft.creates).accessibilityIdentifier("roadmap-new-create")
          }
        }.roomBar(.roadmap)
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: Self.files) { draft.read(file: $0) }
    }.tint(RoadmapPalette.accent).presentationDetents([.large]).presentationDragIndicator(.visible)
  }

  // 01.6 and 01.8c: the two starts, and under them what a name alone plants, or the file that could not be read.
  var startFrom: some View {
    Section {
      LabeledContent {
        PasteButton(payloadType: String.self) { copied in
          Task { @MainActor in draft.read(copied.joined(separator: "\n"), from: .paste) }
        }.buttonBorderShape(.capsule).tint(RoadmapPalette.accent).accessibilityIdentifier("roadmap-new-paste")
      } label: {
        Text("A Copied Plan").foregroundStyle(RoadmapPalette.ink)
      }.listRowBackground(RoadmapPalette.card)
      Button {
        if let file = RoadmapFixture.chosenFile() { draft.read(file: .success(file)) } else { choosingFile = true }
      } label: {
        HStack {
          Text("A File").foregroundStyle(RoadmapPalette.ink)
          Spacer()
          Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkFaint)
        }
      }.listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-new-file")
    } header: {
      Text("Start from").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
    } footer: {
      Group {
        if let unread = draft.unread {
          Text("Couldn’t read “\(unread)”.", comment: "New Roadmap's footer when the file chosen could not be read: the file's name")
            .foregroundStyle(RoadmapPalette.ink)
        } else {
          Text("Create alone plants one step, named as the roadmap.").foregroundStyle(RoadmapPalette.inkDim)
        }
      }.accessibilityIdentifier("roadmap-new-footer")
    }
  }

  // 01.8: the plan's counts, with Clear, and its first steps in the states the Board will show them in.
  @ViewBuilder func readBack(_ plan: RoadmapPlan) -> some View {
    let landing = draft.landing
    Section {
      PlanCounts(steps: plan.readout.steps, branches: plan.readout.branches, done: plan.readout.done, notes: plan.imperfections.notes)
    } header: {
      HStack {
        Text("Pasted plan").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim)
        Spacer()
        Button("Clear") { draft.clear() }.font(.subheadline).foregroundStyle(RoadmapPalette.accent).accessibilityIdentifier("roadmap-new-clear")
      }.textCase(nil)
    }
    if !landing.isEmpty {
      Section {
        ForEach(landing.prefix(Self.firstSteps).indices, id: \.self) { index in PlannedStepRow(landing: landing[index]) }
      } header: {
        Text("First steps").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
      } footer: {
        if landing.count > Self.firstSteps {
          Text("And \(landing.count - Self.firstSteps) more.", comment: "Under a plan's first steps: how many more steps it brings")
            .foregroundStyle(RoadmapPalette.inkDim)
        }
      }
    }
  }
}
