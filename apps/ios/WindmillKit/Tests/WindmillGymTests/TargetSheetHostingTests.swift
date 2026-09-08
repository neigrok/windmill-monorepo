import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The target sheet of brief 17, hosted on the shared fixtures. SwiftUI builds no accessibility tree
// under a plain `UIHostingController` — its `Text` is not a view and its nodes come only with
// VoiceOver or automation — so the chrome is counted from the strings the sheet draws FROM
// (`TargetSheet.chrome`, which cannot drift from the view), and the host proves what UIKit does
// expose: the fields, in order, holding the draft's own texts and placeholders.
@MainActor
final class TargetSheetHostingTests: XCTestCase {
    private let ramp = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80),
                        SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100),
                        SetTarget(reps: 5, weightKg: 80)]

    private func host<Content: View>(_ content: Content) async -> UIWindow {
        let controller = UIHostingController(rootView: content
            .environment(\.gymSkin, GymSkin.instrument)
            .environment(\.colorScheme, .dark))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
        return window
    }

    private func sheet(_ scheme: [SetTarget], movement: String, place: String, signed: Bool = false) -> TargetSheet {
        TargetSheet(entry: RoutineWrite.Entry(exerciseId: "x", sets: scheme), movement: movement, place: place,
                    untested: false, signed: signed, onSet: { _ in }, onCancel: {})
    }

    // The text fields in the order laid out: the head's three, then reps and load per ladder row.
    private func fields(in view: UIView) -> [UITextField] {
        var found: [UITextField] = []
        if let field = view as? UITextField { found.append(field) }
        for child in view.subviews { found += fields(in: child) }
        return found
    }

    private func sheetSource() throws -> Substring {
        let text = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/RoutineBuilderScreens.swift"), encoding: .utf8)
        let body = try XCTUnwrap(text.range(of: "struct TargetSheet: View"))
        return text[body.upperBound...]
    }

    func testTheChromeAtFirstPaintIsTheFourteenPinnedWordsAndTheSheetDrawsFromThem() async throws {
        let commit = TargetEntry.Draft(ramp).commitLabel
        XCTAssertEqual(commit, "Set · 5 sets")
        let chrome = TargetSheet.chrome + [commit]
        XCTAssertEqual(chrome, ["Every set", "Sets", "Reps", "Weight", "Set by set", "Fill", "Add set", "Set · 5 sets"])
        XCTAssertEqual(chrome.joined(separator: " ").split(separator: " ").filter { $0 != "·" }.count, 14)

        let source = try sheetSource()
        for name in ["Chrome.everySet", "Chrome.sets", "Chrome.reps", "Chrome.weight", "Chrome.setBySet",
                     "Chrome.fill", "Chrome.addSet"] {
            XCTAssertTrue(source.contains("Text(\(name))") || source.contains("Label(\(name),")
                          || source.contains("headField(\(name),"), "\(name) is not drawn")
        }
        XCTAssertEqual(source.components(separatedBy: "Text(draft.commitLabel)").count - 1, 1, "the commit is the draft's own")
        XCTAssertTrue(source.contains(".disabled(refused)"), "and refused with it")

        let window = await host(sheet(ramp, movement: "Back Squat", place: "1 of 2 · Lower A"))
        let drawn = fields(in: window)
        XCTAssertEqual(drawn.count, 3 + 2 * 5, "the head's three fields and two per ladder row")
        XCTAssertEqual(drawn.map(\.text), ["5", "", "", "5", "60", "5", "80", "3", "90", "1", "100", "5", "80"])
        XCTAssertEqual(drawn.map(\.placeholder), [TargetEntry.setsPlaceholder, TargetEntry.varies, TargetEntry.varies]
                       + Array(repeating: [TargetEntry.repsPlaceholder, TargetEntry.weightPlaceholder], count: 5).flatMap { $0 },
                       "the head reads `varies` over rows that disagree; every row keeps its own placeholders")
    }

    func testTheStraightSchemeReadsInTheHeadAndCommitsAsItsReadout() async throws {
        let straight = Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3)
        XCTAssertEqual(TargetEntry.Draft(straight).commitLabel, "Set · 3 × 8 · 60")
        let window = await host(sheet(straight, movement: "Bench Press", place: "1 of 5 · Push A"))
        let drawn = fields(in: window)
        XCTAssertEqual(drawn.map(\.text), ["3", "8", "60", "8", "60", "8", "60", "8", "60"])
        XCTAssertEqual(drawn.prefix(3).map(\.placeholder),
                       [TargetEntry.setsPlaceholder, TargetEntry.repsPlaceholder, TargetEntry.weightPlaceholder])
    }

    // `±` stands on the load fields alone, and only when the movement is loaded by bodyweight: the
    // head's Weight and each ladder row's load — six on the ramp, none on a barbell.
    func testTheSignStandsOnEveryLoadFieldOfABodyweightMovementAndNowhereElse() async throws {
        let source = try sheetSource()
        XCTAssertEqual(source.components(separatedBy: "if signed { sign(").count - 1, 2, "the head's load and the row's load")
        XCTAssertEqual(source.components(separatedBy: "sign(").count - 1, 3, "those two sites and the one definition")
        XCTAssertTrue(source.contains("signed: signed)"), "the head's Weight takes the movement's own answer")
        XCTAssertTrue(source.contains("focus: .sets, signed: false)"))
        XCTAssertTrue(source.contains("focus: .reps, signed: false)"))
        XCTAssertTrue(source.contains(".accessibilityLabel(KeypadEntry.flipTheSign)"))

        let signed = await host(sheet(ramp, movement: "Dip", place: "1 of 2 · Lower A", signed: true))
        XCTAssertEqual(fields(in: signed).count, 13, "a signed sheet renders the same thirteen fields, five rows under the head")
    }
}
