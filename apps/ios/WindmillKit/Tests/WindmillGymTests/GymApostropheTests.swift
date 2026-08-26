import XCTest
@testable import WindmillGym

// Every string literal the gym module draws, read straight off the source and scanned for the straight
// apostrophe (C13): a `'` inside a literal is a sentence the room says in the wrong typeface.
// Comments and test prose are drawn nowhere, so the scanner drops them — and the scanner has its own
// test below, because a scanner that reads a line wrongly is a guard that passes on anything.
final class GymApostropheTests: XCTestCase {

    func testNoStraightApostropheSurvivesInAnythingTheRoomSays() {
        let source = Self.gymSources
        XCTAssertGreaterThan(source.count, 40,
                             "the scan found no module to scan, so its silence means nothing")
        var offenders: [String] = []
        for file in source {
            let text = try! String(contentsOf: file, encoding: .utf8)
            for (number, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                for literal in Self.literals(in: String(line)) where literal.contains("'") {
                    offenders.append("\(file.lastPathComponent):\(number + 1) \(literal)")
                }
            }
        }
        XCTAssertEqual(offenders, [], "straight apostrophes left in gym copy")
    }

    // Every .swift under Sources/WindmillGym, found from this file rather than from a bundle.
    static let gymSources: [URL] = {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("Sources/WindmillGym")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let found = (try? FileManager.default.contentsOfDirectory(at: candidate,
                                                                         includingPropertiesForKeys: nil)) ?? []
                return found.filter { $0.pathExtension == "swift" }.sorted { $0.path < $1.path }
            }
            directory = directory.deletingLastPathComponent()
        }
        return []
    }()

    // The string literals on one line, with `//` comments dropped — a scanner, not a parser: a `"`
    // opens a literal and the next unescaped `"` closes it.
    static func literals(in line: String) -> [String] {
        var found: [String] = []
        var current = ""
        var inside = false
        var escaped = false
        var index = line.startIndex
        while index < line.endIndex {
            let character = line[index]
            if inside {
                if escaped {
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    found.append(current)
                    current = ""
                    inside = false
                    index = line.index(after: index)
                    continue
                }
                current.append(character)
            } else if character == "\"" {
                inside = true
            } else if character == "/", line.index(after: index) < line.endIndex,
                      line[line.index(after: index)] == "/" {
                break
            }
            index = line.index(after: index)
        }
        return found
    }

    func testTheApostropheScannerReadsALineTheWayTheCompilerDoes() {
        XCTAssertEqual(Self.literals(in: #"Text("it’s here") // and the reader's note"#), ["it’s here"])
        XCTAssertEqual(Self.literals(in: #"let a = "one", b = "two""#), ["one", "two"])
        XCTAssertEqual(Self.literals(in: #"// only a comment's words"#), [])
        XCTAssertEqual(Self.literals(in: #"let quoted = "a \" inside""#), [#"a \" inside"#])
    }
}
