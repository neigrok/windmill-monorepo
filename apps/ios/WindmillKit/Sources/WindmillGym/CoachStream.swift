import Foundation
import WindmillPlatform

protocol CoachServing {
    func streamCoach(_ request: CoachRequest,
                     receive: @escaping @MainActor (CoachGeneration) throws -> Void) async throws -> CoachGeneration
    func stopCoach(_ request: CoachRequest) async throws -> CoachGeneration
    func thread(_ id: String, before: String?) async throws -> AskThread?
    func uploadCoachPhoto(_ photo: CoachPhotoDraft, data: Data, thread: String,
                          progress: @escaping @Sendable (Double) -> Void) async throws -> CoachAttachment
    func coachPhoto(_ id: String, thread: String) async throws -> Data
}

enum CoachStreamEvent: Equatable {
    case snapshot(thread: String, generation: CoachGeneration)
    case refusal(AskRefusal, generation: CoachGeneration?)
}

struct CoachStreamParser {
    private var name = ""
    private var data: [String] = []
    private var bytes = 0

    mutating func consume(_ line: String) throws -> CoachStreamEvent? {
        guard !line.isEmpty else {
            defer { name = ""; data = []; bytes = 0 }
            guard !data.isEmpty else { return nil }
            let payload = Data(data.joined(separator: "\n").utf8)
            if name == "snapshot" {
                struct Snapshot: Decodable { let thread: String; let generation: CoachGeneration }
                let value = try JSONDecoder().decode(Snapshot.self, from: payload)
                return .snapshot(thread: value.thread, generation: value.generation)
            }
            if name == "error" {
                struct Failure: Decodable {
                    let error: String
                    let code: String?
                    let generation: CoachGeneration?
                }
                let value = try JSONDecoder().decode(Failure.self, from: payload)
                let ceiling: AskCeiling? = value.code == "ask-daily-limit" ? .daily
                    : value.code == "ask-out-of-budget" ? .account : nil
                return .refusal(AskRefusal(line: value.error, mayRetry: true, ceiling: ceiling,
                    needsPhotoUpload: value.code == "ask-attachment-invalid"), generation: value.generation)
            }
            return nil
        }
        if line.hasPrefix(":") { return nil }
        let fields = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(fields[0])
        let raw = fields.count == 2 ? String(fields[1]) : ""
        let value = raw.hasPrefix(" ") ? String(raw.dropFirst()) : raw
        if field == "event" { name = value }
        if field == "data" {
            bytes += value.utf8.count
            guard bytes <= 1_048_576 else { throw WindmillApiError.malformed }
            data.append(value)
        }
        return nil
    }
}
