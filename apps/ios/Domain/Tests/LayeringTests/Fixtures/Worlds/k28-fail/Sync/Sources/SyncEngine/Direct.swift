import SQLite3

enum Direct { static var version: String { String(cString: sqlite3_libversion()) } }
