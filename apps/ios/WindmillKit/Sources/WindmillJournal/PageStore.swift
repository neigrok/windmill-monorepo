import Foundation
import SwiftUI
import WindmillPlatform

// Every write goes in one order: mint a stamp, store on the device, then tell the server or owe it.

@MainActor
public final class PageStore: ObservableObject {
    @Published public private(set) var days: [CanvasDay] = []      // history, oldest→newest
    @Published public private(set) var body: String = ""           // today, the live draft
    @Published public private(set) var mood: Int?
    @Published public private(set) var energy: Int?
    @Published public private(set) var saveState: SaveState = .idle
    @Published public private(set) var saveTick = 0                // bumps once per write, so the note re-fades
    @Published public private(set) var isLoading = true

    @Published public private(set) var today: LocalDay

    private let open: (String?) -> PageCache
    private let clock: HlcClock
    private let sync: (Account) -> (any PageSyncing)?
    private var cache: PageCache
    private var journal: (any PageSyncing)?
    private var seat: Seat = .nobody
    private var touched = false            // the writer typed before the window landed
    private var saveTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var dayTask: Task<Void, Never>?
    // Bumped on every seat change: an await that outlived its seat must not touch the arriving file.
    private var generation = 0

    private static let windowDays = 60
    private static let saveDebounce = Duration.milliseconds(800)
    private static let retryDelay = Duration.seconds(4)

    public init(open: @escaping (String?) -> PageCache = { PageCache(seat: $0) },
                clock: HlcClock = HlcClock(actor: HlcClock.deviceActor()),
                today: LocalDay = .today(),
                sync: @escaping (Account) -> (any PageSyncing)? = { $0.isSignedIn ? JournalApi(api: $0.api) : nil }) {
        self.open = open
        self.clock = clock
        self.today = today
        self.sync = sync
        // Opened for nobody until a seat arrives.
        self.cache = open(nil)
    }

    // `nobody` means never connected, so the first seat to arrive opens its own file even when anonymous.
    private enum Seat: Equatable {
        case nobody
        case anonymous
        case account(String)

        init(_ account: Account) {
            guard let user = account.user else {
                self = .anonymous
                return
            }
            self = .account(user.id)
        }

        var userId: String? {
            guard case .account(let id) = self else { return nil }
            return id
        }
    }

    public struct CanvasDay: Identifiable, Equatable {
        public let day: LocalDay
        public let body: String
        public let mood: Int?
        public let energy: Int?
        public var id: String { day.iso }
        public var wordCount: Int { body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count }
    }

    public enum SaveState: Equatable {
        case idle
        case saved              // the account has it
        case onThisDevice       // nobody signed in — no account to sync to
        case offline            // signed in, but this write has not landed yet

        // nil is a state: a canvas that has just opened says nothing.
        public var line: String? {
            switch self {
            case .idle: return nil
            case .saved: return "saved"
            case .onThisDevice: return "saved on this device"
            case .offline: return "offline · saved here"
            }
        }
    }

    public var isFirstRun: Bool {
        !isLoading && days.isEmpty && body.isEmpty && mood == nil && energy == nil
    }

    // Called on launch and on every change of who is signed in.
    public func connect(to account: Account) async {
        let arriving = Seat(account)
        if arriving != seat { take(arriving) }
        journal = sync(account)
        watchTheCalendar()

        // An unconfirmed seat may read its own file but must not adopt: the claim is irreversible.
        if account.isSignedIn, account.verified { carryTheAnonymousClaim() }
        drawFromCache()
        isLoading = false

        guard journal != nil else {
            saveState = cache.pending.isEmpty ? .idle : .onThisDevice
            return
        }
        await claimWhatIsOwed()
        await loadWindow()
    }

    // Turns the canvas over while the app is awake; the room re-asks on every return to .active.
    private func watchTheCalendar() {
        guard dayTask == nil else { return }
        dayTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(LocalDay.untilTomorrow()))
                guard !Task.isCancelled else { return }
                await self?.rollOver(to: .today())
            }
        }
    }

    // Idempotent. A draft still in the debounce is written into the day it was typed on first.
    public func rollOver(to day: LocalDay) async {
        guard day != today else { return }
        keepDraftOnDevice()
        today = day
        body = ""
        mood = nil
        energy = nil
        touched = false
        drawFromCache()
        guard journal != nil else {
            saveState = cache.pending.isEmpty ? saveState : .onThisDevice
            return
        }
        await claimWhatIsOwed()
        await loadWindow()
    }

    // The departing person's unsaved draft is written into THEIR file, unsent, before the store lets go.
    private func take(_ arriving: Seat) {
        keepDraftOnDevice()
        seat = arriving
        generation += 1
        cache = open(arriving.userId)
        days = []
        body = ""
        mood = nil
        energy = nil
        touched = false
        saveState = .idle
        saveTick = 0
        isLoading = true
    }

    private func keepDraftOnDevice() {
        saveTask?.cancel()
        saveTask = nil
        retryTask?.cancel()
        retryTask = nil
        guard seat != .nobody, touched else { return }
        let held = cache.page(on: today)
        guard held?.body != body || held?.mood != mood || held?.energy != energy else { return }
        cache.store(Page(day: today, body: body, mood: mood, energy: energy,
                         source: .typed, stamp: clock.mint()), needsPush: true)
        cache.flush()
    }

    // Only OWED pages travel, and the order is the safety: the anonymous file is emptied only once
    // this seat's file has taken the pages and flushed them.
    private func carryTheAnonymousClaim() {
        let anonymous = open(nil)
        let drafts = anonymous.pending
        guard !drafts.isEmpty else { return }
        for page in drafts { cache.store(page, needsPush: true) }
        guard cache.flush() else { return }
        anonymous.discard()
    }

    public func type(_ text: String) {
        touched = true
        body = text
        scheduleSave(after: Self.saveDebounce)
    }

    // A scale is set to a value or explicitly cleared; there is no toggle. 0 is a value.
    public func set(mood value: Int?) {
        touched = true
        mood = Scale.narrow(value)
        scheduleSave(after: .zero)
    }

    public func set(energy value: Int?) {
        touched = true
        energy = Scale.narrow(value)
        scheduleSave(after: .zero)
    }

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
        let seated = generation
        do {
            let winner = try await journal.put(sent)
            // The seat changed mid-write: the reply belongs to the departing person.
            guard seated == generation else { return }
            cache.markPushed(today, winner: winner)
            cache.flush()
            adopt(winner, unmovedFrom: sent)
            settle(.saved)
        } catch {
            guard seated == generation else { return }
            settle(.offline)
            scheduleRetry()
        }
    }

    // The tick is what the note watches, so two saves in one state read as two.
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

    // Only for fields the writer has not moved since the write went out.
    private func adopt(_ winner: Page, unmovedFrom sent: Page) {
        if body == sent.body { body = winner.body }
        if mood == sent.mood { mood = winner.mood }
        if energy == sent.energy { energy = winner.energy }
    }

    // Replayed oldest first; each page carries the stamp it was written with.
    private func claimWhatIsOwed() async {
        guard let journal else { return }
        let seated = generation
        for page in cache.pending {
            let winner = try? await journal.put(page)
            // A walk that outlived its seat settles nothing.
            guard seated == generation else { return }
            guard let winner else {
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
        let seated = generation
        let read = try? await journal.range(from: today.advanced(by: -Self.windowDays), to: today)
        // The window belongs to the seat that asked for it.
        guard seated == generation else { return }
        guard let pages = read else {
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

    // Today is never here — it is the draft.
    private func drawFromCache() {
        days = cache.pages
            .filter { $0.day < today && $0.isWritten }
            .map { CanvasDay(day: $0.day, body: $0.body, mood: $0.mood, energy: $0.energy) }
        if let mine = cache.page(on: today), !touched { adoptDraft(from: mine) }
    }
}
