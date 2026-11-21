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
    migrator.registerMigration("v2") { db in
      try db.execute(sql: "ALTER TABLE outbox ADD COLUMN write_targets BLOB NULL")
    }
    // E-7: an opted entry's projections and accepted versions beside its intent, and in `outbox_projection` each projection's
    // scope, the seq that covers it there and whether it is covered, by which a page finds the entries it settles and a
    // scope the entries that hold effects in it, never reading the rest. A store from before holds legacy entries only,
    // whose two new blobs stay null and whose one scope and seq the outbox row keeps.
    migrator.registerMigration("v3") { db in
      try db.execute(sql: """
        ALTER TABLE outbox ADD COLUMN predictions BLOB NULL;
        ALTER TABLE outbox ADD COLUMN accepted_effects BLOB NULL;
        CREATE TABLE outbox_projection (
          local_id   TEXT NOT NULL REFERENCES outbox ON DELETE CASCADE,
          scope      TEXT NOT NULL,
          result_seq INTEGER NULL,
          covered    INTEGER NOT NULL CHECK (covered IN (0, 1)),
          PRIMARY KEY (local_id, scope)
        ) WITHOUT ROWID;
        CREATE INDEX outbox_projection_scope ON outbox_projection(scope, covered, result_seq);
        CREATE INDEX outbox_projection_open  ON outbox_projection(scope) WHERE covered = 0;
        """)
    }
    // K-3: the journal of reversible acts, inverse requests and cancellation receipts, each record by its id, which is a
    // gesture id and so unique on the device, in its replica's namespace; an inverse slot's request beside its entry; and
    // whether a replica's journal holds anything, read with its replica row, so a replica with none reads no more (§7.3
    // Undo of an act). A journal that holds records loads whole for a planner that reads it, and not at all for a reader.
    migrator.registerMigration("v4") { db in
      try db.execute(sql: """
        ALTER TABLE outbox ADD COLUMN inverse_of TEXT NULL;
        ALTER TABLE replica ADD COLUMN journaled INTEGER NOT NULL DEFAULT 0 CHECK (journaled IN (0, 1));
        CREATE TABLE journal_act (
          act_id  TEXT PRIMARY KEY,
          replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
          act     BLOB NOT NULL
        );
        CREATE INDEX journal_act_replica ON journal_act(replica, act_id);
        CREATE TABLE inverse_request (
          request_id     TEXT PRIMARY KEY,
          replica        INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
          inverse_act_id TEXT NOT NULL,
          request        BLOB NOT NULL
        );
        CREATE INDEX inverse_request_replica ON inverse_request(replica, request_id);
        CREATE INDEX inverse_request_act ON inverse_request(inverse_act_id);
        CREATE TABLE cancellation (
          inverse_act_id TEXT PRIMARY KEY,
          replica        INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
          receipt        BLOB NOT NULL
        );
        CREATE INDEX cancellation_replica ON cancellation(replica, inverse_act_id);
        """)
    }
    // §2.5, §7.5: a spent id keeps the seq of the dead row it came from. One stored without it keeps none, so a preimage
    // read over it has no row to walk from, and its Undo skips (§7.3).
    migrator.registerMigration("v5") { db in
      try db.execute(sql: "ALTER TABLE spent ADD COLUMN seq INTEGER NULL")
    }
    return migrator
  }

  // Every table names its replica by `replica.handle`, which a re-identify leaves alone; the replica's id is in `replica`
  // alone (§7.11). Ids are stored as their JCS text, a tuple key and a string id never alike. Local ids, and so notice
  // ids, are unique on the device; commit order counts within a replica (§2.5, corpus/README.md "Ids and order"). Sent
  // entries hold distinct numbers; an acked one keeps its number past a re-identify, which numbers from 1 again.
  // A scope's confirmed rows and a boot's staging are each a `row_set` whose rows are `set_row`; a staging swap, a drop, a
  // forgotten scope and a purge only change which set holds which role, and a set of no role (`released`) is swept later,
  // a slice a transaction (§2.5 the writer). `set_ref` is the ref index of ER-12. `outbox_touch` holds each record an
  // entry's deltas and prediction touch, so a load finds the entries of the records it reads without reading the rest.
  static let v1 = """
    CREATE TABLE replica (
      handle           INTEGER PRIMARY KEY,
      id               TEXT NOT NULL UNIQUE,
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

    CREATE TABLE device (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      fork_guard        TEXT NULL,
      pending_sign_in   TEXT NULL,
      active_replica    INTEGER NOT NULL REFERENCES replica DEFERRABLE INITIALLY DEFERRED,
      ref_index_version INTEGER NOT NULL
    );

    CREATE TABLE row_set (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      replica INTEGER NULL REFERENCES replica ON DELETE SET NULL,
      scope   TEXT NOT NULL,
      role    TEXT NULL CHECK (role IN ('confirmed','staging'))
    );
    CREATE UNIQUE INDEX row_set_role     ON row_set(replica, scope, role) WHERE role IS NOT NULL;
    CREATE INDEX        row_set_released ON row_set(id)                   WHERE role IS NULL;

    CREATE TABLE set_row (
      row_set INTEGER NOT NULL REFERENCES row_set,
      type    TEXT NOT NULL,
      id      TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      visible INTEGER NOT NULL,
      row     BLOB NOT NULL,
      hash    BLOB NOT NULL,
      PRIMARY KEY (row_set, type, id)
    ) WITHOUT ROWID;

    CREATE TABLE set_ref (
      row_set INTEGER NOT NULL REFERENCES row_set,
      type    TEXT NOT NULL,
      field   TEXT NOT NULL,
      target  TEXT NOT NULL,
      id      TEXT NOT NULL,
      PRIMARY KEY (row_set, type, field, target, id)
    ) WITHOUT ROWID;
    CREATE INDEX set_ref_record ON set_ref(row_set, type, id);

    CREATE TABLE spent (
      replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      type    TEXT NOT NULL,
      id      TEXT NOT NULL,
      born    TEXT NOT NULL,
      PRIMARY KEY (replica, scope, type, id)
    ) WITHOUT ROWID;

    CREATE TABLE cursor (
      replica        INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope          TEXT NOT NULL,
      cursor         TEXT NULL,
      digest         BLOB NOT NULL,
      staging_digest BLOB NULL,
      booted         INTEGER NOT NULL DEFAULT 0,
      behind         INTEGER NOT NULL DEFAULT 0,
      mismatch_reset INTEGER NOT NULL DEFAULT 0,
      digest_stop    TEXT NULL,
      PRIMARY KEY (replica, scope)
    );

    CREATE TABLE known_scope (
      replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
      scope   TEXT NOT NULL,
      kind    TEXT NOT NULL CHECK (kind IN ('gone','not-found')),
      PRIMARY KEY (replica, scope)
    ) WITHOUT ROWID;

    CREATE TABLE outbox (
      local_id     TEXT PRIMARY KEY,
      replica      INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
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
    CREATE UNIQUE INDEX outbox_n       ON outbox(replica, n) WHERE state = 'sent';
    CREATE INDEX        outbox_scope   ON outbox(replica, scope, commit_order);
    CREATE INDEX        outbox_state   ON outbox(replica, state, commit_order);
    CREATE INDEX        outbox_gesture ON outbox(gesture_id);

    CREATE TABLE outbox_touch (
      local_id TEXT NOT NULL REFERENCES outbox ON DELETE CASCADE,
      scope    TEXT NOT NULL,
      type     TEXT NOT NULL,
      id       TEXT NOT NULL,
      PRIMARY KEY (scope, type, id, local_id)
    ) WITHOUT ROWID;
    CREATE INDEX outbox_touch_entry ON outbox_touch(local_id);

    CREATE TABLE notice (
      id        TEXT PRIMARY KEY,
      replica   INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
      product   TEXT NOT NULL,
      scope     TEXT NOT NULL,
      code      TEXT NOT NULL,
      detail    BLOB NULL,
      content   BLOB NOT NULL,
      at        INTEGER NOT NULL,
      dismissed INTEGER NOT NULL CHECK (dismissed IN (0, 1))
    );

    CREATE TABLE device_row (
      replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,
      product TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   BLOB NOT NULL,
      PRIMARY KEY (replica, product, key)
    ) WITHOUT ROWID;
    """
}
