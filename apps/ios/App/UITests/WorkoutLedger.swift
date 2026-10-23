import XCTest

extension XCUIApplication {
  // Every set row of the workout ledger, first to last. The ledger is a capped list that scrolls inside the rack, and a
  // drag does not always move it, or the accessibility tree has not caught up when it is read, so an edge counts as
  // reached only when three drags in a row, each down a different lane of the list, leave the same rows in place.
  func workoutLedgerRows(file: StaticString = #filePath, line: UInt = #line) -> [XCUIElementSnapshot] {
    let list = collectionViews.containing(.any, identifier: "workout-current-set").firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 5), file: file, line: line)
    let frame = list.frame
    XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
    let origin = coordinate(withNormalizedOffset: .zero)
    let lanes: [CGFloat] = [0.5, 0.3, 0.7]
    let point = { (x: CGFloat, y: CGFloat) in
      origin.withOffset(CGVector(dx: frame.minX + frame.width * x, dy: frame.minY + frame.height * y))
    }
    let query = descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@",
      "Set [0-9]+, (logged|current|planned), .*"))
    func visible() -> [XCUIElementSnapshot] {
      query.allElementsBoundByIndex.compactMap { try? $0.snapshot() }
        .filter { frame.intersects($0.frame) }.sorted { $0.frame.minY < $1.frame.minY }
    }
    func placed(_ rows: [XCUIElementSnapshot]) -> [String] {
      rows.map { "\($0.identifier)|\($0.label)|\($0.frame)" }
    }
    func drag(from start: CGFloat, to end: CGFloat, toward edge: String, reading: ([XCUIElementSnapshot]) -> Void) {
      var page = visible(), still = 0
      for _ in 0..<40 {
        reading(page)
        let lane = lanes[still]
        point(lane, start).press(forDuration: 0.01, thenDragTo: point(lane, end), withVelocity: .slow, thenHoldForDuration: 0.1)
        let next = visible()
        still = placed(next) == placed(page) ? still + 1 : 0
        if still == 3 { return }
        page = next
      }
      XCTFail("The ledger must reach its \(edge) row.", file: file, line: line)
    }

    drag(from: 0.2, to: 0.8, toward: "first") { _ in }
    var rows: [XCUIElementSnapshot] = []
    var seen = Set<String>()
    drag(from: 0.8, to: 0.2, toward: "last") { page in
      for row in page where seen.insert(row.identifier.isEmpty ? row.label : row.identifier).inserted { rows.append(row) }
    }
    return rows
  }
}
