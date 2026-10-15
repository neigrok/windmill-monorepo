import SwiftUI
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine

struct RoutinesTab: View {
  let gym: GymModel
  var onReviewProposal: ((ID<Proposal>) -> Void)?
  @Environment(\.coachOpenAccount) private var openAccount
  @State private var building: RoutineEditingSession?
  @State private var savedID: ID<Routine>?

  var body: some View {
    let waiting = gym.waitingRoutineProposals
    let receipts = gym.coachRemovalReceipts.filter { $0.outcome != .pending }
    Group {
      if gym.routines.isEmpty, waiting.isEmpty, receipts.isEmpty, gym.personalCounts[Routine.type, default: 0] == 0, gym.historyKnown {
        ContentUnavailableView("No routines yet", systemImage: "list.bullet.rectangle", description: Text("Build one, or just start logging."))
      } else {
        List {
          Group {
            if !receipts.isEmpty || !waiting.isEmpty {
              Section {
                ForEach(receipts, id: \.proposal.id) { receipt in
                  Button { onReviewProposal?(receipt.proposal.id) } label: {
                    GymRow(title: receipt.proposal.baseName ?? "Routine removal",
                           meta: receipt.outcome == .applied ? "Removed" : "Nothing was applied", trailing: .door)
                  }.accessibilityIdentifier("routine-removal-receipt")
                }
                if let newest = waiting.first {
                  Button { onReviewProposal?(newest.id) } label: {
                    GymRow(title: GymCount.of(waiting.count, "proposal"), meta: gym.proposalLine(newest), trailing: .door)
                  }.accessibilityIdentifier("routine-proposal")
                }
              }
            }
            Section {
              ForEach(gym.routinesByLastTraining, id: \.id) { routine in
                NavigationLink { RoutineDetail(gym: gym, id: routine.id) } label: {
                  HStack(spacing: RoomSpace.related) {
                    GymRow(title: routine.name, meta: gym.routineLine(routine))
                    if waiting.dropFirst().contains(where: { $0.routineId == routine.id }) {
                      Text(GymCount.of(1, "proposal")).font(.footnote).foregroundStyle(GymPalette.accent)
                    }
                  }
                }.accessibilityIdentifier("routine-\(routine.id)")
                  .swipeActions(edge: .trailing) { Button("Delete", role: .destructive) { gym.run(DeleteRoutine(routine.id)) } }
                  .contextMenu {
                    Button("Start workout", systemImage: "play.fill") { gym.startWorkout(routineId: routine.id) }
                    Button("Delete routine", systemImage: "trash", role: .destructive) { gym.run(DeleteRoutine(routine.id)) }
                  }
                  .accessibilityAction(named: "Start workout") { gym.startWorkout(routineId: routine.id) }
                  .accessibilityAction(named: "Delete routine") { gym.run(DeleteRoutine(routine.id)) }
              }
              NavigationLink { MovementPicker(gym: gym, purpose: .browse) } label: {
                Label { Text("Movements").foregroundStyle(GymPalette.ink) } icon: { Image(systemName: "list.bullet") }
              }.accessibilityIdentifier("routines-movements")
            }
          }.listRowBackground(GymPalette.card)
        }.listStyle(.insetGrouped)
      }
    }.modifier(GymPage(titleDisplayMode: .large))
      .navigationTitle("Routines").accessibilityIdentifier("gym-routines")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New routine", systemImage: "plus") { building = RoutineEditingSession(gym: gym, routine: nil) }
            .labelStyle(.iconOnly).accessibilityIdentifier("new-routine").disabled(gym.accountTransition)
        }
        if #available(iOS 26, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }.roomBar(.gym)
      .reachBand {
        VStack(spacing: 0) {
          GymTransient(gym: gym)
          ActionBand(title: "Just start logging", room: .gym,
                     disabled: gym.accountTransition || gym.readFailed) { gym.startWorkout() }
        }
      }
      .sheet(item: $building) { editing in RoutineBuilder(gym: gym, editing: editing) { savedID = $0 } }
      .navigationDestination(isPresented: Binding(get: { savedID != nil && building == nil }, set: { if !$0 { savedID = nil } })) {
        if let savedID { RoutineDetail(gym: gym, id: savedID) }
      }
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
}

struct RoutineDetail: View {
  let gym: GymModel
  let id: ID<Routine>
  @State private var editing: RoutineEditingSession?
  var routine: Routine? { gym.routines.first { $0.id == id } }

  var body: some View {
    Group {
      if let routine {
        let history = Array(gym.routineHistory(id).prefix(20))
        List {
          Group {
            Section {
              ForEach(Array(routine.entries.enumerated()), id: \.offset) { index, entry in
                NavigationLink { MovementRecordScreen(gym: gym, exerciseID: entry.exerciseId) } label: {
                  let exercise = gym.catalogue.find(entry.exerciseId)
                  let custom = exercise != nil && !SeedExercises.all.contains { $0.id == entry.exerciseId }
                  GymRow(title: "\(index + 1). \(exercise?.name ?? "Movement unavailable")\(custom ? " · yours" : "")",
                              meta: Readout.target(entry.sets))
                }.accessibilityIdentifier("routine-detail-movement-\(entry.exerciseId)")
              }
            } header: { Text("Movements") } footer: {
              if routine.entries.contains(where: \.isOpen) { Text("Open movements have no target — you decide the numbers at the rack.") }
            }
            if !history.isEmpty || gym.readFailed || gym.historyKnown {
              Section {
                ForEach(history, id: \.id) { session in
                  NavigationLink { SessionDetailScreen(gym: gym, sessionID: session.id) } label: {
                    GymRow(title: RoutineLines.day(session.startedAt, now: gym.log?.moment.now ?? session.startedAt),
                                meta: RoutineLines.session(SessionReadout(session: session, sets: gym.sets)))
                  }.accessibilityIdentifier("routine-history-\(session.id)")
                }
              } header: { Text("History") } footer: {
                if gym.readFailed { Text("The log didn’t answer — this routine’s history is out of reach.") }
                else if history.isEmpty { Text("No workouts with this routine yet.") }
              }
            }
          }.listRowBackground(GymPalette.card)
        }.listStyle(.insetGrouped)
      } else {
        ContentUnavailableView("That routine is no longer in your program.", systemImage: "list.bullet.rectangle",
                               description: Text("Everything you logged against it is still in the log."))
      }
    }.modifier(GymPage())
      .navigationTitle(routine?.name ?? "Routine").accessibilityIdentifier("routine-detail").toolbar(.hidden, for: .tabBar)
      .toolbar {
        if let routine {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Edit") { editing = RoutineEditingSession(gym: gym, routine: routine) }.accessibilityIdentifier("edit-routine")
          }
        }
      }.roomBar(.gym)
      .reachBand {
        VStack(spacing: 0) {
          GymTransient(gym: gym)
          if let routine {
            ActionBand(title: "Start workout", room: .gym,
                       disabled: gym.accountTransition || gym.readFailed) { gym.startWorkout(routineId: routine.id) }
          }
        }
      }
      .sheet(item: $editing) { editing in RoutineBuilder(gym: gym, editing: editing) { _ in } }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine"]) }
  }
}

// What a routine, a waiting proposal and a past workout say on their rows.
enum RoutineLines {
  static func routine(_ routine: Routine, lastTrained: Instant?, historyKnown: Bool, moment: Moment?) -> String {
    let movements = GymCount.of(routine.entries.count, "movement")
    if let lastTrained, let moment { return "\(movements) · trained \(Readout.ago(lastTrained, now: moment.now, zone: moment.zone))" }
    return historyKnown ? "\(movements) · never trained" : movements
  }

  static func proposal(_ proposal: Proposal, createdAt: Instant?, moment: Moment?) -> String {
    let source: String
    switch proposal.provenance {
    case .ask: source = "Coach"
    case .mcp(let connection, let agent): source = agent.isEmpty ? connection.isEmpty ? "a connected tool" : connection : agent
    case .other: source = "a connected tool"
    }
    guard let createdAt, let moment else { return "from \(source)" }
    let time = createdAt.date.formatted(.dateTime.hour().minute())
    return "from \(source) · \(Readout.briefDay(createdAt, now: moment.now, zone: moment.zone)) \(time)"
  }

  static func session(_ readout: SessionReadout) -> String {
    "\(GymCount.of(readout.workingSetCount, "working set")) · \(GymCount.of(readout.movementCount, "movement"))"
  }

  static func day(_ instant: Instant, now: Instant) -> String {
    let date = instant.date, today = now.date
    let style = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated)
    return date.formatted(Calendar.current.isDate(date, equalTo: today, toGranularity: .year) ? style : style.year())
  }
}

extension GymModel {
  var historyKnown: Bool { !readFailed && (isAnonymous || log?.firstPullComplete == true) }

  var routinesByLastTraining: [Routine] {
    let latest = Dictionary(grouping: sessions.filter { !$0.isOpen && $0.historyRoutineId != nil }, by: { $0.historyRoutineId! })
      .mapValues { $0.map(\.startedAt.ms).max() ?? Int64.min }
    return routines.sorted {
      let a = latest[$0.id] ?? Int64.min, b = latest[$1.id] ?? Int64.min
      if a != b { return a > b }
      return $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position
    }
  }

  var waitingRoutineProposals: [Proposal] {
    let pending = proposals.filter { $0.state == "pending" && $0.supersededBy == nil }
    do {
      let born: [ID<Proposal>: Stamp] = try runner.read(Routine.scope) { read in
        try Dictionary(uniqueKeysWithValues: pending.map { ($0.id, try read.repository(Proposal.self).record($0.id, in: .drawn)?.born ?? .unset) })
      }
      return pending.sorted {
        let a = born[$0.id] ?? .unset, b = born[$1.id] ?? .unset
        return a == b ? $0.id < $1.id : a > b
      }
    } catch { report("gym_read", error); return pending }
  }

  func routineHistory(_ id: ID<Routine>) -> [Session] {
    sessions.filter { !$0.isOpen && $0.historyRoutineId == id }.sorted { $0.startedAt > $1.startedAt }
  }

  func routineLine(_ routine: Routine) -> String {
    RoutineLines.routine(routine, lastTrained: routineHistory(routine.id).first?.startedAt, historyKnown: historyKnown, moment: log?.moment)
  }

  // The server stamps a proposal's creation; a proposal the phone has not yet sent shows no time rather than a guessed one.
  func proposalLine(_ proposal: Proposal) -> String {
    do {
      let createdAt = try runner.read(Proposal.scope) { read in
        try read.repository(Proposal.self).record(proposal.id, in: .stored).flatMap { try Fields($0).optionalInstant("createdAt") }
      }
      return RoutineLines.proposal(proposal, createdAt: createdAt, moment: log?.moment)
    } catch {
      report("gym_read", error)
      return RoutineLines.proposal(proposal, createdAt: nil, moment: log?.moment)
    }
  }
}
