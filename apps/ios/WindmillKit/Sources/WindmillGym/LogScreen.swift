import SwiftUI
import WindmillPlatform

// THE LOG — every session that happened, newest first, and the second of the room's three tabs
// (§G16). It is not a calendar: a month grid answers "which days did I train", which this lifter
// answers with a program. There is no adherence percentage either — a number that scores somebody
// against a plan they already changed on purpose.
//
// The week is the client's own fold over the page it already holds; there is no week endpoint and
// there must not be one, because the fold is presentation. What it may say about a week it can only
// say when the week is WHOLE, which is the one honesty rule paging puts on it: reading is
// newest-first, so a week states its tonnage only when it sits above the oldest instant the SERVER
// has answered for. Not "every week but the last on screen" — this device's own unclaimed sessions
// are merged into the list at any age and one of them can sit below the served page.
//
// NO GOLD DOT ON A ROW YET. §G16 draws one for "a record happened in there", and deciding that needs
// the three record rules replayed against history as of that session — the machinery being built
// with the movement record (W1c). The space is left; a cheaper dot that is sometimes wrong would be
// the loudest thing in the product telling a lie.

// The rows of the log, grouped into the weeks they were lived in. Pure: it takes the summaries the
// store is holding and answers what is on screen, so the fold, the tonnage rule and the four facts
// of a row are all readable without a phone.
enum LogWeeks {
    // A session as the row states it. Every field is optional exactly where the fact may be missing,
    // and a missing one draws NOTHING — never a dash, never a zero standing in for a read that did
    // not happen.
    struct Row: Equatable, Identifiable {
        let summary: SessionSummary
        let title: String
        let when: String
        let working: String?
        let tonnage: String?
        let e1rm: String?
        let deviceOnly: Bool

        var id: String { summary.id }

        init(_ summary: SessionSummary, deviceOnly: Bool, now: Int64) {
            self.summary = summary
            self.deviceOnly = deviceOnly
            title = Readout.routine(of: summary.session)
            when = Self.when(summary.session.startedAtMs, now: now)
            working = summary.workingSetCount.map(Readout.workingCount)
            tonnage = summary.tonnageKg.flatMap(Readout.tonnage)
            e1rm = summary.topE1rm.map { "e1RM \(Readout.weight($0))" }
        }

        // `today · 18:44` while it is still today, and the day itself after that. A session is read
        // back on the day it happened far more often than on any other, and the clock is what tells
        // two of those apart; a week later the clock is noise and the day is the fact.
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

    // HOW FAR THE LOG HAS BEEN READ, which is the only thing that decides whether a week may state
    // its own tonnage.
    enum Reach: Equatable {
        case whole                      // the bottom: nothing older exists to arrive
        case served(oldest: Int64?)     // the oldest instant the SERVER has answered for, if any

        // A week may be captioned only when nothing older than it can still land in it. That floor
        // is the SERVED one and it is not "every week but the last on screen": this device's own
        // unclaimed sessions are merged in at ANY age, so a single old one sits below the served
        // page and pushes the genuinely partial week up out of last place — where it would then be
        // captioned with a number that silently changes on the next tap of `Load older`.
        func holds(_ monday: Int64) -> Bool {
            guard case .served(let oldest) = self else { return true }
            guard let oldest else { return false }
            return monday > LogWeeks.weekStart(of: oldest)
        }
    }

    static func fold(_ summaries: [SessionSummary], deviceOnly: Set<String>,
                     reach: Reach, now: Int64) -> [Week] {
        var weeks: [Week] = []
        // Kept beside the weeks rather than inside them because a week whose sum is unknowable must
        // print nothing rather than a total that is quietly short: one session with no tonnage on it
        // takes the whole week's caption with it.
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

    // What is on screen, counted off what is on screen — and NOTHING until something is: a log still
    // being read has not answered `0 sessions`, and every other number here omits rather than
    // zeroes. "Loaded" does real work in that sentence; it is a claim about this list and never
    // about the log, which goes back further than anybody has asked for.
    static func loaded(sessions: Int, weeks: Int) -> String? {
        guard sessions > 0 else { return nil }
        return "\(Readout.sessionCount(sessions)) · \(weeks == 1 ? "1 week" : "\(weeks) weeks") loaded"
    }

    // Monday, in the zone the lifter trained in. The statistics window buckets its weeks on a UTC
    // Monday because the SERVER cut them there; this fold is over a page the client already holds,
    // and a week a session belongs to is the week that person lived it in.
    static func weekStart(of ms: Int64) -> Int64 {
        var calendar = Calendar.current
        calendar.firstWeekday = 2
        let lived = Date(timeIntervalSince1970: Double(ms) / 1000)
        guard let week = calendar.dateInterval(of: .weekOfYear, for: lived) else { return ms }
        return Int64(week.start.timeIntervalSince1970 * 1000)
    }
}

struct LogScreen: View {
    @ObservedObject var store: TrainingStore
    let onOpen: (SessionSummary) -> Void

    @Environment(\.gymSkin) private var skin

    // The fold happens once per frame and everything on screen reads it, including the count in the
    // head — a second call would be a second answer to "how many weeks is this".
    var body: some View {
        let weeks = LogWeeks.fold(store.recent, deviceOnly: store.deviceOnly,
                                  reach: store.logFoot == .bottom
                                      ? .whole : .served(oldest: store.servedOldestMs),
                                  now: Int64(Date().timeIntervalSince1970 * 1000))
        return ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                head(weeks.count)
                if store.recent.isEmpty, store.logFoot == .bottom {
                    nothingYet
                } else {
                    ForEach(weeks) { week in
                        divider(week)
                        ForEach(week.rows) { row in self.row(row) }
                    }
                    foot
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private func head(_ weeks: Int) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text("The log")
                .font(WindmillFont.display(32))
                .foregroundStyle(skin.ink)
            if let loaded = LogWeeks.loaded(sessions: store.recent.count, weeks: weeks) {
                Text(loaded)
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .padding(.bottom, WindmillSpace.x2)
    }

    private var nothingYet: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("No sessions yet.")
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
            Text("The first one you log lands here, newest first.")
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(.top, WindmillSpace.x2)
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
                    // A hollow ring, and on this surface it is REAL: the room is anonymous-first, so
                    // a session lives on the device until an account claims it, and the lifter it
                    // belongs to deserves to know which of these rows only this phone has.
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
        }
        .padding(.bottom, WindmillSpace.x1)
    }

    private func fact(_ text: String) -> some View {
        Text(text)
            .font(GymType.numeral(12.5))
            .foregroundStyle(skin.inkDim)
    }

    // THE FOUR STATES OF THE FOOT, in the order a scroll meets them. There is no spinner and there
    // are no skeleton rows pretending to be sessions: the box that was offering the page is the box
    // that says it is fetching it, one shade quieter.
    @ViewBuilder
    private var foot: some View {
        switch store.logFoot {
        case .more:
            Button { Task { await store.loadOlder() } } label: {
                box("Load older", ink: skin.inkDim, edge: skin.lineStrong)
            }
        case .loading:
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.inkFaint)
                    .frame(width: 7, height: 7)
                Text("Loading")
                    .font(WindmillFont.body(14, .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
        case .bottom:
            // The bottom is a DATE and not an empty box — it is the one fact worth arriving at, and
            // it is drawn off the oldest row actually on screen rather than off any claim about how
            // far back the log goes.
            if let first = store.recent.last {
                Text("first session · \(Readout.dateWithYear(first.session.startedAtMs))")
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
            }
        case .failed:
            // Alarm ink is for a failed read or a failed write and for nothing else in this product
            // — never a missed rep, never a session that ran short.
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
