import Foundation
import UIKit
import ImageIO
import SyncEngine

extension GymRESTClient {
  func coachRequest(_ path: String, method: String = "GET", body: Data? = nil,
                    mediaType: String? = nil, expectedAccount: String? = nil, snapshot: (@MainActor (CoachSnapshot) throws -> Void)? = nil) async throws -> Data {
    if let expectedAccount {
      guard let runtime, try runtime.account() == expectedAccount else { throw CancellationError() }
    }
    if mediaType == nil, snapshot == nil, path.hasPrefix("/v1/gym/") {
      return try await request(path, method: method, body: body)
    }
    guard !blocked, let runtime, let baseURL = runtime.settings.baseURL,
          let owner = try runtime.account(), !runtime.engine.status.authPaused,
          let token = runtime.tokens.token(for: owner) else { throw AppFailure(message: "Sign in to use this part of Gym.") }
    guard (path.hasPrefix("/v1/gym/") || path == "/v1/oauth/grants" || path == "/v1/mcp-keys"), !path.contains(".."),
          let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
          url.host == baseURL.host, url.scheme == baseURL.scheme, url.port == baseURL.port else {
      throw AppFailure(message: "Gym could not open this request.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method; request.httpBody = body
    request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
    if body != nil { request.setValue(mediaType ?? "application/json", forHTTPHeaderField: "Content-Type") }
    if snapshot != nil { request.setValue("text/event-stream", forHTTPHeaderField: "Accept") }
    let requestGeneration = generation
    let id = UUID()
    let streamConfiguration = session.configuration
    streamConfiguration.timeoutIntervalForResource = 120
    let transport = snapshot == nil ? session : URLSession(configuration: streamConfiguration)
    defer { if snapshot != nil { transport.invalidateAndCancel() } }
    let wireRequest = request
    let task = Task<(Data, URLResponse), any Error>.detached { [self] in
      if let snapshot {
        let (bytes, response) = try await transport.bytes(for: wireRequest)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if !(200..<300).contains(http.statusCode) || !(http.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("text/event-stream") {
          var data = Data()
          for try await byte in bytes {
            try Task.checkCancellation()
            data.append(byte)
            if data.count > 1_048_576 { throw URLError(.dataLengthExceedsMaximum) }
          }
          return (data, response)
        }
        var parser = CoachSSE(), terminal = false, line = Data()
        for try await byte in bytes {
          try Task.checkCancellation()
          guard byte == 10 else {
            line.append(byte)
            if line.count > 1_048_576 { throw URLError(.dataLengthExceedsMaximum) }
            continue
          }
          if line.last == 13 { line.removeLast() }
          guard let text = String(data: line, encoding: .utf8) else { throw URLError(.cannotDecodeContentData) }
          line.removeAll(keepingCapacity: true)
          if let (event, data) = parser.consume(text) {
            if event == "error" {
              try await MainActor.run {
                try Task.checkCancellation()
                guard generation == requestGeneration, !blocked,
                      try runtime.account() == owner, runtime.tokens.token(for: owner) == token else { throw CancellationError() }
              }
              let object = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
              throw GymRESTFailure(status: object["status"] as? Int ?? 500, body: data,
                                   message: object["error"] as? String ?? CoachCopy.noAnswer)
            }
            if event == "snapshot" {
              let value = try JSONDecoder().decode(CoachSnapshot.self, from: data)
              try await MainActor.run {
                try Task.checkCancellation()
                guard generation == requestGeneration, !blocked,
                      try runtime.account() == owner, runtime.tokens.token(for: owner) == token else { throw CancellationError() }
                try snapshot(value)
              }
              terminal = value.generation.terminal
              if terminal { break }
            }
          }
        }
        guard terminal else { throw URLError(.networkConnectionLost) }
        return (Data(), response)
      }
      return try await NativeAuth.data(for: wireRequest, session: transport)
    }
    tasks[id] = task
    defer { tasks[id] = nil }
    do {
      let (data, response) = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
      try Task.checkCancellation()
      guard generation == requestGeneration, !blocked, try runtime.account() == owner,
            runtime.tokens.token(for: owner) == token else { throw CancellationError() }
      guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      guard (200..<300).contains(http.statusCode) else {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let detail = object["detail"] as? String ?? ""
        throw GymRESTFailure(status: http.statusCode, body: data,
          message: (object["error"] as? String ?? CoachCopy.noAnswer) + (detail.isEmpty ? "" : ". " + detail))
      }
      return data
    } catch {
      if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
      let status = (error as? GymRESTFailure)?.status
      let offline = [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains((error as? URLError)?.code)
      let kind = offline ? "offline" : (error as? URLError)?.code == .timedOut ? "timeout" : status != nil ? "http" : error is DecodingError ? "decode" : "transport"
      var properties = ["operation": "gym_rest", "route": "/v1/gym", "method": method, "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties)
      let body = (error as? GymRESTFailure).flatMap { (try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any] }
      let unavailable = status == 503 && body?["code"] as? String == "ask-not-configured"
      if !offline, !unavailable, status == nil || ![400, 401, 403, 404, 409, 410, 422, 429].contains(status!) {
        telemetry.failure("gym_rest", kind: kind, properties: properties)
      }
      throw error
    }
  }
}

nonisolated enum CoachPhotoPreparation {
  static let maxBytes = 5 * 1024 * 1024
  static let maxEdge = 4096
  static func prepare(_ data: Data) throws -> (CoachAttachment, Data) {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw AppFailure(message: "Choose a supported photo.") }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxEdge,
      kCGImageSourceShouldCacheImmediately: true]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      throw AppFailure(message: "Choose a supported photo.")
    }
    let png = (CGImageSourceGetType(source) as String?) == "public.png"
    var current = UIImage(cgImage: image)
    while true {
      guard let encoded = png ? current.pngData() : current.jpegData(compressionQuality: 0.88) else {
        throw AppFailure(message: "Choose a supported photo.")
      }
      if encoded.count <= maxBytes {
        let attachment = CoachAttachment(id: UUID().uuidString, mediaType: png ? "image/png" : "image/jpeg",
          width: Int(current.size.width), height: Int(current.size.height), bytes: encoded.count)
        return (attachment, encoded)
      }
      let size = CGSize(width: max(1, floor(current.size.width * 0.8)), height: max(1, floor(current.size.height * 0.8)))
      let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = !png
      current = UIGraphicsImageRenderer(size: size, format: format).image { context in
        if !png { UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size)) }
        current.draw(in: CGRect(origin: .zero, size: size))
      }
    }
  }
}
