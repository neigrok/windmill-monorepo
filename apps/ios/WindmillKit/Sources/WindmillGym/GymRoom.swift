import SwiftUI
import WindmillPlatform

// THE ROOM — gym's whole surface: the three tabs a lifter stands in at rest (Routines · The log ·
// Ask), the session they are in the middle of, the screen a session ends on, and the screens a tab
// opens over itself. It draws no capsule, no theme control and nothing about
// billing: the shell owns all three, and a room that drew one of them would be a second copy of a
// decision the shell already made.
//
// THE FRAME, §F, since the 13 Aug routine-first update. Three tabs in one pill rail 14pt off each
// edge — Routines · The log · Ask — then a hairline, then the shell's You seat, which reads as the
// shell's because of the hairline and not because of a different colour. Rail 50, tab 40, nothing
// tappable under 44. ROUTINES IS HOME — the only tab a lifter acts from — and the room anchors to
// it: open() lands there after every start, and finish-Done falls back onto it. The Today tab
// retired ("it implied something was already happening today"); its cargo rehomed onto Routines.
// The primary action is never in the bar and never in a corner: it is full-width, above the rail,
// where a chalked thumb reaches it without regripping. No top-right anything — no account button,
// no hamburger, no theme toggle: appearance is chosen once, in You, and this room only answers it.
//
// WHAT SURVIVED THE COMMENT THIS REPLACED: gym's canon refuses a fourth tab — there is no dashboard
// in this product, and Insights was refused by name. Three tabs stand because Today died as Ask was
// promoted (R7; the 2026-08-11 "not a tab" entry is reversed on the ledger, not silently). The rail
// is drawn on the three tab roots and nowhere else: the logger, the finish and the away screens
// carry the bar alone, because a workout owns the screen it is on.
//
// The way back out of an away screen is the leading end of the room's own bar, opposite the
// seat, and not the top-left corner §G17 draws it in: that corner is the shell's 38pt capsule lane,
// reserved by a safe-area inset in every app. The shell's back GESTURE is the left screen edge and
// takes you home, so a room screen may not claim that edge either.
//
// The skin is stated rather than followed. Journal's night and day are the writer's choice; gym is
// an instrument, so the room says `.dark` outward and the shell dresses the capsule to match.
//
// A ROOM'S STATE DIES WHEN YOU LEAVE IT — the shell mounts this inside `if let openRoom`, so going
// home tears the subtree down and deallocates the store with everything it had scheduled. That is
// why the queue is on disk after every tap and why leaving flushes: journal pays for the same fact
// with a dropped keystroke, and gym would pay for it with a set that is refused forever once the
// session closes.

public struct GymRoom: View {
    private let account: Account

    @StateObject private var store = TrainingStore()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.shellActions) private var shell
    @Environment(\.openURL) private var openURL
    // "windmill.gym.firstSessionOpened" used to live here for the §J22 first-arrival auto-start,
    // retired 2026-08-13 (R6: nothing runs unless the user started it). The stored key lingers
    // harmlessly on installs that set it; nothing reads it any more.
    @State private var finished: FinishedSession?
    @State private var tab: Tab = .routines
    @State private var away: [Away] = []
    @State private var keptRoutine = false
    @State private var starting = false
    // The routine write in flight, and whatever the log said about one that did not land. They live
    // on the ROOM rather than in the editor because the editor is handed a draft and hands one back:
    // whether the log took it is the room's half of that exchange, and a screen holding its own
    // answer would go on drawing a refusal after the walk that fixed it.
    @State private var savingRoutine = false
    @State private var routineFailure: String?
    @State private var note: String?
    // The proposals home has been told "later" about. It lives here rather than on the Routines
    // screen because a walk to the log and back must not bring the card straight back — and it
    // lives in the ROOM rather than on disk because "later" means exactly this visit: the card is
    // on home again the next time the room is opened, which is what makes it a not-now and not a
    // decision.
    @State private var setAside: Set<String> = []
    // ASK'S CONVERSATION, held by the ROOM for the same reason `setAside` is: opening a proposal
    // from an answer tears the chat screen down — one screen is mounted at a time — and a
    // conversation that vanished on the walk to the diff and back would be the one thing a chat may
    // not do. It carries the thread id the questions of this visit belong to.
    //
    // IT DIES WITH THE ROOM AND THE CONVERSATION DOES NOT. Since §O the server keeps the thread, so
    // leaving gym ends the visit rather than the conversation: what this room forgets is on the
    // Threads list, in the lifter's own words, with what came of it.
    @State private var conversation = AskConversation()
    // Whether this Windmill mounts Ask at all. It is a deployment fact, not a plan: a server with no
    // Anthropic key answers the route's own 404, and the entry goes for the rest of the visit rather
    // than staying as a door onto a sentence.
    @State private var askOnThisDeployment = true
    // Which tools of the lifter's own reach this log (§D13). Held by the ROOM because four screens
    // ask the same question — Routines and the opening picker offer the invitation, settings names
    // the state, and the connect screen draws it — and four reads of one account's credentials is
    // how one room shows one account four answers. It starts `unknown`, which asserts nothing.
    @State private var connected: ConnectedLogState = .unknown

    public init(account: Account) {
        self.account = account
    }

    // The three tabs, in the order the rail draws them. Routines first because it is home.
    private enum Tab: String, CaseIterable, Identifiable {
        case routines = "Routines"
        case log = "The log"
        case ask = "Ask"

        var id: String { rawValue }
    }

    // What a tab can open OVER itself: one past session with its sets — which §G18 can correct a
    // set of, so this one is no longer a read — and one movement's record, which is. The session
    // travels as the ROW the list already holds rather than as an
    // id, because that row carries facts no other read gives back — the working count, the tonnage,
    // and whether the four-hour rule closed it rather than a tap. A movement travels as its ID and
    // nothing else: the record page reads its own name, which is the point of the page.
    //
    // THEY STACK, and only two deep: a session read back opens the record of a movement in it, and
    // the way out of that record is the session rather than the tab. §H draws exactly that — the
    // back reads `Push A` and not `The log`.
    private enum Away: Equatable {
        case session(SessionSummary)
        case movement(String)
        // One agent's proposal, by ID and nothing else: the diff is a read of its own, and a screen
        // handed a copy the card was drawn from would be deciding against a document that may have
        // been settled from the web while this room was open.
        //
        // ASK IS NOT A CASE ANY MORE: it is the third TAB since the 13 Aug promotion (R7), and its
        // conversation is still the room's own state below.
        case proposal(String)
        // §O SCREEN 33 — every conversation this account has had, and one of them read back. The
        // list carries no argument; a thread travels as its ID and nothing else, for the reason a
        // proposal does: the page reads its own turns, and a copy handed down the stack would be a
        // conversation as it stood before the walk.
        case threads
        case thread(String)
        // §I's five rows. It is HERE, on the room's own stack, because the native ProductModule seam
        // has no settings slot for the shell to compose — see the head of SettingsScreen. The
        // connect screen stacks OVER it, which is why its label is drawn after all.
        case settings
        // §D12/13 — the invitation, and the words gym puts around a grant the shell owns. It carries
        // no argument: what it draws is the room's own `connected`, so a copy handed down the stack
        // would be a second answer about one account.
        case connect
        // §M SCREEN 30 — one routine, by ID and nothing else, for the same reason a proposal
        // travels that way: the page reads its own history, which the list read does not carry, and
        // a copy handed down the stack would be a routine as it stood before the walk.
        case routine(String)
        // THE ONE EDITOR (R3) — create and edit in one screen, the name inline. The DRAFT travels,
        // because a draft is not on the log yet and there is nowhere else for it to live: it is
        // seeded here and owned by the screen, so a walk to the picker and back does not lose a
        // half-typed day. Leaving the room drops it, which is the same lifetime every unsaved thing
        // in this product has.
        case building(RoutineDraft)

        // What the way back NAMES when this is the screen underneath.
        func label(in catalog: [Exercise]) -> String {
            switch self {
            case .session(let summary): return Readout.routine(of: summary.session)
            case .movement(let exerciseId): return Readout.movement(exerciseId, in: catalog)
            case .proposal: return "Proposal"
            case .threads: return AskThreads.title
            case .thread: return "Conversation"
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
            // Whatever the room has to say about a door that did not open, in ONE place on every
            // screen and always directly above the furniture at the foot: mono, quiet, and never a
            // toast, a spinner or an alert.
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
        // Gym ships one skin and it is dark. Stated inward so the shell's seat and every system
        // control inside the room resolve against it, and outward so the capsule laid over the room
        // is dressed in the same night.
        .environment(\.colorScheme, .dark)
        .roomChrome(.dark)
        .tint(skin.accent)
        // Re-runs whenever who is signed in changes — and once more when a seat that stood unverified
        // on the device's last-known user is verified, because that is the moment the reads it made off
        // the device copy can land on the log. `connect` drains what the device is still holding
        // BEFORE it reads the log, because reading the log settles a stale open session and a set
        // that arrives after that close is refused forever; and landing back inside a workout that
        // never stopped stands where the lifter was, not in the picker over a session of sets.
        .task(id: account.seat) {
            await store.connect(to: account)
            guard store.exerciseId == nil,
                  let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
            await store.choose(movement)
        }
        // A SECOND TASK AND NOT A LINE IN THE FIRST ONE: the read above decides whether a lifter
        // lands back inside the workout they are standing in, and a credential list is never allowed
        // to hold that up. Signed out the answer is known without asking — there is no account for a
        // grant or a key to hang on — and asking anyway would turn a 401 into "nobody is connected".
        // Keyed on the seat, so a verification re-asks a list an unverified launch could not read.
        .task(id: account.seat) {
            connected = account.isSignedIn ? await ConnectedLog.read(with: account.api) : .none
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await store.flushPendingSets() } }
            // Coming back from the web is HOW a connection is made, so the room re-reads rather than
            // standing on an answer from before the walk. `onChange` never fires for the value the
            // scene launched at, so this is not a second read on arrival.
            if phase == .active, account.isSignedIn {
                Task { connected = await ConnectedLog.read(with: account.api) }
            }
        }
        // Leaving the room ENDS the undo window as well as draining the queue: the affordance goes
        // with the subtree, so the gesture the window was protecting is no longer on screen.
        .onDisappear { Task { await store.flushPendingSets(force: true) } }
    }

    // A LIVE SESSION OUTRANKS EVERY TAB AND EVERY AWAY SCREEN. A workout that opens while one
    // of them is up (a start on this phone, a session joined from another device) puts the lifter
    // back where the sets are, because that is the one screen in this product that is time-critical.
    @ViewBuilder
    private var stage: some View {
        if let finished {
            FinishScreen(finished: finished, catalog: store.catalog, kept: keptRoutine,
                         coach: doors(to: finished.session.id),
                         onKeepRoutine: { name in Task { await keep(finished.sets, as: name) } },
                         onDiscard: { Task { await discard(finished.session) } },
                         // Done lands on home (Routines) — stated here rather than inherited from
                         // open(), because a session adopted from another device never went through
                         // open() and its Done must not fall back onto whatever screen the adoption
                         // interrupted.
                         onDone: {
                             self.finished = nil
                             away.removeAll()
                             tab = .routines
                         })
        } else if store.session != nil {
            LoggerScreen(store: store, isSignedIn: account.isSignedIn,
                         // The picker's card, on the SAME rule Routines' invitation keeps — offered
                         // only while nothing is known to reach the log. It is the one solicitation
                         // a lifter would otherwise meet every session, forever.
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
                // A conversation that has just been deleted has nothing left to draw, so the way
                // back is taken FOR the lifter — the list under it re-reads on appearing and the row
                // is gone from it, which is the whole of what "deleted" has to look like.
                ThreadScreen(threadId: threadId, doors: threadDoors, onDeleted: back)
            case .settings:
                SettingsScreen(store: store, web: account.api.baseURL, connected: connected,
                               onConnectedLog: { look(at: .connect) }, say: { note = $0 })
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
                                    // A copy is a NEW routine under a fresh id — the same editor
                                    // again in create mode, with the day as it stands on screen.
                                    // Replacing the stack's top would keep this screen's identity
                                    // and with it the old draft's state; the `.id` below is what
                                    // makes the fresh draft actually take the screen.
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
                               // The proposal card's shortcut onto the Ask tab — absent rather
                               // than dead where the tab would only answer with a stance.
                               onAsk: Ask.doorIsOpen(signedIn: account.isSignedIn,
                                                     sessionIsOpen: store.session != nil,
                                                     onThisDeployment: askOnThisDeployment)
                                   ? { note = nil; tab = .ask } : nil,
                               onSettings: { look(at: .settings) },
                               onSignIn: { shell.openYou() },
                               // Offered where the program is, and withdrawn the moment something
                               // actually reaches this log: an invitation to do the thing you have
                               // already done is advertising.
                               onConnect: connected.invites ? { look(at: .connect) } : nil)
            case .log:
                LogScreen(store: store, onOpen: { look(at: .session($0)) })
            case .ask:
                // THE TAB ROOT (R7): the conversation with the rail under it — or the designed
                // stance when there is no account to read for, or no Ask on this deployment.
                // Never a 401 and never a dead pane.
                if !account.isSignedIn {
                    AskSignedOutStance(onSignIn: { shell.openYou() })
                } else if !askOnThisDeployment {
                    AskAbsentStance()
                } else {
                    AskScreen(store: store, conversation: $conversation, doors: askDoors)
                }
            }
        }
    }

    private var isAtRest: Bool {
        finished == nil && store.session == nil && away.isEmpty
    }

    // THE AWAY SCREEN ON STAGE, which is not simply the top of the stack: a live session and
    // the finish screen both outrank it, and a way back drawn under one of those would be a control
    // that moves a screen nobody can see.
    private var showing: Away? {
        guard finished == nil, store.session == nil else { return nil }
        return away.last
    }

    // Every door in and out of an away screen goes through here for one reason: the note is what
    // the room has to say about the door that did not open ON THE SCREEN YOU ARE ON, and a refusal
    // from home carried under a chart is a sentence about something that is no longer in front of
    // the lifter.
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

    // THE RAIL, §F: three tabs in one pill, then the hairline and the shell's seat, which `YouSeat`
    // brings with it. It is only ever drawn at rest — see the head of this file.
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

    // The bar every screen that is NOT a tab carries: the room's own way back at the leading end,
    // and the shell's seat at the trailing one — the same right edge it sits at in every other app.
    //
    // The way back NAMES where it goes, which on a stack is the screen underneath and only at the
    // bottom of it the tab: a record opened from a session says `Push A` (§H), and one opened from
    // home says `Routines`.
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

    // The share's two doors, bound to one session and handed to the screen that draws it. The base
    // URL comes from the account's own client, so a debug build pointed at a local server hands over
    // a link to that server and never to windmill.works.
    private func doors(to sessionId: String) -> CoachDoors {
        CoachDoors(base: account.api.baseURL,
                   mint: { await store.share(sessionId) },
                   revoke: { await store.revokeShare(sessionId) })
    }

    // WHAT ASK IS LENT, and the network half of it does not go through the store on purpose: a
    // question mints nothing, owes nothing and has no offline half, where every call the store owns
    // decides whether a set somebody lifted survives. The refusal is read at this seam so the screen
    // is handed a sentence rather than an HTTP status.
    private var askDoors: AskDoors {
        let gym = GymApi(api: account.api)
        return AskDoors(
            send: { thread, question in
                do { return .success(try await gym.ask(question, in: thread)) }
                catch { return .failure(AskRefusal(error)) }
            },
            openThreads: { look(at: .threads) },
            // Ask's own paragraph about how to stop needing Ask lands on the invitation rather than
            // in Safari: the pitch, the precondition and the recipe in that order, and the walk to
            // the web is the last step rather than the first.
            connect: { look(at: .connect) },
            openProposal: { look(at: .proposal($0)) },
            absent: { askOnThisDeployment = false })
    }

    // WHAT THE PAST IS LENT (§O). These are handed over unconditionally — nothing here checks
    // `askOnThisDeployment`, because reading and deleting a conversation is not asking one, and the
    // three routes answer on a Windmill whose vendor key was removed.
    //
    // The DOORS onto them are another matter, and this comment does not claim more than the surface
    // reaches: §O draws two, Ask's header and a routine's history row. The header rides the
    // CONVERSATION root only — the tab's signed-out and absent stances carry no threads door — so
    // on a keyless deployment the past is reachable only from a routine that carries an applied Ask
    // proposal. A third door is a board question rather than a thing to invent here; it is filed
    // rather than drawn.
    //
    // `Ask something new` opens a FRESH thread rather than continuing whatever this visit was in the
    // middle of — a new conversation is what the button says, and a question that quietly joined an
    // hour-old thread would title itself with somebody else's opening line.
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

    // THE FREE DOOR — where connecting actually happens, which is a page on a computer: you paste
    // one address into the tool you already run and approve it in the browser. Signed out it opens
    // the shell's door instead — the account is the shell's business, and everything already logged
    // is claimed on the way back.
    //
    // TWO KINDS OF DOOR REACH IT AND ONLY ONE COMES STRAIGHT HERE. The invitation (§D12) is a room
    // screen, so Routines, settings and Ask walk to `ConnectScreen` and it spends this at the foot.
    // §J22's card in the OPENING PICKER cannot: it is drawn inside a running session, where a live
    // workout outranks every away screen, so a tap that pushed one would land on nothing. That card
    // keeps the direct door — which is also the rule the wave states, that the pitch is never drawn
    // mid-session. Both are withdrawn on the same condition, `connected.invites`.
    private func openConnect() {
        guard account.isSignedIn else {
            shell.openYou()
            return
        }
        openURL(URL(string: "/#/connect", relativeTo: account.api.baseURL) ?? account.api.baseURL)
    }

    // Start. A double tap is a second session, so the door closes while the first one is in flight —
    // the log would JOIN the two, but the phone would have asked twice for one workout.
    //
    // A refusal is repeated in the LOG'S OWN WORDS. "no such routine" — the program was deleted from
    // the web — and "the log didn't answer" are different facts, and reporting the first as the
    // second points the lifter at their signal instead of at the routine that is gone.
    private func open(_ routineId: String?) async {
        guard !starting else { return }
        starting = true
        defer { starting = false }
        note = nil
        if case .failure(let why) = await store.start(routineId: routineId) {
            note = why.line("a session starts there")
            // A start is never a silent join (the 13 Aug start contract): when the account already
            // had a workout open, the store re-read the log and adopted it — so the logger is about
            // to be the screen, the note above says plainly that a workout is already open, and the
            // lifter resumes or finishes it deliberately. Standing where its sets are is the same
            // resume the connect task runs.
            guard store.session != nil else { return }
            away.removeAll()
            tab = .routines
            guard let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
            await store.choose(movement)
            return
        }
        // Whatever was open is over: the workout is what this phone is for, and Done on the finish
        // screen must land on home (Routines) — never back on a movement's record, and never on the
        // detail page a start happened to be tapped from.
        away.removeAll()
        tab = .routines
        // Stand where the session stands: at the head of the plan on a fresh start, or wherever the
        // last set went if this same session survived a relaunch on this device.
        guard let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
        await store.choose(movement)
    }

    // Finish. The sets are taken BEFORE the close, because the queue lets go of a delivered row the
    // moment its session ends — and "Keep this as a routine" is composed from exactly those sets.
    //
    // The two outcomes that are not a close leave the session OPEN and say so: a workout that stayed
    // running because a set had not landed is a fact the lifter can act on, and a Finish that
    // silently did nothing is the same screen as a Finish that worked.
    private func close() async {
        guard store.session != nil else { return }
        let performed = store.sets
        note = nil
        switch await store.finish() {
        case .closed(let session):
            keptRoutine = false
            // Reviewed under the id the close CAME BACK with, not the one it went out under — a
            // local finish whose claim reminted the id holds the review under the fresh one.
            finished = FinishedSession(session: session,
                                       sets: performed,
                                       review: await store.review(of: session.id),
                                       isFirst: store.recent.count <= 1)
        case .stranded(let count):
            note = "\(Readout.setCount(count)) still on this device — the session stays open until they land"
        case .failed(let why):
            // The log's own sentence when it sent one — a workout discarded from another surface is
            // not a phone with no signal — and "didn't answer" only for the transport.
            note = why.line("the session is still open")
        }
    }

    // The one destructive action in the product, and a delete that did not happen is the one it may
    // not draw as if it had: the screen only leaves once the log says the session is gone.
    private func discard(_ session: Session) async {
        note = nil
        guard await store.discard(session.id) else {
            note = "the log didn’t answer — the session is still there"
            return
        }
        finished = nil
    }

    // §M's third door — "Build a routine" on the empty home, "New routine" under the list. One
    // editor since R3: it opens with the name inline and empty, chips beside it, and the movements
    // under it, in whatever order the lifter fills them.
    private func newRoutine() {
        routineFailure = nil
        look(at: .building(RoutineDraft(position: store.routines.count)))
    }

    // DELETE, FROM THE EDITOR'S FOOT (R3). The screen only leaves once the log says the routine is
    // gone — a delete that did not happen may not draw as if it had — and it leaves all the way to
    // home, because the pages under it were that routine's own.
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

    // WHETHER THE TARGET SHEET MAY SAY `Never logged — these are your numbers.` It is a fact about
    // the ROUTINE and not about the movement: a day being built has never been run, and so does a
    // day being edited that has never been run. Editing one you HAVE trained says nothing there —
    // the numbers on screen came out of that history and need no disclaimer over them.
    private func untested(_ draft: RoutineDraft) -> Bool {
        store.routines.first { $0.id == draft.id }?.isUntested ?? true
    }

    // SAVED, AND THE SCREEN ONLY LEAVES ONCE THE LOG SAYS SO. A create and a replace are one road
    // here because a draft knows which it is — the routine either exists or it does not — and a
    // screen that closed on a write that never landed would tell the lifter they had a program.
    //
    // It lands on the routine's own page (§M screen 30), which is where `untested`, the open rows
    // and the history are, and never back on the empty editor it was written in.
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
            // AN EDIT CAME FROM THAT PAGE, so it goes BACK to it rather than pushing a second copy
            // of it — a stack holding the same routine twice would make the way out of a page the
            // same page. A build has no page under it and lands on a fresh one.
            guard away.count > 1, away[away.count - 2] == .routine(saved.id) else {
                away[away.count - 1] = .routine(saved.id)
                return
            }
            away.removeLast()
        case .failure(let why):
            routineFailure = why.line("the routine wasn’t saved")
        }
    }

    // Nothing is created until the tap, and nothing is CLAIMED until the log says it was: a screen
    // that hid the offer on the tap would tell the lifter their program had changed on the strength
    // of a request that may never have landed.
    private func keep(_ sets: [TrainingSet], as name: String) async {
        note = nil
        guard await store.keep(sets, asRoutineNamed: name) != nil else {
            note = "the log didn’t answer — the routine wasn’t kept"
            return
        }
        keptRoutine = true
    }
}
