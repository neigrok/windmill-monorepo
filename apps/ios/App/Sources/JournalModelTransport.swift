#if DEBUG
import Foundation
import CryptoKit
import Synchronization
import SyncCore
import SyncEngine
import enum SyncEngine.Reply
import struct SyncModelServer.ModelServer
import struct SyncModelServer.ServerState
import struct SyncModelServer.AccountKey
import struct SyncModelServer.ComposedServerRules
import struct SyncModelServer.JournalServerRules
import struct SyncModelServer.GymServerRules
import enum SyncModelServer.Credential
import SyncSchema

nonisolated final class JournalModelTransport: SyncTransport, Sendable {
  struct State: Sendable {
    var server = ModelServer(registry: SyncSchema.registry, rules: ComposedServerRules.windmill(registry: SyncSchema.registry), state: ServerState(epoch: "journal-model-1"))
    var sessions: [String: String] = [:]
    var logoutOnline = true
    var authOnline = true
    var helloOnline = true
    var failHelloAfterApple = false
    var helloFailuresRemaining = 0
    var loseRemovalResponse = false
    var offlineAfterApple = false
    var emails: [String: String] = [:]
    var appleDoors: [String: String] = [:]
    var appleEmails: [String: String] = [:]
    var tickets: [String: Ticket] = [:]
    var codes: Set<String> = []
    var appleEmail = "apple@example.com"
    var appleSubject = "fake-apple"
    var ticketLifetime: TimeInterval = 900
    var dataAccounts: Set<String> = []
  }
  struct Ticket: Sendable {
    let subject: String
    let email: String
    let expires: Date
  }
  let state = Mutex(State())
  let boardClock: Bool
  init(boardClock: Bool = false) { self.boardClock = boardClock }
  var now: Int64 { boardClock ? BoardClock().nowMs() : SystemClock().nowMs() }
  func identity(email: String) -> AuthIdentity {
    let account = "model-" + email.lowercased()
    let token = UUID().uuidString
    state.withLock { $0.sessions[token] = account; $0.emails[email.lowercased()] = account }
    return AuthIdentity(account: account, token: SessionToken(token), name: "Sam", email: email)
  }

  func requestCode(email: String) throws {
    try state.withLock { state in
      guard state.authOnline else { throw AuthRefusal.offline }
      state.codes.insert(email.lowercased())
    }
  }

  func verifyCode(email: String, code: String, ticket: AppleTicket?) throws -> AuthIdentity {
    let address = email.lowercased()
    return try state.withLock { state in
      guard state.authOnline else { throw AuthRefusal.offline }
      let pending = try ticket.map { try liveTicket($0, state: state) }
      guard code == "482913", pending == nil || state.codes.contains(address) else { throw AuthRefusal.wrongCode }
      state.codes.remove(address)
      if let pending {
        guard let account = state.emails[address] else { throw AuthRefusal(code: "no-account", message: "No account at this email") }
        if let owner = state.appleDoors[pending.subject], owner != account { throw AuthRefusal.identityTaken }
        state.appleDoors[pending.subject] = account; state.appleEmails[pending.subject] = pending.email
        if let ticket { state.tickets[digest(ticket.secret)] = nil }
        return mint(account: account, email: address, attached: true, state: &state)
      }
      let account = state.emails[address] ?? "model-" + address
      state.emails[address] = account
      return mint(account: account, email: address, state: &state)
    }
  }

  func apple(token: SessionToken?) throws -> AppleAuthResponse {
    try state.withLock { state in
      guard state.authOnline else { throw AuthRefusal.offline }
      let subject = state.appleSubject, email = state.appleEmail
      if let token {
        guard let caller = state.sessions[token.value] else { throw AuthRefusal(code: "unauthorized", message: "Sign in again to resume backup.") }
        if let owner = state.appleDoors[subject], owner != caller {
          let hasData = state.dataAccounts.contains(owner) || state.server.state.replicas.values.contains { $0.account == owner } || state.server.state.scopes.values.contains { $0.owner == owner }
          guard !hasData else { throw AuthRefusal.identityTaken }
          state.sessions = state.sessions.filter { $0.value != owner }
          state.emails = state.emails.filter { $0.value != owner }
          let subjects = state.appleDoors.filter { $0.value == owner }.map(\.key)
          for subject in subjects { state.appleDoors[subject] = nil; state.appleEmails[subject] = nil }
          var emptied = state.server.state
          emptied.accounts[AccountKey(owner)] = nil
          state.server = ModelServer(registry: SyncSchema.registry, rules: ComposedServerRules.windmill(registry: SyncSchema.registry), state: emptied)
        }
        state.appleDoors[subject] = caller; state.appleEmails[subject] = email
        return .attached
      }
      if let account = state.appleDoors[subject] ?? state.emails[email.lowercased()] {
        state.appleDoors[subject] = account; state.appleEmails[subject] = email
        let address = state.emails.first { $0.value == account }?.key ?? email
        return .signedIn(mint(account: account, email: address, state: &state))
      }
      guard !email.isEmpty else { throw AuthRefusal(code: "unverified-email", message: "Apple didn't share a verified email. Use email instead.") }
      let secret = UUID().uuidString + UUID().uuidString
      let expiry = Date().addingTimeInterval(state.ticketLifetime)
      state.tickets[digest(secret)] = Ticket(subject: subject, email: email, expires: expiry)
      if state.failHelloAfterApple { state.helloFailuresRemaining = 1 }
      if state.offlineAfterApple { state.authOnline = false }
      return .ticket(AppleTicket(secret: secret, expiresAt: expiry))
    }
  }

  func createApple(ticket: AppleTicket) throws -> AuthIdentity {
    try state.withLock { state in
      guard state.authOnline else { throw AuthRefusal.offline }
      let pending = try liveTicket(ticket, state: state)
      guard state.appleDoors[pending.subject] == nil else { throw AuthRefusal.identityTaken }
      let account = state.emails[pending.email.lowercased()] ?? "model-" + pending.email.lowercased()
      state.emails[pending.email.lowercased()] = account
      state.appleDoors[pending.subject] = account; state.appleEmails[pending.subject] = pending.email
      state.tickets[digest(ticket.secret)] = nil
      return mint(account: account, email: pending.email, state: &state)
    }
  }

  func liveTicket(_ ticket: AppleTicket, state: State) throws -> Ticket {
    guard let pending = state.tickets[digest(ticket.secret)], pending.expires > Date() else { throw AuthRefusal.expired }
    return pending
  }

  func digest(_ secret: String) -> String { SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined() }

  func mint(account: String, email: String, attached: Bool = false, state: inout State) -> AuthIdentity {
    let token = UUID().uuidString; state.sessions[token] = account
    return AuthIdentity(account: account, token: SessionToken(token), name: "Sam", email: email, appleAttached: attached)
  }

  func signInMethods(token: SessionToken) throws -> [SignInMethod] {
    try state.withLock { state in
      guard state.authOnline else { throw AuthRefusal.offline }
      guard let account = state.sessions[token.value], let email = state.emails.first(where: { $0.value == account })?.key else {
        throw AuthRefusal(code: "unauthorized", message: "Sign in again to resume backup.")
      }
      let apple = state.appleDoors.filter { $0.value == account }.map { subject, _ in
        let email = state.appleEmails[subject] ?? ""
        return SignInMethod(kind: "apple", email: email, relay: email.hasSuffix("privaterelay.appleid.com"))
      }
      return [SignInMethod(kind: "email", email: email)] + apple
    }
  }

  func removeApple(token: SessionToken) throws {
    try state.withLock { state in
      guard state.authOnline else { throw AuthRefusal.offline }
      guard let account = state.sessions[token.value] else { throw AuthRefusal(code: "unauthorized", message: "Sign in again to resume backup.") }
      guard let subject = state.appleDoors.first(where: { $0.value == account })?.key else { throw AuthRefusal(code: "not-found", message: "Apple isn't added to this account.") }
      state.appleDoors[subject] = nil; state.appleEmails[subject] = nil
      if state.loseRemovalResponse { state.loseRemovalResponse = false; throw AuthRefusal.offline }
    }
  }
  func revoke(_ token: SessionToken) throws {
    try state.withLock { state in
      guard state.logoutOnline else { throw AppFailure(message: "Offline") }
      state.sessions[token.value] = nil
    }
  }
  func credential(_ token: SessionToken?, _ state: State) -> Credential {
    guard let token else { return .absent }
    return state.sessions[token.value].map(Credential.account) ?? .unresolved
  }
  func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    state.withLock { state in
      if token != nil && !state.helloOnline { return .unreachable }
      if token != nil && state.helloFailuresRemaining > 0 { state.helloFailuresRemaining -= 1; return .unreachable }
      let c = credential(token, state)
      let reply = state.server.hello(credential: c, at: now)
      return Reply(status: reply.status, body: reply.body)
    }
  }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    state.withLock { state in
      let c = credential(token, state)
      let reply = state.server.push(request.json, credential: c, at: now)
      return Reply(status: reply.status, body: reply.body)
    }
  }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    state.withLock { state in
      let c = credential(token, state)
      let reply = state.server.pull(request.json, credential: c, at: now)
      return Reply(status: reply.status, body: reply.body)
    }
  }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> { .unreachable }
}
#endif
