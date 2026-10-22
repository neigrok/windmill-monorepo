import XCTest

extension XCUIApplication {
  func workoutLedgerRows(file: StaticString = #filePath, line: UInt = #line) -> [XCUIElementSnapshot] {
    let list = collectionViews.containing(.any, identifier: "workout-current-set").firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 5), file: file, line: line)
    let frame = list.frame
    XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
    let origin = coordinate(withNormalizedOffset: .zero)
    let top = origin.withOffset(CGVector(dx: frame.midX, dy: frame.minY + frame.height * 0.2))
    let bottom = origin.withOffset(CGVector(dx: frame.midX, dy: frame.minY + frame.height * 0.8))
    let query = descendants(matching: .any).matching(NSPredicate(format: "label MATCHES %@",
      "Set [0-9]+, (logged|current|planned), .*"))
    func visible() -> [XCUIElementSnapshot] {
      query.allElementsBoundByIndex.compactMap { try? $0.snapshot() }
        .filter { frame.intersects($0.frame) }.sorted { $0.frame.minY < $1.frame.minY }
    }
    for attempt in 0..<20 {
      let before = visible()
      top.press(forDuration: 0.01, thenDragTo: bottom, withVelocity: .slow, thenHoldForDuration: 0.1)
      let after = visible()
      if after.map({ [$0.identifier, $0.label] }) == before.map({ [$0.identifier, $0.label] }), after.map(\.frame) == before.map(\.frame) { break }
      XCTAssertLessThan(attempt, 19, "The ledger must reach its first row.", file: file, line: line)
    }
    var rows: [XCUIElementSnapshot] = []
    var seen = Set<String>()
    for attempt in 0..<20 {
      let page = visible()
      for row in page {
        let key = row.identifier.isEmpty ? row.label : row.identifier
        if seen.insert(key).inserted { rows.append(row) }
      }
      bottom.press(forDuration: 0.01, thenDragTo: top, withVelocity: .slow, thenHoldForDuration: 0.1)
      let after = visible()
      if after.map({ [$0.identifier, $0.label] }) == page.map({ [$0.identifier, $0.label] }), after.map(\.frame) == page.map(\.frame) { break }
      XCTAssertLessThan(attempt, 19, "The ledger must reach its last row.", file: file, line: line)
    }
    return rows
  }
}
