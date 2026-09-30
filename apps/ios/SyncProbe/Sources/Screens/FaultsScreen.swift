import Foundation
import SwiftUI

struct FaultsScreen: View {
  let probe: Probe
  @State private var offline: Bool
  @State private var skewMinutes: Int
  @State private var lastFault = "No fault injected"

  init(probe: Probe) {
    self.probe = probe
    _offline = State(initialValue: probe.transport.isOffline)
    _skewMinutes = State(initialValue: Int(probe.clock.skewMs / 60_000))
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Last fault") { Text(verbatim: lastFault) }
        Section("Network") {
          Toggle("Offline", isOn: $offline)
          Button("Answer the next call 401") { refuseNext(401) }
          Button("Answer the next call 503") { refuseNext(503) }
        }
        Section("Device clock") {
          Stepper("Skew \(skewMinutes) min", value: $skewMinutes, in: -1_440...1_440)
          Button("Jump 1 h ahead") { skewMinutes += 60 }
          Button("Jump 1 h back") { skewMinutes -= 60 }
          TimelineView(.periodic(from: .now, by: 1)) { _ in
            LabeledContent("Reads", value: Date(timeIntervalSince1970: Double(probe.clock.nowMs()) / 1000).formatted(date: .abbreviated, time: .standard))
          }
        }
        Section {
          Button("Die now, with no cleanup", role: .destructive) { exit(0) }
        }
      }
      .onChange(of: offline) {
        probe.transport.setOffline(offline)
        lastFault = offline ? "Offline: no call reaches the server" : "Online again"
      }
      .onChange(of: skewMinutes) {
        probe.clock.setSkew(ms: Int64(skewMinutes) * 60_000)
        lastFault = "The device clock reads \(skewMinutes) min off"
      }
      .navigationTitle("Faults")
    }
  }

  func refuseNext(_ status: Int) {
    probe.transport.refuseNext(status)
    lastFault = "The next call is answered \(status) without reaching the server"
  }
}
