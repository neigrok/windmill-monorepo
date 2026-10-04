import Foundation
import Testing
@testable import Windmill

@MainActor struct OnboardingTelemetryTests {
  let metadata = TelemetryMetadata(info: ["CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "1",
                                          "WMSourceRevision": "local", "WMTelemetryEnvironment": "test"])

  @Test func onboardingNamesAreAllowlistedAndUnknownNamesAreRejected() async throws {
    let names: Set<String> = ["onboarding_screen_viewed", "onboarding_skipped", "onboarding_finished", "onboarding_replayed"]
    #expect(TelemetryPrivacy.events.filter { $0.hasPrefix("onboarding_") } == names)
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "events.json"), delivery = TelemetryDelivery()
    let queue = EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: metadata,
                           credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in }, deliver: delivery.send)
    await queue.record("onboarding_private_marker", properties: ["page": .label("windmill")], account: nil)
    #expect(await queue.state.events.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: file.path))
    #expect(delivery.state.withLock { $0.requests.isEmpty })
  }

  @Test func onboardingLabelsPreserveOnlyBoundedPageAndPresentation() throws {
    for page in ["windmill", "roadmap", "journal", "gym"] {
      for presentation in ["first_launch", "replay"] {
        let filtered = TelemetryPrivacy.properties(["page": page, "presentation": presentation,
                                                    "text": "private-marker", "email": "private-marker",
                                                    "mood": "8", "energy": "2", "picture": "private-marker"])
        #expect(filtered == ["page": .label(page), "presentation": .label(presentation)])
        #expect(!String(decoding: try JSONEncoder().encode(filtered), as: UTF8.self).contains("private-marker"))
      }
    }
    #expect(TelemetryPrivacy.properties(["page": "private-marker", "presentation": "private-marker", "onboarding": "replay"]).isEmpty)
    #expect(TelemetryPrivacy.properties(["page": "5", "presentation": "signed_in"]).isEmpty)
  }

  @Test func restoredIntroductionEventsKeepIdsAndFilterContentBeforeDelivery() async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "events.json"), delivery = TelemetryDelivery()
    var stored = EventQueue.State()
    stored.events = [
      EventQueue.Item(id: UUID().uuidString, name: "onboarding_screen_viewed", clientMs: 1,
                      props: ["page": .label("roadmap"), "presentation": .label("first_launch"), "text": .label("private-marker")], account: nil),
      EventQueue.Item(id: UUID().uuidString, name: "onboarding_skipped", clientMs: 2,
                      props: ["page": .label("journal"), "presentation": .label("first_launch"), "mood": .number(8)], account: nil),
      EventQueue.Item(id: UUID().uuidString, name: "onboarding_finished", clientMs: 3,
                      props: ["page": .label("gym"), "presentation": .label("replay"), "energy": .number(2)], account: nil),
      EventQueue.Item(id: UUID().uuidString, name: "onboarding_replayed", clientMs: 4,
                      props: ["presentation": .label("replay"), "page": .label("private-marker"), "email": .label("private-marker")], account: nil)
    ]
    let bytes = try JSONEncoder().encode(stored)
    let queue = EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: metadata,
                           credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in }, deliver: delivery.send,
                           load: { _ in bytes })
    await queue.flush()
    let body = try #require(delivery.state.withLock { $0.requests.first?.httpBody })
    let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    let events = try #require(json["events"] as? [[String: Any]])
    #expect(events.compactMap { $0["id"] as? String } == stored.events.map(\.id))
    #expect(events.compactMap { $0["name"] as? String } == stored.events.map(\.name))
    let expected: [[String: EventValue]] = [
      ["page": .label("roadmap"), "presentation": .label("first_launch")],
      ["page": .label("journal"), "presentation": .label("first_launch")],
      ["page": .label("gym"), "presentation": .label("replay")],
      ["presentation": .label("replay")]
    ]
    for (event, properties) in zip(events, expected) {
      let props = try #require(event["props"] as? [String: Any])
      let actual = try JSONDecoder().decode([String: EventValue].self, from: JSONSerialization.data(withJSONObject: props))
      #expect(actual == properties.merging(metadata.properties) { _, new in new })
    }
    #expect(!String(decoding: body, as: UTF8.self).contains("private-marker"))
    #expect(await queue.state.events.isEmpty)
  }

  @Test func failedDeliveryPersistsFilteredIntroductionAndRelaunchRetainsId() async throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appending(path: "events.json"), delivery = TelemetryDelivery()
    delivery.state.withLock { $0.statuses = [503] }
    let first = EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: metadata,
                           credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in }, deliver: delivery.send)
    await first.record("onboarding_finished", properties: ["page": .label("gym"), "presentation": .label("first_launch"),
                                                           "text": .label("private-marker")], account: nil)
    let stored = try JSONDecoder().decode(EventQueue.State.self, from: Data(contentsOf: file))
    #expect(stored.events.count == 1)
    #expect(stored.events.first?.props == ["page": .label("gym"), "presentation": .label("first_launch")].merging(metadata.properties) { _, new in new })
    let restored = EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: metadata,
                              credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in }, deliver: delivery.send)
    await restored.flush()
    let bodies = delivery.state.withLock { $0.requests.compactMap(\.httpBody) }
    #expect(bodies.count == 2)
    for body in bodies {
      let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
      let events = try #require(json["events"] as? [[String: Any]])
      #expect(events.compactMap { $0["id"] as? String } == stored.events.map(\.id))
      #expect(!String(decoding: body, as: UTF8.self).contains("private-marker"))
    }
    #expect(await restored.state.events.isEmpty)
  }
}
