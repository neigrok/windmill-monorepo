import SwiftUI
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
#if DEBUG && targetEnvironment(simulator)
import struct SyncModelServer.ServerCall
#endif

struct RoutinesTab: View {
  let gym: GymModel
  var onReviewProposal: ((ID<Proposal>) -> Void)?
  @Environment(\.coachOpenAccount) private var openAccount
  @State private var building: RoutineEditingSession?
  @State private var selectedID: ID<Routine>?
  @State private var startID: ID<Routine>?

  var body: some View {
    let proposals = gym.routineProposals
    let receipts = gym.routineRemovalReceipts
    Group {
      if gym.routines.isEmpty, proposals.isEmpty, receipts.isEmpty, gym.personalCounts[Routine.type, default: 0] == 0, gym.historyKnown {
        ContentUnavailableView("No routines yet", systemImage: "list.bullet.rectangle")
      } else {
        List {
          Group {
            if !receipts.isEmpty || !proposals.isEmpty {
              Section {
                // A removal the log answered reads the word its card stands on: Removed, or Not applied when the log refused it.
                ForEach(receipts, id: \.proposal.id) { receipt in
                  Button { onReviewProposal?(receipt.proposal.id) } label: {
                    GymRow(title: CoachCopy.proposalTitle(routine: receipt.proposal.baseName ?? receipt.proposal.proposedName, changes: 0, removal: true),
                           meta: gym.coachProposalWord(receipt.proposal), trailing: .door)
                  }.accessibilityIdentifier("routine-removal-receipt")
                }
                // A waiting proposal carries the accent and opens its card; one out of date reads its settled word alone.
                ForEach(proposals, id: \.id) { proposal in
                  let outOfDate = gym.coachProposalOutOfDate(proposal)
                  Button { onReviewProposal?(proposal.id) } label: {
                    GymRow(title: gym.proposalTitle(proposal), meta: gym.proposalLine(proposal),
                           leading: outOfDate ? nil : .symbol("bubble.left.and.bubble.right", GymPalette.accent), trailing: .door)
                  }.accessibilityIdentifier(outOfDate ? "routine-proposal-out-of-date" : "routine-proposal")
                }
              }
            }
            let routines = gym.routinesByLastTraining
            if !routines.isEmpty {
              Section {
                ForEach(routines, id: \.id) { routine in
                  Button { selectedID = routine.id } label: {
                    GymRow(title: routine.name, meta: gym.routineLine(routine), trailing: .door)
                  }.accessibilityIdentifier("routine-\(routine.id)")
                    .trashSwipe("Delete routine") { gym.run(DeleteRoutine(routine.id)) }
                    .contextMenu {
                      Button("Start workout", systemImage: "play.fill") { gym.startWorkout(routineId: routine.id) }
                      Button("Delete routine", systemImage: "trash", role: .destructive) { gym.run(DeleteRoutine(routine.id)) }
                    }
                    .accessibilityAction(named: "Start workout") { gym.startWorkout(routineId: routine.id) }
                    .accessibilityAction(named: "Delete routine") { gym.run(DeleteRoutine(routine.id)) }
                }
              }
            }
          }.listRowBackground(GymPalette.card)
        }.listStyle(.insetGrouped)
      }
    }.modifier(GymPage(titleDisplayMode: .large))
      .navigationTitle("Routines").accessibilityElement(children: .contain).accessibilityIdentifier("gym-routines")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }.roomBar(.gym)
      .reachBand {
        VStack(spacing: RoomSpace.related) {
          GymTransient(gym: gym)
          FloatingAction(title: "New routine", symbol: "plus", identifier: "new-routine") {
            building = RoutineEditingSession(gym: gym, routine: nil)
          }.disabled(gym.accountTransition)
        }
      }
      .sheet(item: $building) { editing in RoutineBuilder(gym: gym, editing: editing) { selectedID = $0 } }
      .sheet(isPresented: Binding(get: { selectedID != nil && building == nil }, set: { if !$0 { selectedID = nil } }), onDismiss: {
        if let id = startID { startID = nil; gym.startWorkout(routineId: id) }
      }) {
        if let selectedID { RoutineSummarySheet(gym: gym, id: selectedID) { startID = selectedID; self.selectedID = nil } }
      }
      .preferredColorScheme(OnboardingFixture.appearance)
      .onAppear {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-routines-proposal-fixture"), gym.coachAccountAvailable, gym.routines.isEmpty {
          var fixture = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 60)])]))
          let heavier = [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8, weightKg: 62.5)])]
          if gym.saveRoutine(&fixture) {
            if ProcessInfo.processInfo.arguments.contains("-routines-tool-proposal") { Task { await gym.proposeFromAConnectedToolThenEdit(fixture.current, entries: heavier) } }
            else { gym.run(ProposeRoutine(id: gym.runner.mint(Proposal.self), routineId: fixture.id, name: "Push A", entries: heavier, summary: "A heavier bench target")) }
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
  let start: () -> Void
  var awaitSync = false
  @State private var editing: RoutineEditingSession?
  @State private var confirmedAbsent = false
  @Environment(\.dismiss) private var dismiss
  var routine: Routine? { gym.routines.first { $0.id == id } }
  var waitsForSync: Bool { awaitSync && routine == nil && !confirmedAbsent }

  var body: some View {
    Group {
      if let routine {
        List {
          Section {
            ForEach(Array(routine.entries.enumerated()), id: \.offset) { index, entry in
              GymRow(title: RoutineLines.movement(index, entry.exerciseId, in: gym.catalogue), meta: Readout.target(entry.sets))
                .accessibilityIdentifier("routine-detail-movement-\(entry.exerciseId)")
            }
          }.listRowBackground(GymPalette.card)
        }.listStyle(.insetGrouped)
      } else if waitsForSync {
        ContentUnavailableView {
          Label("Routine not on this phone yet", systemImage: "arrow.triangle.2.circlepath")
        } description: { Text("Your log may still be syncing, or this routine may have been removed. Refresh to check.") }
        actions: {
          Button("Refresh") { Task { await refreshReceipt() } }
            .disabled(gym.runtime?.engine.status.online == false)
        }
      } else {
        ContentUnavailableView("That routine is no longer in your program.", systemImage: "list.bullet.rectangle",
                               description: Text("Everything you logged against it is still in the log."))
      }
    }.modifier(GymPage())
      .navigationTitle(routine?.name ?? "Routine")
      .accessibilityIdentifier("routine-detail")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.accessibilityIdentifier("routine-close") }
        if let routine {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Edit") { editing = RoutineEditingSession(gym: gym, routine: routine) }.accessibilityIdentifier("edit-routine")
          }
        }
      }.roomBar(.gym)
      // The movements pass under Start on a hard edge over the bar material, so no row reads through it (02.19).
      .reachBand(onSurface: true) {
        VStack(spacing: 0) {
          GymTransient(gym: gym)
          if routine != nil {
            ActionBand(title: "Start", room: .gym, disabled: gym.accountTransition || gym.readFailed,
                       actionIdentifier: "routine-start", action: start)
          }
        }
      }
      // The editor deletes the routine at once, so the detail it leaves behind has nothing to show and goes too.
      .sheet(item: $editing, onDismiss: { if routine == nil { dismiss() } }) { editing in RoutineBuilder(gym: gym, editing: editing) { _ in } }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine"]) }
      .task(id: id) { if awaitSync, routine == nil { await refreshReceipt() } }
  }

  func refreshReceipt() async {
    let owner = gym.account
    let exists = await gym.routineExists(id)
    guard owner == gym.account, !Task.isCancelled else { return }
    confirmedAbsent = exists == false
    gym.runtime?.engine.foreground(); gym.refresh()
  }
}

struct RoutineSummarySheet: View {
  let gym: GymModel
  let id: ID<Routine>
  var awaitSync = false
  let start: () -> Void
  @Environment(\.dynamicTypeSize) var typeSize

  var body: some View {
    NavigationStack { RoutineDetail(gym: gym, id: id, start: start, awaitSync: awaitSync) }
      .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.fraction(0.62), .large])
      .presentationDragIndicator(.visible)
      .onAppear { if awaitSync { gym.runtime?.engine.foreground(); gym.refresh() } }
  }
}

// What a routine, a waiting proposal and a past workout say on their rows.
enum RoutineLines {
  // A summary row's movement by its place, marked when it is the lifter's own rather than the catalogue's.
  static func movement(_ index: Int, _ id: ID<Exercise>, in catalogue: Catalogue) -> String {
    guard let exercise = catalogue.find(id) else { return "\(index + 1). Movement unavailable" }
    return "\(index + 1). \(exercise.name)\(SeedExercises.contains(id) ? "" : " · yours")"
  }
  static func routine(_ routine: Routine, lastTrained: Instant?, historyKnown: Bool, moment: Moment?) -> String {
    let movements = GymCount.of(routine.entries.count, "movement")
    if let lastTrained, let moment { return "\(movements) · trained \(Readout.ago(lastTrained, now: moment.now, zone: moment.zone))" }
    return historyKnown ? "\(movements) · never trained" : movements
  }

  // Who proposed it, then when the server stamped it: the time today, the day before that.
  static func proposal(_ proposal: Proposal, createdAt: Instant?, dates: GymDate?) -> String {
    let source = proposal.sourceName
    guard let createdAt, let dates else { return "From \(source)" }
    let moment = dates.moment
    return "From \(source) · \(LocalDay(createdAt, in: moment.zone) == moment.today ? dates.time(createdAt) : dates.day(createdAt))"
  }

  // A movement's targets in its load basis: *4 × 8 · 60 kg total*, *3 × 10 · 22.5 kg each*, *3 × 12* with no load, *Open*.
  static func movement(_ sets: [SetTarget]?, equipment: MovementEquipment) -> String {
    guard let sets, !sets.isEmpty else { return "Open" }
    let target = Readout.target(sets)
    return sets.contains { $0.weightKg != nil } ? "\(target) \(equipment.unit)" : target
  }

  static func session(_ readout: SessionReadout) -> String {
    "\(GymCount.of(readout.workingSetCount, "set")) · \(GymCount.of(readout.movementCount, "movement"))"
  }
}

extension GymModel {
  func routineExists(_ id: ID<Routine>) async -> Bool? {
    do {
      _ = try await rest.request("/v1/gym/routines/" + CoachCopy.escaped(id.description))
      return true
    } catch {
      if (error as? GymRESTFailure)?.status == 404 { return false }
      return nil
    }
  }

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

  // The removals the log answered, each a row on Routines until its card is seen.
  var routineRemovalReceipts: [RoutineRemovalReceipt] { coachRemovalReceipts.filter { $0.outcome != .pending } }

  // The proposals Routines draws, newest first: each one still waiting, and a connected tool's gone out of date while it is
  // the newest proposal on a routine in sight. A Coach proposal out of date leaves for its card; a tool's has no other door.
  // A removal the log answered is its receipt's row alone, though a refused one still waits.
  var routineProposals: [Proposal] {
    let born: [ID<Proposal>: Stamp]
    do {
      born = try runner.read(Routine.scope) { read in
        try Dictionary(uniqueKeysWithValues: proposals.map { ($0.id, try read.repository(Proposal.self).record($0.id, in: .drawn)?.born ?? .unset) })
      }
    } catch { report("gym_read", error); born = [:] }
    let newest = proposals.sorted {
      let a = born[$0.id] ?? .unset, b = born[$1.id] ?? .unset
      return a == b ? $0.id < $1.id : a > b
    }
    let answered = Set(routineRemovalReceipts.map(\.proposal.id))
    return newest.filter { proposal in
      guard !answered.contains(proposal.id) else { return false }
      guard coachProposalOutOfDate(proposal) else { return proposal.state == "pending" }
      if case .ask = proposal.provenance { return false }
      return coachRoutine(proposal) != nil && newest.first { $0.routineId == proposal.routineId }?.id == proposal.id
    }
  }

  func routineHistory(_ id: ID<Routine>) -> [Session] {
    sessions.filter { !$0.isOpen && $0.historyRoutineId == id }.sorted { $0.startedAt > $1.startedAt }
  }

  func routineLine(_ routine: Routine) -> String {
    RoutineLines.routine(routine, lastTrained: routineHistory(routine.id).first?.startedAt, historyKnown: historyKnown, moment: log?.moment)
  }

  // A proposal's Routines row names the routine as it stands now.
  func proposalTitle(_ proposal: Proposal) -> String {
    CoachCopy.proposalTitle(routine: coachRoutine(proposal)?.name ?? proposal.baseName ?? proposal.proposedName,
                            changes: coachChangeCount(proposal), removal: proposal.intent == "remove")
  }

  // Who proposed it and when the server stamped it, no time while the phone has not yet sent it; once its card stands on a
  // word — out of date, or its Apply refused — that word.
  func proposalLine(_ proposal: Proposal) -> String {
    if let word = coachProposalWord(proposal) { return word }
    return RoutineLines.proposal(proposal, createdAt: proposalCreatedAt(proposal), dates: log == nil ? nil : dates)
  }
}

#if DEBUG && targetEnvironment(simulator)
extension GymModel {
  // The connected-tool fixture: a tool proposes on the log, as an MCP tool does, then this phone edits the routine under it.
  func proposeFromAConnectedToolThenEdit(_ routine: Routine, entries: [RoutineEntry]) async {
    guard let runtime, let server = runtime.auth.fake, let account else { return }
    await runtime.engine.flushOnLeave()
    do {
      let proposal = Proposal(id: runner.mint(Proposal.self), routineId: routine.id, intent: "revise", proposedName: routine.name,
                              summary: "A heavier bench target", changes: try ProposalRules.changesBetween(base: routine.entries, proposed: entries),
                              door: "mcp", connection: "My laptop", agent: "Claude")
      let fields = JSON.Object(uniqueKeysWithValues: proposal.fields.map { ($0.key, [$0.value, .null]) })
      let intent: JSON = ["scope": "self/gym", "d": [["t": .string(Proposal.type), "id": proposal.id.json, "born": .null, "life": ["alive", .null], "f": .object(fields)]]]
      let call = ServerCall(account: account, requestId: nil, tool: "gym.propose_routine_change", args: [:], intents: [intent])
      guard server.state.withLock({ $0.server.call(call, at: server.now) })?["s"] == "ok" else { self.error = "The connected tool's proposal was refused."; return }
      runtime.engine.foreground()
      for _ in 0..<250 where !proposals.contains(where: { $0.id == proposal.id }) {
        try await Task.sleep(for: .milliseconds(20)); refresh()
      }
      guard var edit = try runner.open(routine.id) else { return }
      edit.current.entries[0].sets = [SetTarget(reps: 8, weightKg: 65)]
      saveRoutine(&edit)
    } catch { self.error = "The connected tool's proposal could not be prepared." }
  }
}
#endif
