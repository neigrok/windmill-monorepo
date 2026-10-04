import Foundation
import SyncEngine

// Where the engine keeps its files on the device (§2.5, §7.11). The database lives in a directory protected until the
// first unlock after boot, so the leave flush still writes while the phone is locked, and a backup carries it. Beside it
// the fork guard's copy is excluded from backup, so a store restored or cloned from a backup finds no copy and
// re-identifies every replica, and two phones never push as one replica.
public struct ProtectedStorage: Sendable {
  public let directory: URL
  let telemetry: any Telemetry

  // The directory is made, and on iOS protected, if it is not already.
  public init(directory: URL, telemetry: any Telemetry = NoopTelemetry()) throws {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    #if os(iOS)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
    #endif
    } catch {
      telemetry.failure("storage_prepare", kind: "storage")
      throw error
    }
    self.directory = directory
    self.telemetry = telemetry
  }

  // The app's own: `Application Support/WindmillSync`.
  public static func standard(telemetry: any Telemetry = NoopTelemetry()) throws -> ProtectedStorage {
    try ProtectedStorage(directory: URL.applicationSupportDirectory.appending(path: "WindmillSync"), telemetry: telemetry)
  }

  public var databasePath: String { directory.appending(path: "sync.sqlite").path }

  public var forkGuard: FileForkGuardStore { FileForkGuardStore(file: directory.appending(path: "fork-guard"), telemetry: telemetry) }
}

// The fork guard's copy as one file excluded from backup: nil when it is missing or unreadable, as on a restored device.
// A new copy is excluded before it takes the file's name, and a copy found without its exclusion, however it lost it, is
// excluded again when it is read.
public final class FileForkGuardStore: ForkGuardStore {
  public let file: URL
  let telemetry: any Telemetry

  public init(file: URL, telemetry: any Telemetry = NoopTelemetry()) {
    self.file = file
    self.telemetry = telemetry
  }

  public func load() -> String? {
    do {
      let copy = try String(contentsOf: file, encoding: .utf8)
      do { try Self.excludeFromBackup(file) }
      catch { telemetry.failure("storage_fork_guard", kind: "storage") }
      return copy
    } catch {
      if (error as? CocoaError)?.code != .fileReadNoSuchFile {
        telemetry.failure("storage_fork_guard", kind: "storage")
      }
      return nil
    }
  }

  public func save(_ forkGuard: String) throws {
    do {
      let written = file.deletingLastPathComponent().appending(path: "\(file.lastPathComponent).new")
      try Data(forkGuard.utf8).write(to: written)
      try Self.excludeFromBackup(written)
      guard rename(written.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
    } catch {
      telemetry.failure("storage_fork_guard", kind: "storage")
      throw error
    }
  }

  static func excludeFromBackup(_ file: URL) throws {
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    var file = file
    try file.setResourceValues(excluded)
  }
}
