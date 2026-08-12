import Foundation

// THE REST TIMER — a target the lifter set, and a value that is COMPUTED rather than counted. It reads
// the instant the set landed, never a remaining number it decrements, so a pocketed phone, a locked
// screen and a relaunch all come back to the truth instead of to however long the app stayed awake.
//
// THE TARGET IS ASKED FOR, NEVER GUESSED. There used to be a per-movement table here — squats three
// minutes, face pulls one — and it was the reason a lifter who had never opened a settings screen got
// a chime in a gym they never asked for. §I draws one dial (`off · 1:30 · 2:00 · 3:00`) and it starts
// OFF, so the two answers left are the two somebody actually gave: the routine's own line for this
// movement, then the global dial. When neither has an answer there is no timer, and that is a
// perfectly good state rather than a degraded one — the logger simply draws no clock.
//
// WHAT IT CANNOT DO IS SAID WHERE IT IS SET. This app schedules the chime in-process; iOS suspends a
// backgrounded app, so a locked phone gets no sound at the moment the rest lands. The clock is right
// the instant you look again — it is computed from the set's own instant — and a chime that arrived
// late would be a false confirmation, so it is dropped rather than played (LoggerScreen). There is no
// notification in this product to promise instead.
//
// IT IS A HAIRLINE AND A NUMERAL NOW, where it was three strings and a button (§K, 2026-08-12). The
// rule fills toward the target, so the rest is read in one glance from the far side of a rack
// instead of parsed; the numeral stays beside it because a full rule says "the rest landed" and
// nothing after that — seven seconds over and twenty minutes over fill it identically, and how long
// a lifter has been standing there is a number about their training. What went is the LABEL:
// `resting · target 3:00` named a setting they chose, on the screen, forever.
//
// Being over the target is not an error and must never look like one: the rule arrives full and
// stays there and the numeral counts on with a plus, calm and quietly present. Nothing in this file
// may reach for alarm ink, and nothing here moves the lifter on — the rest landing is a fact, not
// an instruction.

public enum Rest {
    // The dial, §I's own four, and `nil` is one of them rather than an absence of one.
    public static let choices: [Int?] = [nil, 90, 120, 180]

    // The routine's line wins: a lifter who wrote three minutes against an accessory meant it, and
    // the dial is what everything else in the session rests to.
    public static func target(planEntry: PlanEntry?, preferences: GymPreferences) -> Int? {
        planEntry?.restSeconds ?? preferences.restSeconds
    }

    // How long a chime may be late before it stops being a confirmation. A scheduled sleep lands
    // within milliseconds while the app is awake; anything past this is a phone that was asleep and a
    // rest that ended without anybody hearing it.
    public static let lateChimeSeconds: Int64 = 5

    // WHAT A SCHEDULED CHIME IS ABOUT — the instant the rest began AND the target it is counting to.
    // Both, because the logger keys the sleeping task on this: a dial turned to `off` (or to another
    // target) mid-rest has to replace the sleep, and one keyed on the instant alone would leave the
    // old one to land and chime for a timer that no longer exists.
    public struct Clock: Equatable {
        public let startedAtMs: Int64
        public let targetSeconds: Int

        public init(startedAtMs: Int64, targetSeconds: Int) {
            self.startedAtMs = startedAtMs
            self.targetSeconds = targetSeconds
        }
    }

    // How much of the hairline is filled, 0 through 1. It is COMPUTED from the instant the set
    // landed, like everything else here, so a phone that slept through the whole rest comes back to
    // a full rule rather than to however long the app was awake for.
    //
    // A rest past its target is a FULL line and never a longer one. There is nothing after the
    // target to draw and nothing this screen wants to say about it — a lifter three minutes over is
    // resting, which is a decision and not a state to be reported on.
    public static func filled(targetSeconds: Int, startedAtMs: Int64, now: Int64) -> Double {
        guard targetSeconds > 0 else { return 1 }
        let elapsed = Double(now - startedAtMs) / 1000
        return min(1, max(0, elapsed / Double(targetSeconds)))
    }

    // WHAT THE RULE CANNOT SAY. It pins at full on the target and every overrun draws the same
    // pixel, so the numeral is what tells a rest seven seconds past its target from one twenty
    // minutes past it. Under the target it is what is left; past it, what has been taken on top,
    // with a plus and in the same ink — over is a decision, not a fault.
    public static func reading(targetSeconds: Int, startedAtMs: Int64, now: Int64) -> String {
        let left = Int64(targetSeconds) - (now - startedAtMs) / 1000
        guard left < 0 else { return Readout.clock(left * 1000) }
        return "+" + Readout.clock(-left * 1000)
    }
}
