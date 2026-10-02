#if DEBUG
import Foundation
import Synchronization
import SyncCore
import SyncEngine
import enum SyncEngine.Reply
import struct SyncModelServer.ModelServer
import struct SyncModelServer.ServerState
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
  }
  let state = Mutex(State())
  let boardClock: Bool
  init(boardClock: Bool = false) { self.boardClock = boardClock }
  var now: Int64 { boardClock ? BoardClock().nowMs() : SystemClock().nowMs() }
  func identity(email: String) -> AuthIdentity {
    let account = "model-" + email.lowercased()
    let token = UUID().uuidString
    state.withLock { $0.sessions[token] = account }
    return AuthIdentity(account: account, token: SessionToken(token), name: "Sam")
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
