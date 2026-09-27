// sense r10: kit test support (part of the kit, D-1) with Sign in with Apple, written iOS-only.
#if os(iOS)
import AuthenticationServices

final class TestSignIn: NSObject, ASAuthorizationControllerPresentationContextProviding {
  @MainActor func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow ?? UIWindow()
  }
}
#endif
