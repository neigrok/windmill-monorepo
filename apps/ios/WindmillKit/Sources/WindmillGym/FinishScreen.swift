import SwiftUI
import WindmillPlatform

// THE END OF A SESSION — three facts, at most one line of meaning, and the movement-by-movement
// comparison under it. Everything here RENDERS the `Review` the domain computed and nothing here
// computes one: no e1RM, no record decision, no matching of one session against another. A second
// opinion drawn on the phone would be the product arguing with itself in its own loudest pixel.
//
// THE EMPTY SLOT IS A DECISION. On the ~190 sessions in 200 that earn nothing the record line is
// simply absent and nothing takes its place: no encouragement, no streak, no score. The comparison
// is a fact with a DIRECTION and never a grade, which is why nothing in it is a percentage and
// nothing in it is coloured.
//
// The one thing under the review is the coach share, and it is not a share SHEET: no social targets,
// no image, nothing discoverable. It mints one revocable, expiring link to this one workout, and
// CoachShare.swift is the whole of it. It is not drawn over a session that ended early — screen 11's
// question there is keep-or-discard, and a second offer beside a delete button competes with it.
//
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

    // A short session is not a failure and is not congratulated either — it is asked about, and the
    // word above it is the only thing that changes. Whether one came before it is a question about
    // the LOG, not about this session, which is why `first` is handed in.
    public static func head(startedAtMs: Int64, finishedAtMs: Int64, routine: String?,
                            slight: Bool, first: Bool) -> Head {
        Head(title: slight ? "Ended early" : "Session finished",
             subtitle: routine ?? (first ? "Your first session" : "No routine"),
             when: "\(Readout.day(startedAtMs)) · \(Readout.time(startedAtMs)) – \(Readout.time(finishedAtMs))")
    }

    // A session with no LOADED working set has no honest one-rep estimate — a chin-up at zero and a
    // band-assisted pull-up at −20 have none — so the tile says nothing with a dash rather than
    // printing a zero nobody lifted.
    public static func tiles(_ stats: Review.Stats) -> [Tile] {
        [Tile(value: Readout.duration(stats.durationMs), label: "Duration"),
         Tile(value: String(stats.workingSets), label: "Working sets"),
         Tile(value: stats.topE1rm.map(Readout.weight) ?? "—", label: "Top e1RM")]
    }

    // The rare loud line. The mark that was passed is named beside the one that passed it, because a
    // record with nothing to compare against is a first entry, and a first entry is not a record.
    //
    // A kind this build has never heard of draws NOTHING. The slot is allowed to be empty, and a
    // sentence assembled out of a rule we do not know is the one thing it may not hold.
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

    // "Against last Legs" — the same routine, the last time it ran, in the order this session
    // performed its movements.
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

    // Which reference the arrow points from: the PLAN when the session had one for that movement,
    // and last time when it did not — the plan is what the lifter agreed to and the log is what
    // happened. The one row that is not an arrow is the one that fell short: "planned 3×12 · did
    // 3×10" says the thing an arrow cannot.
    private static func detail(_ movement: Against.Movement) -> String {
        if let planned = movement.planned,
           movement.now.sets < planned.sets || planned.reps.map({ movement.now.reps < $0 }) == true {
            return "planned \(count(planned.sets, planned.reps)) · did \(count(movement.now.sets, movement.now.reps))"
        }
        if let planned = movement.planned {
            return "\(top(planned.sets, planned.reps, planned.weightKg)) → \(top(movement.now))"
        }
        if let before = movement.before {
            return "\(top(before)) → \(top(movement.now))"
        }
        return top(movement.now)
    }

    // Spaced when the target is absent and tight when it is named — `3 × max` beside `5×5` — which
    // is review.js `countLabel`'s own spelling, so one comparison row reads the same on both
    // surfaces. A movement taken to max never fell short of a rep target it does not have.
    private static func count(_ sets: Int, _ reps: Int?) -> String {
        guard let reps else { return "\(sets) × \(Readout.repTarget(nil))" }
        return "\(sets)×\(reps)"
    }

    // Zero is not a load, it is the absence of one: a chin-up reads `3×8`, and a band-assisted
    // pull-up at −20 still reads its load, because that is a real point on the number line here.
    private static func top(_ sets: Int, _ reps: Int?, _ weightKg: Double?) -> String {
        guard let weightKg, weightKg != 0 else { return count(sets, reps) }
        return "\(count(sets, reps)) @ \(Readout.weight(weightKg))"
    }

    private static func top(_ effort: Against.Effort) -> String {
        top(effort.sets, effort.reps, effort.weightKg)
    }
}

// A session that has just closed, held by the room until the lifter is done reading it. The sets
// travel with it because the log has let go of them by now — the queue drops a delivered row the
// moment its session closes — and "Keep this as a routine" is composed from exactly those sets.
struct FinishedSession: Equatable {
    let session: Session
    let sets: [TrainingSet]
    let review: Review?
    let isFirst: Bool

    var routine: String? { session.plan?.routine }
    var slight: Bool { review?.slight ?? false }

    // The offer belongs to a session that had nothing written down for it — a session started FROM
    // a routine already has one. Nothing is created until the tap, declining costs nothing, and the
    // offer comes back next session.
    //
    // NEVER OVER A SLIGHT SESSION. Screen 11 wins: a session too slight to say anything about is too
    // slight to be worth keeping as a routine, and drawing both would ask the lifter to name a
    // program and throw it away in the same scroll — two primary buttons and two different "keep"s.
    var offersRoutine: Bool {
        !slight && session.routineId == nil && sets.contains { $0.kind == .working }
    }
}

// ONE DRAWING OF A REVIEW, used by the screen a session ends on and by the screen it is revisited
// from. The three facts, the rare record line and the comparison are one readout, and two copies of
// it would be two chances for the product to say the same session two ways.
struct ReviewReadout: View {
    let review: Review?
    let catalog: [Exercise]

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            if let review {
                tiles(review.stats)
                if let sentence = Finish.recordSentence(review.record, catalog: catalog) {
                    record(sentence)
                }
                if let comparison = Finish.comparison(review.against, catalog: catalog) {
                    against(comparison)
                }
            } else {
                // The three facts are the domain's and this read did not come back. Nothing takes
                // their place: a duration counted on the phone would be a second opinion in the one
                // screen that exists to state the first.
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

    // The only loud thing in the product, and at most one per session. Gold is a KIND of moment
    // here, never a state — nothing else on this screen is allowed to borrow it.
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
    // Whether the routine WAS kept, answered by the room after the log said so. Held outside this
    // view on purpose: a screen that hid the offer on the tap would be telling the lifter their
    // program had changed on the strength of a request that may not have landed.
    let kept: Bool
    let coach: CoachDoors
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

                // Not over a session that ended early: that screen is asking whether to keep the
                // workout at all, and offering to send it to somebody in the same breath is two
                // questions where the design allows one.
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
                .font(WindmillFont.display(18))
                .foregroundStyle(skin.ink)

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

            Text("In the order you did them, with the weights you actually used as next week’s targets.")
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

            Button("Just keep the session", action: onDone)
                .font(WindmillFont.body(16, .semibold))
                .foregroundStyle(skin.inkDim)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
        }
        .padding(WindmillSpace.x4)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // The one destructive action in the product, and it sits here because a three-set session is
    // usually a phone left running rather than a workout. It deletes for good: nothing on this
    // screen may suggest it can be got back.
    @ViewBuilder
    private var actions: some View {
        if finished.slight {
            VStack(spacing: WindmillSpace.x3) {
                Button("Keep it", action: onDone)
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))

                Button("Discard session", action: onDiscard)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.alarmInk)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)

                Text("Discarding deletes the session and its sets. There is no undoing it.")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .multilineTextAlignment(.center)
            }
        } else if !finished.offersRoutine || kept {
            Button("Done", action: onDone)
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
    }

    private func target(_ entry: RoutineWrite.Entry) -> String {
        let count = "\(entry.targetSets) × \(Readout.repTarget(entry.targetReps))"
        guard let weight = entry.targetWeightKg, weight != 0 else { return count }
        return "\(count) · \(Readout.weight(weight))"
    }
}
