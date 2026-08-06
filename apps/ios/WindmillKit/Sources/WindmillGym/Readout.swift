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
    public static func weight(_ kg: Double) -> String {
        let magnitude = Ladder.round(abs(kg))
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

    public static func time(_ ms: Int64) -> String {
        let parts = components(ms)
        return pad(parts.hour ?? 0) + ":" + pad(parts.minute ?? 0)
    }

    // `utc` is for one caller and one reason: the statistics weeks are bucketed by
    // `date_trunc('week', … AT TIME ZONE 'UTC')`, so a bucket's start instant is a UTC Monday
    // midnight. Rendered in the reader's own zone it comes out as Sunday for half the planet, and a
    // week label that names the wrong day is worse than none. Everything else in gym is an instant a
    // person lived through and reads in the zone they are standing in, which is the default.
    public static func day(_ ms: Int64, utc: Bool = false) -> String {
        let parts = components(ms, utc: utc)
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

    // Whole days apart, rounded — the same arithmetic the routine list sorts on, so a card and the
    // row above it never disagree about when a routine was last trained.
    public static func ago(_ ms: Int64, now: Int64) -> String {
        let days = Int((Double(now - ms) / 86_400_000).rounded())
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        return "\(days) days ago"
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
    // beside the set's, and the movement lines on the statistics screen borrow it rather than
    // inventing a second noun for the same thing.
    public static func sessionCount(_ count: Int) -> String {
        count == 1 ? "1 session" : "\(count) sessions"
    }

    // A movement is a stable id everywhere except on screen. Falling back to the id keeps a sentence
    // readable while the catalog has not answered — a slug a lifter can still recognise beats a
    // blank where the movement should be.
    public static func movement(_ exerciseId: String, in catalog: [Exercise]) -> String {
        catalog.first { $0.id == exerciseId }?.name ?? exerciseId
    }

    private static func components(_ ms: Int64, utc: Bool = false) -> DateComponents {
        var calendar = Calendar.current
        if utc, let zone = TimeZone(identifier: "UTC") { calendar.timeZone = zone }
        return calendar.dateComponents([.hour, .minute, .weekday, .day, .month],
                                       from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0\(value)" : String(value)
    }
}
