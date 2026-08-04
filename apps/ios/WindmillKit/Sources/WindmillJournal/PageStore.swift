import Foundation
import SwiftUI
import WindmillPlatform

// The canvas's data — the native twin of web/src/products/journal/usePages.js, with the two things
// a phone adds: the device is a real home for a page (so writing works signed out and offline), and
// signing in CLAIMS what is already there rather than gating it (auth canon §2, §4 — adoption is
// always additive).
//
// The order of every write is the same and never varies: mint a stamp → store on the device →
// tell the server, or owe it. Nothing is ever held in memory waiting for a network call to decide
// whether it counts.

@MainActor
public final class PageStore: ObservableObject {
    @Published public private(set) var days: [CanvasDay] = []      // history, oldest→newest, gaps included
    @Published public private(set) var body: String = ""           // today, the live draft
    @Published public private(set) var mood: Mood = .none
    @Published public private(set) var energy: Energy = .none
    @Published public private(set) var saveState: SaveState = .idle
    @Published public private(set) var saveTick = 0                // bumps once per write, so the note re-fades
    @Published public private(set) var isLoading = true

    public let today: LocalDay

    private let cache: PageCache
    private let clock: HlcClock
    private let sync: (Account) -> (any PageSyncing)?
    private var journal: (any PageSyncing)?
    private var touched = false            // the writer typed before the window landed
    private var saveTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?

    private static let windowDays = 60
    private static let saveDebounce = Duration.milliseconds(800)
    private static let retryDelay = Duration.seconds(4)

    public init(cache: PageCache = PageCache(),
                clock: HlcClock = HlcClock(actor: HlcClock.deviceActor()),
                today: LocalDay = .today(),
                sync: @escaping (Account) -> (any PageSyncing)? = { $0.isSignedIn ? JournalApi(api: $0.api) : nil }) {
        self.cache = cache
        self.clock = clock
        self.today = today
        self.sync = sync
    }

    // A day the canvas draws — and only days that were actually written. A day nobody wrote is not
    // drawn at all: the canvas is what you wrote, not a calendar with holes in it. Saying nothing
    // about a missed day is the strongest reading of "no scoring" (canon §3.3) — an unwritten day
    // cannot be counted, coloured, or apologised for if it was never put on the page.
    public struct CanvasDay: Identifiable, Equatable {
        public let day: LocalDay
        public let body: String
        public let mood: Mood
        public let energy: Energy
        public var id: String { day.iso }
        public var wordCount: Int { body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count }
    }

    public enum SaveState: Equatable {
        case idle
        case saved              // the account has it
        case onThisDevice       // nobody signed in — there is no account to sync to, and that is fine
        case offline            // signed in, but this write has not landed yet

        // Mono, lower-case, never a button and never a spinner (canon §4). Silence is a state:
        // a canvas that has just opened says nothing at all.
        public var line: String? {
            switch self {
            case .idle: return nil
            case .saved: return "saved"
            case .onThisDevice: return "saved on this device"
            case .offline: return "offline · saved here"
            }
        }
    }

    // Nothing written, ever — the first-run surface (P9). Computed rather than stored so it cannot
    // be left true by a code path that forgot to clear it.
    public var isFirstRun: Bool {
        !isLoading && days.isEmpty && body.isEmpty && !mood.isSet && !energy.isSet
    }

    // Called on launch and on every change of who is signed in. Draws from the device first and
    // always — a canvas that waited for a network round trip would be a cursor that waits.
    public func connect(to account: Account) async {
        journal = sync(account)
        drawFromCache()
        isLoading = false

        guard journal != nil else {
            saveState = cache.pending.isEmpty ? .idle : .onThisDevice
            return
        }
        await claimWhatIsOwed()
        await loadWindow()
    }

    public func type(_ text: String) {
        touched = true
        body = text
        scheduleSave(after: Self.saveDebounce)
    }

    // Tapping the step you are on clears it: the scales are optional always, so every value must
    // have a way back to unset (canon §3.1 — skippable in one gesture).
    public func tap(mood step: Mood) {
        touched = true
        mood = (mood == step) ? .none : step
        scheduleSave(after: .zero)
    }

    public func tap(energy step: Energy) {
        touched = true
        energy = (energy == step) ? .none : step
        scheduleSave(after: .zero)
    }

    // Flush a queued draft on the way out so nothing typed is lost when the app leaves the screen.
    public func flushPendingWrite() async {
        guard saveTask != nil else { return }
        saveTask?.cancel()
        saveTask = nil
        await persist()
    }

    private func scheduleSave(after delay: Duration) {
        saveTask?.cancel()
        retryTask?.cancel()
        saveTask = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self else { return }
            await self.persist()
        }
    }

    private func persist() async {
        let sent = Page(day: today, body: body, mood: mood, energy: energy,
                        source: .typed, stamp: clock.mint())
        cache.store(sent, needsPush: true)
        cache.flush()
        saveTask = nil

        guard let journal else {
            settle(.onThisDevice)
            return
        }
        do {
            let winner = try await journal.put(sent)
            cache.markPushed(today, winner: winner)
            cache.flush()
            adopt(winner, unmovedFrom: sent)
            settle(.saved)
        } catch {
            // A write that did not land is not a lost write — it is on the device, marked owed,
            // and the retry will carry it. The UI says so and never throws.
            settle(.offline)
            scheduleRetry()
        }
    }

    // One write, one beat. The tick is what the marker's note watches, so two saves that land in
    // the same state still read as two saves rather than as one that never faded.
    private func settle(_ state: SaveState) {
        saveState = state
        saveTick += 1
    }

    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: Self.retryDelay)
            guard !Task.isCancelled, let self, self.saveTask == nil else { return }
            await self.persist()
        }
    }

    // Adopt the winning page, but only for the fields the writer has not moved since the write went
    // out — otherwise a slow reply overwrites the sentence someone kept typing while waiting.
    private func adopt(_ winner: Page, unmovedFrom sent: Page) {
        if body == sent.body { body = winner.body }
        if mood == sent.mood { mood = winner.mood }
        if energy == sent.energy { energy = winner.energy }
    }

    // The claim (auth canon §4): everything written on this device before there was an account,
    // replayed oldest first. Additive by construction — each page carries the stamp it was written
    // with, so the server resolves it against anything already there by the ordinary rule.
    private func claimWhatIsOwed() async {
        guard let journal else { return }
        for page in cache.pending {
            guard let winner = try? await journal.put(page) else {
                saveState = .offline
                return
            }
            cache.markPushed(page.day, winner: winner)
        }
        cache.flush()
        if let mine = cache.page(on: today), !touched { adoptDraft(from: mine) }
    }

    private func loadWindow() async {
        guard let journal else { return }
        guard let pages = try? await journal.range(from: today.advanced(by: -Self.windowDays), to: today) else {
            saveState = cache.pending.isEmpty ? saveState : .offline
            return
        }
        for page in pages { cache.store(page, needsPush: false) }
        cache.flush()
        if let mine = cache.page(on: today), !touched { adoptDraft(from: mine) }
        drawFromCache()
    }

    private func adoptDraft(from page: Page) {
        body = page.body
        mood = page.mood
        energy = page.energy
    }

    // The days that were written, oldest first. Today is never here — it is the draft.
    private func drawFromCache() {
        days = cache.pages
            .filter { $0.day < today && $0.isWritten }
            .map { CanvasDay(day: $0.day, body: $0.body, mood: $0.mood, energy: $0.energy) }
        if let mine = cache.page(on: today), !touched { adoptDraft(from: mine) }
    }
}
