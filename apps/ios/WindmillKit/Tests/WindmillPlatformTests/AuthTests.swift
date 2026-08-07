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

// The waiting screen's instruction is the one string in this app that a dark universal-link setup
// makes WRONG rather than merely absent. A link works exactly once: while iOS still hands
// windmill.works to Safari, "open the link on this phone" signs someone in over there and leaves the
// phone holding a spent link — so the advice has to be to copy it. It flips only when the domain
// serves an association file, which no build can produce and no test can fake.
final class SignInDoorCopyTests: XCTestCase {
    func testAnUnconfiguredBundleReadsAsNoUniversalLinks() {
        XCTAssertFalse(SignInDoor.universalLinksEnabled, "absent must read as off, never as on")
    }

    func testWithNoAssociatedDomainTheDoorSaysCopyRatherThanTap() {
        XCTAssertTrue(SignInDoor.finishing.contains("Copy the link rather than tapping it"))
        XCTAssertFalse(SignInDoor.finishing.contains("Open the link on this phone"),
                       "a tap cannot come back here yet, so nothing may tell anyone to tap")
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
