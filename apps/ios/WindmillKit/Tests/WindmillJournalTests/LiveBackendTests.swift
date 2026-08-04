import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

// The only tests here that touch a real server. Everything else in this package proves the client
// against a fake, which proves the logic and proves nothing about the wire: a field renamed on the
// backend, a 404 that became a 200 with a null body, a stamp that stopped round-tripping — a fake
// agrees with whatever the client believes, forever.
//
// Skipped unless `apps/ios/.live-backend.json` exists, so CI and everyone else stay green without a
// server. Write it (it is gitignored — it holds a live session secret):
//
//   {"base": "http://localhost:8088", "session": "<secret>"}
//
// Mint the session with the recipe in .claude/skills/verify (sessions.token_hash is a plain
// sha256 of the secret, so local mail never has to send). The file is found by walking up from
// #filePath, the same way LadderTests finds the gym golden — env vars are not used because
// xcodebuild's TEST_RUNNER_ prefix does not reach a SwiftPM logic test, and a test that silently
// skips because its plumbing failed is worse than one that never ran.
//
// BUILD THE SERVER OPTIMIZED. A `CMAKE_BUILD_TYPE=Debug` backend fails these in a way that looks
// exactly like a client bug: -O0's un-inlined frames overflow drogon's worker stack and corrupt
// by-value returns, so a page comes back empty or as garbage bytes with no crash and a 200. That
// is written at the top of backend/CMakeLists.txt and it cost an hour here anyway.

final class LiveBackendTests: XCTestCase {
    private var api: WindmillApi!
    private var journal: JournalApi!

    private struct LiveConfig: Decodable { let base: String; let session: String }

    override func setUpWithError() throws {
        guard let url = Self.configURL, let data = try? Data(contentsOf: url) else {
            throw XCTSkip("no live backend — write apps/ios/.live-backend.json to run these")
        }
        let config = try JSONDecoder().decode(LiveConfig.self, from: data)
        let base = try XCTUnwrap(URL(string: config.base))
        api = WindmillApi(baseURL: base, credential: { config.session })
        journal = JournalApi(api: api)
    }

    // Walk up for the file rather than counting directories — the same reason LadderTests walks up
    // for its golden, and the same tripwire avoided.
    private static let configURL: URL? = {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("apps/ios/.live-backend.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        return nil
    }()

    // The Bearer header is the native client's whole credential. If the backend ever stopped
    // honouring it in favour of the cookie, every screen in the app would be signed out and no
    // test built on a fake could tell us.
    func testTheBearerHeaderResolvesToAUser() async throws {
        let reply = try await api.get("/v1/me", as: AuthStore.UserReply.self)
        XCTAssertFalse(reply.user.id.isEmpty)
        XCTAssertFalse(reply.user.email.isEmpty)
    }

    func testAnUnauthenticatedCallIsRefusedAs401() async throws {
        let anonymous = WindmillApi(baseURL: api.baseURL, credential: { nil })
        do {
            _ = try await anonymous.get("/v1/me", as: AuthStore.UserReply.self)
            XCTFail("an anonymous /v1/me must not resolve")
        } catch let error as WindmillApiError {
            XCTAssertTrue(error.isUnauthorized, "expected 401, got \(error)")
        }
    }

    // A page written by the Swift encoder, read back by the Swift decoder, through the real server.
    // This is the round trip the whole product rests on.
    func testAPageSurvivesTheRoundTrip() async throws {
        let day = try uniqueDay()
        let stamp = Hlc(milliseconds: 1_785_600_000_000, counter: 0, actor: "d-livetest")
        let sent = Page(day: day, body: "written by the swift client", mood: .m4, energy: .e2,
                        source: .typed, stamp: stamp)

        let winner = try await journal.put(sent)
        XCTAssertEqual(winner.body, sent.body)
        XCTAssertEqual(winner.mood, .m4)
        XCTAssertEqual(winner.energy, .e2)
        XCTAssertEqual(winner.stamp, stamp, "the stamp must survive the wire verbatim — it is the convergence key")
        XCTAssertGreaterThan(winner.updatedAtMs, 0, "the server stamps its own time")

        let readBack = try await journal.page(day)
        XCTAssertEqual(readBack, winner)
    }

    // The rule PageStore is built on: a losing write is answered with the body that WON, so the
    // canvas is honest on the same round trip instead of discovering it later.
    func testAStaleWriteLosesAndIsAnsweredWithTheWinner() async throws {
        let day = try uniqueDay()
        let fresh = Page(day: day, body: "the winner", stamp: Hlc(milliseconds: 9_000_000_000_000, counter: 0, actor: "d-new"))
        _ = try await journal.put(fresh)

        let stale = Page(day: day, body: "stale, must not win", stamp: Hlc(milliseconds: 1, counter: 0, actor: "d-old"))
        let answer = try await journal.put(stale)

        XCTAssertEqual(answer.body, "the winner", "the server must hand back what won, not what was sent")
        let stored = try await journal.page(day)
        XCTAssertEqual(stored?.body, "the winner")
    }

    // A day nobody wrote is a 404 on the wire and a nil in Swift — the canvas draws a gap, never an
    // error. If this ever throws instead, the first empty day breaks the whole canvas.
    func testADayNeverWrittenReadsAsNil() async throws {
        let never = try XCTUnwrap(LocalDay(iso: "1990-03-14"))
        let absent = try await journal.page(never)
        XCTAssertNil(absent)
    }

    func testTheRangeReadReturnsWhatWasWritten() async throws {
        let day = try uniqueDay()
        _ = try await journal.put(Page(day: day, body: "in the window",
                                       stamp: Hlc(milliseconds: 8_000_000_000_000, counter: 0, actor: "d-range")))

        let window = try await journal.range(from: day.advanced(by: -1), to: day.advanced(by: 1))
        XCTAssertTrue(window.contains { $0.day == day && $0.body == "in the window" },
                      "the day just written is missing from its own range")
    }

    // Each test needs a day nobody else has touched: these run against a shared database, and a
    // fixed date would make two runs — or two agents — fight over one row.
    private func uniqueDay() throws -> LocalDay {
        let offset = Int.random(in: 0..<20_000)
        let base = try XCTUnwrap(LocalDay(iso: "2200-01-01"))
        return base.advanced(by: offset)
    }
}
