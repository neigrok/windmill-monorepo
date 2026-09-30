-- The probe product's tables (packages/api-contract/sync/probe.registry.json): the sync engine's test and
-- dev product. Applied after schema.sql by the test harness and the local dev stack only; deploy never
-- applies it, and windmill_server never names the probe. Idempotent, in FK order.
--
-- Every table carries §2.2's envelope: scope_key, id, seq, rc and ru (epoch ms); born and life_stamp for
-- a type with a born and a life; life where dead rows are kept; <field>_stamp beside every lattice field;
-- <field>_rev and <field>_merged beside every text field. A `deadRows: spent` type's row exists only while
-- the record is alive (sync_spent keeps its death), so it has no life column.

create table if not exists probe_boards (
  scope_key  text not null references sync_scopes(key),
  id         text primary key,
  seq        bigint not null,
  rc         bigint not null,
  ru         bigint not null,
  born       text not null,
  life       text not null check (life in ('alive', 'dead')),
  life_stamp text not null
);
create index if not exists probe_boards_feed on probe_boards (scope_key, seq);

create table if not exists probe_cards (
  scope_key        text not null references sync_scopes(key),
  id               text primary key,
  seq              bigint not null,
  rc               bigint not null,
  ru               bigint not null,
  born             text not null,
  life_stamp       text not null,
  title            text,
  title_stamp      text,
  body             text,
  body_stamp       text,
  ord              text,
  ord_stamp        text,
  size             float8,
  size_stamp       text,
  claim            text,
  claim_stamp      text,
  tier             text,
  tier_stamp       text,
  attachment       jsonb,
  attachment_stamp text
);
create index if not exists probe_cards_feed on probe_cards (scope_key, seq);

create table if not exists probe_runs (
  scope_key        text not null references sync_scopes(key),
  id               text primary key,
  seq              bigint not null,
  rc               bigint not null,
  ru               bigint not null,
  born             text not null,
  life_stamp       text not null,
  started_at       bigint,
  started_at_stamp text,
  label            text,
  label_stamp      text,
  ended_at         bigint,
  ended_at_stamp   text
);
create index if not exists probe_runs_feed on probe_runs (scope_key, seq);

-- run_id holds no foreign key: a lap's parent is a record of the engine (§6.1 step 10), and a dead run is
-- only a sync_spent row.
create table if not exists probe_laps (
  scope_key    text not null references sync_scopes(key),
  id           text primary key,
  seq          bigint not null,
  rc           bigint not null,
  ru           bigint not null,
  born         text not null,
  life_stamp   text not null,
  run_id       text,
  run_id_stamp text,
  no           bigint,
  at           bigint,
  at_stamp     text,
  weight       float8,
  weight_stamp text
);
create index if not exists probe_laps_feed on probe_laps (scope_key, seq);
create index if not exists probe_laps_run on probe_laps (scope_key, run_id);

create table if not exists probe_days (
  scope_key   text not null references sync_scopes(key),
  id          text not null,
  seq         bigint not null,
  rc          bigint not null,
  ru          bigint not null,
  life_stamp  text not null,
  score       bigint,
  score_stamp text,
  primary key (scope_key, id)
);
create index if not exists probe_days_feed on probe_days (scope_key, seq);

create table if not exists probe_facts (
  scope_key   text not null references sync_scopes(key),
  id          text not null,
  seq         bigint not null,
  rc          bigint not null,
  ru          bigint not null,
  life_stamp  text not null,
  value       float8,
  value_stamp text,
  at          bigint,
  at_stamp    text,
  primary key (scope_key, id)
);
create index if not exists probe_facts_feed on probe_facts (scope_key, seq);

create table if not exists probe_metas (
  scope_key        text not null references sync_scopes(key),
  id               text not null,
  seq              bigint not null,
  rc               bigint not null,
  ru               bigint not null,
  title            text,
  title_stamp      text,
  visibility       text,
  visibility_stamp text,
  primary key (scope_key, id)
);
create index if not exists probe_metas_feed on probe_metas (scope_key, seq);

create table if not exists probe_tags (
  scope_key   text not null references sync_scopes(key),
  id          text not null,
  seq         bigint not null,
  rc          bigint not null,
  ru          bigint not null,
  born        text not null,
  life        text not null check (life in ('alive', 'dead')),
  life_stamp  text not null,
  label       text,
  label_stamp text,
  primary key (scope_key, id)
);
create index if not exists probe_tags_feed on probe_tags (scope_key, seq);

-- A link's id is the JCS of its [from, to] tuple.
create table if not exists probe_links (
  scope_key      text not null references sync_scopes(key),
  id             text not null,
  seq            bigint not null,
  rc             bigint not null,
  ru             bigint not null,
  life           text not null check (life in ('alive', 'dead')),
  life_stamp     text not null,
  strength       bigint,
  strength_stamp text,
  primary key (scope_key, id)
);
create index if not exists probe_links_feed on probe_links (scope_key, seq);

create table if not exists probe_marks (
  scope_key   text not null references sync_scopes(key),
  id          text not null,
  seq         bigint not null,
  rc          bigint not null,
  ru          bigint not null,
  done        boolean,
  done_stamp  text,
  memo        text,
  memo_rev    bigint,
  memo_merged boolean not null default false,
  primary key (scope_key, id)
);
create index if not exists probe_marks_feed on probe_marks (scope_key, seq);

-- A mark's superseded memo heads (§6.11 step 4); the probe keeps one per record and field.
create table if not exists probe_marks_revisions (
  scope_key text not null references sync_scopes(key),
  id        text not null,
  field     text not null,
  rev       bigint not null,
  text      text not null,
  primary key (scope_key, id, field, rev)
);

-- The receipts the probe's commands resolve their replays by: the run a probe.start id resolved to, and
-- the board a probe.copy destination was copied from.
create table if not exists probe_start_receipts (
  scope_key text not null references sync_scopes(key),
  called    text not null,
  resolved  text not null,
  primary key (scope_key, called)
);

create table if not exists probe_copy_receipts (
  scope_key   text not null references sync_scopes(key),
  destination text not null,
  source      text not null,
  primary key (scope_key, destination)
);
