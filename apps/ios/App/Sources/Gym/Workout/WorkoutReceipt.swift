import SwiftUI
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
  @State var discard = false
  // The receipt opens over the workout's detail at full height only, with no grabber, so the detail's tiles never show
  // beside its own; its title and subtitle head the page above the tiles (03.7).
  var body: some View {
    NavigationStack {
      List {
        Group {
          Section {
            VStack(spacing: RoomSpace.small) {
              Text(receipt.title).font(.title.weight(.bold)).foregroundStyle(GymPalette.ink).accessibilityAddTraits(.isHeader)
              Text(receipt.subtitle(gym.dates)).font(.subheadline).foregroundStyle(GymPalette.inkDim)
            }.frame(maxWidth: .infinity).multilineTextAlignment(.center)
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
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).toolbar(.hidden, for: .navigationBar)
        .reachBand(onSurface: true) { band }
    }.modifier(GymPage()).presentationDetents([.large]).presentationDragIndicator(.hidden)
      .discardWorkoutQuestion(gym, screen: "workout", isPresented: $discard, sets: receipt.sets.count) {
        guard let result = gym.run(DiscardSession(receipt.session.id)), result.refusal == nil else { return }
        gym.workout.handoff = .detail(nil); dismiss()
      }
      .task { await receipt.loadReview(gym) }
  }

  var band: some View {
    VStack(spacing: 10) {
      GymTransient(gym: gym)
      if receipt.reviewFailed {
        RoomTransient(message: "The log didn’t answer. The workout is saved.", room: .gym, actionTitle: "Try again",
                      actionIdentifier: "workout-review-retry") { Task { await receipt.loadReview(gym) } }
      }
      Button(role: .destructive) { discard = true } label: {
        Text("Discard").frame(maxWidth: .infinity, minHeight: 52).contentShape(Rectangle())
      }.buttonStyle(.borderless)
        .accessibilityIdentifier("workout-discard-receipt")
      Button {
        gym.telemetry.event("gym_action", properties: ["screen": "workout", "action": "share"])
        gym.workout.handoff = .coach
        dismiss()
      } label: { Text("👑 Share with Coach").frame(maxWidth: .infinity, minHeight: 32) }
        .modifier(RoomSecondaryStyle()).controlSize(.large).buttonBorderShape(.capsule)
        .accessibilityIdentifier("workout-share-coach")
        .accessibilityHint(gym.sharingNeedsSignIn ? "Sign in to continue" : gym.coachUnavailable ? "Coach is unavailable" : "Opens Coach to review this workout")
        .disabled(gym.coachUnavailable)
      Button {
        gym.telemetry.event("first_run_choice", properties: ["screen": "workout", "action": "close"])
        dismiss()
      } label: { Text("Done").frame(maxWidth: .infinity, minHeight: 32) }
        .modifier(RoomPrimaryStyle(room: .gym)).accessibilityIdentifier("workout-done")
    }.font(.headline).padding(RoomSpace.inset).disabled(gym.accountTransition)
      .roomMotion(receipt.reviewFailed)
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
