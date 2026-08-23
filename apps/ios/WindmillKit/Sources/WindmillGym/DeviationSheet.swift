import SwiftUI
import WindmillPlatform

public struct Deviation: Equatable {
    public let exerciseId: String
    public let routineId: String
    public let routine: String
    // Routine position of the plan line this addresses: a program may hold the same movement twice.
    public let position: Int
    public let plannedKg: Double
    public let liftedKg: Double

    // The snapshot carries no positions: plan index i is routine position i + 1.
    public init?(leaving exerciseId: String, session: Session?, sets: [TrainingSet], asked: Set<String>) {
        guard let session, let routineId = session.routineId, let plan = session.plan else { return nil }
        guard !asked.contains(exerciseId) else { return nil }
        let planned = plan.entries.enumerated()
            .filter { $0.element.exerciseId == exerciseId }
            .compactMap { index, entry in entry.weightKg.map { (position: index + 1, weightKg: $0) } }
            .max { $0.weightKg < $1.weightKg }
        guard let planned else { return nil }
        let working = sets.filter { $0.exerciseId == exerciseId && $0.kind == .working }
        guard let lifted = working.map(\.weightKg).max(), lifted > planned.weightKg else { return nil }

        self.exerciseId = exerciseId
        self.routineId = routineId
        self.routine = plan.routine
        self.position = planned.position
        self.plannedKg = planned.weightKg
        self.liftedKg = lifted
    }

    public func sentence(movement: String) -> String {
        "Today’s \(movement) ran at \(Readout.weight(liftedKg)) against a planned "
            + "\(Readout.weight(plannedKg)). Today’s session already has it. \(routine) does not."
    }

    public var saveLabel: String { "Save \(Readout.weight(liftedKg)) to \(routine)" }
}

struct DeviationSheet: View {
    let deviation: Deviation
    let movement: String
    let onSave: () -> Void
    let onToday: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            Text("Heavier than the plan")
                .font(WindmillFont.display(22))
                .foregroundStyle(skin.ink)

            Text(deviation.sentence(movement: movement))
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)

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
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(skin.surface)
    }
}
