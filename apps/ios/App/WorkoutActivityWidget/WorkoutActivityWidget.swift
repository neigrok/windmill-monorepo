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
      WorkoutActivityBanner(state: context.state, isStale: context.isStale)
        .activityBackgroundTint(Color(.systemBackground))
        .activitySystemActionForegroundColor(.primary)
        .widgetURL(WorkoutActivityAttributes.workoutURL)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label(context.state.title, systemImage: "dumbbell.fill")
            .font(.headline).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          WorkoutActivityClock(title: "Workout", start: context.state.startedAt, end: context.state.staleAt)
            .padding(.trailing, 12)
        }
        DynamicIslandExpandedRegion(.bottom) {
          WorkoutActivityDetails(state: context.state, isStale: context.isStale, expanded: true)
            .controlSize(.small).padding(.horizontal, 12).padding(.bottom, 8)
        }
      } compactLeading: {
        HStack(spacing: 4) {
          Image(systemName: "dumbbell.fill").foregroundStyle(WorkoutActivityStyle.accent)
          Text(timerInterval: context.state.startedAt...max(context.state.startedAt, context.state.staleAt), countsDown: false).monospacedDigit().frame(maxWidth: 52)
        }.font(.caption2)
      } compactTrailing: {
        Text(timerInterval: (context.state.lastSetAt ?? context.state.startedAt)...max(context.state.lastSetAt ?? context.state.startedAt, context.state.staleAt), countsDown: false)
          .monospacedDigit().font(.caption2).frame(maxWidth: 52)
          .accessibilityLabel("Since last set")
      } minimal: {
        Image(systemName: "dumbbell.fill").foregroundStyle(WorkoutActivityStyle.accent)
          .accessibilityLabel("Workout in progress")
      }
      .widgetURL(WorkoutActivityAttributes.workoutURL)
      .keylineTint(WorkoutActivityStyle.accent)
    }
  }
}

struct WorkoutActivityBanner: View {
  let state: WorkoutActivityAttributes.ContentState
  let isStale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top) {
        Label(state.title, systemImage: "dumbbell.fill").font(.headline).lineLimit(1)
        Spacer(minLength: 8)
        HStack(spacing: 4) {
          Text("Workout").foregroundStyle(.secondary)
          Text(timerInterval: state.startedAt...max(state.startedAt, state.staleAt), countsDown: false).monospacedDigit()
        }.font(.caption).frame(width: 112, alignment: .trailing).accessibilityElement(children: .combine)
      }
      WorkoutActivityDetails(state: state, isStale: isStale)
    }.padding(12)
  }
}

struct WorkoutActivityDetails: View {
  let state: WorkoutActivityAttributes.ContentState
  let isStale: Bool
  var expanded = false
  var body: some View {
    VStack(alignment: .leading, spacing: expanded ? 4 : 8) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(state.movement.isEmpty ? "Choose a movement" : state.movement)
            .font(.subheadline.weight(.semibold)).lineLimit(1)
          if !state.load.isEmpty, state.reps > 0 {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text("\(state.load) × \(state.reps)").font((expanded ? Font.body : .title3).weight(.semibold)).monospacedDigit()
              if state.setKind != "working" {
                Text(state.setKind == "warmup" ? "Warmup" : state.setKind == "drop" ? "Drop set" : "To failure")
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
          if state.workingSetOrdinal > 0 {
            if let count = state.plannedWorkingSetCount {
              Text("\(state.setKind == "working" ? "Working set" : "Next working set") \(state.workingSetOrdinal) of \(count)")
                .font(.caption).foregroundStyle(.secondary)
            } else {
              Text("\(state.setKind == "working" ? "Working set" : "Next working set") \(state.workingSetOrdinal)")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
        WorkoutActivityClock(title: "Since last set", start: state.lastSetAt ?? state.startedAt, end: state.staleAt)
      }
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          if isStale { Text("Open workout to continue") }
          if state.unsyncedSetCount > 0 { Text("\(state.unsyncedSetCount) not sent yet") }
        }.font(.caption).foregroundStyle(.secondary)
        Spacer(minLength: 8)
        if !isStale, let offer = state.offer {
          Button(intent: WorkoutLogSetIntent(offer: offer)) {
            Label("Log set", systemImage: "plus").font(.subheadline.weight(.semibold))
          }.buttonStyle(.borderedProminent).tint(WorkoutActivityStyle.accent).foregroundStyle(.black)
        }
      }
    }
  }
}

struct WorkoutActivityClock: View {
  let title: String
  let start: Date
  let end: Date
  var body: some View {
    VStack(alignment: .trailing, spacing: 3) {
      Text(title).font(.caption2).foregroundStyle(.secondary)
      Text(timerInterval: start...max(start, end), countsDown: false).font(.subheadline.weight(.medium)).monospacedDigit().multilineTextAlignment(.trailing)
    }.frame(width: 90, alignment: .trailing).accessibilityElement(children: .combine)
  }
}

enum WorkoutActivityStyle {
  static let accent = Color(red: 0.31, green: 0.75, blue: 0.65)
}
