import SwiftUI
import DomainKit
import GymDomain
import SyncCore
import SyncEngine

struct RoutinesTab: View {
  let gym: GymModel
  let onAccount: (() -> Void)?
  let onWrittenProgram: (() -> Void)?
  let onReviewProposal: ((ID<Proposal>) -> Void)?
  @Environment(\.coachOpenAccount) private var openAccount
  @State private var building: RoutineEditingSession?
  @State private var savedID: ID<Routine>?
  @State private var browsing = false
  @State private var movement: Exercise?
  init(gym: GymModel, onAccount: (() -> Void)? = nil, onWrittenProgram: (() -> Void)? = nil,
       onReviewProposal: ((ID<Proposal>) -> Void)? = nil) {
    self.gym = gym; self.onAccount = onAccount; self.onWrittenProgram = onWrittenProgram; self.onReviewProposal = onReviewProposal
  }

  var body: some View {
    let waiting = gym.waitingRoutineProposals
    List {
      Group {
        if !gym.isAnonymous, gym.adoptionWorkoutToReview != nil {
          Section { WorkoutAdoptionBand(gym: gym) }.listRowBackground(Color.clear)
        }
        if gym.readFailed {
          Section { Text("Your routines could not be read. Try again."); Button("Try again") { gym.refresh() } }
        }
        ForEach(gym.coachRemovalReceipts.filter { $0.outcome != .pending }, id: \.proposal.id) { receipt in
          Section {
            Button { onReviewProposal?(receipt.proposal.id) } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(receipt.proposal.baseName ?? "Routine removal").font(.headline)
                Text(receipt.outcome == .applied ? "Removed · View receipt" : "Nothing was applied · View receipt").font(.subheadline)
              }
            }.accessibilityIdentifier("routine-removal-receipt")
          }
        }
        if let pending = waiting.first {
          Section {
            Button { onReviewProposal?(pending.id) } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text("Proposal · \(gym.routines.first { $0.id == pending.routineId }?.name ?? pending.baseName ?? pending.proposedName)").font(.headline)
                Text(pending.summary).font(.subheadline).foregroundStyle(GymPalette.inkDim)
                Text("Review changes").font(.subheadline)
              }
            }.accessibilityIdentifier("routine-proposal")
          }
        }
        if gym.isAnonymous {
          Section {
            Text("Your log is saved on this device.").font(.headline)
            Text("Sign in to add it to your account — it opens on the web too.").font(.subheadline).foregroundStyle(GymPalette.inkDim)
            if let onAccount { Button("Sign in", action: onAccount).accessibilityIdentifier("routines-sign-in") }
          }
        }
        Section {
          if gym.routines.isEmpty, gym.personalCounts[Routine.type, default: 0] == 0, !gym.readFailed {
            Text(gym.log?.firstPullComplete == true ? "No routines yet." : "Your routines are still being read.").foregroundStyle(GymPalette.inkDim)
          }
          ForEach(gym.routinesByLastTraining, id: \.id) { routine in
            NavigationLink { RoutineDetail(gym: gym, id: routine.id) } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(routine.name).font(.headline)
                Text(routine.entries.prefix(2).map { gym.catalogue.find($0.exerciseId)?.name ?? "Movement unavailable" }.joined(separator: " · "))
                  .font(.subheadline).foregroundStyle(GymPalette.inkDim)
                if let pending = waiting.first(where: { $0.routineId == routine.id }), pending.id != waiting.first?.id {
                  Button("Proposal · Review changes") { onReviewProposal?(pending.id) }.buttonStyle(.borderless).font(.caption)
                }
              }
            }.accessibilityIdentifier("routine-\(routine.id)")
              .swipeActions(edge: .trailing) { Button("Delete", role: .destructive) { delete(routine) } }
              .contextMenu {
                Button("Start workout", systemImage: "play.fill") { gym.startWorkout(routineId: routine.id) }
                Button("Delete routine", systemImage: "trash", role: .destructive) { delete(routine) }
              }
              .accessibilityAction(named: "Start workout") { gym.startWorkout(routineId: routine.id) }
              .accessibilityAction(named: "Delete routine") { delete(routine) }
          }
        }
        Section { Button("Movements", systemImage: "list.bullet") { browsing = true } }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).navigationTitle("Routines")
      .accessibilityIdentifier("gym-routines")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New routine", systemImage: "plus") { building = RoutineEditingSession(gym: gym, routine: nil) }
            .labelStyle(.iconOnly).accessibilityIdentifier("new-routine").disabled(gym.accountTransition)
        }
        if #available(iOS 26, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          GymTransient(gym: gym)
          ActionBand(title: "Just start logging", accent: GymPalette.accent, onAccent: GymPalette.onAccent,
                     disabled: gym.accountTransition || gym.readFailed) { gym.startWorkout() }
        }
      }
      .sheet(item: $building) { editing in RoutineBuilder(gym: gym, editing: editing) { savedID = $0 } }
      .sheet(isPresented: $browsing) {
        NavigationStack {
          MovementPicker(gym: gym, selected: [], includesTargets: false, onBuildRoutine: onWrittenProgram) { entry in movement = gym.catalogue.find(entry.exerciseId); browsing = false }
        }.modifier(GymPage()).presentationDetents([.large])
      }
      .navigationDestination(isPresented: Binding(get: { savedID != nil && building == nil }, set: { if !$0 { savedID = nil } })) {
        if let savedID { RoutineDetail(gym: gym, id: savedID) }
      }
      .navigationDestination(isPresented: Binding(get: { movement != nil && !browsing }, set: { if !$0 { movement = nil } })) {
        if let movement { RoutineMovementDoor(gym: gym, id: movement.id) }
      }
      .modifier(GymPage(titleDisplayMode: .large))
      .preferredColorScheme(OnboardingFixture.appearance)
      .onAppear {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-routines-proposal-fixture"), gym.coachAccountAvailable, gym.routines.isEmpty {
          var fixture = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 60)])]))
          if gym.saveRoutine(&fixture) {
            gym.run(ProposeRoutine(id: gym.runner.mint(Proposal.self), routineId: fixture.id, name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 62.5)])], summary: "A heavier bench target"))
          }
        }
        #endif
        gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routines"])
      }
  }
  private func delete(_ routine: Routine) {
    gym.run(DeleteRoutine(routine.id))
  }
}

struct RoutineDetail: View {
  let gym: GymModel
  let id: ID<Routine>
  @State private var editing: RoutineEditingSession?
  var routine: Routine? { gym.routines.first { $0.id == id } }
  var body: some View {
    List {
      Group {
        if let routine {
          Section("Movements") {
            ForEach(Array(routine.entries.enumerated()), id: \.offset) { index, entry in
              NavigationLink { RoutineMovementDoor(gym: gym, id: entry.exerciseId) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  let exercise = gym.catalogue.find(entry.exerciseId)
                  let custom = exercise != nil && !SeedExercises.all.contains { $0.id == entry.exerciseId }
                  Text("\(index + 1). \(exercise?.name ?? "Movement unavailable")\(custom ? " · yours" : "")")
                  Text(Readout.target(entry.sets)).font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
                }
              }.accessibilityIdentifier("routine-detail-movement-\(entry.exerciseId)")
            }
          }
          if routine.entries.contains(where: \.isOpen) {
            Section { Text("Open movements have no target — you decide the numbers at the rack.").foregroundStyle(GymPalette.inkDim) }
          }
          Section("History") {
            ForEach(gym.routineHistory(id).prefix(20), id: \.id) { session in
              VStack(alignment: .leading, spacing: 4) {
                Text(Date(timeIntervalSince1970: Double(session.startedAt.ms) / 1000), style: .date)
                let facts = SessionReadout(session: session, sets: gym.sets)
                Text("\(facts.workingSetCount) working sets · \(facts.movementCount) movements").font(.subheadline).foregroundStyle(GymPalette.inkDim)
              }
            }
            if gym.readFailed { Text("The log didn’t answer — this routine’s history is out of reach.").foregroundStyle(GymPalette.inkDim) }
            else if gym.routineHistory(id).isEmpty, gym.log?.firstPullComplete == true { Text("No workouts with this routine yet.").foregroundStyle(GymPalette.inkDim) }
            else if gym.log?.firstPullComplete != true { Text("History is still being read.").foregroundStyle(GymPalette.inkDim) }
          }
        } else { Text("That routine is no longer in your program. Everything you logged against it is still in the log.") }
      }.listRowBackground(GymPalette.card)
    }.navigationTitle(routine?.name ?? "Routine").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
      .toolbar { if routine != nil { ToolbarItem(placement: .topBarTrailing) { Button("Edit") { if let routine { editing = RoutineEditingSession(gym: gym, routine: routine) } }.accessibilityIdentifier("edit-routine") } } }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          GymTransient(gym: gym)
          if let routine {
            ActionBand(title: "Start workout", accent: GymPalette.accent, onAccent: GymPalette.onAccent,
                       disabled: gym.accountTransition || gym.readFailed) { gym.startWorkout(routineId: routine.id) }
          }
        }
      }
      .sheet(item: $editing) { editing in RoutineBuilder(gym: gym, editing: editing) { _ in } }
      .accessibilityIdentifier("routine-detail")
      .modifier(GymPage())
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine"]) }
  }
}


struct RoutineMovementDoor: View {
  let gym: GymModel
  let id: ID<Exercise>
  @State private var renaming = false
  var body: some View {
    List {
      Group {
        if let exercise = gym.catalogue.find(id) {
          Section { Text(exercise.equipment.capitalized); Button("Rename movement") { renaming = true }.accessibilityIdentifier("rename-movement") }
          Section { NavigationLink("Open record") { MovementRecordScreen(gym: gym, exerciseID: id) }.accessibilityIdentifier("routine-open-record") }
          Section("Last time") {
            if let log = gym.log {
              let last = LastTime.of(id, log: log)
              if let session = last.session {
                Text(Date(timeIntervalSince1970: Double(session.startedAt.ms) / 1000), style: .date)
                ForEach(last.sets, id: \.id) { set in Text(Readout.effort(weightKg: set.weightKg, reps: set.reps)).monospacedDigit() }
              } else if last.isFirstTime, !gym.readFailed { Text("Never logged") }
              else { Text("The log is still being read.") }
            }
            if gym.readFailed { Text("The log didn’t answer. Try again."); Button("Try again") { gym.refresh() } }
          }
        } else { Text("This movement is no longer available.") }
      }.listRowBackground(GymPalette.card)
    }.navigationTitle(gym.catalogue.find(id)?.name ?? "Movement").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
      .sheet(isPresented: $renaming) { if let exercise = gym.catalogue.find(id) { RenameMovementSheet(gym: gym, exercise: exercise) } }
      .accessibilityIdentifier("routine-movement")
      .modifier(GymPage())
      .safeAreaInset(edge: .bottom) { GymTransient(gym: gym) }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "movement"]) }
  }
}
