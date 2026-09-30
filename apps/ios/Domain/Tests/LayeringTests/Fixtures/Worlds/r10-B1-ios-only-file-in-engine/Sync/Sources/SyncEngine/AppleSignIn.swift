#if os(iOS)
import AuthenticationServices

// Sign in with Apple beside the session-token port. iOS only: the macOS build is for tests and has nothing to present.
// The anchor is the key window of the foreground scene; UIKit is never imported, AuthenticationServices brings it.
final class AppleSignIn: NSObject, ASAuthorizationControllerPresentationContextProviding {
  @MainActor func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow ?? UIWindow()
  }
}
#endif
