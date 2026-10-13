import ActivityKit
import SwiftUI
import WidgetKit

@main
struct WorkoutActivityBundle: WidgetBundle {
  var body: some Widget { WorkoutActivityWidget() }
}

struct WorkoutActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: WorkoutActivityAttributes.self) { context in
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Label(context.state.title, systemImage: "dumbbell.fill").font(.headline).lineLimit(1)
          Spacer(minLength: 8)
          WorkoutActivityClock(name: "Workout time", from: context.state.startedAt, until: context.state.staleAt)
            .font(.headline).frame(maxWidth: 96, alignment: .trailing)
        }
        WorkoutActivityDetails(state: context.state, isStale: context.isStale)
      }.padding(16)
        .activityBackgroundTint(Color(.systemBackground))
        .activitySystemActionForegroundColor(.primary)
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
        }.font(.caption2)
      } compactTrailing: {
        WorkoutActivityClock(name: "Since last set", from: context.state.lastSetAt ?? context.state.startedAt, until: context.state.staleAt)
          .font(.caption2).frame(maxWidth: 52)
      } minimal: {
        Image(systemName: "dumbbell.fill").foregroundStyle(GymPalette.accent)
          .accessibilityLabel("Workout in progress")
      }
      .widgetURL(WorkoutActivityAttributes.workoutURL)
      .keylineTint(GymPalette.accent)
    }
  }
}

// The ledger's current row: the movement, the prefilled set, its place in the plan and the rest since the last set.
struct WorkoutActivityDetails: View {
  let state: WorkoutActivityAttributes.ContentState
  let isStale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(state.movement.isEmpty ? "Choose a movement" : state.movement)
          .font(.subheadline.weight(.semibold)).lineLimit(1)
        if !state.load.isEmpty, state.reps > 0 {
          Text("\(state.load) × \(state.reps)").font(.title2.weight(.semibold)).monospacedDigit().lineLimit(1)
        }
        position.font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
      }
      HStack(alignment: .bottom) {
        VStack(alignment: .leading, spacing: 2) {
          if isStale { Text("Open workout to continue") }
          if state.unsyncedSetCount > 0 { Text("\(state.unsyncedSetCount) not sent yet") }
        }.font(.caption).foregroundStyle(.secondary)
        Spacer(minLength: 8)
        if !isStale, let offer = state.offer {
          Button(intent: WorkoutLogSetIntent(offer: offer)) {
            Label("Log set", systemImage: "plus").font(.subheadline.weight(.semibold))
          }.buttonStyle(.borderedProminent).tint(GymPalette.accent).foregroundStyle(GymPalette.onAccent)
        }
      }
    }
  }

  var position: Text {
    let planned = state.plannedWorkingSetCount.flatMap { $0 >= state.workingSetOrdinal ? $0 : nil }
    let set = planned.map { "Set \(state.workingSetOrdinal) of \($0)" } ?? "Set \(state.workingSetOrdinal)"
    guard let lastSetAt = state.lastSetAt else { return Text(set) }
    let rest = Text(timerInterval: lastSetAt...max(lastSetAt, state.staleAt), countsDown: false)
    return Text("\(set) · \(rest) since last set")
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
