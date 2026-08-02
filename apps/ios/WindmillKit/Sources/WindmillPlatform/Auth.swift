import Foundation

// Sign-in for the native superapp — the same one door the web has, reached the way a phone can
// reach it. The account is an email address (backend/AUTH.md): a magic link is the founding door
// and Sign in with Apple is the native one. Whichever door opens, the session secret it yields is
// the app's only credential and lives in the Keychain, never in UserDefaults — a session is a
// 90-day bearer of someone's whole journal.

public enum AuthStatus: Equatable {
    case unknown            // the app has not yet asked /v1/me — the seat is a ghost, not empty
    case signedOut
    case signedIn(User)

    public var user: User? {
        if case .signedIn(let user) = self { return user }
        return nil
    }
}

@MainActor
public final class AuthStore: ObservableObject {
    @Published public private(set) var status: AuthStatus = .unknown
    @Published public private(set) var linkSentTo: String?

    public let api: WindmillApi
    private let sessions: any SessionStore

    // Nonisolated: building the store touches nothing but its own stored properties, so a caller
    // may create one anywhere (a default argument, a preview) while every mutation stays on main.
    public nonisolated init(baseURL: URL = WindmillApi.resolvedBaseURL(), sessions: any SessionStore = KeychainSessions()) {
        self.sessions = sessions
        self.api = WindmillApi(baseURL: baseURL, credential: { [sessions] in sessions.read() })
    }

    // The seat on launch. A lapsed session is a non-event (AUTH.md): drop the dead secret and show
    // the door, never an error — nobody needs to be told their 90 days ran out.
    public func restore() async {
        guard sessions.read() != nil else {
            status = .signedOut
            return
        }
        do {
            status = .signedIn(try await api.get("/v1/me", as: UserReply.self).user)
        } catch {
            sessions.clear()
            status = .signedOut
        }
    }

    public func requestLink(to email: String) async throws {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        try await api.send("POST", "/v1/auth/magic-link", body: ["email": address])
        linkSentTo = address
    }

    // The token arrives from the mail. On a phone that means one of two things: the app was opened
    // by the link itself (a universal link, once the associated domain is live), or the person
    // pasted what they were looking at. Both land here, and both accept the whole URL — asking
    // someone to extract a token out of a URL is asking them to do the parser's job.
    public func completeLink(_ pastedOrURL: String) async throws {
        guard let token = MagicLink.token(in: pastedOrURL) else { throw MagicLink.unreadable }
        let answer = try await api.sendCapturingSession("POST", "/v1/auth/verify",
                                                       body: ["token": token], as: UserReply.self)
        try adopt(session: answer.session, user: answer.reply.user)
    }

    // The native door. Apple hands the app a one-time authorization code; the backend does the rest
    // and answers with the session in the body (it knows a native caller has no cookie jar). `name`
    // is Apple's, sent exactly once ever for an Apple ID — so it is forwarded on the one
    // authorization that carries it or it is lost for good.
    @discardableResult
    public func signInWithApple(authorizationCode: String, name: String?) async throws -> AppleOutcome {
        var body: [String: String] = ["authorizationCode": authorizationCode]
        if let name, !name.isEmpty { body["name"] = name }
        let reply = try await api.send("POST", "/v1/auth/apple", body: body, as: AppleReply.self)
        try adopt(session: reply.session, user: reply.user)
        return AppleOutcome(created: reply.created ?? false, privateEmail: reply.privateEmail ?? false)
    }

    // Fold this (new, empty) account into the one a magic link names — the remedy for a Hide My
    // Email sign-in that could not find the account the person already has on the web. Runs while
    // still holding the new account's session, which is why a fresh session comes back.
    public func linkToAccount(_ pastedOrURL: String) async throws {
        guard let token = MagicLink.token(in: pastedOrURL) else { throw MagicLink.unreadable }
        let reply = try await api.send("POST", "/v1/auth/link", body: ["token": token], as: AppleReply.self)
        try adopt(session: reply.session, user: reply.user)
    }

    public func signOut() async {
        _ = try? await api.send("POST", "/v1/auth/logout")
        sessions.clear()
        linkSentTo = nil
        status = .signedOut
    }

    private func adopt(session: String?, user: User) throws {
        guard let session, !session.isEmpty else { throw MagicLink.unreadable }
        sessions.write(session)
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

// `created` and `privateEmail` together are the one condition the link door is offered on
// (AUTH.md): a brand-new account reached through a relay address can never have found the account
// this person already has on the web, and no honest guess exists — so the app offers, once.
public struct AppleOutcome: Equatable {
    public let created: Bool
    public let privateEmail: Bool
    public var shouldOfferLinkDoor: Bool { created && privateEmail }
}

// The emailed link is `{app}/#/auth?token=…` — the token lives in the URL *fragment*, so the
// obvious reading (URLComponents.queryItems) finds nothing. This is the whole reason this is a
// tested function and not two lines at a call site.
public enum MagicLink {
    public static let unreadable = WindmillApiError.refused(400, Refusal(Data()))

    public static func token(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.contains("://") || trimmed.contains("token=") else { return trimmed }

        // Everything after the first `token=`, up to whatever ends it. Works on the fragment form,
        // on a plain query, and on a link a mail client wrapped in tracking parameters.
        guard let start = trimmed.range(of: "token=") else { return nil }
        let tail = trimmed[start.upperBound...]
        let token = tail.prefix { $0 != "&" && $0 != "#" && !$0.isWhitespace }
        return token.isEmpty ? nil : String(token)
    }
}

// Where the session secret sleeps. A protocol so tests get a fake for free and never touch the
// real Keychain, which is process-wide state a test suite must not mutate.
public protocol SessionStore: Sendable {
    func read() -> String?
    func write(_ secret: String)
    func clear()
}

public final class KeychainSessions: SessionStore {
    private let service = "works.windmill.session"
    private let account = "wm_session"

    public init() {}

    public func read() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ secret: String) {
        let data = Data(secret.utf8)
        if SecItemUpdate(baseQuery() as CFDictionary,
                         [kSecValueData as String: data] as CFDictionary) == errSecSuccess { return }
        var insert = baseQuery()
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }

    public func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}

public final class MemorySessions: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var secret: String?

    public init(secret: String? = nil) { self.secret = secret }
    public func read() -> String? { lock.withLock { secret } }
    public func write(_ value: String) { lock.withLock { secret = value } }
    public func clear() { lock.withLock { secret = nil } }
}
