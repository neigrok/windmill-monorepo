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
    // (`13-gestures.md` Law 2). Nothing here may say it cannot be undone, because it can. Drawn on
    // the session detail page and the log row's menu; the receipt itself carries no discard.
    public enum Discard {
        public static let action = "Discard session"
    }

    // The head congratulates an ordinary session. A slight one keeps `Ended early.`: a congratulation
    // on two sets would be a small lie. Android's bytes exactly (`ui/FinishScreen.kt`).
    public static func head(startedAtMs: Int64, finishedAtMs: Int64, routine: String?,
                            slight: Bool, first: Bool) -> Head {
        Head(title: slight ? "Ended early." : "Well done.",
             subtitle: routine ?? (first ? "Your first session" : "No routine"),
             when: "\(Readout.day(startedAtMs)) · \(Readout.time(startedAtMs)) – \(Readout.time(finishedAtMs))")
    }

    // With no loaded working set there is no honest estimate, so the tile prints a dash rather than a zero.
    public static func tiles(_ stats: Review.Stats) -> [Tile] {
        [Tile(value: Readout.duration(stats.durationMs), label: "Duration"),
         Tile(value: String(stats.workingSets), label: "Working sets"),
         Tile(value: stats.topE1rm.map(Readout.weight) ?? "—", label: "Top e1RM")]
    }

    // What the receipt says once the log has taken the routine. The form is gone by then, so this is
    // the whole of the answer, and the room's own note line is behind this sheet. Android's words
    // exactly (`ui/FinishScreen.kt` `keptAs`).
    public static func keptAs(_ name: String) -> String {
        "Kept as \(RoutineDraft.trimmed(name))."
    }

    // Why `Save routine` is grey, in the routine editor's own words — and by the routine editor's own
    // predicate, so a name means one thing on this surface. The empty field is the reason the button
    // is dead RIGHT NOW, so it comes first: a refusal the log raised is older than the name that has
    // since been cleared, and it cannot be raised again while Save cannot be pressed.
    public static func keepRefusal(name: String, failure: String?) -> String? {
        guard RoutineDraft.isNamed(name) else { return RoutineDraft.nameItToSaveIt }
        return failure
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

// The receipt's one primary: it hands the closed workout to Coach by sending ONE line through the
// same path a typed question takes, so the thread is titled by it, the ceilings apply and every
// refusal is drawn as usual. No session id travels with it — Coach's `list_sessions` is newest
// first, and the agent finds the workout itself. Android's bytes exactly (`Finish.kt` `FinishCoach`).
public enum FinishCoach {
    public static let action = "Share with Coach"
    public static let caption = "Sends Coach one line — “Check my last session.” — and opens the answer."
    public static let question = "Check my last session."
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
    // A refusal from `keep`, drawn HERE under the button that raised it, because this sheet covers
    // the room's own note line. It is the receipt's only write, so the only refusal that can land here.
    let failure: String?
    let onKeepRoutine: (String) -> Void
    // Nil when Coach cannot be reached — signed out, or no Coach on this deployment — and then
    // nothing stands in the primary's place: the receipt is the head, the readout, the optional
    // routine card and the dismissal.
    let onShareWithCoach: (() -> Void)?
    let onDone: () -> Void

    @Environment(\.gymSkin) private var skin
    // Seeded here rather than in a `.task`, which runs only after the first frame: the sheet would
    // animate in with an empty field, a grey Save and the empty-name refusal under it, refusing a
    // lifter for something they have not touched.
    @State private var routineName: String

    init(finished: FinishedSession, catalog: [Exercise], kept: Bool, failure: String?,
         onKeepRoutine: @escaping (String) -> Void, onShareWithCoach: (() -> Void)?,
         onDone: @escaping () -> Void) {
        self.finished = finished
        self.catalog = catalog
        self.kept = kept
        self.failure = failure
        self.onKeepRoutine = onKeepRoutine
        self.onShareWithCoach = onShareWithCoach
        self.onDone = onDone
        _routineName = State(initialValue: Readout.weekday(finished.session.startedAtMs))
    }

    var body: some View {
        let head = Finish.head(startedAtMs: finished.session.startedAtMs,
                               finishedAtMs: finished.session.finishedAtMs ?? finished.session.startedAtMs,
                               routine: finished.routine,
                               slight: finished.slight,
                               first: finished.isFirst)
        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                    // The title stays in the content and never becomes the bar's: it is the largest
                    // thing on the screen, and `Ended early.` is the whole salience of a slight session.
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

                    // On both branches, the slight one included: the receipt's single full-strength
                    // button. The share LINK card is not here — it stays on the session detail page
                    // and the log row's menu, because two share verbs on one receipt are two meanings.
                    if let onShareWithCoach { shareWithCoach(onShareWithCoach) }

                    if finished.offersRoutine {
                        // The keep is the one thing this receipt does that writes, so it is the one
                        // thing the receipt owes an answer for. The form it stood in is gone by then
                        // and the room's own line is behind this sheet, which leaves one sentence
                        // where the form was.
                        if kept {
                            Text(Finish.keptAs(routineName))
                                .font(WindmillFont.body(16))
                                .foregroundStyle(skin.inkDim)
                        } else {
                            keepAsRoutine
                        }
                    }

                }
                .padding(.horizontal, WindmillSpace.x5)
                .padding(.top, WindmillSpace.x4)
                .padding(.bottom, WindmillSpace.x8)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Exactly one dismissal, on every state. Dismissing writes nothing — the session was
                // closed and saved before the sheet appeared, and the one control that DOES write is
                // the card's — so it is a toolbar action beside the drag indicator rather than a
                // full-strength button in the reach band (`12-native-idiom.md`). A receipt is read
                // sitting down after the workout and never reached for mid-set, which is the
                // destination `thumb-reach.md` §2 exempts from its top-corner rule, and the swipe
                // stays in the thumb band besides.
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                }
            }
        }
    }

    private func shareWithCoach(_ action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Button(FinishCoach.action, action: action)
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            Text(FinishCoach.caption)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
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
                    // The section head is the only thing naming this field, and a head is not a
                    // label: without this VoiceOver reads the weekday and nothing else.
                    .accessibilityLabel("Routine name")
                    // The room's cap, counted the room's way — sixty CODE POINTS, the editor's own
                    // rule, so a name is bounded the same wherever it is minted. The editor's counter
                    // does not come with it: it earns its place on the surface a lifter works a name
                    // on, and a receipt mints one in passing.
                    .onChange(of: routineName) { _, typed in
                        let kept = RoutineDraft.capped(typed)
                        guard kept != typed else { return }
                        routineName = kept
                    }
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
            .disabled(unnamed)

            // Which of the two the slot is carrying decides the ink, on the same predicate that
            // decides the sentence: the empty name takes the faint ink because nothing was sent and
            // nothing was refused, and only the log's own refusal takes the alarm (`GymSkin`).
            refusal(Finish.keepRefusal(name: routineName, failure: failure),
                    ink: unnamed ? skin.inkFaint : skin.alarmInk)
        }
        .padding(WindmillSpace.x4)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(skin.accent, lineWidth: 1))
    }

    private var unnamed: Bool { !RoutineDraft.isNamed(routineName) }

    @ViewBuilder
    private func refusal(_ line: String?, ink: Color) -> some View {
        if let line {
            Text(line)
                .font(GymType.numeral(12.5))
                .foregroundStyle(ink)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func target(_ entry: RoutineWrite.Entry) -> String {
        Readout.target(sets: entry.targetSets, reps: entry.targetReps, weightKg: entry.targetWeightKg)
    }
}
