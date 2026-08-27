import SwiftUI
import UIKit
import WindmillPlatform

// The room's state dies when you leave it, which is why the queue is on disk after every tap. Leaving
// does NOT end an undo window: what is held stays held on the queue's own clock, and the one verb
// with no home outside this process — a routine, a conversation, a finished workout — is sent on the
// way out and said on the next open.

public struct GymRoom: View {
    private let account: Account

    @StateObject private var store = TrainingStore()
    // The undo window, hosted here rather than by a screen: leaving keeps it, and the transient that
    // draws it follows the lifter from screen to screen (`13-gestures.md` Law 4).
    @StateObject private var withheld = WithheldWindow()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.shellActions) private var shell
    @Environment(\.openURL) private var openURL
    // The finish is a sheet over the session it just closed, never a screen of its own.
    @State private var finished: FinishedSession?
    // A refusal raised BY the finish sheet belongs inside it: the room's own note line is drawn on the
    // stack underneath, which a `.large` sheet covers, and a refusal nobody can read is a silent death.
    @State private var finishFailure: String?
    @State private var tab: Tab = .routines
    // One path per tab, all three owned here. A TabView keeps every tab mounted, so a stack is never
    // read for a tab that is not on screen — see `stackDepth`.
    @State private var paths: [Tab: [Away]] = [:]
    @State private var keptRoutine = false
    @State private var starting = false
    @State private var savingRoutine = false
    @State private var routineFailure: String?
    @State private var note: String?
    // The review sheet, over whatever is beneath it; a session starting takes it down.
    @State private var reviewing: Reviewing?
    @State private var reviewedLast: String?
    // What this visit decided and what it closed undecided: the receipt lines and the `still waiting` cards.
    // Neither is stored; on re-entering the room both are gone, and nothing pretends otherwise.
    @State private var receipts: [String: String] = [:]
    @State private var undecided: Set<String> = []
    @State private var conversation = AskConversation()
    // A server with no Anthropic key answers the Coach route's 404, and the entry goes for the rest of the visit.
    @State private var askOnThisDeployment = true
    // `unknown` asserts nothing.
    @State private var connected: ConnectedLogState = .unknown

    public init(account: Account) {
        self.account = account
    }

    // The raw value is the tab's identity; `label` is the word a lifter reads, and Coach's is the one
    // the room already pins (`Ask.title`) rather than a second spelling of it.
    private enum Tab: String, CaseIterable, Identifiable {
        case routines
        case log
        case ask

        var id: String { rawValue }

        var label: String {
            switch self {
            case .routines: return "Routines"
            case .log: return "The log"
            case .ask: return Ask.title
            }
        }

        // The selected tab is drawn with a filled symbol as well as a tint, so the symbol carries the
        // half of the signal colour cannot (ledger `1v`).
        var symbol: String {
            switch self {
            case .routines: return "list.bullet.rectangle"
            case .log: return "book.closed"
            case .ask: return "bubble.left.and.bubble.right"
            }
        }
    }

    private struct Reviewing: Identifiable {
        let id: String
    }

    // What a tab can open over itself. The room owns the stacks; each IS a NavigationStack's path, so a
    // system back pops it and the room reads the depth off the same array it pushes onto.
    private enum Away: Hashable {
        case session(SessionSummary)
        case movement(String)
        case bodyweight
        case threads
        case thread(String)
        case notes
        case settings
        case connect
        case routine(String)
        case building(RoutineDraft)

        func label(in catalog: [Exercise], routines: [Routine]) -> String {
            switch self {
            case .session(let summary): return Readout.routine(of: summary.session)
            case .movement(let exerciseId): return Readout.movement(exerciseId, in: catalog)
            case .bodyweight: return Bodyweight.title
            case .threads: return AskThreads.title
            case .thread: return "Conversation"
            case .notes: return Notes.title
            case .settings: return "Gym"
            case .connect: return "Connected log"
            case .routine(let routineId):
                return routines.first { $0.id == routineId }?.name ?? "Routine"
            case .building(let draft): return draft.isNamed ? draft.trimmedName : "New routine"
            }
        }

        // The stack is keyed on where a screen goes, never on what it is holding: a draft's letters
        // change as they are typed, and the path may not move under the screen when they do.
        func hash(into hasher: inout Hasher) {
            hasher.combine(key)
        }

        private var key: String {
            switch self {
            case .session(let summary): return "session:\(summary.id)"
            case .movement(let exerciseId): return "movement:\(exerciseId)"
            case .bodyweight: return "bodyweight"
            case .threads: return "threads"
            case .thread(let threadId): return "thread:\(threadId)"
            case .notes: return "notes"
            case .settings: return "settings"
            case .connect: return "connect"
            case .routine(let routineId): return "routine:\(routineId)"
            case .building(let draft): return "building:\(draft.id)"
            }
        }
    }

    private var skin: GymSkin { .instrument }

    public var body: some View {
        stage
            .background(skin.canvas.ignoresSafeArea())
            .environment(\.gymSkin, skin)
            .environment(\.colorScheme, .dark)
            .roomChrome(.dark)
            // The shell reads this to decide what its leading edge means: home at 0, the room's own back
            // deeper. Written once, here, whatever the stage is drawing.
            .roomDepth(stackDepth)
            .tint(skin.accent)
            .sheet(item: $reviewing, onDismiss: closedTheReview) { open in
                ReviewSheet(proposalId: open.id, store: store,
                            onSettled: { receipt in
                                receipts[open.id] = receipt
                                undecided.remove(open.id)
                            },
                            onClosed: { said in
                                reviewing = nil
                                note = said
                            },
                            say: { note = $0 })
                    .presentationBackground(skin.surface)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            // Over the session it closed. Dismissing it leaves the lifter in the workout they finished.
            .sheet(item: $finished) { closed in
                FinishScreen(finished: closed, catalog: store.catalog, kept: keptRoutine,
                             coach: doors(to: closed.session.id), failure: finishFailure,
                             onKeepRoutine: { name in Task { await keep(closed.sets, as: name) } },
                             onDiscard: { discard(closed.session) },
                             onDone: { finished = nil; finishFailure = nil })
                    .presentationBackground(skin.canvas)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            // `connect` drains what the device holds BEFORE it reads the log: reading settles a stale open session at its last
            // activity, and past four hours from that close an owed set is refused for good.
            .task(id: account.seat) {
                await store.connect(to: account)
                guard store.exerciseId == nil,
                      let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
                await store.choose(movement)
            }
            // Its own task so a credential list never holds up the read above.
            .task(id: account.seat) {
                connected = account.isSignedIn ? await ConnectedLog.read(with: account.api) : .none
            }
            .onChange(of: scenePhase) { _, phase in
                WakeLock.hold(WakeLock.wanted(sessionIsOpen: store.session != nil, phase: phase))
                if phase != .active { Task { await store.flushPendingSets() } }
                // The window is the room's, and the room is not on screen any more — so what is held
                // is let go rather than sent: swipe, switch apps, come back must not be a way to
                // destroy a row with the undo already gone. The rows come back and nothing was sent.
                // `.inactive` is a banner and keeps the window.
                if phase == .background { Task { await withheld.abandon() } }
                // `onChange` never fires for the value the scene launched at.
                if phase == .active, account.isSignedIn {
                    Task { connected = await ConnectedLog.read(with: account.api) }
                }
            }
            // Held while the room holds an open session, whichever way it opened or closed: finish, discard, a start, a connect.
            // A session outranks the stage the sheet stood over, so the sheet is taken down with it.
            .onChange(of: store.session != nil, initial: true) { _, open in
                WakeLock.hold(WakeLock.wanted(sessionIsOpen: open, phase: scenePhase))
                if open { reviewing = nil }
            }
            // Leaving a SCREEN keeps the window; leaving the ROOM is the register dying, and a verb
            // whose only home is the register is let go rather than sent. What is owed and ready
            // still goes: the queue's holds are its own.
            .onDisappear {
                WakeLock.hold(false)
                Task {
                    await withheld.abandon()
                    await store.flushPendingSets()
                }
            }
    }

    // A live session outranks every tab: it replaces them, and it carries the room's chrome itself.
    @ViewBuilder
    private var stage: some View {
        if store.session != nil {
            NavigationStack {
                LoggerScreen(store: store, withheld: withheld, isSignedIn: account.isSignedIn,
                             onBuildRoutine: connected.invites ? openConnect : nil,
                             say: { note = $0 })
                    .background(skin.canvas)
                    .navigationBarMargin()
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) { CapsuleButton() }
                        // The rarer act by two orders of magnitude, and the one you never want under a
                        // wet thumb beside `Log set` (16-the-workout.md).
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Finish") { Task { await close() } }
                                .font(WindmillFont.body(15, .semibold))
                                .disabled(store.isFinishing)
                        }
                        ToolbarItem(placement: .topBarTrailing) { YouSeat() }
                    }
            }
            .overlay(alignment: .bottom) {
                WithheldTransient(window: withheld, say: { note = $0 })
                    // The transient declares a transition, and a transition needs an animated
                    // transaction to fire: without this it would pop in and out.
                    .animation(.snappy, value: withheld.held.count)
            }
            .safeAreaInset(edge: .bottom) { noteLine }
        } else {
            TabView(selection: $tab) {
                ForEach(Tab.allCases) { destination in
                    stack(for: destination)
                        .tabItem { Label(destination.label, systemImage: destination.symbol) }
                        .tag(destination)
                }
            }
            // No `.tint` here, and the reason is measured rather than preferred. `.tint` is an
            // ENVIRONMENT value: put on the TabView it reaches every control in all three tabs and
            // every sheet they raise, so a tint chosen for the tab bar repaints the picker's Create
            // button, the editor's Cancel and Save, and every other default-tinted control. On iOS
            // 26.3 (iPhone 17) it buys nothing in exchange: the system tab bar paints BOTH labels
            // itself — #FFFFFF selected against #F6F3FA unselected, 1.10:1 — and ignores `.tint`,
            // `UITabBarAppearance` and `unselectedItemTintColor` alike. What signals selection there
            // is the capsule the system draws behind the selected item (#47444A on the bar's
            // #262328, 1.62:1) plus the filled symbol. Ledger `1v` cannot be closed by any token this
            // room chooses on that OS; the room's own `.tint(skin.accent)` holds everywhere instead.
        }
    }

    // One stack per tab, and one writer of the room's chrome: the capsule leading, the You seat
    // trailing, on every root (`12-native-idiom.md`, ledger `1l`).
    private func stack(for destination: Tab) -> some View {
        NavigationStack(path: path(of: destination)) {
            tabRoot(destination)
                .background(skin.canvas)
                .navigationBarMargin()
                .navigationTitle(destination.label)
                .navigationBarTitleDisplayMode(destination == .ask ? .inline : .large)
                .navigationDestination(for: Away.self) { pushed in
                    screen(at: pushed)
                        .background(skin.canvas)
                        .navigationTitle(pushed.label(in: store.catalog, routines: store.routines))
                        .navigationBarTitleDisplayMode(.inline)
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { CapsuleButton() }
                    // Planning work goes to the top chrome; nobody plans a training block one-handed
                    // at the rack (`12-native-idiom.md`).
                    if destination == .routines {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button(action: newRoutine) {
                                Label("New routine", systemImage: "plus")
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) { YouSeat() }
                }
        }
        // The transient floats over the reach band; the room's status line sits BELOW it, so a refusal
        // said while a window runs is never hidden by the way back.
        .overlay(alignment: .bottom) {
                WithheldTransient(window: withheld, say: { note = $0 })
                    // The transient declares a transition, and a transition needs an animated
                    // transaction to fire: without this it would pop in and out.
                    .animation(.snappy, value: withheld.held.count)
            }
        .safeAreaInset(edge: .bottom) { noteLine }
    }

    private func path(of destination: Tab) -> Binding<[Away]> {
        Binding(get: { paths[destination] ?? [] }, set: { paths[destination] = $0 })
    }

    // The room's one status line, above the tab bar and above whatever the tab is drawing.
    @ViewBuilder
    private var noteLine: some View {
        if let note {
            Text(note)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkDim)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, WindmillSpace.x5)
                .padding(.bottom, WindmillSpace.x2)
        }
    }

    @ViewBuilder
    private func screen(at destination: Away) -> some View {
        switch destination {
            case .session(let summary):
                SessionScreen(summary: summary, store: store, withheld: withheld,
                              coach: doors(to: summary.session.id),
                              onMovement: { look(at: .movement($0)) },
                              onDiscard: { discard(summary.session) })
            case .movement(let exerciseId):
                RecordScreen(exerciseId: exerciseId, store: store, isSignedIn: account.isSignedIn)
            case .bodyweight:
                BodyweightScreen(store: store, say: { note = $0 })
            case .threads:
                ThreadsScreen(doors: threadDoors, withheld: withheld)
            case .thread(let threadId):
                ThreadScreen(threadId: threadId, doors: threadDoors,
                             receipts: receipts, undecided: undecided)
            case .notes:
                if account.isSignedIn {
                    NotesScreen(doors: notesDoors)
                } else {
                    NotesSignedOutStance(onSignIn: { shell.openYou() })
                }
            case .settings:
                SettingsScreen(store: store, web: account.api.baseURL, connected: connected,
                               onConnectedLog: { look(at: .connect) }, onNotes: { look(at: .notes) },
                               say: { note = $0 })
            case .connect:
                ConnectScreen(state: connected, isSignedIn: account.isSignedIn,
                              web: account.api.baseURL, onConnect: openConnect)
            case .routine(let routineId):
                RoutineScreen(routineId: routineId, store: store,
                              onStart: { Task { await open(routineId) } },
                              onEdit: { look(at: .building(RoutineDraft(editing: $0))) },
                              onMovement: { look(at: .movement($0)) },
                              onProposal: review,
                              onThread: { look(at: .thread($0)) })
            case .building(let draft):
                RoutineEditorScreen(draft: draft, catalog: store.catalog, sessions: store.recent,
                                    editing: store.routines.contains { $0.id == draft.id },
                                    untested: untested(draft), saving: savingRoutine,
                                    failure: routineFailure,
                                    onSave: { written in Task { await save(written) } },
                                    onCancel: back,
                                    // A copy is a new routine under a fresh id; `.id(draft.id)` is what gives it the screen.
                                    onDuplicate: { copied in
                                        replaceTop(with: .building(
                                            RoutineDraft(duplicating: copied,
                                                         position: store.routines.count)))
                                    },
                                    onCreateMovement: { name, equipment in
                                        await store.create(name, loadedAs: equipment)
                                    })
                    .id(draft.id)
        }
    }

    @ViewBuilder
    private func tabRoot(_ destination: Tab) -> some View {
        switch destination {
            case .routines:
                RoutinesScreen(store: store, isSignedIn: account.isSignedIn, undecided: undecided,
                               onOpen: { look(at: .routine($0)) },
                               onDelete: withholdDelete(of:),
                               onNew: newRoutine,
                               onStartLogging: { Task { await open(nil) } },
                               onMovement: { look(at: .movement($0)) },
                               onProposal: review,
                               onSettings: { look(at: .settings) },
                               onSignIn: { shell.openYou() })
            case .log:
                LogScreen(store: store, onOpen: { look(at: .session($0)) },
                          onBodyweight: { look(at: .bodyweight) },
                          share: { doors(to: $0) }, discard: discard(_:), say: { note = $0 })
            case .ask:
                if !account.isSignedIn {
                    AskSignedOutStance(onSignIn: { shell.openYou() })
                } else if !askOnThisDeployment {
                    AskAbsentStance(onNotes: { look(at: .notes) })
                } else {
                    AskScreen(store: store, conversation: $conversation, doors: askDoors,
                              receipts: receipts, undecided: undecided)
                }
        }
    }

    // Zero whenever the stacks are not what is on screen, so the shell's leading edge means home there,
    // and the VISIBLE tab's depth otherwise — never the deepest of the three, which would disable the
    // way home from a tab standing at its own root.
    private var stackDepth: Int {
        guard store.session == nil else { return 0 }
        return paths[tab]?.count ?? 0
    }

    private func look(at destination: Away) {
        note = nil
        routineFailure = nil
        paths[tab, default: []].append(destination)
    }

    // Over the conversation, over the routines home, over the routine: a sheet, never a push.
    private func review(_ proposalId: String) {
        note = nil
        reviewedLast = proposalId
        reviewing = Reviewing(id: proposalId)
    }

    // Closing decides nothing: a proposal the sheet did not settle is still waiting, and the card says so.
    private func closedTheReview() {
        guard let last = reviewedLast, receipts[last] == nil else { return }
        undecided.insert(last)
    }

    private func back() {
        note = nil
        routineFailure = nil
        guard !(paths[tab]?.isEmpty ?? true) else { return }
        paths[tab]?.removeLast()
    }

    private func replaceTop(with destination: Away) {
        guard let held = paths[tab], !held.isEmpty else { return }
        paths[tab]?[held.count - 1] = destination
    }

    private func doors(to sessionId: String) -> CoachDoors {
        CoachDoors(base: account.api.baseURL,
                   mint: { await store.share(sessionId) },
                   revoke: { await store.revokeShare(sessionId) })
    }

    private var askDoors: AskDoors {
        let gym = GymApi(api: account.api)
        return AskDoors(
            send: { thread, question in
                do { return .success(try await gym.ask(question, in: thread)) }
                catch { return .failure(AskRefusal(error)) }
            },
            openThreads: { look(at: .threads) },
            openNotes: { look(at: .notes) },
            connect: { look(at: .connect) },
            openProposal: review,
            absent: { askOnThisDeployment = false })
    }

    // Account-only, straight to the log: no device copy, no claim slot.
    private var notesDoors: NotesDoors {
        let gym = GymApi(api: account.api)
        return NotesDoors(
            list: {
                do { return .success(try await gym.notes()) }
                catch { return .failure(NotesRefusal(error)) }
            },
            write: { id, write in
                do { return .success(try await gym.writeNote(id, write)) }
                catch { return .failure(NotesRefusal(error)) }
            },
            delete: { id in
                do {
                    try await gym.deleteNote(id)
                    return nil
                } catch {
                    return NotesRefusal(error).line
                }
            },
            reorder: { order in
                do { return .success(try await gym.reorderNotes(order)) }
                catch { return .failure(NotesRefusal(error)) }
            })
    }

    // The thread routes answer even where Coach itself is not mounted, so nothing here checks `askOnThisDeployment`.
    private var threadDoors: ThreadDoors {
        let gym = GymApi(api: account.api)
        return ThreadDoors(
            // The list is re-read from the server, so a delete still inside its window has to come
            // out of the answer: nothing was sent, and the row would otherwise walk back in.
            list: {
                do { return .success(try await gym.threads().filter { !withheld.hides(.thread, $0.id) }) }
                catch { return .failure(AskRefusal(error)) }
            },
            read: { id in
                do { return .success(try await gym.thread(id)) }
                catch { return .failure(AskRefusal(error)) }
            },
            delete: { thread in withholdDelete(of: thread, through: gym) },
            openThread: { look(at: .thread($0)) },
            openProposal: review,
            askSomethingNew: {
                conversation = AskConversation()
                note = nil
                paths[.ask] = []
                tab = .ask
            })
    }

    private func openConnect() {
        guard account.isSignedIn else {
            shell.openYou()
            return
        }
        openURL(URL(string: "/#/connect", relativeTo: account.api.baseURL) ?? account.api.baseURL)
    }

    // A double tap is a second session, so the door closes while the first one is in flight.
    private func open(_ routineId: String?) async {
        guard !starting else { return }
        starting = true
        defer { starting = false }
        note = nil
        if case .failure(let why) = await store.start(routineId: routineId) {
            note = why.line("a session starts there")
            guard store.session != nil else { return }
            unwind()
            guard let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
            await store.choose(movement)
            return
        }
        unwind()
        guard let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
        await store.choose(movement)
    }

    // A NavigationStack owns its own path, so a session opening has to say so: a stack left standing
    // behind a live logger is a lifter who finishes a workout and lands three screens deep in an editor.
    private func unwind() {
        paths.removeAll()
        tab = .routines
    }

    // The sets are taken BEFORE the close: the queue lets go of a delivered row the moment its session ends.
    private func close() async {
        guard store.session != nil else { return }
        let performed = store.sets
        note = nil
        switch await store.finish() {
        case .closed(let session):
            GymConfirm.finished()
            keptRoutine = false
            finishFailure = nil
            // The sheet stands over the session it just closed, so the room navigates there first.
            paths.removeAll()
            tab = .log
            paths[.log] = [.session(store.recent.first { $0.id == session.id }
                                    ?? SessionSummary(session: session))]
            // Reviewed under the id the close came back with, never the one it went out under.
            finished = FinishedSession(session: session,
                                       sets: performed,
                                       review: await store.review(of: session.id),
                                       isFirst: store.recent.count <= 1)
        case .stranded(let count):
            note = "\(Readout.setCount(count)) still on this device — the session stays open until they land"
        case .failed(let why):
            note = why.line("the session is still open")
        }
    }

    private func newRoutine() {
        routineFailure = nil
        look(at: .building(RoutineDraft(position: store.routines.count)))
    }

    // MARK: - the three withheld deletes

    // Nothing reaches the wire while the window runs, because a send cannot be taken back. The row
    // leaves the list here, the transient carries the way back, and only the window's own clock calls
    // the verb (`13-gestures.md`, the gate the whole gesture wave stands behind).
    private func withholdDelete(of routine: Routine) {
        note = nil
        Task {
            await withheld.hold(Withheld(
                .routine, subject: routine.id,
                line: WithheldWords.routine(routine.name),
                detail: WithheldWords.routineDetail,
                take: { _ in store.withhold(routine: routine) },
                settle: {
                    guard let why = await store.settleDelete(routine: routine.id) else { return true }
                    store.restore(routine: routine)
                    note = why.line("the routine wasn’t deleted")
                    return false
                },
                restore: { store.restore(routine: routine) }))
        }
    }

    private func withholdDelete(of thread: AskThread, through gym: GymApi) {
        note = nil
        Task {
            await withheld.hold(Withheld(
                .thread, subject: thread.id,
                line: WithheldWords.thread,
                detail: WithheldWords.threadDetail,
                settle: {
                    do {
                        try await gym.deleteThread(thread.id)
                        return true
                    } catch {
                        note = AskRefusal(error).line
                        return false
                    }
                }))
        }
    }

    private func discard(_ session: Session) {
        note = nil
        finishFailure = nil
        finished = nil
        // Reached from the finish sheet and from the log row's menu. Either way the screen under it
        // may be the session that is on its way out, so the log stack goes back to its root.
        paths[.log] = []
        Task {
            await withheld.hold(Withheld(
                .session, subject: session.id,
                line: WithheldWords.session,
                take: { _ in store.withhold(session: session.id) },
                settle: {
                    guard await store.settleDelete(session: session.id) else {
                        store.restore(session: session.id)
                        note = "the log didn’t answer — the session is still there"
                        return false
                    }
                    return true
                },
                restore: { store.restore(session: session.id) }))
        }
    }

    private func untested(_ draft: RoutineDraft) -> Bool {
        store.routines.first { $0.id == draft.id }?.isUntested ?? true
    }

    private func save(_ draft: RoutineDraft) async {
        guard !savingRoutine else { return }
        savingRoutine = true
        defer { savingRoutine = false }
        routineFailure = nil
        let written = store.routines.contains { $0.id == draft.id }
            ? await store.replace(draft)
            : await store.create(draft)
        switch written {
        case .success(let saved):
            GymConfirm.saved()
            // An edit returns to the routine page underneath rather than pushing a second copy of it.
            let held = paths[tab] ?? []
            guard held.count > 1, held[held.count - 2] == .routine(saved.id) else {
                replaceTop(with: .routine(saved.id))
                return
            }
            back()
        case .failure(let why):
            routineFailure = why.line("the routine wasn’t saved")
        }
    }

    private func keep(_ sets: [TrainingSet], as name: String) async {
        note = nil
        finishFailure = nil
        guard await store.keep(sets, asRoutineNamed: name) != nil else {
            finishFailure = "the log didn’t answer — the routine wasn’t kept"
            return
        }
        keptRoutine = true
    }
}

// The phone owns the open session, so the screen stays awake for it; released on every way out of the room.
enum WakeLock {
    static func wanted(sessionIsOpen: Bool, phase: ScenePhase) -> Bool {
        sessionIsOpen && phase == .active
    }

    @MainActor
    static func hold(_ held: Bool) {
        guard UIApplication.shared.isIdleTimerDisabled != held else { return }
        UIApplication.shared.isIdleTimerDisabled = held
    }
}
