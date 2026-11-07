import Testing
import DomainKit
import GymDomain
@testable import Windmill

@MainActor struct MovementRowTests {
  @Test func theRowsLineReadsAStraightSchemeAsFactsAndAVariedOneAsASequence() {
    let barbell = MovementEquipment("barbell"), dumbbells = MovementEquipment("dumbbell"), bodyweight = MovementEquipment("bodyweight")
    let bench = MovementPlanLine(Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3), restSeconds: 120, equipment: barbell)
    #expect(bench.facts.map { [$0.symbol, $0.text] } == [["repeat", "3 sets"], ["number", "8 reps"], ["scalemass", "60 kg total"]])
    #expect(bench.sequence.isEmpty && bench.rest == "2:00" && !bench.isOpen)
    #expect(bench.spoken == "3 sets, 8 reps, 60 kg total, rest 2 minutes")
    let incline = MovementPlanLine([SetTarget(reps: 10, weightKg: 16), SetTarget(reps: 8, weightKg: 18), SetTarget(reps: 6, weightKg: 20)], restSeconds: 90, equipment: dumbbells)
    #expect(incline.facts.isEmpty && incline.sequence == ["16×10", "18×8", "20×6"] && incline.rest == "1:30")
    #expect(incline.spoken == "16×10, then 18×8, then 20×6, rest 1 minute 30 seconds")
    let chinUp = MovementPlanLine(Array(repeating: SetTarget(reps: 8, weightKg: 0), count: 3), restSeconds: nil, equipment: bodyweight)
    #expect(chinUp.facts.map(\.text) == ["3 sets", "8 reps", "bodyweight"] && chinUp.rest == nil)
    let assisted = MovementPlanLine([SetTarget(reps: 8, weightKg: -10)], restSeconds: nil, equipment: bodyweight)
    #expect(assisted.facts.map(\.text) == ["1 set", "8 reps", "−10 kg added"])
    let lastTime = MovementPlanLine(Array(repeating: SetTarget(), count: 3), restSeconds: nil, equipment: MovementEquipment("cable"))
    #expect(lastTime.facts.map(\.text) == ["3 sets", "Max reps"] && lastTime.spoken == "3 sets, Max reps")
    let open = MovementPlanLine(nil, restSeconds: 60, equipment: barbell)
    #expect(open.isOpen && open.spoken == "Open plan, rest 1 minute")
    #expect(MovementPlanLine([], restSeconds: nil, equipment: barbell).isOpen)
    let mixed = MovementPlanLine([SetTarget(reps: 5, weightKg: 100), SetTarget(reps: nil, weightKg: nil)], restSeconds: nil, equipment: barbell)
    #expect(mixed.sequence == ["100×5", "last×max"])
  }
}
