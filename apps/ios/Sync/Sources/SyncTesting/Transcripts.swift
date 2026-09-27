import SyncAPI
import SyncCore
import SyncReplica

// protocol/*.jsonl from the client's side (corpus/README.md "protocol/*.jsonl"): each device built from the header;
// every client action performed; every exchange's request checked against the one the device builds, and its answer
// fed back unless lost; every frame applied; and each device's store and ended log checked at the end, the log running
// across a `load` of a restored or cloned store. Server lines are the server runner's.

public enum Transcripts {
  // Where the devices and the transcript disagree; empty when they agree throughout.
  public static func clientDifferences<Device: ClientDevice>(_ lines: [JSON], registry: Registry,
                                                           device makeDevice: (LoadedDevice) throws -> Device) throws -> [String] {
    guard let header = lines.first else { throw VectorError("a transcript starts with its header") }
    let gestures = QueuedIdentities.GestureCount()
    var devices: [String: Device] = [:]
    var contexts: [String: StepContext] = [:]
    for (name, json) in try header.member("devices").asObject().members {
      devices[name] = try makeDevice(try LoadedDevice(json: json, registry: registry))
      let actors = try header["actors"]?[name]?.asArray().map { try $0.asString() } ?? [ClientSteps.actor]
      let queues: JSON = ["ids": header["ids"]?[name] ?? [], "actors": .array(actors.dropFirst().map { .string($0) })]
      contexts[name] = StepContext(identities: try QueuedIdentities(queues, gestures: gestures), actor: try Stamp.Actor(actors[0]))
    }

    var differences: [String] = []
    var endedBeforeLoads: [String: [EngineEvent]] = [:]
    for line in lines.dropFirst() {
      let place = "step \(line["step"]?.jcsText ?? "?")"
      let check = { (answer: JSON, expected: JSON?, what: String) in
        if let expected, answer != expected { differences.append("\(place): \(what) \(answer.jcsText), not \(expected.jcsText)") }
      }
      if line["end"] != nil {
        for (name, device) in devices.sorted(by: { $0.key < $1.key }) {
          check(try device.dump(), line["devices"]?[name], "\(name)'s store is")
          let events = (endedBeforeLoads[name] ?? []) + device.events
          check(.array(events.filter { !$0.isTelemetry }.map(\.json)), line["ended"]?[name], "\(name)'s ended log is")
        }
        continue
      }
      guard let name = try line["device"]?.asString(), var device = devices[name], var context = contexts[name] else { continue }
      let deviceNow = line["deviceNow"] ?? 0
      let perform = { (op: String, parts: JSON.Object) throws -> JSON in
        var step = parts
        step["op"] = .string(op)
        step["deviceNow"] = deviceNow
        return try ClientSteps.perform(.object(step), on: &device, context: &context)
      }
      if let op = try line["do"]?.asString() {
        if op == "load" {
          endedBeforeLoads[name, default: []] += device.events
          device = try makeDevice(try LoadedDevice(json: line.member("args").member("device"), registry: registry))
          check(.null, line["returns"], "load returned")
        } else {
          check(try perform(op, try line.member("args").asObject()), line["returns"], "\(op) returned")
        }
      } else if let http = try line["http"]?.asString() {
        let lost = try line["lost"]?.asBool() ?? false
        let response = try line.member("response")
        switch http {
        case "push":
          check(try perform("push", [:]), line["request"], "push sent")
          if !lost { check(try perform("pushResponse", ["response": response]), line["returns"], "the push answer returned") }
        case "pull":
          let scopes = try line.member("request").member("scopes").asArray().map { try $0.member("scope") }
          check(try perform("pull", ["scopes": .array(scopes)]), line["request"], "pull sent")
          if !lost { check(try perform("pullResponse", ["response": response]), line["returns"], "the pull answer returned") }
        case "hello":
          if !lost { _ = try perform("hello", ["response": response]) }
        case let other:
          throw VectorError("unknown exchange \(other)")
        }
      } else if let frame = line["frame"] {
        check(try perform("frame", ["frame": frame]), line["returns"], "the frame returned")
      }
      devices[name] = device
      contexts[name] = context
    }
    return differences
  }
}
