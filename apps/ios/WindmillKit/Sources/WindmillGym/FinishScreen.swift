import SwiftUI
import WindmillPlatform

// Renders the `Review` the domain computed; nothing here computes an e1RM, a record or a comparison.
// The native twin of web/src/products/gym/review.js.

public enum Finish {
    public struct Head: Equatable {
        public let title: String
        public let subtitle: String
        public let when: String
    }

    public struct Tile: Equatable, Identifiable {
        public let value: String
        public let label: String
        public var id: String { label }
    }

    public struct Row: Equatable, Identifiable {
        public let id: String
        public let movement: String
        public let detail: String
    }

    public struct Comparison: Equatable {
        public let title: String
        public let rows: [Row]
    }

    // Discarding is withheld for nine seconds and taken back on the room's transient, so it asks
    // nothing first: a confirmation on an act that has an undo is a tap that buys nothing
    // (`13-gestures.md` Law 2). Nothing here may say it cannot be undone, because it can.
    public enum Discard {
        public static let action = "Discard session"
    }

    public static func head(startedAtMs: Int64, finishedAtMs: Int64, routine: String?,
                            slight: Bool, first: Bool) -> Head {
        Head(title: slight ? "Ended early" : "Session finished",
             subtitle: routine ?? (first ? "Your first session" : "No routine"),
             when: "\(Readout.day(startedAtMs)) · \(Readout.time(startedAtMs)) – \(Readout.time(finishedAtMs))")
    }

    // With no loaded working set there is no honest estimate, so the tile prints a dash rather than a zero.
    public static func tiles(_ stats: Review.Stats) -> [Tile] {
        [Tile(value: Readout.duration(stats.durationMs), label: "Duration"),
         Tile(value: String(stats.workingSets), label: "Working sets"),
         Tile(value: stats.topE1rm.map(Readout.weight) ?? "—", label: "Top e1RM")]
    }

    // A kind this build has never heard of draws nothing; the slot is allowed to be empty.
    public static func recordSentence(_ record: PersonalRecord?, catalog: [Exercise]) -> String? {
        guard let record else { return nil }
        let movement = Readout.movement(record.exerciseId, in: catalog)
        let past = "past \(Readout.weight(record.previous)) from \(Readout.day(record.previousAtMs))"
        switch record.kind {
        case .e1rm:
            return "\(movement) e1RM \(Readout.weight(record.value)) kg — \(past)."
        case .heaviest:
            return "\(movement) \(Readout.weight(record.value)) kg × \(record.reps) — \(past)."
        case .repsAtWeight:
            return "\(movement) \(record.reps) reps at \(Readout.weight(record.weightKg)) kg — \(past)."
        }
    }

    public static func comparison(_ against: Against?, catalog: [Exercise]) -> Comparison? {
        guard let against else { return nil }
        return Comparison(
            title: "Against last \(against.routine)",
            rows: against.movements.map { movement in
                Row(id: movement.exerciseId,
                    movement: Readout.movement(movement.exerciseId, in: catalog),
                    detail: detail(movement))
            }
        )
    }

    // The predicate for "fell short" is review.js `detailOf`'s exactly: reps are the only axis, and only when the bar did
    // not go up — `now.sets` counts the sets at the top load alone.
    private static func detail(_ movement: Against.Movement) -> String {
        // An open target is nothing to measure against, so the row falls through to last time.
        let planned = movement.planned.flatMap { $0.isOpen ? nil : $0 }
        if let planned, let target = planned.reps, let sets = planned.sets,
           movement.now.reps < target,
           planned.weightKg.map({ movement.now.weightKg <= $0 }) ?? true {
            return "planned \(count(sets, target)) · did \(count(movement.now.sets, movement.now.reps))"
        }
        if let planned, let sets = planned.sets {
            return "\(top(sets, planned.reps, planned.weightKg)) → \(top(movement.now))"
        }
        if let before = movement.before {
            return "\(top(before)) → \(top(movement.now))"
        }
        return top(movement.now)
    }

    // Spacing is review.js `countLabel`'s: `3 × max` when the target is absent, `5×5` when it is named.
    private static func count(_ sets: Int, _ reps: Int?) -> String {
        guard let reps else { return "\(sets) × \(Readout.repTarget(nil))" }
        return "\(sets)×\(reps)"
    }

    // Zero is the absence of a load, not a load: a band-assisted −20 still reads its own.
    private static func top(_ sets: Int, _ reps: Int?, _ weightKg: Double?) -> String {
        guard let weightKg, weightKg != 0 else { return count(sets, reps) }
        return "\(count(sets, reps)) @ \(Readout.weight(weightKg))"
    }

    private static func top(_ effort: Against.Effort) -> String {
        top(effort.sets, effort.reps, effort.weightKg)
    }
}

// The sets travel with it: the queue drops a delivered row the moment its session closes.
struct FinishedSession: Equatable, Identifiable {
    let session: Session
    let sets: [TrainingSet]
    let review: Review?
    let isFirst: Bool

    var id: String { session.id }

    var routine: String? { session.plan?.routine }
    var slight: Bool { review?.slight ?? false }

    var offersRoutine: Bool {
        !slight && session.routineId == nil && sets.contains { $0.kind == .working }
    }
}

// `stats` is off where the session detail's head already states those three facts.
struct ReviewReadout: View {
    let review: Review?
    let catalog: [Exercise]
    var stats = true

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            if let review {
                if stats { tiles(review.stats) }
                if let sentence = Finish.recordSentence(review.record, catalog: catalog) {
                    record(sentence)
                }
                if let comparison = Finish.comparison(review.against, catalog: catalog) {
                    against(comparison)
                }
            } else if stats {
                Text("the log didn’t answer — the session is saved")
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tiles(_ stats: Review.Stats) -> some View {
        HStack(alignment: .top, spacing: WindmillSpace.x3) {
            ForEach(Finish.tiles(stats)) { tile in
                VStack(alignment: .leading, spacing: WindmillSpace.x1) {
                    Text(tile.value)
                        .font(GymType.numeral(26, .semibold))
                        .foregroundStyle(skin.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(tile.label)
                        .font(GymType.numeral(11))
                        .foregroundStyle(skin.inkFaint)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(WindmillSpace.x4)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
    }

    private func record(_ sentence: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("Personal record")
                .font(GymType.numeral(11))
                .foregroundStyle(skin.prInk)
            Text(sentence)
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.prInk.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(skin.prInk.opacity(0.35), lineWidth: 1))
    }

    private func against(_ comparison: Finish.Comparison) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(comparison.title)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
            ForEach(comparison.rows) { row in
                HStack(alignment: .firstTextBaseline) {
                    Text(row.movement)
                        .font(WindmillFont.body(15))
                        .foregroundStyle(skin.ink)
                    Spacer(minLength: WindmillSpace.x3)
                    Text(row.detail)
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkDim)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct FinishScreen: View {
    let finished: FinishedSession
    let catalog: [Exercise]
    // Answered by the room after the log said so, never on the tap.
    let kept: Bool
    let coach: CoachDoors
    // A refusal from `keep` or `discard`. It is drawn HERE, under the control that raised it, because
    // this sheet covers the room's own note line; the two sites below are mutually exclusive (a
    // discard is offered only for a slight session, a keep only for one that offers a routine).
    let failure: String?
    let onKeepRoutine: (String) -> Void
    let onDiscard: () -> Void
    let onDone: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var routineName = ""

    var body: some View {
        let head = Finish.head(startedAtMs: finished.session.startedAtMs,
                               finishedAtMs: finished.session.finishedAtMs ?? finished.session.startedAtMs,
                               routine: finished.routine,
                               slight: finished.slight,
                               first: finished.isFirst)
        return ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                VStack(alignment: .leading, spacing: WindmillSpace.x1) {
                    Text(head.title)
                        .font(WindmillFont.display(30))
                        .foregroundStyle(skin.ink)
                    Text(head.subtitle)
                        .font(WindmillFont.body(17))
                        .foregroundStyle(skin.inkDim)
                    Text(head.when)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                }

                ReviewReadout(review: finished.review, catalog: catalog)

                if finished.offersRoutine && !kept { keepAsRoutine }

                if !finished.slight { CoachShareCard(doors: coach) }

                actions
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x12)
        }
        .task { routineName = Readout.weekday(finished.session.startedAtMs) }
    }

    private var keepAsRoutine: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text("Keep this as a routine")
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(skin.accent)

            HStack(spacing: WindmillSpace.x3) {
                TextField("", text: $routineName)
                    .font(WindmillFont.body(17, .semibold))
                    .foregroundStyle(skin.ink)
                    .textFieldStyle(.plain)
                    .frame(minHeight: GymTap.minimum)
                Text("tap to rename")
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            .padding(.horizontal, WindmillSpace.x3)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.lineStrong, lineWidth: 1))

            ForEach(RoutineWrite(named: routineName, from: finished.sets, position: 0)?.entries ?? [],
                    id: \.exerciseId) { entry in
                HStack {
                    Text(Readout.movement(entry.exerciseId, in: catalog))
                        .font(WindmillFont.body(15))
                        .foregroundStyle(skin.inkDim)
                    Spacer(minLength: WindmillSpace.x3)
                    Text(target(entry))
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.targetInk)
                }
            }

            Text("Today’s weights become next week’s targets.")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)

            Button { onKeepRoutine(routineName) } label: {
                Text("Save routine")
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .disabled(routineName.trimmingCharacters(in: .whitespaces).isEmpty)

            failureLine

            Button("Just keep the session", action: onDone)
                .font(WindmillFont.body(16, .semibold))
                .foregroundStyle(skin.inkDim)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
        }
        .padding(WindmillSpace.x4)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(skin.accent, lineWidth: 1))
    }

    // The session leaves the log at once and the transient carries the way back for nine seconds.
    @ViewBuilder
    private var actions: some View {
        if finished.slight {
            VStack(spacing: WindmillSpace.x3) {
                Button("Keep it", action: onDone)
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))

                Button(Finish.Discard.action, action: onDiscard)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.alarmInk)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)

                failureLine
            }
        } else if !finished.offersRoutine || kept {
            Button("Done", action: onDone)
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
    }

    @ViewBuilder
    private var failureLine: some View {
        if let failure {
            Text(failure)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.alarmInk)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func target(_ entry: RoutineWrite.Entry) -> String {
        Readout.target(sets: entry.targetSets, reps: entry.targetReps, weightKg: entry.targetWeightKg)
    }
}
