import Sentry
import XCTest

final class CrashReportsTests: XCTestCase {
    func testConfigurationRequiresTheIosDsn() throws {
        XCTAssertNil(CrashReports.options(info: [:]))
        XCTAssertNil(CrashReports.options(info: ["SENTRY_DSN": "https://backend@example.invalid/1"]))
        XCTAssertNil(CrashReports.options(info: ["IOS_SENTRY_DSN": ""]))
        XCTAssertNil(CrashReports.options(info: ["IOS_SENTRY_DSN": "$(IOS_SENTRY_DSN)"]))

        let options = try XCTUnwrap(CrashReports.options(info: [
            "IOS_SENTRY_DSN": "https://ios@example.invalid/42",
            "SENTRY_DSN": "https://backend@example.invalid/1",
            "CFBundleShortVersionString": "2.3.4",
            "CFBundleVersion": "56",
        ]))
        XCTAssertEqual(options.dsn, "https://ios@example.invalid/42")
        XCTAssertNotNil(options.parsedDsn)
        XCTAssertEqual(options.releaseName, "windmill-ios@2.3.4+56")
        XCTAssertEqual(options.dist, "56")
    }

    func testSdkScrubsPrivateCrashDataBeforeTransport() throws {
        let options = try XCTUnwrap(CrashReports.options(info: [
            "IOS_SENTRY_DSN": "https://ios@example.invalid/42",
            "CFBundleShortVersionString": "2.3.4",
            "CFBundleVersion": "56",
        ]))
        let scrub = try XCTUnwrap(options.beforeSend)
        let report = expectation(description: "SDK prepares the scrubbed event")
        options.beforeSend = { event in
            guard let event = scrub(event) else {
                XCTFail("The scrub must retain the crash")
                report.fulfill()
                return nil
            }
            XCTAssertNil(event.message)
            XCTAssertNil(event.request)
            XCTAssertNil(event.breadcrumbs)
            XCTAssertNil(event.extra)
            XCTAssertNil(event.user)
            XCTAssertNil(event.context?["user info"])
            XCTAssertNil(event.context?["custom"])
            XCTAssertEqual(event.tags, ["platform": "ios"])
            XCTAssertEqual(event.releaseName, "windmill-ios@2.3.4+56")
            XCTAssertEqual(event.exceptions?.map { $0.serialize() as NSDictionary }, [
                ["type": "RouteProbe", "mechanism": ["type": "test", "handled": true]] as NSDictionary,
            ])
            let json = try? JSONSerialization.data(withJSONObject: event.serialize(), options: [.sortedKeys])
            XCTAssertFalse(String(data: json ?? Data(), encoding: .utf8)?.contains("private-input") ?? true)
            report.fulfill()
            return nil
        }
        SentrySDK.start(options: options)
        defer { SentrySDK.close() }

        let event = Event(level: .error)
        event.message = SentryMessage(formatted: "private-input")
        event.user = User(userId: "private-input")
        event.request = SentryRequest()
        event.request?.url = "https://example.invalid/private-input"
        event.breadcrumbs = [Breadcrumb(level: .info, category: "private-input")]
        event.extra = ["input": "private-input"]
        event.tags = ["input": "private-input"]
        event.context = ["user info": ["input": "private-input"], "custom": ["input": "private-input"]]
        let exception = Exception(value: "private-input", type: "RouteProbe")
        exception.mechanism = Mechanism(type: "test")
        exception.mechanism?.handled = true
        exception.mechanism?.desc = "private-input"
        exception.mechanism?.data = ["input": "private-input"]
        event.exceptions = [exception]
        SentrySDK.capture(event: event)
        wait(for: [report], timeout: 5)
    }
}
