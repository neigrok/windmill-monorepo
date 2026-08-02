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
