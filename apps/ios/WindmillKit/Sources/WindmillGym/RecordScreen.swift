import SwiftUI
import WindmillPlatform

// Renders what `Record.page` decided and computes nothing itself.

struct RecordScreen: View {
    let exerciseId: String
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool

    @Environment(\.gymSkin) private var skin
    @State private var page: Record.Page?
    @State private var failure: TrainingStore.WriteFailure?
    @State private var renaming = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                if let page {
                    head(page)
                    if page.neverLogged {
                        neverLogged
                    } else {
                        if page.best != nil || page.heaviest != nil { tiles(page) }
                        if let chart = page.chart {
                            self.chart(chart)
                        } else if let why = page.noChart, let said = noChart(why) {
                            Text(said)
                                .font(GymType.numeral(12))
                                .foregroundStyle(skin.inkFaint)
                                .lineSpacing(3)
                        }
                        if !page.records.isEmpty { records(page.records) }
                        if !page.days.isEmpty { days(page.days) }
                    }
                    if page.source == .theLog, store.unclaimed(exerciseId) { unclaimed }
                } else if let failure {
                    silence(failure.line("this record isn’t drawn"), retry: true)
                } else {
                    ProgressView("reading your log…")
                        .font(GymType.numeral(13))
                        .tint(skin.inkFaint)
                        .foregroundStyle(skin.inkFaint)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        // Shaped once, outside the body; a second visit asks again.
        .task { await read() }
        .toolbar {
            if page != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Rename") { renaming = true }
                }
            }
        }
        .sheet(isPresented: $renaming) {
            RenameSheet(current: page?.name ?? "",
                        title: "Rename this movement",
                        prompt: "Movement name",
                        proof: page?.proof ?? [],
                        save: { await rename(to: $0) },
                        onClose: { renaming = false })
                .presentationBackground(skin.surface)
                .presentationDetents([.large])
        }
    }

    // The movement's name is the navigation bar's title; Rename is that bar's own action.
    private func head(_ page: Record.Page) -> some View {
        Text(page.subhead)
            .font(GymType.numeral(12))
            .foregroundStyle(skin.inkFaint)
    }

    private func tiles(_ page: Record.Page) -> some View {
        HStack(spacing: WindmillSpace.x2) {
            if let best = page.best { tile(best, ink: skin.prInk) }
            if let heaviest = page.heaviest { tile(heaviest, ink: skin.ink) }
        }
    }

    private func tile(_ tile: Record.Tile, ink: Color) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text(tile.caption.uppercased())
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            Text(tile.value)
                .font(WindmillFont.display(34, .heavy).monospacedDigit())
                .foregroundStyle(ink)
            Text(tile.under)
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    private func chart(_ chart: Record.Chart) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(alignment: .firstTextBaseline) {
                Text("E1RM PER SESSION")
                    .font(GymType.numeral(10.5))
                    .tracking(0.7)
                    .foregroundStyle(skin.inkFaint)
                Spacer(minLength: WindmillSpace.x3)
                Text(chart.window)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(chart.bars) { bar in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(ink(of: bar.mark))
                        .frame(height: max(0, bar.height) * 122)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 122, alignment: .bottom)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("e1RM per session, \(chart.opened) to \(chart.closed)")
            HStack {
                Text(chart.opened)
                Spacer(minLength: WindmillSpace.x3)
                Text(chart.closed)
            }
            .font(GymType.numeral(10.5))
            .foregroundStyle(skin.inkFaint)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    private func ink(of mark: Record.Mark) -> Color {
        switch mark {
        case .best: return skin.prInk
        case .passed: return skin.accent
        case .ordinary: return skin.raised
        }
    }

    private func records(_ rows: [Record.Row]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            caption("Personal records")
            ForEach(rows) { row in
                let leading = row.id == 0
                HStack(spacing: WindmillSpace.x3) {
                    Text(row.effort)
                        .font(GymType.numeral(14, .bold))
                        .foregroundStyle(skin.ink)
                    if let estimate = row.estimate {
                        Text(estimate)
                            .font(GymType.numeral(11.5))
                            .foregroundStyle(skin.inkDim)
                    }
                    Spacer(minLength: WindmillSpace.x2)
                    Text(row.when)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
                .padding(.horizontal, WindmillSpace.x3)
                .padding(.vertical, WindmillSpace.x3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .fill(leading ? skin.prInk.opacity(0.12) : skin.surface))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(leading ? skin.prInk : skin.line, lineWidth: 1))
            }
        }
    }

    private func days(_ days: [Record.Day]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            caption("Recent sets")
            ForEach(days) { day in
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(day.when)
                        .foregroundStyle(skin.inkFaint)
                        .frame(width: 66, alignment: .leading)
                    Text(day.sets)
                        .foregroundStyle(skin.ink)
                }
                .font(GymType.numeral(13))
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text.uppercased())
            .font(GymType.numeral(10.5))
            .tracking(0.7)
            .foregroundStyle(skin.inkFaint)
            .padding(.top, WindmillSpace.x2)
    }

    private var neverLogged: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("Never logged.")
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
            Text("A working set starts the record — warmups count toward nothing.")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
    }

    // A missing chart is named only when the line names a way out or a rule that counts; an
    // estimate Epley cannot give (every working set at or below zero) draws nothing at all.
    private func noChart(_ why: Record.NoChart) -> String? {
        switch why {
        case .onThisDevice:
            guard isSignedIn else { return "e1RM needs your account — sign in for the chart." }
            return "Not on the log yet — the chart arrives when it lands."
        case .outsideWindow:
            return "Nothing in the last \(Record.windowWeeks) weeks."
        case .neverWorked:
            return "No working sets yet — warmups and drop sets count toward nothing."
        case .unloaded:
            return nil
        }
    }

    // Asked per movement, never off `deviceOnly`, which is a set of session ids.
    private var unclaimed: some View {
        Text("Sessions this device hasn’t claimed yet aren’t counted here.")
            .font(GymType.numeral(12))
            .foregroundStyle(skin.inkFaint)
            .lineSpacing(3)
    }

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
        switch await store.record(of: exerciseId) {
        case .success(let answered):
            page = Record.page(answered.record, now: Int64(Date().timeIntervalSince1970 * 1000),
                               from: answered.source)
        case .failure(let why):
            failure = why
        }
    }

    // A rename that landed is re-read rather than patched into what is on screen.
    private func rename(to name: String) async -> TrainingStore.WriteFailure? {
        guard let failed = await store.rename(exerciseId, to: name) else {
            renaming = false
            await read()
            return nil
        }
        return failed
    }
}

struct MovementDoor: View {
    let exerciseId: String
    let name: String
    let font: Font
    let ink: Color
    let open: (String) -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        Button { open(exerciseId) } label: {
            HStack(spacing: WindmillSpace.x1) {
                Text(name)
                    .font(font)
                    .foregroundStyle(ink)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .frame(minHeight: GymTap.minimum, alignment: .leading)
        }
        .accessibilityHint("opens this movement’s record")
    }
}
