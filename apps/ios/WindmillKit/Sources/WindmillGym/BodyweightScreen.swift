import Charts
import SwiftUI
import WindmillPlatform

// A dot per measurement on the series' own range; a segment only across a gap of seven days or fewer, and the rule
// printed beside the window shown. No goal line, no projection, no trend, no scrubbing: a dot is reached by a tap.
struct BodyweightScreen: View {
    @ObservedObject var store: TrainingStore
    let say: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var window: Bodyweight.Window = .ninetyDays
    @State private var repairing: BodyweightEntry?

    var body: some View {
        let today = Bodyweight.dateLocal(Date())
        let chart = Bodyweight.chart(store.bodyweight, window: window, today: today)
        return ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                head(today: today)
                windows
                if let empty = Bodyweight.emptyWindow(chart) {
                    Text(empty)
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkFaint)
                        .padding(.top, WindmillSpace.x2)
                } else {
                    card(chart)
                }
                if store.preferences.units == .lb {
                    Text(Bodyweight.drawsKg)
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.inkFaint)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        .sheet(item: $repairing) { held in
            WeighInSheet(existing: held, fixedDate: held.dateLocal, drawsKgOnly: store.preferences.units == .lb,
                         onSave: { kg, day in
                             repairing = nil
                             Task { await save(kg, on: day) }
                         },
                         onDelete: {
                             repairing = nil
                             Task { await delete(on: held.dateLocal) }
                         })
                .presentationBackground(skin.surface)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func head(today: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            if let reading = Bodyweight.reading(store.bodyweight, today: today) {
                Text(reading)
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // Two values, stated; the active one is printed on the chart as well. `.controlSize(.large)` is
    // the room's 46pt tap floor: a stock segmented control measures 30.7pt and ignores a frame.
    private var windows: some View {
        Picker(Bodyweight.title, selection: $window) {
            ForEach(Bodyweight.Window.allCases, id: \.self) { choice in
                Text(choice.rawValue).tag(choice)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.large)
    }

    private func card(_ chart: Bodyweight.Chart) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(alignment: .firstTextBaseline) {
                Text("KG PER WEIGH-IN")
                    .font(GymType.numeral(10.5))
                    .tracking(0.7)
                    .foregroundStyle(skin.inkFaint)
                Spacer(minLength: WindmillSpace.x3)
                Text(chart.label)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            dots(chart)
                .frame(height: 220)
            Text(Bodyweight.gapRule)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    private func dots(_ chart: Bodyweight.Chart) -> some View {
        Chart {
            ForEach(chart.gaps) { gap in
                RectangleMark(xStart: .value("from", day(gap.from)), xEnd: .value("to", day(gap.to)))
                    .foregroundStyle(skin.raised.opacity(0.7))
                    .annotation(position: .top, alignment: .center, spacing: 2,
                                overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        Text(gap.label)
                            .font(GymType.numeral(9))
                            .foregroundStyle(skin.inkFaint)
                            .lineLimit(1)
                    }
            }
            ForEach(Array(chart.runs.enumerated()), id: \.offset) { index, run in
                ForEach(run) { point in
                    LineMark(x: .value("day", day(point.dateLocal)), y: .value("kg", point.weightKg),
                             series: .value("run", index))
                        .foregroundStyle(skin.accent)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                }
            }
            ForEach(chart.points) { point in
                PointMark(x: .value("day", day(point.dateLocal)), y: .value("kg", point.weightKg))
                    .foregroundStyle(skin.ink)
                    .symbolSize(52)
            }
        }
        .chartYScale(domain: chart.low...chart.high)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine().foregroundStyle(skin.line)
                AxisValueLabel().foregroundStyle(skin.inkFaint).font(GymType.numeral(10.5))
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine().foregroundStyle(skin.line)
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                    .foregroundStyle(skin.inkFaint)
                    .font(GymType.numeral(10.5))
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        guard let plot = proxy.plotFrame else { return }
                        let frame = geometry[plot]
                        let x = location.x - frame.origin.x
                        let nearest = chart.points.compactMap { point -> (BodyweightEntry, CGFloat)? in
                            guard let at = proxy.position(forX: day(point.dateLocal)) else { return nil }
                            return (point, abs(at - x))
                        }.min { $0.1 < $1.1 }
                        guard let nearest, nearest.1 <= 24 else { return }
                        repairing = nearest.0
                    }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("bodyweight, \(chart.label)")
        .accessibilityHint("Tap a dot to correct or delete that weigh-in")
    }

    private func day(_ dateLocal: String) -> Date {
        Bodyweight.date(of: dateLocal) ?? Date()
    }

    private func save(_ kg: Double, on dateLocal: String) async {
        guard let why = await store.weighIn(kg, on: dateLocal) else { return }
        say(why.line("the weigh-in is saved on this device"))
    }

    private func delete(on dateLocal: String) async {
        guard let why = await store.deleteWeighIn(on: dateLocal) else { return }
        say(why.line("the weigh-in is still there"))
    }
}

// The one door onto a weigh-in, reused for the repair: a plain decimal field, never the ladder or the keypad, and
// a date defaulting to today. From the chart the day is fixed and a delete row is offered. The form scrolls, so at
// the medium detent and the largest text size Save and the delete row are reached, never lost below the fold.
struct WeighInSheet: View {
    let existing: BodyweightEntry?
    let fixedDate: String?
    let drawsKgOnly: Bool
    let onSave: (Double, String) -> Void
    let onDelete: (() -> Void)?

    @Environment(\.gymSkin) private var skin
    @State private var text: String
    @State private var date: Date
    @State private var confirmingDelete = false
    @FocusState private var typing: Bool

    init(existing: BodyweightEntry?, fixedDate: String?, drawsKgOnly: Bool,
         onSave: @escaping (Double, String) -> Void, onDelete: (() -> Void)?) {
        self.existing = existing
        self.fixedDate = fixedDate
        self.drawsKgOnly = drawsKgOnly
        self.onSave = onSave
        self.onDelete = onDelete
        _text = State(initialValue: existing.map { Bodyweight.format($0.weightKg) } ?? "")
        _date = State(initialValue: fixedDate.flatMap { Bodyweight.date(of: $0) } ?? Date())
    }

    var body: some View {
        let reading = Bodyweight.read(text)
        let day = fixedDate ?? Bodyweight.dateLocal(date)
        let dateRefusal = Bodyweight.dateRefusal(day, today: Bodyweight.dateLocal(Date()))
        return ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                field(reading)
                dateRow
                if let dateRefusal {
                    Text(dateRefusal)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.alarmInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if drawsKgOnly {
                    caption(Bodyweight.drawsKg)
                }
                save(reading, on: day, refused: dateRefusal != nil)
                if let onDelete { deleteRow(onDelete) }
            }
            .padding(WindmillSpace.x5)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(skin.surface)
        .onAppear { typing = true }
        .confirmationDialog(Bodyweight.deleteTitle, isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(Bodyweight.deleteConfirm, role: .destructive) { onDelete?() }
            Button(Bodyweight.deleteKeep, role: .cancel) {}
        }
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
            Text(Bodyweight.sheetTitle)
                .font(WindmillFont.display(22))
                .foregroundStyle(skin.ink)
            Spacer(minLength: 0)
            if let fixedDate {
                Text(Bodyweight.weekdayDayMonth(fixedDate))
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // One refusal at a time, in place of the hint, and only once something has been typed.
    private func field(_ reading: Bodyweight.Reading) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
                TextField("0", text: $text)
                    .keyboardType(.decimalPad)
                    .focused($typing)
                    .font(WindmillFont.display(44, .heavy).monospacedDigit())
                    .foregroundStyle(text.isEmpty || reading.isValid ? skin.weightInk : skin.alarmInk)
                    .padding(.horizontal, WindmillSpace.x3)
                    .frame(minHeight: 64)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.raised))
                    .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
                    .accessibilityLabel("Weight in kilograms")
                Text("kg")
                    .font(WindmillFont.body(18, .bold))
                    .foregroundStyle(skin.inkFaint)
            }
            if let refusal = reading.refusal, !text.isEmpty {
                Text(refusal)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.alarmInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                caption(Bodyweight.hint)
            }
        }
    }

    @ViewBuilder
    private var dateRow: some View {
        if fixedDate == nil {
            DatePicker(Bodyweight.dateRow, selection: $date, in: ...Date(), displayedComponents: .date)
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
                .tint(skin.accent)
                .frame(minHeight: GymTap.minimum)
        }
    }

    private func save(_ reading: Bodyweight.Reading, on day: String, refused: Bool) -> some View {
        let open = reading.isValid && !refused
        return Button {
            guard let value = reading.value, open else { return }
            onSave(value, day)
        } label: {
            Text(Bodyweight.save)
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(open ? skin.onAccent : skin.inkFaint)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(open ? skin.accent : skin.raised))
        }
        .disabled(!open)
    }

    private func deleteRow(_ onDelete: @escaping () -> Void) -> some View {
        Button { confirmingDelete = true } label: {
            Text(Bodyweight.deleteRow)
                .font(WindmillFont.body(14, .bold))
                .foregroundStyle(skin.alarmInk)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
        }
    }

    private func caption(_ line: String) -> some View {
        Text(line)
            .font(GymType.numeral(12))
            .foregroundStyle(skin.inkFaint)
            .fixedSize(horizontal: false, vertical: true)
    }
}
