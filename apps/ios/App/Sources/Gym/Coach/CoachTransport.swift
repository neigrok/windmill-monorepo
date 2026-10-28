import Foundation
import UIKit
import ImageIO
import SyncEngine

extension GymRESTClient {
  // The account's reads the Coach room makes beside the engine: the connected tools' grants and keys.
  func coachRequest(_ path: String, method: String = "GET", body: Data? = nil, expectedAccount: String? = nil) async throws -> Data {
    if let expectedAccount {
      guard let runtime, try runtime.account() == expectedAccount else { throw CancellationError() }
    }
    guard !blocked, let runtime, let baseURL = runtime.settings.baseURL,
          let owner = try runtime.account(), !runtime.engine.status.authPaused,
          let token = runtime.tokens.token(for: owner) else { throw AppFailure(message: "Sign in to use this part of Gym.") }
    guard (path == "/v1/oauth/grants" || path == "/v1/mcp-keys"), !path.contains(".."),
          let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
          url.host == baseURL.host, url.scheme == baseURL.scheme, url.port == baseURL.port else {
      throw AppFailure(message: "Gym could not open this request.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method; request.httpBody = body
    request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    let requestGeneration = generation
    let id = UUID()
    let task = Task<(Data, URLResponse), any Error>.detached { [session] in try await NativeAuth.data(for: request, session: session) }
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
      let failure = coachFailure(error, method: method)
      telemetry.event("api_request_failed", properties: failure.properties)
      if failure.reportable { telemetry.failure("gym_rest", kind: failure.properties["failure_kind"] ?? "transport", properties: failure.properties) }
      throw error
    }
  }

  // A Coach request's failure as its event says it, and whether it is unexpected enough to report.
  nonisolated func coachFailure(_ error: any Error, method: String) -> (properties: [String: String], reportable: Bool) {
    let status = (error as? GymRESTFailure)?.status
    let offline = [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains((error as? URLError)?.code)
    let kind = offline ? "offline" : (error as? URLError)?.code == .timedOut ? "timeout" : status != nil ? "http" : error is DecodingError ? "decode" : "transport"
    var properties = ["operation": "gym_rest", "route": "/v1/gym", "method": method, "failure_kind": kind]
    if let status { properties["status"] = String(status) }
    return (properties, !offline && !ExpectedStatuses.contains(status))
  }
}

nonisolated enum CoachPhotoPreparation {
  static let maxBytes = 5 * 1024 * 1024
  static let maxEdge = 4096
  static func prepare(_ data: Data, maxBytes: Int = maxBytes) throws -> (CoachAttachment, Data) {
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
      current = scaled(current, by: 0.8, png: png)
    }
  }

  // Coach §9.3: the model copy of a prepared photo, a JPEG within the model's edge and byte bounds, kept beside the original.
  static func modelCopy(of original: Data, attachment: CoachAttachment, maxEdge: Int = CoachTurnBounds.modelPictureEdge,
                        maxBytes: Int = CoachTurnBounds.modelPictureBytes) throws -> CoachPictureRow {
    guard var current = UIImage(data: original) else { throw AppFailure(message: "That photo is unavailable. Remove it and choose it again.") }
    let longest = max(current.size.width, current.size.height)
    if longest > CGFloat(maxEdge) { current = scaled(current, by: CGFloat(maxEdge) / longest, png: false) }
    var quality: CGFloat = 0.85
    while true {
      guard let encoded = current.jpegData(compressionQuality: quality) else { throw AppFailure(message: "That photo is unavailable. Remove it and choose it again.") }
      if encoded.count <= maxBytes {
        return CoachPictureRow(id: attachment.id, mediaType: attachment.mediaType, width: attachment.width, height: attachment.height,
                               original: original, model: encoded)
      }
      if quality > 0.5 { quality -= 0.15 } else { current = scaled(current, by: 0.8, png: false) }
    }
  }

  // A JPEG has no alpha, so a photo is flattened onto white before encoding; a PNG keeps its transparency.
  static func scaled(_ image: UIImage, by factor: CGFloat, png: Bool) -> UIImage {
    let size = CGSize(width: max(1, floor(image.size.width * factor)), height: max(1, floor(image.size.height * factor)))
    let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = !png
    return UIGraphicsImageRenderer(size: size, format: format).image { context in
      if !png { UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size)) }
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }
}
