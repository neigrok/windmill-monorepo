import SwiftUI
import DomainKit
import GymDomain

// The room's two-line row, a title over one meta line, wrapped by its caller in a Button or NavigationLink. At its edges: a
// symbol in its colour or a dot before the title, a dot after it, and trailing a fact (`iphone` before it while unsent,
// under the meta at accessibility sizes, the DoorChevron after it on a Button's door), the selection's check, work on its
// way, or the DoorChevron of a Button's door alone. It sets no height: its list row keeps the 44 pt target.
struct GymRow: View {
  enum Mark: Equatable { case symbol(String, Color), dot(Color, label: String? = nil) }
  enum Trailing: Equatable { case fact(String, unsent: Bool = false, door: Bool = false), check, progress, door }
  let title: String
  var meta: String?
  var leading: Mark?
  var titleDot: Mark?
  var titleColor = GymPalette.ink
  var trailing: Trailing?
  var lineLimit: Int?
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var dot = 8.0
  @ScaledMetric(relativeTo: .body) private var symbolColumn = 28.0

  var body: some View {
    let stacked = typeSize.isAccessibilitySize
    HStack(spacing: RoomSpace.related) {
      HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
        if let leading { mark(leading) }
        VStack(alignment: .leading, spacing: RoomSpace.small) {
          HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
            Text(title).font(meta == nil ? .body : .body.weight(.semibold)).monospacedDigit().foregroundStyle(titleColor).lineLimit(lineLimit)
            if let titleDot { mark(titleDot) }
          }
          if let meta { Text(meta).font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim).lineLimit(lineLimit) }
          if stacked, case .fact(let text, let unsent, _) = trailing { fact(text, unsent: unsent) }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      switch trailing {
      case .fact(let text, let unsent, let door):
        if !stacked { fact(text, unsent: unsent) }
        if door { DoorChevron(room: .gym) }
      case .check: Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true)
      case .progress: ProgressView()
      case .door: DoorChevron(room: .gym)
      case nil: EmptyView()
      }
    }
  }

  // A dot is 8 pt at the default size, centred on the first line's capitals at every size.
  @ViewBuilder func mark(_ mark: Mark) -> some View {
    switch mark {
    case .symbol(let name, let color):
      Image(systemName: name).foregroundStyle(color).frame(width: symbolColumn).accessibilityHidden(true)
    case .dot(let color, let label):
      let size = dot
      let circle = Circle().fill(color).frame(width: size, height: size)
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + size * 0.75 }
      if let label { circle.accessibilityElement().accessibilityLabel(label) } else { circle.accessibilityHidden(true) }
    }
  }

  func fact(_ text: String, unsent: Bool) -> some View {
    HStack(spacing: RoomSpace.related) {
      if unsent { Image(systemName: "iphone").accessibilityLabel("On this phone") }
      Text(text)
    }.font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
  }
}

// A row's trailing swipe: the system's round red trash circle, no word, which VoiceOver names by the act it commits. A
// full swipe never commits it. A swipe action fills with the tint around it, so the button clears the room's accent and
// the system paints its destructive red.
struct TrashSwipe: ViewModifier {
  let act: String
  var enabled = true
  let action: () -> Void

  func body(content: Content) -> some View {
    content.swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if enabled {
        Button(role: .destructive, action: action) { Image(systemName: "trash") }.tint(nil)
          .accessibilityLabel(act).accessibilityIdentifier("trash-swipe")
      }
    }
  }
}

// The one question every door that discards a workout asks (07.5): the receipt, The log's swipe and menu, workout detail
// and Inspect's ⋯. It records the question shown and a cancel on `screen`, and closes when the account changes.
struct DiscardWorkoutAlert: ViewModifier {
  let gym: GymModel
  let screen: String
  @Binding var isPresented: Bool
  let sets: Int
  let discard: () -> Void
  @State var confirmed = false

  static func message(sets: Int) -> String {
    (sets == 0 ? "This deletes the workout." : "This deletes the workout and its \(GymCount.of(sets, "set")).") + " You can’t undo this."
  }

  func body(content: Content) -> some View {
    content
      .alert("Discard this workout?", isPresented: $isPresented) {
        Button("Discard", role: .destructive) { confirmed = true; discard() }
        Button("Cancel", role: .cancel) {}
      } message: { Text(Self.message(sets: sets)) }
      .onChange(of: isPresented) { _, shown in
        if shown {
          confirmed = false
          gym.telemetry.event("gym_action", properties: ["screen": screen, "action": "discard", "state": "shown"])
        } else if !confirmed {
          gym.telemetry.event("gym_action", properties: ["screen": screen, "action": "cancel", "outcome": "cancelled"])
        }
      }
      .onChange(of: gym.account) { _, _ in isPresented = false }
  }
}

extension View {
  func trashSwipe(_ act: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
    modifier(TrashSwipe(act: act, enabled: enabled, action: action))
  }

  func discardWorkoutAlert(_ gym: GymModel, screen: String, isPresented: Binding<Bool>, sets: Int, discard: @escaping () -> Void) -> some View {
    modifier(DiscardWorkoutAlert(gym: gym, screen: screen, isPresented: isPresented, sets: sets, discard: discard))
  }
}

// A movement in a list the lifter orders, as the routine editor and This workout draw it: the list stays out of edit mode, so
// a long press lifts the row by its drawn handle and a swipe shows the trash. Its menu and VoiceOver's actions hold the same
// acts: Edit exercise, Move up, Move down and, where it can go, Remove movement. The caller's `onMove` takes the lift.
struct OrderedMovementRow<Label: View>: View {
  let exercise: Exercise?
  let index: Int
  let count: Int
  var removable = true
  let identifier: String
  let open: () -> Void
  let move: (Int) -> Void
  let remove: () -> Void
  let edit: (Exercise) -> Void
  @ViewBuilder let label: Label

  var body: some View {
    Button(action: open) {
      HStack(spacing: RoomSpace.related) {
        label
        Image(systemName: "line.3.horizontal").foregroundStyle(GymPalette.inkDim).accessibilityHidden(true)
      }
    }.accessibilityIdentifier(identifier)
      .trashSwipe("Remove movement", enabled: removable, action: remove)
      .contextMenu {
        if let exercise { Button("Edit exercise", systemImage: "pencil") { edit(exercise) } }
        Button("Move up") { move(-1) }.disabled(index == 0)
        Button("Move down") { move(1) }.disabled(index == count - 1)
        if removable { Button("Remove movement", systemImage: "trash", role: .destructive, action: remove) }
      }
      .accessibilityActions {
        Button("Move up") { move(-1) }
        Button("Move down") { move(1) }
        if removable { Button("Remove movement", action: remove) }
      }
  }
}

// One set read back: its place, its numbers and, when present, a trailing caption and a second line of the time, the
// effort and the note. Inline it reads *1 · 80 × 5*; in columns, as workout detail draws it, the place stands in its own
// column and the numbers take the monospaced face.
struct SetRow: View {
  enum Reading { case inline, columns }
  let marker: String
  let set: TrainingSet
  var caption: String?
  var time: String?
  var reading = Reading.inline
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var markerColumn = 28.0

  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    let effort = Readout.effort(weightKg: set.weightKg, reps: set.reps)
    let second = [time, set.rpe.map { "RPE \(Readout.weight($0))" }, set.note.isEmpty ? nil : set.note].compactMap { $0 }
    HStack(alignment: .firstTextBaseline, spacing: 0) {
      if reading == .columns {
        Text(marker).font(.footnote.monospaced()).foregroundStyle(GymPalette.inkDim).frame(width: markerColumn, alignment: .leading)
      }
      VStack(alignment: .leading, spacing: RoomSpace.small) {
        layout {
          Text(reading == .columns ? effort : "\(marker) · \(effort)")
            .font(reading == .columns ? .body.monospaced() : .body).monospacedDigit()
            .foregroundStyle(GymPalette.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
          if let caption { Text(caption).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim) }
        }
        if !second.isEmpty {
          Text(second.joined(separator: " · ")).font(reading == .columns ? .footnote : .subheadline).monospacedDigit()
            .foregroundStyle(GymPalette.inkDim)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel((["\(marker) · \(effort)", caption].compactMap { $0 } + (second.isEmpty ? [] : [second.joined(separator: " · ")])).joined(separator: ", "))
  }

  // A set by its place among the sets so far.
  nonisolated static func marker(_ set: TrainingSet, in sets: [TrainingSet]) -> String {
    "\(sets.prefix { $0.id != set.id }.count + 1)"
  }

  // Each movement once, in the order its first set was logged.
  nonisolated static func movements(_ sets: [TrainingSet]) -> [ID<Exercise>] {
    var ids: [ID<Exercise>] = []
    for set in sets where !ids.contains(set.exerciseId) { ids.append(set.exerciseId) }
    return ids
  }
}

// Up to three value-over-label tiles, drawing only the facts that are known: on one shared card, parted by hairlines, or
// each on its own card. A caller drawing its own cards clears the list row's background and insets.
struct FactTiles: View {
  struct Fact: Equatable {
    let value: String
    let label: String
    var record = false
    var identifier: String?
  }
  enum Ground { case shared, own }
  let facts: [Fact]
  var ground = Ground.shared
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let stacked = typeSize.isAccessibilitySize
    let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: ground == .own ? RoomSpace.related : RoomSpace.inset))
      : AnyLayout(HStackLayout(alignment: .center, spacing: ground == .own ? RoomSpace.related : RoomSpace.inset))
    layout {
      ForEach(Array(facts.prefix(3).enumerated()), id: \.offset) { index, fact in
        if ground == .shared && index > 0 && !stacked {
          Rectangle().fill(GymPalette.line).frame(width: 1, height: 44).accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: RoomSpace.small) {
          Text(fact.value).font(.title3.weight(.semibold)).monospacedDigit()
            .foregroundStyle(fact.record ? GymPalette.record : GymPalette.ink).lineLimit(1).minimumScaleFactor(0.5)
          Text(fact.label).font(.caption).foregroundStyle(GymPalette.inkDim)
        }.frame(maxWidth: .infinity, alignment: .leading)
          .padding(ground == .own ? 14 : 0)
          .background { if ground == .own { RoundedRectangle(cornerRadius: RoomSpace.cardRadius).fill(GymPalette.card) } }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier(fact.identifier ?? "")
      }
    }
  }
}

extension FactTiles {
  // A session's tiles, read the same wherever a session is told: Duration · Working sets · Volume, the duration only once
  // the session has finished. The finish receipt sets each on its own card (03.7).
  init(_ readout: SessionReadout, ground: Ground = .shared) {
    self.init(facts: [
      readout.durationMs.map { Fact(value: Readout.duration($0), label: "Duration") },
      Fact(value: "\(readout.workingSetCount)", label: GymCount.noun(readout.workingSetCount, "Working set")),
      Fact(value: "\(Readout.weight(readout.volumeKg)) kg", label: "Volume"),
    ].compactMap { $0 }, ground: ground)
  }
}
