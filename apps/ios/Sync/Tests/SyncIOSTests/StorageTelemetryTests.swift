import Foundation
import SyncEngine
import SyncIOS
import Synchronization
import Testing

struct StorageTelemetryTests {
  final class Recorder: Telemetry {
    let failures = Mutex<[String]>([])
    func event(_ name: String, properties: [String: String], durationMs: Int64?) {}
    func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
      #expect(properties.isEmpty)
      failures.withLock { $0.append("\(operation):\(kind)") }
    }
  }

  @Test func storagePreparationFailureReportsWithoutAPath() throws {
    let recorder = Recorder()
    let file = FileManager.default.temporaryDirectory.appending(path: "StorageTelemetry-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: file) }
    try Data("private journal".utf8).write(to: file)
    #expect(throws: CocoaError.self) { try ProtectedStorage(directory: file, telemetry: recorder) }
    #expect(recorder.failures.withLock { $0 } == ["storage_prepare:storage"])
  }

  @Test func missingForkGuardIsNormalWhileUnreadableAndUnwritableGuardsReport() throws {
    let recorder = Recorder()
    let directory = FileManager.default.temporaryDirectory.appending(path: "StorageTelemetry-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let missing = FileForkGuardStore(file: directory.appending(path: "private-name"), telemetry: recorder)
    #expect(missing.load() == nil)
    #expect(recorder.failures.withLock { $0 }.isEmpty)
    #expect(throws: CocoaError.self) { try missing.save("private identity") }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data([0xff, 0xfe, 0xff]).write(to: missing.file)
    #expect(missing.load() == nil)
    #expect(recorder.failures.withLock { $0 } == ["storage_fork_guard:storage", "storage_fork_guard:storage"])
  }
}
