import SwiftUI
import WindmillPlatform

// THE SET LOGGER — one value at a time, at arm's length, in a room where you cannot hear the tone and
// your hands are chalked.
//
// REBUILT TO §K, 2026-08-12. The first version put thirteen near-equal targets and three lines of
// instructions in front of a man holding a barbell. Nine times in ten the next set is the same
// weight and the same reps, so that case is now one tap and nothing to read: weight and reps are ONE
// reading (`105 kg × 5`, weight dominant, because the weight is the setting and the reps the
// outcome), the fine step is the big button with the plate step beside it as a visibly smaller
// neighbour, and the rare things — a set that is not a working set, the next movement, the pad —
// each cost one deliberate gesture and none of them sit beside the button pressed while out of
// breath. What came off with them: the tier caption, which named numbers the buttons already print;
// `tap the number to type it`, which a dotted underline carries instead; the last-time card, whose
// numbers are already dialled in under the thumb; and the rest's label, which named a setting the
// lifter chose on another screen.
//
// WHAT DID NOT COME OFF, because a quieter screen may not be a less truthful one: the rest's own
// numeral, which is what tells one overrun from another once the rule has filled; the one line the
// last-time card had that was never about a number — a read that was asked and did not land; and
// every verb, each of which is named below with where it went.
//
// EVERY WEIGHT AND REP TAP GOES THROUGH `Ladder`. Step sizes are not re-derived here or anywhere
// else — one module per language, all answering packages/api-contract/gym-ladder.json — and the
// labels re-render as the load climbs because the band under it changed. §K moved the labels and
// left that rule exactly where W1a shipped it.
//
// The screen never congratulates and never warns. An overrun rest fills its rule and stops, "set 4
// of 3" is drawn in the same ink as "set 3 of 5", and the only alarm ink in the product belongs to a
// write that actually failed.

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
    @State private var kind: SetKind = .working
    @State private var kindsUp = false
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
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            header
            if let clock = restClock { restRow(clock) }
            if let line = LiveLines.onThisDeviceLine(store.strandedCount) { unsynced(line) }
            RefusalRows(refusals: store.refusals, catalog: store.catalog,
                        onDismiss: { store.clearRefusals() })

            if store.exerciseId == nil {
                assembling
            } else {
                movementHead
                Spacer(minLength: 0)
                todayColumn
                value
                Spacer(minLength: 0)
                kindPill
                ladder
                repsRow
                logButton
            }
        }
        .padding(.horizontal, WindmillSpace.x4)
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
                Spacer(minLength: 0)
                Text(Readout.clock(stamp(beat.date) - (store.session?.startedAtMs ?? 0)))
                    .font(GymType.numeral(14))
                    .foregroundStyle(skin.inkDim)
                Button("Finish", action: onFinish)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(minWidth: 70, minHeight: GymTap.minimum)
            }
        }
    }

    // THE REST, AS A HAIRLINE AND A NUMERAL (§K, which draws both). It was three strings and a
    // button; what a lifter does with a rest is glance at it, so it is a 2pt rule that fills toward
    // the target — and the clock beside it, because a filled rule is where the rule runs out of
    // things to say: it pins on the target, and a rest seven seconds over and one twenty minutes
    // over are then the same pixel. What went is the LABEL, `resting · target 3:00`, which named a
    // setting the lifter chose back at a screen they set it on.
    //
    // The tap is the old `reset`, kept and moved rather than dropped: it clears the clock, and the
    // row is given a thumb's worth of height so a gesture can find it. Nothing else on this screen
    // is under here, so a stray tap costs a rest nobody was reading.
    private func restRow(_ clock: Rest.Clock) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { beat in
            let now = stamp(beat.date)
            let filled = Rest.filled(targetSeconds: clock.targetSeconds,
                                     startedAtMs: clock.startedAtMs, now: now)
            let reading = Rest.reading(targetSeconds: clock.targetSeconds,
                                       startedAtMs: clock.startedAtMs, now: now)
            Button { restStartedAtMs = nil } label: {
                HStack(spacing: WindmillSpace.x3) {
                    Capsule().fill(skin.line)
                        .frame(height: 2)
                        .overlay(alignment: .leading) {
                            GeometryReader { rule in
                                Capsule().fill(skin.accent).frame(width: rule.size.width * filled)
                            }
                        }
                    Text(reading)
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkDim)
                }
                .frame(maxWidth: .infinity, minHeight: 22)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Resting")
            .accessibilityValue(reading)
            .accessibilityHint("Clears the rest timer")
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

    // NAVIGATION BELONGS IN THE TITLE (§K), so the walk is the two chevrons beside the movement's
    // name and no longer a `next ›` sitting one thumb-width from `Log set`. They step through
    // `store.order` — the same walk the assembly list draws — and stop at its ends rather than
    // wrapping, because a list with a first and a last one is what the lifter is holding.
    //
    // The NAME is the door onto that list, which is where a movement is added, reordered or dropped.
    // It replaces the chevron that used to open it: the title is the one thing on this screen that
    // is already about "which movement", and a fourth control in the head would be a target back.
    private var movementHead: some View {
        HStack(spacing: WindmillSpace.x2) {
            walkButton(-1, glyph: "chevron.left", label: "Previous movement")
            Button { sheet = .jump } label: {
                VStack(spacing: 2) {
                    Text(Readout.movement(store.exerciseId ?? "", in: store.catalog))
                        .font(WindmillFont.display(26))
                        .foregroundStyle(skin.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(counter.plan)
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.targetInk)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .accessibilityHint("This session’s movements")
            walkButton(1, glyph: "chevron.right", label: "Next movement")
        }
    }

    private func walkButton(_ direction: Int, glyph: String, label: String) -> some View {
        let neighbour = walk(direction)
        return Button { if let neighbour { move(to: neighbour) } } label: {
            Image(systemName: glyph)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(neighbour == nil ? skin.line : skin.inkFaint)
                .frame(width: GymTap.minimum, height: GymTap.minimum)
        }
        .disabled(neighbour == nil)
        .accessibilityLabel(label)
    }

    private func walk(_ direction: Int) -> String? {
        guard let current = store.exerciseId,
              let standing = store.order.firstIndex(of: current) else { return nil }
        let next = standing + direction
        guard store.order.indices.contains(next) else { return nil }
        return store.order[next]
    }

    // WHERE AM I, ANSWERED BY LOOKING (§K) — this movement's sets as a column, in the order they were
    // performed, instead of a line of ticks and a count. The row of a set still owed carries the
    // UNDO: the confirmation used to be a sentence above the primary action, which put a control that
    // destroys a set next to the button that makes one, and put it there for every set forever.
    //
    // Undo is offered only over the set it takes back, and only while that set is still this device's
    // alone. Once the log holds the row it is §G18's sheet that moves it, there, with a confirmation
    // and its own way back. The row it hangs on TRAVELS if the walk moves on inside the window
    // (`LiveLines.column`) — the chevrons above are one tap away from a set logged seconds ago, and
    // an armed verb whose row is on no screen would be the verb deleted rather than moved.
    private var todayColumn: some View {
        // Both the rows and their height are read on the beat: the travelling Undo leaves when its
        // window closes, and nothing publishes that — a height measured outside this would hold a
        // gap open under a row that is no longer drawn.
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let undoable = store.undoable
            let rows = LiveLines.column(store.sets, of: store.exerciseId, undoable: undoable,
                                        catalog: store.catalog, stalled: store.stalled)
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(rows) { row in
                        done(row, undoable: row.id == undoable?.id)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            // THE NEWEST ROWS, not the oldest. Past the cap this scrolls, and a column anchored at
            // the top would put the set just logged — the one an Undo is still owed on — below the
            // fold on the fourth set of every movement.
            .defaultScrollAnchor(.bottom)
            // ONLY THIS COLUMN IS ELASTIC, and it asks for exactly what it holds — a scroll view
            // left to itself is greedy, and the first set of a session would be drawn under a
            // hundred points of empty box. Three rows fit; past that it scrolls inside itself, so a
            // session of twenty sets cannot push the value or the buttons under it off the screen.
            // Nothing in the block below moves at all as sets accumulate: the pill, the ladder, the
            // reps and the 64pt action are the geometry the thumb learns on the first set and keeps
            // for the whole session.
            .frame(maxHeight: min(Self.columnCap, CGFloat(rows.count) * Self.rowHeight))
        }
        .layoutPriority(1)
    }

    // A row is a 46pt card and 6 of gap — 46 because while a set is still this device's alone that
    // row holds the Undo, and nothing in this room is tappable under 46. They are named rather than
    // measured because the column has to claim its height BEFORE its rows are laid out, and the cap
    // is three of them so the sentence above it and the number here cannot drift apart.
    private static let rowHeight: CGFloat = 52
    private static let columnCap: CGFloat = rowHeight * 3

    private func done(_ row: LiveLines.Row, undoable: Bool) -> some View {
        HStack(spacing: WindmillSpace.x3) {
            Text(row.index)
                .font(GymType.numeral(11.5))
                .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.inkFaint)
                .frame(width: 16, alignment: .leading)
            Text(row.value)
                .font(GymType.numeral(14.5))
                .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.ink)
            Text(row.note)
                .font(GymType.numeral(11))
                .foregroundStyle(row.isOnThisDevice ? skin.unsyncedInk : skin.inkFaint)
            Spacer(minLength: 0)
            if undoable {
                Button("Undo") { store.undoLast() }
                    .font(WindmillFont.body(13, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(minWidth: 56, minHeight: GymTap.minimum)
            } else {
                Text("✓")
                    .font(GymType.numeral(13))
                    .foregroundStyle(row.countsTowardNothing ? skin.warmupInk : skin.setDone)
            }
        }
        .padding(.horizontal, WindmillSpace.x3)
        .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
    }

    // MARK: - the value

    // ONE READING AND NOT TWO NUMBERS (§K): `105 kg × 5`, weight dominant. The weight is what the
    // lifter sets and the reps are what the set gave, so they are read together, in that order of
    // loudness — the two used to be two numerals of near-equal weight on two rows, and the eye had to
    // choose which one it was looking at. Only the WEIGHT is a button here: the reps are typed from
    // their own row below, where the number they change already is, and a second door onto the same
    // pad inside one reading would re-split the reading.
    private var value: some View {
        VStack(spacing: 6) {
            Text(counter.count)
                .font(GymType.numeral(10.5))
                .textCase(.uppercase)
                .kerning(0.7)
                .foregroundStyle(skin.inkFaint)

            HStack(alignment: .lastTextBaseline, spacing: WindmillSpace.x2) {
                Button { sheet = .weight } label: {
                    Text(Readout.weight(weightKg))
                        .font(GymType.weight)
                        .foregroundStyle(skin.weightInk)
                        .lineLimit(1)
                        // A −102.5 is the widest thing this readout ever holds. It shrinks rather
                        // than truncating: half a weight is worse than a small one.
                        .minimumScaleFactor(0.55)
                        .overlay(alignment: .bottom) { typeable }
                }
                .accessibilityLabel("Weight \(Readout.weight(weightKg)) kilograms")
                .accessibilityHint("Type a weight")
                Text("kg")
                    .font(GymType.numeral(15))
                    .foregroundStyle(skin.inkFaint)
                Text("× \(reps)")
                    .font(GymType.reps)
                    .foregroundStyle(skin.inkDim)
            }

            // §K's line under the numeral: what would go on the bar, built from the plates this gym
            // says it owns — or, when they cannot make the number, the loads that can be made
            // instead. The buttons never hide a weight; this tells the truth about one. It is the one
            // line here that does work at the rack, which is why it is the one that stayed.
            if let plates = Plates.readout(totalKg: weightKg, under: store.preferences) {
                Text(plates)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }

            // ALL THAT IS LEFT OF THE LAST-TIME CARD, and it is here because it is the one state of
            // that card that was never about our design. The numbers went with the card — they are
            // already dialled in under the thumb, which is what §K deleted them for — but a read
            // that was ASKED and came back empty-handed is a fact about this lifter's log, and the
            // dial is silently the empty bar or the plan's number without it. A man who has benched
            // 105 for a year, phone in a basement, may not be shown 20 kg with nothing anywhere
            // saying the log was never reached.
            if store.lastTimeFailed {
                Text("the log didn’t answer — this isn’t your last time")
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.unsyncedInk)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // THE WHOLE OF `tap the number to type it`, which was a line of instructions under the numeral
    // until 2026-08-12. It is drawn on every number that opens the pad and on nothing else, so the
    // mark means one thing wherever it turns up.
    //
    // SwiftUI's own `underline(pattern: .dot)` scales its rule with the font, which under a 104pt
    // numeral is a row of blocks. This is 2pt under both numbers, which is what makes it read as one
    // mark rather than two decorations.
    private var typeable: some View {
        DottedRule()
            .stroke(style: StrokeStyle(lineWidth: 2, dash: [2, 3]))
            .foregroundStyle(skin.lineStrong)
            .frame(height: 2)
    }

    // MARK: - the dial

    // THE SET TYPE BECOMES ONE PILL THAT STATES THE CURRENT VALUE (§K). It was a `warmup` toggle in
    // the reps row, inferred from what was lit; the pill says which kind the next set will be filed
    // as, and the choice costs one deliberate gesture instead of sitting beside the button pressed
    // while out of breath.
    //
    // TWO KINDS, WHICH IS THE TWO THIS LOGGER HAS EVER MINTED. `drop` and `failure` are kinds the
    // log HOLDS — a set from the coach or another surface wears one, and the column below names it
    // — but no iOS logger has ever filed one, and §K moved verbs rather than adding any. Offering
    // them here would be this wave quietly growing the screen it was sent to shrink.
    //
    // IT DISARMS ITSELF THE MOMENT A SET LANDS, because none of these is a mode you can be left in: a
    // warmup is a single set, and a toggle that stayed on would file every working set after it as a
    // ramp-up. A warmup counts toward NOTHING — not the plan counter, not the sticky weight, no
    // record rule, and not "Keep this as a routine" — which is why the choice has to exist at all:
    // without it a 40 kg ramp-up is filed as working, becomes the mark to beat, and the finish screen
    // mints a gold personal record for it.
    private var kindPill: some View {
        HStack(spacing: 0) {
            Button { kindsUp = true } label: {
                HStack(spacing: WindmillSpace.x1) {
                    Text(kind.rawValue)
                        .font(WindmillFont.body(13, .bold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(skin.inkFaint)
                }
                .foregroundStyle(kind == .working ? skin.inkDim : skin.warmupInk)
                .padding(.horizontal, WindmillSpace.x4)
                .frame(minHeight: GymTap.minimum)
                .background(Capsule().fill(skin.surface))
                .overlay(Capsule().strokeBorder(skin.lineStrong, lineWidth: 1))
            }
            .accessibilityLabel("Set type")
            .accessibilityValue(kind.rawValue)
            Spacer(minLength: 0)
        }
        // A dialog rather than a menu: a menu opens where the pill is, in rows sized for a mouse,
        // and this is answered by a chalked thumb in the four biggest targets on the screen.
        .confirmationDialog("Log the next set as", isPresented: $kindsUp, titleVisibility: .visible) {
            ForEach([SetKind.working, .warmup], id: \.self) { choice in
                Button(choice.rawValue) { kind = choice }
            }
        }
    }

    // THE LABELS ARE THE CAPTION (§K). The fine step is the big button — it is the step a barbell
    // program is written in — and the plate step is a visibly smaller neighbour, so the two are told
    // apart by size and weight rather than by a line of text under them naming numbers they already
    // print. `Ladder.labels` is the order: down-plate, down-fine, up-fine, up-plate.
    private var ladder: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(Array(Ladder.labels(for: weightKg).enumerated()), id: \.offset) { index, label in
                let plate = index == 0 || index == 3
                Button { weightKg = Ladder.bump(weight: weightKg, direction: index < 2 ? -1 : 1,
                                                big: plate) } label: {
                    Text(label)
                        .font(GymType.numeral(plate ? 13 : 18, .semibold))
                        .foregroundStyle(plate ? skin.inkFaint : skin.ink)
                        .frame(maxWidth: plate ? 54 : .infinity, minHeight: 60)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .fill(plate ? skin.surface : skin.raised))
                        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .strokeBorder(plate ? skin.line : skin.lineStrong, lineWidth: 1))
                }
            }
        }
    }

    private var repsRow: some View {
        HStack(spacing: WindmillSpace.x2) {
            Text("reps")
                .font(WindmillFont.body(13))
                .foregroundStyle(skin.inkFaint)
            Spacer(minLength: 0)
            Button { reps = Ladder.bumpReps(reps, direction: -1) } label: { step("−") }
                .accessibilityLabel("One rep fewer")
            Button { sheet = .reps } label: {
                Text(String(reps))
                    .font(GymType.numeral(20, .bold))
                    .foregroundStyle(skin.ink)
                    .overlay(alignment: .bottom) { typeable }
                    .frame(minWidth: 40, minHeight: GymTap.minimum)
            }
            .accessibilityLabel("\(reps) reps")
            .accessibilityHint("Type a rep count")
            Button { reps = Ladder.bumpReps(reps, direction: 1) } label: { step("+") }
                .accessibilityLabel("One rep more")
        }
    }

    private func step(_ glyph: String) -> some View {
        Text(glyph)
            .font(WindmillFont.display(21, .semibold))
            .foregroundStyle(skin.inkDim)
            .frame(width: GymTap.minimum, height: GymTap.minimum)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
    }

    // No rest until a set lands: the timer times the gap between two sets, and one started before the
    // first would be counting from the moment the screen opened. No rest at all until somebody asked
    // for one either — the dial starts off (§I), and a clock nobody set is a clock this screen does
    // not draw.
    private var restClock: Rest.Clock? {
        guard let started = restStartedAtMs,
              let target = Rest.target(planEntry: store.planEntry, preferences: store.preferences)
        else { return nil }
        return Rest.Clock(startedAtMs: started, targetSeconds: target)
    }

    private var logButton: some View {
        Button {
            let landed = Int64(Date().timeIntervalSince1970 * 1000)
            let filedAs = kind
            GymConfirm.setLogged(under: store.preferences)
            restStartedAtMs = landed
            // Disarmed on the tap and not on the reply: the set is the lifter's the instant they
            // press, and the pill is about the set that just went, never about the network.
            kind = .working
            Task { await store.logSet(weightKg: weightKg, reps: reps, kind: filedAs) }
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
    // The title's chevrons and the opening picker are not sheets, so there is no dismissal to hang
    // the move on and it settles here. Same move, same offer, one place every road ends.
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

    // Read in two places and computed once, because they are two halves of one sentence: the count
    // stands over the numeral and the target under the movement's name.
    private var counter: LiveLines.Counter {
        LiveLines.counter(workingSetsToday: LiveLines.workingCount(store.todaySets),
                          planEntry: store.planEntry)
    }

    private func stamp(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
    }
}

// A plain horizontal rule, because SwiftUI has no dashed line and its dashed BORDERS are four sides
// of one. Everything about how it is drawn — the dash, the weight, the ink — belongs to the caller.
private struct DottedRule: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
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
