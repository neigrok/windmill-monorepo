import XCTest

@MainActor final class GymIntegrationFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  var server: String? { ProcessInfo.processInfo.environment["WM_GYM_E2E_SERVER"] }
  var identities: [String: [String: String]] {
    guard let file = ProcessInfo.processInfo.environment["WM_GYM_E2E_IDENTITIES"],
          let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
          let values = try? JSONSerialization.jsonObject(with: data) as? [String: [String: String]] else { return [:] }
    return values
  }
  func launch(anonymous: Bool = false, appearance: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", anonymous ? "gym-e2e-anonymous" : "gym-e2e"]
    if let appearance { app.launchArguments += ["-onboarding-appearance", appearance] }
    if let server {
      app.launchArguments += ["-server", server, "-telemetry"]
      if let dsn = ProcessInfo.processInfo.environment["WM_GYM_E2E_SENTRY"] { app.launchArguments += ["-sentry-dsn", dsn] }
      if !anonymous { app.launchArguments += ["-code-file", ProcessInfo.processInfo.environment["WM_GYM_E2E_SESSION"]!] }
    } else { app.launchArguments += ["-model-server", "-server", "http://127.0.0.1:1"] }
    app.launch()
    XCTAssertTrue(app.buttons["new-routine"].waitForExistence(timeout: 20))
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["new-routine"])
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed)
    return app
  }
  func replace(_ field: XCUIElement, _ text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
    if let value = field.value as? String, !["Routine name", "open", "max", "last time"].contains(value) {
      field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
    }
    field.typeText(text)
  }
  func pickBench(_ app: XCUIApplication, routineEditor: Bool = false) {
    capture(app, "picker-after-opening")
    let search = routineEditor ? app.textFields["gym-movement-search"] : app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5)); app.buttons["gym-movement-bench-press"].tap()
  }
  func back(_ app: XCUIApplication) { app.navigationBars.buttons.element(boundBy: 0).tap() }
  func capture(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func logAndFinish(_ app: XCUIApplication, close: Bool = true, count: Int = 4) {
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    for _ in 0..<count { app.buttons["workout-log"].tap() }
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    app.buttons["workout-fix-weight"].tap()
    for digit in ["6", "2", ".", "5"] { app.buttons["workout-key-\(digit)"].tap() }
    app.buttons["workout-keypad-set"].tap()
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 5)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.staticTexts[count < 4 ? "Ended early." : "Well done."].waitForExistence(timeout: 20)); capture(app, "e2e-receipt")
    if !close { return }
    app.buttons["Done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
  }
  func testRoutineWorkoutReceiptLogRecordWeightNoteAndEdit() throws {
    let app = launch()
    app.buttons["new-routine"].tap(); replace(app.textFields["routine-name"], "Integration A")
    app.buttons["add-movement"].tap()
    pickBench(app, routineEditor: true)
    app.buttons["builder-movement-bench-press"].tap()
    replace(app.textFields["gym-target-sets"], "4"); replace(app.textFields["gym-target-reps"], "8"); replace(app.textFields["gym-target-weight"], "60")
    app.buttons["gym-target-set"].tap(); app.buttons["save-routine"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
    app.buttons["Start workout"].tap(); logAndFinish(app)
    app.buttons["gym-session-movement"].firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5)); capture(app, "e2e-record")
    back(app); back(app)
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch.waitForExistence(timeout: 10))
    app.buttons["gym-weigh-in"].tap(); replace(app.textFields["gym-weigh-in-weight"], "82.4"); app.buttons["gym-weigh-in-save"].tap()
    app.tabBars.buttons["Routines"].tap()
    if !app.buttons["edit-routine"].exists {
      let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "routine-", "Integration A")).firstMatch
      XCTAssertTrue(routine.waitForExistence(timeout: 5)); routine.tap()
    }
    XCTAssertTrue(app.buttons["edit-routine"].waitForExistence(timeout: 5)); app.buttons["edit-routine"].tap(); replace(app.textFields["routine-name"], "Integration B"); app.buttons["save-routine"].tap(); back(app)
    app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["you-gym-settings"].waitForExistence(timeout: 5)); app.buttons["you-gym-settings"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-settings"].waitForExistence(timeout: 5)); app.buttons["Notes"].tap()
    app.buttons["coach-add-note"].tap(); replace(app.textFields["coach-note-title"], "Training focus")
    let body = app.textFields["coach-note-body"].exists ? app.textFields["coach-note-body"] : app.textViews["coach-note-body"]
    replace(body, "Keep the bench controlled."); app.buttons["coach-note-save"].tap()
    XCTAssertTrue(app.staticTexts["Training focus"].waitForExistence(timeout: 5)); capture(app, "e2e-notes")
    if server != nil {
      back(app); back(app); app.tabBars.buttons["Coach"].tap()
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 10)); question.tap(); question.typeText("How is my training?")
      app.buttons["coach-send"].tap()
      XCTAssertTrue(app.staticTexts["Coach isn’t part of this Windmill. Your log is still yours to read."].waitForExistence(timeout: 10))
      XCTAssertFalse(question.exists); capture(app, "e2e-coach-unavailable")
      verifyServer("signed", edited: true)
    }
  }
  func testAnonymousWorkoutAdoptedAtSignIn() throws {
    let app = launch(anonymous: true)
    app.buttons["Just start logging"].tap()
    XCTAssertTrue(app.buttons["workout-add"].waitForExistence(timeout: 5)); app.buttons["workout-add"].tap()
    pickBench(app)
    logAndFinish(app); back(app)
    app.buttons["you"].tap()
    if let link = identities["adopt"]?["link"] {
      app.buttons["email-sign-in"].tap(); replace(app.textFields["email-address"], "gym-mail-failure@example.com"); app.buttons["Send code"].tap()
      XCTAssertTrue(app.staticTexts["Can't reach windmill.works. Nothing you've written is lost."].waitForExistence(timeout: 10))
      capture(app, "e2e-auth-mail-unavailable"); app.buttons["Back"].tap()
      app.buttons["link-sign-in"].tap(); replace(app.textFields["sign-in-link"], link); app.buttons["sign-in-link-submit"].tap()
    } else {
      app.buttons["email-sign-in"].tap(); replace(app.textFields["email-address"], "gym-adopt@example.com"); app.buttons["Send code"].tap()
      replace(app.textFields["email-code"], "482913")
    }
    if app.alerts.buttons["Add"].waitForExistence(timeout: 5) { app.alerts.buttons["Add"].tap() }
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 15))
    if server != nil { verifyServer("adopt", edited: false) }
  }
  func testFinishedAndOpenAnonymousWorkoutsStaySeparateFromAccountsOpenWorkout() throws {
    try XCTSkipUnless(server != nil && identities["conflict"] != nil, "Requires the isolated real backend and precreated open account workout.")
    let link = try XCTUnwrap(identities["conflict"]?["link"])
    let accountWorkout = try XCTUnwrap(identities["conflict"]?["openSession"])
    let app = launch(anonymous: true, appearance: "light")
    app.buttons["Just start logging"].tap()
    XCTAssertTrue(app.buttons["workout-add"].waitForExistence(timeout: 5)); app.buttons["workout-add"].tap(); pickBench(app)
    logAndFinish(app, count: 2); back(app)
    app.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(app.buttons["Just start logging"].waitForExistence(timeout: 5)); app.buttons["Just start logging"].tap()
    XCTAssertTrue(app.buttons["workout-add"].waitForExistence(timeout: 5)); app.buttons["workout-add"].tap(); pickBench(app)
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    app.buttons["workout-log"].tap(); app.buttons["workout-log"].tap()
    XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).count, 2)
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5)); app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["link-sign-in"].waitForExistence(timeout: 5)); app.buttons["link-sign-in"].tap()
    replace(app.textFields["sign-in-link"], link); app.buttons["sign-in-link-submit"].tap()
    XCTAssertTrue(app.alerts.buttons["Add"].waitForExistence(timeout: 15)); app.alerts.buttons["Add"].tap()
    let recovery = app.descendants(matching: .any)["gym-adoption-recovery"]
    XCTAssertTrue(recovery.waitForExistence(timeout: 20))
    capture(app, "adoption-recovery-ready")
    let hierarchy = XCTAttachment(string: app.debugDescription)
    hierarchy.name = "adoption-recovery-hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
    let keep = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-adoption-keep-")).firstMatch
    XCTAssertTrue(keep.waitForExistence(timeout: 20)); XCTAssertEqual(keep.label, "Keep as finished workout")
    let recoveredID = String(keep.identifier.dropFirst("gym-adoption-keep-".count))
    XCTAssertFalse(recoveredID.isEmpty); XCTAssertNotEqual(recoveredID, accountWorkout)
    capture(app, "adoption-recovery-light")
    let finishedSets = verifyConflictServer(stage: "before-keep")
    XCTAssertEqual(finishedSets.count, 2)
    app.terminate()
    if let appearance = app.launchArguments.firstIndex(of: "-onboarding-appearance") { app.launchArguments[appearance + 1] = "dark" }
    app.launchArguments += ["-restore-board"]; app.launch()
    XCTAssertTrue(recovery.waitForExistence(timeout: 20))
    let restoredKeep = app.buttons["gym-adoption-keep-" + recoveredID]
    XCTAssertTrue(restoredKeep.waitForExistence(timeout: 5)); XCTAssertEqual(restoredKeep.label, "Keep as finished workout")
    capture(app, "adoption-recovery-dark")
    XCTAssertEqual(verifyConflictServer(stage: "restored-before-keep"), finishedSets)
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in restoredKeep.isEnabled && restoredKeep.isHittable }, object: restoredKeep)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed); restoredKeep.tap()
    XCTAssertTrue(restoredKeep.waitForNonExistence(timeout: 15))
    let allAnonymousSets = verifyConflictServer(stage: "after-keep", recoveryID: recoveredID)
    XCTAssertEqual(allAnonymousSets.count, 4); XCTAssertTrue(allAnonymousSets.isSuperset(of: finishedSets))
    app.terminate(); app.launch()
    let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.buttons["workout-log"].exists || app.buttons["you"].exists }, object: app)
    XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 20), .completed)
    XCTAssertFalse(recovery.exists); XCTAssertFalse(restoredKeep.exists)
    XCTAssertEqual(verifyConflictServer(stage: "relaunch-after-keep", recoveryID: recoveredID), allAnonymousSets)
  }

  func verifyConflictServer(stage: String, recoveryID: String? = nil) -> Set<String> {
    let confirmed = expectation(description: "Anonymous workouts retained separately and exactly once")
    var setIDs = Set<String>()
    Task {
      do { setIDs = try await verifyConflictServerAsync(stage: stage, recoveryID: recoveryID) }
      catch { XCTFail("Conflicting adoption REST verification failed: \(error)") }
      confirmed.fulfill()
    }
    wait(for: [confirmed], timeout: 30)
    return setIDs
  }
  func verifyConflictServerAsync(stage: String, recoveryID: String?) async throws -> Set<String> {
    let identity = try XCTUnwrap(identities["conflict"]), origin = try XCTUnwrap(server)
    let accountWorkout = try XCTUnwrap(identity["openSession"]), accountSet = try XCTUnwrap(identity["openSet"])
    let startedAt = try XCTUnwrap(identity["openStartedAt"].flatMap(Int64.init)), completedAt = try XCTUnwrap(identity["openCompletedAt"].flatMap(Int64.init))
    let token = try XCTUnwrap(identity["token"])
    func get(_ path: String) async throws -> [String: Any] {
      var request = URLRequest(url: URL(string: origin + "/v1/gym/" + path)!); request.timeoutInterval = 5
      request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    let expectedSessions = recoveryID == nil ? 2 : 3
    for _ in 0..<100 {
      let sessions = try await get("sessions")["sessions"] as? [[String: Any]] ?? []
      guard sessions.count == expectedSessions else { try await Task.sleep(for: .milliseconds(200)); continue }
      var details: [[String: Any]] = [], anonymousSets: [[String: Any]] = []
      for listed in sessions {
        let id = try XCTUnwrap(listed["id"] as? String), detail = try await get("sessions/" + id)
        let session = try XCTUnwrap(detail["session"] as? [String: Any]), sets = try XCTUnwrap(detail["sets"] as? [[String: Any]])
        details.append(detail)
        if id == accountWorkout {
          XCTAssertNil(session["finishedAt"]); XCTAssertEqual(sets.count, 1)
          XCTAssertEqual(session["startedAt"] as? Int64, startedAt); XCTAssertEqual(sets.first?["completedAt"] as? Int64, completedAt)
          XCTAssertEqual(sets.first?["kind"] as? String, "working"); XCTAssertEqual(sets.first?["note"] as? String, "")
          XCTAssertEqual(sets.first?["id"] as? String, accountSet)
          XCTAssertEqual(sets.first?["exerciseId"] as? String, "barbell-row")
          XCTAssertEqual(sets.first?["weightKg"] as? Double, 35); XCTAssertEqual(sets.first?["reps"] as? Int, 11)
        } else {
          XCTAssertNotNil(session["finishedAt"]); XCTAssertEqual(sets.count, 2)
          XCTAssertTrue(sets.allSatisfy { $0["exerciseId"] as? String == "bench-press" })
          if id == recoveryID {
            XCTAssertEqual(session["finishedAt"] as? Int64, sets.compactMap { $0["completedAt"] as? Int64 }.max())
          } else { XCTAssertTrue(sets.contains { $0["weightKg"] as? Double == 62.5 }) }
          anonymousSets += sets
        }
      }
      let ids = Set(anonymousSets.compactMap { $0["id"] as? String })
      XCTAssertEqual(ids.count, anonymousSets.count); XCTAssertFalse(ids.contains(accountSet))
      XCTAssertEqual(sessions.filter { $0["finishedAt"] == nil }.compactMap { $0["id"] as? String }, [accountWorkout])
      if let recoveryID { XCTAssertTrue(sessions.contains { $0["id"] as? String == recoveryID }) }
      let data = try JSONSerialization.data(withJSONObject: ["stage": stage, "sessions": details], options: [.prettyPrinted, .sortedKeys])
      let evidence = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
      evidence.name = "conflict-rest-" + stage; evidence.lifetime = .keepAlways; add(evidence)
      return ids
    }
    XCTFail("The expected anonymous sessions did not reach the backend within 20 seconds.")
    return []
  }

  func testReceiptKeepsCoachAndAccountHandoffsThroughDismissal() {
    let signed = XCUIApplication()
    signed.launchArguments = ["-model-server", "-server", "http://127.0.0.1:1", "-scenario", "gym-e2e", "-coach-fixture"]
    signed.launch()
    XCTAssertTrue(signed.buttons["Just start logging"].waitForExistence(timeout: 15)); signed.buttons["Just start logging"].tap()
    XCTAssertTrue(signed.buttons["workout-add"].waitForExistence(timeout: 5)); signed.buttons["workout-add"].tap()
    pickBench(signed)
    logAndFinish(signed, close: false)
    let share = signed.buttons["workout-share-coach"]
    for _ in 0..<4 where !share.isHittable { signed.swipeUp() }
    XCTAssertTrue(share.waitForExistence(timeout: 5)); share.tap()
    XCTAssertTrue(signed.staticTexts["Check my last session."].waitForExistence(timeout: 15))
    XCTAssertTrue(signed.buttons["Review"].waitForExistence(timeout: 10))
    signed.terminate()
    let anonymous = launch(anonymous: true)
    anonymous.buttons["Just start logging"].tap()
    XCTAssertTrue(anonymous.buttons["workout-add"].waitForExistence(timeout: 5)); anonymous.buttons["workout-add"].tap()
    pickBench(anonymous)
    logAndFinish(anonymous, close: false)
    let keep = anonymous.buttons["Keep this log"]
    for _ in 0..<4 where !keep.isHittable { anonymous.swipeUp() }
    keep.tap()
    XCTAssertTrue(anonymous.staticTexts["Keep your training"].waitForExistence(timeout: 10))
  }

  func verifyServer(_ kind: String, edited: Bool) {
    let confirmed = expectation(description: "All UI changes confirmed through backend REST reads")
    Task {
      do { try await verifyServerAsync(kind, edited: edited) }
      catch { XCTFail("Backend verification failed: \(error)") }
      confirmed.fulfill()
    }
    wait(for: [confirmed], timeout: 30)
  }
  func verifyServerAsync(_ kind: String, edited: Bool) async throws {
    let identity = try XCTUnwrap(identities[kind]), origin = try XCTUnwrap(server)
    func get(_ path: String) async throws -> [String: Any] {
      var request = URLRequest(url: URL(string: origin + "/v1/gym/" + path)!)
      request.setValue("Bearer " + identity["token"]!, forHTTPHeaderField: "Authorization")
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    for _ in 0..<100 {
      let listing = try await get("sessions")
      let sessions = listing["sessions"] as? [[String: Any]] ?? []
      if let session = sessions.first(where: { $0["finishedAt"] is NSNumber }), let id = session["id"] as? String {
        let detail = try await get("sessions/" + id)
        let sets = detail["sets"] as? [[String: Any]] ?? []
        var confirmed = sets.count == 4 && sets.contains { ($0["weightKg"] as? Double) == 62.5 }
        if edited {
          let frozen = (detail["session"] as? [String: Any])?["plan"] as? [String: Any] ?? [:]
          let entries = frozen["entries"] as? [[String: Any]] ?? []
          let targets = entries.first?["sets"] as? [[String: Any]] ?? []
          confirmed = confirmed && frozen["routine"] as? String == "Integration A" && targets.count == 4
          confirmed = confirmed && targets.allSatisfy { ($0["weightKg"] as? Double) == 60 && ($0["reps"] as? Int) == 8 }
          let routines = try await get("routines"), weights = try await get("bodyweight"), notes = try await get("notes")
          confirmed = confirmed && (routines["routines"] as? [[String: Any]] ?? []).contains { $0["name"] as? String == "Integration B" }
          confirmed = confirmed && (weights["entries"] as? [[String: Any]] ?? []).contains { ($0["weightKg"] as? Double) == 82.4 }
          confirmed = confirmed && (notes["notes"] as? [[String: Any]] ?? []).contains {
            $0["title"] as? String == "Training focus" && $0["body"] as? String == "Keep the bench controlled."
          }
        }
        if confirmed { return }
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTFail("The UI changes did not all reach the real backend within 20 seconds.")
  }
}
