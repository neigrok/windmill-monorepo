import SwiftUI
import WindmillPlatform

// CHANGE TODAY, OR CHANGE THE PROGRAM — the one moment gym asks a question it did not have to ask.
// The plan snapshot is frozen, so last Tuesday keeps reading correctly whichever way this is
// answered; what is at stake is only whether next week's target moves with the lifter.
//
// THE SERVER NEVER INFERS THIS. It never auto-writes a routine and never asks — a store that noticed
// a heavier set and quietly rewrote the program would be changing what somebody wrote down, on the
// evidence of one afternoon. The offer is the client's, it is raised ONCE per movement per session
// at the exercise boundary, and declining costs nothing.
//
// ONLY HEAVIER. The design's own title says so and the restriction is the honest half of the rule:
// dropping the weight mid-exercise is a bad night far more often than it is a decision, and writing
// that back would lower next week's target off one session and then read as a failed session every
// time it came round.

public struct Deviation: Equatable {
    public let exerciseId: String
    public let routineId: String
    public let routine: String
    public let plannedKg: Double
    public let liftedKg: Double

    // The heaviest WORKING set of the movement being left, against the weight the frozen snapshot
    // named for it. Warmups, drops and failures are not what the session was, so none of them can
    // raise this.
    public init?(leaving exerciseId: String, session: Session?, sets: [TrainingSet], asked: Set<String>) {
        guard let session, let routineId = session.routineId, let plan = session.plan else { return nil }
        guard !asked.contains(exerciseId) else { return nil }
        guard let planned = plan.entry(for: exerciseId)?.weightKg else { return nil }
        let working = sets.filter { $0.exerciseId == exerciseId && $0.kind == .working }
        guard let lifted = working.map(\.weightKg).max(), lifted > planned else { return nil }

        self.exerciseId = exerciseId
        self.routineId = routineId
        self.routine = plan.routine
        self.plannedKg = planned
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

            // "Asked once, when you leave the exercise — never again this session" was drawn here
            // until 2026-08-12. It described when this sheet appears, to somebody already looking at
            // it — which is the room explaining its own timing rather than telling a lifter anything
            // about their training. The rule it described is unchanged and lives in `Deviation`.
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
