#if os(iOS)
import UIKit

@MainActor public enum AppLifecycle {
  public static let leaving = UIApplication.didEnterBackgroundNotification
}
#endif
