import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

// apps/ios/.live-backend.json (gitignored) holds a live session secret:
//   {"base": "http://localhost:8088", "session": "<secret>"}

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

    private static let configURL: URL? = {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("apps/ios/.live-backend.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        return nil
    }()

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

    func testAPageSurvivesTheRoundTrip() async throws {
        let day = try uniqueDay()
        let stamp = Hlc(milliseconds: 1_785_600_000_000, counter: 0, actor: "d-livetest")
        let sent = Page(day: day, body: "written by the swift client", mood: 4, energy: 2,
                        source: .typed, stamp: stamp)

        let winner = try await journal.put(sent)
        XCTAssertEqual(winner.body, sent.body)
        XCTAssertEqual(winner.mood, 4)
        XCTAssertEqual(winner.energy, 2)
        XCTAssertEqual(winner.stamp, stamp, "the stamp must survive the wire verbatim — it is the convergence key")
        XCTAssertGreaterThan(winner.updatedAtMs, 0, "the server stamps its own time")

        let readBack = try await journal.page(day)
        XCTAssertEqual(readBack, winner)
    }

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

    private func uniqueDay() throws -> LocalDay {
        let offset = Int.random(in: 0..<20_000)
        let base = try XCTUnwrap(LocalDay(iso: "2200-01-01"))
        return base.advanced(by: offset)
    }
}
