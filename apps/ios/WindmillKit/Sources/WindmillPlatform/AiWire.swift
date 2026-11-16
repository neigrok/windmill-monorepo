import Foundation
import Agent
import SyncCore

enum AiWire {
  static func fields(_ value: JSON, _ names: String) throws -> JSON.Object {
    let object = try value.asObject()
    guard Set(object.keys) == Set(names.split(separator: " ").map(String.init)) else { throw AiTransportFailure.invalidResponse }
    return object
  }

  static func integer(_ value: JSON, minimum: Int64 = 0, nullable: Bool = false) throws {
    if nullable && value == .null { return }
    guard try value.asInteger() >= minimum else { throw AiTransportFailure.invalidResponse }
  }

  static func money(_ value: JSON, nullable: Bool = false) throws -> Int64 {
    if nullable && value == .null { return 0 }
    let text = try value.asString()
    let pieces = text.split(separator: ".", omittingEmptySubsequences: false)
    guard (1...2).contains(pieces.count), let whole = pieces.first, !whole.isEmpty,
          whole == "0" || whole.first != "0", whole.utf8.allSatisfy({ (48...57).contains($0) }),
          let dollars = Int64(whole), dollars <= Int64.max / 1_000_000_000 else { throw AiTransportFailure.invalidResponse }
    let fraction = pieces.count == 2 ? pieces[1] : ""
    guard pieces.count == 1 || (1...9).contains(fraction.count), fraction.utf8.allSatisfy({ (48...57).contains($0) }) else { throw AiTransportFailure.invalidResponse }
    let nanos = Int64(fraction + String(repeating: "0", count: 9 - fraction.count))!
    let (amount, overflow) = (dollars * 1_000_000_000).addingReportingOverflow(nanos)
    guard !overflow else { throw AiTransportFailure.invalidResponse }
    return amount
  }

  static func allowance(_ value: JSON, nullable: Bool = false) throws {
    if nullable && value == .null { return }
    let object = try fields(value, "tier period limit used reserved remaining resetsAt budgetResetsAt code capabilities")
    let tier = try object.member("tier").asString()
    let period = try object.member("period").asString()
    guard ["anonymous", "free", "one"].contains(tier), ["lifetime", "calendar_month_utc", "billing_period"].contains(period),
          tier != "anonymous" || period == "lifetime", tier != "free" || period == "calendar_month_utc" else { throw AiTransportFailure.invalidResponse }
    let limit = try money(object.member("limit"))
    let used = try money(object.member("used"))
    let reserved = try money(object.member("reserved"))
    guard try money(object.member("remaining")) == max(0, max(0, limit - used) - reserved) else { throw AiTransportFailure.invalidResponse }
    try integer(object.member("resetsAt"), nullable: true)
    try integer(object.member("budgetResetsAt"), nullable: true)
    let code = try object.member("code").asString()
    guard (object["resetsAt"] == .null) == (period == "lifetime"),
          ["ok", "device_bound", "subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted"].contains(code),
          ["subject_exhausted", "free_month_exhausted", "free_day_exhausted"].contains(code) || object["budgetResetsAt"] == .null else { throw AiTransportFailure.invalidResponse }
    let capabilities = try fields(object.member("capabilities"), "text transcription")
    let text = try fields(capabilities.member("text"), "large medium small")
    for member in text.members { guard try ["large", "medium", "small"].contains(member.value.asString()) else { throw AiTransportFailure.invalidResponse } }
    guard try capabilities.member("transcription").asBool() == (tier == "one") else { throw AiTransportFailure.invalidResponse }
  }

  static func tool(_ value: JSON) throws {
    let object = try fields(value, "id name input")
    let name = try object.member("name").asString()
    guard try !object.member("id").asString().isEmpty, (1...64).contains(name.utf8.count),
          name.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { throw AiTransportFailure.invalidResponse }
    _ = try object.member("input").asObject()
  }

  static func parts(_ value: JSON) throws {
    for part in try value.asArray() {
      let object = try part.asObject()
      guard object.count == 1 else { throw AiTransportFailure.invalidResponse }
      if let text = object["text"] { _ = try text.asString() }
      else if let call = object["toolCall"] { try tool(call) }
      else if let image = object["image"] {
        if let picture = try image.asObject()["picture"] {
          _ = try fields(image, "picture")
          guard try ServiceAiClient.validID(picture.asString()) else { throw AiTransportFailure.invalidResponse }
        } else {
          let image = try fields(image, "mediaType data")
          let media = try image.member("mediaType").asString()
          guard ["image/png", "image/jpeg"].contains(media), let bytes = try Data(base64Encoded: image.member("data").asString()),
                bytes.starts(with: media == "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255]) else { throw AiTransportFailure.invalidResponse }
        }
      } else { throw AiTransportFailure.invalidResponse }
    }
  }

  static func event(_ event: AiEvent, callID: String? = nil) throws {
    guard event.id > 0 else { throw AiTransportFailure.invalidResponse }
    switch event.name {
    case "started":
      let value = try fields(event.data, "callId served maxTokens")
      let id = try value.member("callId").asString()
      guard ServiceAiClient.validID(id), callID == nil || id == callID,
            try ["large", "medium", "small"].contains(value.member("served").asString()) else { throw AiTransportFailure.invalidResponse }
      try integer(value.member("maxTokens"), minimum: 1)
    case "text": _ = try fields(event.data, "delta").member("delta").asString()
    case "toolCall": try tool(event.data)
    case "ended", "failed":
      let value = try fields(event.data, event.name == "ended" ? "stop message charged allowance" : "code charged allowance")
      _ = try money(value.member("charged"), nullable: true)
      try allowance(value.member("allowance"), nullable: true)
      if event.name == "failed" {
        guard try ["provider_rejected", "provider_unavailable", "provider_failed", "accounting_unavailable"].contains(value.member("code").asString()) else { throw AiTransportFailure.invalidResponse }
      } else {
        guard try ["completed", "tool_calls", "truncated", "declined"].contains(value.member("stop").asString()) else { throw AiTransportFailure.invalidResponse }
        let message = try fields(value.member("message"), "role parts carry")
        guard try message.member("role").asString() == "assistant" else { throw AiTransportFailure.invalidResponse }
        _ = try message.member("carry").asString()
        try parts(message.member("parts"))
      }
    default: throw AiTransportFailure.invalidResponse
    }
  }

  static let refusalStatus: [String: Int] = [
    "invalid_request": 400, "provider_rejected": 400, "pass_missing": 401, "pass_signature": 401,
    "pass_audience": 401, "pass_malformed": 401, "pass_expired": 401, "funding_required": 403,
    "device_bound": 403, "call_unknown": 404, "conflict": 409, "result_gone": 410, "picture_gone": 410,
    "too_large": 413, "subject_exhausted": 429, "free_month_exhausted": 429, "free_day_exhausted": 429,
    "concurrency_exhausted": 429, "rate_limited": 429, "busy": 503, "paused": 503,
    "accounting_unavailable": 503, "provider_unavailable": 503,
  ]
  static let passStatus: [String: Int] = [
    "invalid_request": 400, "unauthenticated": 401, "invalid_installation": 401, "device_bound": 409,
    "client-update-required": 426, "anonymous_ai_unavailable": 503, "rate_limited": 429,
    "unavailable": 503, "untrusted-origin": 403, "unsupported-media-type": 415,
  ]
}
