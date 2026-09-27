import GRDB

// §2.5 the local store as SQLite: the pragmas every connection sets, and the migrations. Rows, intents, deltas and
// notices are JCS blobs; the columns beside them are the ones SQL filters, orders or keys by.

enum Schema {
  // `synchronous=FULL`: a returned commit survives an OS crash, not only an app crash (INV-3).
  static func configuration() -> Configuration {
    var configuration = Configuration()
    configuration.foreignKeysEnabled = true
    configuration.busyMode = .timeout(5)
    configuration.prepareDatabase { db in
      try db.execute(sql: "PRAGMA synchronous = FULL")
    }
    return configuration
  }

  static var migrator: DatabaseMigrator {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v1") { db in
      try db.execute(sql: v1)
    }
    return migrator
  }

  // Ids are stored as their JCS text, a tuple key and a string id never alike. Local ids, and so notice ids, are unique
  // on the device; commit order counts within a replica (§2.5, corpus/README.md "Ids and order"). Sent entries hold
  // distinct numbers; an acked one keeps its number past a re-identify, which numbers from 1 again (§7.11).
  static let v1 = """
    CREATE TABLE device (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      fork_guard        TEXT NULL,
      pending_sign_in   TEXT NULL,
      active_replica    TEXT NOT NULL,
      ref_index_version INTEGER NOT NULL
    );

    CREATE TABLE replica (
      replica          TEXT PRIMARY KEY,
      state            TEXT NOT NULL CHECK (state IN ('anon','bound','dormant')),
      account          TEXT NULL,
      next_n           INTEGER NOT NULL DEFAULT 1,
      hlc_ms           INTEGER NOT NULL DEFAULT 0,
      hlc_counter      INTEGER NOT NULL DEFAULT 0,
      hlc_high         TEXT NOT NULL DEFAULT '0:0:',
      admitted_high    TEXT NOT NULL DEFAULT '0:0:',
      server_offset_ms INTEGER NOT NULL DEFAULT 0,
      offset_samples   BLOB NOT NULL DEFAULT '[]',
      clock_reading    BLOB NULL,
      server_epoch     TEXT NULL,
      ack_through      INTEGER NOT NULL DEFAULT 0,
      auth_paused      INTEGER NOT NULL DEFAULT 0,
      CHECK ((state = 'anon') = (account IS NULL))
    );
    CREATE UNIQUE INDEX replica_one_anon    ON replica(state)   WHERE state = 'anon';
    CREATE UNIQUE INDEX replica_one_bound   ON replica(state)   WHERE state = 'bound';
    CREATE UNIQUE INDEX replica_per_account ON replica(account) WHERE account IS NOT NULL;

    CREATE TABLE confirmed (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      type    TEXT NOT NULL,
      id      TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      visible INTEGER NOT NULL,
      row     BLOB NOT NULL,
      hash    BLOB NOT NULL,
      PRIMARY KEY (replica, scope, type, id)
    ) WITHOUT ROWID;

    CREATE TABLE staging (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      type    TEXT NOT NULL,
      id      TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      visible INTEGER NOT NULL,
      row     BLOB NOT NULL,
      hash    BLOB NOT NULL,
      PRIMARY KEY (replica, scope, type, id)
    ) WITHOUT ROWID;

    CREATE TABLE confirmed_ref (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      type    TEXT NOT NULL,
      field   TEXT NOT NULL,
      target  TEXT NOT NULL,
      id      TEXT NOT NULL,
      PRIMARY KEY (replica, scope, type, field, target, id)
    ) WITHOUT ROWID;
    CREATE INDEX confirmed_ref_record ON confirmed_ref(replica, scope, type, id);

    CREATE TABLE staging_ref (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      type    TEXT NOT NULL,
      field   TEXT NOT NULL,
      target  TEXT NOT NULL,
      id      TEXT NOT NULL,
      PRIMARY KEY (replica, scope, type, field, target, id)
    ) WITHOUT ROWID;
    CREATE INDEX staging_ref_record ON staging_ref(replica, scope, type, id);

    CREATE TABLE spent (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      type    TEXT NOT NULL,
      id      TEXT NOT NULL,
      born    TEXT NOT NULL,
      PRIMARY KEY (replica, scope, type, id)
    ) WITHOUT ROWID;

    CREATE TABLE cursor (
      replica        TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope          TEXT NOT NULL,
      cursor         TEXT NULL,
      digest         BLOB NOT NULL,
      staging_digest BLOB NULL,
      booted         INTEGER NOT NULL DEFAULT 0,
      mismatch_reset INTEGER NOT NULL DEFAULT 0,
      digest_stop    TEXT NULL,
      PRIMARY KEY (replica, scope)
    );

    CREATE TABLE known_scope (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      kind    TEXT NOT NULL CHECK (kind IN ('gone','not-found')),
      PRIMARY KEY (replica, scope)
    ) WITHOUT ROWID;

    CREATE TABLE outbox (
      local_id     TEXT PRIMARY KEY,
      replica      TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      gesture_id   TEXT NOT NULL,
      lineage      TEXT NOT NULL,
      scope        TEXT NOT NULL,
      state        TEXT NOT NULL CHECK (state IN ('held','ready','sent','acked')),
      commit_order INTEGER NOT NULL,
      release_at   INTEGER NOT NULL DEFAULT 0,
      stamp        TEXT NOT NULL,
      intent       BLOB NOT NULL,
      predict      BLOB NULL,
      base_texts   BLOB NULL,
      n            INTEGER NULL,
      digest       BLOB NULL,
      result_seq   INTEGER NULL,
      result_epoch TEXT NULL,
      orphan_of    TEXT NULL,
      UNIQUE (replica, commit_order),
      CHECK ((n IS NULL) = (state IN ('held','ready'))),
      CHECK ((state = 'acked') = (result_seq IS NOT NULL))
    );
    CREATE UNIQUE INDEX outbox_n     ON outbox(replica, n) WHERE state = 'sent';
    CREATE INDEX        outbox_scope ON outbox(replica, scope, commit_order);
    CREATE INDEX        outbox_state ON outbox(replica, state, commit_order);

    CREATE TABLE notice (
      id        TEXT PRIMARY KEY,
      replica   TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      product   TEXT NOT NULL,
      scope     TEXT NOT NULL,
      code      TEXT NOT NULL,
      detail    BLOB NULL,
      content   BLOB NOT NULL,
      at        INTEGER NOT NULL,
      dismissed INTEGER NOT NULL CHECK (dismissed IN (0, 1))
    );

    CREATE TABLE device_row (
      replica TEXT NOT NULL REFERENCES replica ON DELETE CASCADE,
      product TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   BLOB NOT NULL,
      PRIMARY KEY (replica, product, key)
    ) WITHOUT ROWID;
    """
}
