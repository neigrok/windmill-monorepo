import Foundation

public struct WindmillApi: Sendable {
    public let baseURL: URL
    private let credential: @Sendable () -> String?
    private let session: URLSession

    public init(baseURL: URL, credential: @escaping @Sendable () -> String?,
                session: URLSession = WindmillApi.cookieless) {
        self.baseURL = baseURL
        self.credential = credential
        self.session = session
    }

    // The server resolves a session cookie before the bearer, so this session stores and sends none.
    public static let cookieless: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        return URLSession(configuration: configuration)
    }()

    public static func forgetCookieJar(for baseURL: URL) {
        let jar = HTTPCookieStorage.shared
        for cookie in jar.cookies(for: baseURL) ?? [] { jar.deleteCookie(cookie) }
    }

    public static func resolvedBaseURL(bundle: Bundle = .main) -> URL {
        if let configured = bundle.object(forInfoDictionaryKey: "WMApiBaseURL") as? String,
           !configured.isEmpty,
           let url = URL(string: configured) {
            return url
        }
        return URL(string: "https://windmill.works")!
    }

    public func get<Reply: Decodable>(_ path: String, as reply: Reply.Type) async throws -> Reply {
        try decode(reply, from: try await perform(request("GET", path)).body)
    }

    public func send<Reply: Decodable>(
        _ method: String, _ path: String, body: (any Encodable)? = nil, as reply: Reply.Type
    ) async throws -> Reply {
        try decode(reply, from: try await perform(request(method, path, json: body)).body)
    }

    @discardableResult
    public func send(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws -> Data {
        try await perform(request(method, path, json: body)).body
    }

    public func data(_ method: String, _ path: String, body: Data? = nil,
                     contentType: String? = nil, accept: String = "application/octet-stream",
                     progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Data {
        var wire = try request(method, path)
        wire.setValue(accept, forHTTPHeaderField: "Accept")
        wire.setValue(contentType, forHTTPHeaderField: "Content-Type")
        guard let body else { return try await perform(wire).body }
        let received: (Data, URLResponse)
        do {
            received = try await session.upload(for: wire, from: body,
                                               delegate: UploadProgress(report: progress))
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw WindmillApiError.offline
        }
        guard let response = received.1 as? HTTPURLResponse else { throw WindmillApiError.malformed }
        guard (200..<300).contains(response.statusCode) else {
            throw WindmillApiError.refused(response.statusCode, Refusal(received.0))
        }
        return received.0
    }

    public func lines(_ method: String, _ path: String, body: any Encodable,
                      accept: String) throws -> AsyncThrowingStream<String, Error> {
        var wire = try request(method, path, json: body)
        wire.setValue(accept, forHTTPHeaderField: "Accept")
        wire.timeoutInterval = 120
        let prepared = wire
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, received) = try await session.bytes(for: prepared)
                    defer { bytes.task.cancel() }
                    guard let response = received as? HTTPURLResponse else { throw WindmillApiError.malformed }
                    guard (200..<300).contains(response.statusCode) else {
                        var body = Data()
                        for try await byte in bytes {
                            body.append(byte)
                            if body.count >= 65_536 { break }
                        }
                        throw WindmillApiError.refused(response.statusCode, Refusal(body))
                    }
                    guard response.mimeType == accept else { throw WindmillApiError.malformed }
                    var line = Data()
                    var carriageReturn = false
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if carriageReturn {
                            carriageReturn = false
                            if byte == 10 { continue }
                        }
                        if byte == 10 || byte == 13 {
                            guard let text = String(data: line, encoding: .utf8) else { throw WindmillApiError.malformed }
                            continuation.yield(text)
                            line.removeAll(keepingCapacity: true)
                            carriageReturn = byte == 13
                        } else {
                            line.append(byte)
                            guard line.count <= 1_048_576 else { throw WindmillApiError.malformed }
                        }
                    }
                    if !line.isEmpty {
                        guard let text = String(data: line, encoding: .utf8) else { throw WindmillApiError.malformed }
                        continuation.yield(text)
                    }
                    continuation.finish()
                } catch {
                    if Task.isCancelled { continuation.finish(throwing: CancellationError()) }
                    else if let failure = error as? WindmillApiError { continuation.finish(throwing: failure) }
                    else { continuation.finish(throwing: WindmillApiError.offline) }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // /v1/auth/verify mints the session only as a Set-Cookie header.
    public func sendCapturingSession<Reply: Decodable>(
        _ method: String, _ path: String, body: (any Encodable)? = nil, as reply: Reply.Type
    ) async throws -> (reply: Reply, session: String?) {
        let answer = try await perform(request(method, path, json: body))
        return (try decode(reply, from: answer.body), Self.sessionCookie(in: answer.response, for: baseURL))
    }

    // Resolve as a whole relative reference: `appendingPathComponent` percent-encodes `?` and `&`
    // into one segment, which silently 404s every endpoint carrying a query.
    static func url(for path: String, base: URL) -> URL? {
        URL(string: path, relativeTo: base)
    }

    static func sessionCookie(in response: HTTPURLResponse, for url: URL) -> String? {
        let headers = response.allHeaderFields as? [String: String] ?? [:]
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
            .first { $0.name == "wm_session" }?
            .value
    }

    private func request(_ method: String, _ path: String, json body: (any Encodable)? = nil) throws -> URLRequest {
        // Resolve relatively, never appendingPathComponent: it percent-encodes `?` and `&` into the path.
        guard let url = URL(string: path, relativeTo: baseURL) else { throw WindmillApiError.malformed }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let secret = credential() {
            request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        return request
    }

    private func perform(_ request: URLRequest) async throws -> (body: Data, response: HTTPURLResponse) {
        let received: (Data, URLResponse)
        do {
            received = try await session.data(for: request)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw WindmillApiError.offline
        }
        guard let response = received.1 as? HTTPURLResponse else { throw WindmillApiError.malformed }
        guard (200..<300).contains(response.statusCode) else {
            throw WindmillApiError.refused(response.statusCode, Refusal(received.0))
        }
        return (received.0, response)
    }

    private func decode<Reply: Decodable>(_ reply: Reply.Type, from data: Data) throws -> Reply {
        if Reply.self == Empty.self { return Empty() as! Reply }
        do {
            return try JSONDecoder().decode(reply, from: data)
        } catch {
            throw WindmillApiError.malformed
        }
    }

    public struct Empty: Codable { public init() {} }
}

public struct Refusal: Equatable, Sendable {
    public let message: String?
    public let detail: String?
    public let code: String?

    init(_ data: Data) {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        message = json["error"] as? String
        detail = json["detail"] as? String
        code = json["code"] as? String
    }
}

public enum WindmillApiError: Error, Equatable {
    case offline
    case refused(Int, Refusal)
    case malformed

    public var isUnauthorized: Bool {
        if case .refused(401, _) = self { return true }
        return false
    }

    public var line: String {
        switch self {
        case .offline: return "Can’t reach windmill.works"
        case .refused(_, let refusal): return refusal.message ?? "That didn’t go through"
        case .malformed: return "That didn’t go through"
        }
    }
}

private struct AnyEncodable: Encodable {
    let wrapped: any Encodable
    init(_ wrapped: any Encodable) { self.wrapped = wrapped }
    func encode(to encoder: Encoder) throws { try wrapped.encode(to: encoder) }
}

private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let report: @Sendable (Double) -> Void

    init(report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}
