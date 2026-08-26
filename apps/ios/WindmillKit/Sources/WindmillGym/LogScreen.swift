import SwiftUI
import WindmillPlatform

// Weeks are folded on the client over the page it holds; there is no week endpoint.
enum LogWeeks {
    // A missing fact draws nothing — never a dash, never a zero.
    struct Row: Equatable, Identifiable {
        let summary: SessionSummary
        let title: String
        let when: String
        let working: String?
        let tonnage: String?
        let e1rm: String?
        let deviceOnly: Bool
        let record: Bool

        var id: String { summary.id }

        init(_ summary: SessionSummary, deviceOnly: Bool, now: Int64) {
            self.summary = summary
            self.deviceOnly = deviceOnly
            record = summary.record
            title = Readout.routine(of: summary.session)
            when = Self.when(summary.session.startedAtMs, now: now)
            working = summary.workingSetCount.map(Readout.workingCount)
            tonnage = summary.tonnageKg.flatMap(Readout.tonnage)
            e1rm = summary.topE1rm.map { "e1RM \(Readout.weight($0))" }
        }

        static func when(_ ms: Int64, now: Int64) -> String {
            guard Readout.daysAgo(ms, now: now) > 0 else { return "today · \(Readout.time(ms))" }
            return Readout.day(ms)
        }
    }

    struct Week: Equatable, Identifiable {
        let startedAtMs: Int64
        var rows: [Row]
        var tonnage: String?

        var id: Int64 { startedAtMs }
        var label: String { "week of \(Readout.date(startedAtMs))" }
    }

    enum Reach: Equatable {
        case whole  // the bottom: nothing older exists to arrive
        case served(oldest: Int64?)  // the oldest instant the SERVER has answered for, if any

        // A week may be captioned only when nothing older can still land in it, and that floor is the served one.
        func holds(_ monday: Int64) -> Bool {
            guard case .served(let oldest) = self else { return true }
            guard let oldest else { return false }
            return monday > LogWeeks.weekStart(of: oldest)
        }
    }

    static func fold(_ summaries: [SessionSummary], deviceOnly: Set<String>,
                     reach: Reach, now: Int64) -> [Week] {
        var weeks: [Week] = []
        // One session with no tonnage takes the whole week's caption with it.
        var kilos: [Double?] = []

        for summary in summaries.sorted(by: { $0.session.startedAtMs > $1.session.startedAtMs }) {
            let monday = weekStart(of: summary.session.startedAtMs)
            if weeks.last?.startedAtMs != monday {
                weeks.append(Week(startedAtMs: monday, rows: [], tonnage: nil))
                kilos.append(0)
            }
            weeks[weeks.count - 1].rows.append(
                Row(summary, deviceOnly: deviceOnly.contains(summary.id), now: now))
            guard let held = kilos[kilos.count - 1], let lifted = summary.tonnageKg else {
                kilos[kilos.count - 1] = nil
                continue
            }
            kilos[kilos.count - 1] = held + lifted
        }

        return weeks.indices.map { index in
            var week = weeks[index]
            guard reach.holds(week.startedAtMs) else { return week }
            week.tonnage = kilos[index].flatMap(Readout.tonnage)
            return week
        }
    }

    static func loaded(sessions: Int, weeks: Int) -> String? {
        guard sessions > 0 else { return nil }
        return "\(Readout.sessionCount(sessions)) · \(weeks == 1 ? "1 week" : "\(weeks) weeks") loaded"
    }

    // Monday in the lifter's own zone, never a UTC bucket.
    static func weekStart(of ms: Int64) -> Int64 {
        var calendar = Calendar.current
        calendar.firstWeekday = 2
        let lived = Date(timeIntervalSince1970: Double(ms) / 1000)
        guard let week = calendar.dateInterval(of: .weekOfYear, for: lived) else { return ms }
        return Int64(week.start.timeIntervalSince1970 * 1000)
    }
}

// The reading sits at the head of the tab and opens the chart; the writing is the one chip pinned in the reach band.
struct LogScreen: View {
    @ObservedObject var store: TrainingStore
    let onOpen: (SessionSummary) -> Void
    let onBodyweight: () -> Void
    let say: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var weighingIn = false

    var body: some View {
        let weeks = LogWeeks.fold(store.recent, deviceOnly: store.deviceOnly,
                                  reach: store.logFoot == .bottom
                                      ? .whole : .served(oldest: store.servedOldestMs),
                                  now: Int64(Date().timeIntervalSince1970 * 1000))
        return List {
            Section { head(weeks.count) }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: WindmillSpace.x5,
                                          bottom: WindmillSpace.x2, trailing: WindmillSpace.x5))
            if store.recent.isEmpty, store.logFoot == .bottom {
                Section { nothingYet }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: WindmillSpace.x5,
                                              bottom: 0, trailing: WindmillSpace.x5))
            } else {
                ForEach(weeks) { week in
                    Section {
                        ForEach(week.rows) { row in self.row(row) }
                    } header: {
                        divider(week)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 3, leading: WindmillSpace.x5,
                                              bottom: 3, trailing: WindmillSpace.x5))
                }
                Section { foot }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: WindmillSpace.x3, leading: WindmillSpace.x5,
                                              bottom: WindmillSpace.x6, trailing: WindmillSpace.x5))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 1)
        .safeAreaInset(edge: .bottom) { weighInChip }
        .sheet(isPresented: $weighingIn) {
            WeighInSheet(existing: nil, fixedDate: nil, drawsKgOnly: store.preferences.units == .lb,
                         onSave: { kg, day in
                             weighingIn = false
                             Task { await weighIn(kg, on: day) }
                         },
                         onDelete: nil)
                .presentationBackground(skin.surface)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // The last weigh-in and its age; nothing at all before the first, never a dash or a zero.
    private func head(_ weeks: Int) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            if let loaded = LogWeeks.loaded(sessions: store.recent.count, weeks: weeks) {
                Text(loaded)
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
            if let reading = Bodyweight.reading(store.bodyweight, today: Bodyweight.dateLocal(Date())) {
                Button(action: onBodyweight) {
                    HStack(spacing: WindmillSpace.x1) {
                        Text(reading)
                            .font(GymType.numeral(13))
                            .foregroundStyle(skin.inkDim)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(skin.inkFaint)
                    }
                    .frame(minHeight: GymTap.minimum - 18)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Bodyweight \(reading)")
                .accessibilityHint("Opens the bodyweight chart")
            }
        }
        .padding(.bottom, WindmillSpace.x2)
    }

    // The only door to entering a weigh-in, at every scroll position.
    private var weighInChip: some View {
        HStack {
            Spacer(minLength: 0)
            Button { weighingIn = true } label: {
                Text(Bodyweight.chip)
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(skin.onAccent)
                    .padding(.horizontal, WindmillSpace.x5)
                    .frame(minHeight: GymTap.minimum)
                    .background(Capsule().fill(skin.accent))
            }
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.vertical, WindmillSpace.x2)
    }

    private func weighIn(_ kg: Double, on dateLocal: String) async {
        guard let why = await store.weighIn(kg, on: dateLocal) else { return }
        say(why.line("the weigh-in is saved on this device"))
    }

    // One description and no action: the weigh-in chip below is this screen's only writing.
    private var nothingYet: some View {
        ContentUnavailableView {
            Label("No sessions yet.", systemImage: "book.closed")
                .foregroundStyle(skin.inkDim)
        } description: {
            Text("The first one you log lands here, newest first.")
                .foregroundStyle(skin.inkFaint)
        }
    }

    private func divider(_ week: LogWeeks.Week) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
            Text(week.label.uppercased())
                .font(GymType.numeral(11))
                .tracking(0.8)
                .foregroundStyle(skin.inkFaint)
            Rectangle()
                .fill(skin.line)
                .frame(height: 1)
            if let tonnage = week.tonnage {
                Text(tonnage)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkDim)
            }
        }
        .padding(.top, WindmillSpace.x3)
        .padding(.bottom, WindmillSpace.x1)
    }

    private func row(_ row: LogWeeks.Row) -> some View {
        Button { onOpen(row.summary) } label: {
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                HStack(spacing: WindmillSpace.x2) {
                    Text(row.title)
                        .font(WindmillFont.body(16, .bold))
                        .foregroundStyle(skin.ink)
                        .lineLimit(1)
                    if row.record {
                        Circle()
                            .fill(skin.prInk)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("a personal record happened here")
                    }
                    if row.deviceOnly {
                        Circle()
                            .strokeBorder(skin.unsyncedInk, lineWidth: 1.5)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("saved on this device only")
                    }
                    Spacer(minLength: WindmillSpace.x2)
                    Text(row.when)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                }
                HStack(spacing: WindmillSpace.x4) {
                    if let working = row.working { fact(working) }
                    if let tonnage = row.tonnage { fact(tonnage) }
                    if let e1rm = row.e1rm { fact(e1rm) }
                }
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func fact(_ text: String) -> some View {
        Text(text)
            .font(GymType.numeral(12.5))
            .foregroundStyle(skin.inkDim)
    }

    @ViewBuilder
    private var foot: some View {
        switch store.logFoot {
        case .more:
            Button { Task { await store.loadOlder() } } label: {
                box("Load older", ink: skin.inkDim, edge: skin.lineStrong)
            }
        case .loading:
            ProgressView()
                .tint(skin.inkFaint)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
        case .bottom:
            if let first = store.recent.last {
                Text("first session · \(Readout.dateWithYear(first.session.startedAtMs))")
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
            }
        case .failed:
            Button { Task { await store.loadOlder() } } label: {
                box("That read failed · retry", ink: skin.alarmInk, edge: skin.alarmInk)
            }
        }
    }

    private func box(_ label: String, ink: Color, edge: Color) -> some View {
        Text(label)
            .font(WindmillFont.body(14, .bold))
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(edge, lineWidth: 1))
    }
}
