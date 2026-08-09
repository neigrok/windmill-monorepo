import SwiftUI
import WindmillPlatform

// TODAY — the home, and the only surface in gym that ever asks for attention, because this product
// has no notifications. It answers one question: what am I doing right now.
//
// No tour, no sample program, no questions about goals or experience. This lifter already has a
// program; the app's job is to CATCH it, not to write it — which is why the empty state's one door
// is an empty session, and the routine is the thing you name on the way out.
//
// Looking BACK lives at the foot of this screen and nowhere else in the room: two doors, under
// everything that starts a workout, and only once the log holds a session that has finished. That
// is the whole of gym's navigation and it is deliberately not a tab bar — see GymRoom for why.

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
                if store.routines.isEmpty {
                    empty
                } else {
                    ForEach(Array(store.routines.enumerated()), id: \.element.id) { index, routine in
                        if index == 0 { card(routine) } else { row(routine) }
                    }
                    logWithoutARoutine
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

            ForEach(routine.entries.sorted { $0.position < $1.position }.prefix(3), id: \.exerciseId) { entry in
                HStack {
                    Text(Readout.movement(entry.exerciseId, in: store.catalog))
                        .font(WindmillFont.body(15))
                        .foregroundStyle(skin.inkDim)
                    Spacer(minLength: WindmillSpace.x3)
                    Text(target(entry))
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

    // Sorted by last trained and never by when they were made, because that is how a lifter picks
    // one — and it is the same fact the row prints, so the list never has to explain its own order.
    private func row(_ routine: Routine) -> some View {
        Button { onStart(routine.id) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(routine.name)
                        .font(WindmillFont.body(17))
                        .foregroundStyle(skin.ink)
                    Text(meta(routine))
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
                            Text(last.session.plan?.routine ?? "Ad-hoc")
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

    private func meta(_ routine: Routine) -> String {
        let count = routine.entries.count
        let movements = count == 1 ? "1 exercise" : "\(count) exercises"
        guard let trained = routine.lastTrainedAtMs else { return "\(movements) · never trained" }
        return "\(movements) · trained \(Readout.ago(trained, now: nowMs))"
    }

    private func target(_ entry: RoutineEntry) -> String {
        let count = "\(entry.targetSets) × \(Readout.repTarget(entry.targetReps))"
        guard let weight = entry.targetWeightKg, weight != 0 else { return count }
        return "\(count) · \(Readout.weight(weight))"
    }

    private func lastMeta(_ summary: SessionSummary) -> String {
        let day = Readout.day(summary.session.startedAtMs)
        guard let finished = summary.session.finishedAtMs else {
            return "\(day) · \(Readout.setCount(summary.setCount))"
        }
        let length = Readout.duration(finished - summary.session.startedAtMs)
        return "\(day) · \(Readout.setCount(summary.setCount)) · \(length)"
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
