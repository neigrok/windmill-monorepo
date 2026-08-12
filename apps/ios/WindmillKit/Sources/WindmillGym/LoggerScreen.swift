import SwiftUI
import WindmillPlatform

// THE SET LOGGER — one value at a time, at arm's length, in a room where you cannot hear the tone and
// your hands are chalked. Only the today list is elastic: the big weight, the ladder, the reps and
// the 64pt primary action never move as sets accumulate, so the thumb learns one geometry and keeps
// it for the whole session.
//
// EVERY WEIGHT AND REP TAP GOES THROUGH `Ladder`. Step sizes are not re-derived here, on the web, or
// anywhere else — one module per language, both answering packages/api-contract/gym-ladder.json, and
// the labels re-render as the load climbs because the band under it changed.
//
// The screen never congratulates and never warns. An overrun rest counts up in the accent, "set 4 of 3"
// is drawn in the same ink as "set 3 of 5", and the only alarm ink in the product belongs to a write
// that actually failed.

struct LoggerScreen: View {
    @ObservedObject var store: TrainingStore
    // Only the opening picker's card reads these — §J22's one account verb, and the sentence over it
    // that is different signed in. Nothing else on this screen changes with the account: logging is
    // the same act with or without one.
    let isSignedIn: Bool
    // nil while something already reaches this log: the card is an invitation, and the room
    // withdraws it the moment it would be selling a connection the lifter has already made.
    let onBuildRoutine: (() -> Void)?
    // The room bar's leading slot, lent to this screen. Both writes the logger can make happen behind
    // a sheet that closes either way, and a write that did not land is the one thing a room may not
    // draw as though it had.
    let say: (String?) -> Void
    let onFinish: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var weightKg = Prefill.emptyBarKg
    @State private var reps = Prefill.emptyBarReps
    @State private var warmup = false
    @State private var restStartedAtMs: Int64?
    @State private var sheet: Sheet?
    @State private var goingTo: String?
    @State private var pendingDeviation: Deviation?
    @State private var asked: Set<String> = []

    private enum Sheet: Identifiable {
        case weight
        case reps
        case jump
        case picker
        case deviation(Deviation, movement: String)

        var id: String {
            switch self {
            case .weight: return "weight"
            case .reps: return "reps"
            case .jump: return "jump"
            case .picker: return "picker"
            case .deviation(let deviation, _): return "deviation-\(deviation.exerciseId)"
            }
        }

        // The pad is sized to its own keys rather than to a detent: a keypad the lifter has to drag
        // taller before the digits are reachable is a keypad that has already cost them a set.
        var detents: Set<PresentationDetent> {
            switch self {
            case .weight, .reps: return [.height(520)]
            // The jump sheet is the assembly surface now (§A screen 2), and a half-height one would
            // give the list a few rows and the two gestures nowhere to happen.
            case .picker, .jump: return [.large]
            case .deviation: return [.medium, .large]
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            header
            if let line = LiveLines.onThisDeviceLine(store.strandedCount) { unsynced(line) }
            RefusalRows(refusals: store.refusals, catalog: store.catalog,
                        onDismiss: { store.clearRefusals() })

            if store.exerciseId == nil {
                assembling
            } else {
                movementHead
                prefillCard
                todayList
                Spacer(minLength: 0)
                weightBlock
                repsRow
                if let clock = restClock { rest(clock) }
                undoRow
                logButton
            }
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.top, WindmillSpace.x2)
        .padding(.bottom, WindmillSpace.x3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // The dial follows the prefill, and the prefill only moves when the movement does or when a
        // set lands on it — so a number the lifter dialled and did not log is never taken from under
        // them mid-exercise.
        .onChange(of: store.prefill) { _, dialled in
            weightKg = dialled.weightKg
            reps = dialled.reps
        }
        .task {
            weightKg = store.prefill.weightKg
            reps = store.prefill.reps
            // Walking back into a workout that never stopped is a lifter who is resting RIGHT NOW,
            // and the device knows exactly since when — the last set's own instant. The timer is
            // computed from that rather than restored from a counter, so it needs nothing persisted.
            restStartedAtMs = store.todaySets.last?.completedAtMs
        }
        // The chime is scheduled against the instant the set landed rather than watched for while
        // rendering: a phone in a pocket draws nothing, and a confirmation the screen cannot give
        // must not depend on the screen being awake. It is keyed on the whole clock — the instant AND
        // the target — so turning the dial off mid-rest replaces this task instead of leaving a sleep
        // to land on a timer nobody is running any more.
        .task(id: restClock) {
            guard let clock = restClock else { return }
            let started = clock.startedAtMs
            let target = clock.targetSeconds
            let waited = (Int64(Date().timeIntervalSince1970 * 1000) - started) / 1000
            guard waited < Int64(target) else { return }
            try? await Task.sleep(for: .seconds(Int64(target) - waited))
            guard !Task.isCancelled else { return }
            // WHAT A LOCKED SCREEN GETS IS SILENCE, and it is said rather than worked around. iOS
            // suspends this app, so the sleep above lands whenever the app is next awake; a chime
            // minutes after the rest ended confirms nothing and would teach the wrong thing about
            // when to stand up. The clock is still right the moment it is looked at — it is computed
            // from the set's own instant — and this product has no notification to promise instead.
            let elapsed = (Int64(Date().timeIntervalSince1970 * 1000) - started) / 1000
            guard elapsed <= Int64(target) + Rest.lateChimeSeconds else { return }
            GymConfirm.restLanded(under: store.preferences)
        }
        .sheet(item: $sheet, onDismiss: settleTheMove) { sheet in
            content(of: sheet)
                .presentationBackground(skin.surface)
                .presentationDetents(sheet.detents)
        }
    }

    // MARK: - the session

    private var header: some View {
        TimelineView(.periodic(from: .now, by: 1)) { beat in
            HStack(spacing: WindmillSpace.x3) {
                Circle().fill(skin.accent).frame(width: 8, height: 8)
                Text(store.session.map(Readout.routine) ?? Readout.noRoutine)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.ink)
                    .lineLimit(1)
                Text(Readout.clock(stamp(beat.date) - (store.session?.startedAtMs ?? 0)))
                    .font(GymType.numeral(14))
                    .foregroundStyle(skin.inkDim)
                Spacer(minLength: 0)
                Button("Finish", action: onFinish)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(minWidth: 70, minHeight: GymTap.minimum)
            }
        }
    }

    private func unsynced(_ line: String) -> some View {
        Text(line)
            .font(GymType.numeral(12))
            .foregroundStyle(skin.unsyncedInk)
            .lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Nothing in hand yet, which on the very first arrival is the whole of gym's onboarding: §J22,
    // the picker already up over a session nobody pressed start on. It is the same screen every
    // later time a session holds nothing, and it needs no branch for that — "what are you starting
    // with" is true of a first launch and of a list just swiped empty.
    //
    // There is no "Choose a movement" button in front of it any more. A button whose only job is to
    // open the list it is standing on is a tap this room can simply not charge for.
    private var assembling: some View {
        OpeningPicker(catalog: store.catalog, taken: store.order, lastSets: store.lastSets,
                      isSignedIn: isSignedIn,
                      onPick: { move(to: $0) },
                      onCreate: { mint($0) },
                      onBuildRoutine: onBuildRoutine)
            // The meta is a PICKER-OPEN read, here and on the sheet: the filter above runs over the
            // catalog this client already holds, so typing asks the log for nothing.
            .task { await store.loadLastSets() }
    }

    // MARK: - the movement in hand

    private var movementHead: some View {
        let counter = LiveLines.counter(workingSetsToday: workingToday, planEntry: store.planEntry)
        return HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Readout.movement(store.exerciseId ?? "", in: store.catalog))
                    .font(WindmillFont.display(28))
                    .foregroundStyle(skin.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                HStack(spacing: 0) {
                    Text(counter.count)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkDim)
                    Text(counter.tail)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.targetInk)
                }
            }
            Spacer(minLength: 0)
            Button { sheet = .jump } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(skin.inkDim)
                    .frame(width: GymTap.minimum, height: GymTap.minimum)
            }
            .accessibilityLabel("This session")
        }
    }

    private var prefillCard: some View {
        let card = LiveLines.prefillCard(lastTime: store.lastTime, planEntry: store.planEntry,
                                         routine: store.session?.plan?.routine,
                                         readFailed: store.lastTimeFailed,
                                         now: Int64(Date().timeIntervalSince1970 * 1000))
        return Button { sheet = .weight } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(card.title)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
                Text(card.body)
                    .font(GymType.numeral(14))
                    .foregroundStyle(skin.ink)
                    // A Button's label centres its own wrapped text, and a card of four sets read
                    // down a ragged left edge is the one place that would show.
                    .multilineTextAlignment(.leading)
            }
            .padding(WindmillSpace.x3)
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        }
    }

    private var todayList: some View {
        let rows = LiveLines.rows(store.todaySets, stalled: store.stalled)
        return ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if rows.isEmpty {
                    Text("Nothing logged for this movement yet.")
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                }
                ForEach(rows) { row in
                    HStack(spacing: WindmillSpace.x3) {
                        Text(row.index)
                            .font(GymType.numeral(12))
                            .foregroundStyle(row.isWarmup ? skin.warmupInk : skin.setDone)
                            .frame(width: 16, alignment: .leading)
                        Text(row.value)
                            .font(GymType.numeral(15))
                            .foregroundStyle(row.isWarmup ? skin.warmupInk : skin.ink)
                        Text(row.note)
                            .font(GymType.numeral(11))
                            .foregroundStyle(row.isOnThisDevice ? skin.unsyncedInk : skin.inkFaint)
                        Spacer(minLength: 0)
                        Text(row.time)
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkFaint)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        // ONLY THIS LIST IS ELASTIC, and only up to here. Past the cap it scrolls inside itself, so
        // the weight, the ladder, the reps and the 64pt action do not move as sets accumulate — the
        // thumb learns one geometry on the first set and keeps it for the whole session.
        //
        // The priority is what makes the cap mean anything: a scroll view and the spacer below it
        // are equally elastic, so a stack with both splits the slack between them and the record of
        // the session — the rows — is the half that gets squeezed. This asks first, the spacer takes
        // what is left.
        .frame(maxHeight: 190)
        .layoutPriority(1)
    }

    // MARK: - the dial

    private var weightBlock: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Button { sheet = .weight } label: {
                HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
                    Text(Readout.weight(weightKg))
                        .font(GymType.weight)
                        .foregroundStyle(skin.weightInk)
                        .lineLimit(1)
                        // A −102.5 is the widest thing this readout ever holds. It shrinks rather
                        // than truncating: half a weight is worse than a small one.
                        .minimumScaleFactor(0.55)
                    Text("kg")
                        .font(GymType.numeral(15))
                        .foregroundStyle(skin.inkFaint)
                    Spacer(minLength: 0)
                }
            }

            // §K's line under the numeral: what would go on the bar, built from the plates this gym
            // says it owns — or, when they cannot make the number, the loads that can be made
            // instead. The buttons never hide a weight; this tells the truth about one. The keypad is
            // named beside it, because the numeral is a button and nothing else on screen says so.
            Text(plateLine)
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, alignment: .center)

            HStack(spacing: WindmillSpace.x2) {
                ForEach(Array(Ladder.labels(for: weightKg).enumerated()), id: \.offset) { index, label in
                    Button { weightKg = Ladder.bump(weight: weightKg, direction: index < 2 ? -1 : 1,
                                                    big: index == 0 || index == 3) } label: {
                        Text(label)
                            .font(GymType.numeral(17, .semibold))
                            .foregroundStyle(skin.ink)
                            .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
                    }
                }
            }

            // Read off the ladder rather than typed under it, and read off BOTH of the rows the four
            // buttons above are using — on a band boundary they are two, and a caption naming one of
            // them would contradict the button it sits under (Ladder.caption).
            Text(Ladder.caption(for: weightKg))
                .font(GymType.numeral(10.5))
                .textCase(.uppercase)
                .kerning(0.5)
                .foregroundStyle(skin.inkFaint)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private var plateLine: String {
        let keypad = "tap the number to type it"
        guard let plates = Plates.readout(totalKg: weightKg, under: store.preferences) else { return keypad }
        return "\(plates) · \(keypad)"
    }

    private var repsRow: some View {
        HStack(spacing: WindmillSpace.x3) {
            Button { reps = Ladder.bumpReps(reps, direction: -1) } label: {
                Text("−")
                    .font(WindmillFont.display(24, .semibold))
                    .foregroundStyle(skin.ink)
                    .frame(width: GymTap.minimum + 12, height: GymTap.minimum + 6)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
            }
            .accessibilityLabel("One rep fewer")

            Button { sheet = .reps } label: {
                HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
                    Text(String(reps))
                        .font(GymType.reps)
                        .foregroundStyle(skin.ink)
                    Text("reps")
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkFaint)
                }
                .frame(maxWidth: .infinity)
            }

            Button { reps = Ladder.bumpReps(reps, direction: 1) } label: {
                Text("+")
                    .font(WindmillFont.display(24, .semibold))
                    .foregroundStyle(skin.ink)
                    .frame(width: GymTap.minimum + 12, height: GymTap.minimum + 6)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
            }
            .accessibilityLabel("One rep more")

            warmupToggle
        }
    }

    // THE ONE PLACE A SET'S KIND IS DECIDED. It arms the next Log set and disarms itself the moment
    // that set lands, because a warmup is a single set and not a mode you can be left in — a toggle
    // that stayed on would file the working sets after it as ramp-ups, which is the same loss the
    // other way round.
    //
    // A warmup counts toward NOTHING: it does not advance the plan counter, it is not carried forward
    // as the sticky weight, no record rule reads it, and "Keep this as a routine" leaves it out. That
    // is why this has to exist — without it a 40 kg ramp-up is filed as working and becomes the mark
    // to beat, and the finish screen mints a gold personal record for a warmup.
    //
    // It is the chip backfill already draws (`gym-line-kind`), and it sits IN the reps row rather
    // than on a line of its own: the row's height and the 64pt action below it are what the thumb
    // learns on the first set, and neither may move as the session goes on.
    private var warmupToggle: some View {
        Button { warmup.toggle() } label: {
            Text("warmup")
                .font(GymType.numeral(12))
                .foregroundStyle(warmup ? skin.warmupInk : skin.inkFaint)
                .frame(width: 74, height: GymTap.minimum + 6)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .fill(warmup ? skin.raised : .clear))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(warmup ? skin.lineStrong : skin.line, lineWidth: 1))
        }
        .accessibilityLabel("Log the next set as a warmup")
        .accessibilityAddTraits(warmup ? [.isSelected] : [])
    }

    // No rest line until a set lands: the timer times the gap between two sets, and one drawn before
    // the first would be counting from the moment the screen opened. No rest line at all until
    // somebody asked for one either — the dial starts off (§I), and a clock nobody set is a clock
    // this screen does not draw.
    private var restClock: Rest.Clock? {
        guard let started = restStartedAtMs,
              let target = Rest.target(planEntry: store.planEntry, preferences: store.preferences)
        else { return nil }
        return Rest.Clock(startedAtMs: started, targetSeconds: target)
    }

    private func rest(_ clock: Rest.Clock) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { beat in
            let line = Rest.Line(targetSeconds: clock.targetSeconds, startedAtMs: clock.startedAtMs,
                                 now: stamp(beat.date))
            HStack(spacing: WindmillSpace.x3) {
                Text(line.label)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                Text(line.time)
                    .font(GymType.numeral(15))
                    .foregroundStyle(line.overrun ? skin.accent : skin.ink)
                Spacer(minLength: 0)
                Button("reset") { restStartedAtMs = nil }
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .frame(minHeight: GymTap.minimum)
            }
        }
    }

    // The confirmation is visual and it is this: the row above, and the sentence here saying what
    // was taken. Undo is offered exactly while the set is still this device's alone, so taking it
    // back costs nobody anything. Once the log holds the row it is §G18's sheet that moves it —
    // there, with a confirmation and its own way back — and a button that outlived the window here
    // would be a second door onto that with neither.
    private var undoRow: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack {
                if let set = store.undoable {
                    Text("Logged \(Readout.effort(weightKg: set.weightKg, reps: set.reps))")
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkDim)
                    Spacer(minLength: 0)
                    Button("Undo") { store.undoLast() }
                        .font(WindmillFont.body(14, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(minWidth: 60, minHeight: GymTap.minimum - 8)
                }
            }
            .frame(height: 26)
        }
    }

    private var logButton: some View {
        Button {
            let landed = Int64(Date().timeIntervalSince1970 * 1000)
            let kind: SetKind = warmup ? .warmup : .working
            GymConfirm.setLogged(under: store.preferences)
            restStartedAtMs = landed
            // Disarmed on the tap and not on the reply: the set is the lifter's the instant they
            // press, and the toggle is about the set that just went, never about the network.
            warmup = false
            Task { await store.logSet(weightKg: weightKg, reps: reps, kind: kind) }
        } label: {
            Text("Log set  ·  \(Readout.effort(weightKg: weightKg, reps: reps))")
                .font(WindmillFont.body(19, .bold))
                .foregroundStyle(store.isFinishing ? skin.inkFaint : skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .fill(store.isFinishing ? skin.raised : skin.accent))
        }
        // Finish is a round trip and the store refuses a set once it is in flight. The button has to
        // say so BEFORE the tap, or the surface looks live and answers with a refusal nobody earned.
        .disabled(store.isFinishing)
    }

    // MARK: - the sheets

    @ViewBuilder
    private func content(of sheet: Sheet) -> some View {
        switch sheet {
        case .weight:
            KeypadSheet(mode: .weight, current: weightKg,
                        onCommit: { weightKg = $0; self.sheet = nil },
                        onCancel: { self.sheet = nil })
        case .reps:
            KeypadSheet(mode: .reps, current: Double(reps),
                        onCommit: { reps = Int($0); self.sheet = nil },
                        onCancel: { self.sheet = nil })
        case .jump:
            JumpSheet(rows: LiveLines.jumpRows(order: store.order, sets: store.sets,
                                               plan: store.session?.plan, catalog: store.catalog,
                                               current: store.exerciseId, stalled: store.stalled),
                      assembling: store.session?.routineId == nil,
                      onJump: { move(to: $0) },
                      onMove: { store.reorder(from: $0, to: $1) },
                      onDrop: { movement in Task { await store.drop(movement) } },
                      onAdd: { self.sheet = .picker },
                      onClose: { self.sheet = nil })
        case .picker:
            MovementPicker(catalog: store.catalog, taken: store.order, lastSets: store.lastSets,
                           onPick: { move(to: $0) },
                           onCreate: { mint($0) },
                           onClose: { self.sheet = nil })
                .task { await store.loadLastSets() }
        case .deviation(let deviation, let movement):
            DeviationSheet(deviation: deviation, movement: movement,
                           onSave: {
                               self.sheet = nil
                               say(nil)
                               Task {
                                   // The write that moves next week's target. Said when it does not
                                   // land, or the lifter believes their program changed.
                                   guard let why = await store.save(deviation.liftedKg,
                                                                    toRoutine: deviation.routineId,
                                                                    for: deviation.exerciseId) else { return }
                                   say(why.line("\(deviation.routine) wasn’t changed"))
                               }
                           },
                           onToday: { self.sheet = nil })
        }
    }

    // Minting a movement the catalog has never heard of, from either picker. A picker that closed on
    // a movement that was never minted is a lifter left holding nothing, with nothing said about it.
    private func mint(_ name: String) {
        sheet = nil
        say(nil)
        Task {
            switch await store.create(name) {
            case .success(let made): await store.choose(made.id)
            case .failure(let why): say(why.line("“\(name)” wasn’t created"))
            }
        }
    }

    // Leaving a movement is the one boundary the change offer is raised at, and the sheet that
    // raised it cannot be the one still on screen — so the move is remembered, the sheet closes, and
    // whatever is owed is presented once it has.
    //
    // The opening picker is not a sheet, so there is no dismissal to hang the move on and it settles
    // here. Same move, same offer, one place either road ends.
    private func move(to movement: String) {
        if let leaving = store.exerciseId, leaving != movement,
           let deviation = Deviation(leaving: leaving, session: store.session,
                                     sets: store.sets, asked: asked) {
            asked.insert(leaving)
            pendingDeviation = deviation
        }
        goingTo = movement
        guard sheet == nil else {
            sheet = nil
            return
        }
        settleTheMove()
    }

    private func settleTheMove() {
        if let movement = goingTo {
            goingTo = nil
            restStartedAtMs = nil
            Task { await store.choose(movement) }
        }
        guard let deviation = pendingDeviation else { return }
        pendingDeviation = nil
        sheet = .deviation(deviation, movement: Readout.movement(deviation.exerciseId, in: store.catalog))
    }

    private var workingToday: Int {
        LiveLines.workingCount(store.todaySets)
    }

    private func stamp(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
    }
}

// A write somebody lost. It is SAID — a set with its movement and its numbers, a claim-level
// document under its name — because a queue that dropped it quietly would count the loss as
// intended. ONE component because it is one voice: the logger says a loss over the workout it
// happened in, and Today says the same loss when a boot claim met it with no logger mounted.
// Dismiss clears the shown refusals on this surface.
struct RefusalRows: View {
    let refusals: [RefusedWrite]
    let catalog: [Exercise]
    let onDismiss: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ForEach(refusals) { refused in
            HStack(alignment: .top, spacing: WindmillSpace.x3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.headline(of: refused, in: catalog))
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.alarmInk)
                    Text(refused.reason)
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkDim)
                }
                Spacer(minLength: 0)
                Button("Dismiss", action: onDismiss)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
                    .frame(minHeight: GymTap.minimum)
            }
        }
    }

    // The convergence pin, to the word with Android's LoggerScreen.kt: claim-level losses are said
    // by NAME on both platforms, and the server's sentence rides underneath.
    //
    // A LOST SET AND A LOST CHANGE ARE NOT THE SAME LOSS and may not share a sentence. The first is
    // a set that never reached the log at all; the second is a set the log still holds, under the
    // numbers the lifter was trying to move it off — telling them it "never reached the log" would
    // be a false statement about training that is sitting there.
    static func headline(of refused: RefusedWrite, in catalog: [Exercise]) -> String {
        switch refused {
        case .set(let set):
            return "\(Readout.movement(set.exerciseId, in: catalog)) "
                + "\(Readout.effort(weightKg: set.weightKg, reps: set.reps)) never reached the log"
        case .change(let set):
            return "\(Readout.movement(set.exerciseId, in: catalog)) "
                + "\(Readout.effort(weightKg: set.weightKg, reps: set.reps)) — that change didn’t land"
        case .claim(let claim):
            return "“\(claim.name)” couldn’t be claimed"
        }
    }
}
