-- Re-applied in order on every deploy: every statement must be idempotent. Grouped by FK
-- dependency, so the per-product banners alternate.

create extension if not exists citext;

-- ── Platform (platform/) ─────────────────────────────────────────────────────────────────────

create table if not exists users (
  id         uuid primary key,
  email      citext unique not null,
  name       text not null default '',
  created_at timestamptz not null default now()
);

alter table users add column if not exists name text not null default '';
alter table users drop column if exists password_hash;
alter table users drop column if exists handle;

-- Unused: nothing in the backend reads or writes orgs, org_members or trees.org_id.
create table if not exists orgs (
  id         uuid primary key,
  name       text not null,
  slug       text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists org_members (
  org_id  uuid not null references orgs(id),
  user_id uuid not null references users(id),
  role    text not null,
  primary key (org_id, user_id)
);

-- ── Roadmap (products/roadmap) ───────────────────────────────────────────────────────────────

-- title is LWW: `title_hlc` is its stamp ('' = unset); `title_ms`/`title_counter` are that stamp's
-- numeric split, so the guard runs in SQL.
create table if not exists trees (
  id            text primary key,
  org_id        uuid,
  owner_id      uuid,
  title         text not null default '',
  title_hlc     text not null default '',
  title_ms      bigint not null default 0,
  title_counter bigint not null default 0,
  visibility    text not null default 'private',
  head_seq      bigint not null default 0,
  forked_from   text,
  document      jsonb not null default '{"nodes":[]}'::jsonb,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table trees add column if not exists title_hlc text not null default '';
alter table trees add column if not exists title_ms bigint not null default 0;
alter table trees add column if not exists title_counter bigint not null default 0;
-- visibility gates every read: 'private' is owner-only, 'unlisted'/'public' are readable by anyone
-- holding the id.
alter table trees add column if not exists visibility text not null default 'private';
alter table trees alter column visibility set default 'private';

create index if not exists trees_owner on trees (owner_id) where deleted_at is null;
create index if not exists trees_forked_from on trees (forked_from) where deleted_at is null;
create index if not exists trees_public on trees (visibility) where visibility = 'public' and deleted_at is null;

-- Grow-only: a delete is a tombstone stamp, so saves are pure upserts and rows are never deleted.
-- Stamps are HLC text ("physicalMs:counter:actor", '' = unset), never compared in SQL; `present` is
-- the writer's projection of them.
create table if not exists tree_nodes (
  tree_id         text not null,
  node_id         text not null,
  created_hlc     text not null default '',
  deleted_hlc     text not null default '',
  label           text not null default '',
  label_hlc       text not null default '',
  icon            text not null default '',
  icon_hlc        text not null default '',
  color           text not null default 'terracotta',
  color_hlc       text not null default '',
  ord             text not null default '',
  ord_hlc         text not null default '',
  pos_x           double precision,
  pos_y           double precision,
  pos_hlc         text not null default '',
  status          text,
  status_hlc      text not null default '',
  description     text not null default '',
  description_hlc text not null default '',
  links           jsonb not null default '[]'::jsonb,
  links_hlc       text not null default '',
  present         boolean not null default false,
  primary key (tree_id, node_id)
);
-- `ord` is a fractional-index sort key (opaque text, LWW by `ord_hlc`), scoped to its parent.
alter table tree_nodes add column if not exists ord text not null default '';
alter table tree_nodes add column if not exists ord_hlc text not null default '';

create table if not exists tree_edges (
  tree_id     text not null,
  from_id     text not null,
  to_id       text not null,
  added_hlc   text not null default '',
  removed_hlc text not null default '',
  primary key (tree_id, from_id, to_id)
);

create table if not exists tree_kinds (
  tree_id         text not null,
  kind_id         text not null,
  created_hlc     text not null default '',
  deleted_hlc     text not null default '',
  hue             text not null default 'terracotta',
  hue_hlc         text not null default '',
  label           text not null default '',
  label_hlc       text not null default '',
  description     text not null default '',
  description_hlc text not null default '',
  rank            double precision not null default 0,
  rank_hlc        text not null default '',
  primary key (tree_id, kind_id)
);

-- The unfurl card served by GET /og/:id.png. No FK to trees: addressed by tree id and read behind
-- the tree's own visibility gate.
create table if not exists tree_og_images (
  tree_id    text primary key,
  png        bytea not null,
  updated_at timestamptz not null default now()
);

-- The share video served by GET /v1/trees/:id/og-video; a missing video is a plain 404. No FK to
-- trees, same as tree_og_images.
create table if not exists tree_og_videos (
  tree_id    text primary key,
  video      bytea not null,
  mime       text not null default 'video/mp4',
  updated_at timestamptz not null default now()
);

-- append-only op log: activity, undo, reconnect replay
create table if not exists tree_ops (
  tree_id    text not null,
  seq        bigint not null,
  actor_id   text not null default '',
  op_id      text not null,
  kind       text not null,
  payload    jsonb not null,
  hlc        text not null,
  created_at timestamptz not null default now(),
  primary key (tree_id, seq),
  unique (tree_id, op_id)
);

-- Per-user private progress, LWW per node. `status` is a stamped value including 'none' — a clear
-- is a value, never a row delete. (`stamp_ms`, `stamp_counter`) is the HLC split for numeric LWW and
-- is unique per write to a tree.
create table if not exists node_progress (
  tree_id       text not null,
  user_id       text not null,
  node_id       text not null,
  status        text not null,
  hlc           text not null default '',
  stamp_ms      bigint not null default 0,
  stamp_counter bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (tree_id, user_id, node_id)
);
alter table node_progress add column if not exists stamp_ms bigint not null default 0;
alter table node_progress add column if not exists stamp_counter bigint not null default 0;

-- ── Platform (platform/), continued ──────────────────────────────────────────────────────────

-- Passwordless sign-in. A link is addressed by the digest of its secret; the raw token is never at
-- rest. *_ms are epoch milliseconds. consumed_ms is null until spent.
create table if not exists magic_links (
  token_hash  text primary key,
  email       citext not null,
  created_ms  bigint not null,
  expires_ms  bigint not null,
  consumed_ms bigint,
  created_at  timestamptz not null default now()
);
create index if not exists magic_links_email_created on magic_links (email, created_ms);
-- fork_source: a tree to copy into whatever account verify signs in.
alter table magic_links add column if not exists fork_source text;
-- The 6-digit code twin lives on the link's row; either credential flips consumed_ms. At the
-- attempts cap the row stops resolving.
alter table magic_links add column if not exists code_hash text;
alter table magic_links add column if not exists attempts int not null default 0;

-- One row per device, keyed by the digest of the cookie secret.
create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_ms bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user on sessions (user_id);

-- `id` is the public per-session handle; the digest stays server-side. last_seen_ms rolls forward
-- on every authenticated use; 0 means never recorded, and the list reads created_at instead.
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
alter table sessions add column if not exists user_agent text not null default '';
alter table sessions add column if not exists last_seen_ms bigint not null default 0;
alter table sessions add column if not exists ip text not null default '';
create unique index if not exists sessions_id on sessions (id);

-- (provider, subject) is the identity; the email is only ever a hint. email_at_link records the
-- address the door came in on and is never read to resolve anyone.
create table if not exists user_identities (
  provider      text not null check (provider in ('google','apple')),
  subject       text not null,
  user_id       uuid not null references users(id) on delete cascade,
  email_at_link text not null default '',
  created_at    timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists user_identities_user on user_identities (user_id);

-- Long-lived per-user bearer tokens for OAuth-less MCP clients, keyed by the digest of the secret;
-- the raw token is never stored. `id` is the public per-key handle. expires_ms null = never expires.
create table if not exists mcp_keys (
  token_hash   text primary key,
  id           uuid not null default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null default '',
  created_ms   bigint not null,
  last_used_ms bigint,
  expires_ms   bigint,
  created_at   timestamptz not null default now()
);
create index if not exists mcp_keys_user on mcp_keys (user_id);
create unique index if not exists mcp_keys_id on mcp_keys (id);

-- What the key's bearer may reach: space-delimited `<product>:<level>`. '' is account-wide.
alter table mcp_keys add column if not exists scope text not null default '';

-- Soft close with a 30-day grace. A within-grace magic-link sign-in clears it, and authenticate
-- refuses any session whose user carries it.
alter table users add column if not exists deleted_at timestamptz;

-- granted_ms is set once and kept as the earliest; last_used_ms advances as the client's tokens
-- act.
create table if not exists oauth_grants (
  user_id      uuid not null references users(id) on delete cascade,
  client_id    text not null,
  granted_ms   bigint not null,
  last_used_ms bigint not null default 0,
  primary key (user_id, client_id)
);

-- The scope the human approved; '' is account-wide.
alter table oauth_grants add column if not exists scope text not null default '';

-- OAuth 2.1 for the MCP resource server. Only digests are at rest.
create table if not exists oauth_clients (
  client_id     text primary key,
  redirect_uris text[] not null,
  client_name   text not null default '',
  created_at    timestamptz not null default now()
);

-- The anonymous registration ceiling must stay a range scan over one hour, never a table scan.
create index if not exists oauth_clients_created on oauth_clients (created_at);

create table if not exists oauth_codes (
  code_hash      text primary key,      -- digest of the authorization code
  client_id      text not null,
  user_id        uuid not null references users(id) on delete cascade,
  redirect_uri   text not null,         -- must match the one the token request presents
  code_challenge text not null,         -- PKCE S256 challenge
  resource       text not null,         -- audience the eventual token is bound to
  scope          text not null default '',
  expires_ms     bigint not null,
  created_at     timestamptz not null default now()
);

create table if not exists oauth_tokens (
  token_hash         text primary key,  -- digest of the access token
  refresh_hash       text unique,       -- digest of the rotating refresh token
  client_id          text not null,
  user_id            uuid not null references users(id) on delete cascade,
  resource           text not null,     -- audience: the MCP server this token is valid for
  scope              text not null default '',
  expires_ms         bigint not null,   -- access-token expiry
  refresh_expires_ms bigint,            -- refresh-token expiry
  created_at         timestamptz not null default now()
);
create index if not exists oauth_tokens_user on oauth_tokens (user_id);
create index if not exists oauth_tokens_refresh on oauth_tokens (refresh_hash);
-- When this row's refresh token was spent. A rotated row stays as a tombstone with its access token
-- expired to 0 until the retention sweep collects it, so replaying a spent refresh token is
-- detectable and revokes the grant.
alter table oauth_tokens add column if not exists rotated_ms bigint;

-- Append-only. session_key is the client-minted per-browser id; user_id is resolved server-side,
-- never trusted from the body, null for a ghost.
create table if not exists events (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  client_ms   bigint,
  session_key text,
  user_id     uuid,
  name        text not null,
  props       jsonb
);
create index if not exists events_name_ts on events (name, ts);
-- The per-session ingest bound must stay a range scan over one session, never a scan of the stream.
create index if not exists events_session_ts on events (session_key, ts);

-- session_key is a client-minted correlation id, never identity; user_id is resolved server-side,
-- never trusted from the body, null for a ghost.
create table if not exists feedback (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  session_key text,
  user_id     uuid,
  message     text not null,
  email       text,
  context     text
);
create index if not exists feedback_ts on feedback (ts);

-- Exceptions that escaped a handler. method/path/message are best-effort; actor is null when the
-- caller could not be resolved.
create table if not exists server_errors (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  method  text,
  path    text,
  status  int not null default 500,
  message text,
  actor   uuid
);
create index if not exists server_errors_ts on server_errors (ts);

-- One append-only row per vendor call: counts and costs only, never content. user_id null = the
-- anonymous birth canvas. cost_nanos null = the model was absent from the price table, and the
-- ceilings read cost_floor_nanos instead. run_id groups one tool loop's iterations. Failures
-- record too.
create table if not exists ai_usage (
  id                 bigserial primary key,
  ts                 timestamptz not null default now(),
  user_id            uuid,
  product            text not null,
  operation          text not null,
  run_id             text not null default '',
  iteration          int  not null default 0,
  model              text not null,
  outcome            text not null default 'ok',  -- ok | truncated | refused | rate_limited | transport | schema_invalid
  input_tokens       bigint not null default 0,
  output_tokens      bigint not null default 0,
  cache_read_tokens  bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  cost_nanos         bigint,
  cost_floor_nanos   bigint not null default 0
);
alter table ai_usage add column if not exists cost_floor_nanos bigint not null default 0;
update ai_usage set cost_floor_nanos = cost_nanos where cost_floor_nanos = 0 and cost_nanos is not null;
create index if not exists ai_usage_user_ts on ai_usage (user_id, ts);
create index if not exists ai_usage_ts on ai_usage (ts);

-- ── Paddle billing ──────────────────────────────────────────────────────────────────────────
-- Every notification upserts here: access gating reads this database and never the Paddle API. An
-- account bridges to a Paddle customer by email (citext, matching users.email).
create table if not exists paddle_customers (
  customer_id text primary key,   -- "ctm_..."
  email       citext not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists paddle_customers_email on paddle_customers (email);

-- No foreign key to paddle_customers: deliveries are unordered, so an orphan row is legal and
-- reads as "no access".
create table if not exists paddle_subscriptions (
  subscription_id     text primary key,  -- "sub_..."
  customer_id         text not null,
  user_id             uuid,              -- the Windmill account, stamped via checkout custom_data
  status              text not null,     -- active | trialing | past_due | paused | canceled
  price_id            text not null default '',
  product_id          text not null default '',
  scheduled_change_at timestamptz,       -- set while a pause/cancel is pending; status stays active
  occurred_at         timestamptz,       -- Paddle's event time; a stale retry must not overwrite newer state
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists paddle_subscriptions_customer on paddle_subscriptions (customer_id);
-- Deliveries can land out of order: the upsert refuses to move occurred_at backwards.
alter table paddle_subscriptions add column if not exists occurred_at timestamptz;
-- Checkout stamps custom_data.user_id and the webhook lands it here. Gating reads it first and
-- falls back to the email match when it is null.
alter table paddle_subscriptions add column if not exists user_id uuid;
create index if not exists paddle_subscriptions_user on paddle_subscriptions (user_id);

-- ── Roadmap (products/roadmap), continued ────────────────────────────────────────────────────

-- ── Tending runs (server-side agent edits) ──────────────────────────────────────────────────
-- Durable state of a run that outlives its socket: the catch-up endpoint reads a row long after the
-- request that made it is gone. status is running/done/failed/refused; refusal '' = none.
-- started_at/finished_at are epoch ms from the service's clock, not now(). (seq_from, seq_to] is
-- the run's footprint in the tree's op log.
create table if not exists tend_runs (
  id           text primary key,
  tree_id      text not null,
  user_id      uuid not null,
  prompt       text not null,
  status       text not null default 'running',
  refusal      text not null default '',
  summary      text not null default '',
  detail       text not null default '',
  edits        int not null default 0,
  seq_from     bigint not null default 0,
  seq_to       bigint not null default 0,
  started_at   bigint not null default 0,
  finished_at  bigint not null default 0,
  created_node_ids jsonb not null default '[]',
  created_at   timestamptz not null default now()
);
alter table tend_runs add column if not exists refusal text not null default '';
alter table tend_runs add column if not exists detail text not null default '';
alter table tend_runs add column if not exists edits int not null default 0;
alter table tend_runs add column if not exists seq_from bigint not null default 0;
alter table tend_runs add column if not exists seq_to bigint not null default 0;
alter table tend_runs add column if not exists finished_at bigint not null default 0;
alter table tend_runs add column if not exists created_node_ids jsonb not null default '[]';
create index if not exists tend_runs_user_started on tend_runs (user_id, started_at);
create index if not exists tend_runs_tree on tend_runs (tree_id);

-- ── Weekly reminders (products/roadmap/domain/Reminders.h) ───────────────────────────────────
-- Do all calendar work in SQL via AT TIME ZONE: macOS and CI's Linux disagree in C++.
-- `next_due_at` is the materialized UTC instant of the next slot and the only thing the sweep
-- queries; NULL means never send, which the partial index enforces. slot_minute is confined to
-- 08:00–11:00 local so DST's nonexistent and ambiguous local times are unreachable. pause_digest is
-- a digest, never the secret.
create table if not exists reminder_subscription (
  user_id      uuid primary key references users(id) on delete cascade,
  enabled      boolean not null default false,
  iana_tz      text not null default '',
  slot_dow     int not null default 2 check (slot_dow between 1 and 7),      -- 1=Mon .. 7=Sun
  slot_minute  int not null default 540 check (slot_minute between 480 and 660),
  next_due_at  timestamptz,
  -- Set by the delivery webhook and by nothing else, on a permanent bounce or a complaint. It gates
  -- reminders only, never the sign-in path, and turning reminders on again lifts it.
  suppressed   boolean not null default false,
  pause_digest text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists reminder_due on reminder_subscription (next_due_at)
  where enabled and not suppressed and next_due_at is not null;
create unique index if not exists reminder_pause on reminder_subscription (pause_digest)
  where pause_digest <> '';

-- One row per eligible user per week; the primary key is the one-per-week mutex, and the claim
-- re-checks enabled/suppressed/deleted in its own transaction. A null sent_at is indistinguishable
-- from a lost update, so it must never be auto-retried. decision is 'sent' | 'skipped'; reason is
-- 'ok' | 'no-ready-steps' | 'recently-active' | 'in-grace' | 'too-late' | 'load-failed' | 'held' |
-- 'send-failed'.
create table if not exists reminder_week (
  user_id     uuid not null references users(id) on delete cascade,
  slot_date   date not null,          -- the LOCAL date of the slot; unique per week by construction
  decision    text not null,
  reason      text not null,
  tree_id     text,
  ready_count int not null default 0,
  sent_at     timestamptz,
  decided_at  timestamptz not null default now(),
  primary key (user_id, slot_date)
);
create index if not exists reminder_week_decided on reminder_week (decided_at);

-- ── The playable demo tree ──────────────────────────────────────────────────────────────────
-- Read anonymously over HTTP and WS: the row must exist and be public or read enforcement 404s it.
-- owner_id NULL leaves the tree unwritable by anyone. Stamps are the genesis HLC ('1:0:genesis');
-- '0:0:' is the never-set / never-deleted sentinel. Null positions leave the client to lay the tree
-- out from the DAG.
INSERT INTO trees (id, org_id, owner_id, title, visibility, head_seq, forked_from, document, deleted_at, created_at, updated_at, title_hlc, title_ms, title_counter) VALUES ('t_9e407a96b5330ebe', NULL, NULL, 'Learn to sail', 'public', 0, NULL, '{"nodes": []}', NULL, now(), now(), '', 0, 0)
ON CONFLICT DO NOTHING;

INSERT INTO tree_kinds (tree_id, kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, description_hlc, rank, rank_hlc) VALUES ('t_9e407a96b5330ebe', 'build', '1:0:genesis', '0:0:', 'terracotta', '1:0:genesis', 'Milestones', '1:0:genesis', 'The days you''ll remember', '1:0:genesis', 0, '1:0:genesis')
ON CONFLICT DO NOTHING;
INSERT INTO tree_kinds (tree_id, kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, description_hlc, rank, rank_hlc) VALUES ('t_9e407a96b5330ebe', 'learn', '1:0:genesis', '0:0:', 'olive', '1:0:genesis', 'Practice', '1:0:genesis', 'Hands on the boat — drills until they''re reflex', '1:0:genesis', 1, '1:0:genesis')
ON CONFLICT DO NOTHING;
INSERT INTO tree_kinds (tree_id, kind_id, created_hlc, deleted_hlc, hue, hue_hlc, label, label_hlc, description, description_hlc, rank, rank_hlc) VALUES ('t_9e407a96b5330ebe', 'milestone', '1:0:genesis', '0:0:', 'gold', '1:0:genesis', 'Theory', '1:0:genesis', 'What you learn ashore — wind, rules, weather', '1:0:genesis', 2, '1:0:genesis')
ON CONFLICT DO NOTHING;

INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'boat-parts', '1:0:genesis', '0:0:', 'Parts of the boat', '1:0:genesis', 'anchor', '1:0:genesis', 'gold', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'capsize', '1:0:genesis', '0:0:', 'Capsize & recover', '1:0:genesis', 'rotate-ccw', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'day-cruise', '1:0:genesis', '0:0:', 'Day cruise with crew', '1:0:genesis', 'users', '1:0:genesis', 'terracotta', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'docking', '1:0:genesis', '0:0:', 'Docking under sail', '1:0:genesis', 'anchor', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'dream', '1:0:genesis', '0:0:', 'Dream of sailing', '1:0:genesis', 'sparkles', '1:0:genesis', 'terracotta', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'first-aboard', '1:0:genesis', '0:0:', 'First time on board', '1:0:genesis', 'sailboat', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'first-solo', '1:0:genesis', '0:0:', 'First solo lap', '1:0:genesis', 'flag', '1:0:genesis', 'terracotta', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'forecast', '1:0:genesis', '0:0:', 'Read a forecast', '1:0:genesis', 'cloud-sun', '1:0:genesis', 'gold', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'jibing', '1:0:genesis', '0:0:', 'Jibing', '1:0:genesis', 'corner-down-right', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'mob-drill', '1:0:genesis', '0:0:', 'Man-overboard drill', '1:0:genesis', 'life-buoy', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'night-sail', '1:0:genesis', '0:0:', 'First night sail', '1:0:genesis', 'moon', '1:0:genesis', 'terracotta', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'points-of-sail', '1:0:genesis', '0:0:', 'Points of sail', '1:0:genesis', 'compass', '1:0:genesis', 'gold', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'rigging', '1:0:genesis', '0:0:', 'Rig the boat yourself', '1:0:genesis', 'cable', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'skipper-weekend', '1:0:genesis', '0:0:', 'Skipper a weekend trip', '1:0:genesis', 'map', '1:0:genesis', 'terracotta', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'tacking', '1:0:genesis', '0:0:', 'Tacking', '1:0:genesis', 'corner-up-right', '1:0:genesis', 'olive', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'water-rules', '1:0:genesis', '0:0:', 'Rules of the water', '1:0:genesis', 'scale', '1:0:genesis', 'gold', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;
INSERT INTO tree_nodes (tree_id, node_id, created_hlc, deleted_hlc, label, label_hlc, icon, icon_hlc, color, color_hlc, pos_x, pos_y, pos_hlc, status, status_hlc, description, description_hlc, links, links_hlc, present) VALUES ('t_9e407a96b5330ebe', 'wind-basics', '1:0:genesis', '0:0:', 'How wind moves a boat', '1:0:genesis', 'wind', '1:0:genesis', 'gold', '1:0:genesis', NULL, NULL, '0:0:', NULL, '0:0:', '', '0:0:', '[]', '0:0:', true)
ON CONFLICT DO NOTHING;

INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'boat-parts', 'first-aboard', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'capsize', 'first-solo', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'day-cruise', 'night-sail', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'day-cruise', 'skipper-weekend', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'dream', 'boat-parts', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'dream', 'wind-basics', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'first-aboard', 'rigging', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'first-solo', 'day-cruise', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'forecast', 'day-cruise', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'jibing', 'capsize', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'jibing', 'docking', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'mob-drill', 'first-solo', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'points-of-sail', 'forecast', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'points-of-sail', 'jibing', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'points-of-sail', 'tacking', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'points-of-sail', 'water-rules', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'rigging', 'jibing', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'rigging', 'tacking', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'tacking', 'docking', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'tacking', 'mob-drill', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'water-rules', 'day-cruise', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;
INSERT INTO tree_edges (tree_id, from_id, to_id, added_hlc, removed_hlc) VALUES ('t_9e407a96b5330ebe', 'wind-basics', 'points-of-sail', '1:0:genesis', '0:0:')
ON CONFLICT DO NOTHING;

-- The INSERT above no-ops on an existing row, so force the demo public and un-deleted here.
update trees set visibility = 'public', deleted_at = null where id = 't_9e407a96b5330ebe';

-- ── Journal (products/journal) ───────────────────────────────────────────────────────────────
-- One page per user per LOCAL day. Nothing is shared: every read is scoped `where user_id = $1`.
-- A user's devices converge last-writer-wins on (stamp_ms, stamp_counter).
create table if not exists journal_page (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,                    -- the writer's local ISO day, the key
  body          text not null default '',
  mood          smallint check (mood between 0 and 10),     -- null = not answered; 0 IS an answer
  energy        smallint check (energy between 0 and 10),   -- null = not answered; 0 IS an answer
  source        text not null default 'typed',    -- typed | spoken
  stamp_ms      bigint not null default 0,         -- HLC physical ms  ┐ the LWW guard; a write
  stamp_counter bigint not null default 0,         -- HLC counter      ┘ never goes backwards
  stamp_actor   text not null default '',          -- HLC actor (the writing device/replica)
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);
-- Both scales became 0..10 with null for unanswered (docs/design/journal/scales.md). Before that
-- mood was 1..5, energy 1..3, and 0 was the unset sentinel. The old rows are remapped once: mood
-- onto the odd positions (new = 2*old - 1), which is where the five shipped colour anchors sit, so
-- no migrated page changes colour on any glyph; energy onto the centre of each old third. The
-- remap is guarded on the column still being NOT NULL, which is true exactly once — a second run
-- would double the values it already moved. Constraint names verified against a live journal_page.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_page'
               and column_name = 'mood' and is_nullable = 'NO') then
    alter table journal_page alter column mood   drop default;
    alter table journal_page alter column energy drop default;
    alter table journal_page alter column mood   drop not null;
    alter table journal_page alter column energy drop not null;
    alter table journal_page drop constraint if exists journal_page_mood_check;
    alter table journal_page drop constraint if exists journal_page_energy_check;
    update journal_page set mood   = case mood   when 0 then null else 2 * mood - 1 end,
                            energy = case energy when 0 then null
                                                 when 1 then 2 when 2 then 5 when 3 then 8 end;
  end if;
end $$;

alter table journal_page drop constraint if exists journal_page_mood_check;
alter table journal_page drop constraint if exists journal_page_energy_check;
alter table journal_page add constraint journal_page_mood_check   check (mood   between 0 and 10);
alter table journal_page add constraint journal_page_energy_check check (energy between 0 and 10);

create index if not exists journal_page_user_day on journal_page (user_id, day);
create index if not exists journal_page_user_stamp on journal_page (user_id, stamp_ms, stamp_counter);

-- Superseded bodies, append-only and shown to nobody. Every superseding write prunes this table
-- inside its own transaction to ten revisions a day, five hundred rows and 8 MB per user, and
-- ninety days of age; nothing else deletes from here.
create table if not exists journal_page_revision (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,
  body          text not null,
  stamp_ms      bigint not null default 0,
  stamp_counter bigint not null default 0,
  stamp_actor   text not null default '',
  superseded_at timestamptz not null default now()
);
create index if not exists journal_page_revision_key on journal_page_revision (user_id, day);

-- ── Journal nudges (one a day at most) ───────────────────────────────────────────────────────
-- next_due_at is materialised by the DEVICE, so the server keeps no timezone; NULL means never
-- send, which the partial index enforces. slot_day is the local day next_due_at belongs to and is
-- both the "did they already write today?" key and the ledger key. pause_digest is a digest, never
-- the secret.
create table if not exists journal_nudge (
  user_id      uuid primary key references users(id) on delete cascade,
  enabled      boolean not null default false,
  channel      text not null default 'email',    -- email | inapp
  next_due_at  timestamptz,                       -- device-materialised; NULL ⇒ never send
  slot_day     date,                              -- the LOCAL day next_due_at belongs to
  paused_until timestamptz,                       -- "pause for a week", one tap
  -- Set by the delivery webhook and by nothing else, on a permanent bounce or a complaint. It gates
  -- nudges only, never the sign-in path, and turning nudges on again lifts it.
  suppressed   boolean not null default false,
  pause_digest text not null default '',
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists journal_nudge_due on journal_nudge (next_due_at)
  where enabled and not suppressed and next_due_at is not null;
create unique index if not exists journal_nudge_pause on journal_nudge (pause_digest)
  where pause_digest <> '';

-- One row per eligible user per day; the primary key is the one-per-day mutex. A null sent_at is
-- indistinguishable from a lost update, so it must never be auto-retried. decision is
-- 'sent' | 'skipped'; reason is 'ok' | 'already-wrote' | 'paused' | 'too-late' | 'held' |
-- 'send-failed'.
create table if not exists journal_nudge_day (
  user_id    uuid not null references users(id) on delete cascade,
  slot_day   date not null,
  decision   text not null,
  reason     text not null,
  sent_at    timestamptz,
  decided_at timestamptz not null default now(),
  primary key (user_id, slot_day)
);
create index if not exists journal_nudge_day_decided on journal_nudge_day (decided_at);

-- ── Journal echoes ───────────────────────────────────────────────────────────────────────────
-- An older passage of the writer's own set beside one written tonight. Written by the nightly sweep
-- and only for Windmill One subscribers, so everyone else's tables stay empty. Everything is
-- passage-level.

-- Guarded on a column the current shape lacks: an unguarded drop would delete real echoes on every
-- deploy.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_name = 'journal_echo' and column_name = 'trigger_lo') then
    drop table journal_echo;
  end if;
end $$;

drop table if exists journal_page_vector;

-- Mint span ids here only: sweeps can overlap, so max(span_id)+1 is a race with no lock behind it.
create sequence if not exists journal_span_id_seq;

-- One segmented passage of one page. span_id is the identity; (day, ord) is only a coordinate, and
-- re-derivation carries span_id forward for every passage whose normalised text survives.
-- vector is float32, little-endian, four bytes per dimension, in a bytea — never a real[].
-- text_sha256 digests the normalised text: outer whitespace trimmed, internal runs collapsed.
-- Retrieval must read one embed_version only; cosine between two embedding spaces is meaningless.
create table if not exists journal_span (
  user_id       uuid not null references users(id) on delete cascade,
  span_id       bigint not null,
  day           date not null,
  ord           int not null,
  lo            int not null,                    -- BYTE offsets into the page body [lo, hi); they
  hi            int not null,                    -- never leave the server (JS slices UTF-16)
  text          text not null,
  text_sha256   bytea not null,
  vector        bytea not null,
  embed_version text not null,
  body_stamp_ms bigint not null default 0,       -- the page HLC ms this derivation read
  primary key (user_id, span_id)
);
create index if not exists journal_span_page on journal_span (user_id, day, ord);
create index if not exists journal_span_hash on journal_span (user_id, text_sha256);

-- cosine is what retrieval measured. relation is the curator's judgement and is comparable only
-- within one call. curator_version folds in the digest of the curator's own system prompt.
-- match_is_self false means the older passage is something the writer copied down, not their words.
create table if not exists journal_echo (
  user_id         uuid not null references users(id) on delete cascade,
  trigger_day     date not null,
  trigger_span_id bigint not null,
  match_day       date not null,
  match_span_id   bigint not null,
  cosine          real not null default 0,
  relation        real not null default 0,
  match_is_self   boolean not null default true,
  curator_version text not null default '',
  created_at      timestamptz not null default now(),
  primary key (user_id, trigger_span_id, match_span_id),
  check (match_day < trigger_day)
);
alter table journal_echo drop column if exists prompt_hash;
create index if not exists journal_echo_page on journal_echo (user_id, trigger_day);
-- The reverse edge: finds every page holding an echo into a page whose passages changed.
create index if not exists journal_echo_inbound on journal_echo (user_id, match_day);

-- The reader told a pairing to fade. Keyed on the content of both passages, never on span ids or
-- days, so a dismissal survives re-derivation and re-segmentation.
create table if not exists journal_echo_dismissal (
  user_id      uuid not null references users(id) on delete cascade,
  trigger_hash bytea not null,
  match_hash   bytea not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, trigger_hash, match_hash)
);

-- What the reader said about one pairing. kind is 'opened' | 'useful' | 'not_useful' and is in the
-- primary key so the three answers coexist; every insert is ON CONFLICT DO NOTHING, so pressing a
-- button twice is one row. cosine, relation and curator_version are copied in as they stood.
create table if not exists journal_echo_signal (
  user_id         uuid not null references users(id) on delete cascade,
  trigger_day     date not null,
  trigger_span_id bigint not null,
  match_day       date not null,
  match_span_id   bigint not null,
  kind            text not null,
  cosine          real not null default 0,
  relation        real not null default 0,
  curator_version text not null default '',
  created_at      timestamptz not null default now(),
  primary key (user_id, trigger_span_id, match_span_id, kind)
);
create index if not exists journal_echo_signal_page
  on journal_echo_signal (user_id, trigger_day, kind);

-- The reader declined the upgrade offer on this page. Keyed on the day and not on a passage hash,
-- so rewriting the page's text does not put the offer back.
create table if not exists journal_echo_offer_dismissal (
  user_id    uuid not null references users(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- body_stamp_ms is the page HLC ms the derivation read; corpus_stamp is a FINGERPRINT (md5, 60 bits)
-- of every span the writer holds, compared for SAMENESS and never for order. It was the newest
-- body_stamp_ms across those spans, which is monotone only while a corpus grows: emptying a page
-- could LOWER it, and `corpus_stamp < stored` then reopened nothing at all.
-- These stamps are the "am I done" record: never advance them on a failed curate. status is
-- ok | empty_ok | transport | rate_limited | truncated | schema_invalid | refused; ok, empty_ok and
-- refused advance them, the rest do not. The due queries skip a refused row on corpus movement, so
-- only an edit to that body makes it due again. attempts counts consecutive unsettled failures, and
-- the due queries stop reopening a page past kCurationRetries of them — an unsettled page is due on
-- its status, and without the bound a body nothing can fix is re-derived, and re-bought, forever.
-- An unsettled pass still records the version columns for the steps that DID land, so work already
-- paid for is not paid for twice.
create table if not exists journal_page_curation (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,
  body_stamp_ms bigint not null default 0,
  corpus_stamp  bigint not null default 0,
  status        text not null default '',
  attempts      int not null default 0,
  last_error    text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);
-- Which pipeline derived the page; a change here is what makes it due again after a segmenter or
-- embedder change. The empty default reads as "not the current pipeline".
alter table journal_page_curation add column if not exists segment_version text not null default '';
alter table journal_page_curation add column if not exists embed_version   text not null default '';
-- The judging half: the curator's prompt and effort plus a digest of the selection knobs.
alter table journal_page_curation add column if not exists judge_version   text not null default '';

-- ── Gym (products/gym) ───────────────────────────────────────────────────────────────────────
-- Every gym_* row is owner-scoped and cascades on account deletion: every route stays
-- `WHERE user_id = :caller`, and the only reader who is not the owner comes in through
-- gym_session_shares. All date/time work stays in SQL; instants cross the wire and the domain as
-- epoch-ms. Create order is FK order.

-- id is a stable slug ('back-squat'), never renamed and never displayed; name is the mutable
-- display string, so every set keeps pointing at the same id across a rename. created_by NULL marks
-- a catalog seed; every read is `created_by IS NULL OR created_by = :caller`.
create table if not exists gym_exercises (
  id          text primary key,
  name        text not null,
  pattern     text not null check (pattern in
                ('squat','hinge','press','pull','carry','core','isolation')),
  equipment   text not null check (equipment in
                ('barbell','dumbbell','machine','cable','bodyweight','kettlebell')),
  step_kg     numeric(4,2) not null default 2.5,   -- per-movement increment, seeded and served;
                                                   -- read by nothing today
  created_by  uuid references users(id) on delete cascade,   -- null = catalog seed
  created_at  timestamptz not null default now()
);

-- What a lifter calls a SEEDED movement. Seed rows are global, so renaming one writes a line here
-- and every read coalesces it over the seed's name; a movement the lifter created renames in place
-- on its own row instead. Renaming back to the seed name deletes the row.
create table if not exists gym_exercise_names (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- Former names for a movement; the picker searches aliases beside the current name. The name is
-- part of the primary key, so renaming back to one is a delete of a single row. The write caps the
-- list per movement, because this row set ships on the catalog read.
create table if not exists gym_exercise_aliases (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, exercise_id, name)
);
create index if not exists gym_exercise_aliases_user on gym_exercise_aliases (user_id);

-- A routine is written as a whole document in one transaction, the row and its entries together, so
-- a routine holding no entries is not a state this schema can be left in. The client-minted id is
-- the idempotency key.
create table if not exists gym_routines (
  id          text primary key,                     -- client-minted 'rt_<hex>'
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists gym_routines_user on gym_routines (user_id, position);
-- The concurrency token a proposal is minted against: an apply lands only while the routine still
-- stands at the revision its diff was computed from. It moves on every write that changes the
-- document, superseding a pending proposal in the same transaction; a client reads it, never sends
-- it.
alter table gym_routines add column if not exists revision int not null default 1;

-- Both columns are written by the create and by nothing else. created_entries is the line count the
-- routine was built with, stored rather than counted at read time so a later edit cannot rewrite
-- it. created_door is the agent door that made it; null is the lifter's own hand.
alter table gym_routines add column if not exists created_entries int;
alter table gym_routines add column if not exists created_door text
  check (created_door in ('mcp','ask'));

-- Positions are dense and 1-based; entries have no id, their key is their position, and a replace
-- lays the whole run down again. The same movement twice is two rows.
create table if not exists gym_routine_entries (
  routine_id       text not null references gym_routines(id) on delete cascade,
  position         int  not null check (position >= 1),
  exercise_id      text not null references gym_exercises(id),
  target_sets      int  check (target_sets between 1 and 20),                   -- null = open
  target_reps      int  check (target_reps between 1 and 100),                  -- null = max
  target_weight_kg numeric(6,2) check (target_weight_kg between -500 and 500),  -- null = last time
  rest_seconds     int check (rest_seconds between 15 and 900),                 -- null = client default
  primary key (routine_id, position)
);
alter table gym_routine_entries alter column target_reps drop not null;
alter table gym_routine_entries alter column target_reps drop default;
alter table gym_routine_entries alter column target_sets drop not null;
alter table gym_routine_entries alter column target_sets drop default;

-- An agent mints a row here and nothing moves until the lifter applies it. No tool at any grant
-- level writes `applied`; only the owner-scoped routes do. base_revision and base_name are frozen
-- at mint: an apply lands only while gym_routines.revision still equals base_revision, and a routine
-- that moved is superseded, never merged over. door / connection / agent are provenance; connection
-- and agent are empty from every door today.
create table if not exists gym_proposals (
  id            text primary key,                   -- client-minted 'prop_<hex>', the idempotency key
  routine_id    text not null references gym_routines(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  intent        text not null check (intent in ('revise','remove')),
  base_revision int  not null,
  base_name     text not null,
  proposed_name text not null,
  summary       text not null default '',
  changes       int  not null default 0,            -- `Apply all N`: rows that move + a rename + a reorder
  state         text not null check (state in ('pending','applied','dismissed','superseded')),
  door          text not null check (door in ('mcp','ask')),
  connection    text not null default '',
  agent         text not null default '',
  created_at    timestamptz not null,
  settled_at    timestamptz
);
-- One pending proposal per (routine, door, connection): this index is the arbiter, never an
-- application check.
create unique index if not exists gym_proposals_one_pending
  on gym_proposals (routine_id, door, connection) where state = 'pending';
create index if not exists gym_proposals_routine on gym_proposals (routine_id, created_at desc);
create index if not exists gym_proposals_user on gym_proposals (user_id, state, created_at desc);

-- Rows 1..k are the run the routine takes on, in order; rows k+1..n are the lines the proposal
-- takes away. Every before_*/after_* pair mirrors gym_routine_entries' own columns. The whole
-- `before` side is null on an added line and the whole `after` side on a removed one. No CHECKs on
-- the target columns: a bound tightened on gym_routine_entries must never make an already-minted
-- proposal unreadable.
create table if not exists gym_proposal_changes (
  proposal_id         text not null references gym_proposals(id) on delete cascade,
  position            int  not null check (position >= 1),
  user_id             uuid not null references users(id) on delete cascade,
  kind                text not null check (kind in ('kept','added','removed','retargeted')),
  exercise_id         text not null references gym_exercises(id),
  before_sets         int,
  before_reps         int,
  before_weight_kg    numeric(6,2),
  before_rest_seconds int,
  after_sets          int,
  after_reps          int,
  after_weight_kg     numeric(6,2),
  after_rest_seconds  int,
  primary key (proposal_id, position)
);

-- id is client-minted ('ses_<hex>') and is the idempotency key: a double-tapped start, an offline
-- replay and a retried POST all conflict on the PK and no-op. One open session per user, enforced by
-- the partial unique index: starting while another is open joins that session, unless the caller
-- states it will not join, in which case the no-op is a refusal. plan is a frozen jsonb copy of the
-- routine at start, composed by the server and never by a client (null = ad-hoc); routine_id is
-- informational and the snapshot is the truth. started_at/finished_at are client wall-clock
-- instants.
create table if not exists gym_sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  routine_id  text references gym_routines(id) on delete set null,
  plan        jsonb,
  started_at  timestamptz not null,
  finished_at timestamptz,
  -- 'finish' is the lifter's own close and final; 'stale' is the four-hour guess, closed at the
  -- last landed set, and a set landing within four hours of finished_at continues that workout and
  -- moves finished_at forward. NULL reads as 'finish'.
  closed_by   text check (closed_by in ('finish', 'stale'))
);
alter table gym_sessions add column if not exists closed_by text check (closed_by in ('finish', 'stale'));
create index if not exists gym_sessions_log on gym_sessions (user_id, started_at desc);
create unique index if not exists gym_sessions_one_open on gym_sessions (user_id)
  where finished_at is null;

-- One row per set that currently stands; a correction rewrites the row and keeps what it replaced
-- in gym_set_revisions. The client-minted id ('set_<hex>') makes the flush queue replayable, and a
-- delete spends the id for good: an insert asks gym_set_revisions whether the id names a deleted set
-- before it writes. set_number is server-assigned max+1 per (session, exercise), never count+1, and
-- nothing renumbers after a delete. Weights are kg; negative is legal (band-assisted). Only working
-- sets count toward volume.
create table if not exists gym_sets (
  id           text primary key,
  session_id   text not null references gym_sessions(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  exercise_id  text not null references gym_exercises(id),
  set_number   int  not null check (set_number >= 1),
  weight_kg    numeric(6,2) not null check (weight_kg between -500 and 500),
  reps         int  not null check (reps between 1 and 500),
  kind         text not null default 'working' check (kind in
                 ('warmup','working','drop','failure')),
  rpe          numeric(3,1) check (rpe between 1 and 10),
  note         text not null default '',
  completed_at timestamptz not null
);
create index if not exists gym_sets_session  on gym_sets (session_id, set_number);
create index if not exists gym_sets_history  on gym_sets (user_id, exercise_id, completed_at desc);

-- What a correction replaced and what a delete took out of the log: a fix appends the version it
-- replaced, a delete moves the row here whole and marked `deleted`. Nothing shows this table to a
-- lifter; the one read asks whether an id names a set this account deleted. set_id carries no
-- foreign key: a deleted set's row is gone from gym_sets and this table outlives it.
create table if not exists gym_set_revisions (
  revision_id  bigserial primary key,
  set_id       text not null,
  session_id   text not null references gym_sessions(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  exercise_id  text not null references gym_exercises(id),
  set_number   int  not null,
  weight_kg    numeric(6,2) not null,
  reps         int  not null,
  kind         text not null,
  rpe          numeric(3,1),
  note         text not null default '',
  completed_at timestamptz not null,
  deleted      boolean not null default false,   -- true = the set left the log; false = it was rewritten
  replaced_at  timestamptz not null default now()
);
-- No CHECKs: a constraint tightened on gym_sets later must never make the history of a set
-- unwritable.
create index if not exists gym_set_revisions_set on gym_set_revisions (set_id, replaced_at);

-- The coach share. session_id is the primary key, so a repeated mint is idempotent and hands back
-- the same link. The token is minted by the server, never accepted from a client, and stored in the
-- clear because a repeat mint must return it. expires_at ends the capability; revocation is
-- deleting the row, and nothing is marked or swept.
create table if not exists gym_session_shares (
  session_id  text primary key references gym_sessions(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists gym_session_shares_user on gym_session_shares (user_id);

-- One row per account, not per device. `units` is a display transform and nothing else: every
-- weight in this schema is kilograms and no read is scoped by it. Every default here also sits in
-- products/gym/domain/Preferences.h, which is what a client that has never written is served: the
-- two must not disagree. rest_seconds bounds match a routine line's rest target.
create table if not exists gym_preferences (
  user_id         uuid primary key references users(id) on delete cascade,
  units           text not null default 'kg' check (units in ('kg','lb')),
  rest_seconds    int check (rest_seconds between 15 and 900),   -- null = no timer
  rest_sound      boolean not null default true,
  confirm_haptic  boolean not null default true,
  confirm_sound   boolean not null default false,
  updated_at      timestamptz not null default now()
);

alter table gym_preferences drop column if exists bar_weight_kg;
alter table gym_preferences drop column if exists plates_kg;

-- Ask's threads. title is the first message verbatim, written once at creation and never by a
-- model. asked_at is the newest turn's instant and what the list sorts and dates by; created_at
-- dates the question that named the thread. Both are the server's clock, unlike the log's instants.
create table if not exists gym_ask_threads (
  id         text primary key,                  -- client-minted 'thr_<hex>', the idempotency key
  user_id    uuid not null references users(id) on delete cascade,
  title      text not null,
  created_at timestamptz not null,
  asked_at   timestamptz not null
);
create index if not exists gym_ask_threads_user on gym_ask_threads (user_id, asked_at desc);

-- The turns, stored as sent, byte for byte. Written a pair at a time and only after an answer
-- lands, so a failed ask leaves this table exactly as it found it and the retry appends once.
create table if not exists gym_ask_turns (
  thread_id   text not null references gym_ask_threads(id) on delete cascade,
  position    int  not null check (position >= 1),
  user_id     uuid not null references users(id) on delete cascade,
  from_lifter boolean not null,
  text        text not null,
  said_at     timestamptz not null,
  primary key (thread_id, position)
);

-- Which conversation minted this proposal. Null for every MCP-door proposal and for one whose
-- thread was deleted; both read to a client as nothing to open.
alter table gym_proposals add column if not exists thread_id text
  references gym_ask_threads(id) on delete set null;
create index if not exists gym_proposals_thread on gym_proposals (thread_id);

-- The catalog seed. step_kg by equipment, in kg: barbell 2.5, dumbbell 2.0, machine 5.0, cable 2.5,
-- bodyweight 2.5, kettlebell 4.0. ON CONFLICT DO NOTHING so a redeploy never clobbers a rename.
insert into gym_exercises (id, name, pattern, equipment, step_kg) values
  ('back-squat',                 'Back Squat',                 'squat',     'barbell',    2.5),
  ('front-squat',                'Front Squat',                'squat',     'barbell',    2.5),
  ('goblet-squat',               'Goblet Squat',               'squat',     'dumbbell',   2.0),
  ('bulgarian-split-squat',      'Bulgarian Split Squat',      'squat',     'dumbbell',   2.0),
  ('walking-lunge',              'Walking Lunge',              'squat',     'dumbbell',   2.0),
  ('step-up',                    'Step Up',                    'squat',     'dumbbell',   2.0),
  ('leg-press',                  'Leg Press',                  'squat',     'machine',    5.0),
  ('hack-squat',                 'Hack Squat',                 'squat',     'machine',    5.0),
  ('deadlift',                   'Deadlift',                   'hinge',     'barbell',    2.5),
  ('sumo-deadlift',              'Sumo Deadlift',              'hinge',     'barbell',    2.5),
  ('romanian-deadlift',          'Romanian Deadlift',          'hinge',     'barbell',    2.5),
  ('trap-bar-deadlift',          'Trap Bar Deadlift',          'hinge',     'barbell',    2.5),
  ('good-morning',               'Good Morning',               'hinge',     'barbell',    2.5),
  ('hip-thrust',                 'Hip Thrust',                 'hinge',     'barbell',    2.5),
  ('back-extension',             'Back Extension',             'hinge',     'bodyweight', 2.5),
  ('kettlebell-swing',           'Kettlebell Swing',           'hinge',     'kettlebell', 4.0),
  ('bench-press',                'Bench Press',                'press',     'barbell',    2.5),
  ('incline-bench-press',        'Incline Bench Press',        'press',     'barbell',    2.5),
  ('close-grip-bench-press',     'Close Grip Bench Press',     'press',     'barbell',    2.5),
  ('overhead-press',             'Overhead Press',             'press',     'barbell',    2.5),
  ('push-press',                 'Push Press',                 'press',     'barbell',    2.5),
  ('dumbbell-bench-press',       'Dumbbell Bench Press',       'press',     'dumbbell',   2.0),
  ('incline-dumbbell-press',     'Incline Dumbbell Press',     'press',     'dumbbell',   2.0),
  ('dumbbell-shoulder-press',    'Dumbbell Shoulder Press',    'press',     'dumbbell',   2.0),
  ('machine-chest-press',        'Machine Chest Press',        'press',     'machine',    5.0),
  ('machine-shoulder-press',     'Machine Shoulder Press',     'press',     'machine',    5.0),
  ('dip',                        'Dip',                        'press',     'bodyweight', 2.5),
  ('push-up',                    'Push Up',                    'press',     'bodyweight', 2.5),
  ('pull-up',                    'Pull Up',                    'pull',      'bodyweight', 2.5),
  ('chin-up',                    'Chin Up',                    'pull',      'bodyweight', 2.5),
  ('muscle-up',                  'Muscle Up',                  'pull',      'bodyweight', 2.5),
  ('lat-pulldown',               'Lat Pulldown',               'pull',      'cable',      2.5),
  ('barbell-row',                'Barbell Row',                'pull',      'barbell',    2.5),
  ('dumbbell-row',               'Dumbbell Row',               'pull',      'dumbbell',   2.0),
  ('chest-supported-row',        'Chest Supported Row',        'pull',      'machine',    5.0),
  ('seated-cable-row',           'Seated Cable Row',           'pull',      'cable',      2.5),
  ('face-pull',                  'Face Pull',                  'pull',      'cable',      2.5),
  ('barbell-shrug',              'Barbell Shrug',              'pull',      'barbell',    2.5),
  ('inverted-row',               'Inverted Row',               'pull',      'bodyweight', 2.5),
  ('farmers-carry',              'Farmers Carry',              'carry',     'dumbbell',   2.0),
  ('suitcase-carry',             'Suitcase Carry',             'carry',     'dumbbell',   2.0),
  ('overhead-carry',             'Overhead Carry',             'carry',     'dumbbell',   2.0),
  ('plank',                      'Plank',                      'core',      'bodyweight', 2.5),
  ('hanging-leg-raise',          'Hanging Leg Raise',          'core',      'bodyweight', 2.5),
  ('ab-wheel-rollout',           'Ab Wheel Rollout',           'core',      'bodyweight', 2.5),
  ('cable-crunch',               'Cable Crunch',               'core',      'cable',      2.5),
  ('pallof-press',               'Pallof Press',               'core',      'cable',      2.5),
  ('weighted-sit-up',            'Weighted Sit Up',            'core',      'bodyweight', 2.5),
  ('barbell-curl',               'Barbell Curl',               'isolation', 'barbell',    2.5),
  ('dumbbell-curl',              'Dumbbell Curl',              'isolation', 'dumbbell',   2.0),
  ('hammer-curl',                'Hammer Curl',                'isolation', 'dumbbell',   2.0),
  ('triceps-pushdown',           'Triceps Pushdown',           'isolation', 'cable',      2.5),
  ('skull-crusher',              'Skull Crusher',              'isolation', 'barbell',    2.5),
  ('overhead-triceps-extension', 'Overhead Triceps Extension', 'isolation', 'dumbbell',   2.0),
  ('lateral-raise',              'Lateral Raise',              'isolation', 'dumbbell',   2.0),
  ('rear-delt-fly',              'Rear Delt Fly',              'isolation', 'dumbbell',   2.0),
  ('dumbbell-fly',               'Dumbbell Fly',               'isolation', 'dumbbell',   2.0),
  ('cable-fly',                  'Cable Fly',                  'isolation', 'cable',      2.5),
  ('leg-extension',              'Leg Extension',              'isolation', 'machine',    5.0),
  ('lying-leg-curl',             'Lying Leg Curl',             'isolation', 'machine',    5.0),
  ('standing-calf-raise',        'Standing Calf Raise',        'isolation', 'machine',    5.0),
  ('seated-calf-raise',          'Seated Calf Raise',          'isolation', 'machine',    5.0),
  ('wrist-curl',                 'Wrist Curl',                 'isolation', 'barbell',    2.5),
  ('hip-abduction',              'Hip Abduction',              'isolation', 'machine',    5.0)
on conflict (id) do nothing;
