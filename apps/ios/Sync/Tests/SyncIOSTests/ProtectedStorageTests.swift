import Foundation
import SyncCore
import SyncEngine
import SyncIOS
import SyncStore
import SyncTesting
import Testing

// The storage directory over real files: the fork guard's copy is excluded from backup, so a store copied as a backup
// copies it (every file not excluded) comes back as a store of its own, while the device it was copied from keeps its
// replica.
struct ProtectedStorageTests {
  @Test func theForkGuardsCopyIsAFileExcludedFromBackup() throws {
    try withDirectory { directory in
      let storage = try ProtectedStorage(directory: directory.appending(path: "WindmillSync"))
      let copy = storage.forkGuard

      #expect(copy.load() == nil)
      try copy.save("fg_first")
      try copy.save("fg_second")

      #expect(copy.load() == "fg_second")
      #expect(try isExcluded(copy.file))
      #expect(try FileManager.default.contentsOfDirectory(atPath: storage.directory.path) == ["fork-guard"])
      #expect(storage.databasePath == directory.appending(path: "WindmillSync/sync.sqlite").path)
    }
  }

  @Test func aStoreRestoredFromABackupReidentifiesAndTheOriginalDoesNot() throws {
    try withDirectory { directory in
      let original = try ProtectedStorage(directory: directory.appending(path: "original"))
      let replica = try launch(over: original)
      #expect(try launch(over: original) == replica)

      let restored = try ProtectedStorage(directory: directory.appending(path: "restored"))
      try backUp(original, into: restored)
      #expect(restored.forkGuard.load() == nil)
      let reidentified = try launch(over: restored)

      #expect(reidentified != replica)
      #expect(restored.forkGuard.load() != nil)
      #expect(restored.forkGuard.load() != original.forkGuard.load())
      #expect(try launch(over: original) == replica)
    }
  }

  // A copy that lost its exclusion (a copy written by other means, or one a death caught between its write and its
  // exclusion) is excluded again at the next start, so a backup taken after it still makes a store of its own. Found in
  // review.
  @Test func aCopyThatLostItsExclusionIsExcludedAgainAtTheNextStart() throws {
    try withDirectory { directory in
      let original = try ProtectedStorage(directory: directory.appending(path: "original"))
      let replica = try launch(over: original)
      try Data(try #require(original.forkGuard.load()).utf8).write(to: original.forkGuard.file, options: .atomic)
      #expect(try isExcluded(original.forkGuard.file) == false)

      #expect(try launch(over: original) == replica)
      #expect(try isExcluded(original.forkGuard.file) == true)

      let restored = try ProtectedStorage(directory: directory.appending(path: "restored"))
      try backUp(original, into: restored)
      #expect(try launch(over: restored) != replica)
    }
  }

  // An engine started over the storage's files, as a process launch starts it: the active replica it then holds.
  func launch(over storage: ProtectedStorage) throws -> String {
    let store = try Store(path: storage.databasePath, registry: try Corpus.probeRegistry())
    _ = try SyncEngine(
      config: EngineConfig(appVersion: "1.0", surface: .ios, drivesLoops: false), store: store, transport: ScriptedTransport(),
      tokens: InMemoryTokenStore(), forkGuard: storage.forkGuard, clock: SimClock(wallMs: 1_700_000_000_000).engineClock,
      random: SystemRandom(), connectivity: SwitchedConnectivity())
    return try store.read { try $0.activeReplica() }
  }

  // What a backup carries: every file not excluded from it. SQLite rebuilds the shared-memory index from the log.
  func backUp(_ storage: ProtectedStorage, into restored: ProtectedStorage) throws {
    let files = try FileManager.default.contentsOfDirectory(at: storage.directory, includingPropertiesForKeys: [.isExcludedFromBackupKey])
    for file in files where !file.lastPathComponent.hasSuffix("-shm") {
      guard try !isExcluded(file) else { continue }
      try FileManager.default.copyItem(at: file, to: restored.directory.appending(path: file.lastPathComponent))
    }
  }

  func isExcluded(_ file: URL) throws -> Bool {
    try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
  }

  func withDirectory(_ body: (URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "ProtectedStorageTests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    try body(directory)
  }
}
