import Foundation

// The one place the native app talks to the backend it was built against — the mirror of
// web/src/shell/apiBase.js and the per-product API clients that sit on it. On the web the session
// is an HttpOnly cookie and the browser carries it; a native app holds the same secret in the
// Keychain and sends it as `Authorization: Bearer`, which the backend has accepted since AUTH.md.
//
// Where the backend lives is read from the bundle's `WMApiBaseURL` (the native VITE_API_BASE_URL),
// so a debug build points at the local windmill_server without a code change.

public struct WindmillApi: Sendable {
    public let baseURL: URL
    private let credential: @Sendable () -> String?
    private let session: URLSession

    public init(baseURL: URL, credential: @escaping @Sendable () -> String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.credential = credential
        self.session = session
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

    // The one call that reads a header instead of a body: POST /v1/auth/verify answers with the
    // user and mints the session as a Set-Cookie, and only as a cookie — deliberately, because
    // putting a 90-day secret in a body would hand it to any XSS on the web. Native is not a
    // browser, so it lifts the same value out of the header and puts it in the Keychain.
    public func sendCapturingSession<Reply: Decodable>(
        _ method: String, _ path: String, body: (any Encodable)? = nil, as reply: Reply.Type
    ) async throws -> (reply: Reply, session: String?) {
        let answer = try await perform(request(method, path, json: body))
        return (try decode(reply, from: answer.body), Self.sessionCookie(in: answer.response, for: baseURL))
    }

    // Exposed for the test that pins the rule above. A URL is the one part of a request that no
    // unit test could otherwise see, because everything else about a call is mocked at the seam.
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
        // Resolved as a RELATIVE URL, never appendingPathComponent: that method treats the whole
        // string as one path segment and percent-encodes `?` and `&` into it, so every endpoint
        // carrying a query — the window read and the delta feed — silently became a 404 path.
        // It cost nothing at the call site and broke half the journal's reads.
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
            // No reachable host. Callers that own writing turn this into "offline · saved here"
            // rather than an error — a device with no signal has not lost anything.
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

// What the backend said when it refused. The house copy is written on the server (AUTH.md: "copy is
// verbatim from auth.md §7"), so the app shows these words rather than inventing its own — one
// sentence lives in one place and the two surfaces cannot drift apart in tone.
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

    // What to show a person. The server's own sentence when it sent one; otherwise the app's, and
    // never a status code — a number is not a thing anyone can act on.
    public var line: String {
        switch self {
        case .offline: return "Can't reach windmill.works"
        case .refused(_, let refusal): return refusal.message ?? "That didn't go through"
        case .malformed: return "That didn't go through"
        }
    }
}

// JSONEncoder cannot encode an existential; this is the one-line box that lets a caller pass any
// Encodable body without every request type needing a generic parameter it never reads.
private struct AnyEncodable: Encodable {
    let wrapped: any Encodable
    init(_ wrapped: any Encodable) { self.wrapped = wrapped }
    func encode(to encoder: Encoder) throws { try wrapped.encode(to: encoder) }
}
