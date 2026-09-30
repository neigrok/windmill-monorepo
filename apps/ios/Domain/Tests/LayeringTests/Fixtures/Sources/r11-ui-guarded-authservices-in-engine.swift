// module: SyncEngine
// expect: 6: import AuthenticationServices
// expect: 7: import UIKit
import Foundation
#if os(iOS)
import AuthenticationServices
import UIKit
final class AppleSignIn: NSObject, ASAuthorizationControllerPresentationContextProviding {
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow ?? UIWindow()
  }
}
#endif
