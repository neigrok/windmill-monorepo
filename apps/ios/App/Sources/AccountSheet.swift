import SwiftUI
import AuthenticationServices
import CryptoKit
import SyncReplica

struct AccountSheet: View {
  @Bindable var model: JournalModel
  @FocusState var inputFocused: Bool
  @State var appleNonce = ""
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        if model.sheet == .code || model.sheet == .address {
          roundButton("chevron.left", "Back") { model.choose("back", screen: model.sheet?.rawValue ?? "keep"); model.sheet = model.sheet == .code ? .address : .keep }
        } else if model.sheet == .keep { roundButton("xmark", "Close") { model.closeKeep() } }
        Spacer()
        if model.sheet == .you { Button("Done") { model.choose("close", screen: "you"); model.sheet = nil }.font(Design.strong()).padding(.horizontal, 18).frame(height: 44).modifier(Glass()) }
      }.padding(.horizontal, 24).padding(.top, model.sheet == .keep ? 24 : 16)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          switch model.sheet {
          case .keep: keep
          case .address: address
          case .code: code
          case .you: you
          case .adoption: adoption
          case .discardAdoption: discardAdoption
          case .signOut: signOut
          case nil: EmptyView()
          }
          if let error = model.error { Text(error).font(Design.text(13)).foregroundStyle(Design.brand).accessibilityIdentifier("auth-error") }
        }.padding(.horizontal, 24).padding(.top, model.sheet == .code ? 150 : 24).padding(.bottom, model.sheet == .code ? 0 : 26)
      }.defaultScrollAnchor(model.sheet == .code ? .bottom : .top)
    }.background(model.sheet == .code || model.sheet == .address ? Design.card : Design.shell)
      .foregroundStyle(Design.ink).font(Design.text()).tint(Design.brand)
      .presentationDragIndicator(.visible)
      .presentationDetents(model.sheet == .keep && !typeSize.isAccessibilitySize ? [.height(411)] : [.large])
      .presentationCornerRadius(38)
      .interactiveDismissDisabled(model.editorReadOnly)
      .disabled(model.working || model.accountTransition)
      .onChange(of: model.sheet, initial: true) { _, value in inputFocused = value == .code || value == .address; if let value { model.screenViewed(value == .discardAdoption ? "discard_adoption" : value == .signOut ? "sign_out" : value.rawValue) } }
  }

  var keep: some View {
    VStack(alignment: .leading, spacing: 14) {
      Image(systemName: "checkmark.icloud").font(.system(size: 27)).foregroundStyle(Design.brand)
      Text("Keep your pages").font(Design.title())
      Text("They live only on this phone. Sign in to back them up and open them on the web.").foregroundStyle(Design.dim).lineSpacing(4)
      if model.canSignIn {
        authDoors.padding(.top, 10)
      } else {
        Text("Backup is not connected in this build. Your pages stay on this phone.").font(Design.text(14)).foregroundStyle(Design.dim)
      }
    }
  }

  var authDoors: some View {
    VStack(spacing: 16) {
      if model.runtime?.settings.appleEnabled == true {
        if model.runtime?.settings.fakeApple == true {
          Button {
            Task {
              await model.authenticateApple {
                guard let auth = model.runtime?.auth else { throw AppFailure(message: "Sign-in is unavailable.") }
                return try auth.fakeApple()
              }
            }
          } label: {
            HStack { Image(systemName: "apple.logo"); Text("Continue with Apple").font(Design.strong(17)) }.frame(maxWidth: .infinity).frame(height: 52).foregroundStyle(.black).background(.white, in: Capsule())
          }.accessibilityIdentifier("apple-sign-in")
        } else {
          SignInWithAppleButton(.continue) { request in
            appleNonce = UUID().uuidString + UUID().uuidString
            request.requestedScopes = [.fullName, .email]
            request.nonce = SHA256.hash(data: Data(appleNonce.utf8)).map { String(format: "%02x", $0) }.joined()
          } onCompletion: { result in
            Task {
              do {
                let authorization = try result.get()
                guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                      let data = credential.identityToken, let identityToken = String(data: data, encoding: .utf8), let auth = model.runtime?.auth else { return }
                let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) } ?? ""
                await model.authenticateApple { try await auth.apple(identityToken: identityToken, nonce: appleNonce, name: name) }
              } catch {
                let cancelled = (error as? ASAuthorizationError)?.code == .canceled
                model.telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": cancelled ? "cancelled" : "failed"])
                if !cancelled { model.telemetry.failure("auth_apple", kind: "unexpected") }
                model.error = error.localizedDescription
              }
            }
          }.signInWithAppleButtonStyle(.white).frame(height: 52).clipShape(Capsule())
        }
      }
      Button("Use email instead") { model.choose("email", screen: model.sheet?.rawValue ?? "keep"); model.sheet = .address }.font(Design.strong()).frame(maxWidth: .infinity, minHeight: 44).accessibilityIdentifier("email-sign-in")
      Text("Signed up with email before? Use email, so it stays one account.").font(Design.text(13)).foregroundStyle(Design.faint).multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 5)
    }.buttonStyle(.plain)
  }

  var address: some View {
    VStack(alignment: .leading, spacing: 18) {
      Image(systemName: "envelope").font(.system(size: 25)).foregroundStyle(Design.brand)
      Text("Sign in with email").font(Design.title())
      Text("We'll send a six-digit code.").foregroundStyle(Design.dim)
      TextField("Email address", text: $model.email).keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().focused($inputFocused)
        .padding(18).background(Color(hex: 0x222224), in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(Design.brand)).accessibilityIdentifier("email-address")
      Button("Send code") { Task { await model.sendCode() } }.font(Design.strong()).frame(maxWidth: .infinity, minHeight: 52).background(Design.brand, in: Capsule()).foregroundStyle(Design.shell).disabled(model.working || !model.email.contains("@"))
    }
  }

  var code: some View {
    VStack(alignment: .leading, spacing: 16) {
      Image(systemName: "envelope").font(.system(size: 25)).foregroundStyle(Design.brand)
      Text("Check your email").font(Design.title())
      HStack(spacing: 7) {
        Text("Sent to \(model.email)").font(Design.text(14)).foregroundStyle(Design.dim)
        Button("Change") { model.choose("change_email", screen: "code"); model.sheet = .address }.font(Design.strong(14)).foregroundStyle(Design.brand)
      }
      TextField("6-digit code", text: $model.code).keyboardType(.numberPad).textContentType(.oneTimeCode).focused($inputFocused)
        .padding(18).frame(minHeight: 60).background(Color(hex: 0x222224), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Design.brand, lineWidth: 1.5)).accessibilityIdentifier("email-code")
        .onChange(of: model.code) { _, value in
          let digits = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6))
          if value != digits { model.code = digits }
          if digits.count == 6 { Task { await model.verifyCode() } }
        }
      Text("It works once and lasts 15 minutes.").font(Design.text(13)).foregroundStyle(Design.faint)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let remaining = max(0, 30 - Int(context.date.timeIntervalSince(model.codeSentAt ?? .distantPast)))
        Button(remaining == 0 ? "Resend code" : "Resend code in 0:\(String(format: "%02d", remaining))") { Task { await model.sendCode() } }
          .font(Design.strong(13)).foregroundStyle(remaining == 0 ? Design.brand : Design.faint).disabled(remaining > 0 || model.working).frame(minHeight: 44, alignment: .leading)
      }
    }
  }

  var you: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text("You").font(Design.title(34))
      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 14) {
          Image(systemName: "person.crop.circle").font(.system(size: 28))
          VStack(alignment: .leading, spacing: 5) {
            Text(model.account == nil ? "Not signed in" : model.accountName).font(Design.strong())
            Text(model.account == nil ? "Everything lives on this phone" : model.authPaused ? "Backup is paused. Sign in again to resume." : "Signed in").font(Design.text(13)).foregroundStyle(Design.dim)
          }
        }
        if model.account == nil && model.canSignIn { authDoors }
        if model.account != nil && model.authPaused && model.canSignIn {
          Text("Sign in to the same account. Your writing stays on this phone.").font(Design.text(13)).foregroundStyle(Design.dim)
          authDoors
        }
      }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Design.card, in: RoundedRectangle(cornerRadius: 22))
      if model.account == nil {
        Text("ON THIS PHONE").font(Design.mono()).foregroundStyle(Design.faint)
        fact("Journal", "\(model.room?.days.count ?? 0) pages")
      } else {
        Text("YOUR DATA").font(Design.mono()).foregroundStyle(Design.faint)
        fact("Backup", model.authPaused ? "Paused" : model.backup == "backed up" ? "Up to date" : "Not backed up yet")
        Button("Sign out") { Task { await model.beginSignOut() } }.frame(minHeight: 52).accessibilityIdentifier("sign-out")
      }
    }
  }

  var adoption: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Add your pages?").font(Design.title())
      Text("This account already has pages. Add \(model.adoptionCount) pages from this phone, or discard them from this phone.").foregroundStyle(Design.dim)
      Button("Add") { Task { await model.adopt(.add) } }.frame(maxWidth: .infinity, minHeight: 52).modifier(Glass()).foregroundStyle(Design.brand)
      Button("Discard") { model.choose("discard", screen: "adoption"); model.sheet = .discardAdoption }.frame(maxWidth: .infinity, minHeight: 52).modifier(Glass()).foregroundStyle(Design.brand)
    }
  }

  var discardAdoption: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Discard these pages?").font(Design.title())
      Text("Discard \(model.adoptionCount) pages written on this phone while signed out. Your account's pages stay in your account.").foregroundStyle(Design.dim)
      Button("Discard", role: .destructive) { Task { await model.adopt(.discard) } }.frame(maxWidth: .infinity, minHeight: 52)
      Button("Cancel", role: .cancel) { model.choose("cancel", screen: "discard_adoption"); model.sheet = .adoption }.frame(maxWidth: .infinity, minHeight: 52)
    }
  }

  var signOut: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Sign out?").font(Design.title())
      let count = model.signOutSession?.unsent ?? 0
      Text(count == 0 ? "Your pages stay in your account and leave this phone." : "\(count) pending work items haven't been confirmed as backed up. Keep them on this phone for this account, or discard them from this phone.").foregroundStyle(Design.dim)
      Button(count == 0 ? "Sign out" : "Keep and sign out") { Task { await model.finishSignOut(.keep) } }.frame(maxWidth: .infinity, minHeight: 52).accessibilityIdentifier("sign-out-keep")
      if count > 0 { Button("Discard and sign out", role: .destructive) { Task { await model.finishSignOut(.discard) } }.frame(maxWidth: .infinity, minHeight: 52) }
      Button("Cancel", role: .cancel) { Task { await model.cancelSignOut() } }.frame(maxWidth: .infinity, minHeight: 52)
    }
  }

  func fact(_ name: String, _ value: String) -> some View {
    HStack { Text(name); Spacer(); Text(value).foregroundStyle(Design.dim) }.padding(16).frame(minHeight: 52).background(Design.card, in: RoundedRectangle(cornerRadius: 20))
  }
  func roundButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { Image(systemName: symbol).frame(width: 44, height: 44).modifier(Glass(capsule: false)) }.accessibilityLabel(label)
  }
}
