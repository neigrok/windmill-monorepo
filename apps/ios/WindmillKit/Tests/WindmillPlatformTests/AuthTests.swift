import XCTest
@testable import WindmillPlatform

// The two places native auth differs from the web's, and therefore the two places it can be wrong
// in a way no web test would catch: reading the token out of an emailed link, and lifting the
// session out of a Set-Cookie header instead of letting a cookie jar do it.

final class MagicLinkTests: XCTestCase {
    // The shipped link is `{app}/#/auth?token=…` — the token is in the FRAGMENT. The obvious
    // reading (URLComponents.queryItems) returns nil for this, which is the bug this guards.
    func testTheTokenIsFoundInTheFragmentOfTheShippedLink() {
        XCTAssertEqual(MagicLink.token(in: "https://windmill.works/#/auth?token=abc123"), "abc123")
    }

    func testAPastedLinkSurvivesTheWhitespaceAMailClientAdds() {
        XCTAssertEqual(MagicLink.token(in: "  https://windmill.works/#/auth?token=abc123\n"), "abc123")
    }

    // Someone who pastes just the token has done nothing wrong.
    func testABareTokenIsAcceptedAsItself() {
        XCTAssertEqual(MagicLink.token(in: "abc123"), "abc123")
        XCTAssertEqual(MagicLink.token(in: "  abc123  "), "abc123")
    }

    // A mail client that appends tracking parameters must not widen the token.
    func testTrailingParametersAreNotSwallowedIntoTheToken() {
        XCTAssertEqual(MagicLink.token(in: "https://windmill.works/#/auth?token=abc123&utm_source=mail"), "abc123")
        XCTAssertEqual(MagicLink.token(in: "https://windmill.works/?token=abc123#/auth"), "abc123")
    }

    func testTokensCarryTheUrlSafeBase64AlphabetIntact() {
        let secret = "aB3-_xyzQW09"
        XCTAssertEqual(MagicLink.token(in: "https://windmill.works/#/auth?token=\(secret)"), secret)
    }

    func testNothingUsableReadsAsNothing() {
        XCTAssertNil(MagicLink.token(in: ""))
        XCTAssertNil(MagicLink.token(in: "   "))
        XCTAssertNil(MagicLink.token(in: "https://windmill.works/#/auth?token="))
    }
}

// A link that opens the APP instead of the browser (`Shell.onOpenURL` → `AuthStore.arrived`). It has
// no call site holding a `catch` and often no screen waiting for it, so everything it can do wrong
// is silent: signing nobody in and saying nothing, or claiming a link expired when the phone simply
// had no signal.
@MainActor
final class LinkArrivalTests: XCTestCase {
    private func store() -> AuthStore {
        AuthStore(baseURL: URL(string: "https://windmill.works")!, sessions: MemorySessions())
    }

    // The app claims one shape of link. Everything else on the domain — the gallery, a shared tree,
    // the pricing page — is not its business, and answering nil is what keeps it from opening a
    // sign-in door over a link that was never about signing in.
    func testAUrlWithNoTokenInItIsNotThisAppsBusiness() async {
        let auth = store()
        let arrival = await auth.arrived(from: URL(string: "https://windmill.works/#/gallery")!)
        XCTAssertNil(arrival, "a link with no token must be ignored, not refused")
        XCTAssertNil(auth.arrival, "and it must not leave a refusal on screen for something else")
        XCTAssertEqual(auth.status, .unknown, "and it must not touch the seat")
    }

    // "Send a fresh one" is advice nobody offline can follow, and the link in their mail is fine.
    // Only the failure that is really about the link gets the sentence about the link.
    func testOnlyALinkFailureIsReportedAsAnExpiredLink() {
        XCTAssertEqual(MagicLink.refusal(for: MagicLink.unreadable), MagicLink.expired)
        XCTAssertEqual(MagicLink.refusal(for: WindmillApiError.refused(400, Refusal(Data()))),
                       MagicLink.expired)
        XCTAssertEqual(MagicLink.refusal(for: WindmillApiError.offline), "Can't reach windmill.works")
    }
}

// The door's one field takes two credentials, and this is the rule that tells them apart. The pin
// that matters most is the LAST test: the link parser accepts ANY bare string as a token, so the
// door must ask the code question FIRST — a six-digit code that reached MagicLink would be POSTed
// to /v1/auth/verify as a token and die there.
final class SignInCodeTests: XCTestCase {
    func testExactlySixAsciiDigitsIsACodeAndNothingElseIs() {
        XCTAssertEqual(SignInCode.parse("483201"), "483201")
        XCTAssertEqual(SignInCode.parse("  483201\n"), "483201")
        XCTAssertNil(SignInCode.parse("48320"), "five digits is not a code")
        XCTAssertNil(SignInCode.parse("4832017"), "seven digits is not a code")
        XCTAssertNil(SignInCode.parse("48a201"), "a letter makes it a token")
        XCTAssertNil(SignInCode.parse(""))
        XCTAssertNil(SignInCode.parse("https://windmill.works/#/auth?token=abc123"),
                     "a pasted link is the parser's, never a code")
    }

    func testTheParserStillTreatsABareSixDigitStringAsAToken() {
        XCTAssertEqual(MagicLink.token(in: "483201"), "483201",
                       "the parser has not changed — the door disambiguates by asking SignInCode first")
    }

    // The server collapses wrong/spent/expired/unknown into one refusal; offline is the one failure
    // that is not about the code, and it keeps its own sentence.
    func testOnlyACodeFailureIsReportedAsAnExpiredCode() {
        XCTAssertEqual(SignInCode.refusal(for: WindmillApiError.refused(410, Refusal(Data()))),
                       SignInCode.expired)
        XCTAssertEqual(SignInCode.refusal(for: WindmillApiError.malformed), SignInCode.expired)
        XCTAssertEqual(SignInCode.refusal(for: WindmillApiError.offline), "Can't reach windmill.works")
    }
}

// A wire the tests own end to end: every request the store sends is recorded, and the answer is
// scripted. This is what lets the code door's endpoint, body and cookie capture — and restore's
// clear-only-on-401 rule — be pinned without a server.
final class DoorWire: URLProtocol {
    struct Sent: Equatable {
        let method: String
        let path: String
        let body: [String: String]
    }

    static var script: [(status: Int, headers: [String: String], body: String)] = []
    static var failWith: Error?
    private(set) static var sent: [Sent] = []

    static func reset() {
        script = []
        failWith = nil
        sent = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.sent.append(Sent(method: request.httpMethod ?? "",
                              path: request.url?.path ?? "",
                              body: Self.bodyOf(request)))
        if let failure = Self.failWith {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        let step = Self.script.isEmpty ? (status: 200, headers: [:], body: "{}") : Self.script.removeFirst()
        let response = HTTPURLResponse(url: request.url!, statusCode: step.status,
                                       httpVersion: "HTTP/1.1", headerFields: step.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(step.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    // URLSession hands a POST body to a protocol as a STREAM, not as `httpBody` — reading only the
    // property would pin every body as empty and prove nothing.
    private static func bodyOf(_ request: URLRequest) -> [String: String] {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var collected = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: 1024)
                guard read > 0 else { break }
                collected.append(buffer, count: read)
            }
            data = collected
        }
        guard let data else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: String] ?? [:]
    }
}

@MainActor
final class AuthStoreWireTests: XCTestCase {
    override func setUp() async throws {
        DoorWire.reset()
    }

    private func store(sessions: MemorySessions = MemorySessions()) -> AuthStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DoorWire.self]
        return AuthStore(baseURL: URL(string: "https://windmill.works")!, sessions: sessions,
                         urlSession: URLSession(configuration: configuration))
    }

    // The app's mint asks for the CODE email — `door: "app"` is what makes the mail carry a code
    // instead of a link, and the trimmed address is what verify-code will later be keyed on.
    func testRequestingACodeNamesTheAppDoor() async throws {
        let auth = store()
        DoorWire.script = [(200, [:], #"{"status":"sent"}"#)]

        try await auth.requestLink(to: "  sam@example.com \n")

        XCTAssertEqual(DoorWire.sent, [DoorWire.Sent(method: "POST", path: "/v1/auth/magic-link",
                                                     body: ["email": "sam@example.com", "door": "app"])])
        XCTAssertEqual(auth.linkSentTo, "sam@example.com")
    }

    // The verify-code reply is shaped exactly like verify: user in the body, session ONLY in
    // Set-Cookie. If the capture stops working, sign-in looks successful with no credential stored.
    func testCompletingWithACodePostsEmailAndCodeAndLiftsTheSessionCookie() async throws {
        let sessions = MemorySessions()
        let auth = store(sessions: sessions)
        DoorWire.script = [(200, ["Set-Cookie": "wm_session=s3cr3t; Path=/; HttpOnly; Max-Age=7776000"],
                            #"{"user":{"id":"u1","email":"sam@example.com","name":"Sam"}}"#)]

        try await auth.completeCode(email: "sam@example.com", code: "483201")

        XCTAssertEqual(DoorWire.sent, [DoorWire.Sent(method: "POST", path: "/v1/auth/verify-code",
                                                     body: ["email": "sam@example.com", "code": "483201"])])
        XCTAssertEqual(sessions.read(), "s3cr3t")
        XCTAssertEqual(auth.status, .signedIn(User(id: "u1", email: "sam@example.com", name: "Sam")))
    }

    func testACodeReplyWithoutACookieRefusesRatherThanPretending() async {
        let sessions = MemorySessions()
        let auth = store(sessions: sessions)
        DoorWire.script = [(200, [:], #"{"user":{"id":"u1","email":"sam@example.com","name":"Sam"}}"#)]

        do {
            try await auth.completeCode(email: "sam@example.com", code: "483201")
            XCTFail("no cookie is no session — adopting nothing must throw")
        } catch {}
        XCTAssertNil(sessions.read())
        XCTAssertEqual(auth.status, .unknown, "a failed sign-in touches nothing")
    }

    // THE RESTORE RULE: only a definitive 401 clears the Keychain. A phone opened in a basement is
    // not signed out — clearing there deleted a live 90-day secret and stranded the gym queue's
    // owed sets behind a bearer that no longer existed.
    func testRestoreKeepsTheSecretWhenTheNetworkFails() async {
        let sessions = MemorySessions(secret: "held")
        let auth = store(sessions: sessions)
        DoorWire.failWith = URLError(.notConnectedToInternet)

        await auth.restore()

        XCTAssertEqual(auth.status, .signedOut, "the seat rests signed out until the log answers")
        XCTAssertEqual(sessions.read(), "held", "and the secret survives to try again")
    }

    func testRestoreKeepsTheSecretThroughAServerFailure() async {
        let sessions = MemorySessions(secret: "held")
        let auth = store(sessions: sessions)
        DoorWire.script = [(500, [:], #"{"error":"internal error"}"#)]

        await auth.restore()

        XCTAssertEqual(auth.status, .signedOut)
        XCTAssertEqual(sessions.read(), "held")
    }

    func testRestoreClearsTheSecretOnADefinitive401() async {
        let sessions = MemorySessions(secret: "spent")
        let auth = store(sessions: sessions)
        DoorWire.script = [(401, [:], #"{"error":"session expired"}"#)]

        await auth.restore()

        XCTAssertEqual(auth.status, .signedOut)
        XCTAssertNil(sessions.read(), "a 401 is the one answer that really ends the session")
    }
}

final class SessionCookieTests: XCTestCase {
    private let url = URL(string: "https://windmill.works")!

    // POST /v1/auth/verify answers with the user in the body and the session ONLY as a Set-Cookie
    // (deliberately — a body would hand a 90-day secret to any XSS on the web). Native has no
    // cookie jar it trusts, so it lifts the value here. If this stops working, magic-link sign-in
    // silently produces a signed-in-looking app with no credential.
    func testTheSessionIsLiftedOutOfSetCookie() {
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Set-Cookie": "wm_session=s3cr3t-value; Path=/; HttpOnly; Secure; Max-Age=7776000"]
        )!
        XCTAssertEqual(WindmillApi.sessionCookie(in: response, for: url), "s3cr3t-value")
    }

    func testAnUnrelatedCookieIsNotMistakenForTheSession() {
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Set-Cookie": "wm_oauth_state=xyz; Path=/; HttpOnly"]
        )!
        XCTAssertNil(WindmillApi.sessionCookie(in: response, for: url))
    }

    func testNoCookieAtAllIsNil() {
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
        XCTAssertNil(WindmillApi.sessionCookie(in: response, for: url))
    }
}

final class RefusalTests: XCTestCase {
    // The backend owns the house copy, so the app shows the server's sentence rather than its own.
    func testTheServersOwnWordsAreWhatGetShown() {
        let body = Data(#"{"error":"That address looks unfinished — check the ending.","code":"invalid_email"}"#.utf8)
        let error = WindmillApiError.refused(400, Refusal(body))
        XCTAssertEqual(error.line, "That address looks unfinished — check the ending.")
    }

    func testAnEmptyRefusalStillEndsInSomethingSayable() {
        XCTAssertEqual(WindmillApiError.refused(500, Refusal(Data())).line, "That didn't go through")
        XCTAssertEqual(WindmillApiError.offline.line, "Can't reach windmill.works")
    }

    func testOnly401ReadsAsUnauthorized() {
        XCTAssertTrue(WindmillApiError.refused(401, Refusal(Data())).isUnauthorized)
        XCTAssertFalse(WindmillApiError.refused(403, Refusal(Data())).isUnauthorized)
        XCTAssertFalse(WindmillApiError.offline.isUnauthorized)
    }
}

// The one part of a request no other test can see. Every seam above the wire is faked, so a URL
// built wrongly is invisible until a real server answers 404 — which is exactly how the window read
// and the delta feed shipped broken: `appendingPathComponent` treats the whole string as ONE path
// segment and percent-encodes the query into it.
final class RequestURLTests: XCTestCase {
    private let base = URL(string: "http://localhost:8088")!

    func testAPlainPathResolves() {
        XCTAssertEqual(WindmillApi.url(for: "/v1/me", base: base)?.absoluteString,
                       "http://localhost:8088/v1/me")
    }

    func testAQueryStringStaysAQueryString() {
        let url = WindmillApi.url(for: "/v1/journal/pages?from=2026-08-01&to=2026-08-31", base: base)
        XCTAssertEqual(url?.absoluteString,
                       "http://localhost:8088/v1/journal/pages?from=2026-08-01&to=2026-08-31")
        XCTAssertEqual(url?.path, "/v1/journal/pages", "the query must not become part of the path")
        XCTAssertEqual(url?.query, "from=2026-08-01&to=2026-08-31")
    }

    // The delta feed's cursor is an HLC — "ms:counter:actor" — and its colons must survive as an
    // encoded query value rather than being read as a scheme separator.
    func testTheDeltaCursorSurvivesEncoding() {
        let url = WindmillApi.url(for: "/v1/journal/pages?since=0%3A0%3A&limit=500", base: base)
        XCTAssertEqual(url?.path, "/v1/journal/pages")
        XCTAssertEqual(url?.query, "since=0%3A0%3A&limit=500")
    }

    func testADayPathKeepsItsSegments() {
        XCTAssertEqual(WindmillApi.url(for: "/v1/journal/page/2026-08-04", base: base)?.path,
                       "/v1/journal/page/2026-08-04")
    }
}
