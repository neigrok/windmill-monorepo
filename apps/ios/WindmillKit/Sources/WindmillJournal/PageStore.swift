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

    // NOT A `let` ANY MORE. A canvas nobody closed used to keep writing into the day it opened on:
    // the phone was held past midnight and tonight's sentence landed on yesterday's page. It is
    // published because the day is what the whole canvas is drawn around.
    @Published public private(set) var today: LocalDay

    private let open: (String?) -> PageCache
    private let clock: HlcClock
    private let sync: (Account) -> (any PageSyncing)?
    private var cache: PageCache
    private var journal: (any PageSyncing)?
    private var seat: Seat = .nobody       // whose file this store has open
    private var touched = false            // the writer typed before the window landed
    private var saveTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var dayTask: Task<Void, Never>?
    // Bumped on every seat change. Everything that awaits reads it first and gives up if it moved:
    // a PUT sent under the departing person's bearer must not come back and mark a page pushed —
    // or adopt its words into the draft — in the arriving person's file.
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
        // Opened for nobody until a seat arrives. Nothing is ever drawn from it: `connect` opens the
        // arriving seat's own file first, and this one exists only so the property is never nil.
        self.cache = open(nil)
    }

    // WHOSE FILE THIS STORE HAS OPEN — and `nobody` is a third state, not a spelling of anonymous:
    // a store that has never been connected has drawn nothing and owes nothing, and the first seat
    // to arrive must open its own file even when that seat is the anonymous one.
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
        let arriving = Seat(account)
        if arriving != seat { take(arriving) }
        journal = sync(account)
        watchTheCalendar()

        // WHAT AN UNCONFIRMED SEAT MAY AND MAY NOT DO. `verified` is false while the seat stands on
        // the user this device wrote beside its Keychain secret and THIS launch has not heard the
        // log confirm it (AuthStatus.unverified). It may READ ITS OWN FILE — a basement is not a
        // sign-out, the phone is one person's behind an OS lock, and a signed-in writer opening the
        // canvas on a plane to a blank page would be this product breaking its own promise. What it
        // may not do is ADOPT: taking the anonymous pages is irreversible and it takes ownership of
        // work nobody has claimed, so it waits for the log to say who this is.
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

    // MIDNIGHT, ON A CANVAS NOBODY CLOSED — the native statement of the web's PageStore.rollOver
    // (web/src/products/journal/pageStore.js). The day the writer is standing on is the device's,
    // and an app held past midnight was still writing into the day it launched on.
    //
    // Two halves, because A TIMER IS NOT A CLOCK: this sleep turns the canvas over for someone
    // watching it happen, and the room re-asks on every return to .active (JournalRoom), which is
    // the only thing that catches a midnight the app slept through — a suspended app's sleep does
    // not fire on time, and most nights the phone is in a pocket rather than on the canvas.
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

    // Idempotent — the same day again is nothing at all — because the room says it on every wake.
    //
    // The beat still in the debounce belongs to the day it was TYPED on, so it is written into that
    // day's page before the calendar moves, exactly as a departing seat's is. Then yesterday drops
    // into the history, tonight opens blank, and the window is read again around the new today.
    public func rollOver(to day: LocalDay) async {
        guard day != today else { return }
        keepDraftOnDevice()
        today = day
        body = ""
        mood = .none
        energy = .none
        touched = false
        drawFromCache()
        guard journal != nil else {
            saveState = cache.pending.isEmpty ? saveState : .onThisDevice
            return
        }
        await claimWhatIsOwed()
        await loadWindow()
    }

    // A NEW SEAT, AND THE OLD ONE'S WORDS GO WITH IT. What the departing person had typed but not
    // yet saved is written into THEIR file, unsent, before this store lets go of it — a fix that
    // loses somebody's writing is a worse bug than the leak it closes. Then everything held in
    // memory is dropped: the canvas, the draft, the two scales and the save note all belong to the
    // seat that just left, and the arriving one opens its own file with none of it on screen.
    private func take(_ arriving: Seat) {
        keepDraftOnDevice()
        seat = arriving
        generation += 1
        cache = open(arriving.userId)
        days = []
        body = ""
        mood = .none
        energy = .none
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

    // THE ONE THING THAT CROSSES A SEAT: pages written while nobody was signed in belong to the
    // person who signs in here — the anonymous-first door's whole promise (auth canon §2, "claiming,
    // not gating"). Only the OWED pages travel, because a page already sent belongs to the account
    // that took it.
    //
    // THE ORDER IS THE WHOLE OF THE SAFETY. The anonymous file is emptied only once this seat's file
    // has TAKEN the pages and said so — a full disk, a file the OS refused, and the device is still
    // holding them under the anonymous name for the next attempt. Discarding on a flush nobody
    // checked destroyed the only copy of somebody's writing, which is a worse bug than the leak this
    // seam exists to close.
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
        let seated = generation
        do {
            let winner = try await journal.put(sent)
            // The seat changed while this write was in the air: the reply is the departing person's
            // and everything it would touch — the file, the draft, the save note — is now the
            // arriving person's. Their file already holds the words (keepDraftOnDevice), so there
            // is nothing here to settle and nothing to draw.
            guard seated == generation else { return }
            cache.markPushed(today, winner: winner)
            cache.flush()
            adopt(winner, unmovedFrom: sent)
            settle(.saved)
        } catch {
            // A write that did not land is not a lost write — it is on the device, marked owed,
            // and the retry will carry it. The UI says so and never throws.
            guard seated == generation else { return }
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
        let seated = generation
        for page in cache.pending {
            let winner = try? await journal.put(page)
            // A walk that outlived its seat settles nothing: the file it would write to belongs to
            // whoever is here now, and this claim is that seat's connect to make again.
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
        // The window belongs to the seat that asked for it. Storing it now would file one account's
        // sixty days into whoever's file is open — which is the leak this whole seam exists to stop.
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

    // The days that were written, oldest first. Today is never here — it is the draft.
    private func drawFromCache() {
        days = cache.pages
            .filter { $0.day < today && $0.isWritten }
            .map { CanvasDay(day: $0.day, body: $0.body, mood: $0.mood, energy: $0.energy) }
        if let mine = cache.page(on: today), !touched { adoptDraft(from: mine) }
    }
}
