import SwiftUI
import UIKit
import RoadmapDomain

// The Guide sheet (Roadmap · iOS 08.1 to 08.5), raised by the title menu's Guide: a large sheet with its own bar. Read,
// it is the open roadmap's guide as one column, then who else reads it where the phone is signed in, then each guide of a
// roadmap above under that roadmap's name, nearest first and read-only; a roadmap with no guide of its own stands as the
// room's empty view with Add Guide. Edit and Add Guide turn the same sheet into the editor: one field over the draft with
// the keyboard up, Cancel and Save in the bar, and the footer counting from 4,500 characters, in ink past 5,000, where
// Save is dimmed. Cancel asks once on a changed draft, which a swipe down does not send away. The room's band stands at
// the sheet's foot, away while the field has the keyboard.
struct RoadmapGuide: View {
  let roadmap: RoadmapModel
  @Bindable var sheet: GuideSheet
  // Signed out the guide is the phone's alone, so no footer says who else reads it.
  let signedIn: Bool
  @FocusState private var writing: Bool

  var body: some View {
    NavigationStack {
      Group {
        if let draft = sheet.draft { editor(draft) }
        else if sheet.written || !sheet.above.isEmpty { reading }
        else { empty.frame(maxHeight: .infinity) }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("Guide").navigationBarTitleDisplayMode(.inline)
        .toolbar { bar }.roomBar(.roadmap)
        .roadmapFoot(roadmap, away: writing, inSheet: true) {}
    }.tint(RoadmapPalette.accent).presentationDetents([.large]).presentationDragIndicator(.visible)
      .interactiveDismissDisabled(sheet.draft?.changed ?? false)
  }

  @ToolbarContentBuilder var bar: some ToolbarContent {
    if let draft = sheet.draft {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { sheet.cancel() }
          .confirmationDialog("Discard draft?", isPresented: $sheet.asksDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { sheet.discard() }
          }.accessibilityIdentifier("roadmap-guide-cancel")
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          writing = false
          sheet.save()
        }.fontWeight(.semibold).disabled(!draft.changed || !draft.fits).accessibilityIdentifier("roadmap-guide-save")
      }
    } else {
      ToolbarItem(placement: .cancellationAction) { close }
      if sheet.written {
        ToolbarItem(placement: .primaryAction) { Button("Edit") { sheet.edit(via: .edit) }.accessibilityIdentifier("roadmap-guide-edit") }
      }
    }
  }

  // The sheet's close, the system's on iOS 26.
  @ViewBuilder var close: some View {
    if #available(iOS 26.0, *) {
      Button(role: .close) { roadmap.closeGuide() }.accessibilityIdentifier("roadmap-guide-close")
    } else {
      Button("Done") { roadmap.closeGuide() }.accessibilityIdentifier("roadmap-guide-close")
    }
  }

  // 08.1 and 08.5: the guide, who reads it, and the guides from above, each under its roadmap's name.
  var reading: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if sheet.written {
          Text(sheet.text).foregroundStyle(RoadmapPalette.ink).textSelection(.enabled).accessibilityIdentifier("roadmap-guide-text")
          if signedIn { audience.padding(.top, RoomSpace.inset) }
        } else {
          empty.padding(.vertical, RoomSpace.panel)
        }
        ForEach(sheet.above, id: \.tree) { guide in
          Text("\(ListedRoadmap.name(of: guide.title)) · from above", comment: "A guide of a roadmap above this one: that roadmap's name")
            .font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim)
            .padding(.top, RoomSpace.panel + RoomSpace.related).padding(.bottom, RoomSpace.related).accessibilityAddTraits(.isHeader)
          Text(guide.text).foregroundStyle(RoadmapPalette.inkDim).textSelection(.enabled).accessibilityIdentifier("roadmap-guide-above")
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, RoomSpace.panel).padding(.top, RoomSpace.related)
    }
  }

  // 08.2: a roadmap with no guide of its own.
  var empty: some View {
    ContentUnavailableView {
      Label { Text("No guide yet").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "book.closed").foregroundStyle(RoadmapPalette.inkDim) }
    } description: {
      Text("What are you working toward?").foregroundStyle(RoadmapPalette.inkDim)
    } actions: {
      Button("Add Guide") { sheet.edit(via: .add) }.buttonStyle(RoomSecondaryStyle()).tint(RoadmapPalette.accent)
        .accessibilityIdentifier("roadmap-guide-add")
    }
  }

  var audience: some View {
    Text("Your agents and people you share this roadmap with can read the guide.").font(.footnote).foregroundStyle(RoadmapPalette.inkDim)
  }

  // 08.3 and 08.4: the field over the draft, with the keyboard up as it opens, and under it the counter, or who reads the
  // guide before the counter shows.
  func editor(_ draft: GuideDraft) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      TextEditor(text: Binding(get: { sheet.draft?.text ?? "" }, set: { sheet.type($0) }))
        .focused($writing).scrollContentBackground(.hidden).foregroundStyle(RoadmapPalette.ink)
        .contentMargins(.bottom, RoomSpace.related, for: .scrollContent)
        .accessibilityLabel("Guide").accessibilityIdentifier("roadmap-guide-field")
      Group {
        if let count = draft.count {
          Text(count).foregroundStyle(draft.fits ? RoadmapPalette.inkDim : RoadmapPalette.ink).accessibilityIdentifier("roadmap-guide-count")
        } else if signedIn {
          audience
        }
      }.font(.footnote).padding(.horizontal, RoomSpace.small).padding(.vertical, RoomSpace.related)
    }.padding(.horizontal, RoomSpace.inset)
      .onAppear { writing = true }
      .onChange(of: draft.fits) { _, fits in
        if !fits, let count = draft.count { UIAccessibility.post(notification: .announcement, argument: count) }
      }
  }
}
