import Foundation
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine

// The requests the room makes of the backend (Roadmap on iOS §3, INV-1), all of them sharing and named as the backend's HTTP
// surface names them, each with the account's token where the phone is signed in: the owner's progress a cover shows
// (`GET /v1/trees/{id}/progress`), Fork (`POST /v1/trees/{id}/fork`) and the public gallery (`GET /v1/gallery`). Every
// other read and change of a roadmap goes through the sync engine.
protocol RoadmapSharing {
  // The owner's progress on a roadmap someone else owns, as the server shows it to a reader.
  func progress(of tree: String) async throws(SharingFailure) -> OwnersProgress
  // A copy of the roadmap in the person's own list, which arrives by sync: the copy's id. `request` names the fork, so the
  // same fork asked again, after an answer that was lost, answers the same copy.
  func fork(_ tree: String, request: String) async throws(SharingFailure) -> String
  // One page of the public gallery in the server's order, from its start or after the page before it.
  func gallery(after cursor: String?) async throws(SharingFailure) -> GalleryPage
}

// Why a sharing request came to nothing: no connection; no session the phone can send as, or one the server no longer
// takes (401), which a fork needs; the server's refusal, a roadmap the person may not read or a subtree's id; the server
// busy for a moment (503), to be tried again; the request given up by whoever asked, as a cover that closed; or a failure,
// an answer the room cannot read among them.
enum SharingFailure: Error, Equatable {
  case offline, signedOut, refused, busy, cancelled, failed
}

// The requests over HTTP to the site the app syncs with. Each failure is told as an `api_request_failed` under its
// operation, `roadmap_progress`, `roadmap_fork` or `roadmap_gallery`, and reported where nobody expects it: neither no
// connection, a status the server answers on purpose, nor the server busy. A request given up is no failure and tells
// nothing.
final class SharingRequests: RoadmapSharing {
  // How many rows a page of the gallery asks for, as the web asks; the server holds a page to 60.
  static let galleryPage = 24

  let baseURL: URL?
  // The signed-in account's token; none signed out, or while the session waits to be renewed.
  let credential: () -> SessionToken?
  let online: () -> Bool
  let telemetry: any Telemetry
  let session: URLSession

  init(baseURL: URL?, credential: @escaping () -> SessionToken?, online: @escaping () -> Bool, telemetry: any Telemetry,
       session: URLSession = NativeAuth.nativeSession()) {
    self.baseURL = baseURL; self.credential = credential; self.online = online; self.telemetry = telemetry; self.session = session
  }

  func progress(of tree: String) async throws(SharingFailure) -> OwnersProgress {
    let answer = try await request("v1/trees/\(tree)/progress", method: "GET", operation: "roadmap_progress", route: "/v1/trees", token: credential())
    guard let progress = try? OwnersProgress(answer: answer) else {
      telemetry.failure("roadmap_progress", kind: "decode", properties: ["method": "GET", "route": "/v1/trees"])
      throw .failed
    }
    if progress.unread > 0 { telemetry.failure("roadmap_progress", kind: "decode", properties: ["method": "GET", "route": "/v1/trees"]) }
    return progress
  }

  func fork(_ tree: String, request id: String) async throws(SharingFailure) -> String {
    guard let token = credential() else { throw .signedOut }
    let answer = try await request("v1/trees/\(tree)/fork", method: "POST", operation: "roadmap_fork", route: "/v1/trees", token: token, body: ["requestId": id])
    guard case .string(let copy)? = (try? JSON(parsing: Array(answer)))?["data"]?["id"] else {
      telemetry.failure("roadmap_fork", kind: "decode", properties: ["method": "POST", "route": "/v1/trees"])
      throw .failed
    }
    return copy
  }

  // The gallery asks no account; a session adds whether each row is the person's own. A session the server no longer
  // takes is asked again with none, so the gallery is read whatever the phone's session.
  func gallery(after cursor: String?) async throws(SharingFailure) -> GalleryPage {
    let query = [URLQueryItem(name: "limit", value: String(Self.galleryPage))] + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    let token = credential()
    let answer: Data
    do throws(SharingFailure) {
      answer = try await request("v1/gallery", query: query, method: "GET", operation: "roadmap_gallery", route: "/v1/gallery", token: token)
    } catch .signedOut where token != nil {
      answer = try await request("v1/gallery", query: query, method: "GET", operation: "roadmap_gallery", route: "/v1/gallery", token: nil)
    }
    guard let page = try? GalleryPage(answer: answer) else {
      telemetry.failure("roadmap_gallery", kind: "decode", properties: ["method": "GET", "route": "/v1/gallery"])
      throw .failed
    }
    if page.unread > 0 { telemetry.failure("roadmap_gallery", kind: "decode", properties: ["method": "GET", "route": "/v1/gallery"]) }
    return page
  }

  // One request and its answer's body; a status other than success is the server's refusal where it answers it on purpose.
  func request(_ path: String, query: [URLQueryItem] = [], method: String, operation: String, route: String, token: SessionToken?,
               body: [String: String]? = nil) async throws(SharingFailure) -> Data {
    let started = ContinuousClock.now
    var kind = "offline"
    var status: Int?
    do {
      guard let baseURL, online() else { throw URLError(.notConnectedToInternet) }
      var request = URLRequest(url: baseURL.appending(path: path).appending(queryItems: query))
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
      if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled { throw .cancelled }
      if let failure = error as? URLError {
        if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains(failure.code) { kind = "offline" }
        if failure.code == .timedOut { kind = "timeout" }
      }
      let elapsed = started.duration(to: .now).components
      let ms = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
      var properties = ["method": method, "route": route, "operation": operation, "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties, durationMs: ms)
      if kind != "offline", status != 503, !ExpectedStatuses.contains(status) { telemetry.failure(operation, kind: kind, properties: properties, durationMs: ms) }
      if kind == "offline" || kind == "timeout" { throw .offline }
      if status == 401 { throw .signedOut }
      if status == 503 { throw .busy }
      throw ExpectedStatuses.contains(status) ? .refused : .failed
    }
  }
}

// The owner's progress on a roadmap someone else owns, as the server shows it to a reader: their marks, which the phone
// holds none of, and what each subtree the roadmap's steps own has come to, which the phone holds no copy of.
struct OwnersProgress {
  let marks: [RoadmapTree.Mark]
  let subtrees: [RoadmapAccount.Told]
  // The rows of the server's answer the room could not read, left out.
  let unread: Int

  init(marks: [RoadmapTree.Mark], subtrees: [RoadmapAccount.Told] = []) {
    self.marks = marks
    self.subtrees = subtrees
    unread = 0
  }

  // The server's progress answer, `{marks: [{node, status, at, markedAt, outOfOrder?}], subtrees?: [{node, tree, done,
  // total}]}`: each mark dated as the phone's copy dates a mark, by its stamp's time where it was made and by the server's
  // receipt, `complete` or not; and each subtree by its id with how many of its steps are done of how many. A mark row that
  // names no step or holds no stamp, and a subtree row that names no roadmap or holds no counts, are left out and counted.
  // Throws where the answer is no such object.
  init(answer: Data) throws {
    let body = try JSON(parsing: Array(answer))
    let rows = try body.member("marks").asArray()
    var marks: [RoadmapTree.Mark] = []
    for row in rows {
      guard case .string(let node)? = row["node"], !node.isEmpty, case .string(let at)? = row["at"], let stamp = try? Stamp(at) else { continue }
      let complete: Bool = if case .string("complete")? = row["status"] { true } else { false }
      let received = (try? row["markedAt"]?.asInteger()).flatMap { $0 }.map(Instant.init(ms:))
      let outOfOrder: Bool = if case .bool(true)? = row["outOfOrder"] { true } else { false }
      marks.append(RoadmapTree.Mark(node: node, status: complete ? "complete" : "none", outOfOrder: outOfOrder, recordedAt: received,
                                    deviceAt: Instant(ms: stamp.ms), stamp: stamp))
    }
    let counted = try body["subtrees"]?.asArray() ?? []
    let subtrees = counted.compactMap { (row: JSON) -> RoadmapAccount.Told? in
      guard case .string(let tree)? = row["tree"], !tree.isEmpty, let done = try? row["done"]?.asInteger(), let total = try? row["total"]?.asInteger(),
            done >= 0, done <= total else { return nil }
      return RoadmapAccount.Told(tree: tree, counts: Counts(done: Int(done), total: Int(total)))
    }
    self.marks = marks
    self.subtrees = subtrees
    unread = rows.count - marks.count + counted.count - subtrees.count
  }
}

// One page of the public gallery as the server ranks it: each row's roadmap, its title and how many steps it holds, which is
// all a row shows (R-8), and whether it is the person's own; and where the next page starts, none after the last.
struct GalleryPage: Equatable {
  struct Row: Equatable, Identifiable {
    let id: String
    let title: String
    let steps: Int
    let mine: Bool
  }

  let rows: [Row]
  let next: String?
  // The rows of the server's answer the room could not read, left out.
  let unread: Int

  init(rows: [Row], next: String? = nil) {
    self.rows = rows
    self.next = next
    unread = 0
  }

  // The server's gallery answer, `{entries: [{id, title, total, mine, …}], count, nextCursor?}`. A row that names no roadmap
  // the phone can address or holds no count is left out and counted; a title it lacks reads empty. Throws where the answer is
  // no such object.
  init(answer: Data) throws {
    let body = try JSON(parsing: Array(answer))
    let entries = try body.member("entries").asArray()
    rows = entries.compactMap { (entry: JSON) -> Row? in
      guard case .string(let id)? = entry["id"], RoadmapAddress(tree: id) != nil, let total = try? entry["total"]?.asInteger(), total >= 0 else { return nil }
      let title: String = if case .string(let title)? = entry["title"] { title } else { "" }
      let mine: Bool = if case .bool(true)? = entry["mine"] { true } else { false }
      return Row(id: id, title: title, steps: Int(total), mine: mine)
    }
    next = if case .string(let cursor)? = body["nextCursor"], !cursor.isEmpty { cursor } else { nil }
    unread = entries.count - rows.count
  }
}
