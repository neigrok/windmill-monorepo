import SwiftUI
import WindmillPlatform

public struct Deviation: Equatable {
    public let exerciseId: String
    public let routineId: String
    public let routine: String
    // Routine position of the plan line this addresses: a program may hold the same movement twice.
    public let position: Int
    // The plan line's scheme, and what Save writes over it: on a straight scheme every load at the
    // lifted weight; on a ladder the working sets as lifted, in order.
    public let planned: [SetTarget]
    public let offered: [SetTarget]
    // The heaviest named planned load, and the heaviest working load lifted.
    public let plannedKg: Double
    public let liftedKg: Double

    // Raised when the heaviest working set beat the heaviest named planned load — on the line with the
    // heaviest, when a program holds the movement twice. The snapshot carries no positions: plan index
    // i is routine position i + 1. A ladder's offer is the sets as lifted, and a routine line holds
    // twenty at most: past that there is nothing the sheet could save, so it does not rise.
    public init?(leaving exerciseId: String, session: Session?, sets: [TrainingSet], asked: Set<String>) {
        guard let session, let routineId = session.routineId, let plan = session.plan else { return nil }
        guard !asked.contains(exerciseId) else { return nil }
        let planned = plan.entries.enumerated()
            .filter { $0.element.exerciseId == exerciseId }
            .compactMap { index, entry in
                entry.sets.compactMap(\.weightKg).max().map { (position: index + 1, entry: entry, weightKg: $0) }
            }
            .max { $0.weightKg < $1.weightKg }
        guard let planned else { return nil }
        let working = sets.filter { $0.exerciseId == exerciseId && $0.kind == .working }
            .sorted { $0.completedAtMs < $1.completedAtMs }
        guard let lifted = working.map(\.weightKg).max(), lifted > planned.weightKg else { return nil }
        guard SetTarget.agree(planned.entry.sets) || working.count <= TargetEntry.setsBand.upperBound else {
            return nil
        }

        self.exerciseId = exerciseId
        self.routineId = routineId
        self.routine = plan.routine
        self.position = planned.position
        self.planned = planned.entry.sets
        self.plannedKg = planned.weightKg
        self.liftedKg = lifted
        offered = SetTarget.agree(planned.entry.sets)
            ? planned.entry.sets.map { SetTarget(reps: $0.reps, weightKg: lifted) }
            : working.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) }
    }

    public var isLadder: Bool { !SetTarget.agree(planned) }

    public func sentence(movement: String) -> String {
        "Today’s \(movement) ran at \(Readout.weight(liftedKg)) against a planned "
            + "\(Readout.weight(plannedKg)). Today’s session already has it. \(routine) does not."
    }

    public var saveLabel: String {
        guard isLadder else { return "Save \(Readout.weight(liftedKg)) to \(routine)" }
        return "Save today’s sets"
    }
}

struct DeviationSheet: View {
    let deviation: Deviation
    let movement: String
    let onSave: () -> Void
    let onToday: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: GymLayout.sectionGap) {
            Text("Heavier than the plan")
                .font(WindmillFont.display(22))
                .foregroundStyle(skin.ink)

            Text(deviation.sentence(movement: movement))
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)

            // On a scheme whose sets disagree the honest offer is the sets as lifted, so the sheet
            // draws them against the plan, set by set, in the review's own row.
            if deviation.isLadder {
                LadderLines(before: deviation.planned.map(Readout.set),
                            after: deviation.offered.map(Readout.set))
            }

            Button(action: onSave) {
                Text(deviation.saveLabel)
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }

            Button(action: onToday) {
                Text("Today only")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.inkDim)
                    .frame(maxWidth: .infinity, minHeight: GymTap.row)
            }
        }
        .padding(GymLayout.gutter)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(skin.surface)
    }
}
