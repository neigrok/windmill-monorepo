import SwiftUI
import RoadmapDomain

// What a Board row shows of the roadmap its step opens (Roadmap · iOS 07.1, 07.5d): the stack mark, the roadmap's name and
// its count with a bar, or the short words of an odd end with none.
struct OpeningPill: View {
  let opening: RoadmapModel.Opened

  var body: some View {
    if let pill = opening.pill {
      HStack(spacing: 6) {
        Image(systemName: "square.stack.3d.up").imageScale(.small).accessibilityHidden(true)
        Text(pill).lineLimit(1)
        if let gauge = opening.gauge { ProgressView(value: gauge).tint(RoadmapPalette.accent).frame(width: 28).accessibilityHidden(true) }
      }.font(.footnote).foregroundStyle(RoadmapPalette.inkDim)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(RoadmapPalette.raised, in: Capsule())
        .padding(.vertical, 2)
    }
  }
}

// A step page's Roadmap section, or Subtree for a subtree the step owns (Roadmap · iOS 07.2, 07.2b, 07.4, 07.5a to 07.5c,
// 07.8b, 07.11): one row that goes into the roadmap, its name over how far it is, and the footer that says what completes
// the step, with what a Done mark set aside costs. The owner's row of a roadmap the step opens carries the … menu of 07.9,
// and one that cannot be found pushes the attach list; a subtree's row has no menu, since nothing changes or detaches it.
// On a reader's cover the row goes nowhere, and so does a row whose roadmap already stands on the stack, as a loop's does.
struct OpenedSection: View {
  let roadmap: RoadmapModel
  let row: RoadmapModel.Row
  let opening: RoadmapModel.Opened
  let open: RoadmapModel.OpenRoadmap

  var body: some View {
    Section {
      if roadmap.owns {
        // The … menu stands over the link, so a tap on it opens the menu and never goes in.
        Group {
          if let visit { NavigationLink(value: roadmap.stacked(visit)) { label } }
          else { label.accessibilityElement(children: .combine) }
        }.accessibilityIdentifier("roadmap-step-roadmap")
          .overlay(alignment: .trailing) { if !opening.owned { menu.padding(.trailing, 6) } }
      } else {
        label.accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-step-roadmap")
      }
    } header: {
      StepSectionHeader(title: opening.owned ? "Subtree" : "Roadmap")
    } footer: {
      if let footer { Text(footer).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-step-roadmap-rule") }
    }.listRowBackground(RoadmapPalette.card)
  }

  // Where the owner's row leads: into the roadmap, to the attach list where it cannot be found, and nowhere where the
  // roadmap stands on the stack already.
  var visit: RoadmapModel.Visit? {
    guard opening.leads else { return .attach(to: row.id) }
    return roadmap.goesIn(to: opening) ? .roadmap(opening.tree, by: .step) : nil
  }

  var label: some View {
    HStack(spacing: 12) {
      Image(systemName: "square.stack.3d.up").foregroundStyle(RoadmapPalette.accent).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        if opening.face == .unread && opening.title == nil { ProgressView().controlSize(.small) }
        else { Text(opening.name).foregroundStyle(RoadmapPalette.ink) }
        if let progress = opening.progress { Text(progress).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      // Room for the … menu, which stands over the row.
      if roadmap.owns && !opening.owned { Color.clear.frame(width: RoomSpace.minimumTarget + 6, height: 1).accessibilityHidden(true) }
    }
  }

  // The owner's Change Roadmap and Detach Roadmap (07.9): Detach asks nothing and is not red, since the band offers Undo.
  var menu: some View {
    Menu {
      Button("Change Roadmap", systemImage: "square.stack.3d.up") { roadmap.path.append(.attach(to: row.id)) }.tint(RoadmapPalette.ink)
      Button("Detach Roadmap", systemImage: "minus.circle") { roadmap.detach(row) }.tint(RoadmapPalette.ink)
    } label: {
      Image(systemName: "ellipsis").foregroundStyle(RoadmapPalette.accent).frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget)
        .contentShape(Rectangle())
    }.accessibilityLabel(Text("More")).accessibilityIdentifier("roadmap-step-roadmap-more")
  }

  // The rule, and where the owner's Done mark is set aside what that costs: the steps the step opened alone lock again,
  // as the domain reads it.
  var footer: String? {
    guard let rule = opening.rule(of: row, in: open, detaches: roadmap.owns) else { return nil }
    guard let aside = open.setAside(of: row) else { return rule }
    return "\(rule) \(RoadmapModel.Opened.markAside(relocks: aside.count))"
  }
}

// The foot's one filled control on an Up next step that opens a roadmap (Roadmap · iOS 07.2, 07.5a to 07.5c, 07.11): Open
// Roadmap or Open Subtree goes in, and Choose Roadmap pushes the attach list where the roadmap cannot be found. A roadmap
// that stands on the stack already is gone into no deeper, so the foot holds none.
struct OpenedPrimary: View {
  let roadmap: RoadmapModel
  let row: RoadmapModel.Row
  let opening: RoadmapModel.Opened

  var body: some View {
    if !opening.leads || roadmap.goesIn(to: opening) {
      Button {
        if opening.leads { roadmap.goIn(row, by: .foot) } else { roadmap.path.append(.attach(to: row.id)) }
      } label: {
        Text(opening.primary).frame(maxWidth: .infinity)
      }.buttonStyle(RoomPrimaryStyle(room: .roadmap)).padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        .accessibilityIdentifier("roadmap-open-roadmap")
    }
  }
}

// A roadmap gone into (Roadmap · iOS 07.3, 07.11b), pushed on the room's stack: its Board or its Graph under the switch
// row and the stack's foot, in a room of its own. Its bar has the system's Back, which names the roadmap gone in from, the
// roadmap's name over its progress, and its own verbs in a … menu, Guide, Kinds and Activity as tiles over Export. Switching, New
// Roadmap, Share, Rename and Delete Roadmap are the root's, and a subtree has none of them either. One the phone has yet to read waits
// with a spinner, or with no connection says it is not on this iPhone, as a cover does (09.11); the room's first read is
// the root's alone to tell.
struct RoadmapInside: View {
  let roadmap: RoadmapModel
  let app: AppModel

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if let selection = roadmap.selection, let open = roadmap.shown { BoardSelectionBar(roadmap: roadmap, selection: selection, open: open) }
      }.roomBar(.roadmap)
  }

  @ViewBuilder var content: some View {
    switch roadmap.phase {
    case .open(let open): RoadmapViews(roadmap: roadmap, open: open).modifier(InsideTitle(roadmap: roadmap, open: open))
    case .unread, .empty:
      if roadmap.root.links?.sources.online() == false {
        ContentUnavailableView {
          Label { Text("Needs a connection").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "wifi.slash").foregroundStyle(RoadmapPalette.inkDim) }
        } description: {
          Text("This roadmap isn’t on this iPhone.").foregroundStyle(RoadmapPalette.inkDim)
        }
      } else {
        ProgressView().controlSize(.large).tint(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-inside-reading")
      }
    case .failed: RoadmapRoom.FailedRead(roadmap: roadmap)
    }
  }
}

// The bar of a roadmap gone into: its name over its progress, and its … menu. While several steps are selected the title
// counts them and the menu waits. The title stands on a view of its own behind the screen, as the root's does.
struct InsideTitle: ViewModifier {
  let roadmap: RoadmapModel
  let open: RoadmapModel.OpenRoadmap

  func body(content: Content) -> some View {
    content.background { title }
      .toolbar {
        if roadmap.selection == nil {
          ToolbarItem(placement: .topBarTrailing) {
            Menu("More", systemImage: "ellipsis") {
              RoadmapViewTiles(roadmap: roadmap, open: open)
              Button("Export", systemImage: "doc.text") { roadmap.export(from: .more) }.tint(RoadmapPalette.ink)
            }.accessibilityIdentifier("roadmap-inside-more")
          }
        }
      }.roomBar(.roadmap)
  }

  @ViewBuilder var title: some View {
    if let selection = roadmap.selection {
      RoadmapTitle.SelectedTitle(selection: selection)
    } else if #available(iOS 26.0, *) {
      Color.clear.navigationTitle(open.listed.name).navigationSubtitle(roadmap.subtitle(of: open))
    } else {
      Color.clear.roomTitle(open.listed.name, subtitle: roadmap.subtitle(of: open))
    }
  }
}
