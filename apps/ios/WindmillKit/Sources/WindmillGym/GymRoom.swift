import SwiftUI
import UIKit
import WindmillPlatform

// The room's state dies when you leave it, which is why the queue is on disk after every tap and why leaving flushes.

public struct GymRoom: View {
    private let account: Account

    @StateObject private var store = TrainingStore()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.shellActions) private var shell
    @Environment(\.openURL) private var openURL
    @State private var finished: FinishedSession?
    @State private var tab: Tab = .routines
    @State private var away: [Away] = []
    @State private var keptRoutine = false
    @State private var starting = false
    @State private var savingRoutine = false
    @State private var routineFailure: String?
    @State private var note: String?
    // "Later" means exactly this visit: the room holds it, never disk.
    @State private var setAside: Set<String> = []
    @State private var conversation = AskConversation()
    // A server with no Anthropic key answers the Coach route's 404, and the entry goes for the rest of the visit.
    @State private var askOnThisDeployment = true
    // `unknown` asserts nothing.
    @State private var connected: ConnectedLogState = .unknown

    public init(account: Account) {
        self.account = account
    }

    private enum Tab: String, CaseIterable, Identifiable {
        case routines = "Routines"
        case log = "The log"
        case ask = "Coach"

        var id: String { rawValue }
    }

    // What a tab can open over itself. They stack, and only two deep.
    private enum Away: Equatable {
        case session(SessionSummary)
        case movement(String)
        case proposal(String)
        case threads
        case thread(String)
        case notes
        case settings
        case connect
        case routine(String)
        case building(RoutineDraft)

        func label(in catalog: [Exercise]) -> String {
            switch self {
            case .session(let summary): return Readout.routine(of: summary.session)
            case .movement(let exerciseId): return Readout.movement(exerciseId, in: catalog)
            case .proposal: return "Proposal"
            case .threads: return AskThreads.title
            case .thread: return "Conversation"
            case .notes: return Notes.title
            case .settings: return "Gym"
            case .connect: return "Connected log"
            case .routine: return "Routine"
            case .building(let draft): return draft.isNamed ? draft.trimmedName : "New routine"
            }
        }
    }

    private var skin: GymSkin { .instrument }

    public var body: some View {
        VStack(spacing: 0) {
            stage
            if let note {
                Text(note)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkDim)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, WindmillSpace.x5)
                    .padding(.bottom, WindmillSpace.x2)
            }
            if isAtRest { rail } else { bar }
        }
        .background(skin.canvas.ignoresSafeArea())
        .environment(\.gymSkin, skin)
        .environment(\.colorScheme, .dark)
        .roomChrome(.dark)
        .tint(skin.accent)
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
            // `onChange` never fires for the value the scene launched at.
            if phase == .active, account.isSignedIn {
                Task { connected = await ConnectedLog.read(with: account.api) }
            }
        }
        // Held while the room holds an open session, whichever way it opened or closed: finish, discard, a start, a connect.
        .onChange(of: store.session != nil, initial: true) { _, open in
            WakeLock.hold(WakeLock.wanted(sessionIsOpen: open, phase: scenePhase))
        }
        .onDisappear {
            WakeLock.hold(false)
            Task { await store.flushPendingSets(force: true) }
        }
    }

    // A live session outranks every tab and every away screen.
    @ViewBuilder
    private var stage: some View {
        if let finished {
            FinishScreen(finished: finished, catalog: store.catalog, kept: keptRoutine,
                         coach: doors(to: finished.session.id),
                         onKeepRoutine: { name in Task { await keep(finished.sets, as: name) } },
                         onDiscard: { Task { await discard(finished.session) } },
                         onDone: {
                             self.finished = nil
                             away.removeAll()
                             tab = .routines
                         })
        } else if store.session != nil {
            LoggerScreen(store: store, isSignedIn: account.isSignedIn,
                         onBuildRoutine: connected.invites ? openConnect : nil,
                         say: { note = $0 }, onFinish: { Task { await close() } })
        } else if let showing {
            switch showing {
            case .session(let summary):
                SessionScreen(summary: summary, store: store,
                              coach: doors(to: summary.session.id),
                              onMovement: { look(at: .movement($0)) })
            case .movement(let exerciseId):
                RecordScreen(exerciseId: exerciseId, store: store, isSignedIn: account.isSignedIn)
            case .proposal(let proposalId):
                ProposalScreen(proposalId: proposalId, store: store,
                               onClosed: { said in back(); note = said },
                               say: { note = $0 })
            case .threads:
                ThreadsScreen(doors: threadDoors)
            case .thread(let threadId):
                ThreadScreen(threadId: threadId, doors: threadDoors, onDeleted: back)
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
                              onProposal: { look(at: .proposal($0)) },
                              onThread: { look(at: .thread($0)) })
            case .building(let draft):
                RoutineEditorScreen(draft: draft, catalog: store.catalog,
                                    editing: store.routines.contains { $0.id == draft.id },
                                    untested: untested(draft), saving: savingRoutine,
                                    failure: routineFailure,
                                    onSave: { written in Task { await save(written) } },
                                    // A copy is a new routine under a fresh id; `.id(draft.id)` is what gives it the screen.
                                    onDuplicate: { copied in
                                        away[away.count - 1] = .building(
                                            RoutineDraft(duplicating: copied,
                                                         position: store.routines.count))
                                    },
                                    onDelete: { Task { await delete(draft.id) } },
                                    onCreateMovement: { name, equipment in
                                        await store.create(name, loadedAs: equipment)
                                    })
                    .id(draft.id)
            }
        } else {
            switch tab {
            case .routines:
                RoutinesScreen(store: store, isSignedIn: account.isSignedIn, setAside: setAside,
                               onOpen: { look(at: .routine($0)) },
                               onNew: newRoutine,
                               onStartLogging: { Task { await open(nil) } },
                               onMovement: { look(at: .movement($0)) },
                               onProposal: { look(at: .proposal($0)) },
                               onLater: { setAside.insert($0) },
                               onAsk: Ask.doorIsOpen(signedIn: account.isSignedIn,
                                                     sessionIsOpen: store.session != nil,
                                                     onThisDeployment: askOnThisDeployment)
                                   ? { note = nil; tab = .ask } : nil,
                               onSettings: { look(at: .settings) },
                               onSignIn: { shell.openYou() },
                               onConnect: connected.invites ? { look(at: .connect) } : nil)
            case .log:
                LogScreen(store: store, onOpen: { look(at: .session($0)) })
            case .ask:
                if !account.isSignedIn {
                    AskSignedOutStance(onSignIn: { shell.openYou() })
                } else if !askOnThisDeployment {
                    AskAbsentStance(onNotes: { look(at: .notes) })
                } else {
                    AskScreen(store: store, conversation: $conversation, doors: askDoors)
                }
            }
        }
    }

    private var isAtRest: Bool {
        finished == nil && store.session == nil && away.isEmpty
    }

    private var showing: Away? {
        guard finished == nil, store.session == nil else { return nil }
        return away.last
    }

    private func look(at destination: Away) {
        note = nil
        routineFailure = nil
        away.append(destination)
    }

    private func back() {
        note = nil
        routineFailure = nil
        away.removeLast()
    }

    private var rail: some View {
        HStack(spacing: WindmillSpace.x1) {
            ForEach(Tab.allCases) { destination in
                Button { note = nil; away.removeAll(); tab = destination } label: {
                    Text(destination.rawValue)
                        .font(WindmillFont.body(13, destination == tab ? .bold : .semibold))
                        .foregroundStyle(destination == tab ? skin.accent : skin.inkFaint)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.full)
                            .fill(destination == tab ? skin.accentSoft : .clear))
                }
                .accessibilityAddTraits(destination == tab ? [.isSelected] : [])
            }
            YouSeat()
        }
        .padding(WindmillSpace.x1)
        .frame(minHeight: 50)
        .background(Capsule().fill(skin.surface))
        .overlay(Capsule().strokeBorder(skin.line, lineWidth: 1))
        .padding(.horizontal, 14)
        .padding(.bottom, WindmillSpace.x2)
    }

    private var bar: some View {
        HStack(spacing: WindmillSpace.x3) {
            if showing != nil {
                Button { back() } label: {
                    HStack(spacing: WindmillSpace.x1) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .semibold))
                        Text(away.count > 1
                                ? away[away.count - 2].label(in: store.catalog)
                                : tab.rawValue)
                            .font(WindmillFont.body(15, .semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
                }
            }
            Spacer(minLength: 0)
            YouSeat()
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x2)
        .frame(minHeight: 46)
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
            openProposal: { look(at: .proposal($0)) },
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
            list: {
                do { return .success(try await gym.threads()) }
                catch { return .failure(AskRefusal(error)) }
            },
            read: { id in
                do { return .success(try await gym.thread(id)) }
                catch { return .failure(AskRefusal(error)) }
            },
            delete: { id in
                do {
                    try await gym.deleteThread(id)
                    return nil
                } catch {
                    return AskRefusal(error).line
                }
            },
            openThread: { look(at: .thread($0)) },
            openProposal: { look(at: .proposal($0)) },
            askSomethingNew: {
                conversation = AskConversation()
                note = nil
                away.removeAll()
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
            away.removeAll()
            tab = .routines
            guard let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
            await store.choose(movement)
            return
        }
        away.removeAll()
        tab = .routines
        guard let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
        await store.choose(movement)
    }

    // The sets are taken BEFORE the close: the queue lets go of a delivered row the moment its session ends.
    private func close() async {
        guard store.session != nil else { return }
        let performed = store.sets
        note = nil
        switch await store.finish() {
        case .closed(let session):
            keptRoutine = false
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

    private func discard(_ session: Session) async {
        note = nil
        guard await store.discard(session.id) else {
            note = "the log didn’t answer — the session is still there"
            return
        }
        finished = nil
    }

    private func newRoutine() {
        routineFailure = nil
        look(at: .building(RoutineDraft(position: store.routines.count)))
    }

    private func delete(_ routineId: String) async {
        guard !savingRoutine else { return }
        savingRoutine = true
        defer { savingRoutine = false }
        routineFailure = nil
        if let why = await store.deleteRoutine(routineId) {
            routineFailure = why.line("the routine wasn’t deleted")
            return
        }
        away.removeAll()
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
            // An edit returns to the routine page underneath rather than pushing a second copy of it.
            guard away.count > 1, away[away.count - 2] == .routine(saved.id) else {
                away[away.count - 1] = .routine(saved.id)
                return
            }
            away.removeLast()
        case .failure(let why):
            routineFailure = why.line("the routine wasn’t saved")
        }
    }

    private func keep(_ sets: [TrainingSet], as name: String) async {
        note = nil
        guard await store.keep(sets, asRoutineNamed: name) != nil else {
            note = "the log didn’t answer — the routine wasn’t kept"
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
