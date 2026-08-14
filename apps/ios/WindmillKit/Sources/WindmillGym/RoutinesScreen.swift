import SwiftUI
import WindmillPlatform

// ROUTINES — HOME since the 13 Aug update: the first of the room's three tabs (Routines · The log ·
// Ask), the screen open() anchors to and finish-Done lands on. "Home is your plans, not a running
// clock" — the Today tab retired because it implied something was already happening, and this list
// of written-down days is what a lifter acts FROM. It is a list and three ways in: `New routine` at
// the foot, a routine's own page behind its name, and every movement it names a door onto that
// movement's record (§H).
//
// TODAY'S CARGO LIVES HERE NOW (the rehoming map): the boot-claim refusal rows and the signed-out
// claim offer in the top band, the one pending proposal card above the list, the settings door at
// the very foot — and the free-form door under the list as "Just start logging" (R4; "Log without
// a routine" retired). The last-session shortcut died: The log is one tab away and holds the same
// door. The Ask door died into the Ask tab.
//
// The order is the log's own — trained most recently first — so each row's own last-trained line
// states the sort. `Routine.byLastTrained` puts the device's unclaimed routines in the same order
// the server sends the rest.
//
// THE ROW OPENS THE ROUTINE AND NEVER STARTS IT. The start lives on the routine's own page (R2),
// as the one primary under the plan. What the row keeps is the pending marker: a proposal is about
// the routine and the tap onto it belongs beside its name.

struct RoutinesScreen: View {
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool
    // Which pending proposals the lifter has said "later" to. Held by the ROOM and not here, so the
    // answer survives a walk to the log and back — and dies with the room, which is the whole of
    // what "later" promises.
    let setAside: Set<String>
    let onOpen: (String) -> Void
    let onNew: () -> Void
    // The free-form door — "Just start logging" (R4), the second path for the day you turn up
    // without a plan. A user-tapped start like every other: nothing on this screen runs by itself.
    let onStartLogging: () -> Void
    let onMovement: (String) -> Void
    let onProposal: (String) -> Void
    let onLater: (String) -> Void
    // The proposal card's Ask chip — nil wherever an Ask door is not offered (a keyless
    // deployment), so the chip is absent rather than dead. The tab itself always stands and says
    // its own stance; this is the shortcut, and a shortcut onto a sentence is not worth drawing.
    let onAsk: (() -> Void)?
    let onSettings: () -> Void
    let onSignIn: () -> Void
    // THE INVITATION (§D12), and nil is the whole of its rule: the room hands this over only while
    // nothing is known to reach the log, so a lifter whose Claude already writes these proposals is
    // never sold the thing they are already using. It is an invitation and not a gate — no lock, no
    // chip, no price, and nothing on this screen is withheld while it goes unanswered.
    let onConnect: (() -> Void)?

    @Environment(\.gymSkin) private var skin

    // SIGNED OUT, HOME IS THE SAME SCREEN. The room is anonymous-first: routines live on the
    // device's own shelf, sessions open against the local log, and every door below is real before
    // there is an account. What signing in adds is reach — the account, the web mirror, agents that
    // read the log — so the door is a quiet claim offer under the top band, never a wall.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                // A loss said during a boot claim has no logger to carry it — no session is open,
                // so home is the screen the lifter is standing on. Same rows, same voice, same
                // dismiss as the logger's (wave 2 §B); with a session open the logger is mounted
                // instead of this screen, so the loss is never said twice.
                RefusalRows(refusals: store.refusals, catalog: store.catalog,
                            onDismiss: { store.clearRefusals() })
                waiting
                if !isSignedIn { claimOffer }
                if store.routines.isEmpty {
                    empty
                } else {
                    // Sorted by last trained rather than by when they were made, and the list says so
                    // by carrying each routine's own last-trained line — a caption under the list
                    // naming the sort order is the room explaining itself.
                    ForEach(store.routines) { routine in row(routine) }
                    newRoutine
                    justStartLogging
                }
                // AT THE FOOT, UNDER THE PROGRAM AND NEVER IN FRONT OF IT — including when there is
                // no program yet, which is the one moment an agent reading a written plan is worth
                // the most.
                if let onConnect {
                    ConnectInvite(open: onConnect)
                        .padding(.top, WindmillSpace.x2)
                }
                settingsDoor
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text("Routines")
                .font(WindmillFont.display(32))
                .foregroundStyle(skin.ink)
            // `4 routines · nothing running` (§B screen 4). "nothing running" is always true where
            // this line is drawn — a live session owns the whole screen — so the sub-line states
            // the two facts a lifter lands on: how much program there is, and that the clock is
            // theirs to start. Absent over an empty list, whose state says its own thing below.
            if !store.routines.isEmpty {
                Text("\(Readout.routineCount(store.routines.count)) · nothing running")
                    .font(GymType.numeral(13))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .padding(.bottom, WindmillSpace.x1)
    }

    // Screen 1 — "Empty — and it says what to do". The fresh-install home, and since the arrival
    // auto-start retired (R6) the first thing a new lifter sees: the empty state carries the
    // onboarding weight now, so it points at both doors — build the plan, or just start logging.
    private var empty: some View {
        VStack(spacing: WindmillSpace.x4) {
            Text("+")
                .font(WindmillFont.display(28))
                .foregroundStyle(skin.inkFaint)
                .frame(width: 62, height: 62)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    .foregroundStyle(skin.lineStrong))
            Text("No routines yet")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.ink)
            Text("A routine is one training day written down — the movements, in order, with your targets.")
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .multilineTextAlignment(.center)
            Button(action: onNew) {
                Text("Build a routine")
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            Button(action: onStartLogging) {
                Text("Just start logging")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.inkDim)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary - 10)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, WindmillSpace.x6)
    }

    // The populated home's primary (§B screen 4): the way a new day gets written, at the foot of
    // the list where the thumb is, with the free-form door as the quieter line under it.
    private var newRoutine: some View {
        Button(action: onNew) {
            Text("New routine")
                .font(WindmillFont.body(17, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
        .padding(.top, WindmillSpace.x2)
    }

    private var justStartLogging: some View {
        Button(action: onStartLogging) {
            Text("Just start logging")
                .font(WindmillFont.body(15, .semibold))
                .foregroundStyle(skin.accent)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
        }
    }

    // THE ONE THING ON THIS SCREEN THAT ASKS FOR ATTENTION, and the only notification this product
    // has: a proposal an agent wrote, waiting above the program until it is applied or dismissed.
    // There is no push, no badge and no unread count anywhere in gym — the card waits where the
    // lifter is already looking, which is why it does not need any of them.
    //
    // SIGNED OUT IT IS NEVER HERE, and not because this screen hides it: a proposal belongs to an
    // account, so the store's list is empty until there is one and there is nothing to draw.
    //
    // The newest one, and only while its routine is on screen to be named. A card that could not
    // say which program it is about would be asking the lifter to open a diff on faith — and the
    // list a routine went missing from is one whose read failed, which is a reason to say less.
    @ViewBuilder
    private var waiting: some View {
        if let head = store.proposals.first(where: { $0.isPending && !setAside.contains($0.id) }),
           let routine = store.routines.first(where: { $0.id == head.routineId }) {
            ProposalCard(head: head, routineName: routine.name,
                         onReview: { onProposal(head.id) },
                         onLater: { onLater(head.id) },
                         onAsk: onAsk)
        }
    }

    // The quiet claim offer (wave contract §C) — the one sentence signed-out home says about the
    // account, in the top band the rehoming map gave it. Tapping it opens You, where the sign-in
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

    // THE DOOR THAT SHOULD NOT BE HERE, and it says so in one place rather than two: §I reaches
    // gym's settings from You, where the shell composes a section every product registers. That
    // seam does not exist on this surface (`ProductModule` has no settings slot), and the shell is
    // not this room's territory — so the door sits at the very foot of home, under everything that
    // starts a workout, and moves to You the day the seam lands.
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

    // THE DOOR IS THE HEADER AND NOT THE WHOLE CARD, since the movement names below it are doors
    // onto their own records (§H): a button inside a button is not a second tap target on iOS, it is
    // one that swallows the other. The header is where §B screen 5 draws the row anyway — the name,
    // its meta and the chevron — and the entries under it are this surface's own preview of what the
    // day asks for.
    private func row(_ routine: Routine) -> some View {
        // Asked once and read twice — the marker and the card's own edge are one fact, and a card
        // lit at the border with no row to tap would be the loudest thing on this screen saying
        // nothing.
        let pending = store.pending(of: routine.id)
        return VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Button { onOpen(routine.id) } label: {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(routine.name)
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.ink)
                    // The word §M puts on a routine that has never been run, said where the list can
                    // say it too: it is the same absence, read the same way, and a lifter scanning
                    // for what to do tonight has earned knowing which of these is untried.
                    if routine.isUntested {
                        Text("untested")
                            .font(GymType.numeral(10))
                            .tracking(0.5)
                            .textCase(.uppercase)
                            .foregroundStyle(skin.inkFaint)
                    }
                    Spacer(minLength: 0)
                    Text(meta(routine))
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .frame(minHeight: GymTap.minimum)
            }
            if let newest = pending.first { waiting(newest, of: pending.count) }
            // Keyed on POSITION and never on the movement: a routine may name one twice — bench
            // heavy then bench back-off is the case the domain's `Routine` calls out by name —
            // and two rows sharing an id is undefined behaviour in a ForEach.
            ForEach(routine.entries.sorted { $0.position < $1.position }, id: \.position) { entry in
                HStack(spacing: WindmillSpace.x3) {
                    MovementDoor(exerciseId: entry.exerciseId,
                                 name: Readout.movement(entry.exerciseId, in: store.catalog),
                                 font: WindmillFont.body(14), ink: skin.inkDim, open: onMovement)
                    Spacer(minLength: WindmillSpace.x2)
                    Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                        weightKg: entry.targetWeightKg))
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(entry.isOpen ? skin.inkFaint : skin.targetInk)
                }
            }
            history(of: routine)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(pending.isEmpty ? skin.line : skin.accent, lineWidth: 1))
    }

    // `● 1 proposal` (§B screen 5), and on this surface it is the DOOR as well as the mark: the
    // row's own tap opens the routine, so a diff reached only through it would be two taps from a
    // list whose whole job is to say something is waiting.
    //
    // IT COUNTS WHAT IS WAITING AND OPENS THE NEWEST. The ledger keeps one pending proposal per
    // door, so two doors put two on one routine — a mark that said "1" over both would be wrong
    // about the one number it is here to give. The older ones are not lost behind the tap: applying
    // the newest sets them aside, dismissing it leaves the next one marked in its place.
    private func waiting(_ newest: ProposalHead, of count: Int) -> some View {
        Button { onProposal(newest.id) } label: {
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.accent)
                    .frame(width: 6, height: 6)
                Text(ProposalHead.waitingLine(count))
                    .font(WindmillFont.body(13, .bold))
                    .foregroundStyle(skin.accent)
                Text(count == 1 ? "from \(newest.source.agentName)"
                                : "newest from \(newest.source.agentName)")
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.accent)
            }
            .frame(minHeight: GymTap.minimum)
        }
    }

    // HISTORY (§B screen 6) — `2 Aug · applied 3 changes from Claude`, most recently DECIDED first
    // (the store orders it by the day each row prints), every row a door back onto the diff it
    // settled. The three most recent are drawn and the rest are COUNTED:
    // a section that grew without bound would push the movements it belongs to off the card, and a
    // number is the room's own way of saying there is more (the routine cards' `+ N more` says it
    // the same way).
    @ViewBuilder
    private func history(of routine: Routine) -> some View {
        let settled = store.history(of: routine.id)
        if !settled.isEmpty {
            Text("History")
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(skin.inkFaint)
                .padding(.top, WindmillSpace.x2)
            ForEach(settled.prefix(3)) { head in
                Button { onProposal(head.id) } label: {
                    HStack(spacing: WindmillSpace.x2) {
                        Text(head.historyLine(now: Int64(Date().timeIntervalSince1970 * 1000)))
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkDim)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(skin.inkFaint)
                    }
                    .frame(minHeight: GymTap.minimum)
                    .padding(.horizontal, WindmillSpace.x3)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
                    .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                        .strokeBorder(skin.line, lineWidth: 1))
                }
            }
            if settled.count > 3 {
                Text("+ \(settled.count - 3) older")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
        }
    }

    // `6 movements · trained 5 days ago`. A routine that has never been run says only its count
    // here: the `untested` word beside the name is the same fact, and a row that carried both would
    // be saying one thing twice in one line.
    private func meta(_ routine: Routine) -> String {
        let count = routine.entries.count
        let movements = count == 1 ? "1 movement" : "\(count) movements"
        guard let trained = routine.lastTrainedAtMs else { return movements }
        return "\(movements) · trained \(Readout.ago(trained, now: Int64(Date().timeIntervalSince1970 * 1000)))"
    }
}
