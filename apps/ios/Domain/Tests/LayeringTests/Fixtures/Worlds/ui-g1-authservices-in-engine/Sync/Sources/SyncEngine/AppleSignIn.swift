import AuthenticationServices

// layering r9 G1, both forms: Sign in with Apple beside the session-token port, presenting from a window found through
// UIKit (iOS) or AppKit (macOS), neither of them imported.
final class AppleSignIn: NSObject, ASAuthorizationControllerPresentationContextProviding {
#if os(iOS)
  @MainActor func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow ?? UIWindow()
  }
#else
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    NSApplication.shared.keyWindow ?? NSWindow()
  }
#endif
}
