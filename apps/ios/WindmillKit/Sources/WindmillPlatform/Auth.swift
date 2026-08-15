import Foundation

// Sign-in for the native superapp — the same one door the web has, reached the way a phone can
// reach it. The account is an email address (backend/AUTH.md): the app asks for an emailed six-digit
// CODE (`door: "app"`), the web keeps the magic link, and Sign in with Apple is the native extra.
// Whichever door opens, the session secret it yields is the app's only credential and lives in the
// Keychain, never in UserDefaults — a session is a 90-day bearer of someone's whole journal.

public enum AuthStatus: Equatable {
    case unknown            // the app has not yet asked /v1/me — the seat is a ghost, not empty
    case signedOut
    case signedIn(User)
    // The seat as this device last knew it: a secret is held and this is the user the log last
    // named for it, but THIS launch has not heard the log confirm it — the phone had no signal, or
    // the log fell over. It is a signed-in seat, not a signed-out one: a basement is not a sign-out,
    // and every product connects under this user off the copy it holds. The next launch or
    // return to the foreground asks again (`restore`).
    case unverified(User)

    public var user: User? {
        switch self {
        case .signedIn(let user), .unverified(let user): return user
        case .unknown, .signedOut: return nil
        }
    }

    // False only for the seat the log has not confirmed THIS launch. Signed out is verified — nobody
    // is waiting on an answer — so a room keyed on (user, verified) re-runs for a verification and
    // for nothing else.
    public var verified: Bool {
        if case .unverified = self { return false }
        return true
    }
}

// What happened to a link that arrived from OUTSIDE the app — a universal-link tap rather than a
// paste. It is published because nobody is standing at the paste field when one lands: a door that
// happens to be open reads it and closes itself, and a link that woke a closed app hands its refusal
// back to the caller so the shell can open a door for it.
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

    // Nonisolated: building the store touches nothing but its own stored properties, so a caller
    // may create one anywhere (a default argument, a preview) while every mutation stays on main.
    public nonisolated init(baseURL: URL = WindmillApi.resolvedBaseURL(),
                            sessions: any SessionStore = KeychainSessions(),
                            urlSession: URLSession = .shared) {
        self.sessions = sessions
        self.api = WindmillApi(baseURL: baseURL, credential: { [sessions] in sessions.read() },
                               session: urlSession)
    }

    // The seat on launch, and again on every return to the foreground while it is unverified. A
    // lapsed session is a non-event (AUTH.md): drop the dead secret and show the door, never an
    // error — nobody needs to be told their 90 days ran out.
    //
    // Only a DEFINITIVE 401 may clear the Keychain, and only a definitive 401 is a sign-out. A phone
    // with no signal — or a log answering 5xx — has not been signed out: the secret stays, and the
    // seat is the user this device last read beside it, marked unverified, so the rooms connect
    // SIGNED IN off the copies they hold. Answering signed-out there was a silent sign-out that
    // opened gym on the anonymous shelf, let go of the account's settings document, and stranded
    // the queue's owed sets behind a bearer that no longer existed.
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

    // `door: "app"` asks the mail to carry the six-digit code instead of the link — a code can be
    // read off one screen and typed into this one, where a tapped link opens the wrong surface.
    public func requestLink(to email: String) async throws {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        try await api.send("POST", "/v1/auth/magic-link", body: ["email": address, "door": "app"])
        linkSentTo = address
    }

    // The app door's own finish: the emailed code, with the address it was sent to. The reply is
    // shaped exactly like /v1/auth/verify — the user in the body, the session only in Set-Cookie —
    // so the same capture lifts it.
    public func completeCode(email: String, code: String) async throws {
        let answer = try await api.sendCapturingSession("POST", "/v1/auth/verify-code",
                                                        body: ["email": email, "code": code],
                                                        as: UserReply.self)
        try adopt(session: answer.session, user: answer.reply.user)
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

    // The same completion, reached from the other side: the app was opened BY the link. It cannot
    // throw, because no call site is holding a `catch` — the outcome is the return value and the
    // published `arrival` at once, and clearing to nil first is what makes a second identical
    // refusal still register as a change for anything watching.
    //
    // A URL carrying nothing this app can read answers nil and touches nothing. That guard lives
    // here rather than at the call site because what a magic link looks like is auth's knowledge,
    // and a shell that had to know it would be a second copy of the same rule.
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

    // One fact, one sentence, wherever a link fails — pasted into the door or tapped in the mail.
    public static let expired = "That link has expired. Links work once and last 15 minutes — send a fresh one."

    // And it is not always that fact. A request that never reached the server has not expired
    // anything, and "send a fresh one" is advice nobody offline can follow — so the only failure
    // that is really about the link gets the sentence about the link.
    public static func refusal(for error: Error) -> String {
        guard let api = error as? WindmillApiError, api == .offline else { return expired }
        return api.line
    }

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

// The emailed six-digit code — what the app's own door requests (`door: "app"`) and verifies. It
// shares one field with the pasted link, and the door tells the two credentials apart HERE, before
// the parser: `MagicLink.token(in:)` accepts ANY bare string as a token, so a code that reached it
// would go out to /v1/auth/verify as a token and die there. Exactly six ASCII digits is a code;
// everything else is the parser's.
public enum SignInCode {
    // The server collapses wrong, spent, expired and unknown into one refusal so nothing leaks;
    // this is the door's one sentence for all of them, and the remedy is the Resend button above it.
    public static let expired = "That code has expired. Codes work once and last 15 minutes — send a fresh one."

    // The same split MagicLink.refusal makes: a request that never reached the server has not
    // expired anything, so only a failure that is really about the code gets the code's sentence.
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

// Where the session secret sleeps — and, beside it, the user the log last named for that secret,
// which is what lets a launch with no signal answer a seat instead of a sign-out. A protocol so
// tests get a fake for free and never touch the real Keychain, which is process-wide state a test
// suite must not mutate. `clear` ends both together: a secret the log refused names nobody.
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

    // The user rides in the same Keychain item class as the secret, under its own account name:
    // it is the secret's companion, held exactly as long and cleared in the same breath, and a
    // file in Application Support would outlive the secret it describes.
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
