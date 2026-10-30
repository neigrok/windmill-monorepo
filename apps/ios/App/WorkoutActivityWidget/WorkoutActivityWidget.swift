import ActivityKit
import SwiftUI
import WidgetKit

@main
struct WorkoutActivityBundle: WidgetBundle {
  var body: some Widget {
    WorkoutActivityWidget()
    WorkoutControl()
  }
}

// The workout's one control (Figma Gym · iOS 04.1): it draws what the app last published.
struct WorkoutControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: WorkoutControlState.kind, provider: Board()) { state in
      ControlWidgetButton(action: WorkoutControlIntent(state)) {
        Label(state.title, systemImage: state.symbol).controlWidgetActionHint(state.actionHint)
        if let offer = state.offer { Text(offer.value) }
      }.tint(GymPalette.accent)
    }
    .displayName("Workout")
    .description("Start a workout, or log the set on the rack.")
  }

  struct Board: ControlValueProvider {
    var previewValue: WorkoutControlState { .startWorkout }
    func currentValue() async throws -> WorkoutControlState { (WorkoutControlBoard()?.read() ?? .startWorkout).drawn(at: .now) }
  }
}

// The ledger's current row outside the app: the Lock Screen card (04.7) and the expanded Island (04.6) each draw the
// movement's rest target static under the since clock. The Island's fixed shape holds its regions at .xxLarge text and the
// compact Island its clocks at .caption, its slots too narrow to scale. Neither says what is unsent; the room does.
struct WorkoutActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: WorkoutActivityAttributes.self) { context in
      WorkoutLockScreenCard(state: context.state, isStale: context.isStale)
        .activityBackgroundTint(GymPalette.card)
        .widgetURL(WorkoutActivityAttributes.workoutURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 2) {
            if context.state.movement.isEmpty {
              Text("Pick a movement in the app.").font(.headline).lineLimit(2).minimumScaleFactor(0.8)
            } else {
              Text(context.state.movement).font(.headline).lineLimit(1).minimumScaleFactor(0.7)
              if let place = context.state.place {
                Text(place.uppercased()).font(.caption2).fontDesign(.monospaced).tracking(0.7).foregroundStyle(.secondary).lineLimit(1)
                  .minimumScaleFactor(0.7)
              }
            }
          }.padding(.leading, 4).dynamicTypeSize(...DynamicTypeSize.xxLarge)
        }
        DynamicIslandExpandedRegion(.trailing) {
          WorkoutRestClock(state: context.state, numeral: .title.weight(.heavy), target: .caption)
            .frame(maxWidth: 120, alignment: .trailing).padding(.trailing, 4).dynamicTypeSize(...DynamicTypeSize.xxLarge)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Group {
            if context.isStale {
              Text("Open workout to continue").font(.subheadline).foregroundStyle(.secondary)
            } else if let offer = context.state.offer {
              Button(intent: WorkoutLogSetIntent(offer: offer)) {
                Text(["Log set", context.state.effort].compactMap(\.self).joined(separator: "  ·  ")).font(.headline).lineLimit(1)
                  .frame(maxWidth: .infinity, minHeight: 46)
                  .background(GymPalette.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                  .foregroundStyle(GymPalette.onAccent)
              }.buttonStyle(.plain).accessibilityLabel("Log set").accessibilityValue(context.state.effort ?? "")
            }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10).padding(.horizontal, 4).dynamicTypeSize(...DynamicTypeSize.xxLarge)
        }
      } compactLeading: {
        HStack(spacing: 4) {
          Image(systemName: "dumbbell.fill").foregroundStyle(GymPalette.accent)
          WorkoutActivityClock(name: "Workout time", from: context.state.startedAt, until: context.state.staleAt).frame(maxWidth: 52)
        }.font(.caption).dynamicTypeSize(.large)
      } compactTrailing: {
        WorkoutActivityClock.rest(context.state)
          .font(.caption).dynamicTypeSize(.large).frame(maxWidth: 52)
      } minimal: {
        Image(systemName: "dumbbell.fill").foregroundStyle(GymPalette.accent)
          .accessibilityLabel("Workout in progress")
      }
      .widgetURL(WorkoutActivityAttributes.workoutURL)
      .keylineTint(GymPalette.accent)
    }
  }
}

// The compact card (04.7): the routine, the movement and the set's place over the set it would log, and at the trailing
// edge the since clock over the rest target, then Log set. Stale, *Open workout to continue* takes the button's place;
// before a movement is chosen, where to choose it fills the movement's lines. The card sizes to its content, under
// ActivityKit's 160 pt.
struct WorkoutLockScreenCard: View {
  let state: WorkoutActivityAttributes.ContentState
  let isStale: Bool
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Label(state.title, systemImage: "dumbbell.fill").font(.subheadline.weight(.semibold)).lineLimit(1)
        if state.movement.isEmpty {
          Text("Pick a movement in the app.").font(.subheadline).foregroundStyle(GymPalette.inkDim).lineLimit(2)
        } else {
          Text(state.movement).font(.subheadline).foregroundStyle(GymPalette.inkDim).lineLimit(1)
          if let place = state.place { Text(place).font(.footnote).fontDesign(.monospaced).foregroundStyle(GymPalette.inkDim).lineLimit(1) }
          Spacer(minLength: 4)
          if !state.load.isEmpty, state.reps > 0 {
            Text("\(state.load) × \(state.reps)").font(.title2.weight(.bold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
          }
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 0) {
        WorkoutRestClock(state: state, numeral: .title2.weight(.bold), target: .footnote).frame(maxWidth: 110, alignment: .trailing)
        Spacer(minLength: 15)
        if isStale {
          Text("Open workout to continue").font(.caption).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.trailing)
        } else if let offer = state.offer {
          Button(intent: WorkoutLogSetIntent(offer: offer)) {
            Text("Log set").font(.headline).frame(width: 150, height: 52)
              .background(GymPalette.accent, in: Capsule()).foregroundStyle(GymPalette.onAccent)
          }.buttonStyle(.plain)
        }
      }
    }.fixedSize(horizontal: false, vertical: true).padding(16).foregroundStyle(GymPalette.ink)
  }
}

// The since clock over the movement's rest target, static: it never counts down and never changes colour. Before the first
// set the clock is the workout's time, which no target measures.
struct WorkoutRestClock: View {
  let state: WorkoutActivityAttributes.ContentState
  let numeral: Font
  let target: Font
  var body: some View {
    VStack(alignment: .trailing, spacing: 0) {
      WorkoutActivityClock.rest(state).font(numeral)
      if state.lastSetAt != nil, let rest = state.restReading {
        Text("/ " + rest).font(target).fontDesign(.monospaced).foregroundStyle(.secondary)
          .accessibilityLabel("Rest target").accessibilityValue(rest)
      }
    }
  }
}

// A clock the system draws from a timestamp; its name is spoken, never shown. The rest clock counts from the latest set,
// and from the start until there is one.
struct WorkoutActivityClock: View {
  let name: String
  let from: Date
  let until: Date
  static func rest(_ state: WorkoutActivityAttributes.ContentState) -> Self {
    guard let lastSetAt = state.lastSetAt else { return Self(name: "Workout time", from: state.startedAt, until: state.staleAt) }
    return Self(name: "Since last set", from: lastSetAt, until: state.staleAt)
  }
  var body: some View {
    Text(timerInterval: from...max(from, until), countsDown: false).monospacedDigit().multilineTextAlignment(.trailing)
      .accessibilityLabel(name)
  }
}
