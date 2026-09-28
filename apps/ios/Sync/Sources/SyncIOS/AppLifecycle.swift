import Foundation
import SyncEngine
#if os(iOS)
import UIKit
#endif

// Leaving the app and coming back (design §6.7, §7.3). Leaving is the last foreground scene going to the background:
// every held entry is released at once, so Undo is not offered again, and one flush pushes them inside the background
// time the system lends. An inactive app (Control Center, the app switcher, an alert) has not left. Coming back sends,
// pulls and follows live again. No background task keeps a hold: what the flush cannot send goes at the next foreground
// or launch.

// MARK: - Background time

// The time the system lends an app that has left: granted by name, handed back by its identifier, and taken back when it
// runs out.
@MainActor
public protocol BackgroundTime: AnyObject {
  // The identifier of the time granted, nil when none is; `expired` runs on the main actor when it runs out.
  func begin(named name: String, expired: @escaping @MainActor @Sendable () -> Void) -> Int?
  func end(_ identifier: Int)
}

// Async work inside background time. The time is handed back exactly once: when the work ends, or when the time runs
// out, whichever comes first; running out cancels the work, so a push in flight is cancelled and its entries stay sent.
@MainActor
public final class BackgroundActivity {
  // One run's time: its identifier once granted, and whether it was handed back.
  final class Lease {
    var identifier: Int?
    var ended = false
  }

  let time: any BackgroundTime

  public init(time: any BackgroundTime) {
    self.time = time
  }

  // With no time granted the work still runs, for as long as the app does.
  @discardableResult
  public func run(named name: String, _ work: @escaping @Sendable () async -> Void) -> Task<Void, Never> {
    let lease = Lease()
    let task = Task { @MainActor in
      await work()
      self.end(lease)
    }
    let granted = time.begin(named: name) { [weak self] in
      task.cancel()
      self?.end(lease)
    }
    if lease.ended {
      if let granted { time.end(granted) }
    } else {
      lease.identifier = granted
    }
    return task
  }

  func end(_ lease: Lease) {
    guard !lease.ended else { return }
    lease.ended = true
    if let identifier = lease.identifier { time.end(identifier) }
  }
}

// MARK: - The app's lifecycle

// Observed by selector, so the center forgets the lifecycle when it goes.
@MainActor
public final class AppLifecycle: NSObject {
  // The two signals, as notifications posted on the main thread: the app left, and it is coming back.
  public struct Signals: Sendable {
    public let leaving: Notification.Name
    public let returning: Notification.Name

    public init(leaving: Notification.Name, returning: Notification.Name) {
      self.leaving = leaving
      self.returning = returning
    }
  }

  let engine: SyncEngine
  let activity: BackgroundActivity
  // The last leave's flush, while it runs and after.
  package private(set) var leaveFlush: Task<Void, Never>?

  public init(engine: SyncEngine, signals: Signals, time: any BackgroundTime, center: NotificationCenter = .default) {
    self.engine = engine
    activity = BackgroundActivity(time: time)
    super.init()
    center.addObserver(self, selector: #selector(leave), name: signals.leaving, object: nil)
    center.addObserver(self, selector: #selector(comeBack), name: signals.returning, object: nil)
  }

  // A store that cannot release now leaves its holds for engine start; the flush still sends what is ready.
  @objc func leave() {
    try? engine.leave()
    leaveFlush = activity.run(named: "windmill.sync.leave") { [engine] in await engine.flushOnLeave() }
  }

  @objc func comeBack() {
    engine.foreground()
  }
}

#if os(iOS)
extension AppLifecycle.Signals {
  // UIKit's: the app entered the background, and it will enter the foreground.
  public static let application = AppLifecycle.Signals(
    leaving: UIApplication.didEnterBackgroundNotification, returning: UIApplication.willEnterForegroundNotification)
}

extension AppLifecycle {
  public convenience init(engine: SyncEngine) {
    self.init(engine: engine, signals: .application, time: ApplicationBackgroundTime())
  }
}

// UIKit's background tasks.
@MainActor
public final class ApplicationBackgroundTime: BackgroundTime {
  public init() {}

  public func begin(named name: String, expired: @escaping @MainActor @Sendable () -> Void) -> Int? {
    let identifier = UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expired)
    return identifier == .invalid ? nil : identifier.rawValue
  }

  public func end(_ identifier: Int) {
    UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: identifier))
  }
}
#endif
