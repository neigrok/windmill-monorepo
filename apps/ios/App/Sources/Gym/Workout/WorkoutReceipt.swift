import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncCore

@Observable nonisolated final class WorkoutReceiptData {
  let session: Session
  let sets: [TrainingSet]
  var routine: Draft<Routine>
  var keptName: String?
  var saving = false
  var failure: String?
  var review: WorkoutReview?
  var reviewFailed = false
  var readingReview = false
  @ObservationIgnored var refusedNoticeId: String?
  init(session: Session, sets: [TrainingSet], routineId: ID<Routine>, routinePosition: Int) {
    self.session = session
    self.sets = sets.filter { $0.sessionId == session.id }.sorted { $0.completedAt == $1.completedAt ? $0.id < $1.id : $0.completedAt < $1.completedAt }
    var ids: [ID<Exercise>] = []
    for set in self.sets where set.kind == "working" && !ids.contains(set.exerciseId) { ids.append(set.exerciseId) }
    let retained = self.sets
    let entries = ids.map { id in
      RoutineEntry(exerciseId: id, sets: retained.filter { $0.exerciseId == id && $0.kind == "working" }.map {
        SetTarget(reps: $0.reps, weightKg: $0.weightKg)
      })
    }
    let name = session.startedAt.date.formatted(.dateTime.weekday(.wide))
    routine = Draft(new: Routine(id: routineId, name: name, position: routinePosition, entries: entries))
  }
  var readout: SessionReadout { SessionReadout(session: session, sets: sets) }
  var slight: Bool { readout.workingSetCount < 4 }
  var offersRoutine: Bool { session.routineId == nil && !slight }
  var nameRefusal: String? {
    if routine.current.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Name it to save it." }
    if routine.current.name.precomposedStringWithCanonicalMapping.unicodeScalars.count > 60 { return "Use 60 characters or fewer." }
    return nil
  }
  @MainActor @discardableResult func saveRoutine(_ gym: GymModel) -> Bool {
    guard offersRoutine, keptName == nil, !saving, nameRefusal == nil else { return false }
    saving = true; failure = nil; defer { saving = false }
    guard case .saved = gym.save(&routine) else { failure = gym.error ?? "The routine wasn’t saved. Try again."; return false }
    keptName = routine.current.name
    gym.telemetry.event("gym_routine_saved", properties: ["screen": "workout", "outcome": "ok"])
    return true
  }
  @MainActor func reconcile(_ gym: GymModel) {
    guard let notice = gym.notices.last(where: { $0.subject == routine.current.id.ref }),
          notice.id != refusedNoticeId else { return }
    refusedNoticeId = notice.id
    keptName = nil
    routine = Draft(new: routine.current)
    failure = gym.message(notice.refusal)
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
    func sentence(_ catalogue: Catalogue) -> String? {
      guard let previous, let previousAt, value.isFinite, previous.isFinite, weightKg.isFinite else { return nil }
      let name = catalogue.find(ID(RecordID(exerciseId)))?.name ?? "Movement"
      let past = "past \(Readout.weight(previous)) from \(Instant(ms: previousAt).date.formatted(date: .abbreviated, time: .omitted))"
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
  var body: some View {
    NavigationStack {
      List {
        Group {
          Section {
            Text(receipt.slight ? "Ended early." : "Well done.").font(.title2.weight(.bold))
            HStack {
              fact("Sets", "\(receipt.readout.workingSetCount)")
              fact("kg", Readout.weight(receipt.readout.volumeKg))
              fact("Movements", "\(receipt.readout.movementCount)")
            }
            if let duration = receipt.readout.durationMs { Text(Readout.duration(duration)).font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
          }
          Section("Performed") {
            let ids = receipt.sets.reduce(into: [ID<Exercise>]()) { result, set in if !result.contains(set.exerciseId) { result.append(set.exerciseId) } }
            ForEach(ids, id: \.self) { id in
              VStack(alignment: .leading, spacing: 6) {
                Text(gym.catalogue.find(id)?.name ?? "Movement").font(.body.weight(.semibold))
                let working = receipt.sets.filter { $0.exerciseId == id && $0.kind == "working" }
                if !working.isEmpty { Text(Readout.target(working.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) })).font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
                ForEach(receipt.sets.filter { $0.exerciseId == id }, id: \.id) { set in
                  Text("\(set.kind == "warmup" ? "W · " : "")\(Readout.weight(set.weightKg)) kg × \(set.reps)").font(.subheadline.monospacedDigit())
                }
              }
            }
          }
          if let sentence = receipt.review?.record?.sentence(gym.catalogue) {
            Section("Personal record") { Text(sentence).font(.body.weight(.semibold)).foregroundStyle(GymPalette.record) }
          }
          if let against = receipt.review?.against {
            Section(against.title) {
              ForEach(Array(against.movements.enumerated()), id: \.offset) { _, movement in
                VStack(alignment: .leading, spacing: 4) {
                  Text(gym.catalogue.find(ID(RecordID(movement.exerciseId)))?.name ?? "Movement")
                  Text((Set(against.movements.map(\.source)).count > 1 ? "\(movement.source): " : "") + movement.detail)
                    .font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
                }
              }
            }
          }
          if receipt.readingReview { Section { ProgressView("Reading the log…") } }
          if receipt.reviewFailed { Section { Text("the log didn’t answer — the session is saved"); Button("Try again") { Task { await receipt.loadReview(gym) } } } }
          if gym.isAnonymous {
            Section { Button("Keep this log") { gym.workout.handoff = .keep; dismiss() }.modifier(RoomPrimaryStyle(accent: GymPalette.accent, onAccent: GymPalette.onAccent)).foregroundStyle(GymPalette.onAccent) } footer: { Text("This log is only on this phone.") }
          } else if gym.workout.coachAvailable && !gym.authPaused {
            Section {
              Button("Share with Coach") { gym.workout.handoff = .coach; dismiss() }
                .modifier(RoomPrimaryStyle(accent: GymPalette.accent, onAccent: GymPalette.onAccent)).foregroundStyle(GymPalette.onAccent).disabled(gym.accountTransition).accessibilityIdentifier("workout-share-coach")
            } footer: { Text("Sends Coach one line — “Check my last session.” — and opens the answer.") }
          }
          if receipt.offersRoutine {
            Section("Save as routine") {
              if let name = receipt.keptName { Text("Kept as \(name).").accessibilityIdentifier("workout-routine-kept") }
              else {
                TextField("Routine name", text: $receipt.routine.current.name).accessibilityIdentifier("workout-routine-name")
                Button(receipt.saving ? "Saving…" : "Save as routine") { _ = receipt.saveRoutine(gym) }
                  .disabled(receipt.nameRefusal != nil || receipt.saving || gym.accountTransition).accessibilityIdentifier("workout-save-routine")
                if !receipt.saving, let refusal = receipt.nameRefusal { Text(refusal).font(.footnote) }
                if let failure = receipt.failure { Text(failure).font(.footnote).accessibilityIdentifier("workout-routine-failure") }
              }
            }
          }
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage()).navigationTitle(receipt.session.name ?? Readout.noRoutine).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }.modifier(GymPage()).presentationDetents([.large])
      .sensoryFeedback(.success, trigger: receipt.keptName) { old, new in old == nil && new != nil }
      .task { await receipt.loadReview(gym) }
      .onAppear { receipt.reconcile(gym) }
      .onChange(of: gym.notices.map(\.id)) { _, _ in receipt.reconcile(gym) }
  }
  func fact(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(value).font(.title3.monospacedDigit().weight(.semibold)).minimumScaleFactor(0.5)
      Text(label).font(.caption).foregroundStyle(GymPalette.inkDim)
    }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
  }
}
