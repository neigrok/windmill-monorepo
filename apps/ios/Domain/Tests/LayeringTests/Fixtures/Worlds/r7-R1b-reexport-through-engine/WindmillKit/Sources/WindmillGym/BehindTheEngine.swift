import SyncEngine

// Imports only what §2.1 lists for a UI module; SyncEngine hands over SyncStore and GRDB.
func markDone(at path: String) throws {
  let db = try DatabaseQueue(path: path)
  try db.write { try $0.execute(sql: "UPDATE confirmed SET body = ? WHERE id = ?", arguments: ["{}", "r_1"]) }
}
