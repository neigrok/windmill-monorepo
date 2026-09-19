import XCTest
@testable import WindmillPlatform

final class WindmillApiTests: XCTestCase {
    func testAuthenticatedLinesKeepEmptyEventsAndSplitUnicodeIntact() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ByteWire.self]
        let api = WindmillApi(baseURL: URL(string: "https://transport.example.invalid")!, credential: { "fixture" },
                              session: URLSession(configuration: configuration))
        var values: [String] = []
        let lines = try api.lines("POST", "/lines", body: ["question": "hello"], accept: "text/event-stream")
        for try await line in lines { values.append(line) }
        XCTAssertEqual(values, [": heartbeat", "", "event: snapshot", "data: café 🏋", "", "event: snapshot", "data: done", ""])
    }

    func testCancellingStreamReleasesTheURLSessionTask() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ByteWire.self]
        let api = WindmillApi(baseURL: URL(string: "https://transport.example.invalid")!, credential: { "fixture" },
                              session: URLSession(configuration: configuration))
        let first = expectation(description: "First line")
        let cancelled = expectation(description: "Underlying request cancelled")
        let observer = NotificationCenter.default.addObserver(forName: Notification.Name("ByteWire.cancelled"),
                                                              object: nil, queue: nil) { notification in
            if notification.object as? String == "/held" { cancelled.fulfill() }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        let task = Task {
            let lines = try api.lines("POST", "/held", body: ["a": 1], accept: "text/event-stream")
            for try await _ in lines { first.fulfill() }
        }
        await fulfillment(of: [first], timeout: 2)
        task.cancel()
        _ = await task.result
        await fulfillment(of: [cancelled], timeout: 2)
    }

    func testBinaryUploadAndReadPreserveBytesAndRefusalStatus() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ByteWire.self]
        let api = WindmillApi(baseURL: URL(string: "https://transport.example.invalid")!, credential: { "fixture" },
                              session: URLSession(configuration: configuration))
        let bytes = Data([0, 255, 17, 128, 10])
        let sent = try await api.data("PUT", "/bytes", body: bytes, contentType: "image/png")
        XCTAssertEqual(sent, bytes)
        let read = try await api.data("GET", "/bytes")
        XCTAssertEqual(read, bytes)
        do {
            _ = try await api.data("GET", "/refused")
            XCTFail("A refused read must not return bytes")
        } catch let error as WindmillApiError {
            guard case .refused(let status, let why) = error else { return XCTFail("Lost HTTP refusal") }
            XCTAssertEqual(status, 409)
            XCTAssertEqual(why.code, "same-request")
            XCTAssertEqual(why.message, "Keep this request")
        }
    }

    func testStreamRejectsWrongContentTypeAndPreservesHTTPRefusal() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ByteWire.self]
        let api = WindmillApi(baseURL: URL(string: "https://transport.example.invalid")!, credential: { "fixture" },
                              session: URLSession(configuration: configuration))
        do {
            let lines = try api.lines("POST", "/bytes", body: ["a": 1], accept: "text/event-stream")
            for try await _ in lines {}
            XCTFail("Binary must not masquerade as an event stream")
        } catch let error as WindmillApiError { XCTAssertEqual(error, .malformed) }
        do {
            let lines = try api.lines("POST", "/refused", body: ["a": 1], accept: "text/event-stream")
            for try await _ in lines {}
            XCTFail("Refusal must throw")
        } catch let error as WindmillApiError {
            guard case .refused(let status, let why) = error else { return XCTFail("Lost HTTP refusal") }
            XCTAssertEqual(status, 409)
            XCTAssertEqual(why.message, "Keep this request")
        }
    }
}

private final class ByteWire: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {
        NotificationCenter.default.post(name: Notification.Name("ByteWire.cancelled"), object: request.url?.path)
    }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let authenticated = request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture"
        let status = authenticated ? (path == "/refused" ? 409 : 200) : 401
        let type = (path == "/lines" || path == "/held") ? "text/event-stream" : "application/octet-stream"
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if path == "/held" {
            client?.urlProtocol(self, didLoad: Data("first\n".utf8))
            return
        }
        if path == "/lines" {
            let bytes = Data(": heartbeat\r\n\r\nevent: snapshot\r\ndata: café 🏋\r\n\r\nevent: snapshot\ndata: done\n\n".utf8)
            for index in stride(from: 0, to: bytes.count, by: 3) {
                client?.urlProtocol(self, didLoad: bytes.subdata(in: index..<min(index + 3, bytes.count)))
            }
        } else if path == "/refused" {
            client?.urlProtocol(self, didLoad: Data(#"{"error":"Keep this request","code":"same-request"}"#.utf8))
        } else if request.httpMethod == "PUT" {
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    data.append(buffer, count: count)
                }
            }
            client?.urlProtocol(self, didLoad: data)
        } else {
            client?.urlProtocol(self, didLoad: Data([0, 255, 17, 128, 10]))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
}
