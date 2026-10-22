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

// The workout's one control (docs/design/ios/ios-redesign.md §7.19): it draws what the app last published.
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

// The ledger's current row outside the app (docs/design/ios/ios-redesign.md §7.7): the routine and the workout clock on
// top, which the expanded Island draws in its leading and trailing regions, then the set it would log, and Log set. The
// compact Island keeps the clocks at .caption, its slots too narrow to scale.
struct WorkoutActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: WorkoutActivityAttributes.self) { context in
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Label(context.state.title, systemImage: "dumbbell.fill").lineLimit(1)
          Spacer(minLength: 8)
          WorkoutActivityClock(name: "Workout time", from: context.state.startedAt, until: context.state.staleAt).frame(maxWidth: 96, alignment: .trailing)
        }.font(.headline)
        WorkoutActivityDetails(state: context.state, isStale: context.isStale)
      }.padding(16)
        .widgetURL(WorkoutActivityAttributes.workoutURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label(context.state.title, systemImage: "dumbbell.fill").font(.headline).lineLimit(1).padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          WorkoutActivityClock(name: "Workout time", from: context.state.startedAt, until: context.state.staleAt)
            .font(.headline).frame(maxWidth: 96, alignment: .trailing).padding(.trailing, 12)
        }
        DynamicIslandExpandedRegion(.bottom) {
          WorkoutActivityDetails(state: context.state, isStale: context.isStale)
            .controlSize(.small).padding(.horizontal, 12).padding(.bottom, 8)
        }
      } compactLeading: {
        HStack(spacing: 4) {
          Image(systemName: "dumbbell.fill").foregroundStyle(GymPalette.accent)
          WorkoutActivityClock(name: "Workout time", from: context.state.startedAt, until: context.state.staleAt).frame(maxWidth: 52)
        }.font(.caption).dynamicTypeSize(.large)
      } compactTrailing: {
        WorkoutActivityClock(name: context.state.lastSetAt == nil ? "Workout time" : "Since last set", from: context.state.lastSetAt ?? context.state.startedAt, until: context.state.staleAt)
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

// The movement, the prefilled set as the one large line, its place in the plan with the rest since the last set, and Log
// set; before a movement is chosen, where to choose it and the rest alone. What is not yet sent is said beside the button,
// or above it where the row is too narrow for both.
struct WorkoutActivityDetails: View {
  let state: WorkoutActivityAttributes.ContentState
  let isStale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        if state.movement.isEmpty {
          Text("Pick a movement in the app.").font(.title3.weight(.semibold)).lineLimit(2)
        } else {
          Text(state.movement).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
          if !state.load.isEmpty, state.reps > 0 {
            Text("\(state.load) × \(state.reps)").font(.title2.weight(.bold)).monospacedDigit().lineLimit(1)
          }
        }
        position.font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
      }
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .center) { aside; Spacer(minLength: 8); logSet }
        VStack(alignment: .leading, spacing: 8) { aside; logSet }
      }
    }
  }

  @ViewBuilder var aside: some View {
    if isStale || state.unsentSetCount > 0 {
      VStack(alignment: .leading, spacing: 2) {
        if isStale { Text("Open workout to continue") }
        if state.unsentSetCount > 0 { Text("\(state.unsentSetCount) not sent yet") }
      }.font(.caption).foregroundStyle(.secondary).fixedSize()
    }
  }

  @ViewBuilder var logSet: some View {
    if !isStale, let offer = state.offer {
      Button(intent: WorkoutLogSetIntent(offer: offer)) {
        Text("Log set").font(.subheadline.weight(.semibold)).fixedSize()
      }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(GymPalette.accent).foregroundStyle(GymPalette.onAccent)
    }
  }

  @ViewBuilder var position: some View {
    let rest = state.lastSetAt.map { Text(timerInterval: $0...max($0, state.staleAt), countsDown: false) }
    if let place = state.place, let rest { Text("\(place) · \(rest) since last set") }
    else if let place = state.place { Text(place) }
    else if let rest { Text("\(rest) since last set") }
  }
}

// A clock the system draws from a timestamp; its name is spoken, never shown.
struct WorkoutActivityClock: View {
  let name: String
  let from: Date
  let until: Date
  var body: some View {
    Text(timerInterval: from...max(from, until), countsDown: false).monospacedDigit().multilineTextAlignment(.trailing)
      .accessibilityLabel(name)
  }
}
