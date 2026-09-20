import XCTest
import UIKit
import ImageIO
import WindmillPlatform
@testable import WindmillGym

final class CoachStreamTests: XCTestCase {
    func testSSEHandlesCommentsMultipleDataLinesAndAuthoritativeRevisions() throws {
        var parser = CoachStreamParser()
        XCTAssertNil(try parser.consume(": heartbeat"))
        XCTAssertNil(try parser.consume(""))
        var conversation = AskConversation(threadId: "thread_one")
        for (revision, text, status) in [(1, "First", "running"), (2, "First and second", "running"),
                                         (1, "stale", "running"), (3, "First and second.", "stopped")] {
            let data = """
            {"thread":"thread_one","generation":{"id":"generation_one","requestId":"request_one","question":"help",
            "status":"\(status)","answer":"\(text)","at":1,"steps":[],"results":[],"revision":\(revision)}}
            """
            XCTAssertNil(try parser.consume("event: snapshot"))
            XCTAssertNil(try parser.consume("id: generation_one:\(revision)"))
            for line in data.components(separatedBy: "\n") { XCTAssertNil(try parser.consume("data: \(line)")) }
            guard case .snapshot(let thread, let generation) = try parser.consume("") else { return XCTFail("Expected snapshot") }
            XCTAssertEqual(thread, "thread_one")
            conversation.accept(generation)
        }
        XCTAssertEqual(conversation.exchanges.count, 1)
        XCTAssertEqual(conversation.exchanges[0].snapshot?.answer, "First and second.")
        XCTAssertEqual(conversation.exchanges[0].revision, 3)
        XCTAssertEqual(conversation.exchanges[0].outcome, .refused(AskRefusal(line: "Response stopped.")))
        XCTAssertNil(conversation.unresolved)
    }

    func testSSERefusalRetainsPartialResultAndCeiling() throws {
        var parser = CoachStreamParser()
        _ = try parser.consume("event: error")
        _ = try parser.consume("data: " + #"{"error":"Allowance reached","code":"ask-out-of-budget","generation":{"id":"g1","requestId":"request_one","question":"make it","status":"failed","answer":"I made","at":1,"revision":4,"results":[{"kind":"routine-created","operationId":"operation_one","routineId":"routine_one","routineName":"Push A"}]}}"#)
        guard case .refusal(let why, let generation) = try parser.consume("") else { return XCTFail("Expected refusal") }
        XCTAssertEqual(why, AskRefusal(line: "Allowance reached", mayRetry: true, ceiling: .account))
        var conversation = AskConversation()
        conversation.accept(try XCTUnwrap(generation))
        conversation.settle("request_one", .refused(why))
        XCTAssertEqual(conversation.exchanges[0].snapshot?.answer, "I made")
        XCTAssertEqual(conversation.exchanges[0].snapshot?.results.map(\.routineName), ["Push A"])
        XCTAssertEqual(conversation.open("make it", replacing: "request_one"), "request_one")
    }

    func testUnsupportedEventIsIgnoredAndMalformedSnapshotFails() throws {
        var parser = CoachStreamParser()
        _ = try parser.consume("event: internal")
        _ = try parser.consume("data: ignore this")
        XCTAssertNil(try parser.consume(""))
        _ = try parser.consume("event: snapshot")
        _ = try parser.consume("data: invalid json")
        XCTAssertThrowsError(try parser.consume(""))
    }
}

@MainActor
final class CoachPhotoTests: XCTestCase {
    func testPhotoNormalizationFitsContractAndDropsMetadata() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 5000, height: 1000), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 5000, height: 1000))
        }
        let normalized = try CoachPhoto.normalized(try XCTUnwrap(image.pngData()))
        XCTAssertEqual(normalized.draft.mediaType, "image/jpeg")
        XCTAssertEqual(normalized.draft.width, 4096)
        XCTAssertEqual(normalized.draft.height, 819)
        XCTAssertLessThanOrEqual(normalized.data.count, 5 * 1024 * 1024)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(normalized.data as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertThrowsError(try CoachPhoto.normalized(Data("not a photo".utf8)))
    }

    func testPhotoAndImageOnlyRequestSurviveRelaunchUnderTheirOwnerAndThread() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("requests.json")
        let requests = CoachRequests(url: url)
        let photo = CoachPhotoDraft(id: "photo_original", mediaType: "image/jpeg", width: 2, height: 2, bytes: 4)
        let data = Data([1, 2, 3, 4])
        try requests.savePhoto(photo, data: data, thread: "thread_original", user: "owner")
        let request = CoachRequest(thread: "thread_original", question: "", requestId: "request_original", attachmentIds: [photo.id])
        try requests.save(request, user: "owner")
        let restored = CoachRequests(url: url)
        XCTAssertEqual(restored.seat("owner").requests[request.thread], request)
        XCTAssertEqual(restored.seat("owner").photos?[request.thread], photo)
        XCTAssertEqual(try restored.photoData(photo.id, thread: request.thread, user: "owner"), data)
        XCTAssertThrowsError(try restored.photoData(photo.id, thread: request.thread, user: "other"))
        XCTAssertThrowsError(try restored.photoData(photo.id, thread: "other_thread", user: "owner"))
        try restored.savePhoto(nil, thread: request.thread, user: "owner")
        XCTAssertThrowsError(try restored.photoData(photo.id, thread: request.thread, user: "owner"))
    }
}

@MainActor
final class CoachWireTests: XCTestCase {
    func testWireSendsStableImagePayloadAndDeliversIncrementalSnapshots() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoachEventWire.self]
        let api = GymApi(api: WindmillApi(baseURL: URL(string: "https://coach.example.invalid")!, credential: { "fixture" },
                                         session: URLSession(configuration: configuration)))
        let request = CoachRequest(thread: "thread_one", question: "", requestId: "request_one", attachmentIds: ["photo_one"])
        var values: [CoachGeneration] = []
        let terminal = try await api.streamCoach(request) { values.append($0) }
        XCTAssertEqual(values.map(\.answer), ["First", "First and second."])
        XCTAssertEqual(values.map(\.revision), [1, 2])
        XCTAssertEqual(values.map(\.status), ["running", "completed"])
        XCTAssertEqual(terminal.requestId, "request_one")
        XCTAssertEqual(terminal.attachments.map(\.id), ["photo_one"])
    }
}

private final class CoachEventWire: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var bytes = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                bytes.append(buffer, count: count)
            }
        }
        let input = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
        let valid = input?["thread"] as? String == "thread_one" && input?["requestId"] as? String == "request_one"
            && input?["question"] as? String == "" && input?["stream"] as? Bool == true
            && input?["attachmentIds"] as? [String] == ["photo_one"]
        let response = HTTPURLResponse(url: request.url!, statusCode: valid ? 200 : 400, httpVersion: nil,
                                       headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for (revision, answer, status) in [(1, "First", "running"), (2, "First and second.", "completed")] {
            let event = """
            event: snapshot
            id: generation_one:\(revision)
            data: {"thread":"thread_one","generation":{"id":"generation_one","requestId":"request_one","question":"","status":"\(status)","answer":"\(answer)","at":1,"revision":\(revision),"attachments":[{"id":"photo_one","mediaType":"image/jpeg","width":2,"height":2,"bytes":100}]}}


            """
            client?.urlProtocol(self, didLoad: Data(event.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
}
