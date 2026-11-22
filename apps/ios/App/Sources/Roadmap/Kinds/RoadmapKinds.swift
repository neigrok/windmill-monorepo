import SwiftUI
import RoadmapDomain

// Kinds (Roadmap · iOS 06.1 to 06.5b): a large sheet with its own stack, raised by the title menu over the Board or by
// Edit Kinds over the step form. The roadmap's legend under its name, each entry with its disc, name, description and
// how many steps wear it, pushing its page; Add Kind while a hue is free, which makes a kind at once and opens it with
// Name focused, and the footer that says why it is gone at six. Edit is the system's edit mode, whose delete control,
// like a row's swipe, removes a kind no step wears at once, and the footer then says why the others have none. The
// band stands at the sheet's foot.
struct RoadmapKinds: View {
  let roadmap: RoadmapModel
  @State private var path: [RoadmapLegend.Subject] = []
  @State private var editing = EditMode.inactive
  // The kind Add Kind made, whose page opens once the phone's copy holds it, and that page, which opens with Name
  // focused.
  @State private var added: RoadmapLegend.Subject?
  @State private var naming: RoadmapLegend.Subject?
  // The kinds removed here that the phone's copy is still read with: the list lets a row go as its delete is written, as
  // the system's edit mode asks, and the copy follows a moment later. A delete refused leaves its row.
  @State private var removing: Set<RoadmapLegend.Subject> = []
  @ScaledMetric(relativeTo: .body) private var disc = 22.0

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if let open = roadmap.shown { list(open) }
      }.background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("Kinds").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { close }
          // Edit in the bar's ink; active, the system's checkmark in the room's accent, as 06.5 draws it.
          ToolbarItem(placement: .topBarTrailing) {
            EditButton().tint(editing.isEditing ? RoadmapPalette.accent : RoadmapPalette.ink).accessibilityIdentifier("roadmap-kinds-edit")
          }
        }.roomBar(.roadmap)
        .environment(\.editMode, $editing)
        .navigationDestination(for: RoadmapLegend.Subject.self) { subject in
          RoadmapKindPage(roadmap: roadmap, subject: subject, focusesName: subject == naming)
        }
        .roadmapFoot(roadmap) {}
        .onChange(of: added.flatMap { roadmap.shown?.legend.entry($0) } != nil) { _, held in
          guard held, let added else { return }
          (naming, self.added) = (added, nil)
          path.append(added)
        }
        .onChange(of: path.isEmpty) { _, back in if back { naming = nil } }
    }.tint(RoadmapPalette.accent).presentationDetents([.large]).presentationDragIndicator(.visible)
  }

  // The sheet's close, the system's on iOS 26.
  @ViewBuilder var close: some View {
    if #available(iOS 26.0, *) {
      Button(role: .close) { roadmap.closeKinds() }.accessibilityIdentifier("roadmap-kinds-close")
    } else {
      Button("Done") { roadmap.closeKinds() }.accessibilityIdentifier("roadmap-kinds-close")
    }
  }

  func list(_ open: RoadmapModel.OpenRoadmap) -> some View {
    let entries = open.legend.entries.filter { !removing.contains($0.id) }
    return List {
      Section {
        ForEach(entries) { entry in
          NavigationLink(value: entry.id) { row(entry) }.deleteDisabled(!entry.removable)
            .accessibilityIdentifier("roadmap-kinds-row")
        }.onDelete { places in
          for place in places where entries.indices.contains(place) {
            if roadmap.remove(entries[place].id) { removing.insert(entries[place].id) }
          }
        }
        if open.legend.freeHue != nil {
          Button("Add Kind", systemImage: "plus") { added = roadmap.addKind() }.foregroundStyle(RoadmapPalette.accent)
            .accessibilityIdentifier("roadmap-kinds-add")
        }
      } header: {
        Text(open.listed.name).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
      } footer: {
        if editing.isEditing && entries.contains(where: { !$0.removable }) {
          Text("A kind that steps wear can’t be removed.").foregroundStyle(RoadmapPalette.inkDim)
        } else if open.legend.freeHue == nil {
          Text("A roadmap has up to six kinds.").foregroundStyle(RoadmapPalette.inkDim)
        }
      }.listRowBackground(RoadmapPalette.card)
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
      .onChange(of: open.legend.entries.map(\.id)) { _, read in removing.formIntersection(read) }
  }

  // An entry's row: its disc, its name over its description, and how many steps wear it.
  func row(_ entry: RoadmapLegend.Entry) -> some View {
    LabeledContent {
      Text(verbatim: String(entry.steps)).foregroundStyle(RoadmapPalette.inkDim)
    } label: {
      HStack(spacing: 12) {
        Circle().fill(RoadmapPalette.kind(entry.hue)).frame(width: disc, height: disc).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(entry.name).foregroundStyle(RoadmapPalette.ink)
          if !entry.description.isEmpty { Text(entry.description).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
        }
      }
    }.accessibilityElement(children: .combine)
  }
}

// A kind (Roadmap · iOS 06.2, 06.3, 06.6, 10.6b), pushed inside the Kinds sheet: a settings-style form with no Save, where
// each change applies as it is made. Its name and its description, each stopping at the domain's limit, are written as
// their field leaves them; a hue no kind names takes a name or a description by becoming a kind. Color lists the six
// hues, the entry's checked: a hue another entry has is dimmed and says whose it is, and a free one recolors the kind
// and every step that wears it. While the entry a name or a colour moved the page to is still to be read, the page
// draws the entry it read last.
struct RoadmapKindPage: View {
  enum Field {
    case name, description
  }

  // The entry the page last read, which it goes on drawing while the entry its name or its colour moved to is still to
  // be read, so the page keeps its form, its focus and the keyboard.
  final class LastRead {
    private(set) var entry: RoadmapLegend.Entry?

    func read(_ now: RoadmapLegend.Entry?) -> RoadmapLegend.Entry? {
      if let now { entry = now }
      return entry
    }
  }

  let roadmap: RoadmapModel
  // The entry the page stands on, which a name, or a colour of a hue no kind names, moves.
  @State private var subject: RoadmapLegend.Subject
  @State private var last = LastRead()
  @State private var name: String
  @State private var description: String
  @State private var focusesName: Bool
  @FocusState private var focused: Field?
  @ScaledMetric(relativeTo: .body) private var disc = 22.0

  init(roadmap: RoadmapModel, subject: RoadmapLegend.Subject, focusesName: Bool) {
    self.roadmap = roadmap
    let entry = roadmap.shown?.legend.entry(subject)
    _subject = State(initialValue: subject)
    _name = State(initialValue: entry?.kind?.label ?? "")
    _description = State(initialValue: entry?.description ?? "")
    _focusesName = State(initialValue: focusesName)
  }

  var body: some View {
    if let entry = last.read(roadmap.shown?.legend.entry(subject)) {
      Form {
        Section {
          TextField("Name", text: $name).focused($focused, equals: .name)
            .onSubmit { write(.name) }.accessibilityIdentifier("roadmap-kind-name")
          TextField("What belongs here?", text: $description, axis: .vertical).focused($focused, equals: .description)
            .accessibilityIdentifier("roadmap-kind-description")
        }.foregroundStyle(RoadmapPalette.ink).listRowBackground(RoadmapPalette.card)
        Section {
          Picker("Color", selection: Binding(get: { entry.hue }, set: { subject = roadmap.recolour(subject, to: $0) })) {
            ForEach(RoadmapRules.hues, id: \.self) { hue in
              let worn = hue != entry.hue && roadmap.shown?.legend.wearer(of: hue) != nil
              colour(hue, worn: worn).tag(hue).disabled(worn)
            }
          }.pickerStyle(.inline).labelsHidden().accessibilityIdentifier("roadmap-kind-colors")
        } header: {
          Text("Color").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
        }.listRowBackground(RoadmapPalette.card)
      }.scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle(entry.name).navigationBarTitleDisplayMode(.inline)
        .onChange(of: name) { _, typed in
          let held = RoadmapSpecs.kindLabel.holding(typed)
          if held != typed { name = held }
        }
        .onChange(of: description) { _, typed in
          let held = RoadmapSpecs.kindDescription.holding(typed)
          if held != typed { description = held }
        }
        .onChange(of: focused) { left, _ in if let left { write(left) } }
        .onAppear {
          roadmap.kindOpened()
          // A kind Add Kind made opens with Name focused.
          if focusesName {
            focusesName = false
            focused = .name
          }
        }
        .onDisappear {
          write(.name)
          write(.description)
        }
    }
  }

  // A hue's row of Color: its disc and name, and where another entry has it, dimmed with whose it is.
  func colour(_ hue: String, worn: Bool) -> some View {
    HStack(spacing: 12) {
      Circle().fill(RoadmapPalette.kind(hue)).frame(width: disc, height: disc).accessibilityHidden(true)
      Text(RoadmapModel.Row.hue(hue) ?? hue).foregroundStyle(worn ? RoadmapPalette.inkFaint : RoadmapPalette.ink)
      if worn, let wearer = roadmap.shown?.legend.wearer(of: hue) {
        Spacer()
        Text(wearer.kind?.label.isEmpty == false
             ? String(localized: "In use by \(wearer.name)", comment: "A hue in a kind's Color list that another kind wears: that kind's name")
             : String(localized: "In use", comment: "A hue in a kind's Color list that steps wear with no kind named for it"))
          .font(.footnote).foregroundStyle(RoadmapPalette.inkDim)
      }
    }.accessibilityElement(children: .combine)
  }

  // A field's words as it leaves them: written where they differ from the entry's.
  func write(_ field: Field) {
    subject = field == .name ? roadmap.name(subject, name) : roadmap.describe(subject, description)
  }
}
