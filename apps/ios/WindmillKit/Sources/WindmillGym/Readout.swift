import Foundation

// Days and months are spelled out rather than localised: a locale must not reorder "Tue 4 Aug".

public enum Readout {
    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    // Trailing zeros stripped, and the minus is U+2212. Rounded on the ladder's grid, never a second rounding.
    // Bounded because loads arrive as unvalidated Doubles and `Int(…)` traps above 9.2e18; past the bound it is a dash.
    public static func weight(_ kg: Double) -> String {
        let magnitude = Ladder.round(abs(kg))
        guard magnitude.isFinite, magnitude < 1e15 else { return "—" }
        let digits = magnitude == magnitude.rounded() ? String(Int(magnitude)) : String(magnitude)
        return (kg < 0 ? "\u{2212}" : "") + digits
    }

    public static func effort(weightKg: Double, reps: Int) -> String {
        "\(weight(weightKg)) × \(reps)"
    }

    // The column keeps one decimal, so a whole rating prints whole: `8`, never `8.0`.
    public static func rpe(_ rated: Double) -> String {
        guard rated.isFinite else { return "—" }
        let held = (rated * 10).rounded() / 10
        guard held != held.rounded() else { return String(Int(held)) }
        return String(held)
    }

    // nil reps is `max`, not a zero and not a blank.
    public static func repTarget(_ reps: Int?) -> String {
        guard let reps else { return "max" }
        return String(reps)
    }

    public static let openTarget = "open"

    // An absent weight and a zero both print nothing; a band-assisted −20 prints. Absent sets read `open` alone.
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

    // Instants are read in the zone the lifter was standing in.
    public static func day(_ ms: Int64) -> String {
        let parts = components(ms)
        let weekday = weekdays[max(0, min(6, (parts.weekday ?? 1) - 1))]
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        return "\(weekday) \(parts.day ?? 1) \(month)"
    }

    public static func weekday(_ ms: Int64) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return names[max(0, min(6, (components(ms).weekday ?? 1) - 1))]
    }

    public static func date(_ ms: Int64) -> String {
        let parts = components(ms)
        return "\(parts.day ?? 1) \(months[max(0, min(11, (parts.month ?? 1) - 1))])"
    }

    public static func dateWithYear(_ ms: Int64) -> String {
        "\(date(ms)) \(components(ms).year ?? 1970)"
    }

    public static func month(_ ms: Int64, now: Int64) -> String {
        let full = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"]
        let parts = components(ms)
        let named = full[max(0, min(11, (parts.month ?? 1) - 1))]
        guard parts.year == components(now).year else { return "\(named) \(parts.year ?? 1970)" }
        return named
    }

    // A calendar claim, not elapsed hours: both instants fall to their own local midnight before the difference.
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

    public static func when(_ ms: Int64, now: Int64) -> String {
        let days = daysAgo(ms, now: now)
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        guard components(ms).year == components(now).year else { return dateWithYear(ms) }
        return date(ms)
    }

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

    public static func sessionCount(_ count: Int) -> String {
        count == 1 ? "1 session" : "\(count) sessions"
    }

    public static func routineCount(_ count: Int) -> String {
        count == 1 ? "1 routine" : "\(count) routines"
    }

    // A week is the server's Monday-UTC bucket; nothing on this device works out which week a set fell in.
    public static func weekCount(_ count: Int) -> String {
        count == 1 ? "1 week" : "\(count) weeks"
    }

    public static func changeCount(_ count: Int) -> String {
        count == 1 ? "1 change" : "\(count) changes"
    }

    public static func workingCount(_ count: Int) -> String {
        "\(count) working"
    }

    // The argument is a sum, so it can arrive non-finite; under 50 kg prints nothing rather than a false zero.
    public static func tonnage(_ kg: Double) -> String? {
        guard kg.isFinite, kg >= 50 else { return nil }
        return String(format: "%.1f t", kg / 1000)
    }

    public static let noRoutine = "Free session"

    public static func routine(of session: Session) -> String {
        guard let named = session.plan?.routine, !named.isEmpty else { return noRoutine }
        return named
    }

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
