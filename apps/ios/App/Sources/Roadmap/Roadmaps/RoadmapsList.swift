import SwiftUI
import RoadmapDomain

// All Roadmaps (Roadmap · iOS 01.4), pushed on the room's stack: every roadmap of the person in the domain's order, the
// most recent first, each name over its progress and the open one checked. A row opens its roadmap on its Board, and
// slides left for Delete, which asks on the row and leaves the list under the room's band. Past eight roadmaps the bar's
// drawer finds them by name, and + names a new one.
struct RoadmapsList: View {
  let roadmap: RoadmapModel
  @State private var query = ""
  @State private var searched = false

  var body: some View {
    // Past eight roadmaps the drawer finds one as the web's switcher does (`SEARCH_THRESHOLD`, `roadmapMatch`): its
    // title holds the words typed, in any case.
    let searching = roadmap.roadmaps.count > 8
    let sought = searching ? query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() : ""
    let found = roadmap.roadmaps.filter { sought.isEmpty || ($0.title ?? "").lowercased().contains(sought) }
    return drawer(shown: searching, over: List(found, id: \.id) { listed in row(listed) }
      .listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
      .overlay { if !sought.isEmpty && found.isEmpty { ContentUnavailableView.search(text: query) } })
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      .navigationTitle("All Roadmaps").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New Roadmap", systemImage: "plus") { roadmap.nameRoadmap(from: .list) }.accessibilityIdentifier("roadmap-list-new")
        }
      }.roomBar(.roadmap)
      .roadmapFoot(roadmap) {}
      .onChange(of: sought.isEmpty) { _, empty in
        guard !empty, !searched else { return }
        searched = true
        roadmap.searchedRoadmaps()
      }
  }

  @ViewBuilder func drawer(shown: Bool, over list: some View) -> some View {
    if shown { list.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a roadmap") }
    else { list }
  }

  func row(_ listed: ListedRoadmap) -> some View {
    var open = false
    if case .open(let shown) = roadmap.phase { open = shown.listed.id == listed.id }
    return Button { roadmap.open(listed.id, from: .list) } label: {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(listed.name).foregroundStyle(RoadmapPalette.ink)
          if let counts = listed.counts { Text(counts.progress).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
        }.frame(maxWidth: .infinity, alignment: .leading)
        if open { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(RoadmapPalette.accent).accessibilityHidden(true) }
      }.contentShape(Rectangle())
    }.buttonStyle(.plain)
      .listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: RoomSpace.inset))
      .listRowBackground(RoadmapPalette.card)
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Delete", systemImage: "trash", role: .destructive) { roadmap.askDelete(listed, from: .list) }.tint(nil)
      }
      .modifier(DeleteRoadmapQuestion(roadmap: roadmap, row: listed.id))
      .accessibilityElement(children: .combine).accessibilityAddTraits(open ? .isSelected : [])
      .accessibilityIdentifier("roadmap-listed")
  }
}

// The room's words for a roadmap, the same in the bar, in the title menu, in All Roadmaps, in the delete question and in
// the band.
extension ListedRoadmap {
  var name: String { Self.name(of: title) }

  // A roadmap is named by its title, and one without a title by these words.
  static func name(of title: String?) -> String { title?.nilIfEmpty ?? String(localized: "Untitled roadmap") }
}

// How far a roadmap is, under its name: on its Board and in All Roadmaps with the word, in the title menu without.
extension Counts {
  var progress: String {
    if total == 0 { return String(localized: "No steps yet") }
    return String(localized: "\(done) of \(total) done", locale: .copy,
                  comment: "How many are done, of how many: a roadmap's steps under its name, and the steps a step requires")
  }

  var tally: String {
    if total == 0 { return String(localized: "No steps yet") }
    return String(localized: "\(done) of \(total)", locale: .copy, comment: "How many of a roadmap's steps are done, of how many, under its name in the title menu")
  }
}
