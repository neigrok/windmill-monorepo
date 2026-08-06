import SwiftUI
import WindmillPlatform

// THE ROOM — gym's whole surface, and the five places a lifter can stand in it: Today, the session
// they are in the middle of, the screen a session ends on, and the two retrospective screens Today
// opens (Statistics, and one past session). It draws no capsule, no theme control and nothing about
// billing: the shell owns all three, and a room that drew one of them would be a second copy of a
// decision the shell already made.
//
// NAVIGATION IS A DOOR OFF TODAY AND NOT A TAB BAR, deliberately. A tab bar is permanent furniture:
// it would draw a second destination across the logger, where this product's whole rule is that the
// workout owns the screen — and it is the shape that invites a third and a fourth tab, which is the
// "fourth Insights tab" gym's canon refused. A door only exists where it leads somewhere, so Today
// offers Statistics and the last session exactly when the log holds a finished session, and the way
// back is the leading end of the room's own bar, opposite the shell's seat. The shell's back gesture
// is the left screen edge and takes you HOME, so a room screen may not claim that edge for itself.
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
    @State private var away: Away?
    @State private var keptRoutine = false
    @State private var starting = false
    @State private var note: String?

    public init(account: Account) {
        self.account = account
    }

    // Where Today can send you, and both are read-only: the long window over every finished session,
    // and one past session with its sets. The session travels as the ROW Today already holds rather
    // than as an id, because that row carries facts no other read gives back — the set count, and
    // whether the four-hour rule closed it rather than a tap.
    private enum Away: Equatable {
        case statistics
        case session(SessionSummary)
    }

    private var skin: GymSkin { .instrument }

    public var body: some View {
        VStack(spacing: 0) {
            stage
            bar
        }
        .background(skin.canvas.ignoresSafeArea())
        .environment(\.gymSkin, skin)
        // Gym ships one skin and it is dark. Stated inward so the shell's seat and every system
        // control inside the room resolve against it, and outward so the capsule laid over the room
        // is dressed in the same night.
        .environment(\.colorScheme, .dark)
        .roomChrome(.dark)
        .tint(skin.steel)
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

    // A LIVE SESSION OUTRANKS A RETROSPECTIVE SCREEN. Statistics and a past session are only
    // reachable from Today, which is only drawn at rest — but a workout that opens while one of them
    // is up (a start on this phone, a session joined from another device) puts the lifter back where
    // the sets are, because that is the one screen in this product that is time-critical.
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
        } else if let away {
            switch away {
            case .statistics:
                StatisticsScreen(store: store)
            case .session(let summary):
                SessionScreen(summary: summary, store: store,
                              coach: doors(to: summary.session.id))
            }
        } else {
            TodayScreen(store: store, isSignedIn: account.isSignedIn,
                        onStart: { routineId in Task { await open(routineId) } },
                        onStatistics: { look(at: .statistics) },
                        onOpenSession: { look(at: .session($0)) },
                        onSignIn: { shell.openYou() })
        }
    }

    // Every door in and out of a retrospective screen goes through here for one reason: the bar's
    // note is what the room has to say about the door that did not open ON THE SCREEN YOU ARE ON,
    // and a refusal from Today carried under a chart is a sentence about something that is no longer
    // in front of the lifter.
    private func look(at destination: Away?) {
        note = nil
        away = destination
    }

    // The shell's seat, at the trailing end of the room's own bar and past its own hairline — the
    // same right edge it sits at in every other app, on every screen gym has. At the leading end,
    // the room's own way back out of a screen Today opened. Between them, and in one place on every
    // screen, whatever the room has to say about a door that did not open: mono, quiet, and never a
    // toast, a spinner or an alert.
    private var bar: some View {
        HStack(spacing: WindmillSpace.x3) {
            if away != nil {
                Button { look(at: nil) } label: {
                    HStack(spacing: WindmillSpace.x1) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Today")
                            .font(WindmillFont.body(15, .semibold))
                    }
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
                }
            }
            if let note {
                Text(note)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkDim)
                    .lineLimit(2)
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
        guard account.isSignedIn else {
            note = "sessions are kept on your account"
            return
        }
        if case .failure(let why) = await store.start(routineId: routineId) {
            note = why.line("a session starts there")
            return
        }
        // Whatever retrospective screen was open is over: the workout is what this phone is for, and
        // Done on the finish screen must land on Today rather than back on a chart.
        away = nil
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
        guard let live = store.session else { return }
        let performed = store.sets
        note = nil
        switch await store.finish() {
        case .closed(let session):
            keptRoutine = false
            finished = FinishedSession(session: session,
                                       sets: performed,
                                       review: await store.review(of: live.id),
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
