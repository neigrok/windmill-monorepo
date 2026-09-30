// module: SyncIOS
// expect: pass
#if os(iOS)
import UIKit
public enum Lifecycle { public static let didEnterBackground = UIApplication.didEnterBackgroundNotification }
#endif
