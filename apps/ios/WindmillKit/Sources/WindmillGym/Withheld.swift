import SwiftUI
import WindmillPlatform

// One window over every verb that can still be taken back: a set just logged, a set deleted, a
// routine, a conversation, a finished workout, a note, a weigh-in. Nine seconds each
// (`SetQueue.undoWindowMs`), each on its own clock, and a second act never settles the first.
//
// It is also the room's answer to "are you sure": no delete here asks a question first. The one
// confirmation the room keeps is turning a proposal down, which settles for good and has no window.
//
// A server-only verb — a conversation, a routine, a finished workout, a note — is NOT sent while its
// window runs, because a send cannot be taken back. `take` hides it here; `settle` is the only thing
// that reaches the wire. Two verbs keep their hold somewhere else: a set's is written into the queue
// on disk, so it survives the process that made it, and a weigh-in's is `TrainingStore`'s own filter
// over the drawn series — the chart and the log's head read one list, and only the closing clock
// writes the tombstone to disk.

// The words. Pinned here so three screens cannot invent four spellings of the same fact.
public enum WithheldWords {
    public static let undo = "Undo"
    // Pressed as the clock fires: the way back is gone and the transient says so rather than doing
    // nothing. Nothing else can produce it — the transient retires with the last clock.
    public static let windowClosed = "The window closed — that delete already went."
    public static let thread = "Conversation deleted."
    // What deleting a conversation does NOT take with it, said at the moment of the act rather than
    // three screens deep inside the conversation, where the block that used to say it lived. Six
    // words, byte-identical on all three surfaces — which is why it may not be shortened again on this
    // one alone, and why this phone draws it over two lines under 402 points (`WithheldTransient`).
    public static let threadDetail = "your routine keeps what you applied"
    public static let session = "Session deleted."
    public static let note = "Note deleted."
    public static let weighIn = "Weigh-in deleted."
    // What a settle the log REFUSED leaves standing. Kept here rather than typed into the room's
    // closures, in the bytes the other surfaces already say it in — `still here` on the web
    // (`threads.js`) and on Android (`WithheldDelete.kt`). A screen is licensed its own words; two
    // screens a word apart read as a typo instead of a decision.
    public static let threadStands = "that conversation is still here"
    public static let noteStands = "that note is still here"
    // A routine's proposals are `on delete cascade` on `gym_proposals.routine_id`, so they go with it.
    public static let routineDetail = "its proposals go with it"

    // Which thing left, in the surface's own rendering of the numbers.
    public static func deleted(_ effort: String) -> String { "\(effort) is out of the log." }

    public static func logged(_ effort: String) -> String { "\(effort) logged." }

    public static func routine(_ name: String) -> String { "\(name) deleted." }

    // The newest is drawn on its own; past one, the transient says how many are held. `deleted` is
    // only honest while every one of them is a delete — the logger's own window is an append.
    public static func many(_ kinds: [Withheld.Kind]) -> String {
        guard kinds.count > 1 else { return "" }
        if kinds.allSatisfy(\.isDelete) { return "\(kinds.count) deleted." }
        return "\(kinds.count) to take back."
    }
}

public struct Withheld: Identifiable {
    public enum Kind: String, Equatable, Sendable {
        case loggedSet
        case set
        case routine
        case thread
        case session
        case note
        case bodyweight

        // Six verbs destroy and one does not; only the six may be counted as deleted.
        public var isDelete: Bool { self != .loggedSet }

        // Where a set is concerned this register is not the only home: the queue writes the hold to
        // disk with its own clock. So the room forgetting a set may not reach in and change what the
        // lifter did — it lets go, and the queue keeps its promise.
        public var isHeldOnDisk: Bool { self == .set || self == .loggedSet }
    }

    public let id: String
    public let kind: Kind
    public let subject: String
    public let line: String
    public let detail: String?
    // When the act already carries its own instant — a set the queue is holding on disk — the
    // transient runs on THAT clock rather than starting a second one after the walk.
    public let closesAtMs: Int64?
    // Does it, and is handed the instant its own window closes — the only verb that needs it is the
    // set, whose hold is written into the queue on disk.
    let take: @MainActor (Int64) async -> Void
    // Answers whether it actually went. A list read back from the server would otherwise draw a row
    // the server has already dropped, and a settle the log refused has to put its row back.
    let settle: @MainActor () async -> Bool
    let restore: @MainActor () async -> Void

    // The id is minted per act, never derived from the subject: deleting a row, taking it back and
    // deleting it again is three acts, and two of them name the same row.
    public init(_ kind: Kind, subject: String, line: String, detail: String? = nil,
                closesAtMs: Int64? = nil,
                take: @escaping @MainActor (Int64) async -> Void = { _ in },
                settle: @escaping @MainActor () async -> Bool = { true },
                restore: @escaping @MainActor () async -> Void = {}) {
        id = "\(kind.rawValue)-\(subject)-\(UUID().uuidString)"
        self.kind = kind
        self.subject = subject
        self.line = line
        self.detail = detail
        self.closesAtMs = closesAtMs
        self.take = take
        self.settle = settle
        self.restore = restore
    }
}

// The room's window register. Hosted by the room and not by a screen, so leaving a screen keeps the
// window and the transient follows the lifter.
@MainActor
public final class WithheldWindow: ObservableObject {
    public struct Held: Identifiable {
        let act: Withheld
        let untilMs: Int64

        public var id: String { act.id }
        public var kind: Withheld.Kind { act.kind }
        public var subject: String { act.subject }
        public var line: String { act.line }
        public var detail: String? { act.detail }
    }

    // Oldest first. Every window is the same length, so the newest is always the last to close.
    @Published public private(set) var held: [Held] = []

    // Subjects whose delete has been sent and answered for.
    @Published public private(set) var gone: Set<String> = []

    private let windowMs: Int64
    private let now: () -> Int64
    private var clocks: [String: Task<Void, Never>] = [:]

    public init(windowMs: Int64 = SetQueue.undoWindowMs,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.windowMs = windowMs
        self.now = now
    }

    public var newest: Held? { held.last }

    public var isOpen: Bool { !held.isEmpty }

    // What the transient says: the newest act's own words, or how many are held once there are more.
    public var line: String {
        guard let newest else { return "" }
        guard held.count > 1 else { return newest.line }
        return WithheldWords.many(held.map(\.kind))
    }

    // Drawn only when it is the whole of what is held: a count has no one detail to carry.
    public var detail: String? {
        guard held.count == 1 else { return nil }
        return newest?.detail
    }

    public var closesAtMs: Int64? { newest?.untilMs }

    // How much of the newest window is still to run. The register holds the instant, so the
    // register does the subtraction, on the one clock that also closes the window: the transient
    // draws its drain from this and reads no clock of its own. A second clock — the wall clock
    // under a seat built on an injected one — empties the bar at a different moment than the way
    // back actually disappears.
    public var leftMs: Int64 {
        guard let untilMs = newest?.untilMs else { return 0 }
        return max(0, untilMs - now())
    }

    public func holds(_ kind: Withheld.Kind, _ subject: String) -> Bool {
        held.contains { $0.kind == kind && $0.subject == subject }
    }

    // The delete went and the log answered for it. A list that must say what the STORE holds asks
    // this half alone: a row inside its window is still stored, and a row whose delete has landed is
    // not — which is how the notes cap stops naming a way out the lifter has already taken.
    public func settled(_ kind: Withheld.Kind, _ subject: String) -> Bool {
        gone.contains(Self.key(kind, subject))
    }

    // What a list must not draw: still inside its window, or already gone. A list read back from the
    // server is the reason for the second half — the server has it, and it has not caught up yet.
    public func hides(_ kind: Withheld.Kind, _ subject: String) -> Bool {
        holds(kind, subject) || settled(kind, subject)
    }

    public func subjects(of kind: Withheld.Kind) -> Set<String> {
        Set(held.filter { $0.kind == kind }.map(\.subject))
    }

    // The act runs here and now; only the send waits.
    public func hold(_ act: Withheld) async {
        let until = act.closesAtMs ?? (now() + windowMs)
        let waiting = max(0, until - now())
        held.append(Held(act: act, untilMs: until))
        await act.take(until)
        clocks[act.id] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(waiting))
            guard !Task.isCancelled else { return }
            await self?.close(act.id)
        }
    }

    // The newest first, and the transient re-reads for the rest.
    @discardableResult
    public func undo() async -> Withheld.Kind? {
        guard let last = held.last else { return nil }
        clocks.removeValue(forKey: last.id)?.cancel()
        held.removeLast()
        await last.act.restore()
        return last.kind
    }

    // A subject WRITTEN AGAIN under a name it already carried. Only the weigh-in reaches this: it is
    // keyed by the local day, which is the lifter's to write again, and every other window is keyed
    // by a minted id nothing reuses. For that one both of the window's answers are wrong — a hold
    // still running would delete the number just saved when its clock fires, and a subject already
    // recorded gone would hide it for the life of the room. Writing the day again IS the way back,
    // so the row comes back and the transient retires. Called BEFORE the write reaches the store.
    public func writtenAgain(_ kind: Withheld.Kind, _ subject: String) async {
        gone.remove(Self.key(kind, subject))
        guard let index = held.firstIndex(where: { $0.kind == kind && $0.subject == subject }) else { return }
        let taking = held.remove(at: index)
        clocks.removeValue(forKey: taking.id)?.cancel()
        await taking.act.restore()
    }

    // The window lives only while the room is on screen in a live process. Leaving the foreground —
    // or the room going away for good — ABANDONS what is still held: the row comes back, nothing
    // reaches the wire, and nothing is said on the next open, because nothing happened. Settling
    // here instead would make `swipe · switch apps · come back` destroy a row with the way back
    // already gone, which is the exact shape this whole pattern exists to prevent. Deleting again
    // costs one stroke.
    //
    // A set is the one thing not put back, and only because its hold is not here (`isHeldOnDisk`).
    public func abandon() async {
        guard !held.isEmpty else { return }
        let going = held
        held = []
        for clock in clocks.values { clock.cancel() }
        clocks = [:]
        for item in going where !item.kind.isHeldOnDisk { await item.act.restore() }
    }

    private func close(_ id: String) async {
        clocks[id] = nil
        guard let index = held.firstIndex(where: { $0.id == id }) else { return }
        await sent(held.remove(at: index).act)
    }

    private func sent(_ act: Withheld) async {
        guard await act.settle() else { return }
        gone.insert(Self.key(act.kind, act.subject))
    }

    private static func key(_ kind: Withheld.Kind, _ subject: String) -> String {
        "\(kind.rawValue)-\(subject)"
    }
}

// The one undo on this surface. It floats ABOVE the reach band and grows no inset: `Log set` is
// pressed five to forty times a session and may not jump when a window opens, so this sits OVER the
// controls beneath it and retires itself when the last clock closes (`13-gestures.md` Law 4).
struct WithheldTransient: View {
    @ObservedObject var window: WithheldWindow
    // The room's one status line. An undo pressed as the clock fires has to be answered somewhere,
    // and the transient it was pressed on is already on its way out.
    let say: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var draining: Double = 1

    var body: some View {
        if let newest = window.newest {
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                HStack(spacing: WindmillSpace.x3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(window.line)
                            .font(WindmillFont.body(14, .semibold))
                            .foregroundStyle(skin.ink)
                            .lineLimit(1)
                        // Two lines, not one. `your routine keeps what you applied` draws 249 points
                        // and the slot beside the Undo button holds one line only from 402 points up,
                        // so on a 390-point phone one line is a sentence cut off mid-word. It runs on
                        // instead: the transient is three lines under 402 and two above, which overruns
                        // `text-budget.md`'s two on the phones the room actually ships to — the detail
                        // is one string in three files and cannot be shortened on this one alone.
                        // Measured by hosting, in `WithheldTransientTests`.
                        if let detail = window.detail {
                            Text(detail)
                                .font(GymType.numeral(11.5))
                                .foregroundStyle(skin.inkFaint)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                    Button(WithheldWords.undo) {
                        Task {
                            guard await window.undo() == nil else { return }
                            say(WithheldWords.windowClosed)
                        }
                    }
                        .font(WindmillFont.body(15, .bold))
                        .foregroundStyle(skin.accent)
                        .frame(minWidth: 64, minHeight: GymTap.minimum - 8)
                }
                // The window closing is the half a drawn Undo never showed: one animation, no timer.
                Capsule()
                    .fill(skin.line)
                    .frame(height: 2)
                    .overlay(alignment: .leading) {
                        GeometryReader { rule in
                            Capsule().fill(skin.accent)
                                .frame(width: rule.size.width * draining)
                        }
                    }
                    .frame(height: 2)
            }
            .padding(.horizontal, WindmillSpace.x4)
            .padding(.vertical, WindmillSpace.x3)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.raised))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                .strokeBorder(skin.lineStrong, lineWidth: 1))
            .padding(.horizontal, WindmillSpace.x4)
            .padding(.bottom, WindmillSpace.x3)
            .accessibilityElement(children: .contain)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onAppear { drain() }
            .onChange(of: newest.id) { _, _ in drain() }
        }
    }

    // Over what the WINDOW says is left, never over a clock this view read for itself: the window is
    // what retires the transient, and a bar measured on a second clock disagrees with it.
    private func drain() {
        let remaining = Double(window.leftMs) / 1000
        draining = 1
        guard remaining > 0 else {
            draining = 0
            return
        }
        withAnimation(.linear(duration: remaining)) { draining = 0 }
    }
}
