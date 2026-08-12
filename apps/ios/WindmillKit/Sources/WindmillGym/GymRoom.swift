import SwiftUI
import WindmillPlatform

// THE ROOM — gym's whole surface: the three tabs a lifter stands in at rest (Today, The log,
// Routines), the session they are in the middle of, the screen a session ends on, and the two
// read-only screens a tab opens over itself. It draws no capsule, no theme control and nothing about
// billing: the shell owns all three, and a room that drew one of them would be a second copy of a
// decision the shell already made.
//
// THE FRAME, §F, 2026-08-12. Three tabs in one pill rail 14pt off each edge — Today · The log ·
// Routines — then a hairline, then the shell's You seat, which reads as the shell's because of the
// hairline and not because of a different colour. Rail 50, tab 40, nothing tappable under 44. The
// primary action is never in the bar and never in a corner: it is full-width, above the rail, where
// a chalked thumb reaches it without regripping. No top-right anything — no account button, no
// hamburger, no theme toggle: appearance is chosen once, in You, and this room only answers it.
//
// WHAT SURVIVED THE COMMENT THIS REPLACED: gym's canon refuses a FOURTH tab — there is no dashboard
// in this product, and Insights was refused by name. That stands. "Therefore no tab bar at all" was
// this room's own inference from it and §F contradicts it; the block arguing for the shape is gone
// with the shape. The rail is drawn on the three tabs and nowhere else: the logger, the finish and
// the two read-only screens carry the bar alone, because a workout owns the screen it is on.
//
// The way back out of a read-only screen is the leading end of the room's own bar, opposite the
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
    @State private var finished: FinishedSession?
    @State private var tab: Tab = .today
    @State private var away: [Away] = []
    @State private var keptRoutine = false
    @State private var starting = false
    @State private var note: String?

    public init(account: Account) {
        self.account = account
    }

    // The three tabs, in the order the rail draws them.
    private enum Tab: String, CaseIterable, Identifiable {
        case today = "Today"
        case log = "The log"
        case routines = "Routines"

        var id: String { rawValue }
    }

    // What a tab can open OVER itself, and both are read-only: one past session with its sets, and
    // one movement's record. The session travels as the ROW the list already holds rather than as an
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

        // What the way back NAMES when this is the screen underneath.
        func label(in catalog: [Exercise]) -> String {
            switch self {
            case .session(let summary): return Readout.routine(of: summary.session)
            case .movement(let exerciseId): return Readout.movement(exerciseId, in: catalog)
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
        // Re-runs whenever who is signed in changes. `connect` drains what the device is still
        // holding BEFORE it reads the log, because reading the log settles a stale open session and
        // a set that arrives after that close is refused forever; and landing back inside a workout
        // that never stopped stands where the lifter was, not in the picker over a session of sets.
        .task(id: account.user?.id) {
            await store.connect(to: account)
            guard store.exerciseId == nil,
                  let movement = LiveOrder.resume(order: store.order, sets: store.sets) else { return }
            await store.choose(movement)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await store.flushPendingSets() } }
        }
        // Leaving the room ENDS the undo window as well as draining the queue: the affordance goes
        // with the subtree, so the gesture the window was protecting is no longer on screen.
        .onDisappear { Task { await store.flushPendingSets(force: true) } }
    }

    // A LIVE SESSION OUTRANKS EVERY TAB AND EVERY READ-ONLY SCREEN. A workout that opens while one
    // of them is up (a start on this phone, a session joined from another device) puts the lifter
    // back where the sets are, because that is the one screen in this product that is time-critical.
    @ViewBuilder
    private var stage: some View {
        if let finished {
            FinishScreen(finished: finished, catalog: store.catalog, kept: keptRoutine,
                         coach: doors(to: finished.session.id),
                         onKeepRoutine: { name in Task { await keep(finished.sets, as: name) } },
                         onDiscard: { Task { await discard(finished.session) } },
                         onDone: { self.finished = nil })
        } else if store.session != nil {
            LoggerScreen(store: store, say: { note = $0 }, onFinish: { Task { await close() } })
        } else if let showing {
            switch showing {
            case .session(let summary):
                SessionScreen(summary: summary, store: store,
                              coach: doors(to: summary.session.id),
                              onMovement: { look(at: .movement($0)) })
            case .movement(let exerciseId):
                RecordScreen(exerciseId: exerciseId, store: store, isSignedIn: account.isSignedIn)
            }
        } else {
            switch tab {
            case .today:
                TodayScreen(store: store, isSignedIn: account.isSignedIn,
                            onStart: { routineId in Task { await open(routineId) } },
                            onMovement: { look(at: .movement($0)) },
                            onOpenSession: { look(at: .session($0)) },
                            onSignIn: { shell.openYou() })
            case .log:
                LogScreen(store: store, onOpen: { look(at: .session($0)) })
            case .routines:
                RoutinesScreen(store: store, onStart: { routineId in Task { await open(routineId) } },
                               onMovement: { look(at: .movement($0)) })
            }
        }
    }

    private var isAtRest: Bool {
        finished == nil && store.session == nil && away.isEmpty
    }

    // THE READ-ONLY SCREEN ON STAGE, which is not simply the top of the stack: a live session and
    // the finish screen both outrank it, and a way back drawn under one of those would be a control
    // that moves a screen nobody can see.
    private var showing: Away? {
        guard finished == nil, store.session == nil else { return nil }
        return away.last
    }

    // Every door in and out of a read-only screen goes through here for one reason: the note is what
    // the room has to say about the door that did not open ON THE SCREEN YOU ARE ON, and a refusal
    // from Today carried under a chart is a sentence about something that is no longer in front of
    // the lifter.
    private func look(at destination: Away) {
        note = nil
        away.append(destination)
    }

    private func back() {
        note = nil
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
    // Today says `Today`.
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
            return
        }
        // Whatever was open is over: the workout is what this phone is for, and Done on the finish
        // screen must land on Today — never back on a movement's record, and never on the routines
        // list a start happened to be tapped from.
        away.removeAll()
        tab = .today
        // A start JOINS whatever session is already open, so what came back may be a workout with
        // sets in it — stand where that workout is, not at the head of the routine that was asked for.
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
        case .noAnswer:
            note = "the log didn’t answer — the session is still open"
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
