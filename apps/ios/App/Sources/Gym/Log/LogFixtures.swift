import Foundation
import SwiftUI
import DomainKit
import GymDomain

extension LogTab {
  func prepareLogFixture() {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-gym-log-fixture"), gym.finishedLogSessions.isEmpty,
          let now = gym.log?.moment.now else { return }
    let bench = SeedExercises.all.first { $0.name == "Bench Press" }!
    let squat = SeedExercises.all.first { $0.name == "Back Squat" }!
    let routine = Routine(id: gym.runner.mint(Routine.self), name: "Push A", entries: [RoutineEntry(exerciseId: bench.id, sets: [SetTarget(reps: 5, weightKg: 60)])])
    var routineDraft = Draft(new: routine); _ = gym.save(&routineDraft)
    for index in 0..<35 {
      let start = Instant(ms: now.ms - Int64(35 - index) * 3 * 86_400_000)
      let id = gym.runner.mint(Session.self)
      let sets = [ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: bench.id, weightKg: Double(50 + index), reps: 5, completedAt: Instant(ms: start.ms + 600_000), rpe: 8, note: index == 34 ? "Smooth last set." : ""),
                  ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: squat.id, weightKg: 100, reps: 12, completedAt: Instant(ms: start.ms + 1_200_000))]
      gym.run(ImportSession(id: id, startedAt: start, finishedAt: Instant(ms: start.ms + 2_700_000), sets: sets, routineId: routine.id))
    }
    let offsets = ProcessInfo.processInfo.arguments.contains("-gym-chart-overflow-fixture") ? (0..<40).map { $0 * 3 } : [0, 3, 6, 9, 30, 33]
    for offset in offsets {
      let day = gym.log!.moment.today.adding(days: -offset)
      var draft = Draft(new: WeighIn(day: day, kg: 82.4 + Double(offset) / 30)); _ = gym.save(&draft)
    }
    #endif
  }
}
