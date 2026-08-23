import Foundation

// The session secret is the app's only credential and lives in the Keychain, never UserDefaults.

public enum AuthStatus: Equatable {
    case unknown            // /v1/me has not been asked yet
    case signedOut
    case signedIn(User)
    // A held secret whose user this launch has not confirmed with the backend.
    case unverified(User)

    public var user: User? {
        switch self {
        case .signedIn(let user), .unverified(let user): return user
        case .unknown, .signedOut: return nil
        }
    }

    // Signed out counts as verified.
    public var verified: Bool {
        if case .unverified = self { return false }
        return true
    }
}

public enum LinkArrival: Equatable {
    case signedIn
    case refused(String)
}

@MainActor
public final class AuthStore: ObservableObject {
    @Published public private(set) var status: AuthStatus = .unknown
    @Published public private(set) var linkSentTo: String?
    @Published public private(set) var arrival: LinkArrival?

    public let api: WindmillApi
    private let sessions: any SessionStore

    public nonisolated init(baseURL: URL = WindmillApi.resolvedBaseURL(),
                            sessions: any SessionStore = KeychainSessions(),
                            urlSession: URLSession = WindmillApi.cookieless) {
        self.sessions = sessions
        self.api = WindmillApi(baseURL: baseURL, credential: { [sessions] in sessions.read() },
                               session: urlSession)
        WindmillApi.forgetCookieJar(for: baseURL)
    }

    // Only a 401 clears the Keychain; any other failure keeps the secret and marks the seat unverified.
    public func restore() async {
        guard sessions.read() != nil else {
            status = .signedOut
            return
        }
        do {
            let user = try await api.get("/v1/me", as: UserReply.self).user
            sessions.write(user: user)
            status = .signedIn(user)
        } catch let refusal as WindmillApiError where refusal.isUnauthorized {
            sessions.clear()
            status = .signedOut
        } catch {
            guard let known = sessions.readUser() else {
                status = .signedOut
                return
            }
            status = .unverified(known)
        }
    }

    // `door: "app"` asks the mail to carry the six-digit code instead of the link.
    public func requestLink(to email: String) async throws {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        try await api.send("POST", "/v1/auth/magic-link", body: ["email": address, "door": "app"])
        linkSentTo = address
    }

    // User in the body, session only in Set-Cookie.
    public func completeCode(email: String, code: String) async throws {
        let answer = try await api.sendCapturingSession("POST", "/v1/auth/verify-code",
                                                        body: ["email": email, "code": code],
                                                        as: UserReply.self)
        try adopt(session: answer.session, user: answer.reply.user)
    }

    // Accepts the whole link URL or a bare token.
    public func completeLink(_ pastedOrURL: String) async throws {
        guard let token = MagicLink.token(in: pastedOrURL) else { throw MagicLink.unreadable }
        let answer = try await api.sendCapturingSession("POST", "/v1/auth/verify",
                                                       body: ["token": token], as: UserReply.self)
        try adopt(session: answer.session, user: answer.reply.user)
    }

    // Clearing `arrival` first makes a repeated identical refusal register as a change.
    @discardableResult
    public func arrived(from url: URL) async -> LinkArrival? {
        guard MagicLink.token(in: url.absoluteString) != nil else { return nil }
        arrival = nil
        let outcome: LinkArrival
        do {
            try await completeLink(url.absoluteString)
            outcome = .signedIn
        } catch {
            outcome = .refused(MagicLink.refusal(for: error))
        }
        arrival = outcome
        return outcome
    }

    // Apple sends `name` once ever per Apple ID: forward it on that authorization or it is lost.
    @discardableResult
    public func signInWithApple(authorizationCode: String, name: String?) async throws -> AppleOutcome {
        var body: [String: String] = ["authorizationCode": authorizationCode]
        if let name, !name.isEmpty { body["name"] = name }
        let reply = try await api.send("POST", "/v1/auth/apple", body: body, as: AppleReply.self)
        try adopt(session: reply.session, user: reply.user)
        return AppleOutcome(created: reply.created ?? false, privateEmail: reply.privateEmail ?? false)
    }

    // Folds this account into the one the link names; the reply carries a fresh session.
    public func linkToAccount(_ pastedOrURL: String) async throws {
        guard let token = MagicLink.token(in: pastedOrURL) else { throw MagicLink.unreadable }
        let reply = try await api.send("POST", "/v1/auth/link", body: ["token": token], as: AppleReply.self)
        try adopt(session: reply.session, user: reply.user)
    }

    public func signOut() async {
        _ = try? await api.send("POST", "/v1/auth/logout")
        sessions.clear()
        WindmillApi.forgetCookieJar(for: api.baseURL)
        linkSentTo = nil
        status = .signedOut
    }

    private func adopt(session: String?, user: User) throws {
        guard let session, !session.isEmpty else { throw MagicLink.unreadable }
        sessions.write(session)
        sessions.write(user: user)
        linkSentTo = nil
        status = .signedIn(user)
    }

    struct UserReply: Decodable { let user: User }
    struct AppleReply: Decodable {
        let user: User
        let session: String?
        let created: Bool?
        let privateEmail: Bool?
    }
}

public struct AppleOutcome: Equatable {
    public let created: Bool
    public let privateEmail: Bool
    public var shouldOfferLinkDoor: Bool { created && privateEmail }
}

// The emailed link is `{app}/#/auth?token=…`: the token sits in the fragment, so queryItems finds nothing.
public enum MagicLink {
    public static let unreadable = WindmillApiError.refused(400, Refusal(Data()))

    public static let expired = "That link has expired. Links work once and last 15 minutes — send a fresh one."

    public static func refusal(for error: Error) -> String {
        guard let api = error as? WindmillApiError, api == .offline else { return expired }
        return api.line
    }

    public static func token(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.contains("://") || trimmed.contains("token=") else { return trimmed }

        guard let start = trimmed.range(of: "token=") else { return nil }
        let tail = trimmed[start.upperBound...]
        let token = tail.prefix { $0 != "&" && $0 != "#" && !$0.isWhitespace }
        return token.isEmpty ? nil : String(token)
    }
}

// Exactly six ASCII digits is a code; anything else belongs to MagicLink.
public enum SignInCode {
    public static let expired = "That code has expired. Codes work once and last 15 minutes — send a fresh one."

    public static func refusal(for error: Error) -> String {
        guard let api = error as? WindmillApiError, api == .offline else { return expired }
        return api.line
    }

    public static func parse(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 6, trimmed.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return trimmed
    }
}

public protocol SessionStore: Sendable {
    func read() -> String?
    func write(_ secret: String)
    func readUser() -> User?
    func write(user: User)
    func clear()
}

public final class KeychainSessions: SessionStore {
    private let service = "works.windmill.session"
    private let secretAccount = "wm_session"
    private let userAccount = "wm_user"

    public init() {}

    public func read() -> String? {
        guard let data = read(account: secretAccount) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ secret: String) {
        write(Data(secret.utf8), account: secretAccount)
    }

    public func readUser() -> User? {
        guard let data = read(account: userAccount) else { return nil }
        return try? JSONDecoder().decode(User.self, from: data)
    }

    public func write(user: User) {
        guard let data = try? JSONEncoder().encode(user) else { return }
        write(data, account: userAccount)
    }

    public func clear() {
        SecItemDelete(baseQuery(account: secretAccount) as CFDictionary)
        SecItemDelete(baseQuery(account: userAccount) as CFDictionary)
    }

    private func read(account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private func write(_ data: Data, account: String) {
        if SecItemUpdate(baseQuery(account: account) as CFDictionary,
                         [kSecValueData as String: data] as CFDictionary) == errSecSuccess { return }
        var insert = baseQuery(account: account)
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }

    private func baseQuery(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}

public final class MemorySessions: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var secret: String?
    private var user: User?

    public init(secret: String? = nil, user: User? = nil) {
        self.secret = secret
        self.user = user
    }

    public func read() -> String? { lock.withLock { secret } }
    public func write(_ value: String) { lock.withLock { secret = value } }
    public func readUser() -> User? { lock.withLock { user } }
    public func write(user value: User) { lock.withLock { user = value } }
    public func clear() {
        lock.withLock {
            secret = nil
            user = nil
        }
    }
}
