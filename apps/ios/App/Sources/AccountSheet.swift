import SwiftUI
import UIKit
import AuthenticationServices
import CryptoKit
import SyncReplica

struct AccountSheet: View {
  @Bindable var model: AppModel
  @FocusState var focusedInput: AppModel.Sheet?
  @State var appleNonce = ""
  @State var aboutWindmill = false
  @State var usingLink = false
  @State var signInLink = ""
  @State var confirmSignOut = false
  @State var answeringSignOut = false
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @Environment(\.colorScheme) var colorScheme
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.openURL) var openURL
  var receipt: Bool { model.sheet == .appleAdded || ((model.sheet == .adoption || model.sheet == .discardAdoption) && model.appleLinkedReceipt) }
  var compact: Bool { model.compactAccountSheet }
  var inputStep: Bool { [.code, .address, .appleAddress].contains(model.sheet) }
  var shell: Color { ShellPalette.canvas }
  var card: Color { ShellPalette.card }
  var inputSurface: Color { ShellPalette.raised }
  var ink: Color { ShellPalette.ink }
  var dim: Color { ShellPalette.inkDim }
  var faint: Color { ShellPalette.inkFaint }
  var brand: Color { ShellPalette.brand }
  var offline: Bool { model.runtime?.engine.status.online == false }
  var body: some View {
    NavigationStack {
      Group {
        if model.sheet == .you { you } else { steps }
      }.background(shell)
        .navigationTitle(sheetTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(shell, for: .navigationBar)
        .toolbar { accountToolbar }
    }
      .tint(brand)
      .presentationDragIndicator(.hidden)
      .presentationDetents(compact && !typeSize.isAccessibilitySize ? [.medium] : [.large])
      .presentationBackground(shell)
      .sheet(isPresented: $aboutWindmill) {
        NavigationStack {
          OnboardingScreen(replay: true, telemetry: model.telemetry) { aboutWindmill = false }
            .navigationTitle("About Windmill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(shell, for: .navigationBar)
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("Done") { aboutWindmill = false }.accessibilityIdentifier("onboarding-exit")
              }
            }
        }.presentationDetents([.large]).presentationDragIndicator(.hidden)
      }
      .interactiveDismissDisabled(model.signInSession?.isComplete == false || model.signOutSession != nil)
      .disabled(answeringSignOut)
      .animation(.easeOut(duration: reduceMotion ? 0.2 : 0.28), value: model.sheet)
      .sensoryFeedback(.success, trigger: model.authSuccess)
      .sensoryFeedback(.selection, trigger: model.authSelection)
      .onChange(of: model.sheet, initial: true) { _, value in
        if value == .appleAddress { usingLink = false }
        confirmSignOut = value == .signOut && (model.signOutSession?.unsent ?? 0) == 0
        focusedInput = value == .code || value == .address || value == .appleAddress ? value : nil
        if let value { model.screenViewed(value.telemetryName) }
      }
      .task(id: model.sheet) { if model.sheet == .you { await model.loadSignInMethods() } }
      .alert("Sign out?", isPresented: $confirmSignOut) {
        Button("Sign out", role: .destructive) { finishSignOut(.keep) }
        Button("Cancel", role: .cancel, action: cancelSignOut)
      } message: {
        Text("Your pages and log stay in your account and leave this phone.")
      }
      .background {
        AccountConfirmation(model: model, isPresented: model.identityTaken || model.sheet == .adoption || model.sheet == .discardAdoption).frame(width: 0, height: 0)
      }
  }

  var steps: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        switch model.sheet {
        case .keep: keep
        case .address, .appleAddress: address
        case .code: code
        case .adoption, .discardAdoption: if model.appleLinkedReceipt { appleAdded } else { code }
        case .signOut: signOut
        case .appleQuestion: appleQuestion
        case .appleAdded: appleAdded
        case .appleNoAccount: appleNoAccount
        case .appleExpired: appleExpired
        case .authPending: authPending
        case .you, nil: EmptyView()
        }
        if model.sheet != .code, let error = model.error { errorText(error) }
      }.padding(.horizontal, 24).padding(.top, receipt ? 218 : inputStep ? 130 : compact ? 18 : 14).padding(.bottom, inputStep ? 0 : 26)
    }.defaultScrollAnchor(inputStep ? .bottom : .top).foregroundStyle(ink).font(ShellType.body)
  }

  func head(_ symbol: String) -> some View {
    Image(systemName: symbol).font(.largeTitle).foregroundStyle(brand).accessibilityHidden(true)
  }

  @ViewBuilder var authPending: some View {
    Text("Finish signing in").font(ShellType.title)
    if model.updateRequired {
      Text("Syncing paused · update Windmill").foregroundStyle(dim)
      Button(action: openUpdate) { Text("Get the update").frame(maxWidth: .infinity) }
        .font(ShellType.action).modifier(RoomPrimaryStyle(room: .shell)).accessibilityIdentifier("get-update")
    } else {
      Text("Sign-in needs a connection. You can keep using this phone while offline.").foregroundStyle(dim)
      Button { model.choose("retry", screen: "auth_pending"); model.performAuthentication { await model.retryAuthenticatedSignIn() } } label: {
        Text("Try again").frame(maxWidth: .infinity)
      }.font(ShellType.action).modifier(RoomPrimaryStyle(room: .shell)).accessibilityIdentifier("auth-retry")
    }
  }

  func openUpdate() {
    openURL(AppSettings.updateDestination) { model.updateOpened($0) }
  }

  var sheetTitle: String {
    switch model.sheet {
    case .you: "You"
    case .keep: "Keep"
    case .appleQuestion, .appleAdded, .appleNoAccount, .appleExpired: "Apple"
    case .signOut: "Sign out"
    default: "Sign in"
    }
  }

  @ToolbarContentBuilder var accountToolbar: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) { backOrClose }
    ToolbarItem(placement: .confirmationAction) {
      if [.you, .authPending, .adoption, .discardAdoption].contains(model.sheet) {
        Button("Done") { model.cancelAuthentication(); model.choose("close", screen: "you"); model.sheet = nil }
      } else if inputStep {
        Button("Close", role: .cancel, action: closeSignIn)
      }
    }
  }

  @ViewBuilder var backOrClose: some View {
    if model.sheet != .appleAdded {
      if inputStep {
        Button("Back", systemImage: "chevron.left", action: goBack)
      } else if model.sheet == .keep {
        Button("Close") { model.cancelAuthentication(); model.closeKeep() }
      } else if compact {
        Button("Close") { model.cancelAuthentication(); model.closeAppleStep() }
      } else if model.sheet == .signOut {
        Button("Cancel", role: .cancel, action: cancelSignOut)
      }
    }
  }

  func goBack() {
    guard inputStep else { return }
    model.cancelAuthentication(); model.choose("back", screen: model.sheet?.telemetryName ?? "keep"); model.error = nil
    if model.sheet == .code { model.sheet = model.appleTicket == nil ? .address : .appleAddress }
    else if model.sheet == .appleAddress { model.sheet = model.account == nil ? .appleQuestion : model.appleOrigin }
    else { model.sheet = .keep }
  }

  func closeSignIn() {
    guard inputStep else { return }
    model.cancelAuthentication()
    if model.sheet == .appleAddress || model.appleTicket != nil { model.closeAppleStep(); return }
    model.choose("close", screen: model.sheet?.telemetryName ?? "keep")
    model.error = nil; model.sheet = nil
  }

  var appleQuestion: some View {
    VStack(alignment: .leading, spacing: 10) {
      head("person.crop.circle.badge.questionmark")
      Text("Already on Windmill?").font(ShellType.title)
      Text("This Apple ID doesn't open a Windmill account yet. If you have one, confirm its email and Apple will open it too.").font(ShellType.body).tracking(-0.3).foregroundStyle(dim).lineSpacing(2)
      VStack(spacing: 12) {
        equalButton("Use my account") { model.useAppleAccount() }
        equalButton("Create account") { model.performAuthentication { await model.createAppleAccount() } }
      }.padding(.top, 14)
    }
  }

  var appleNoAccount: some View {
    VStack(alignment: .leading, spacing: 10) {
      head("person.crop.circle.badge.questionmark")
      Text("No account at this email").font(ShellType.title)
      Text("\(model.email) doesn't open a Windmill account. Try the address you signed up with, or create one with Apple.").font(ShellType.body).tracking(-0.3).foregroundStyle(dim).lineSpacing(2)
      VStack(spacing: 12) {
        equalButton("Try another email") { model.cancelAuthentication(); model.choose("change_email", screen: "apple_no_account"); model.error = nil; model.code = ""; model.sheet = .appleAddress }
        equalButton("Create account") { model.performAuthentication { await model.createAppleAccount() } }
      }.padding(.top, 14)
    }
  }

  var appleExpired: some View {
    VStack(alignment: .leading, spacing: 10) {
      head("clock.arrow.circlepath")
      Text("Continue with Apple again").font(ShellType.title)
      Text(AuthRefusal.expired.message).foregroundStyle(dim).lineSpacing(3)
      authDoors.padding(.top, 14)
    }
  }

  var appleAdded: some View {
    VStack(alignment: .leading, spacing: 12) {
      receiptSymbol
      Text("Apple added").font(ShellType.title)
      Text("Apple now opens \(model.appleReceiptEmail).").font(ShellType.subheadline).foregroundStyle(dim)
      Text(model.code).font(ShellType.body).frame(maxWidth: .infinity, minHeight: 60, alignment: .leading).padding(.horizontal, 18)
        .background(inputSurface, in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(brand, lineWidth: 1.5)).padding(.top, 8)
    }
  }

  @ViewBuilder var receiptSymbol: some View {
    if #available(iOS 26.0, *) {
      if reduceMotion { head("checkmark.circle").transition(.opacity) }
      else { head("checkmark.circle").transition(.symbolEffect(.drawOn)) }
    } else { head("checkmark.circle") }
  }

  func equalButton(_ label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { Text(label).font(ShellType.secondaryAction).foregroundStyle(brand).frame(maxWidth: .infinity, minHeight: 27) }
      .modifier(RoomSecondaryStyle()).controlSize(.large).buttonBorderShape(.capsule).tint(brand)
  }

  func errorText(_ error: String) -> some View { Text(error).font(ShellType.meta).foregroundStyle(brand).accessibilityIdentifier("auth-error") }

  var keep: some View {
    let journal = model.selectedRoom == .journal || model.welcome
    return VStack(alignment: .leading, spacing: 14) {
      head("checkmark.icloud")
      Text(journal ? "Keep your pages" : "Keep your log").font(ShellType.title)
      Text(journal ? "They live only on this phone. Sign in to back them up and open them on the web."
           : "It lives only on this phone. Sign in to back it up and open it on the web.").foregroundStyle(dim).lineSpacing(4)
      if model.canSignIn {
        authDoors.padding(.top, 10)
      } else {
        Text("Backup is not connected in this build. Your work stays on this phone.").font(ShellType.subheadline).foregroundStyle(dim)
      }
    }
  }

  var authDoors: some View {
    VStack(spacing: 16) {
      appleDoor
      emailDoor.frame(maxWidth: .infinity, minHeight: 44)
      if offline { Text("Sign-in needs a connection.").font(ShellType.meta).foregroundStyle(dim) }
    }
  }

  var emailDoor: some View {
    Button("Use email instead") {
      model.cancelAuthentication(); usingLink = false; model.choose("email", screen: model.sheet?.telemetryName ?? "keep")
      model.appleTicket = nil; model.appleAuthorization = nil; model.error = nil; model.sheet = .address
    }.font(ShellType.action).foregroundStyle(brand).buttonStyle(.plain).disabled(offline).accessibilityIdentifier("email-sign-in")
  }

  @ViewBuilder var appleDoor: some View {
      if model.runtime?.settings.appleEnabled == true {
        if model.runtime?.settings.fakeApple == true {
          Button {
            model.performAuthentication {
              guard let auth = model.runtime?.auth else { model.error = "Sign-in is unavailable."; return }
              await model.authenticateApple { token in
                return try auth.authorizeFakeApple(token: token)
              }
            }
          } label: {
            HStack { Image(systemName: "apple.logo"); Text("Continue with Apple").font(ShellType.action) }.frame(maxWidth: .infinity).frame(height: 52).foregroundStyle(colorScheme == .dark ? .black : .white).background(colorScheme == .dark ? .white : .black, in: Capsule())
          }.disabled(offline).opacity(offline ? 0.4 : 1).accessibilityIdentifier("apple-sign-in")
        } else {
          SignInWithAppleButton(.continue) { request in
            appleNonce = UUID().uuidString + UUID().uuidString
            request.requestedScopes = [.fullName, .email]
            request.nonce = SHA256.hash(data: Data(appleNonce.utf8)).map { String(format: "%02x", $0) }.joined()
          } onCompletion: { result in
            model.performAuthentication {
              do {
                let authorization = try result.get()
                guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                      let data = credential.identityToken, let identityToken = String(data: data, encoding: .utf8), let auth = model.runtime?.auth else { throw URLError(.cannotParseResponse) }
                let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) } ?? ""
                let nonce = appleNonce
                await model.authenticateApple { token in try await auth.apple(identityToken: identityToken, nonce: nonce, name: name, token: token) }
              } catch {
                let cancelled = (error as? ASAuthorizationError)?.code == .canceled
                model.telemetry.event("auth_signed_in", properties: ["method": "apple", "outcome": cancelled ? "cancelled" : "failed"])
                if !cancelled { model.telemetry.failure("auth_apple", kind: "unexpected") }
                if !cancelled { model.error = "Couldn't continue with Apple. Try again, or use email instead." }
              }
            }
          }.signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black).frame(height: 52).clipShape(Capsule())
            .disabled(offline).opacity(offline ? 0.4 : 1)
        }
      }
  }

  var address: some View {
    VStack(alignment: .leading, spacing: 18) {
      Image(systemName: "envelope").font(.system(size: 25)).foregroundStyle(brand)
      if usingLink {
        Text("Your sign-in link").font(ShellType.title)
        Text("Works once and lasts 15 minutes.").font(ShellType.subheadline).foregroundStyle(dim)
        TextField("Sign-in link or token", text: $signInLink).textInputAutocapitalization(.never).autocorrectionDisabled()
          .padding(18).background(inputSurface, in: RoundedRectangle(cornerRadius: 18)).accessibilityIdentifier("sign-in-link")
        Button { model.performAuthentication { await model.verifyLink(signInLink) } } label: {
          Text("Sign in").frame(maxWidth: .infinity)
        }.font(ShellType.action)
          .modifier(RoomPrimaryStyle(room: .shell)).disabled(model.working || signInLink.isEmpty).accessibilityIdentifier("sign-in-link-submit")
        Button("Use email instead") { model.cancelAuthentication(); usingLink = false; model.error = nil }.frame(minHeight: 44)
      } else {
      Text(model.sheet == .appleAddress ? "Your Windmill email" : "Sign in with email").font(ShellType.title)
      Text(model.sheet == .appleAddress ? "We'll send a code to confirm it's yours." : "We'll send a six-digit code.").font(ShellType.subheadline).foregroundStyle(dim)
      TextField("Email address", text: Binding(get: { model.email }, set: { if !model.working { model.email = $0 } })).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focusedInput, equals: model.sheet == .appleAddress ? .appleAddress : .address)
        .padding(18).background(inputSurface, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(brand)).accessibilityIdentifier("email-address")
      Button { model.performAuthentication { await model.sendCode() } } label: {
        Text("Send code").frame(maxWidth: .infinity)
      }.font(ShellType.action).modifier(RoomPrimaryStyle(room: .shell)).disabled(model.working || !model.email.contains("@"))
      Text("New here? This also creates your account.").font(ShellType.meta).foregroundStyle(dim)
      }
    }
  }

  var code: some View {
    VStack(alignment: .leading, spacing: 16) {
      Image(systemName: "envelope").font(.system(size: 25)).foregroundStyle(brand)
      Text("Check your email").font(ShellType.title)
      HStack(spacing: 7) {
        Text("Sent to \(model.email)").font(ShellType.subheadline).foregroundStyle(dim)
        Button("Change") { model.cancelAuthentication(); model.choose("change_email", screen: "code"); model.error = nil; model.sheet = model.appleTicket == nil ? .address : .appleAddress }.font(ShellType.secondaryAction).foregroundStyle(brand)
      }
      TextField("6-digit code", text: Binding(get: { model.code }, set: { if !model.working { model.code = String($0.filter { $0.isASCII && $0.isNumber }.prefix(6)) } })).keyboardType(.numberPad).textContentType(.oneTimeCode).focused($focusedInput, equals: .code)
        .padding(18).frame(minHeight: 60).background(inputSurface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(brand, lineWidth: 1.5)).accessibilityIdentifier("email-code")
        .overlay(alignment: .trailing) { if model.authBusyIndicator { ProgressView().tint(brand).padding(.trailing, 18) } }
        .onChange(of: model.code) { _, value in
          if value.count == 6 { model.performAuthentication { await model.verifyCode() } }
        }
      if let error = model.error { errorText(error) }
      else { Text("It works once and lasts 15 minutes.").font(ShellType.meta).foregroundStyle(faint) }
      if model.appleTicket == nil {
        Button("Use a sign-in link") { model.cancelAuthentication(); usingLink = true; model.code = ""; model.sheet = .address }
          .frame(minHeight: 44).accessibilityIdentifier("link-sign-in")
      }
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let remaining = max(0, 30 - Int(context.date.timeIntervalSince(model.codeSentAt ?? .distantPast)))
        Button(remaining == 0 ? "Resend code" : "Resend code in 0:\(String(format: "%02d", remaining))") { model.performAuthentication { await model.sendCode() } }
          .font(ShellType.secondaryAction).foregroundStyle(remaining == 0 ? brand : faint).disabled(remaining > 0 || model.working).frame(minHeight: 44, alignment: .leading)
      }
    }
  }

  var you: some View {
    let signedIn = model.account != nil
    let doors = model.canSignIn && (!signedIn || model.authPaused)
    let apple = model.signInMethods.first { $0.kind == "apple" }
    return List {
      Section {
        identityRow
        if doors {
          appleDoor.listRowSeparator(.hidden)
          emailDoor.frame(maxWidth: .infinity, minHeight: 44).listRowSeparator(.hidden)
        }
        if model.updateRequired {
          Button(action: openUpdate) {
            HStack { Text("Get the update"); Spacer(); Image(systemName: "arrow.up.forward").accessibilityHidden(true) }
              .foregroundStyle(brand).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityIdentifier("get-update")
        }
      } footer: {
        if doors && offline { Text("Sign-in needs a connection.") }
        else if doors && signedIn { Text("Sign in to the same account. Your writing stays on this phone.") }
      }.listRowBackground(card)
      if !signedIn {
        Section("On this phone") {
          let pages = model.journal.room?.days.filter { $0.document.isWritten }.count ?? 0
          factRow("Journal", pages == 0 ? "nothing yet" : "\(pages) \(pages == 1 ? "page" : "pages")", symbol: AppModel.Room.journal.symbol)
          factRow("Gym", model.gym.phoneSummary, symbol: AppModel.Room.gym.symbol)
        }.listRowBackground(card)
      } else {
        if !model.authPaused {
          Section {
            factRow("Email", model.accountEmail, symbol: "envelope")
            if let apple {
              Button { model.askToRemoveApple() } label: {
                factRow("Apple", apple.relay ? "Hide My Email" : apple.email, symbol: "apple.logo").contentShape(Rectangle())
              }.buttonStyle(.plain).accessibilityIdentifier("apple-method")
                .confirmationDialog("Remove Apple?", isPresented: Binding(get: { model.removingApple }, set: { if !$0 { model.cancelAppleRemoval() } }),
                                    titleVisibility: .visible) {
                  Button("Remove Apple", role: .destructive) { model.confirmAppleRemoval() }
                  Button("Cancel", role: .cancel) { model.cancelAppleRemoval() }
                } message: {
                  Text("You'll sign in with \(model.accountEmail) instead. Apple won't open this account.")
                }
                .swipeActions { Button("Remove Apple", role: .destructive) { model.askToRemoveApple() } }
            } else { appleDoor }
          } header: { Text("How you sign in") } footer: {
            Text(apple == nil ? "Apple will open this same account." : "Either one opens this account.")
          }.listRowBackground(card)
        }
        Section("Your data") {
          factRow("Backup", model.authPaused ? "Paused" : model.backup == "backed up" ? "Up to date" : "Not backed up yet", symbol: "checkmark.icloud")
        }.listRowBackground(card)
      }
      Section("Settings") {
        Picker("Appearance", selection: Binding(get: { model.appearance }, set: { model.chooseAppearance($0) })) {
          ForEach(AppModel.Appearance.allCases, id: \.self) { Text($0.title).tag($0) }
        }.pickerStyle(.segmented).accessibilityIdentifier("appearance")
        doorRow("Gym settings", identifier: "you-gym-settings") {
          model.cancelAuthentication(); model.sheet = nil
          model.gymSettingsRequested = true
          model.openRoom(.gym)
        }
        doorRow("About Windmill", identifier: "about-windmill") {
          model.telemetry.event("onboarding_replayed", properties: ["presentation": "replay"])
          aboutWindmill = true
        }
      }.listRowBackground(card)
      if signedIn {
        Section {
          Button(role: .destructive) { model.performAuthentication { await model.beginSignOut() } } label: {
            Text("Sign out").foregroundStyle(ShellPalette.danger)
          }.accessibilityIdentifier("sign-out")
        }.listRowBackground(card)
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).listRowSeparatorTint(ShellPalette.line)
      .safeAreaInset(edge: .bottom) { if model.updateOpenFailed { UpdateFailure(model: model) } }
  }

  var identityRow: some View {
    HStack(spacing: 14) {
      if model.account == nil { Image(systemName: "person.crop.circle").font(.largeTitle).foregroundStyle(dim) }
      else {
        Text(String(model.accountName.prefix(1))).font(ShellType.title).foregroundStyle(ShellPalette.onBrand)
          .frame(width: 52, height: 52).background(brand, in: Circle())
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(model.account == nil ? "Not signed in" : model.accountName).font(ShellType.action).foregroundStyle(ink)
        Text(identityState).font(ShellType.subheadline).foregroundStyle(dim)
      }
    }.padding(.vertical, 4)
  }

  var identityState: String {
    if model.account == nil { return "Everything lives on this phone" }
    if model.updateRequired { return "Syncing paused · update Windmill" }
    return model.authPaused ? "Backup is paused. Sign in again to resume." : "Signed in with email"
  }

  func factRow(_ name: String, _ value: String, symbol: String) -> some View {
    LabeledContent {
      Text(value).foregroundStyle(dim)
    } label: {
      Label { Text(name).foregroundStyle(ink) } icon: { Image(systemName: symbol).foregroundStyle(dim) }
    }
  }

  func doorRow(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        Text(title).foregroundStyle(ink)
        Spacer()
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(faint).accessibilityHidden(true)
      }.contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityIdentifier(identifier)
  }

  var signOut: some View {
    VStack(alignment: .leading, spacing: 20) {
      let count = model.signOutSession?.unsent ?? 0
      Text(count == 0 ? "Your pages and log stay in your account and leave this phone." : "\(count) pending work \(count == 1 ? "item hasn't" : "items haven't") been confirmed as backed up. Keep \(count == 1 ? "it" : "them") on this phone for this account, or discard \(count == 1 ? "it" : "them") from this phone.").foregroundStyle(dim)
      if count == 0 {
        Button("Sign out", role: .destructive) {
          if model.sheet == .signOut && !answeringSignOut { confirmSignOut = true }
        }
          .frame(maxWidth: .infinity, minHeight: 52).accessibilityIdentifier("sign-out-retry")
      } else {
        Button("Keep and sign out") { finishSignOut(.keep) }
          .frame(maxWidth: .infinity, minHeight: 52).accessibilityIdentifier("sign-out-keep")
        Button("Discard and sign out", role: .destructive) { finishSignOut(.discard) }
          .frame(maxWidth: .infinity, minHeight: 52)
      }
    }
  }

  func finishSignOut(_ choice: SignOutChoice) {
    guard model.sheet == .signOut, !model.accountTransition, !answeringSignOut else { return }
    answeringSignOut = true
    Task {
      await model.finishSignOut(choice)
      answeringSignOut = false
    }
  }

  func cancelSignOut() {
    guard model.sheet == .signOut, !model.accountTransition, !answeringSignOut else { return }
    answeringSignOut = true
    Task {
      await model.cancelSignOut()
      answeringSignOut = false
    }
  }
}

struct AccountConfirmation: UIViewControllerRepresentable {
  let model: AppModel
  let isPresented: Bool
  func makeUIViewController(context: Context) -> Presenter { Presenter() }
  func updateUIViewController(_ controller: Presenter, context: Context) {
    controller.model = model
    if isPresented { controller.showConfirmation() } else { controller.dialog?.dismiss(animated: true) }
  }

  final class Presenter: UIViewController {
    var model: AppModel?
    var settling = false
    weak var dialog: UIAlertController?
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); showConfirmation() }
    func afterDismissal(of controller: UIViewController, perform completion: @escaping () -> Void) {
      // A rejected transition can still invoke its completion after dismissal.
      var completed = false
      let finish = {
        guard !completed else { return }
        completed = true
        completion()
      }
      if let transition = controller.transitionCoordinator,
         transition.animate(alongsideTransition: nil, completion: { _ in finish() }) { return }
      controller.dismiss(animated: true, completion: finish)
    }
    func showConfirmation() {
      guard let model, !settling, view.window != nil else { return }
      guard model.identityTaken || model.sheet == .adoption || model.sheet == .discardAdoption else {
        dialog?.dismiss(animated: true); return
      }
      var host: UIViewController = self
      while let parent = host.parent { host = parent }
      guard host.presentedViewController == nil else { return }
      let alert = UIAlertController(title: model.adoptionAlertTitle, message: model.adoptionAlertMessage, preferredStyle: .alert)
      dialog = alert
      func button(_ title: String, style: UIAlertAction.Style = .default, action: @escaping @MainActor () async -> Void) {
        alert.addAction(UIAlertAction(title: title, style: style) { [weak self, weak alert] _ in
          guard let self, let alert else { return }
          self.settling = true
          let finish: () -> Void = { [weak self] in
            model.performAuthentication {
              await action()
              self?.settling = false
              self?.showConfirmation()
            }
          }
          self.afterDismissal(of: alert, perform: finish)
        })
      }
      if model.identityTaken {
        button("OK") { model.identityTaken = false }
      } else if model.sheet == .discardAdoption {
        button("Cancel", style: .cancel) { model.choose("cancel", screen: "discard_adoption"); model.sheet = .adoption }
        button("Discard", style: .destructive) { await model.adopt(.discard) }
      } else {
        button("Not now", style: .cancel) { model.cancelAuthentication(); model.choose("cancel", screen: "adoption"); model.sheet = nil }
        button("Add") { await model.adopt(.add) }
        button("Discard") { model.choose("discard", screen: "adoption"); model.sheet = .discardAdoption }
      }
      host.present(alert, animated: true)
    }
  }
}
