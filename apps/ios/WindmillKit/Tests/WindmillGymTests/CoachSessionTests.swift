import XCTest
import UIKit
@testable import WindmillPlatform
@testable import WindmillGym

@MainActor
final class CoachSessionTests: XCTestCase {
    func testDisconnectReconnectsSameRequestAndReplacesSnapshot() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = CoachRequests(url: directory.appendingPathComponent("requests.json"))
        let server = CoachServer(script: [.disconnect, .complete])
        let session = CoachSession(requests: requests, connection: { _ in server })
        await session.connect(Account(api: WindmillApi(baseURL: URL(string: "https://test.invalid")!, credential: { nil }),
                                      user: User(id: "owner", email: "owner@example.invalid", name: "Owner")))
        session.ask("Create a routine", replacing: nil)
        for _ in 0..<200 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(server.sent.count, 2)
        XCTAssertEqual(Set(server.sent.map(\.requestId)).count, 1)
        XCTAssertEqual(session.conversation.exchanges.count, 1)
        XCTAssertEqual(session.conversation.exchanges.first?.snapshot?.answer, "A routine is ready.")
        XCTAssertNil(session.conversation.unresolved)
        XCTAssertEqual(requests.seat("owner").requests, [:])
    }

    func testFailedCreationThen429AndSnapshotless503KeepRequestResultsAndNextDraft() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = CoachRequests(url: directory.appendingPathComponent("requests.json"))
        let server = CoachServer(script: [.fail, .ceiling, .busy, .complete])
        let session = CoachSession(requests: requests, connection: { _ in server })
        await session.connect(Account(api: WindmillApi(baseURL: URL(string: "https://test.invalid")!, credential: { nil }),
                                      user: User(id: "owner", email: "owner@example.invalid", name: "Owner")))
        session.ask("Create a routine", replacing: nil)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        let exchange = try XCTUnwrap(session.conversation.exchanges.last)
        session.conversation.draft = "My next question"
        session.saveDraft()
        session.ask(exchange.question, replacing: exchange.id)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.conversation.cappedRefusal?.ceiling, .account)
        XCTAssertEqual(session.conversation.exchanges.last?.snapshot?.results.map(\.routineName), ["Push A"])
        XCTAssertEqual(requests.seat("owner").requests[session.conversation.threadId]?.requestId, exchange.id)
        XCTAssertEqual(requests.seat("owner").drafts[session.conversation.threadId], "My next question")
        session.ask(exchange.question, replacing: exchange.id)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.conversation.exchanges.last?.outcome,
                       .refused(AskRefusal(line: "Coach is busy. Try again.", mayRetry: true)))
        XCTAssertEqual(session.conversation.exchanges.last?.snapshot?.results.map(\.routineName), ["Push A"])
        XCTAssertEqual(requests.seat("owner").requests[session.conversation.threadId]?.requestId, exchange.id)
        session.ask(exchange.question, replacing: exchange.id)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.sent.map(\.requestId), [exchange.id, exchange.id, exchange.id, exchange.id])
        XCTAssertEqual(session.conversation.draft, "My next question")
        XCTAssertEqual(requests.seat("owner").requests, [:])
    }

    func testStopPreservesPartialAnswerAndCompletedResultThenAllowsNewQuestion() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = CoachRequests(url: directory.appendingPathComponent("requests.json"))
        let server = CoachServer(script: [.wait, .complete])
        let session = CoachSession(requests: requests, connection: { _ in server })
        await session.connect(Account(api: WindmillApi(baseURL: URL(string: "https://test.invalid")!, credential: { nil }),
                                      user: User(id: "owner", email: "owner@example.invalid", name: "Owner")))
        session.ask("Create a routine", replacing: nil)
        for _ in 0..<100 where server.sent.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let first = try XCTUnwrap(server.sent.first)
        session.stop()
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.stopped, [first])
        XCTAssertEqual(session.conversation.exchanges.last?.snapshot?.answer, "A routine")
        XCTAssertEqual(session.conversation.exchanges.last?.snapshot?.results.map(\.routineName), ["Push A"])
        XCTAssertEqual(session.conversation.exchanges.last?.outcome, .refused(AskRefusal(line: "Response stopped.")))
        session.ask("Continue with my next question", replacing: nil)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.sent.count, 2)
        XCTAssertNotEqual(server.sent[0].requestId, server.sent[1].requestId)
    }

    func testFailedUploadRetriesSameBytesAndImageOnlyAskUsesSamePhoto() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = CoachRequests(url: directory.appendingPathComponent("requests.json"))
        let server = CoachServer(script: [.complete])
        server.refuseUpload = true
        let session = CoachSession(requests: requests, connection: { _ in server })
        await session.connect(Account(api: WindmillApi(baseURL: URL(string: "https://test.invalid")!, credential: { nil }),
                                      user: User(id: "owner", email: "owner@example.invalid", name: "Owner")))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        session.addPhoto(try XCTUnwrap(image.pngData()))
        for _ in 0..<100 where session.photoBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.photoFailure, "Photo didn’t upload.")
        let photo = try XCTUnwrap(session.photo)
        server.refuseUpload = false
        session.uploadPhoto()
        for _ in 0..<100 where session.photoBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.uploadIds, [photo.id, photo.id])
        XCTAssertEqual(server.uploadBytes[0], server.uploadBytes[1])
        XCTAssertEqual(session.photo?.uploaded, true)
        session.ask("", replacing: nil)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.sent.first?.question, "")
        XCTAssertEqual(server.sent.first?.attachmentIds, [photo.id])
        XCTAssertEqual(session.conversation.exchanges.first?.attachments.map(\.id), [photo.id])
        XCTAssertNil(session.photo)
        XCTAssertNil(requests.seat("owner").photos?[session.conversation.threadId])
    }

    func testRestoredUploadIsRefreshedBeforeRetryWithSamePhotoBytesAndRequest() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let requests = CoachRequests(url: directory.appendingPathComponent("requests.json"))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        let normalized = try CoachPhoto.normalized(XCTUnwrap(image.pngData()))
        var photo = normalized.draft
        photo.uploaded = true
        let request = CoachRequest(thread: "thread_restored", question: "", requestId: "request_restored",
                                   attachmentIds: [photo.id])
        try requests.savePhoto(photo, data: normalized.data, thread: request.thread, user: "owner")
        try requests.save(request, user: "owner")
        let server = CoachServer(script: [.complete])
        server.refuseUpload = true
        let session = CoachSession(requests: requests, connection: { _ in server })
        await session.connect(Account(api: WindmillApi(baseURL: URL(string: "https://test.invalid")!, credential: { nil }),
                                      user: User(id: "owner", email: "owner@example.invalid", name: "Owner")))
        for _ in 0..<100 where session.photoBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.photo?.uploaded, false)
        XCTAssertEqual(requests.seat("owner").photos?[request.thread]?.uploaded, false)
        XCTAssertEqual(session.photoFailure, "Photo didn’t upload.")
        session.ask("", replacing: request.requestId)
        XCTAssertEqual(server.sent, [])
        XCTAssertEqual(requests.seat("owner").requests[request.thread], request)
        server.refuseUpload = false
        session.uploadPhoto()
        for _ in 0..<100 where session.photoBusy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.uploadIds, [photo.id, photo.id])
        XCTAssertEqual(server.uploadBytes, [normalized.data, normalized.data])
        session.ask("", replacing: request.requestId)
        for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.sent, [request])
        XCTAssertEqual(session.conversation.exchanges.first?.attachments.map(\.id), [photo.id])
        XCTAssertNil(session.photo)
        XCTAssertEqual(requests.seat("owner").requests, [:])
    }

    func testPhotoExpiryOnMountedPageReuploadsSameBytesBeforeSameRequestRetry() async throws {
        for reply in [CoachServer.Reply.photoExpiredHttp, .photoExpiredStream] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let requests = CoachRequests(url: directory.appendingPathComponent("requests.json"))
            let server = CoachServer(script: [reply, .complete])
            let session = CoachSession(requests: requests, connection: { _ in server })
            await session.connect(Account(api: WindmillApi(baseURL: URL(string: "https://test.invalid")!, credential: { nil }),
                                          user: User(id: "owner", email: "owner@example.invalid", name: "Owner")))
            let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { context in
                UIColor.blue.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
            }
            session.addPhoto(try XCTUnwrap(image.pngData()))
            for _ in 0..<100 where session.photoBusy { try await Task.sleep(for: .milliseconds(10)) }
            let photo = try XCTUnwrap(session.photo)
            let bytes = try XCTUnwrap(session.photoData)
            XCTAssertTrue(photo.uploaded)
            server.refuseUpload = true
            session.ask("Check my form", replacing: nil)
            for _ in 0..<100 where session.conversation.waiting || session.photoBusy {
                try await Task.sleep(for: .milliseconds(10))
            }
            let request = try XCTUnwrap(server.sent.first)
            XCTAssertEqual(session.photo?.uploaded, false)
            XCTAssertEqual(session.photoFailure, "Photo didn’t upload.")
            XCTAssertEqual(requests.seat("owner").photos?[request.thread]?.uploaded, false)
            XCTAssertEqual(requests.seat("owner").requests[request.thread], request)
            session.ask(request.question, replacing: request.requestId)
            XCTAssertEqual(server.sent, [request])
            server.refuseUpload = false
            session.uploadPhoto()
            for _ in 0..<100 where session.photoBusy { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertEqual(server.uploadIds, [photo.id, photo.id, photo.id])
            XCTAssertEqual(server.uploadBytes, [bytes, bytes, bytes])
            session.ask(request.question, replacing: request.requestId)
            for _ in 0..<100 where session.conversation.waiting { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertEqual(server.sent, [request, request])
            XCTAssertEqual(session.conversation.exchanges.count, 1)
            XCTAssertNil(session.photo)
            XCTAssertEqual(requests.seat("owner").requests, [:])
        }
    }
}

@MainActor
private final class CoachServer: CoachServing {
    enum Reply { case disconnect, fail, ceiling, busy, complete, wait, photoExpiredHttp, photoExpiredStream }
    var script: [Reply]
    var sent: [CoachRequest] = []
    var stopped: [CoachRequest] = []
    var uploadIds: [String] = []
    var uploadBytes: [Data] = []
    var photos: [CoachAttachment] = []
    var refuseUpload = false

    init(script: [Reply]) { self.script = script }

    func streamCoach(_ request: CoachRequest,
                     receive: @escaping @MainActor (CoachGeneration) throws -> Void) async throws -> CoachGeneration {
        sent.append(request)
        let reply = script.removeFirst()
        if reply == .ceiling { throw AskRefusal(line: "Allowance reached", mayRetry: true, ceiling: .account) }
        if reply == .busy {
            throw WindmillApiError.refused(503, Refusal(Data(#"{"error":"Coach is busy. Try again.","code":"ask-busy"}"#.utf8)))
        }
        if reply == .photoExpiredHttp || reply == .photoExpiredStream {
            photos = []
            if reply == .photoExpiredHttp {
                throw WindmillApiError.refused(400, Refusal(Data(#"{"error":"Photo expired","code":"ask-attachment-invalid"}"#.utf8)))
            }
            var parser = CoachStreamParser()
            _ = try parser.consume("event: error")
            _ = try parser.consume("data: " + #"{"error":"Photo expired","status":400,"code":"ask-attachment-invalid"}"#)
            guard case .refusal(let refusal, _) = try parser.consume("") else { throw WindmillApiError.malformed }
            throw refusal
        }
        let revision = Int64(sent.count * 2)
        let result = CoachResult(kind: "routine-created", operationId: "operation_one", routineId: "routine_one", routineName: "Push A")
        let partial = CoachGeneration(id: "generation_\(request.requestId)", requestId: request.requestId,
            question: request.question, status: "running", answer: "A routine", at: 1, steps: [], receipt: nil,
            results: [result], revision: revision, attachments: photos)
        try receive(partial)
        if reply == .disconnect { throw WindmillApiError.offline }
        if reply == .wait { while true { try await Task.sleep(for: .seconds(10)) } }
        let terminal = CoachGeneration(id: partial.id, requestId: request.requestId, question: request.question,
            status: reply == .fail ? "failed" : "completed", answer: "A routine is ready.", at: 1,
            steps: [], receipt: nil, results: [result], revision: revision + 1, attachments: photos)
        try receive(terminal)
        return terminal
    }

    func stopCoach(_ request: CoachRequest) async throws -> CoachGeneration {
        stopped.append(request)
        return CoachGeneration(id: "generation_\(request.requestId)", requestId: request.requestId,
            question: request.question, status: "stopped", answer: "A routine", at: 1, steps: [], receipt: nil,
            results: [CoachResult(kind: "routine-created", operationId: "operation_one", routineId: "routine_one", routineName: "Push A")],
            revision: 100, attachments: photos)
    }

    func thread(_ id: String, before: String?) async throws -> AskThread? { nil }

    func uploadCoachPhoto(_ photo: CoachPhotoDraft, data: Data, thread: String,
                          progress: @escaping @Sendable (Double) -> Void) async throws -> CoachAttachment {
        uploadIds.append(photo.id)
        uploadBytes.append(data)
        if refuseUpload { throw WindmillApiError.offline }
        progress(1)
        photos = [photo.attachment]
        return photo.attachment
    }

    func coachPhoto(_ id: String, thread: String) async throws -> Data { uploadBytes.last ?? Data() }
}
