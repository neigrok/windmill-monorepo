import XCTest

// The Graph's budget on a screen (Roadmap on iOS §5), on the simulator board that holds the 5,000-step handbook: the
// time from the switch to the Graph's first frame, with its layout, and the frames the main actor is given while a
// scripted pan and pinch move the camera. The app measures itself (`RoadmapGraph.Measure`) and appends each measure to
// the file this launch names; the test drives the gestures, prints each measure as a `bench` line beside its budget
// with the share of the budget it used, and fails when one passes it. The budgets are §5's own, a second and a frame
// at 60 a second, held here on the Mac that runs the simulator: the share says how wide the margin is for a phone,
// which is slower. Opt in with TEST_RUNNER_WM_GRAPH_BENCH=1 on a Release-configuration build that compiles the room
// and its boards in, as `Tools/graph_bench.sh` does.
@MainActor final class RoadmapGraphBenchmarks: XCTestCase {
  override func setUpWithError() throws {
    try super.setUpWithError()
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_GRAPH_BENCH"] == "1", "The Graph's benchmarks are opt-in.")
    continueAfterFailure = false
  }

  func testTheFirstFrameAndAScriptedPanAndPinchHoldTheBudgetAtFiveThousandSteps() throws {
    let file = FileManager.default.temporaryDirectory.appending(path: "graph-measures-\(UUID().uuidString).jsonl")
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
    app.launchArguments = ["-model-server", "-board", "roadmap-handbook", "-graph-measures", file.path]
    app.launch()
    // The board plants the handbook's 5,000 steps through the domain before its Board stands, in about half a minute.
    XCTAssertTrue(app.staticTexts["120 of 5000 done"].waitForExistence(timeout: 120))

    app.segmentedControls.buttons["Graph"].tap()
    let canvas = app.descendants(matching: .any)["roadmap-graph"]
    XCTAssertTrue(canvas.waitForExistence(timeout: 30))
    XCTAssertTrue(written(1), "the Graph's first frame was not measured")

    // The whole roadmap: one finger pans it four ways. Then five pinches in, to the ceiling, with a pan after each, and
    // five pinches back out to the floor. Each gesture's frames are written as it ends.
    let centre = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    let drags = [CGVector(dx: 120, dy: 80), CGVector(dx: -120, dy: -80), CGVector(dx: 0, dy: 160), CGVector(dx: 0, dy: -160)]
    let measured = { (gesture: () -> Void) in
      let before = measures().count
      gesture()
      XCTAssertTrue(written(before + 1), "a gesture's frames were not measured")
    }
    for drag in drags {
      measured { centre.press(forDuration: 0.05, thenDragTo: centre.withOffset(drag), withVelocity: 240, thenHoldForDuration: 0.05) }
    }
    for pinch in 0..<5 {
      measured { canvas.pinch(withScale: 4, velocity: 2) }
      measured { centre.press(forDuration: 0.05, thenDragTo: centre.withOffset(drags[pinch % drags.count]), withVelocity: 240, thenHoldForDuration: 0.05) }
    }
    for _ in 0..<5 {
      measured { canvas.pinch(withScale: 0.25, velocity: -2) }
    }

    let taken = measures()
    let first = try XCTUnwrap(taken.first { $0["measure"] as? String == "firstFrame" })
    let (firstMs, layoutMs) = (try XCTUnwrap(first["ms"] as? Double), try XCTUnwrap(first["layoutMs"] as? Double))
    print(String(format: "bench [simulator] graph · the switch to the first frame: ms=%.1f layout=%.1fms steps=%d | budget ≤ 1000ms → %@, %.0f%% of it",
                 firstMs, layoutMs, first["steps"] as? Int ?? 0, firstMs > 1_000 ? "OVER" : "under", firstMs / 10))
    XCTAssertEqual(first["steps"] as? Int, 5_000)

    // A frame is late past one and a half frames at 60 a second, and a gesture of half a second or more holds the
    // budget with no more than a tenth of its frames late: the rule the app reports a missed budget by. The main
    // actor's work in a frame, its commit to the screen included, is held to the frame itself by its median over
    // the gesture: now and then a frame or two of a gesture stall, at the closest zoom too, where the canvas draws a
    // step or two, so the nineteenth of twenty is printed and not judged.
    let frame = 1_000.0 / 60
    let moved = taken.filter { $0["measure"] as? String == "frames" }
    XCTAssertGreaterThanOrEqual(moved.count, 19)
    var over: [Int] = []
    for (place, gesture) in moved.enumerated() {
      let (gaps, work) = (try XCTUnwrap(gesture["gapsMs"] as? [Double]), try XCTUnwrap(gesture["workMs"] as? [Double]).sorted())
      let (late, median) = (gaps.filter { $0 > frame * 1.5 }.count, work[work.count / 2])
      let missed = (gaps.count >= 30 && late * 10 > gaps.count) || median > frame
      if missed { over.append(place + 1) }
      print(String(format: "bench [simulator] graph · gesture %d of the scripted pan and pinch: zoom=%.5f frames=%d late=%d work p50=%.2fms p95=%.2fms max=%.2fms | budget late ≤ a tenth, work p50 ≤ 16.7ms → %@, %.0f%% of it",
                   place + 1, gesture["zoom"] as? Double ?? 0, gaps.count, late, median, work[min(work.count - 1, Int(Double(work.count) * 0.95))], work[work.count - 1],
                   missed ? "OVER" : "under", median / frame * 100))
    }
    let gaps = moved.flatMap { $0["gapsMs"] as? [Double] ?? [] }.sorted()
    let work = moved.flatMap { $0["workMs"] as? [Double] ?? [] }.sorted()
    print(String(format: "bench [simulator] graph · every frame of the scripted pan and pinch: frames=%d late=%d gap p50=%.1fms p99=%.1fms max=%.1fms · work p50=%.2fms p95=%.2fms p99=%.2fms max=%.2fms",
                 gaps.count, gaps.filter { $0 > frame * 1.5 }.count, gaps[gaps.count / 2], gaps[Int(Double(gaps.count) * 0.99)], gaps[gaps.count - 1],
                 work[work.count / 2], work[Int(Double(work.count) * 0.95)], work[Int(Double(work.count) * 0.99)], work[work.count - 1]))
    XCTAssertEqual(over, [], "gestures over the budget: more than a tenth of their frames late, or the median of a frame's work past a frame")
    XCTAssertLessThanOrEqual(firstMs, 1_000, "the first frame came later than a second after the switch")
  }
}
