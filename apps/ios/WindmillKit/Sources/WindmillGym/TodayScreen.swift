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
// The two read-only doors sit at the foot, under everything that starts a workout, and only once the
// log holds a session that has finished: a door onto an empty screen is the same defect as a chevron
// that goes nowhere. Statistics is one of them until its replacement exists (W1c).

struct TodayScreen: View {
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool
    let onStart: (String?) -> Void
    let onStatistics: () -> Void
    let onOpenSession: (SessionSummary) -> Void
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    // SIGNED OUT, TODAY IS THE SAME SCREEN. The room is anonymous-first: sessions open against the
    // device's own log, the plan freezes off the local routine, and every Start below is real before
    // there is an account. What signing in adds is reach — the account, the web mirror, the coach —
    // so the door is a quiet claim offer under the work, never a wall in front of it.
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
                if !isSignedIn { claimOffer }
                lookingBack
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
            ForEach(routine.entries.sorted { $0.position < $1.position }.prefix(3), id: \.position) { entry in
                HStack {
                    Text(Readout.movement(entry.exerciseId, in: store.catalog))
                        .font(WindmillFont.body(15))
                        .foregroundStyle(skin.inkDim)
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

    // THE TWO RETROSPECTIVE DOORS, and they exist exactly when there is something behind them: a log
    // with no finished session has no statistics to draw and no last session to open, and a door
    // onto an empty screen is the same defect as a chevron that goes nowhere. Both are read-only —
    // nothing on either side of them can change the log.
    @ViewBuilder
    private var lookingBack: some View {
        if let last = store.recent.first(where: { !$0.session.isOpen }) {
            VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                Button(action: onStatistics) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Statistics")
                                .font(WindmillFont.body(17))
                                .foregroundStyle(skin.ink)
                            Text("movement lines, standing bests, weeks")
                                .font(GymType.numeral(12))
                                .foregroundStyle(skin.inkFaint)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(skin.inkFaint)
                    }
                    .frame(minHeight: GymTap.minimum + 8)
                }

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
            }
            .padding(.top, WindmillSpace.x2)
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
