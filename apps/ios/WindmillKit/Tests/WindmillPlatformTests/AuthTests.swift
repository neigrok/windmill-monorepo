import XCTest
@testable import WindmillPlatform

final class MagicLinkTests: XCTestCase {
    func testTheTokenIsFoundInTheFragmentOfTheShippedLink() {
        XCTAssertEqual(MagicLink.token(in: "https://windmill.works/#/auth?token=abc123"), "abc123")
    }

    func testAPastedLinkSurvivesTheWhitespaceAMailClientAdds() {
        XCTAssertEqual(MagicLink.token(in: "  https://windmill.works/#/auth?token=abc123\n"), "abc123")
    }

    func testABareTokenIsAcceptedAsItself() {
        XCTAssertEqual(MagicLink.token(in: "abc123"), "abc123")
        XCTAssertEqual(MagicLink.token(in: "  abc123  "), "abc123")
    }

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

@MainActor
final class LinkArrivalTests: XCTestCase {
    private func store() -> AuthStore {
        AuthStore(baseURL: URL(string: "https://windmill.works")!, sessions: MemorySessions())
    }

    func testAUrlWithNoTokenInItIsNotThisAppsBusiness() async {
        let auth = store()
        let arrival = await auth.arrived(from: URL(string: "https://windmill.works/#/gallery")!)
        XCTAssertNil(arrival, "a link with no token must be ignored, not refused")
        XCTAssertNil(auth.arrival, "and it must not leave a refusal on screen for something else")
        XCTAssertEqual(auth.status, .unknown, "and it must not touch the seat")
    }

    func testOnlyALinkFailureIsReportedAsAnExpiredLink() {
        XCTAssertEqual(MagicLink.refusal(for: MagicLink.unreadable), MagicLink.expired)
        XCTAssertEqual(MagicLink.refusal(for: WindmillApiError.refused(400, Refusal(Data()))),
                       MagicLink.expired)
        XCTAssertEqual(MagicLink.refusal(for: WindmillApiError.offline), "Can't reach windmill.works")
    }
}

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

    func testOnlyACodeFailureIsReportedAsAnExpiredCode() {
        XCTAssertEqual(SignInCode.refusal(for: WindmillApiError.refused(410, Refusal(Data()))),
                       SignInCode.expired)
        XCTAssertEqual(SignInCode.refusal(for: WindmillApiError.malformed), SignInCode.expired)
        XCTAssertEqual(SignInCode.refusal(for: WindmillApiError.offline), "Can't reach windmill.works")
    }
}

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

    // URLSession hands a POST body to a protocol as a STREAM, not as `httpBody`.
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

    func testRequestingACodeNamesTheAppDoor() async throws {
        let auth = store()
        DoorWire.script = [(200, [:], #"{"status":"sent"}"#)]

        try await auth.requestLink(to: "  sam@example.com \n")

        XCTAssertEqual(DoorWire.sent, [DoorWire.Sent(method: "POST", path: "/v1/auth/magic-link",
                                                     body: ["email": "sam@example.com", "door": "app"])])
        XCTAssertEqual(auth.linkSentTo, "sam@example.com")
    }

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
        XCTAssertEqual(sessions.readUser(), User(id: "u1", email: "sam@example.com", name: "Sam"),
                       "the user is kept beside the secret for the launch the log cannot answer")
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

    func testRestoreKeepsTheSeatUnverifiedWhenTheNetworkFails() async {
        let sam = User(id: "u1", email: "sam@example.com", name: "Sam")
        let sessions = MemorySessions(secret: "held", user: sam)
        let auth = store(sessions: sessions)
        DoorWire.failWith = URLError(.notConnectedToInternet)

        await auth.restore()

        XCTAssertEqual(auth.status, .unverified(sam), "a basement is not a sign-out")
        XCTAssertEqual(auth.status.user, sam, "and the rooms connect under the last-known seat")
        XCTAssertEqual(sessions.read(), "held", "the secret survives to try again")
        XCTAssertEqual(sessions.readUser(), sam)
    }

    func testRestoreKeepsTheSeatUnverifiedThroughAServerFailure() async {
        let sam = User(id: "u1", email: "sam@example.com", name: "Sam")
        let sessions = MemorySessions(secret: "held", user: sam)
        let auth = store(sessions: sessions)
        DoorWire.script = [(500, [:], #"{"error":"internal error"}"#)]

        await auth.restore()

        XCTAssertEqual(auth.status, .unverified(sam))
        XCTAssertEqual(sessions.read(), "held")
    }

    func testVerifyingTheSeatMovesTheValueTheRoomsKeyTheirConnectOn() async {
        let sam = User(id: "u1", email: "sam@example.com", name: "Sam")
        let sessions = MemorySessions(secret: "held", user: sam)
        let auth = store(sessions: sessions)
        DoorWire.failWith = URLError(.notConnectedToInternet)

        await auth.restore()
        let basement = Account(api: auth.api, user: auth.status.user, verified: auth.status.verified)
        XCTAssertEqual(basement.seat, Account.Seat(userId: "u1", verified: false))
        XCTAssertTrue(basement.isSignedIn, "unverified is still signed in — the room connects for Sam")

        DoorWire.failWith = nil
        DoorWire.script = [(200, [:], #"{"user":{"id":"u1","email":"sam@example.com","name":"Sam"}}"#)]
        await auth.restore()
        let verified = Account(api: auth.api, user: auth.status.user, verified: auth.status.verified)
        XCTAssertEqual(auth.status, .signedIn(sam))
        XCTAssertEqual(verified.seat, Account.Seat(userId: "u1", verified: true))
        XCTAssertNotEqual(verified.seat, basement.seat, "the same user, a new seat: the room's connect re-runs")

        XCTAssertEqual(AuthStatus.signedOut.verified, true)
        XCTAssertEqual(AuthStatus.unknown.verified, true)
        XCTAssertEqual(Account(api: auth.api, user: nil).seat, Account.Seat(userId: nil, verified: true))
    }

    func testRestoreWithNoKnownUserRestsSignedOutButKeepsTheSecret() async {
        let sessions = MemorySessions(secret: "held")
        let auth = store(sessions: sessions)
        DoorWire.failWith = URLError(.notConnectedToInternet)

        await auth.restore()

        XCTAssertEqual(auth.status, .signedOut)
        XCTAssertEqual(sessions.read(), "held")
    }

    func testASuccessfulRestoreVerifiesTheSeatAndKeepsTheUserBesideTheSecret() async {
        let sessions = MemorySessions(secret: "held")
        let auth = store(sessions: sessions)
        DoorWire.script = [(200, [:], #"{"user":{"id":"u1","email":"sam@example.com","name":"Sam"}}"#)]

        await auth.restore()

        let sam = User(id: "u1", email: "sam@example.com", name: "Sam")
        XCTAssertEqual(auth.status, .signedIn(sam))
        XCTAssertEqual(sessions.readUser(), sam)
    }

    func testRestoreClearsTheSecretAndTheUserOnADefinitive401() async {
        let sessions = MemorySessions(secret: "spent", user: User(id: "u1", email: "sam@example.com", name: "Sam"))
        let auth = store(sessions: sessions)
        DoorWire.script = [(401, [:], #"{"error":"session expired"}"#)]

        await auth.restore()

        XCTAssertEqual(auth.status, .signedOut)
        XCTAssertNil(sessions.read(), "a 401 is the one answer that really ends the session")
        XCTAssertNil(sessions.readUser(), "and nobody is left beside a secret that is gone")
    }
}

final class SessionCookieTests: XCTestCase {
    private let url = URL(string: "https://windmill.works")!

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

    func testTheAppsOwnSessionKeepsNoCookieJar() {
        let configuration = WindmillApi.cookieless.configuration
        XCTAssertNil(configuration.httpCookieStorage, "no jar means no second credential on the disk")
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
    }

    func testSigningOutClearsAnyCookieAnOlderBuildLeftOnTheDisk() {
        let residue = HTTPCookie(properties: [
            .name: "wm_session", .value: "left-by-an-older-build", .domain: "windmill.works",
            .path: "/", .expires: Date().addingTimeInterval(7_776_000),
        ])!
        HTTPCookieStorage.shared.setCookie(residue)
        XCTAssertEqual(HTTPCookieStorage.shared.cookies(for: url)?.map(\.name), ["wm_session"])

        WindmillApi.forgetCookieJar(for: url)

        XCTAssertEqual(HTTPCookieStorage.shared.cookies(for: url) ?? [], [])
    }
}

final class RefusalTests: XCTestCase {
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
