import Foundation
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine

// The requests the room makes of the backend (Roadmap on iOS §3, INV-1), all of them sharing and named as the backend's HTTP
// surface names them, each with the account's token where the phone is signed in: the owner's progress a cover shows
// (`GET /v1/trees/{id}/progress`) and Fork (`POST /v1/trees/{id}/fork`). Every other read and change of a roadmap goes
// through the sync engine.
protocol RoadmapSharing {
  // The owner's marks on a roadmap someone else owns, as the server shows them to a reader.
  func progress(of tree: String) async throws(SharingFailure) -> [RoadmapTree.Mark]
  // A copy of the roadmap in the person's own list, which arrives by sync: the copy's id. `request` names the fork, so the
  // same fork asked again, after an answer that was lost, answers the same copy.
  func fork(_ tree: String, request: String) async throws(SharingFailure) -> String
}

// Why a sharing request came to nothing: no connection; no account, which a fork needs; the server's refusal, a roadmap
// the person may not read or a subtree's id; or a failure, an answer the room cannot read among them.
enum SharingFailure: Error, Equatable {
  case offline, signedOut, refused, failed
}

// The requests over HTTP to the site the app syncs with. Each failure is told as an `api_request_failed` under its
// operation, `roadmap_progress` or `roadmap_fork`, and reported where nobody expects it: neither no connection nor a status
// the server answers on purpose.
final class SharingRequests: RoadmapSharing {
  let baseURL: URL?
  // The signed-in account's token; none signed out, or while the session waits to be renewed.
  let credential: () throws -> SessionToken?
  let online: () -> Bool
  let telemetry: any Telemetry
  let session: URLSession

  init(baseURL: URL?, credential: @escaping () throws -> SessionToken?, online: @escaping () -> Bool, telemetry: any Telemetry,
       session: URLSession = NativeAuth.nativeSession()) {
    self.baseURL = baseURL; self.credential = credential; self.online = online; self.telemetry = telemetry; self.session = session
  }

  func progress(of tree: String) async throws(SharingFailure) -> [RoadmapTree.Mark] {
    let answer = try await request("v1/trees/\(tree)/progress", method: "GET", operation: "roadmap_progress", token: try? credential())
    guard let marks = try? RoadmapTree.Mark.owners(answer) else {
      telemetry.failure("roadmap_progress", kind: "decode", properties: ["method": "GET", "route": "/v1/trees"])
      throw .failed
    }
    if marks.unread > 0 { telemetry.failure("roadmap_progress", kind: "decode", properties: ["method": "GET", "route": "/v1/trees"]) }
    return marks.read
  }

  func fork(_ tree: String, request id: String) async throws(SharingFailure) -> String {
    guard let token = try? credential() else { throw .signedOut }
    let answer = try await request("v1/trees/\(tree)/fork", method: "POST", operation: "roadmap_fork", token: token, body: ["requestId": id])
    guard case .string(let copy)? = (try? JSON(parsing: Array(answer)))?["data"]?["id"] else {
      telemetry.failure("roadmap_fork", kind: "decode", properties: ["method": "POST", "route": "/v1/trees"])
      throw .failed
    }
    return copy
  }

  // One request and its answer's body; a status other than success is the server's refusal where it answers it on purpose.
  func request(_ path: String, method: String, operation: String, token: SessionToken?, body: [String: String]? = nil) async throws(SharingFailure) -> Data {
    let started = ContinuousClock.now
    var kind = "offline"
    var status: Int?
    do {
      guard let baseURL, online() else { throw URLError(.notConnectedToInternet) }
      var request = URLRequest(url: baseURL.appending(path: path))
      request.httpMethod = method
      request.httpShouldHandleCookies = false
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      if let token { request.setValue("Bearer " + token.value, forHTTPHeaderField: "Authorization") }
      if let body {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
      }
      kind = "transport"
      let (data, response) = try await NativeAuth.data(for: request, session: session)
      guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      status = response.statusCode
      guard (200..<300).contains(response.statusCode) else {
        kind = "http"
        throw URLError(.badServerResponse)
      }
      return data
    } catch {
      if let failure = error as? URLError {
        if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains(failure.code) { kind = "offline" }
        if failure.code == .timedOut { kind = "timeout" }
      }
      let elapsed = started.duration(to: .now).components
      let ms = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
      var properties = ["method": method, "route": "/v1/trees", "operation": operation, "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties, durationMs: ms)
      if kind != "offline", !ExpectedStatuses.contains(status) { telemetry.failure(operation, kind: kind, properties: properties, durationMs: ms) }
      if kind == "offline" || kind == "timeout" { throw .offline }
      if status == 401 { throw .signedOut }
      throw ExpectedStatuses.contains(status) ? .refused : .failed
    }
  }
}

extension RoadmapTree.Mark {
  // The owner's marks as the server's progress answer gives them, `{marks: [{node, status, at, markedAt, outOfOrder?}]}`:
  // each dated as the phone's copy dates a mark, by its stamp's time where it was made and by the server's receipt; a mark
  // `complete` or not. Rows that name no step or hold no stamp are left out and counted. Throws where the answer is no
  // such object.
  static func owners(_ answer: Data) throws -> (read: [RoadmapTree.Mark], unread: Int) {
    let rows = try JSON(parsing: Array(answer)).member("marks").asArray()
    var read: [RoadmapTree.Mark] = []
    for row in rows {
      guard case .string(let node)? = row["node"], !node.isEmpty, case .string(let at)? = row["at"], let stamp = try? Stamp(at) else { continue }
      let complete: Bool = if case .string("complete")? = row["status"] { true } else { false }
      let received = (try? row["markedAt"]?.asInteger()).flatMap { $0 }.map(Instant.init(ms:))
      let outOfOrder: Bool = if case .bool(true)? = row["outOfOrder"] { true } else { false }
      read.append(RoadmapTree.Mark(node: node, status: complete ? "complete" : "none", outOfOrder: outOfOrder, recordedAt: received,
                                   deviceAt: Instant(ms: stamp.ms), stamp: stamp))
    }
    return (read, rows.count - read.count)
  }
}
