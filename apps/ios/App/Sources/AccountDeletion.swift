import SwiftUI
import SyncEngine

// Delete account (27a–27g), from You signed in. In order: the engine's sign-out flush, DELETE /v1/me naming the signed-in
// user id, the discard finish that deletes this phone's copy of the account, and Coach's drafts for it.
enum AccountDeletion: Equatable {
  case confirming, deleting, failed, deleted(closingOn: Date)

  // The typed email confirms when it is the account's, trimmed and in any case.
  static func confirms(_ typed: String, email: String) -> Bool {
    !email.isEmpty && typed.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(email) == .orderedSame
  }

  // 27f: the changes the account has not confirmed go with it.
  static func unconfirmedLine(_ count: Int) -> String? {
    if count == 0 { return nil }
    if count == 1 { return "1 change on this phone hasn’t been confirmed by your account. It is deleted too." }
    return "\(count) changes on this phone haven’t been confirmed by your account. They are deleted too."
  }

  // 27d: the last day a sign-in brings the account back, in the person's locale.
  static func returnLine(_ closingOn: Date, locale: Locale = .autoupdatingCurrent) -> String {
    "Sign in before \(closingOn.formatted(Date.FormatStyle(locale: locale).month(.abbreviated).day())) to bring it back."
  }
}

extension AppModel {
  // What the engine has not had confirmed: entries ready to send and sent without an answer.
  var unsentChanges: Int { (runtime?.engine.status.ready ?? 0) + (runtime?.engine.status.sent ?? 0) }

  func openAccountDeletion() {
    deletion = .confirming
    telemetry.event("account_delete", properties: ["state": "shown"])
  }

  func cancelAccountDeletion() {
    guard deletion == .confirming || deletion == .failed else { return }
    deletion = nil
    telemetry.event("account_delete", properties: ["outcome": "cancelled"])
  }

  func deleteAccount() async {
    guard deletion != .deleting, !accountTransition, let runtime, let account, let token = runtime.tokens.token(for: account) else { return }
    deletion = .deleting; accountTransition = true; journal.editing = false
    defer { accountTransition = false }
    guard flushRooms() else { deletion = .failed; telemetry.event("account_delete", properties: ["outcome": "failed"]); return }
    var session: SignOutSession
    do { session = try await runtime.engine.signOut() } catch {
      reportBoundary("account_delete", error: error)
      deletion = .failed; telemetry.event("account_delete", properties: ["outcome": "failed"]); return
    }
    let closingOn: Date
    do { closingOn = try await runtime.auth.deleteAccount(account, token: token) } catch {
      await session.cancel()
      telemetry.event("account_delete", properties: ["outcome": "failed"])
      // A session already gone, or another account signed in meanwhile, closes the page; You says what holds now.
      let code = (error as? AuthRefusal)?.code
      deletion = code == "unauthorized" || code == "account-mismatch" ? nil : .failed
      return
    }
    do {
      for attempt in 1...3 {
        do { _ = try await session.finish(.discard); break }
        catch EngineError.signOutChanged where attempt < 3 { session = try await runtime.engine.signOut() }
      }
      try CoachDraftStore().delete(account)
    } catch { reportBoundary("account_delete", error: error) }
    runtime.updateTelemetryIdentity()
    forgetAccount(account)
    deletion = .deleted(closingOn: closingOn)
    telemetry.event("account_delete", properties: ["outcome": "ok"])
  }
}

// 27a–27g: the page You pushes. The facts, the email that confirms, and the act pinned above the home indicator; 27d once
// the account is closed, whose Done returns to You signed out.
struct DeleteAccountScreen: View {
  @Bindable var model: AppModel
  @State var typed = ""
  @FocusState var typing: Bool
  @Environment(\.dismiss) var dismiss
  var deleting: Bool { model.deletion == .deleting }

  var body: some View {
    Group {
      if case .deleted(let closingOn) = model.deletion { deleted(closingOn) } else { confirmation }
    }
    .background(ShellPalette.canvas)
    .onAppear { if model.deletion == nil { model.openAccountDeletion() } }
    .onDisappear { model.cancelAccountDeletion() }
    .onChange(of: model.deletion) { _, deletion in if deletion == nil { dismiss() } }
  }

  var confirmation: some View {
    Form {
      Section {
        fact("trash", "This deletes your Windmill account and its copy in the cloud: your roadmaps, journal pages and gym log.")
        fact("iphone", "Every device signs out, and connected tools lose access, right away.")
        fact("clock.arrow.circlepath", "For 30 days, you can sign in again to bring it all back. After that, it is deleted for good.")
        fact("square.and.arrow.up", "To keep a copy, export it first at windmill.works.")
        if let unconfirmed = AccountDeletion.unconfirmedLine(model.unsentChanges) { fact("icloud.slash", unconfirmed) }
      } header: {
        Text("Delete your account?").font(.title.weight(.bold)).foregroundStyle(ShellPalette.ink).textCase(nil)
          .padding(.leading, -RoomSpace.inset).padding(.bottom, 8)
      }
      Section {
        TextField("Email", text: $typed).keyboardType(.emailAddress).textContentType(.username)
          .textInputAutocapitalization(.never).autocorrectionDisabled().focused($typing)
          .disabled(deleting).accessibilityIdentifier("delete-account-email").listRowBackground(ShellPalette.card)
      } header: { Text("Type your email to confirm").font(ShellType.meta).foregroundStyle(ShellPalette.inkDim).textCase(nil) } footer: {
        if model.deletion == .failed {
          Text("Couldn’t delete your account. Check your connection and try again.").font(ShellType.meta).foregroundStyle(ShellPalette.danger)
            .accessibilityIdentifier("delete-account-error")
        } else { Text("Signed in as \(model.accountEmail)").font(ShellType.meta).foregroundStyle(ShellPalette.inkDim) }
      }
    }
    .scrollContentBackground(.hidden).foregroundStyle(ShellPalette.ink)
    .listRowBackground(ShellPalette.card)
    .navigationTitle("Delete account").navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(deleting)
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: RoomSpace.related) {
        Button(role: .destructive) { typing = false; Task { await model.deleteAccount() } } label: {
          HStack(spacing: 8) {
            if deleting { ProgressView().tint(ShellPalette.onBrand) }
            Text(deleting ? "Deleting…" : model.deletion == .failed ? "Try again" : "Delete account")
          }.font(ShellType.action).foregroundStyle(ShellPalette.onBrand).frame(maxWidth: .infinity, minHeight: 34)
        }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large).tint(ShellPalette.danger)
          .disabled(!AccountDeletion.confirms(typed, email: model.accountEmail))
          .accessibilityIdentifier("delete-account-confirm")
        Button("Cancel") { dismiss() }.font(ShellType.body).foregroundStyle(deleting ? ShellPalette.inkFaint : ShellPalette.brand).frame(minHeight: 44)
          .disabled(deleting).accessibilityIdentifier("delete-account-cancel")
      }.padding(.horizontal, RoomSpace.inset).padding(.bottom, 8).background(ShellPalette.canvas)
    }
  }

  func fact(_ symbol: String, _ line: String) -> some View {
    Label { Text(line).font(ShellType.subheadline).foregroundStyle(ShellPalette.ink) } icon: { Image(systemName: symbol).font(ShellType.subheadline).foregroundStyle(ShellPalette.ink) }
      .listRowBackground(ShellPalette.card)
  }

  func deleted(_ closingOn: Date) -> some View {
    VStack(spacing: 10) {
      Spacer()
      Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(ShellPalette.ink).accessibilityHidden(true)
      Text("Your account is deleted").font(.title3.weight(.bold)).foregroundStyle(ShellPalette.ink)
      Text(AccountDeletion.returnLine(closingOn)).font(ShellType.body).foregroundStyle(ShellPalette.inkDim).multilineTextAlignment(.center)
      Spacer()
      Button { model.deletion = nil } label: { Text("Done").frame(maxWidth: .infinity) }
        .font(ShellType.action).modifier(RoomPrimaryStyle(room: .shell)).accessibilityIdentifier("delete-account-done")
    }.padding(.horizontal, RoomSpace.inset).padding(.bottom, 8).frame(maxWidth: .infinity)
      .toolbar(.hidden, for: .navigationBar)
  }
}
