internal import SQLite3
import SyncCore

public struct Store { public init() {}; public var version: String { String(cString: sqlite3_libversion()) } }
