import SwiftUI
import DomainKit
import RoadmapDomain

// The workspace on a step's page (Roadmap · iOS 03.2, 03.3, 03.5, 03.14): Subtasks, Note and Your links, three ordinary
// sections of the page's list after what the step opens. Each is the person's alone, which the first header says once.
// A tap checks a subtask in place, Add Subtask is a field in the list whose return key adds one and keeps the field,
// and a subtask or a link slides left for Delete. The note's row opens the note's screen, and Add Link raises the link
// form. A section that holds nothing is its one add row.
struct StepWorkspaceSections: View {
  let roadmap: RoadmapModel
  let step: String
  let workspace: StepWorkspace
  // Add Subtask's field, whose keyboard takes the page's foot away.
  let addingSubtask: FocusState<Bool>.Binding
  @Binding var addingLink: Bool
  @State private var subtask = ""
  @ScaledMetric(relativeTo: .body) private var symbolColumn = 24.0

  var body: some View {
    Section {
      ForEach(workspace.subtasks, id: \.id) { subtask in
        Toggle(isOn: Binding(get: { subtask.done }, set: { _ in roadmap.toggle(subtask) })) {
          Text(subtask.label).foregroundStyle(subtask.done ? RoadmapPalette.inkDim : RoadmapPalette.ink)
        }.toggleStyle(SubtaskCheck(column: symbolColumn))
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", systemImage: "trash", role: .destructive) { roadmap.remove(subtask) }.tint(nil)
          }.accessibilityIdentifier("roadmap-subtask")
      }
      TextField(text: $subtask, prompt: Text("Add Subtask").foregroundStyle(RoadmapPalette.accent)) { Text("Add Subtask") }
        .foregroundStyle(RoadmapPalette.ink).focused(addingSubtask)
        .onSubmit {
          guard roadmap.addSubtask(subtask, to: step) else { return }
          subtask = ""
          addingSubtask.wrappedValue = true
        }
        .onChange(of: subtask) { _, typed in subtask = RoadmapSpecs.subtask.holding(typed) }
        .accessibilityLabel("Add Subtask").accessibilityIdentifier("roadmap-add-subtask")
    } header: {
      let tally = String(localized: "\(workspace.done) of \(workspace.subtasks.count)", locale: .copy,
                         comment: "How many of a step's subtasks are checked, of how many, beside Subtasks")
      StepSectionHeader(title: "Subtasks", count: workspace.subtasks.isEmpty ? nil : tally, onlyYou: true)
        .accessibilityIdentifier("roadmap-step-subtasks")
    } footer: {
      if workspace.allDone { Text("All subtasks done").foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-subtasks-done") }
    }.listRowBackground(RoadmapPalette.card)
    Section {
      if let note = workspace.note {
        NavigationLink(value: roadmap.stacked(.note(of: step))) {
          Text(NoteText.read(note.text)).foregroundStyle(RoadmapPalette.ink)
        }.accessibilityIdentifier("roadmap-note")
      } else {
        Button("Add Note") { roadmap.path.append(.note(of: step)) }.accessibilityIdentifier("roadmap-add-note")
      }
    } header: {
      StepSectionHeader(title: "Note")
    }.listRowBackground(RoadmapPalette.card)
    Section {
      ForEach(workspace.links) { link in
        StepLinkRow(title: link.title, host: link.address.host, opens: link.address.url)
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", systemImage: "trash", role: .destructive) { roadmap.remove(link) }.tint(nil)
          }.accessibilityIdentifier("roadmap-step-link")
      }
      Button("Add Link") {
        roadmap.linkFormOpened()
        addingLink = true
      }.accessibilityIdentifier("roadmap-add-link")
    } header: {
      StepSectionHeader(title: "Your links")
    }.listRowBackground(RoadmapPalette.card)
  }
}

// The header of a section of a step's page: its name, its count where it has one, and on the first section of the
// workspace that what follows is the person's alone.
struct StepSectionHeader: View {
  let title: LocalizedStringResource
  var count: String?
  var onlyYou = false

  var body: some View {
    HStack(spacing: 6) {
      Text(title).fontWeight(.semibold)
      if let count { Text(count) }
      if onlyYou {
        Spacer()
        Label("Only you", systemImage: "lock.fill").labelStyle(.titleAndIcon)
      }
    }.font(.footnote).foregroundStyle(RoadmapPalette.inkDim).textCase(nil).accessibilityElement(children: .combine)
  }
}

// A subtask's check (the kit's Row / Subtask): a ring a tap fills, in the room's accent. VoiceOver hears the switch it is.
struct SubtaskCheck: ToggleStyle {
  let column: Double

  func makeBody(configuration: Configuration) -> some View {
    Button { configuration.isOn.toggle() } label: {
      HStack(spacing: 12) {
        Image(systemName: configuration.isOn ? "checkmark.circle.fill" : "circle").imageScale(.large)
          .foregroundStyle(configuration.isOn ? RoadmapPalette.accent : RoadmapPalette.inkFaint).frame(width: column)
        configuration.label.frame(maxWidth: .infinity, alignment: .leading)
      }.contentShape(Rectangle())
    }.buttonStyle(.plain)
      .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
  }
}

// A link's row wherever the room lists links (the kit's Row / Link): its title over its host. On a step's page it opens
// its address; in the step's form, where a link is part of the draft, it only stands.
struct StepLinkRow: View {
  let title: String
  let host: String?
  var opens: URL?
  @ScaledMetric(relativeTo: .body) private var symbolColumn = 24.0

  var body: some View {
    let row = HStack(spacing: 12) {
      Image(systemName: "link").frame(width: symbolColumn).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
        if let host { Text(host).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
      }
    }.foregroundStyle(RoadmapPalette.accent)
    if let opens { Link(destination: opens) { row } } else { row.accessibilityElement(children: .combine) }
  }
}

// New Link (Roadmap · iOS 03.11): the two-field form Add Link raises, for a link the person keeps on a step's page or
// one the step shares in its form. Add stays dimmed until the address is one the phone can open; a field holds no more
// than the domain takes of it. Cancel, or the sheet sent away, adds nothing.
struct NewLink: View {
  enum Field {
    case title, address
  }

  // The most the domain takes of a title and of an address, for the link this form adds.
  let title: TextSpec
  let address: TextSpec
  // Adds the link; whoever raised the form closes it once the link is taken.
  let add: (LinkAddress, String) -> Void
  @State private var typedTitle = ""
  @State private var typedAddress = ""
  @FocusState private var focused: Field?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let link = LinkAddress(typed: typedAddress)
    NavigationStack {
      Form {
        Section {
          LabeledContent("Title") {
            TextField("Title", text: $typedTitle, prompt: Text(verbatim: "")).focused($focused, equals: .title).submitLabel(.next)
              .onSubmit { focused = .address }.accessibilityIdentifier("roadmap-link-title")
          }
          LabeledContent("URL") {
            TextField("URL", text: $typedAddress, prompt: Text(verbatim: "")).focused($focused, equals: .address).keyboardType(.URL)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .onSubmit { if let link { add(link, typedTitle) } }.accessibilityIdentifier("roadmap-link-url")
          }
        }.foregroundStyle(RoadmapPalette.ink).listRowBackground(RoadmapPalette.card)
      }.scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("New Link").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }.accessibilityIdentifier("roadmap-link-cancel")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Add") { if let link { add(link, typedTitle) } }.fontWeight(.semibold).disabled(link == nil)
              .accessibilityIdentifier("roadmap-link-add")
          }
        }.roomBar(.roadmap)
        .onChange(of: typedTitle) { _, typed in typedTitle = title.holding(typed) }
        .onChange(of: typedAddress) { _, typed in typedAddress = address.holding(typed) }
        .onAppear { focused = .title }
    }.tint(RoadmapPalette.accent).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
  }
}
