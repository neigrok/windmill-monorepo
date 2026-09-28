import SwiftUI
import SyncEngine
import SyncReplica

struct LifecycleScreen: View {
  let probe: Probe
  @State private var account: String
  @State private var token: String
  @State private var signingIn: SignInSession?
  @State private var signingOut: SignOutSession?
  @State private var lastStep = "Nothing done yet"

  init(probe: Probe) {
    self.probe = probe
    _account = State(initialValue: probe.settings.account ?? "")
    _token = State(initialValue: probe.settings.token ?? "")
  }

  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        Form {
          Section("Last step") { Text(verbatim: lastStep) }
          statusSection
          signInSection
          signOutSection
          dormantSection
        }
      }
      .navigationTitle("Lifecycle")
      .sheet(isPresented: Binding(get: { signingIn != nil }, set: { if !$0 { signingIn = nil } })) {
        if let session = signingIn {
          DecisionsSheet(session: session) { step in
            signingIn = nil
            lastStep = step
          }
        }
      }
    }
  }

  @ViewBuilder var statusSection: some View {
    let status = probe.engine.status
    Section("Status") {
      LabeledContent("account", value: status.account ?? "signed out")
      LabeledContent("authPaused", value: String(status.authPaused))
      LabeledContent("upgradeRequired", value: String(status.upgradeRequired))
      LabeledContent("online", value: String(status.online))
      LabeledContent("pendingSignIn", value: status.pendingSignIn ?? "none")
      LabeledContent("unsent", value: "\(status.ready) ready · \(status.sent) sent")
    }
  }

  var signInSection: some View {
    Section("Sign in") {
      TextField("Account", text: $account).textInputAutocapitalization(.never).autocorrectionDisabled()
      TextField("Session token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
      Button("Sign in") { Task { await signIn() } }.disabled(account.isEmpty || token.isEmpty)
    }
  }

  @ViewBuilder var signOutSection: some View {
    if let session = signingOut {
      Section("Signing out \(session.account)") {
        LabeledContent("Ready, never sent", value: "\(session.ready)")
        LabeledContent("Sent, may already be saved", value: "\(session.sent)")
        Button("Keep them on this device") { Task { await finishSignOut(session, .keep) } }
        Button("Discard them from this device", role: .destructive) { Task { await finishSignOut(session, .discard) } }
        Button("Cancel and stay signed in") { Task { await cancelSignOut(session) } }
      }
    } else {
      Section { Button("Sign out") { Task { await signOut() } } }
    }
  }

  var dormantSection: some View {
    Section("Dormant replicas") {
      switch Result(catching: { try probe.engine.dormantReplicas() }) {
      case .success(let dormant) where dormant.isEmpty:
        Text("None")
      case .success(let dormant):
        ForEach(dormant, id: \.account) { replica in
          HStack {
            Text(verbatim: "\(replica.account): \(replica.ready) ready · \(replica.sent) sent")
            Spacer()
            Button("Discard", role: .destructive) { discardDormant(replica.account) }.buttonStyle(.borderless)
          }
        }
      case .failure(let error):
        Text(verbatim: "The dormant replicas could not be read: \(error)")
      }
    }
  }

  func signIn() async {
    lastStep = "Signing in as \(account)"
    do {
      let session = try await probe.engine.signIn(
        account: account.trimmingCharacters(in: .whitespacesAndNewlines),
        token: SessionToken(token.trimmingCharacters(in: .whitespacesAndNewlines)))
      guard !session.isComplete else {
        lastStep = "Signed in as \(session.account), no decision due"
        return
      }
      signingIn = session
    } catch {
      lastStep = "Sign-in failed: \(error)"
    }
  }

  func signOut() async {
    lastStep = "Signing out, flushing what is unsent"
    do {
      signingOut = try await probe.engine.signOut()
      lastStep = "Signing out: keep or discard what is unsent"
    } catch {
      lastStep = "Sign-out failed: \(error)"
    }
  }

  func finishSignOut(_ session: SignOutSession, _ choice: SignOutChoice) async {
    do {
      let finished = try await session.finish(choice)
      signingOut = nil
      lastStep = "Signed out, \(choice.rawValue): \(finished.ready) ready and \(finished.sent) sent"
    } catch {
      if (error as? EngineError) == .signOutEnded { signingOut = nil }
      lastStep = "Sign-out \(choice.rawValue) failed: \(error)"
    }
  }

  func cancelSignOut(_ session: SignOutSession) async {
    await session.cancel()
    signingOut = nil
    lastStep = "Sign-out cancelled, still signed in"
  }

  func discardDormant(_ account: String) {
    do {
      lastStep = try probe.engine.discardDormant(account: account)
        ? "Discarded what \(account) left unsent" : "\(account) left nothing to discard"
    } catch {
      lastStep = "Discard failed: \(error)"
    }
  }
}

// The signed-out decisions due at a sign-in: each product's work made signed out, added to the account or discarded.
private struct DecisionsSheet: View {
  let session: SignInSession
  let ended: (String) -> Void
  @State private var answers: [String: LineageAnswer] = [:]
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      Form {
        ForEach(session.decisions, id: \.product) { decision in
          Section(decision.product) {
            ForEach(decision.counts.sorted { $0.key < $1.key }, id: \.key) { type, count in
              LabeledContent(type, value: "\(count) made signed out")
            }
            LabeledContent("Answer", value: answers[decision.product]?.rawValue ?? "none yet")
            Button("Add it to \(session.account)") { answers[decision.product] = .add }
            Button("Discard it", role: .destructive) { answers[decision.product] = .discard }
          }
        }
        Section {
          Button("Complete") { Task { await complete() } }.disabled(answers.count < session.decisions.count)
          if let failure { Text(verbatim: failure) }
        }
      }
      .navigationTitle("Signing in")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            session.cancel()
            ended("Sign-in cancelled, still pending")
          }
        }
      }
    }
    .interactiveDismissDisabled()
  }

  func complete() async {
    do {
      try await session.complete(answers)
      ended("Signed in as \(session.account): \(answers.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value.rawValue)" }.joined(separator: ", "))")
    } catch {
      failure = "Complete failed: \(error)"
    }
  }
}
