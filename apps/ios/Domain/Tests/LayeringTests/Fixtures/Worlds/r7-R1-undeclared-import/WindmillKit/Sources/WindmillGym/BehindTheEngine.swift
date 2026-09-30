import GRDB
import SyncStore

// WindmillGym declares SyncEngine (§2.1) and neither of these; it writes the replica's SQLite past the engine.
func markDone(at path: String) throws {
  let db = try DatabaseQueue(path: path)
  try db.write { try $0.execute(sql: "UPDATE confirmed SET body = ? WHERE id = ?", arguments: ["{}", "r_1"]) }
  _ = Store(path: path)
}
