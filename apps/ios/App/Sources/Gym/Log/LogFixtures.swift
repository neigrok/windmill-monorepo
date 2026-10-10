import Foundation
import SwiftUI
import DomainKit
import GymDomain

extension LogTab {
  func prepareLogFixture() {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-gym-log-fixture"), gym.finishedLogSessions.isEmpty,
          let moment = gym.log?.moment else { return }
    let bench = SeedExercises.all.first { $0.name == "Bench Press" }!
    let squat = SeedExercises.all.first { $0.name == "Back Squat" }!
    let routine = Routine(id: gym.runner.mint(Routine.self), name: "Push A", entries: [RoutineEntry(exerciseId: bench.id, sets: [SetTarget(reps: 5, weightKg: 60)])])
    // The seed writes through the runner and the gym reads once at the end, not once per record it seeds.
    var refused = 0
    var routineDraft = Draft(new: routine)
    if case .saved = gym.runner.save(&routineDraft, SaveDraft<Routine, GymRefusal>.self) {} else { refused += 1 }
    for index in 0..<35 {
      let start = Instant(ms: moment.now.ms - Int64(35 - index) * 3 * 86_400_000)
      let id = gym.runner.mint(Session.self)
      let sets = [ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: bench.id, weightKg: Double(50 + index), reps: 5, completedAt: Instant(ms: start.ms + 600_000), rpe: 8, note: index == 34 ? "Smooth last set." : ""),
                  ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: squat.id, weightKg: 100, reps: 12, completedAt: Instant(ms: start.ms + 1_200_000))]
      let imported = try? gym.runner.run(ImportSession(id: id, startedAt: start, finishedAt: Instant(ms: start.ms + 2_700_000), sets: sets, routineId: routine.id))
      if imported == nil || imported?.refusal != nil { refused += 1 }
    }
    let offsets = ProcessInfo.processInfo.arguments.contains("-gym-chart-overflow-fixture") ? (0..<40).map { $0 * 3 } : [0, 3, 6, 9, 30, 33]
    for offset in offsets {
      var draft = Draft(new: WeighIn(day: moment.today.adding(days: -offset), kg: 82.4 + Double(offset) / 30))
      if case .saved = gym.runner.save(&draft, SaveDraft<WeighIn, GymRefusal>.self) {} else { refused += 1 }
    }
    gym.refresh()
    if refused > 0 { gym.error = "The log fixture could not be seeded." }
    #endif
  }
}
