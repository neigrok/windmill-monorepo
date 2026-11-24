import SwiftUI
import RoadmapDomain

// A plan read back before anything is written (Roadmap · iOS 01.8, 02.17): the grammar's counts, and its steps in the
// states they will land in.

// The steps a plan brings, and of them its branches, the ones it brings done and the lines it kept as notes, each said
// where it has any.
struct PlanCounts: View {
  let steps: Int
  let branches: Int
  let done: Int
  let notes: Int

  var body: some View {
    Group {
      LabeledContent("Steps", value: steps.formatted()).accessibilityIdentifier("roadmap-plan-steps")
      if branches > 0 { LabeledContent("Branches", value: branches.formatted()).accessibilityIdentifier("roadmap-plan-branches") }
      if done > 0 { LabeledContent("Already done", value: done.formatted()).accessibilityIdentifier("roadmap-plan-done") }
      if notes > 0 { LabeledContent("Lines kept as notes", value: notes.formatted()).accessibilityIdentifier("roadmap-plan-notes") }
    }.foregroundStyle(RoadmapPalette.ink).listRowBackground(RoadmapPalette.card)
  }
}

// A step as it will land: its state's symbol in its kind's colour, and its name, dimmed while it is Locked.
struct PlannedStepRow: View {
  let landing: RoadmapPlan.Landing
  @ScaledMetric(relativeTo: .body) var symbolColumn = 24.0

  var body: some View {
    let column = BoardRead.Column.Name(landing.state)
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: column.symbol).imageScale(.large).foregroundStyle(RoadmapPalette.kind(landing.color)).frame(width: symbolColumn)
        .accessibilityLabel(column.title)
      Text(RoadmapModel.Row.name(of: landing.label)).foregroundStyle(column == .locked ? RoadmapPalette.inkDim : RoadmapPalette.ink)
    }.listRowBackground(RoadmapPalette.card).accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-planned-step")
  }
}

extension BoardRead.Column.Name {
  // The group a step in this state stands in.
  init(_ state: StepState) {
    switch state {
    case .available: self = .upNext
    case .locked: self = .locked
    case .complete: self = .done
    }
  }
}
