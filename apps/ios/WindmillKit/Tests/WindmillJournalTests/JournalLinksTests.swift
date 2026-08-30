import XCTest
@testable import WindmillJournal

final class JournalLinksTests: XCTestCase {
    struct Golden: Decodable {
        let cases: [Case]
    }

    struct Case: Decodable {
        let why: String
        let text: String
        let links: [Link]
    }

    struct Link: Decodable {
        let lo: Int
        let hi: Int
        let href: String
    }

    static let goldenURL: URL = {
        let relative = "packages/api-contract/journal-links.json"
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(relative)
    }()

    var golden: Golden!

    override func setUpWithError() throws {
        if !FileManager.default.fileExists(atPath: Self.goldenURL.path) {
            XCTFail("link golden not found at \(Self.goldenURL.path) — this suite reads the repo's packages/api-contract/journal-links.json, not a bundled copy")
        }
        golden = try JSONDecoder().decode(Golden.self, from: Data(contentsOf: Self.goldenURL))
    }

    func testTheGoldenStillCarriesItsCases() {
        XCTAssertGreaterThanOrEqual(golden.cases.count, 22, "the golden shrank to \(golden.cases.count) cases")
    }

    // The one test that matters: this room and the web canvas answer the same page the same way.
    func testEveryCaseInTheSharedGolden() {
        for one in golden.cases {
            let found = JournalLinks.find(in: one.text)
            XCTAssertEqual(found.count, one.links.count, "\(one.why) — \(one.text)")
            guard found.count == one.links.count else { continue }
            for (got, want) in zip(found, one.links) {
                XCTAssertEqual(got.lo, want.lo, "\(one.why) — lo of \(one.text)")
                XCTAssertEqual(got.hi, want.hi, "\(one.why) — hi of \(one.text)")
                XCTAssertEqual(got.href, want.href, "\(one.why) — href of \(one.text)")
            }
        }
    }

    func testThePaintedPageSpellsTheWritingBackExactly() {
        for one in golden.cases {
            let painted = JournalLinks.attributed(one.text, tint: .red)
            XCTAssertEqual(String(painted.characters), one.text, one.why)
        }
    }

    func testEveryLinkInThePaintedPageIsTappableAndTinted() {
        let text = "see www.a.io and https://b.io/x"
        let painted = JournalLinks.attributed(text, tint: .red)
        let linked = painted.runs.compactMap { run -> (String, URL)? in
            guard let url = run.link else { return nil }
            XCTAssertEqual(run.foregroundColor, .red, "a link is lamp")
            XCTAssertEqual(run.underlineStyle, .single, "a link is underlined")
            return (String(painted[run.range].characters), url)
        }
        XCTAssertEqual(linked.map(\.0), ["www.a.io", "https://b.io/x"])
        XCTAssertEqual(linked.map(\.1), [URL(string: "https://www.a.io")!, URL(string: "https://b.io/x")!])
    }

    func testAPageWithNoLinkIsOneUnmarkedRun() {
        let painted = JournalLinks.attributed("a quiet day", tint: .red)
        XCTAssertEqual(painted.runs.count, 1)
        XCTAssertNil(painted.runs.first?.link)
    }
}
