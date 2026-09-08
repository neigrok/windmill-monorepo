import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym

// The slot strip is proved on the row the logger draws it with. A hosted SwiftUI tree hands nothing
// to UIKit's accessibility while the accessibility runtime is off, as it is in a test process, so
// what VoiceOver hears is read off the row's own `spoken` — the one string the row puts on the
// channel — and the rendered column is measured for its rows.
@MainActor
final class LoggerSlotsHostingTests: XCTestCase {
    private func column(_ slots: [LiveLines.Slot]) -> some View {
        VStack(spacing: 8) {
            ForEach(slots) { slot in SlotRow(slot: slot) }
        }
        .environment(\.gymSkin, GymSkin.instrument)
    }

    // The rack fixture: sets 1 and 2 landed as planned against the ramp, set 3 current.
    func testTheStripSpeaksEveryPillAsOneSentenceAndNoPlannedPillIsADoor() throws {
        let ramp = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80),
                    SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100),
                    SetTarget(reps: 5, weightKg: 80)]
        let landed = [
            TrainingSet(id: "s1", exerciseId: "back-squat", weightKg: 60, reps: 5, completedAtMs: 1_000),
            TrainingSet(id: "s2", exerciseId: "back-squat", weightKg: 80, reps: 5, completedAtMs: 2_000),
        ]
        let slots = LiveLines.slots(landed, plan: PlanEntry(exerciseId: "back-squat", sets: ramp), stalled: [])

        XCTAssertEqual(slots.map { SlotRow(slot: $0).spoken }, [
            "set 1, 60 × 5",
            "set 2, 80 × 5",
            "set 3, target 90 × 3",
            "set 4, target 100 × 1",
            "set 5, target 80 × 5",
        ])

        let drawn = UIHostingController(rootView: column(slots))
            .sizeThatFits(in: CGSize(width: 390, height: CGFloat.infinity))
        XCTAssertGreaterThanOrEqual(drawn.height, 5 * GymTap.minimum + 4 * 8, "five pills, each a tap target tall")

        // The logger opens no fix sheet of its own — the session page does — so a landed pill is a
        // row today, and a planned pill is never a door: there is nothing to fix yet.
        let screen = try gymSource("LoggerScreen.swift")
        let row = try XCTUnwrap(screen.range(of: "struct SlotRow: View {"))
        let rule = try XCTUnwrap(screen.range(of: "struct TypeableRule: View {", range: row.upperBound..<screen.endIndex))
        XCTAssertFalse(screen[row.upperBound..<rule.lowerBound].contains("Button"), "a pill became a door")
        XCTAssertTrue(screen[row.upperBound..<rule.lowerBound].contains(".accessibilityLabel(spoken)"),
                      "the pill is spoken as one sentence, never as its parts")
    }

    func testAWarmupAndAStalledSetSpeakWhatTheyAre() {
        let sets = [
            TrainingSet(id: "w1", exerciseId: "chin-up", weightKg: 0, reps: 8, kind: .warmup, completedAtMs: 1_000),
            TrainingSet(id: "s1", exerciseId: "chin-up", weightKg: 10, reps: 8, completedAtMs: 2_000),
        ]
        let plan = PlanEntry(exerciseId: "chin-up", sets: [SetTarget(reps: 8, weightKg: 10), SetTarget(reps: 8)])

        XCTAssertEqual(LiveLines.slots(sets, plan: plan, stalled: ["s1"]).map { SlotRow(slot: $0).spoken }, [
            "warmup, 0 × 8",
            "set 1, 10 × 8, on this device",
            "set 2, target last × 8",
        ])
    }

    // The set line is one line in one place: the count, then the current slot's target after a
    // middle dot, and the head under the title no longer carries a target of its own.
    func testTheSetLineIsOneLineOverTheNumeralAndTheHeadCarriesNoTarget() throws {
        let screen = try gymSource("LoggerScreen.swift")
        let head = try XCTUnwrap(screen.range(of: "private var movementHead: some View {"))
        let stroke = try XCTUnwrap(screen.range(of: "private var walkStroke: some Gesture {", range: head.upperBound..<screen.endIndex))
        XCTAssertFalse(screen[head.upperBound..<stroke.lowerBound].contains("counter.target"),
                       "the head still draws the target under the title")

        let line = try XCTUnwrap(screen.range(of: "private var setLine: Text {"))
        let value = try XCTUnwrap(screen.range(of: "private var value: some View {", range: line.upperBound..<screen.endIndex))
        let body = screen[line.upperBound..<value.lowerBound]
        XCTAssertTrue(body.contains("counter.count.prefix(1).uppercased() + counter.count.dropFirst()"),
                      "the count is capitalised at the draw site and nowhere in the domain")
        XCTAssertTrue(body.contains("Text(\" · \\(target)\").foregroundStyle(skin.targetInk)"),
                      "the tail is the target, in the target ink, after a middle dot")
        XCTAssertEqual(screen.components(separatedBy: "counter.count").count, 3, "the count is drawn once")
    }
}
