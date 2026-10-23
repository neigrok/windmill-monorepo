import SwiftUI
import UIKit
import Observation
import DomainKit
import GymDomain
import SyncCore

@Observable nonisolated final class WorkoutReceiptData {
  let session: Session
  let sets: [TrainingSet]
  let suggestsKeep: Bool
  var review: WorkoutReview?
  var reviewFailed = false
  var readingReview = false
  init(session: Session, sets: [TrainingSet], suggestsKeep: Bool = false) {
    self.session = session; self.suggestsKeep = suggestsKeep
    self.sets = sets.filter { $0.sessionId == session.id }.sorted { $0.completedAt == $1.completedAt ? $0.id < $1.id : $0.completedAt < $1.completedAt }
  }
  var slight: Bool { sets.count < 4 }
  var title: String { slight ? "Ended early." : "Well done." }
  func subtitle(_ dates: GymDate) -> String { "\(session.name ?? Readout.noRoutine) · \(dates.subtitle(session.startedAt))" }
  // Each movement once, in the order its first set was logged, with its sets; then each planned movement never begun.
  var performed: [(exerciseId: ID<Exercise>, reading: String)] {
    let logged = SetRow.movements(sets)
    let begun = logged.map { id in
      (exerciseId: id, reading: Readout.target(sets.filter { $0.exerciseId == id }.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) }))
    }
    let unbegun = (session.plan?.entries ?? []).map(\.exerciseId).filter { !logged.contains($0) }.map { (exerciseId: $0, reading: "not started") }
    return begun + unbegun
  }
  @MainActor func loadReview(_ gym: GymModel) async {
    guard !gym.isAnonymous, !readingReview, review == nil else { return }
    readingReview = true; reviewFailed = false; defer { readingReview = false }
    do {
      let data = try await gym.rest.request("/v1/gym/sessions/\(session.id.record)/review")
      try Task.checkCancellation()
      review = try JSONDecoder().decode(WorkoutReview.self, from: data)
    } catch is CancellationError { return }
    catch {
      if Task.isCancelled { return }
      reviewFailed = true
      if !(error is GymRESTFailure), !(error is URLError), !(error is AppFailure) { gym.telemetry.failure("gym_read", kind: "decode") }
    }
  }
}

nonisolated struct WorkoutReview: Decodable, Sendable {
  struct Record: Decodable, Sendable {
    let kind: String
    let exerciseId: String
    let value: Double
    let weightKg: Double
    let reps: Int
    let previous: Double?
    let previousAt: Int64?
    func sentence(_ catalogue: Catalogue, dates: GymDate) -> String? {
      guard let previous, let previousAt, value.isFinite, previous.isFinite, weightKg.isFinite else { return nil }
      let name = catalogue.find(ID(RecordID(exerciseId)))?.name ?? "Movement"
      let past = "past \(Readout.weight(previous)) from \(dates.day(Instant(ms: previousAt), inSentence: true))"
      switch kind {
      case "e1rm": return "\(name) e1RM \(Readout.weight(value)) kg — \(past)."
      case "heaviest": return "\(name) \(Readout.weight(value)) kg × \(reps) — \(past)."
      case "reps-at-weight": return "\(name) \(reps) reps at \(Readout.weight(weightKg)) kg — \(past)."
      default: return nil
      }
    }
  }
  struct Effort: Decodable, Sendable {
    let sets: Int
    let reps: Int
    let weightKg: Double
    var reading: String { "\(sets) × \(reps)" + (weightKg == 0 ? "" : " · \(Readout.weight(weightKg))") }
  }
  struct Planned: Decodable, Sendable {
    struct Target: Decodable, Sendable { let reps: Int?; let weightKg: Double? }
    let sets: [Target]
    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      sets = try container.decodeIfPresent([Target].self, forKey: .sets) ?? []
    }
    enum CodingKeys: String, CodingKey { case sets }
    var scheme: [SetTarget] { sets.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) } }
    var top: Target? { sets.filter { $0.weightKg != nil }.max { $0.weightKg! < $1.weightKg! } ?? sets.first }
  }
  struct Movement: Decodable, Sendable {
    let exerciseId: String
    let now: Effort
    let before: Effort?
    let planned: Planned?
    var source: String { planned?.top != nil ? "Plan" : before != nil ? "Last time" : "Performed" }
    var detail: String {
      if let planned, let top = planned.top {
        let short = top.reps.map { now.reps < $0 } == true && (top.weightKg.map { now.weightKg <= $0 } ?? true)
        return short ? "planned \(Readout.target(planned.scheme)) — did \(now.reading)" : "\(Readout.target(planned.scheme)) → \(now.reading)"
      }
      if let before { return "\(before.reading) → \(now.reading)" }
      return now.reading
    }
  }
  struct Against: Decodable, Sendable {
    let routine: String?
    let movements: [Movement]
    var title: String {
      let sources = Set(movements.map(\.source))
      if sources == ["Plan"] { return "Against plan" }
      if sources == ["Last time"] { return "Against last \(routine ?? "time")" }
      if sources == ["Performed"] { return "Performed" }
      return "Comparison"
    }
  }
  let record: Record?
  let against: Against?
  enum CodingKeys: String, CodingKey { case record, against }
  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    record = try container.decodeIfPresent(Record.self, forKey: .record)
    against = try container.decodeIfPresent(Against.self, forKey: .against)
    if let record {
      guard record.value.isFinite, abs(record.value) <= 9_000,
            record.previous.map({ $0.isFinite && abs($0) <= 9_000 }) ?? true,
            record.weightKg.isFinite, abs(record.weightKg) <= 500, (1...500).contains(record.reps) else {
        throw DecodingError.dataCorruptedError(forKey: .record, in: container, debugDescription: "Invalid record numbers")
      }
    }
    for movement in against?.movements ?? [] {
      for effort in [movement.now, movement.before].compactMap({ $0 }) {
        guard effort.sets > 0, (1...500).contains(effort.reps), effort.weightKg.isFinite, abs(effort.weightKg) <= 500 else {
          throw DecodingError.dataCorruptedError(forKey: .against, in: container, debugDescription: "Invalid effort numbers")
        }
      }
      for target in movement.planned?.sets ?? [] {
        guard target.reps.map({ (1...100).contains($0) }) ?? true,
              target.weightKg.map({ $0.isFinite && abs($0) <= 500 }) ?? true else {
          throw DecodingError.dataCorruptedError(forKey: .against, in: container, debugDescription: "Invalid target numbers")
        }
      }
    }
  }
}

struct WorkoutReceipt: View {
  let gym: GymModel
  @Bindable var receipt: WorkoutReceiptData
  @Environment(\.dismiss) var dismiss
  @Environment(\.dynamicTypeSize) var typeSize
  @ScaledMetric(relativeTo: .headline) private var crownSpace = 22
  @State var discard = false
  // The large receipt has no grabber; its native toolbar holds the outcome and workout options.
  var content: some View {
      List {
        Group {
          Section {
            if typeSize.isAccessibilitySize {
              Text(receipt.title).font(.title.weight(.bold)).foregroundStyle(GymPalette.ink)
                .frame(maxWidth: .infinity).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
            Text(receipt.subtitle(gym.dates)).font(.subheadline).foregroundStyle(GymPalette.inkDim)
              .frame(maxWidth: .infinity).multilineTextAlignment(.center)
              .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            FactTiles(SessionReadout(session: receipt.session, sets: receipt.sets, catalogue: gym.catalogue), ground: .own)
              .listRowInsets(EdgeInsets(top: RoomSpace.inset, leading: 0, bottom: 0, trailing: 0)).listRowBackground(Color.clear)
            if receipt.suggestsKeep {
              Button {
                gym.telemetry.event("gym_setup_step", properties: ["screen": "receipt", "action": "keep"])
                gym.workout.handoff = .keep(receipt.session.id); dismiss()
              } label: {
                HStack(spacing: RoomSpace.related) {
                  Image(systemName: "iphone").accessibilityHidden(true)
                  Text("Only on this phone · ") + Text("Keep it").foregroundStyle(GymPalette.accent)
                }.font(.footnote).foregroundStyle(GymPalette.inkDim).frame(minHeight: RoomSpace.minimumTarget)
              }.buttonStyle(.plain).accessibilityIdentifier("workout-keep")
                .listRowInsets(EdgeInsets(top: 0, leading: RoomSpace.inset, bottom: 0, trailing: 0)).listRowBackground(Color.clear)
            }
          }.listRowSeparator(.hidden)
          if let sentence = receipt.review?.record?.sentence(gym.catalogue, dates: gym.dates) {
            Section {
              VStack(alignment: .leading, spacing: RoomSpace.small) {
                Text("Personal record").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.record)
                Text(sentence).font(.subheadline).foregroundStyle(GymPalette.ink)
              }.accessibilityElement(children: .combine).modifier(RecordArrival())
            }
          }
          Section("Performed") {
            ForEach(receipt.performed, id: \.exerciseId) { movement in
              GymRow(title: gym.catalogue.find(movement.exerciseId)?.name ?? "Movement", trailing: .fact(movement.reading))
            }
          }
          if let against = receipt.review?.against {
            Section(against.title) {
              ForEach(Array(against.movements.enumerated()), id: \.offset) { _, movement in
                GymRow(title: gym.catalogue.find(ID(RecordID(movement.exerciseId)))?.name ?? "Movement",
                            meta: (Set(against.movements.map(\.source)).count > 1 ? "\(movement.source): " : "") + movement.detail)
              }
            }
          }
          if receipt.readingReview { Section { ProgressView().frame(maxWidth: .infinity) } }
          if receipt.reviewFailed {
            Section {
              RoomTransient(message: "The log didn’t answer. The workout is saved.", room: .gym, actionTitle: "Try again",
                            actionIdentifier: "workout-review-retry") {
                gym.telemetry.event("gym_action", properties: ["screen": "receipt", "action": "retry"])
                Task { await receipt.loadReview(gym) }
              }
            }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
          }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).contentMargins(.top, 0, for: .scrollContent)
        .disabled(gym.accountTransition)
  }

  var body: some View {
    NavigationStack {
      content
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .principal) {
            if !typeSize.isAccessibilitySize {
              Text(receipt.title).font(.title.weight(.bold)).foregroundStyle(GymPalette.ink)
                .accessibilityAddTraits(.isHeader)
            }
          }
          if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarTrailing) { options }.sharedBackgroundVisibility(.hidden)
          } else {
            ToolbarItem(placement: .topBarTrailing) { options }
          }
        }.roomBar(.gym)
        .reachBand(onSurface: true) { band }
    }.modifier(GymPage()).presentationDetents([.large]).presentationDragIndicator(.hidden)
      .discardWorkoutQuestion(gym, screen: "workout", isPresented: $discard, sets: receipt.sets.count) {
        guard let result = gym.run(DiscardSession(receipt.session.id)), result.refusal == nil else { return }
        gym.workout.handoff = .detail(nil); dismiss()
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "receipt"]) }
      .task { await receipt.loadReview(gym) }
  }

  var options: some View {
    WorkoutReceiptMenu(enabled: !gym.accountTransition) {
      gym.telemetry.event("gym_action", properties: ["screen": "receipt", "action": "menu"])
    } requestDiscard: {
      guard !gym.accountTransition else { return }
      discard = true
    }.frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget)
  }

  var band: some View {
    VStack(spacing: 12) {
      if GymTransient(gym: gym).shown != nil { GymTransient(gym: gym) }
      Button {
        gym.telemetry.event("gym_action", properties: ["screen": "workout", "action": "share"])
        gym.workout.handoff = .coach
        dismiss()
      } label: {
        HStack(spacing: 8) {
          Image("gym/coach-crown").renderingMode(.original).resizable().scaledToFit()
            .frame(width: crownSpace, height: crownSpace * 24 / 22)
            .frame(width: crownSpace, height: crownSpace).accessibilityHidden(true)
          Text("Share with Coach")
        }.frame(maxWidth: .infinity, minHeight: 22)
      }
        .modifier(RoomSecondaryStyle()).controlSize(.large).buttonBorderShape(.capsule)
        .accessibilityLabel("👑 Share with Coach")
        .accessibilityIdentifier("workout-share-coach")
        .accessibilityHint(gym.sharingNeedsSignIn ? "Sign in to continue" : gym.coachUnavailable ? "Coach is unavailable" : "Opens Coach to review this workout")
        .disabled(gym.coachUnavailable)
      Button {
        gym.telemetry.event("first_run_choice", properties: ["screen": "workout", "action": "close"])
        dismiss()
      } label: { Text("Done").frame(maxWidth: .infinity, minHeight: 22) }
        .modifier(RoomPrimaryStyle(room: .gym)).accessibilityIdentifier("workout-done")
    }.font(.headline).padding(.horizontal, RoomSpace.inset).padding(.top, RoomSpace.inset)
      .disabled(gym.accountTransition)
  }
}

struct WorkoutReceiptMenu: UIViewRepresentable {
  let enabled: Bool
  let opened: () -> Void
  let requestDiscard: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(opened: opened, requestDiscard: requestDiscard) }
  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .system)
    var configuration = UIButton.Configuration.plain()
    if #available(iOS 26.0, *) { configuration = .glass() }
    configuration.cornerStyle = .capsule
    configuration.image = UIImage(systemName: "ellipsis")
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .body)
    configuration.contentInsets = .zero
    button.configuration = configuration
    button.showsMenuAsPrimaryAction = true
    button.accessibilityLabel = "Workout options"
    button.accessibilityIdentifier = "workout-receipt-options"
    button.menu = UIMenu(children: [
      UIAction(title: "Discard workout", image: UIImage(systemName: "trash"), identifier: UIAction.Identifier("workout-discard-receipt"), attributes: .destructive) { [weak coordinator = context.coordinator] _ in
        coordinator?.requestDiscard()
      },
    ])
    button.addAction(UIAction { [weak coordinator = context.coordinator] _ in coordinator?.opened() }, for: .menuActionTriggered)
    return button
  }
  func updateUIView(_ button: UIButton, context: Context) {
    context.coordinator.opened = opened
    context.coordinator.requestDiscard = requestDiscard
    button.isEnabled = enabled
    button.tintColor = UIColor(GymPalette.ink)
  }
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIButton, context: Context) -> CGSize? {
    CGSize(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget)
  }
  @MainActor final class Coordinator {
    var opened: () -> Void
    var requestDiscard: () -> Void
    init(opened: @escaping () -> Void, requestDiscard: @escaping () -> Void) {
      self.opened = opened; self.requestDiscard = requestDiscard
    }
  }
}

// A new record arrives with one gym/record pulse, never a burst; under Reduce Motion it fades in over 200 ms.
struct RecordArrival: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var arrived = false

  func body(content: Content) -> some View {
    Group {
      if reduceMotion {
        content.opacity(arrived ? 1 : 0).roomMotion(arrived)
      } else {
        content.keyframeAnimator(initialValue: 0.0, trigger: arrived) { line, pulse in
          line.scaleEffect(1 + 0.04 * pulse, anchor: .leading).shadow(color: GymPalette.record, radius: 8 * pulse)
        } keyframes: { _ in
          SpringKeyframe(1, duration: 0.25)
          SpringKeyframe(0, duration: 0.45)
        }
      }
    }.onAppear { arrived = true }
  }
}
