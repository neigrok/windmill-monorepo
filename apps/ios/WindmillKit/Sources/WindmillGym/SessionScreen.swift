import SwiftUI
import WindmillPlatform

// A SESSION, REVISITED — the door Today's "Last session" row has always pointed at and, until this
// wave, did not open. A row that reads as a destination and goes nowhere is the same defect this
// room refuses everywhere else (a primary button that fails, a tab bar over a screen that does not
// exist), so it is either a door or it is not a row: it is a door.
//
// It is the finished session and nothing else: the review the DOMAIN computed, every set as it was
// performed, and the coach share. It draws no editing of any kind — the log is append-only, the
// phone owns the OPEN session, and a screen that offered to change a closed one would be promising a
// route the wire does not have.

// The sets of a session as they are read back: grouped by movement in the order the movements were
// first touched, and inside a movement in the order the sets were performed. That is the order the
// session was LIVED in, and the same one "Keep this as a routine" composes a program from.
enum Performed {
    // Named for what it is on screen rather than for the domain's `TrainingSet`, which is also what
    // keeps it from shadowing the standard library's `Set` inside this namespace.
    struct Row: Equatable, Identifiable {
        let id: String
        let number: String
        let effort: String
        let kind: SetKind
    }

    struct Movement: Equatable, Identifiable {
        let id: String
        let movement: String
        let rows: [Row]
    }

    // `setNumber` is the LOG's own count of this movement in this session, and it is what the row
    // prints when it is there. A session read back from the log always carries it; the fallback is
    // the position in this movement's own run, so a row is never numberless.
    static func movements(_ sets: [TrainingSet], catalog: [Exercise]) -> [Movement] {
        let performed = sets.sorted { $0.completedAtMs < $1.completedAtMs }
        var order: [String] = []
        for set in performed where !order.contains(set.exerciseId) { order.append(set.exerciseId) }

        return order.map { exerciseId in
            let mine = performed.filter { $0.exerciseId == exerciseId }
            return Movement(
                id: exerciseId,
                movement: Readout.movement(exerciseId, in: catalog),
                rows: mine.enumerated().map { index, set in
                    Row(id: set.id,
                        number: String(set.setNumber ?? index + 1),
                        effort: Readout.effort(weightKg: set.weightKg, reps: set.reps),
                        kind: set.kind)
                })
        }
    }
}

struct SessionScreen: View {
    let summary: SessionSummary
    @ObservedObject var store: TrainingStore
    let coach: CoachDoors

    @Environment(\.gymSkin) private var skin
    @State private var detail: SessionDetail?
    @State private var setsFailure: TrainingStore.WriteFailure?
    @State private var review: Review?
    @State private var read = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                head
                // The review is the domain's opinion of the session and the sets are the session
                // itself; the readout is only drawn once the log has answered, because "the log
                // didn't answer" is its empty state and this screen has not asked yet on first frame.
                if read { ReviewReadout(review: review, catalog: store.catalog) }
                sets
                CoachShareCard(doors: coach)
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        .task { await load() }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text(summary.session.plan?.routine ?? "Ad-hoc")
                .font(WindmillFont.display(30))
                .foregroundStyle(skin.ink)
            Text(when)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
            // The four-hour rule closed this one rather than a tap, which is a fact about the
            // session a lifter reading it back deserves — the duration on the tiles above is a
            // phone left running, not a workout that lasted that long.
            if summary.closedItself {
                Text("closed on its own — no set for four hours")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    @ViewBuilder
    private var sets: some View {
        if let detail {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                ForEach(Performed.movements(detail.sets, catalog: store.catalog)) { movement in
                    VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                        Text(movement.movement)
                            .font(WindmillFont.body(16, .semibold))
                            .foregroundStyle(skin.ink)
                        ForEach(movement.rows) { performed in row(performed) }
                    }
                }
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        } else if let setsFailure {
            // The log's own sentence when it sent one — including the one this store writes for a
            // session that has been discarded from another surface since Today listed it, which is
            // a fact about the log and not about this phone's signal.
            Text(setsFailure.line("the sets are on your account"))
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
        }
    }

    // A warmup counts toward nothing — not the records, not the prefill, not the comparison — so it
    // is drawn in the ink that says so rather than beside a working set as though it were one.
    private func row(_ set: Performed.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
            Text(set.number)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .frame(width: 18, alignment: .trailing)
            Text(set.effort)
                .font(GymType.numeral(15))
                .foregroundStyle(set.kind == .working ? skin.ink : skin.warmupInk)
            Spacer(minLength: 0)
            if set.kind != .working {
                Text(set.kind.rawValue)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.warmupInk)
            }
        }
    }

    private var when: String {
        let day = "\(Readout.day(summary.session.startedAtMs)) · \(Readout.time(summary.session.startedAtMs))"
        guard let finished = summary.session.finishedAtMs else {
            return "\(day) · \(Readout.setCount(summary.setCount))"
        }
        return "\(day) – \(Readout.time(finished)) · \(Readout.setCount(summary.setCount))"
    }

    // Two reads, and neither one blocks the other: the sets are the session and the review is what
    // the domain makes of it, so a screen missing one still says everything it can about the other.
    private func load() async {
        switch await store.sessionDetail(summary.session.id) {
        case .success(let found): detail = found
        case .failure(let why): setsFailure = why
        }
        review = await store.review(of: summary.session.id)
        read = true
    }
}
