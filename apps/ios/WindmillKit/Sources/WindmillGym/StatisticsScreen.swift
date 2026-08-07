import SwiftUI
import WindmillPlatform

// STATISTICS — the long window, and the second place a lifter can stand in this room at rest. It
// RENDERS what `Stats.board` decided and computes nothing itself: no e1RM, no normalisation, no
// sorting, no arithmetic in a view body.
//
// A CHART ON A PHONE HAS NO SCRUB AND NO HOVER, so every number a mark would otherwise reveal on
// touch is printed beside it — each bar row carries its own peak, each movement line its two
// endpoints. A chart whose values can only be reached by a gesture the surface does not have is a
// decoration, and this product does not draw those.
//
// Nothing here is a grade. No score, no percentage, no green and no red: iris is the one accent
// and it reads as iron, exactly as it does on the weight the lifter is under.

struct StatisticsScreen: View {
    @ObservedObject var store: TrainingStore

    @Environment(\.gymSkin) private var skin
    @State private var board: Stats.Board?
    @State private var failure: TrainingStore.WriteFailure?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                head
                if let board {
                    if let weeks = board.weeks { self.weeks(weeks) }
                    ForEach(board.lines) { line in movement(line) }
                    if board.isEmpty { nothingYet }
                } else if let failure {
                    // In the log's own words when it sent any. A 500 that said "internal error" is
                    // not a phone with no signal, and this screen may not report it as one.
                    silence(failure.line("these lines aren’t drawn"), retry: true)
                } else {
                    silence("reading your log…", retry: false)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        // Read on the way in and shaped once, outside the body. There is no cache to key on a
        // collection's length and get wrong: a second visit asks the log again, and a set logged in
        // between counts the next time this screen is opened.
        .task { await read() }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text("Statistics")
                .font(WindmillFont.display(32))
                .foregroundStyle(skin.ink)
            Text("every session you have finished")
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
        }
    }

    // Two rows of bars, each measured against ITS OWN peak — sessions and working sets count
    // different things, and one axis across both is the chart that made Lift's progress tab
    // unreadable. A week with nothing in it draws no bar, so a gap in a program reads as a gap in the
    // row rather than as a bar the eye has to measure.
    private func weeks(_ weeks: Stats.Weeks) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            series(weeks.sets)
            series(weeks.sessions)
            Text(weeks.span)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
    }

    private func series(_ series: Stats.Series) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack {
                Text(series.label)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkDim)
                Spacer(minLength: WindmillSpace.x3)
                Text(series.peak)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            VStack(spacing: 0) {
                HStack(alignment: .bottom, spacing: 3) {
                    ForEach(Array(series.heights.enumerated()), id: \.offset) { _, height in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(skin.accent)
                            .frame(height: max(0, height) * 44)
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 44, alignment: .bottom)
                Rectangle()
                    .fill(skin.line)
                    .frame(height: 1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // One movement, and the only chart in the product that is a line: a load over sessions is a
    // continuous thing and a count per week is not.
    private func movement(_ line: Stats.Line) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack(alignment: .firstTextBaseline) {
                Text(line.movement)
                    .font(WindmillFont.body(17))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: WindmillSpace.x3)
                Text(line.value)
                    .font(GymType.numeral(17, .semibold))
                    .foregroundStyle(skin.ink)
                Text(line.unit)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }

            Text(line.lastTrained)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)

            Sparkline(heights: line.heights, ink: skin.accent)
                .frame(height: 36)
                .padding(.vertical, WindmillSpace.x1)

            Text(line.span)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)

            ForEach(line.bests, id: \.self) { best in
                Text(best)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // The honest empty: a log with no FINISHED session has nothing to draw, and the session running
    // right now is deliberately not in here — a statistics read that moved under a lifter between two
    // sets would be reporting on a workout in flight.
    private var nothingYet: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("Nothing finished yet.")
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
            Text("These lines are drawn from sessions you have closed. The one you are in the middle of is today’s screen.")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
    }

    // Mono, quiet, never a spinner and never an alert — the room's one voice for a door that did not
    // open. The read is offered again rather than retried forever: this screen is somewhere a lifter
    // chose to stand, and a poll behind it would spend a basement's signal on a chart.
    private func silence(_ line: String, retry: Bool) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(line)
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
            if retry {
                Button { Task { await read() } } label: {
                    Text("Try again")
                        .font(WindmillFont.body(16, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
            }
        }
    }

    private func read() async {
        failure = nil
        switch await store.statistics() {
        case .success(let statistics):
            board = Stats.board(statistics, catalog: store.catalog,
                                now: Int64(Date().timeIntervalSince1970 * 1000))
        case .failure(let why):
            failure = why
        }
    }
}

// The line itself, and the whole of its drawing: a polyline through the normalised points with the
// newest one marked, because the last point is the one a lifter is looking for. A movement with one
// session is one dot — a chart of a single point is honest and an interpolation to nowhere is not.
private struct Sparkline: View {
    let heights: [Double]
    let ink: Color

    var body: some View {
        GeometryReader { geometry in
            let points = placed(in: geometry.size)
            Path { path in
                for (index, point) in points.enumerated() {
                    index == 0 ? path.move(to: point) : path.addLine(to: point)
                }
            }
            .stroke(ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))

            if let last = points.last {
                Circle()
                    .fill(ink)
                    .frame(width: 5, height: 5)
                    .position(last)
            }
        }
    }

    // Inset by the dot's own radius on every side, so the newest point's mark and a line that runs
    // along its own floor are both drawn INSIDE the frame rather than half over the card's edge.
    private func placed(in size: CGSize) -> [CGPoint] {
        let inset: CGFloat = 3
        let height = size.height - inset * 2
        guard heights.count > 1 else {
            return heights.map { CGPoint(x: size.width / 2, y: inset + height * (1 - $0)) }
        }
        let step = (size.width - inset * 2) / CGFloat(heights.count - 1)
        return heights.enumerated().map { index, value in
            CGPoint(x: inset + CGFloat(index) * step, y: inset + height * (1 - CGFloat(value)))
        }
    }
}
