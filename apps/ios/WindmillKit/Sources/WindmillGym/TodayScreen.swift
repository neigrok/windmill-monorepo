import SwiftUI
import WindmillPlatform

// TODAY — the home, the first of the room's three tabs, and the only surface in gym that ever asks
// for attention, because this product has no notifications. It answers one question: what am I doing
// right now.
//
// No tour, no sample program, no questions about goals or experience. This lifter already has a
// program; the app's job is to CATCH it, not to write it — which is why the empty state's one door
// is an empty session, and the routine is the thing you name on the way out.
//
// ONE routine is on this screen and it is the one trained most recently (§B screen 4). The whole
// list is a tab of its own now, so a lifter who wants a different day goes there rather than
// scrolling past it here — Today is what is happening, not a menu.
//
// The read-only door sits at the foot, under everything that starts a workout, and only once the log
// holds a session that has finished: a door onto an empty screen is the same defect as a chevron
// that goes nowhere. It used to have a Statistics twin beside it; there is no dashboard in this
// product, and what a lifter wanted from that board is one movement's record — reached by tapping
// the movement's NAME on the routine card above, which is where they are already looking.

struct TodayScreen: View {
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool
    // Which pending proposals the lifter has said "later" to. Held by the ROOM and not here, so the
    // answer survives a walk to the log and back — and dies with the room, which is the whole of
    // what "later" promises.
    let setAside: Set<String>
    // Whether this deployment mounts Ask at all. It is not a preference and not a plan: a Windmill
    // with no Anthropic key does not carry the route, and the room learns that from a 404 the first
    // time somebody asks. Until then the door is drawn — the alternative is hiding a feature from
    // every lifter on the chance that one deployment lacks it.
    let askOnThisDeployment: Bool
    let onStart: (String?) -> Void
    let onMovement: (String) -> Void
    let onOpenSession: (SessionSummary) -> Void
    let onProposal: (String) -> Void
    let onLater: (String) -> Void
    let onAsk: () -> Void
    let onSettings: () -> Void
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    // SIGNED OUT, TODAY IS THE SAME SCREEN. The room is anonymous-first: sessions open against the
    // device's own log, the plan freezes off the local routine, and every Start below is real before
    // there is an account. What signing in adds is reach — the account, the web mirror, agents that
    // read the log — so the door is a quiet claim offer under the work, never a wall in front of it.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                head
                // A loss said during a boot claim has no logger to carry it — no session is open,
                // so Today is the screen the lifter is standing on. Same rows, same voice, same
                // dismiss as the logger's (wave 2 §B); with a session open the logger is mounted
                // instead of this screen, so the loss is never said twice.
                RefusalRows(refusals: store.refusals, catalog: store.catalog,
                            onDismiss: { store.clearRefusals() })
                if let due = store.routines.first {
                    card(due)
                    logWithoutARoutine
                } else {
                    empty
                }
                waiting
                if !isSignedIn { claimOffer }
                lookingBack
                askDoor
                settingsDoor
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text("Today")
                .font(WindmillFont.display(32))
                .foregroundStyle(skin.ink)
            Text(store.recent.isEmpty ? "nothing logged yet" : "\(Readout.day(nowMs)) · nothing running")
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
        }
    }

    // Screen 1. One way in, and the sentence that says what the empty session is FOR — a lifter who
    // is told a routine gets written at the end does not go looking for an editor first.
    //
    // THE SECOND BUTTON THE BOARD DRAWS IS NOT HERE. Screen 1's `Type out a routine first` opens a
    // routine editor, and this surface has none — RoutinesScreen says why, and it is the same split:
    // the phone owns the open session, the web owns the desk work. A button onto a screen that does
    // not exist would be the defect this room refuses everywhere else, so it is absent rather than
    // dead, and the sentence over the button already says how a routine gets made here.
    //
    // The dashed box under it — "no tour, no sample program, no questions about goals" — came off on
    // 2026-08-12 with the twenty others: that is the ARGUMENT for this screen, and it lives beside
    // the screen, in these comments and on the board, rather than on the glass.
    private var empty: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            Text("Start empty and pick movements as you go. What you do today becomes your routine — you name it at the end.")
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
            start(label: "Start a session", routineId: nil)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // The routine trained most recently, opened out: what it holds, and one button that starts it.
    // The plan snapshot is frozen by the SERVER off this routine's own row, so what is drawn here is
    // a preview of the workout and never the thing the session is planned from.
    private func card(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack {
                Text(routine.name)
                    .font(WindmillFont.display(22))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                Text(routine.lastTrainedAtMs.map { Readout.ago($0, now: nowMs) } ?? "never trained")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }

            // Keyed on POSITION, because a routine may name a movement twice — bench heavy then
            // bench back-off — and two rows sharing an id is undefined behaviour in a ForEach.
            //
            // THE NAME IS A DOOR (§H): tapping it lands on that movement's record, which is how a
            // lifter checks "+2.5 on squat" before they start the day that carries it. The chevron
            // is on the name and not at the end of the row, because the row's other half is the
            // plan's target and the door is not onto that.
            ForEach(routine.entries.sorted { $0.position < $1.position }.prefix(3), id: \.position) { entry in
                HStack {
                    MovementDoor(exerciseId: entry.exerciseId,
                                 name: Readout.movement(entry.exerciseId, in: store.catalog),
                                 font: WindmillFont.body(15), ink: skin.inkDim, open: onMovement)
                    Spacer(minLength: WindmillSpace.x3)
                    Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                        weightKg: entry.targetWeightKg))
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.targetInk)
                }
            }
            if routine.entries.count > 3 {
                Text("+ \(routine.entries.count - 3) more")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }

            start(label: "Start \(routine.name)", routineId: routine.id)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // THE ONE THING ON THIS SCREEN THAT ASKS FOR ATTENTION, and the only notification this product
    // has: a proposal an agent wrote, waiting under the day's routine until it is applied or
    // dismissed. There is no push, no badge and no unread count anywhere in gym — the card waits
    // where the lifter is already looking, which is why it does not need any of them.
    //
    // SIGNED OUT IT IS NEVER HERE, and not because this screen hides it: a proposal belongs to an
    // account, so the store's list is empty until there is one and there is nothing to draw.
    //
    // The newest one, and only while its routine is on screen to be named. A card that could not
    // say which program it is about would be asking the lifter to open a diff on faith — and the
    // list a routine went missing from is one whose read failed, which is a reason to say less.
    //
    // NO GATE AND NO PITCH, AND THE REASON CHANGED THIS WAVE. §D12 puts its sell on the proposal
    // card as well as on Routines, and there is nothing left to sell: the connected log gates
    // nothing, `hasWindmillOne` is read nowhere in this product, and the invitation now lives on
    // Routines and in settings. On THIS card it would be worse than redundant — a proposal is a
    // connection that already exists, so inviting a lifter to make one, on the object it made, is
    // advertising at somebody for something they have.
    @ViewBuilder
    private var waiting: some View {
        if let head = store.proposals.first(where: { $0.isPending && !setAside.contains($0.id) }),
           let routine = store.routines.first(where: { $0.id == head.routineId }) {
            ProposalCard(head: head, routineName: routine.name,
                         onReview: { onProposal(head.id) },
                         onLater: { onLater(head.id) },
                         onAsk: Ask.doorIsOpen(signedIn: isSignedIn,
                                               sessionIsOpen: store.session != nil,
                                               onThisDeployment: askOnThisDeployment) ? onAsk : nil)
        }
    }

    private var logWithoutARoutine: some View {
        Button { onStart(nil) } label: {
            Text("Log without a routine")
                .font(WindmillFont.body(16, .semibold))
                .foregroundStyle(skin.accent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary - 8)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(skin.lineStrong, lineWidth: 1))
        }
    }

    // The quiet claim offer (wave contract §C) — the one sentence signed-out Today says about the
    // account, under the doors and never in front of them. Tapping it opens You, where the sign-in
    // door is; the claim itself runs on connect, the moment there is an account to take it.
    private var claimOffer: some View {
        Button(action: onSignIn) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Your log is saved on this device.")
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.ink)
                Text("Sign in to claim it to your account — and open it on the web.")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
                    // A Button's label centres its own wrapped text, and every other paragraph in
                    // this room is ragged-right. Said here because the card is a button.
                    .multilineTextAlignment(.leading)
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.raised))
        }
    }

    // THE RETROSPECTIVE DOOR, and it exists exactly when there is something behind it: a log with no
    // finished session has no last session to open, and a door onto an empty screen is the same
    // defect as a chevron that goes nowhere. It opens the session as it was LIVED, where §G18 can
    // correct a set of it — the one door on Today that reaches back into the log at all.
    @ViewBuilder
    private var lookingBack: some View {
        if let last = store.recent.first(where: { !$0.session.isOpen }) {
            Button { onOpenSession(last) } label: {
                VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                    Text("Last session")
                        .font(GymType.numeral(11))
                        .foregroundStyle(skin.inkFaint)
                    HStack {
                        Text(Readout.routine(of: last.session))
                            .font(WindmillFont.body(16))
                            .foregroundStyle(skin.ink)
                        Spacer(minLength: WindmillSpace.x3)
                        Text(lastMeta(last))
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkFaint)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(skin.inkFaint)
                    }
                }
                .frame(minHeight: GymTap.minimum)
            }
            .padding(.top, WindmillSpace.x2)
        }
    }

    // ASK (§L), IN TODAY'S BOTTOM BAND — under everything that starts a workout, beside the two other
    // doors that lead away from the day. It is never a fourth tab and it is NEVER OFFERED
    // MID-SESSION: `Ask.doorIsOpen` states both halves of that once, so this screen and the proposal
    // card below cannot come to different answers about when a chat may be reached.
    //
    // The subtitle is the promise, not a tagline: what is behind this row reads the log and can
    // propose. Nothing here mentions a plan, a price or an upgrade, because Ask is open to every
    // account with a plainly-worded daily limit and there is nothing to sell against it.
    @ViewBuilder
    private var askDoor: some View {
        if Ask.doorIsOpen(signedIn: isSignedIn, sessionIsOpen: store.session != nil,
                          onThisDeployment: askOnThisDeployment) {
            Button(action: onAsk) {
                HStack(spacing: WindmillSpace.x3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Ask.title)
                            .font(WindmillFont.body(16, .semibold))
                            .foregroundStyle(skin.ink)
                        Text(Ask.subtitle)
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkFaint)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .padding(.horizontal, WindmillSpace.x4)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 12)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
        }
    }

    // THE DOOR THAT SHOULD NOT BE HERE, and it says so in one place rather than two: §I reaches gym's
    // settings from You, where the shell composes a section every product registers. That seam does
    // not exist on this surface (`ProductModule` has no settings slot), and the shell is not this
    // room's territory — so the door sits at the very foot of Today, under everything that starts a
    // workout, and moves to You the day the seam lands.
    private var settingsDoor: some View {
        Button(action: onSettings) {
            HStack {
                Text("Gym settings")
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .frame(minHeight: GymTap.minimum)
        }
    }

    private func start(label: String, routineId: String?) -> some View {
        Button { onStart(routineId) } label: {
            Text(label)
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
    }

    // `16 sets` — EVERY set, every kind — because that is what §B screen 4 draws on this row, and it
    // is the design's own choice rather than an oversight: §G17 spells the same session `11 working`
    // in the log's head, where the number sits beside a top set that is filtered to working and
    // would otherwise contradict it. Here nothing is filtered and nothing is compared, so the row
    // says how much work happened. Two labelled counts are not two answers.
    private func lastMeta(_ summary: SessionSummary) -> String {
        var said = [Readout.day(summary.session.startedAtMs), Readout.setCount(summary.setCount)]
        if let finished = summary.session.finishedAtMs {
            said.append(Readout.duration(finished - summary.session.startedAtMs))
        }
        return said.joined(separator: " · ")
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
