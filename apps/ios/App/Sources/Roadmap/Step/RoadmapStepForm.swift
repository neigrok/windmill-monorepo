import SwiftUI
import UIKit
import RoadmapDomain
import SyncCore

// The step form (Roadmap · iOS 05.1, 05.5, 05.6a, 05.8, 05.10): a large sheet with its own stack over one draft. Name
// and Description, then Kind, Requires and Opens, each pushed inside the sheet and bound to the draft, the links the
// step shares, each sliding left for Delete, with Add Link raising the link form, and Delete Step on a step that may go. Cancel and Create or Save stand in the bar and are the form's only ways out: Cancel asks once
// on a changed draft, which a swipe down does not send away. A refusal is its section's footer in ink, announced as it
// comes. The room's band stands at the sheet's foot, away while a field has the keyboard.
struct RoadmapStepForm: View {
  enum Field {
    case name, description
  }

  let roadmap: RoadmapModel
  @Bindable var draft: StepDraft
  // What the two fields show: what was typed goes to the draft, and the field takes back what the draft kept of it,
  // so it stops at the domain's limit.
  @State private var name: String
  @State private var description: String
  @State private var addingLink = false
  @FocusState private var focused: Field?

  init(roadmap: RoadmapModel, draft: StepDraft) {
    self.roadmap = roadmap
    self.draft = draft
    _name = State(initialValue: draft.name)
    _description = State(initialValue: draft.description)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name this step", text: $name).focused($focused, equals: .name).accessibilityIdentifier("roadmap-form-name")
          TextField("What does this step cover?", text: $description, axis: .vertical).lineLimit(3...)
            .focused($focused, equals: .description).accessibilityIdentifier("roadmap-form-description")
        } footer: {
          if draft.refusal == .name { refusal }
        }.foregroundStyle(RoadmapPalette.ink).listRowBackground(RoadmapPalette.card)
        Section {
          NavigationLink { StepKinds(draft: draft) } label: {
            row("Kind", value: draft.kinds.first { $0.hue == draft.kind }?.name ?? "")
          }.accessibilityIdentifier("roadmap-form-kind")
          list(.requires, "Requires").accessibilityIdentifier("roadmap-form-requires")
          list(.opens, "Opens").accessibilityIdentifier("roadmap-form-opens")
        } footer: {
          if case .loop = draft.refusal { refusal }
          else if draft.moves { Text(draft.placement).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-form-placement") }
        }.listRowBackground(RoadmapPalette.card)
        Section {
          ForEach(Array(draft.links.enumerated()), id: \.offset) { link in
            let address = LinkAddress(link.element.url)
            StepLinkRow(title: link.element.label.nilIfEmpty ?? link.element.url, host: address?.url.host())
              .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Delete", systemImage: "trash", role: .destructive) { draft.removeLink(at: link.offset) }.tint(nil)
              }.accessibilityIdentifier("roadmap-form-link")
          }
          if draft.takesLink {
            Button("Add Link") { addingLink = true }.tint(RoadmapPalette.accent).accessibilityIdentifier("roadmap-form-add-link")
          }
        } header: {
          Text("Links").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
        }.listRowBackground(RoadmapPalette.card)
        if !draft.isNew, let step = draft.open?.step(draft.step.description), step.deletes {
          Section {
            Button("Delete Step", role: .destructive) { roadmap.askDelete(step, by: .form) }
              .modifier(DeleteQuestion(roadmap: roadmap, step: step.id, by: [.form])).accessibilityIdentifier("roadmap-form-delete")
          }.listRowBackground(RoadmapPalette.card)
        }
      }.scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle(draft.isNew ? Text("New Step") : Text("Edit Step")).navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { draft.cancel() }
              .confirmationDialog("Discard draft?", isPresented: $draft.asksDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) { draft.discard() }
              }.accessibilityIdentifier("roadmap-form-cancel")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button {
              focused = nil
              draft.save()
            } label: {
              draft.isNew ? Text("Create") : Text("Save")
            }.fontWeight(.semibold).disabled(!draft.commits).accessibilityIdentifier("roadmap-form-commit")
          }
        }.roomBar(.roadmap)
        .roadmapFoot(roadmap, away: focused != nil) {}
        .sheet(isPresented: $addingLink) {
          NewLink(title: RoadmapSpecs.linkLabel, address: RoadmapSpecs.linkUrl) { address, title in
            draft.add(link: address, titled: title)
            addingLink = false
          }
        }
        .sheet(isPresented: Binding(get: { roadmap.kindsDoor == .form }, set: { if !$0 { roadmap.closeKinds() } })) { RoadmapKinds(roadmap: roadmap) }
    }.tint(RoadmapPalette.accent).presentationDetents([.large]).presentationDragIndicator(.visible)
      .interactiveDismissDisabled(draft.isChanged)
      .onChange(of: name) { _, typed in
        draft.name = typed
        name = draft.name
      }
      .onChange(of: description) { _, typed in
        draft.description = typed
        description = draft.description
      }
      .onChange(of: draft.refusal) { _, refused in
        if refused != nil, let words = draft.refusalWords { UIAccessibility.post(notification: .announcement, argument: words) }
      }
  }

  var refusal: some View {
    Text(draft.refusalWords ?? "").foregroundStyle(RoadmapPalette.ink).accessibilityIdentifier("roadmap-form-refusal")
  }

  // A row that names what it sets and says its value.
  func row(_ title: LocalizedStringResource, value: String) -> some View {
    LabeledContent {
      Text(value).foregroundStyle(RoadmapPalette.inkDim)
    } label: {
      Text(title).foregroundStyle(RoadmapPalette.ink)
    }
  }

  // Requires or Opens: the names of the steps chosen, or None, and the list they are chosen in. In a roadmap with no
  // other step the row stands disabled.
  func list(_ side: StepDraft.Side, _ title: LocalizedStringResource) -> some View {
    let names = draft.names(side)
    return NavigationLink { StepChoices(draft: draft, side: side) } label: {
      row(title, value: names.isEmpty ? String(localized: "None", comment: "A step's form: no step is chosen in Requires or in Opens")
        : names.formatted(.list(type: .and, width: .narrow)))
    }.disabled(!draft.offersSteps)
  }
}

// Kind (Roadmap · iOS 05.2), pushed inside the form: the six kinds, the chosen one checked. A tap chooses and returns,
// as a single-choice picker's list does. Edit Kinds raises the Kinds sheet over the form.
struct StepKinds: View {
  let draft: StepDraft
  @Environment(\.dismiss) private var dismiss
  @ScaledMetric(relativeTo: .body) private var disc = 22.0

  var body: some View {
    List {
      Section {
        ForEach(draft.kinds) { kind in
          Button {
            draft.kind = kind.hue
            dismiss()
          } label: {
            HStack(spacing: 12) {
              Circle().fill(RoadmapPalette.kind(kind.hue)).frame(width: disc, height: disc).accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 2) {
                Text(kind.name).foregroundStyle(RoadmapPalette.ink)
                if !kind.description.isEmpty { Text(kind.description).font(.footnote).foregroundStyle(RoadmapPalette.inkDim) }
              }.frame(maxWidth: .infinity, alignment: .leading)
              if kind.hue == draft.kind { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(RoadmapPalette.accent).accessibilityHidden(true) }
            }.contentShape(Rectangle())
          }.buttonStyle(.plain).listRowBackground(RoadmapPalette.card)
            .listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: RoomSpace.inset))
            .accessibilityElement(children: .combine).accessibilityAddTraits(kind.hue == draft.kind ? .isSelected : [])
            .accessibilityIdentifier("roadmap-kind")
        }
      }
      Section {
        Button("Edit Kinds") { draft.room.openKinds(from: .form) }.foregroundStyle(RoadmapPalette.accent).accessibilityIdentifier("roadmap-edit-kinds")
      }.listRowBackground(RoadmapPalette.card)
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .navigationTitle("Kind").navigationBarTitleDisplayMode(.inline).roomBar(.roadmap)
  }
}

// Requires and Opens (Roadmap · iOS 05.3, 05.4, 05.6b), pushed inside the form and bound to the draft: a tap takes or
// drops the checkmark in place, and Back returns. The steps chosen as the list opened head it under Selected, where a
// search never hides them; the steps that would close a loop stand dimmed in their own group, whose footer says why
// once and, after a tap on one, names it in ink.
struct StepChoices: View {
  let draft: StepDraft
  let side: StepDraft.Side
  @State private var chosenAtOpening: [StepDraft.StepID]
  @State private var query = ""
  @ScaledMetric(relativeTo: .body) private var symbolColumn = 24.0

  init(draft: StepDraft, side: StepDraft.Side) {
    self.draft = draft
    self.side = side
    _chosenAtOpening = State(initialValue: draft.chosen(side))
  }

  var body: some View {
    let choices = draft.choices(of: side, chosenAtOpening: chosenAtOpening, finding: query)
    let reason = side == .requires ? String(localized: "These come after this step.") : String(localized: "These come before this step.")
    return List {
      if !choices.selected.isEmpty { Section { rows(choices.selected) } header: { header("Selected") } }
      if !choices.all.isEmpty { Section { rows(choices.all) } header: { header("All steps") } }
      if !choices.blocked.isEmpty {
        Section {
          rows(choices.blocked, dimmedBecause: reason)
        } header: {
          header(side == .requires ? "Can’t be prerequisites" : "Can’t be opened")
        } footer: {
          if case .loop = draft.refusal {
            Text(draft.refusalWords ?? "").foregroundStyle(RoadmapPalette.ink).accessibilityIdentifier("roadmap-form-refusal")
          } else { Text(reason).foregroundStyle(RoadmapPalette.inkDim) }
        }
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden)
      .overlay {
        if !query.isEmpty && choices.selected.isEmpty && choices.all.isEmpty && choices.blocked.isEmpty { ContentUnavailableView.search(text: query) }
      }
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a step")
      .navigationTitle(side == .requires ? Text("Requires") : Text("Opens")).navigationBarTitleDisplayMode(.inline).roomBar(.roadmap)
      .onDisappear { draft.listClosed() }
  }

  func header(_ title: LocalizedStringResource) -> some View {
    Text(title).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
  }

  // A step's row: its state's symbol in its kind's colour, its name, and the checkmark while the draft holds it. A
  // dimmed row takes its tap too, which the draft refuses, and says as its hint why its group cannot be chosen.
  func rows(_ rows: [RoadmapModel.Row], dimmedBecause reason: String? = nil) -> some View {
    ForEach(rows) { row in
      let checked = draft.chosen(side).contains(StepDraft.StepID(RecordID(row.id)))
      Button { draft.toggle(row, in: side) } label: {
        HStack(spacing: 12) {
          Image(systemName: row.card.column.symbol).imageScale(.large).foregroundStyle(RoadmapPalette.kind(row.step.color))
            .frame(width: symbolColumn).accessibilityHidden(true)
          Text(row.name).foregroundStyle(reason == nil ? RoadmapPalette.ink : RoadmapPalette.inkFaint).frame(maxWidth: .infinity, alignment: .leading)
          if checked { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(RoadmapPalette.accent).accessibilityHidden(true) }
        }.contentShape(Rectangle())
      }.buttonStyle(.plain).listRowBackground(RoadmapPalette.card)
        .listRowInsets(EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: RoomSpace.inset))
        .accessibilityAddTraits(checked ? .isSelected : []).accessibilityHint(reason ?? "")
        .accessibilityIdentifier("roadmap-choice")
    }
  }
}

// The form's words over what the draft tells, each the boards' own.
extension StepDraft {
  // Where the step will land: Up next with nothing it requires left to do, else Locked, naming what is not done.
  var placement: String {
    let waiting = unmet.map(\.name)
    switch waiting.count {
    case 0: return String(localized: "Lands in Up next")
    case 1: return String(localized: "Lands in Locked · \(waiting[0]) isn’t done", comment: "A step's form: the one step it requires that is not done")
    case 2:
      return String(localized: "Lands in Locked · \(waiting[0]) and \(waiting[1]) aren’t done",
                    comment: "A step's form: the two steps it requires that are not done")
    default:
      return String(localized: "Lands in Locked · \(waiting[0]) and \(waiting.count - 1) more aren’t done", locale: .copy,
                    comment: "A step's form: the first step it requires that is not done, and how many more are not")
    }
  }

  // What the standing refusal says.
  var refusalWords: String? {
    switch refusal {
    case nil: return nil
    case .name: return String(localized: "Enter a name for this step.")
    case .loop(let other, let side):
      let name = RoadmapModel.Row.name(of: open?.tree.step(other.description)?.label ?? "")
      if side == .requires { return String(localized: "\(name) comes after this step.", comment: "A step's form: a step that cannot be required, by its name") }
      return String(localized: "\(name) comes before this step.", comment: "A step's form: a step that cannot be opened, by its name")
    }
  }
}
