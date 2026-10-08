import Foundation
import Observation
import SwiftUI
import UIKit
import DomainKit
import GymDomain

nonisolated struct SessionPublicLink: Codable, Equatable, Sendable {
  let token: String
  var url: String? = nil
  let expiresAt: Int64

  func link(base: String) -> String {
    if let url, !url.isEmpty { return url }
    return "\(base.hasSuffix("/") ? String(base.dropLast()) : base)/#/gym/shared/\(token)"
  }
}

nonisolated enum SessionShareState: Equatable, Sendable {
  case closed(note: String? = nil)
  case working
  case live(SessionPublicLink, copied: Bool = false, note: String? = nil)
  case revoked

  var title: String {
    switch self {
    case .closed, .working: "Share this workout"
    case .live: "The link is live"
    case .revoked: "The link is dead"
    }
  }

  var action: String {
    switch self {
    case .closed(let note): note == nil ? "Get a link" : "Try again"
    case .working: "…"
    case .live(_, let copied, _): copied ? "Copied" : "Copy link"
    case .revoked: "Get a link"
    }
  }

  var note: String? {
    switch self {
    case .closed(let note), .live(_, _, let note): note
    case .working, .revoked: nil
    }
  }

  func body(expiry: String = "") -> String {
    switch self {
    case .closed, .working:
      "Anyone with the link can read this workout.\nIncludes set notes and effort.\nLinks last 30 days. End sharing anytime."
    case .live:
      "Anyone who has this link can read this one workout. It stops working on \(expiry), and revoking it kills it immediately."
    case .revoked:
      "Anyone still holding it gets nothing. You can make a new one whenever you like."
    }
  }
}

@Observable @MainActor final class SessionShareModel {
  var state: SessionShareState = .closed()
  @ObservationIgnored var task: Task<Void, Never>?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var previous: SessionShareState?
  private let mint: () async throws -> SessionPublicLink
  private let revoke: () async throws -> Void

  init(mint: @escaping () async throws -> SessionPublicLink, revoke: @escaping () async throws -> Void) {
    self.mint = mint; self.revoke = revoke
  }

  @discardableResult func getLink() -> Task<Void, Never>? {
    guard state != .working else { return nil }
    let standing = state
    previous = standing; state = .working; generation += 1
    let request = generation, mint = mint
    let pending = Task { [weak self] in
      do {
        let share = try await mint()
        try Task.checkCancellation()
        guard let self, self.generation == request else { return }
        self.state = .live(share); self.task = nil; self.previous = nil
      } catch {
        guard let self, self.generation == request else { return }
        self.state = Self.isCancellation(error) ? standing : .closed(note: Self.message(error, revoking: false))
        self.task = nil; self.previous = nil
      }
    }
    task = pending; return pending
  }

  func copied() {
    guard case .live(let share, _, let note) = state else { return }
    state = .live(share, copied: true, note: note)
  }

  @discardableResult func revokeLink() -> Task<Void, Never>? {
    guard case .live(let share, _, _) = state else { return nil }
    let standing = state
    previous = standing; state = .working; generation += 1
    let request = generation, revoke = revoke
    let pending = Task { [weak self] in
      do {
        try await revoke()
        try Task.checkCancellation()
        guard let self, self.generation == request else { return }
        self.state = .revoked; self.task = nil; self.previous = nil
      } catch {
        guard let self, self.generation == request else { return }
        self.state = Self.isCancellation(error) ? standing : .live(share, note: Self.message(error, revoking: true))
        self.task = nil; self.previous = nil
      }
    }
    task = pending; return pending
  }

  func cancel() {
    generation += 1; task?.cancel(); task = nil
    if let previous { state = previous }
    previous = nil
  }

  func accountChanged() {
    cancel(); state = .closed(note: "sharing needs your account — sign in first")
  }

  static func isCancellation(_ error: any Error) -> Bool {
    error is CancellationError || (error as? URLError)?.code == .cancelled
  }

  static func message(_ error: any Error, revoking: Bool) -> String {
    if let error = error as? GymRESTFailure { return error.message }
    if let error = error as? AppFailure { return error.message }
    return "the log didn’t answer — \(revoking ? "the link is still live" : "the link wasn’t made")"
  }
}

extension GymModel {
  func mintSessionShare(_ id: ID<Session>) async throws -> SessionPublicLink {
    do {
      guard !accountTransition else { throw AppFailure(message: "Wait for the account change to finish.") }
      guard !isAnonymous, let owner = account, !authPaused else {
        throw AppFailure(message: "sharing needs your account — sign in first")
      }
      let data = try await rest.request("/v1/gym/sessions/\(id)/share", method: "POST")
      try Task.checkCancellation()
      guard account == owner, !accountTransition, !authPaused else { throw CancellationError() }
      let share: SessionPublicLink
      do { share = try JSONDecoder().decode(SessionPublicLink.self, from: data) }
      catch {
        telemetry.event("api_request_failed", properties: ["method": "POST", "route": "/v1/gym", "operation": "gym_rest", "failure_kind": "decode"])
        telemetry.failure("gym_rest", kind: "decode")
        throw error
      }
      telemetry.event("gym_action", properties: ["screen": "session_share", "outcome": "ok"])
      return share
    } catch {
      if !SessionShareModel.isCancellation(error) {
        telemetry.event("gym_action", properties: ["screen": "session_share", "outcome": error is AppFailure || error is GymRESTFailure ? "refused" : "failed"])
      }
      throw error
    }
  }

  func revokeSessionShare(_ id: ID<Session>) async throws {
    do {
      guard !accountTransition else { throw AppFailure(message: "Wait for the account change to finish.") }
      guard !isAnonymous, let owner = account, !authPaused else {
        throw AppFailure(message: "sharing needs your account — sign in first")
      }
      _ = try await rest.request("/v1/gym/sessions/\(id)/share", method: "DELETE")
      try Task.checkCancellation()
      guard account == owner, !accountTransition, !authPaused else { throw CancellationError() }
      telemetry.event("gym_action", properties: ["screen": "session_share", "outcome": "ok"])
    } catch {
      if !SessionShareModel.isCancellation(error) {
        telemetry.event("gym_action", properties: ["screen": "session_share", "outcome": error is AppFailure || error is GymRESTFailure ? "refused" : "failed"])
      }
      throw error
    }
  }
}

struct SessionShareSheet: View {
  let gym: GymModel
  let sessionID: ID<Session>
  @Environment(\.dismiss) private var dismiss
  @State private var owner: String?
  @State private var sharing: SessionShareModel

  init(gym: GymModel, sessionID: ID<Session>) {
    self.gym = gym; self.sessionID = sessionID
    _owner = State(initialValue: gym.account)
    _sharing = State(initialValue: SessionShareModel(mint: { try await gym.mintSessionShare(sessionID) },
                                                    revoke: { try await gym.revokeSessionShare(sessionID) }))
  }

  var base: String { gym.runtime?.settings.baseURL?.absoluteString ?? "https://windmill.works" }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text(sharing.state.body(expiry: expiry)).font(.body).foregroundStyle(GymPalette.inkDim)
          if case .live(let share, _, _) = sharing.state {
            Text(share.link(base: base))
              .font(.footnote.monospacedDigit()).foregroundStyle(GymPalette.accent)
              .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
              .padding().background(GymPalette.card, in: RoundedRectangle(cornerRadius: 12))
              .accessibilityIdentifier("gym-share-link")
          }
          if let note = sharing.state.note {
            Text(note).font(.body).foregroundStyle(GymPalette.alarm)
              .accessibilityIdentifier("gym-share-error")
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding()
      }
      .modifier(GymPage())
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 12) {
          Button {
            if case .live(let share, _, _) = sharing.state {
              guard gym.account == owner, !gym.accountTransition, !gym.authPaused else { sharing.accountChanged(); return }
              UIPasteboard.general.string = share.link(base: base); sharing.copied()
              gym.telemetry.event("gym_action", properties: ["screen": "session_share", "outcome": "ok"])
            } else { owner = gym.account; sharing.getLink() }
          } label: {
            Group {
              if sharing.state == .working { ProgressView().accessibilityLabel("Working") }
              else { Text(sharing.state.action).font(.body.weight(.semibold)) }
            }.frame(maxWidth: .infinity, minHeight: 44)
          }
          .modifier(RoomPrimaryStyle(accent: GymPalette.accent, onAccent: GymPalette.onAccent)).controlSize(.large).tint(GymPalette.accent).foregroundStyle(GymPalette.onAccent)
          .disabled(sharing.state == .working).accessibilityIdentifier("gym-share-primary")
          if case .live = sharing.state {
            Button("Revoke the link", role: .destructive) { sharing.revokeLink() }
              .font(.body).foregroundStyle(GymPalette.alarm).frame(minHeight: 44)
              .accessibilityIdentifier("gym-share-revoke")
          }
        }.padding().background(GymPalette.canvas)
      }
      .navigationTitle(sharing.state.title).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "session_share"]) }
      .onDisappear { sharing.cancel() }
      .onChange(of: gym.account) { _, _ in sharing.accountChanged() }
      .onChange(of: gym.accountTransition) { _, changing in if changing { sharing.accountChanged() } }
      .onChange(of: gym.authPaused) { _, paused in if paused { sharing.accountChanged() } }
    }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
  }

  var expiry: String {
    guard case .live(let share, _, _) = sharing.state else { return "" }
    return LogPresentation.brief(LogPresentation.date(Instant(ms: share.expiresAt)))
  }
}
