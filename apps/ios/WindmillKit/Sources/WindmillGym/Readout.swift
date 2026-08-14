import Foundation

// ONE WAY TO SPELL A NUMBER — the native statement of web/src/products/gym/log.js. A weight, a day,
// a duration and a clock are printed here and nowhere else in gym, so the prefill card, the set row,
// the finish tiles and the log row can never disagree about the same fact.
//
// Days and months are spelled out rather than localised, exactly as the web spells them: "Tue 4 Aug"
// is the string the design draws, and a locale that reordered it would make two surfaces of the same
// product print one day two ways.

public enum Readout {
    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    // Trailing zeros stripped and a REAL U+2212 minus, because a negative load is a normal point on
    // the number line here — band-assisted work sits below zero. The grid is the LADDER's own and
    // never a second opinion: this rounded to two decimals itself until the two spellings disagreed
    // on a negative half-cent, and only one of them has a golden.
    //
    // TOTAL BY CONSTRUCTION, and the bound is not decoration. A load and an estimate both arrive as
    // unvalidated Doubles — off the wire, off the device shelf — and a JSON number runs to 1e308
    // while `Int(…)` TRAPS above 9.2e18. One absurd number in one field would take down every screen
    // that rendered it rather than spoiling the row it belongs to. Nothing a barbell holds is
    // anywhere near the bound; past it there is no spelling, and the product's mark for a fact it
    // does not have is the dash.
    public static func weight(_ kg: Double) -> String {
        let magnitude = Ladder.round(abs(kg))
        guard magnitude.isFinite, magnitude < 1e15 else { return "—" }
        let digits = magnitude == magnitude.rounded() ? String(Int(magnitude)) : String(magnitude)
        return (kg < 0 ? "\u{2212}" : "") + digits
    }

    public static func effort(weightKg: Double, reps: Int) -> String {
        "\(weight(weightKg)) × \(reps)"
    }

    // A rep target a routine declines to set is `3 × max` — a movement taken to whatever it gives
    // that day. It is not a zero and it is not a blank, and this is the only place the word is
    // spelled, so the routine card, the logger's plan line and the finish comparison agree.
    public static func repTarget(_ reps: Int?) -> String {
        guard let reps else { return "max" }
        return String(reps)
    }

    // A row the routine names NOTHING for — no sets, and therefore no reps and no weight either. It
    // is one word and it is the word §M draws: the target is not missing, it is left open on
    // purpose, and the movement asks at the rack. Spelled here so the routine card, the routine
    // page, the plan line and every diff row say it the same way.
    public static let openTarget = "open"

    // What a routine asks a movement for, in one line — the routine card, the session detail's plan
    // line and the finish comparison all print it, so a target reads the same wherever it is read
    // (log.js `entryLabel`). An absent weight is "whatever you did last time" and prints nothing
    // rather than a zero; so does an actual zero, because zero is not a load but the absence of one,
    // while a band-assisted −20 is a real point on this number line and prints.
    //
    // ABSENT SETS SHORT-CIRCUIT THE WHOLE LINE to `open`, and nothing is lost by it: the server
    // refuses to store reps or a weight on a line with no set count, so there is never a second
    // number here to say instead.
    //
    // The plan and the routine spell their targets with different field names and the same three
    // numbers, so both hand them over rather than each writing the grammar out again.
    public static func target(sets: Int?, reps: Int?, weightKg: Double?) -> String {
        guard let sets else { return openTarget }
        let count = "\(sets) × \(repTarget(reps))"
        guard let weightKg, weightKg != 0 else { return count }
        return "\(count) · \(weight(weightKg))"
    }

    public static func time(_ ms: Int64) -> String {
        let parts = components(ms)
        return pad(parts.hour ?? 0) + ":" + pad(parts.minute ?? 0)
    }

    // Every instant gym prints is one a person LIVED THROUGH, so every one of them is read in the
    // zone they are standing in. This carried a `utc` switch for one caller — the retired statistics
    // board, whose weeks were UTC Monday buckets the server had cut — and the switch went with the
    // board rather than waiting for somebody to find a second use for it.
    public static func day(_ ms: Int64) -> String {
        let parts = components(ms)
        let weekday = weekdays[max(0, min(6, (parts.weekday ?? 1) - 1))]
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        return "\(weekday) \(parts.day ?? 1) \(month)"
    }

    // The day a session ran, spelled in full — the one place gym prints a weekday as a NAME rather
    // than as a date, because it is offered as a routine's name and "Tue 4 Aug" is not one.
    public static func weekday(_ ms: Int64) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return names[max(0, min(6, (components(ms).weekday ?? 1) - 1))]
    }

    // A date with no weekday in front, for the two places gym names a square on the calendar rather
    // than a moment somebody lived through: the Monday a week of the log opens on, and the bottom of
    // that log. The bottom carries its YEAR, because "6 May" cannot say which May a training history
    // began in and that is the one fact worth arriving at.
    public static func date(_ ms: Int64) -> String {
        let parts = components(ms)
        return "\(parts.day ?? 1) \(months[max(0, min(11, (parts.month ?? 1) - 1))])"
    }

    public static func dateWithYear(_ ms: Int64) -> String {
        "\(date(ms)) \(components(ms).year ?? 1970)"
    }

    // THE HEADING OVER A RUN OF ROWS THAT SHARE A MONTH (§O screen 33) — the one place gym spells a
    // month as a word rather than as part of a date, because it names a section and not a day.
    //
    // The YEAR arrives the moment the month is no longer in this one, for the same reason the record
    // ladder's dates carry theirs: `August` is a heading on nobody's calendar once there are two
    // Augusts in a log, and threads are the first thing in this product built to be read years later.
    public static func month(_ ms: Int64, now: Int64) -> String {
        let full = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"]
        let parts = components(ms)
        let named = full[max(0, min(11, (parts.month ?? 1) - 1))]
        guard parts.year == components(now).year else { return "\(named) \(parts.year ?? 1970)" }
        return named
    }

    // "Yesterday" is a claim about the CALENDAR and not about elapsed hours: a session finished at
    // 07:00 is still today at 21:00, and one finished at 23:00 is already yesterday by 01:00. So both
    // instants fall to their own local midnight before the difference is taken — which also makes the
    // count right across the 23- and the 25-hour day, where dividing by 86_400_000 is not. The web
    // says it the same way (log.js `agoLabel`), over the same stored instant.
    //
    // The count is its own answer because the log's rows ask the same question in different words —
    // a row reads `today · 18:44` on the day it happened and `Fri 7 Aug` after — and two places
    // deciding where midnight falls is how one product shows one session on two days.
    public static func daysAgo(_ ms: Int64, now: Int64) -> Int {
        let calendar = Calendar.current
        let then = calendar.startOfDay(for: Date(timeIntervalSince1970: Double(ms) / 1000))
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: Double(now) / 1000))
        return calendar.dateComponents([.day], from: then, to: today).day ?? 0
    }

    public static func ago(_ ms: Int64, now: Int64) -> String {
        let days = daysAgo(ms, now: now)
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        return "\(days) days ago"
    }

    // WHEN A PAST DAY IS NAMED RATHER THAN COUNTED — the record page's records and its recent days
    // (§H prints `today` on one row and `27 Jul` on the next). It is not `ago`: "16 days ago" is the
    // wrong answer for a mark somebody wants to find in their log, and past a fortnight the count
    // stops being a date at all.
    //
    // The YEAR arrives the moment the date is no longer this one. A record ladder is lifetime and a
    // rarely-trained movement's last day can be two years back, where "13 Jul" names a square on
    // nobody's calendar — the same fact the log's bottom prints its year for.
    public static func when(_ ms: Int64, now: Int64) -> String {
        let days = daysAgo(ms, now: now)
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        guard components(ms).year == components(now).year else { return dateWithYear(ms) }
        return date(ms)
    }

    // The session clock and the rest timer both read this, and both hand it a span computed from an
    // instant rather than a counter they incremented — so a locked phone and a relaunch both come
    // back showing the true elapsed time instead of the time the app was awake for.
    public static func clock(_ ms: Int64) -> String {
        let total = max(0, ms / 1000)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        let head = hours > 0 ? "\(hours):\(pad(Int(minutes)))" : String(minutes)
        return head + ":" + pad(Int(seconds))
    }

    public static func duration(_ ms: Int64) -> String {
        let minutes = max(1, ms / 60_000)
        if minutes < 60 { return "\(minutes)m" }
        return "\(minutes / 60)h \(pad(Int(minutes % 60)))m"
    }

    public static func setCount(_ count: Int) -> String {
        count == 1 ? "1 set" : "\(count) sets"
    }

    // The product counts SESSIONS — never workouts and never entries — so the word is spelled here
    // beside the set's, and the record page's subhead borrows it rather than inventing a second noun
    // for the same thing.
    public static func sessionCount(_ count: Int) -> String {
        count == 1 ? "1 session" : "\(count) sessions"
    }

    // The home's sub-line counts the program (§B screen 4: `4 routines · nothing running`), spelled
    // beside the other counts so one row never invents its own plural.
    public static func routineCount(_ count: Int) -> String {
        count == 1 ? "1 routine" : "\(count) routines"
    }

    // The third noun the read line counts (§L). A week here is the SERVER's Monday-UTC bucket, the
    // same one `date_trunc('week')` cuts, and this spells it rather than deciding it — nothing on
    // this device works out which weeks a set fell in.
    public static func weekCount(_ count: Int) -> String {
        count == 1 ? "1 week" : "\(count) weeks"
    }

    // WHAT A DIFF ASKS FOR, counted. It is spelled here beside the sets and the sessions because
    // four screens print it — the review button, the card in Ask's stream, a routine's history row
    // and a thread's outcome line — and a `1 changes` on any one of them would be the room
    // miscounting the only thing that row exists to say.
    public static func changeCount(_ count: Int) -> String {
        count == 1 ? "1 change" : "\(count) changes"
    }

    // The count the log's row and the session detail's head both print (§G16, §G17), and it is not
    // `setCount`: a warmup counts toward nothing in this product, so the number beside a top set
    // filtered to working has to be filtered the same way or the row states two different sessions.
    public static func workingCount(_ count: Int) -> String {
        "\(count) working"
    }

    // A week's or a session's tonnage, in tonnes to one decimal — the CAPTION §G16 hangs on a week
    // divider, and never a metric. domain/Statistics refuses volume as one and that refusal stands:
    // band-assisted work logs a negative load, so weight × reps falls as a lifter gets stronger, and
    // four light sets outrank three heavy ones. Nothing is ranked or tracked by this.
    //
    // An assisted set contributes zero rather than subtracting — it moved no external load — and a
    // bodyweight set contributes zero for the same reason, gym not knowing anybody's bodyweight. So
    // a chin-up-and-dips week sums to zero, and zero prints NOTHING: that week did not move zero
    // kilograms, we simply have nothing true to say about it. The floor is the same rule one decimal
    // further down — under 50 kg what this would print IS `0.0 t`.
    //
    // Its argument is a SUM, which is the one way a number in this product goes non-finite: the
    // decoder refuses a JSON number it cannot represent, but adding representable ones can still
    // overflow. `inf t` on a week divider is not a caption.
    public static func tonnage(_ kg: Double) -> String? {
        guard kg.isFinite, kg >= 50 else { return nil }
        return String(format: "%.1f t", kg / 1000)
    }

    // ONE WORD FOR A SESSION NOBODY PLANNED, everywhere this surface names one — the log's row and
    // the session read back. It is the design's own (§G16) and it replaced
    // "Ad-hoc", which the web retired for the same reason: a session with no routine is the ordinary
    // case in most logs and must not read as a fault or as jargon.
    public static let noRoutine = "Session · no routine"

    public static func routine(of session: Session) -> String {
        guard let named = session.plan?.routine, !named.isEmpty else { return noRoutine }
        return named
    }

    // A movement is a stable id everywhere except on screen. Falling back to the id keeps a sentence
    // readable while the catalog has not answered — a slug a lifter can still recognise beats a
    // blank where the movement should be.
    public static func movement(_ exerciseId: String, in catalog: [Exercise]) -> String {
        catalog.first { $0.id == exerciseId }?.name ?? exerciseId
    }

    private static func components(_ ms: Int64) -> DateComponents {
        Calendar.current.dateComponents([.hour, .minute, .weekday, .day, .month, .year],
                                        from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0\(value)" : String(value)
    }
}
