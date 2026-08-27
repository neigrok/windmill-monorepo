import SwiftUI
import WindmillPlatform

// One window over every verb that can still be taken back: a set just logged, a set deleted, a
// routine, a conversation, a finished workout. Nine seconds each (`SetQueue.undoWindowMs`), each on
// its own clock, and a second act never settles the first.
//
// A server-only verb — a conversation, a routine, a finished workout — is NOT sent while its window
// runs, because a send cannot be taken back. `take` hides it here; `settle` is the only thing that
// reaches the wire. A set is the exception only in where its hold lives: the queue carries it on
// disk, so a delete survives the process that made it.

// The words. Pinned here so three screens cannot invent four spellings of the same fact.
public enum WithheldWords {
    public static let undo = "Undo"
    // Pressed as the clock fires: the way back is gone and the transient says so rather than doing
    // nothing. Nothing else can produce it — the transient retires with the last clock.
    public static let windowClosed = "The window closed — that delete already went."
    public static let thread = "Conversation deleted."
    // What deleting a conversation does NOT take with it, said at the moment of the act rather than
    // three screens deep inside the conversation, where the block that used to say it lived.
    public static let threadDetail = "a change you applied stays in the routine’s history"
    public static let session = "Session deleted."
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

        // Four verbs destroy and one does not; only the four may be counted as deleted.
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

    public func holds(_ kind: Withheld.Kind, _ subject: String) -> Bool {
        held.contains { $0.kind == kind && $0.subject == subject }
    }

    // What a list must not draw: still inside its window, or already gone. A list read back from the
    // server is the reason for the second half — the server has it, and it has not caught up yet.
    public func hides(_ kind: Withheld.Kind, _ subject: String) -> Bool {
        holds(kind, subject) || gone.contains(Self.key(kind, subject))
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
                        if let detail = window.detail {
                            Text(detail)
                                .font(GymType.numeral(11.5))
                                .foregroundStyle(skin.inkFaint)
                                .lineLimit(1)
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
            .onAppear { drain(until: newest.untilMs) }
            .onChange(of: newest.id) { _, _ in drain(until: newest.untilMs) }
        }
    }

    private func drain(until closesAtMs: Int64) {
        let remaining = Double(closesAtMs - Int64(Date().timeIntervalSince1970 * 1000)) / 1000
        draining = 1
        guard remaining > 0 else {
            draining = 0
            return
        }
        withAnimation(.linear(duration: remaining)) { draining = 0 }
    }
}
