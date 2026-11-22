import XCTest

// The Board's budget on a screen (Roadmap on iOS §5), on the simulator board that holds the 5,000-step handbook: the
// time from the switch to the Board's first frame, and the frames the main actor is given while scripted flings scroll
// the list through its rows, each from the finger's first move to the list at rest. The app measures itself
// (`BoardFrames`) and appends each measure to the file this launch names; the test drives the taps and the flings,
// prints each measure as a `bench` line beside its budget with the share of the budget it used, and fails when one
// passes it. The budgets are §5's own, a second and a frame at 60 a second, held here on the Mac that runs the
// simulator. Opt in with TEST_RUNNER_WM_BOARD_BENCH=1 on a Release-configuration build that compiles the room and its
// boards in, as `Tools/board_bench.sh` does.
@MainActor final class RoadmapBoardBenchmarks: XCTestCase {
  override func setUpWithError() throws {
    try super.setUpWithError()
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_BOARD_BENCH"] == "1", "The Board's benchmarks are opt-in.")
    continueAfterFailure = false
  }

  func testTheFirstFrameAndAScriptedScrollHoldTheBudgetAtFiveThousandSteps() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: "board-measures-\(UUID().uuidString).jsonl")
    defer { try? FileManager.default.removeItem(at: file) }
    let measures = { () -> [[String: Any]] in
      ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { (line: Substring) -> [String: Any]? in
        (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
      }
    }
    let written = { (count: Int) -> Bool in
      XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in measures().count >= count }, object: nil)], timeout: 30) == .completed
    }
    let app = XCUIApplication()
    app.launchArguments = ["-model-server", "-board", "roadmap-handbook", "-board-measures", file.path]
    app.launch()
    // The board plants the handbook's 5,000 steps through the domain before its Board stands, in about half a minute.
    XCTAssertTrue(app.staticTexts["120 of 5000 done"].waitForExistence(timeout: 120))

    // Three times the Graph, then the Board again: each Board's first frame is timed from the tap.
    for _ in 0..<3 {
      app.segmentedControls.buttons["Graph"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["roadmap-graph"].waitForExistence(timeout: 30))
      let before = measures().count
      app.segmentedControls.buttons["Board"].tap()
      XCTAssertTrue(written(before + 1), "the Board's first frame was not measured")
    }

    // Eight flings down the list through Up next and Locked, and eight back up. Each scroll's frames are written as the
    // list comes to rest.
    let list = app.collectionViews.firstMatch
    XCTAssertTrue(list.waitForExistence(timeout: 10))
    for fling in 0..<16 {
      let before = measures().count
      if fling < 8 { list.swipeUp(velocity: .fast) } else { list.swipeDown(velocity: .fast) }
      XCTAssertTrue(written(before + 1), "a scroll's frames were not measured")
    }

    let taken = measures()
    let firsts = taken.filter { $0["measure"] as? String == "firstFrame" }.compactMap { $0["ms"] as? Double }
    XCTAssertEqual(firsts.count, 3)
    XCTAssertTrue(taken.allSatisfy { $0["steps"] as? Int == 5_000 })
    for (place, ms) in firsts.enumerated() {
      print(String(format: "bench [simulator] board · the switch to the Board's first frame, %d of 3: ms=%.1f steps=5000 | budget ≤ 1000ms → %@, %.0f%% of it",
                   place + 1, ms, ms > 1_000 ? "OVER" : "under", ms / 10))
    }

    // A frame is late past one and a half frames at 60 a second, and a scroll of half a second or more holds the
    // budget with no more than a tenth of its frames late, the rule the Graph's budget is judged by; the main actor's
    // work in a frame, its commit to the screen included, is held to the frame itself by its median over the scroll.
    let frame = 1_000.0 / 60
    let scrolls = taken.filter { $0["measure"] as? String == "frames" }
    XCTAssertGreaterThanOrEqual(scrolls.count, 16)
    var over: [Int] = []
    for (place, scroll) in scrolls.enumerated() {
      let (gaps, work) = (try XCTUnwrap(scroll["gapsMs"] as? [Double]), try XCTUnwrap(scroll["workMs"] as? [Double]).sorted())
      let (late, median) = (gaps.filter { $0 > frame * 1.5 }.count, work.isEmpty ? 0 : work[work.count / 2])
      let missed = (gaps.count >= 30 && late * 10 > gaps.count) || median > frame
      if missed { over.append(place + 1) }
      print(String(format: "bench [simulator] board · scroll %d of the scripted flings: frames=%d late=%d work p50=%.2fms p95=%.2fms max=%.2fms | budget late ≤ a tenth, work p50 ≤ 16.7ms → %@, %.0f%% of it",
                   place + 1, gaps.count, late, median, work.isEmpty ? 0 : work[min(work.count - 1, Int(Double(work.count) * 0.95))],
                   work.last ?? 0, missed ? "OVER" : "under", median / frame * 100))
    }
    let gaps = scrolls.flatMap { $0["gapsMs"] as? [Double] ?? [] }.sorted()
    let work = scrolls.flatMap { $0["workMs"] as? [Double] ?? [] }.sorted()
    print(String(format: "bench [simulator] board · every frame of the scripted flings: frames=%d late=%d gap p50=%.1fms p99=%.1fms max=%.1fms · work p50=%.2fms p95=%.2fms p99=%.2fms max=%.2fms",
                 gaps.count, gaps.filter { $0 > frame * 1.5 }.count, gaps[gaps.count / 2], gaps[Int(Double(gaps.count) * 0.99)], gaps[gaps.count - 1],
                 work[work.count / 2], work[Int(Double(work.count) * 0.95)], work[Int(Double(work.count) * 0.99)], work[work.count - 1]))
    XCTAssertEqual(over, [], "scrolls over the budget: more than a tenth of their frames late, or the median of a frame's work past a frame")
    XCTAssertTrue(firsts.allSatisfy { $0 <= 1_000 }, "a first frame came later than a second after the switch")
  }
}
