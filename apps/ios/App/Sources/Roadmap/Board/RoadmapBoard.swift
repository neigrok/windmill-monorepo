import SwiftUI
import UIKit
import RoadmapDomain

// A roadmap's Board (Roadmap · iOS 01.1, 01.12, 02.1 to 02.15, 05.7, 07.1, 07.1b, 07.5d, 09.5a): one list of the domain's
// groups, Up next first, each folding under its header, as the Board's reading keeps them. A row opens its step's page,
// slides right for Complete, or for Open into the roadmap its step opens, and left for Delete, and a long press lists Complete, Edit, Open in Graph, Select and Delete Step. A narrowed
// Board says what it shows in its first rows, with Clear, and one left with nothing says why. Find's field stands at the
// foot while Find is up. With no step yet, or with every step done, the Board says so. A step the form made, which the
// reading shows, is scrolled to once the list holds it. While several steps are selected the list is in the system's
// edit mode. On a reader's cover the same list offers no act: nothing slides, presses or selects, and nothing adds a step.
struct RoadmapBoard: View {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  var body: some View {
    if open.board.overall.total == 0 && !roadmap.owns {
      ContentUnavailableView {
        Label { Text("No steps yet").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      }
    } else if open.board.overall.total == 0 {
      ContentUnavailableView {
        Label { Text("Your first step").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      } description: {
        Text("Give your roadmap a place to start.").foregroundStyle(RoadmapPalette.inkDim)
      } actions: {
        Button("New Step") { roadmap.newStep(from: .empty) }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-first-step")
      }
    } else {
      board(roadmap.reading.shown(in: open)).modifier(FindField(reading: roadmap.reading))
    }
  }

  @ViewBuilder func board(_ shown: BoardReading.Shown) -> some View {
    if shown.groups.isEmpty, let recovery = shown.recovery { nothingMatches(recovery, kinds: shown.kinds) }
    else { list(shown) }
  }

  func list(_ shown: BoardReading.Shown) -> some View {
    let made = roadmap.band.flatMap { (band: RoadmapModel.Band) -> String? in
      guard case .created = band.says else { return nil }
      return band.arrived.first { open.step($0) != nil }
    }
    let selection = roadmap.selection
    let chosen = selection.map { (selection: BoardSelection) -> Binding<Set<String>> in
      Binding(get: { selection.steps }, set: { selection.steps = $0 })
    }
    // While several are selected, a step the Board stops showing is chosen no longer.
    let kept = selection == nil ? Set<String>() : Set(shown.groups.flatMap { (group: RoadmapModel.Group) -> [String] in group.rows.map(\.id) })
    return ScrollViewReader { list in
      List(selection: chosen) {
        if open.everyStepDone && shown.recovery == nil && shown.branch == nil && roadmap.owns { Section {} header: { everyStepDone } }
        if let branch = shown.branch {
          narrowed(String(localized: "Branch · \(branch.name)", comment: "The Board's first row while it stays in a step's branch: the step's name"),
                   identifier: "roadmap-branch") { roadmap.reading.clearBranch() }
        }
        if !shown.kinds.isEmpty {
          narrowed(String(localized: "Showing \(shown.kinds.formatted(.list(type: .and)))", comment: "The Board's first row while a kind filter narrows it: the kinds shown"),
                   identifier: "roadmap-showing") { roadmap.reading.clearKinds(from: .row) }
        }
        ForEach(shown.groups) { group in
          Section(isExpanded: expanded(group.id, finding: shown.finding)) {
            ForEach(group.rows) { row in self.row(row, selecting: selection != nil, chosen: selection?.steps.contains(row.id) == true) }
          } header: {
            header(group.id, count: group.rows.count, finding: shown.finding)
          }.headerProminence(.increased)
        }
      }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
        // A first row that says what narrows the Board stands right under the switch row, as 02.8 and 02.9 draw it.
        .contentMargins(.top, shown.branch == nil && shown.kinds.isEmpty ? nil : RoomSpace.inset, for: .scrollContent)
        .environment(\.editMode, .constant(selection == nil ? .inactive : .active))
        .roomMotion(shown.groups.map { (group: RoadmapModel.Group) -> [String] in group.rows.map(\.id) })
        .onChange(of: kept) { _, shown in selection?.keep(shown) }
        .onAppear { roadmap.boardFrames.appeared(steps: open.board.overall.total) }
        .onScrollPhaseChange { _, phase in roadmap.boardFrames.scroll(moving: phase.isScrolling, steps: open.board.overall.total) }
        .onChange(of: made, initial: true) { _, step in
          guard let step else { return }
          withAnimation { list.scrollTo(step, anchor: .center) }
        }
    }
  }

  // 01.12: what heads the list once nothing is Up next or Locked. Share is drawn and does nothing.
  var everyStepDone: some View {
    VStack(spacing: 0) {
      Image(systemName: "checkmark.circle.fill").font(.largeTitle).imageScale(.large).foregroundStyle(RoadmapPalette.act)
        .accessibilityHidden(true)
      Text("All \(open.board.overall.total) steps done").font(.title2.bold()).foregroundStyle(RoadmapPalette.ink).padding(.top, 12)
      Text("Add a step whenever you’re ready.").font(.subheadline).foregroundStyle(RoadmapPalette.inkDim).padding(.top, RoomSpace.small)
      Button("Share") {}.buttonStyle(RoomSecondaryStyle()).fontWeight(.semibold).disabled(true).padding(.top, RoomSpace.inset)
        .accessibilityIdentifier("roadmap-share")
    }.frame(maxWidth: .infinity).multilineTextAlignment(.center).textCase(nil)
  }

  // 02.8, 02.9: a first row that says what narrows the Board, with Clear.
  func narrowed(_ says: String, identifier: String, clear: @escaping () -> Void) -> some View {
    Section {
      LabeledContent {
        Button("Clear", action: clear).foregroundStyle(RoadmapPalette.accent).accessibilityIdentifier(identifier + "-clear")
      } label: {
        Text(says).foregroundStyle(RoadmapPalette.ink).accessibilityIdentifier(identifier)
      }
    }.listRowBackground(RoadmapPalette.card).listSectionSpacing(RoomSpace.related)
  }

  // 02.6, 02.6b: the Board left with nothing. Find's words offer a new step of that name; a kind filter offers to show
  // every kind again. The subtitle still counts the whole roadmap.
  func nothingMatches(_ recovery: BoardRead.Recovery, kinds: [String]) -> some View {
    let words = roadmap.reading.needle
    let found = recovery != .kinds
    return ContentUnavailableView {
      Label {
        Text(found ? String(localized: "No steps match “\(words)”", comment: "Find matched no step: the words looked for") : String(localized: "No steps match"))
          .foregroundStyle(RoadmapPalette.ink)
      } icon: {
        Image(systemName: found ? "magnifyingglass" : "line.3.horizontal.decrease.circle").foregroundStyle(RoadmapPalette.inkDim)
      }
    } description: {
      if recovery != .search {
        Text(String(localized: "Showing \(kinds.formatted(.list(type: .and)))", comment: "The Board's first row while a kind filter narrows it: the kinds shown"))
          .foregroundStyle(RoadmapPalette.inkDim)
      }
    } actions: {
      if found && roadmap.owns {
        Button(String(localized: "New Step “\(words)”", comment: "Find matched no step: a new step named as the words looked for")) {
          roadmap.newStep(from: .find, named: words)
        }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-find-new-step")
      }
      if recovery != .search {
        Button("Clear Filters") { roadmap.reading.clearKinds(from: .empty) }.buttonStyle(RoomSecondaryStyle()).accessibilityIdentifier("roadmap-clear-filters")
      }
    }
  }

  // While Find narrows, each group with a match stands open and its header folds it for that search alone; otherwise a
  // header folds its group as the Board keeps it.
  func expanded(_ group: BoardRead.Column.Name, finding: Bool) -> Binding<Bool> {
    let reading = roadmap.reading
    guard !finding else {
      return Binding(get: { !reading.foldedWhileFinding.contains(group) }, set: {
        if $0 { reading.foldedWhileFinding.remove(group) } else { reading.foldedWhileFinding.insert(group) }
      })
    }
    return Binding(get: { !roadmap.folded.contains(group) }, set: { if $0 { roadmap.folded.remove(group) } else { roadmap.folded.insert(group) } })
  }

  // The header is the control that folds its section: this list style draws none of its own.
  func header(_ group: BoardRead.Column.Name, count: Int, finding: Bool) -> some View {
    let expanded = expanded(group, finding: finding)
    return Button { withAnimation { expanded.wrappedValue.toggle() } } label: {
      HStack(spacing: RoomSpace.related) {
        Text(group.title)
        Text(verbatim: String(count))
        Spacer()
        Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right").font(.footnote.weight(.semibold))
          .foregroundStyle(RoadmapPalette.inkDim).accessibilityHidden(true)
      }.foregroundStyle(RoadmapPalette.ink).contentShape(Rectangle())
    }.buttonStyle(.plain)
      .accessibilityValue(expanded.wrappedValue ? Text("Expanded") : Text("Collapsed"))
      .accessibilityIdentifier("roadmap-group-" + group.rawValue)
  }

  // A step's row, with why it stands in its group and its excerpt. A step the last act brought up next is washed while
  // the band says so, and so is the step the composer asks about (11.17). While several are selected the row is chosen by
  // a tap, a chosen one on the raised ground, and slides and presses for nothing.
  func row(_ row: RoadmapModel.Row, selecting: Bool, chosen: Bool) -> some View {
    let coach = roadmap.root.coach
    let asked = coach.map { $0.focused && $0.about?.treeId == open.id.description && $0.about?.step == row.id } ?? false
    let arrived = roadmap.band?.arrived.contains(row.id) == true || asked
    return RoadmapStepRow(roadmap: roadmap, row: row, door: .card, line: open.reason(row.card), excerpt: true)
      .listRowBackground(ZStack { chosen ? RoadmapPalette.raised : RoadmapPalette.card; if arrived { RoadmapPalette.accentSoft } }.roomMotion(arrived))
      .swipeActions(edge: .leading, allowsFullSwipe: false) {
        if row.completes && !selecting { Button("Complete", systemImage: "checkmark") { roadmap.complete(row, by: .swipe) }.tint(RoadmapPalette.act) }
        if roadmap.owns, !selecting, let opening = row.opening, roadmap.goesIn(to: opening) {
          Button("Open", systemImage: "square.stack.3d.up") { roadmap.goIn(row, by: .swipe) }.tint(RoadmapPalette.accent)
        }
      }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        if row.deletes && !selecting { Button("Delete", systemImage: "trash", role: .destructive) { roadmap.askDelete(row, by: .swipe) }.tint(nil) }
      }
      .contextMenu { if !selecting && roadmap.owns { menu(row) } }
      .modifier(DeleteQuestion(roadmap: roadmap, step: row.id, by: [.swipe, .menu]))
  }

  // 02.4: what a long press offers; Copy Link waits for its screen.
  @ViewBuilder func menu(_ row: RoadmapModel.Row) -> some View {
    if row.completes { Button("Complete", systemImage: "checkmark") { roadmap.complete(row, by: .menu) }.tint(RoadmapPalette.ink) }
    Button("Edit", systemImage: "pencil") { if let page = open.page(of: row.id) { roadmap.edit(page, from: .menu) } }.tint(RoadmapPalette.ink)
    Button("Open in Graph", systemImage: "point.3.connected.trianglepath.dotted") { roadmap.openInGraph(row.id, from: .menu) }.tint(RoadmapPalette.ink)
    Button("Select", systemImage: "checkmark.circle") { roadmap.startSelecting(row.id, from: .menu) }.tint(RoadmapPalette.ink)
    // 11.17: Ask Coach opens the composer about the step.
    if let coach = roadmap.root.coach {
      Button("Ask Coach", systemImage: "bubble.left.and.bubble.right") { coach.open(in: roadmap, about: (row.id, row.step.label), from: .row) }
        .tint(RoadmapPalette.ink).accessibilityIdentifier("roadmap-ask-coach")
    }
    if row.deletes {
      Divider()
      Button("Delete Step", systemImage: "trash", role: .destructive) { roadmap.askDelete(row, by: .menu) }
    }
  }
}

// Find (Roadmap · iOS 02.5, 02.6): while Find is up the Board takes the system's search, whose field stands at the foot
// above the keyboard and keeps the bar and the switch row. Its close ends Find, and the search key tells the search. The
// search stands on a view of its own behind the Board, so the list is not made anew, nor scrolled back to its top, as
// Find opens and closes.
struct FindField: ViewModifier {
  @Bindable var reading: BoardReading

  func body(content: Content) -> some View {
    content.background {
      if reading.finds {
        Color.clear.searchable(text: $reading.finding, isPresented: $reading.finds, prompt: Text("Find a step"))
          .searchPresentationToolbarBehavior(.avoidHidingContent)
          .onSubmit(of: .search) { reading.searched() }
      }
    }
  }
}

// The Board's tool in the switch row (Roadmap · iOS 02.7, 02.8, 09.5a): one menu over itself, with the order of Up next
// and Locked, the kinds in use to show, and, but on a reader's cover, the way into selecting several. Its symbol fills
// while another order or a kind filter narrows the Board.
struct BoardTool: View {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  var body: some View {
    let reading = roadmap.reading
    Menu {
      // An inline picker in a menu drops its label on iOS 26.5, so the order is a section of three toggles under Sort.
      Section(String(localized: "Sort", comment: "The Board's Sort and filter menu: the order of Up next and Locked")) {
        // The menu's items are made as it opens, so its first one tells the opening.
        order(.roadmap, "Roadmap Order").onAppear { roadmap.telemetry.event("roadmap_board_menu", properties: ["menu": "sortFilter"]) }
        order(.newest, "Newest First")
        order(.oldest, "Oldest First")
      }
      if !open.legend.inUse.isEmpty {
        Section(String(localized: "Filter by Kind", comment: "The Board's Sort and filter menu: the kinds in use, each shown or not")) {
          ForEach(open.legend.inUse) { entry in
            Toggle(isOn: Binding(get: { reading.kinds.contains(entry.hue) }, set: { _ in reading.toggle(entry.hue) })) {
              Label { Text(entry.name) } icon: { Image.kindDisc(entry.hue) }
            }
          }
        }
      }
      if roadmap.owns {
        Button("Select Steps", systemImage: "checkmark.circle") { roadmap.startSelecting(nil, from: .tool) }
      }
    } label: {
      Label("Sort and filter", systemImage: reading.narrows ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }.menuOrder(.fixed).modifier(GlassCircle()).accessibilityIdentifier("roadmap-board-tool")
  }

  // One order, checked while it stands.
  func order(_ sort: BoardQuery.Sort, _ name: LocalizedStringResource) -> some View {
    Toggle(isOn: Binding(get: { roadmap.reading.sort == sort }, set: { _ in roadmap.reading.pick(sort) })) { Text(name) }
  }
}

// The bar and the bottom toolbar while several steps are selected (Roadmap · iOS 02.10 to 02.12): Select All, or
// Deselect All once every step shown is chosen; the checkmark that ends it; Recolor with the six kinds; and Delete N
// Steps, which asks on itself and is dimmed while the choice holds every starting step. The title counts the steps
// chosen (`RoadmapTitle`). Each item reads the choice in its own view, so a tap on a row redraws the items and nothing
// of the room around them.
struct BoardSelectionBar: ToolbarContent {
  let roadmap: RoadmapModel
  let selection: BoardSelection
  let open: RoadmapModel.OpenRoadmap

  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) { SelectAll(selection: selection) }
    ToolbarItem(placement: .topBarTrailing) {
      Button("Done", systemImage: "checkmark") { roadmap.endSelecting(via: .done) }.labelStyle(.iconOnly).modifier(SelectionDone())
        .accessibilityIdentifier("roadmap-select-done")
    }
    ToolbarItemGroup(placement: .bottomBar) {
      SelectionActions(roadmap: roadmap, selection: selection, choices: open.legend.choices)
    }
  }

  struct SelectAll: View {
    let selection: BoardSelection

    var body: some View {
      Button(selection.holdsEveryKept ? String(localized: "Deselect All") : String(localized: "Select All")) { selection.selectAll() }
        .accessibilityIdentifier("roadmap-select-all")
    }
  }

  struct SelectionActions: View {
    let roadmap: RoadmapModel
    let selection: BoardSelection
    let choices: [RoadmapLegend.Choice]

    var body: some View {
      // A bar's item shows its symbol alone; these name their act beside it, as the board words them.
      Menu {
        ForEach(choices) { choice in
          Button { selection.recolor(choice.hue) } label: { Label { Text(choice.name) } icon: { Image.kindDisc(choice.hue) } }
        }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "paintpalette")
          Text("Recolor")
        }
      }.menuOrder(.fixed).disabled(selection.steps.isEmpty).accessibilityIdentifier("roadmap-recolor")
      Spacer()
      Button { selection.askDelete() } label: {
        HStack(spacing: 6) {
          Image(systemName: "trash")
          Text(DeleteStepsQuestion.delete(selection.steps.count))
        }
      }.disabled(selection.steps.isEmpty || selection.takesEveryStart)
        .modifier(DeleteStepsQuestion(roadmap: roadmap)).accessibilityIdentifier("roadmap-delete-steps")
    }
  }
}

// The checkmark that ends selecting: the system's prominent glass, tinted, as an active edit button draws it on iOS 26.
struct SelectionDone: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 26.0, *) { content.buttonStyle(.glassProminent).tint(RoadmapPalette.accent) }
    else { content.fontWeight(.semibold) }
  }
}

extension Image {
  // A kind's disc where a menu lists it: a menu draws a template symbol in its own ink, so the colour is the image's own.
  static func kindDisc(_ hue: String) -> Image {
    Image(uiImage: (UIImage(systemName: "circle.fill") ?? UIImage()).withTintColor(UIColor(RoadmapPalette.kind(hue)), renderingMode: .alwaysOriginal))
  }
}
