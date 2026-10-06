import SwiftUI
import DomainKit
import GymDomain

enum MovementName {
  static func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

  static func capped(_ value: String) -> String {
    String(String.UnicodeScalarView(value.unicodeScalars.prefix(60)))
  }

  static func problem(_ value: String) -> String? {
    let name = trimmed(value)
    if name.isEmpty { return "Name it to save it." }
    if name.unicodeScalars.count > 60 { return "Use 60 characters or fewer." }
    return nil
  }

  static func counter(_ value: String) -> String? {
    let count = value.unicodeScalars.count
    return count < 48 ? nil : "\(count)/60"
  }

  static func changed(from: String, to: String) -> Bool {
    problem(to) == nil && trimmed(to) != from
  }
}

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
  }

  struct Result: Equatable {
    let six: [Row]
    let matches: [Row]
    let unread: String?
    let empty: String?
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
    let makeRow = { (exercise: Exercise, alias: String?) -> Row in
      var meta: String?
      if let log {
        let last = log.lastTime(for: exercise.id)
        if let set = last.sets.last, let session = last.session {
          meta = "last \(Readout.effort(weightKg: set.weightKg, reps: set.reps)) · \(Readout.ago(session.startedAt, now: log.moment.now, zone: log.moment.zone))"
        } else if last.isComplete && !readFailed { meta = "never logged" }
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
    return Result(six: six, matches: matches, unread: unread,
                  empty: six.isEmpty && matches.isEmpty && unread == nil ? "No movement by that name." : nil)
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
  var sets: [SetTarget]?
  var refusal: String?
  static let equipmentChoices = ["barbell", "dumbbell", "machine", "bodyweight"]

  var exercise: Exercise {
    Exercise(id: id, name: MovementName.trimmed(name), pattern: "isolation", equipment: equipment,
             stepKg: ExerciseRules.defaultStepKg(equipment: equipment))
  }

  func problem(includesTargets: Bool) -> String? {
    if let problem = MovementName.problem(name) { return problem }
    if !Self.equipmentChoices.contains(equipment) { return "check the movement name and equipment" }
    if includesTargets && (sets?.isEmpty ?? true) { return "Choose at least one set." }
    return nil
  }
}

extension GymModel {
  func createMovement(_ draft: inout MovementCreationDraft, includesTargets: Bool) -> RoutineEntry? {
    if let problem = draft.problem(includesTargets: includesTargets) { draft.refusal = problem; return nil }
    guard let outcome = run(CreateExercise(draft.exercise)), outcome.refusal == nil else {
      draft.refusal = error ?? "The movement wasn’t created. Try again."
      return nil
    }
    draft.refusal = nil
    return RoutineEntry(exerciseId: draft.id, sets: includesTargets ? draft.sets : nil)
  }
}

struct MovementPicker: View {
  let gym: GymModel
  let selected: Set<ID<Exercise>>
  let includesTargets: Bool
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
  @State private var pickingAccount: String?
  @State private var pickingAnonymous: Bool

  init(gym: GymModel, selected: Set<ID<Exercise>>, includesTargets: Bool,
       onBuildRoutine: (() -> Void)? = nil, query: Binding<String>? = nil,
       onCreate: (() -> Void)? = nil, onCancel: (() -> Void)? = nil, onSelect: @escaping (RoutineEntry) -> Void) {
    self.gym = gym; self.selected = selected; self.includesTargets = includesTargets
    self.onBuildRoutine = onBuildRoutine; self.onSelect = onSelect
    externalQuery = query; self.onCreate = onCreate; self.onCancel = onCancel
    _pickingAccount = State(initialValue: gym.account); _pickingAnonymous = State(initialValue: gym.isAnonymous)
  }

  var firstSession: Bool { MovementPickerOptions.firstSession(log: gym.log, routines: gym.routines, readFailed: gym.readFailed) }

  var body: some View {
    Group {
      if externalQuery == nil {
        movementList.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search movements")
      } else { movementList }
    }
    .accessibilityIdentifier("gym-movement-picker")
    .autocorrectionDisabled()
    .navigationTitle(includesTargets ? "Add movement" : firstSession ? "What are you starting with?" : "What are you lifting?")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if let onCancel { onCancel() } else { dismiss() } } } }
    .safeAreaInset(edge: .bottom) {
      Button {
        searchFocused = false
        if let onCreate { onCreate(); return }
        if creation == nil { creation = MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: MovementName.capped(MovementName.trimmed(query))) }
        showingCreation = true
      } label: { Label("Create movement", systemImage: "plus").frame(maxWidth: .infinity) }
      .buttonStyle(.bordered).controlSize(.large).disabled(gym.accountTransition)
      .accessibilityIdentifier("gym-create-movement")
      .padding(16).background(.bar)
    }
    .onAppear {
      ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log)
      gym.telemetry.event("gym_screen_viewed", properties: ["screen": includesTargets ? "routine_editor" : "movement"])
    }
    .onChange(of: gym.sessions) { _, _ in ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log) }
    .onChange(of: gym.sets) { _, _ in ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log) }
    .onChange(of: gym.log?.firstPullComplete) { _, _ in ranking.capture(catalogue: gym.catalogue.exercises, log: gym.log) }
    .sheet(isPresented: $showingCreation) {
      if let draft = creation {
        NavigationStack {
          CreateMovementSheet(gym: gym, draft: Binding(get: { creation ?? draft }, set: { creation = $0 }), includesTargets: includesTargets,
                              account: pickingAccount, anonymous: pickingAnonymous) { entry in
            onSelect(entry)
          }
        }.modifier(RoutineTint())
      }
    }
    .modifier(RoutineTint())
  }

  private var movementList: some View {
    let query = externalQuery?.wrappedValue ?? self.query
    let options = MovementPickerOptions.matching(query: query, catalogue: gym.catalogue.exercises, selected: selected,
                                                 log: gym.log, featured: ranking.ids, readFailed: gym.readFailed)
    return List {
      if let externalQuery {
        Section {
          HStack {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search movements", text: externalQuery).focused($searchFocused)
              .textInputAutocapitalization(.never).submitLabel(.done).onSubmit { searchFocused = false }
              .accessibilityIdentifier("gym-movement-search")
            if !query.isEmpty {
              Button { externalQuery.wrappedValue = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(minWidth: 44, minHeight: 44) }
                .buttonStyle(.plain).accessibilityLabel("Clear search").accessibilityIdentifier("gym-movement-search-clear")
            }
          }
        }
      }
      if let unread = options.unread {
        Section { Text(unread).foregroundStyle(.secondary); Button("Try again") { gym.refresh() } }
      }
      RoutineNotice(gym: gym)
      if !options.six.isEmpty { Section("The six") { ForEach(options.six) { movementRow($0) } } }
      if !options.matches.isEmpty {
        Section(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "All movements" : "Matches") {
          ForEach(options.matches) { movementRow($0) }
        }
      }
      if let empty = options.empty { Section { Text(empty).foregroundStyle(.secondary) } }
      if !includesTargets && firstSession {
        Section {
          Text(gym.isAnonymous ? "Have a written program? An agent can build it — sign in first." : "Have a written program? Ask Coach to build it into a routine.")
          if let onBuildRoutine { Button("Build my routine") { dismiss(); onBuildRoutine() }.accessibilityIdentifier("gym-build-written-program") }
        }
      }
    }
  }

  func movementRow(_ row: MovementPickerOptions.Row) -> some View {
    Button {
      onSelect(RoutineEntry(exerciseId: row.id))
    } label: {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(row.exercise.name).font(.body.weight(.semibold)).foregroundStyle(Color.primary)
          Text(row.exercise.equipment.capitalized).font(.caption).foregroundStyle(Color.secondary)
          if let alias = row.alias { Text("was “\(alias)”").font(.caption).foregroundStyle(Color.secondary) }
          if let meta = row.meta { Text(meta).font(.caption.monospaced()).foregroundStyle(Color.secondary).monospacedDigit() }
        }.frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: row.selected ? "checkmark" : "plus").foregroundStyle(Color.secondary)
      }.padding(.vertical, 4)
    }
    .disabled(row.selected || gym.accountTransition)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(row.selected ? [.isSelected] : [])
    .accessibilityHint(row.selected ? "Already added" : "Add movement")
    .accessibilityIdentifier("gym-movement-\(row.id.record.string ?? "")")
  }
}

struct CreateMovementSheet: View {
  let gym: GymModel
  @Binding var draft: MovementCreationDraft
  let includesTargets: Bool
  let onCreated: (RoutineEntry) -> Void
  let onCancel: (() -> Void)?
  let onTargets: (() -> Void)?
  @Environment(\.dismiss) var dismiss
  @FocusState var nameFocused: Bool
  @State var busy = false
  @State private var creatingAccount: String?
  @State private var creatingAnonymous: Bool

  init(gym: GymModel, draft: Binding<MovementCreationDraft>, includesTargets: Bool, account: String?, anonymous: Bool,
       onCancel: (() -> Void)? = nil, onTargets: (() -> Void)? = nil, onCreated: @escaping (RoutineEntry) -> Void) {
    self.gym = gym; _draft = draft; self.includesTargets = includesTargets; self.onCreated = onCreated
    self.onCancel = onCancel; self.onTargets = onTargets
    _creatingAccount = State(initialValue: account); _creatingAnonymous = State(initialValue: anonymous)
  }

  var body: some View {
    Form {
      Section("Name") {
        TextField("Movement name", text: $draft.name).focused($nameFocused).autocorrectionDisabled().textInputAutocapitalization(.words).submitLabel(.done).onSubmit { nameFocused = false }
          .disabled(busy).accessibilityIdentifier("gym-movement-name")
        if let counter = MovementName.counter(draft.name) { Text(counter).font(.caption.monospaced()).foregroundStyle(.secondary) }
        if let problem = MovementName.problem(draft.name), !busy { Text(problem).font(.footnote).foregroundStyle(.red) }
      }
      Section("Equipment") {
        Picker("Equipment", selection: $draft.equipment) {
          ForEach(MovementCreationDraft.equipmentChoices, id: \.self) { Text($0.capitalized).tag($0) }
        }.labelsHidden().pickerStyle(.inline).disabled(busy).accessibilityIdentifier("gym-movement-equipment")
      }
      if includesTargets {
        Section {
          Button { nameFocused = false; onTargets?() } label: {
            HStack { Text("Targets"); Spacer(); Text(Readout.target(draft.sets)).foregroundStyle(.secondary).monospacedDigit() }
          }.disabled(busy).accessibilityIdentifier("gym-movement-targets")
          if draft.sets?.isEmpty ?? true { Text("Choose at least one set.").font(.footnote).foregroundStyle(.red) }
        }
      }
      if let refusal = draft.refusal { Section { Text(refusal).foregroundStyle(.red).accessibilityIdentifier("gym-movement-creation-refusal") } }
    }
    .accessibilityIdentifier("gym-movement-creation")
    .navigationTitle("Create movement").navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if let onCancel { onCancel() } else { dismiss() } }.disabled(busy) } }
    .safeAreaInset(edge: .bottom) {
      Button {
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
          let entry = gym.createMovement(&draft, includesTargets: includesTargets)
          busy = false
          if let entry { onCreated(entry) }
        }
      } label: {
        Text(busy ? "Creating…" : includesTargets ? "Add to routine" : "Create and add").foregroundStyle(CoachPalette.onAccent).frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
      .disabled(busy || gym.accountTransition || draft.problem(includesTargets: includesTargets) != nil)
      .accessibilityIdentifier("gym-movement-create-commit")
      .padding(16).background(.bar)
    }
    .interactiveDismissDisabled(busy)
    .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": includesTargets ? "routine_editor" : "movement"]) }
    .onChange(of: draft.name) { _, value in draft.name = MovementName.capped(value); draft.refusal = nil }
    .onChange(of: draft.equipment) { _, _ in draft.refusal = nil }
  }
}
