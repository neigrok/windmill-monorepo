import SwiftUI
import DomainKit
import GymDomain

enum MovementPickerOptions {
  static let catalogueUnread = "The catalog didn’t load. It comes back when you have signal."
  static let openers: [ID<Exercise>] = [ID("back-squat"), ID("bench-press"), ID("deadlift"),
                                      ID("overhead-press"), ID("barbell-row"), ID("chin-up")]

  struct Row: Identifiable, Equatable {
    let exercise: Exercise
    let meta: String?
    let alias: String?
    let selected: Bool
    var id: ID<Exercise> { exercise.id }
    var line: String { [exercise.equipment.capitalized, alias.map { "was “\($0)”" }, meta].compactMap { $0 }.joined(separator: " · ") }
  }

  // `create` is the query as a new movement's name, offered while no movement or former name is exactly it.
  struct Result: Equatable {
    let six: [Row]
    let matches: [Row]
    let unread: String?
    let create: String?
  }

  static func mostTrained(catalogue: [Exercise], log: TrainingLog?) -> [ID<Exercise>] {
    let finished = log?.firstPullComplete == true ? Array((log?.drawnSessions ?? []).filter { !$0.isOpen }.prefix(50)) : []
    var counts: [ID<Exercise>: Int] = [:]
    for session in finished {
      for id in Set((log?.sets(session: session.id) ?? []).map(\.exerciseId)) { counts[id, default: 0] += 1 }
    }
    let ranked = catalogue.enumerated().filter { counts[$0.element.id, default: 0] > 0 }.sorted {
      let left = counts[$0.element.id, default: 0], right = counts[$1.element.id, default: 0]
      return left == right ? $0.offset < $1.offset : left > right
    }.prefix(6).map(\.element.id)
    let available = Set(catalogue.map(\.id))
    return Array((ranked + openers.filter { available.contains($0) && !ranked.contains($0) }).prefix(6))
  }

  static func firstSession(log: TrainingLog?, routines: [Routine], readFailed: Bool) -> Bool {
    guard !readFailed, let log, log.firstPullComplete else { return false }
    return log.drawnSessions.allSatisfy(\.isOpen) && routines.isEmpty
  }

  static func matching(query: String, catalogue: [Exercise], selected: Set<ID<Exercise>>,
                       log: TrainingLog?, featured: [ID<Exercise>]? = nil, readFailed: Bool = false) -> Result {
    let term = MovementName.trimmed(query).lowercased()
    let featured = term.isEmpty ? featured ?? mostTrained(catalogue: catalogue, log: log) : []
    // A logged movement adds its last effort and when; before its first log the equipment says enough.
    let makeRow = { (exercise: Exercise, alias: String?) -> Row in
      var meta: String?
      if let log, case let last = log.lastTime(for: exercise.id), let set = last.sets.last, let session = last.session {
        meta = "\(Readout.effort(weightKg: set.weightKg, reps: set.reps)) · \(Readout.ago(session.startedAt, now: log.moment.now, zone: log.moment.zone))"
      }
      return Row(exercise: exercise, meta: meta, alias: alias, selected: selected.contains(exercise.id))
    }
    let six = featured.compactMap { id in catalogue.first { $0.id == id }.map { makeRow($0, nil) } }
    let rest = catalogue.filter { exercise in !six.contains { $0.id == exercise.id } }.compactMap { exercise -> Row? in
      if term.isEmpty || exercise.name.lowercased().contains(term) { return makeRow(exercise, nil) }
      guard let alias = exercise.aliases.first(where: { $0.lowercased().contains(term) }) else { return nil }
      return makeRow(exercise, alias)
    }
    let matches = term.isEmpty ? rest : Array(rest.prefix(7))
    let unread = readFailed || catalogue.isEmpty ? catalogueUnread : nil
    let exact = catalogue.contains { ([$0.name] + $0.aliases).contains { MovementName.trimmed($0).lowercased() == term } }
    return Result(six: six, matches: matches, unread: unread,
                  create: term.isEmpty || exact || unread != nil ? nil : MovementName.capped(MovementName.trimmed(query)))
  }
}

struct MovementPickerRanking {
  private(set) var ids: [ID<Exercise>]?

  mutating func capture(catalogue: [Exercise], log: TrainingLog?) {
    guard ids == nil, !catalogue.isEmpty, let log, log.firstPullComplete,
          log.drawnSessions.contains(where: { !$0.isOpen }) else { return }
    ids = MovementPickerOptions.mostTrained(catalogue: catalogue, log: log)
  }
}

struct MovementCreationDraft {
  let id: ID<Exercise>
  var name: String
  var equipment = "barbell"
  var loadCount = 2
  var sets: [SetTarget]?
  var refusal: String?
  static let equipmentChoices = MovementEquipment.choices

  var exercise: Exercise {
    Exercise(id: id, name: MovementName.trimmed(name), pattern: "isolation", equipment: equipment,
             stepKg: ExerciseRules.defaultStepKg(equipment: equipment), loadCount: loadCount)
  }

  var problem: String? {
    if let problem = MovementName.problem(name) { return problem }
    if !Self.equipmentChoices.contains(equipment) { return "check the movement name and equipment" }
    return nil
  }

  // A draft reopens as the owner left it; a nameless one takes the search it opens from.
  mutating func takeQuery(_ query: String) {
    if MovementName.trimmed(name).isEmpty { name = MovementName.capped(MovementName.trimmed(query)) }
  }
}

extension GymModel {
  func createMovement(_ draft: inout MovementCreationDraft) -> RoutineEntry? {
    if let problem = draft.problem { draft.refusal = problem; return nil }
    guard let outcome = run(CreateExercise(draft.exercise)), outcome.refusal == nil else {
      draft.refusal = error ?? "The movement wasn’t created. Try again."
      return nil
    }
    draft.refusal = nil
    return RoutineEntry(exerciseId: draft.id, sets: draft.sets)
  }
}

struct MovementPicker: View {
  // Where the picker opens decides its title, what a row does and what a created movement joins.
  enum Purpose {
    case routine, workout, browse

    var title: String {
      switch self {
      case .routine: "Add movement"
      case .workout: "Next movement"
      case .browse: "Movements"
      }
    }
    var screen: String { self == .routine ? "routine_movement" : "movement" }
  }

  let gym: GymModel
  let purpose: Purpose
  let selected: Set<ID<Exercise>>
  let onSelect: (RoutineEntry) -> Void
  let onBuildRoutine: (() -> Void)?
  let externalQuery: Binding<String>?
  let onCreate: (() -> Void)?
  let onCancel: (() -> Void)?
  @Environment(\.dismiss) var dismiss
  @State var query = ""
  @FocusState private var searchFocused: Bool
  @State var ranking = MovementPickerRanking()
  @State var creation: MovementCreationDraft?
  @State var showingCreation = false
  @State private var created: ID<Exercise>?
  @State private var opened: ID<Exercise>?
  @State private var pickingAccount: String?
  @State private var pickingAnonymous: Bool

  init(gym: GymModel, purpose: Purpose, selected: Set<ID<Exercise>> = [], onBuildRoutine: (() -> Void)? = nil,
       query: Binding<String>? = nil, onCreate: (() -> Void)? = nil, onCancel: (() -> Void)? = nil,
       onSelect: @escaping (RoutineEntry) -> Void = { _ in }) {
    self.gym = gym; self.purpose = purpose; self.selected = selected
    self.onBuildRoutine = onBuildRoutine; self.onSelect = onSelect
    externalQuery = query; self.onCreate = onCreate; self.onCancel = onCancel
    _pickingAccount = State(initialValue: gym.account); _pickingAnonymous = State(initialValue: gym.isAnonymous)
  }

  var firstSession: Bool { MovementPickerOptions.firstSession(log: gym.log, routines: gym.routines, readFailed: gym.readFailed) }

  // The builder pushes Create movement over its picker, so its search stays a field in the list: a search controller left
  // active under the pushed step would take the taps meant for its bar.
  var body: some View {
    Group {
      if externalQuery == nil {
        movementList.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search movements")
          .searchFocused($searchFocused)
      } else { movementList }
    }
    .accessibilityIdentifier("gym-movement-picker")
    .autocorrectionDisabled()
    .modifier(GymPage())
    .navigationTitle(purpose.title)
    .toolbar {
      if purpose != .browse {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if let onCancel { onCancel() } else { dismiss() } } }
      }
      if MovementName.trimmed(externalQuery?.wrappedValue ?? query).isEmpty {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New movement", systemImage: "plus") { create() }.labelStyle(.iconOnly)
            .disabled(gym.accountTransition).accessibilityIdentifier("gym-new-movement")
        }
      }
    }.roomBar(.gym)
    .reachBand { GymTransient(gym: gym) }
    .onAppear {
      ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log)
      gym.telemetry.event("gym_screen_viewed", properties: ["screen": purpose.screen])
    }
    .onChange(of: gym.sessions) { _, _ in ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log) }
    .onChange(of: gym.sets) { _, _ in ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log) }
    .onChange(of: gym.log?.firstPullComplete) { _, _ in ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log) }
    .sheet(isPresented: $showingCreation, onDismiss: { if let created { creation = nil; opened = created; self.created = nil } }) {
      if let draft = creation {
        NavigationStack {
          CreateMovementSheet(gym: gym, draft: Binding(get: { creation ?? draft }, set: { creation = $0 }), purpose: purpose,
                              account: pickingAccount, anonymous: pickingAnonymous) { entry in
            if purpose == .browse { created = entry.exerciseId; showingCreation = false }
            else { onSelect(entry) }
          }
        }.modifier(GymPage()).presentationDetents([.medium])
      }
    }
    .navigationDestination(item: $opened) { id in MovementRecordScreen(gym: gym, exerciseID: id) }
    .gymTabBar(hidden: purpose == .browse)
  }

  // Create movement opens with the query as its name: the builder's own step, or this picker's sheet.
  func create() {
    searchFocused = false
    if let onCreate { onCreate(); return }
    var draft = creation ?? MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "")
    draft.takeQuery(query)
    creation = draft; showingCreation = true
  }

  private var movementList: some View {
    let query = externalQuery?.wrappedValue ?? self.query
    let options = MovementPickerOptions.matching(query: query, catalogue: gym.catalogue.exercises, selected: selected,
                                                 log: gym.log, featured: ranking.ids, readFailed: gym.readFailed)
    let unread = gym.readFailed ? nil : options.unread
    return List {
      Group {
        if let externalQuery {
          Section {
            HStack {
              Image(systemName: "magnifyingglass").foregroundStyle(GymPalette.inkDim)
              TextField("Search movements", text: externalQuery).focused($searchFocused)
                .textInputAutocapitalization(.never).onSubmit { searchFocused = false }
                .accessibilityIdentifier("gym-movement-search")
              if !query.isEmpty {
                Button { externalQuery.wrappedValue = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(GymPalette.inkDim).frame(minWidth: 44, minHeight: 44) }
                  .buttonStyle(.plain).accessibilityLabel("Clear search").accessibilityIdentifier("gym-movement-search-clear")
              }
            }
          } footer: { if let unread { Text(unread) } }
        } else if let unread {
          Section {} footer: { Text(unread) }
        }
        if let name = options.create {
          Section {
            Button { create() } label: { Label("Create “\(name)”", systemImage: "plus.circle.fill") }
              .disabled(gym.accountTransition).accessibilityIdentifier("gym-create-movement")
          }
        }
        if !options.six.isEmpty { Section("The six") { ForEach(options.six) { movementRow($0) } } }
        if !options.matches.isEmpty {
          Section(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "All movements" : "Matches") {
            ForEach(options.matches) { movementRow($0) }
          }
        }
        if purpose == .workout && firstSession {
          Section {
            Text(gym.isAnonymous ? "Have a written program? An agent can build it — sign in first." : "Have a written program? Ask Coach to build it into a routine.")
            if let onBuildRoutine { Button("Build my routine") { dismiss(); onBuildRoutine() }.accessibilityIdentifier("gym-build-written-program") }
          }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped)
  }

  @ViewBuilder func movementRow(_ row: MovementPickerOptions.Row) -> some View {
    if purpose == .browse {
      NavigationLink { MovementRecordScreen(gym: gym, exerciseID: row.id) } label: {
        GymRow(title: row.exercise.name, meta: row.line)
      }.accessibilityIdentifier("gym-movement-\(row.id.record.string ?? "")")
    } else {
      Button {
        onSelect(RoutineEntry(exerciseId: row.id))
      } label: {
        GymRow(title: row.exercise.name, meta: row.line, trailing: row.selected ? .check : nil)
      }
      .disabled(row.selected || gym.accountTransition)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(row.selected ? [.isSelected] : [])
      .accessibilityHint(row.selected ? "Already added" : "Add movement")
      .accessibilityIdentifier("gym-movement-\(row.id.record.string ?? "")")
    }
  }
}

struct CreateMovementSheet: View {
  let gym: GymModel
  @Binding var draft: MovementCreationDraft
  let purpose: MovementPicker.Purpose
  let onCreated: (RoutineEntry) -> Void
  let onCancel: (() -> Void)?
  @Environment(\.dismiss) var dismiss
  @FocusState var nameFocused: Bool
  @State var busy = false
  @State private var creatingAccount: String?
  @State private var creatingAnonymous: Bool

  init(gym: GymModel, draft: Binding<MovementCreationDraft>, purpose: MovementPicker.Purpose, account: String?, anonymous: Bool,
       onCancel: (() -> Void)? = nil, onCreated: @escaping (RoutineEntry) -> Void) {
    self.gym = gym; _draft = draft; self.purpose = purpose; self.onCreated = onCreated; self.onCancel = onCancel
    _creatingAccount = State(initialValue: account); _creatingAnonymous = State(initialValue: anonymous)
  }

  var body: some View {
    Form {
      Group {
        Section {
          TextField("Name", text: $draft.name).focused($nameFocused).autocorrectionDisabled().textInputAutocapitalization(.words).onSubmit { nameFocused = false }
            .disabled(busy).accessibilityIdentifier("gym-movement-name")
          if let counter = MovementName.counter(draft.name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
          MovementEquipmentPicker(equipment: $draft.equipment, loadCount: $draft.loadCount, identifier: "gym-movement-equipment").disabled(busy)
        } footer: { Text(MovementEquipment(draft.equipment).help) }
        if purpose == .routine {
          Section {
            NavigationLink(value: RoutineEditingSession.Step.targets(draft.id)) {
              LabeledContent { Text(Readout.target(draft.sets)).monospacedDigit() } label: { Text("Targets").foregroundStyle(GymPalette.ink) }
            }.disabled(busy).accessibilityIdentifier("gym-movement-targets")
          }
        }
      }.listRowBackground(GymPalette.card)
    }
    .modifier(GymPage()).accessibilityIdentifier("gym-movement-creation")
    .navigationTitle("Create movement")
    .sheetCommit("Add", identifier: "gym-movement-create-commit",
                 disabled: gym.accountTransition || MovementName.trimmed(draft.name).isEmpty, busy: busy,
                 dismiss: { if let onCancel { onCancel() } else { dismiss() } }, commit: add)
    .reachBand {
      GymTransient(gym: gym, message: draft.refusal, dismiss: { draft.refusal = nil }, errorIdentifier: "gym-movement-creation-refusal")
    }
    .interactiveDismissDisabled(busy)
    .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": purpose.screen]) }
    .onChange(of: draft.name) { _, value in draft.name = MovementName.capped(value); draft.refusal = nil }
    .onChange(of: draft.equipment) { _, _ in draft.refusal = nil }
  }

  func add() {
    guard creatingAccount == gym.account, creatingAnonymous == gym.isAnonymous else {
      draft.refusal = "the account changed while creating"; return
    }
    busy = true; nameFocused = false
    let account = gym.account, anonymous = gym.isAnonymous
    Task { @MainActor in
      await Task.yield()
      guard account == gym.account && anonymous == gym.isAnonymous else {
        draft.refusal = "the account changed while creating"; busy = false; return
      }
      let entry = gym.createMovement(&draft)
      busy = false
      if let entry { onCreated(entry) }
    }
  }
}
