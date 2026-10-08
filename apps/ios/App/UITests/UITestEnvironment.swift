import XCTest

@objc(UITestEnvironment)
final class UITestEnvironment: NSObject, XCTestObservation {
  override init() {
    super.init()
    XCTestObservationCenter.shared.addTestObserver(self)
  }

  func testBundleWillStart(_ testBundle: Bundle) {
    let prepare: @MainActor @Sendable () -> Void = {
      XCUIDevice.shared.press(.home)
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      precondition(springboard.wait(for: .runningForeground, timeout: 30),
        "SpringBoard must reach the foreground before UI tests begin")
      precondition(springboard.icons["Safari"].wait(for: \.isHittable, toEqual: true, timeout: 30),
        "The Home screen must accept a native hit before UI tests begin")
    }
    if Thread.isMainThread {
      MainActor.assumeIsolated { prepare() }
      return
    }
    DispatchQueue.main.sync { prepare() }
  }
}
