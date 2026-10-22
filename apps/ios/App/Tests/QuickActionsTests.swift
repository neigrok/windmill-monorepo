import Foundation
import Testing
import UIKit
import DomainKit
import DomainKitTesting
import GymDomain
import JournalDomain
import SyncCore
import SyncSchema
import SyncModelServer
@testable import Windmill

@Suite(.serialized) @MainActor struct QuickActionsTests {
  func model(_ recorder: TelemetryRecorder) throws -> (Harness, AppModel) {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    return (harness, try AppModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!, telemetry: recorder))
  }

  func routine(_ app: AppModel, _ name: String) throws -> Routine {
    var draft = Draft(new: Routine(id: app.gym.runner.mint(Routine.self), name: name, entries: [RoutineEntry(exerciseId: ID("back-squat"))]))
    #expect(saved(app.gym.save(&draft)))
    return try #require(app.gym.routines.first { $0.id == draft.current.id })
  }

  func session(_ id: String, routine: Routine?, at ms: Int64, open: Bool = false) -> Session {
    Session(id: ID(RecordID(id)), startedAt: Instant(ms: ms), finishedAt: open ? nil : Instant(ms: ms + 60_000),
            closedBy: open ? nil : "finish", routineId: routine?.id, plan: routine.map(SessionPlan.init))
  }

  @Test func theGymItemStartsTheRoutineLastTrainedAndOpensARunningWorkout() {
    let full = Routine(id: ID("full-body-a"), name: "Full body A"), legs = Routine(id: ID("legs"), name: "Legs")
    let gone = Routine(id: ID("gone"), name: "Deleted")
    #expect(QuickAction.items(routines: [], sessions: [session("a", routine: gone, at: 3)], open: nil) == [.write])
    #expect(QuickAction.items(routines: [full, legs], sessions: [], open: nil) == [.write, .start(full.id, name: "Full body A")])
    let trained = [session("a", routine: full, at: 1), session("b", routine: legs, at: 2), session("c", routine: gone, at: 3), session("d", routine: nil, at: 4)]
    #expect(QuickAction.items(routines: [full, legs], sessions: trained, open: nil) == [.write, .start(legs.id, name: "Legs")])
    let running = session("e", routine: full, at: 5, open: true)
    #expect(QuickAction.items(routines: [full, legs], sessions: trained + [running], open: running) == [.write, .openWorkout])
  }

  @Test func eachItemIsAHomeScreenShortcutThatReadsBackAsItself() {
    let actions: [QuickAction] = [.write, .start(ID("full-body-a"), name: "Full body A"), .openWorkout]
    let shortcuts = actions.map(\.shortcut)
    #expect(shortcuts.map { [$0.type, $0.localizedTitle] } == [
      ["works.windmill.app.quick.write", "Write tonight"], ["works.windmill.app.quick.start", "Start Full body A"],
      ["works.windmill.app.quick.open_workout", "Open workout"],
    ])
    #expect(shortcuts.map(QuickAction.init) == actions)
    #expect(QuickAction(UIApplicationShortcutItem(type: "works.windmill.app.quick.start", localizedTitle: "Start")) == nil)
    #expect(QuickAction(UIApplicationShortcutItem(type: "elsewhere", localizedTitle: "Write tonight")) == nil)
  }

  @Test func anActionTakenBeforeTheFirstScreenWaitsForItAndWritesTonight() throws {
    let recorder = TelemetryRecorder(), (_, app) = try model(recorder)
    QuickActionHandler.model = nil
    QuickActionHandler.perform(.write)
    #expect(QuickActionHandler.waiting == .write && !app.journal.editing)
    QuickActionHandler.present(app)
    #expect(QuickActionHandler.waiting == nil && app.selectedRoom == .journal && !app.welcome && app.journal.editing)
    #expect(app.journal.editorDay == app.journal.today && !app.journal.inkVisible)
    #expect(recorder.entries.withLock { $0 }.filter { $0.name == "quick_action" }.map(\.properties) == [["item": "write"]])
  }

  @Test func startBeginsTheRoutinesWorkoutOnceAndOpenWorkoutBringsAHiddenOneBack() throws {
    let recorder = TelemetryRecorder(), (_, app) = try model(recorder)
    let lower = try routine(app, "Lower A")
    #expect(app.quickActions == [.write, .start(lower.id, name: "Lower A")])
    app.perform(.start(lower.id, name: "Lower A"))
    let open = try #require(app.gym.openSession)
    #expect(app.selectedRoom == .gym && !app.welcome && open.routineId == lower.id && app.gym.workout.isPresented)
    #expect(app.quickActions == [.write, .openWorkout])
    app.perform(.start(lower.id, name: "Lower A"))
    #expect(app.gym.sessions.map(\.id) == [open.id])
    #expect(app.gym.hideWorkout() && !app.gym.workout.isPresented)
    app.perform(.openWorkout)
    #expect(app.gym.openSession?.id == open.id && !app.gym.workoutHidden && app.gym.workout.isPresented)
    let events = recorder.entries.withLock { $0 }
    #expect(events.filter { $0.name == "quick_action" }.map(\.properties) == [["item": "start"], ["item": "start"], ["item": "open_workout"]])
    #expect(events.filter { $0.name == "gym_session_started" }.count == 1)
    #expect(events.allSatisfy { !$0.properties.values.contains("Lower A") })
  }
}
