import SwiftUI
import UIKit
import DomainKit
import GymDomain
import SyncCore

// The Home Screen's quick actions (Figma Shell · iOS 22): Write tonight, then the gym's one door — Start the routine last
// trained, or Open workout while one runs. With no routine there is no gym item, since a workout starts only from a routine.
enum QuickAction: Equatable {
  case write
  case start(ID<Routine>, name: String)
  case openWorkout

  static let prefix = "works.windmill.app.quick."

  // The routine last trained, else the first in Routines; the log's newest workout that names a routine still kept wins.
  static func items(routines: [Routine], sessions: [Session], open: Session?) -> [QuickAction] {
    if open != nil { return [.write, .openWorkout] }
    let trained = sessions.sorted { $0.startedAt.ms > $1.startedAt.ms }.lazy
      .compactMap { session in routines.first { $0.id == session.routineId } }.first
    guard let routine = trained ?? routines.first else { return [.write] }
    return [.write, .start(routine.id, name: routine.name)]
  }

  // The bounded label `quick_action` records; the routine's name is never one.
  var item: String {
    switch self {
    case .write: "write"
    case .start: "start"
    case .openWorkout: "open_workout"
    }
  }

  var shortcut: UIApplicationShortcutItem {
    switch self {
    case .write:
      UIApplicationShortcutItem(type: Self.prefix + item, localizedTitle: "Write tonight", localizedSubtitle: nil,
                                icon: UIApplicationShortcutIcon(systemImageName: "square.and.pencil"))
    case .start(let id, let name):
      UIApplicationShortcutItem(type: Self.prefix + item, localizedTitle: "Start \(name)", localizedSubtitle: nil,
                                icon: UIApplicationShortcutIcon(systemImageName: "dumbbell"),
                                userInfo: ["routine": id.description as NSString, "name": name as NSString])
    case .openWorkout:
      UIApplicationShortcutItem(type: Self.prefix + item, localizedTitle: "Open workout", localizedSubtitle: nil,
                                icon: UIApplicationShortcutIcon(systemImageName: "dumbbell"))
    }
  }

  init?(_ shortcut: UIApplicationShortcutItem) {
    switch shortcut.type {
    case Self.prefix + "write": self = .write
    case Self.prefix + "open_workout": self = .openWorkout
    case Self.prefix + "start":
      guard let routine = shortcut.userInfo?["routine"] as? String, let name = shortcut.userInfo?["name"] as? String else { return nil }
      self = .start(ID(RecordID(routine)), name: name)
    default: return nil
    }
  }
}

// A quick action taken before the app draws its first screen waits for it, as an outside door does.
@MainActor enum QuickActionHandler {
  static weak var model: AppModel?
  static var waiting: QuickAction?

  static func perform(_ action: QuickAction) {
    guard let model else { waiting = action; return }
    model.perform(action)
  }

  static func present(_ app: AppModel) {
    model = app
    guard let waiting else { return }
    self.waiting = nil
    app.perform(waiting)
  }
}

// A quick action chosen while Windmill runs reaches the scene; one that launched it arrives with the scene's connection.
@MainActor final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
  func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                   completionHandler: @escaping (Bool) -> Void) {
    guard let action = QuickAction(shortcutItem) else { completionHandler(false); return }
    QuickActionHandler.perform(action)
    completionHandler(true)
  }
}

extension AppModel {
  var quickActions: [QuickAction] { QuickAction.items(routines: gym.routines, sessions: gym.sessions, open: gym.openSession) }

  func perform(_ action: QuickAction) {
    telemetry.event("quick_action", properties: ["item": action.item])
    switch action {
    case .write: writeTonight()
    case .start(let id, _): startWorkout(fromHome: id)
    case .openWorkout: openActivityWorkout()
    }
  }

  // Tonight's page with the keyboard up: the one door where it rises, because the person asked to write.
  func writeTonight() {
    selectedRoom = .journal; welcome = false
    if !editorReadOnly { journal.editing = true }
    journal.openJournal()
  }

  // The routine's workout, or the one already running: a start never joins or replaces an open workout.
  func startWorkout(fromHome id: ID<Routine>) {
    guard gym.openSession == nil else { openActivityWorkout(); return }
    selectedRoom = .gym; welcome = false
    gym.startWorkout(routineId: id)
  }
}
