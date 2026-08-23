-- Windmill backend schema. Applied in order and re-applied on every deploy, so every statement
-- must be idempotent. Grouped by FK dependency, which is why the per-product banners alternate.
-- Source paths cited below are relative to `backend/`.

create extension if not exists citext;

-- ── Platform (platform/) ─────────────────────────────────────────────────────────────────────
-- Read and written by platform/adapters/postgres, never by a product's repository.

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
-- Read and written by products/roadmap/adapters/postgres. Tending runs, weekly reminders and the
-- demo seed are roadmap's too and sit further down, past the platform run between them.

-- title is an LWW register: `title_hlc` is its stamp in canonical HLC text ('' = unset), and
-- `title_ms`/`title_counter` are that stamp's numeric split so the write is LWW-guarded in SQL.
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
-- visibility gates every read (platform/domain/Access.h): 'private' is owner-only,
-- 'unlisted'/'public' are readable by anyone holding the id.
alter table trees add column if not exists visibility text not null default 'private';
alter table trees alter column visibility set default 'private';

create index if not exists trees_owner on trees (owner_id) where deleted_at is null;
create index if not exists trees_forked_from on trees (forked_from) where deleted_at is null;
create index if not exists trees_public on trees (visibility) where visibility = 'public' and deleted_at is null;

-- The tree lattice, one row per CRDT entry. Entry-grow-only — a delete is a tombstone stamp, so
-- saves are pure upserts and rows are never deleted. Stamps are canonical HLC text
-- ("physicalMs:counter:actor", '' = unset), never compared in SQL; `present` is the writer's
-- projection flag for read-side use.
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

-- The share unfurl card served by GET /og/:id.png; a missing card falls back to the generic
-- image. No FK to trees: addressed by tree id and read behind the tree's own visibility gate.
create table if not exists tree_og_images (
  tree_id    text primary key,
  png        bytea not null,
  updated_at timestamptz not null default now()
);

-- The share video served by GET /v1/trees/:id/og-video, with the og:image card as poster
-- fallback; a missing video is a plain 404. No FK to trees, same as tree_og_images.
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

-- Per-user private progress overlay, a last-writer-wins register per node. `status` is a stamped
-- value including 'none' — a clear is a value, never a row delete. `stamp_ms`/`stamp_counter` are
-- the HLC split out for numeric LWW; the room clock mints a unique (ms, counter) per write, so the
-- pair totally orders every write to a tree.
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

-- Passwordless sign-in (AUTH.md). A magic link is addressed by the digest of its secret; the raw
-- token is never at rest. Lifetimes are epoch-millisecond bigints. consumed_ms is null until spent.
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
-- The 6-digit code twin lives ON the link's row; either credential flips consumed_ms. At the
-- attempts cap (domain/Auth.h) the row stops resolving.
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

-- `id` is the public per-session handle the revoke endpoint addresses; the digest stays
-- server-side. user_agent/ip are stored raw — the server never geo-resolves. last_seen_ms rolls
-- forward on every authenticated use; 0 means never recorded and the list reads created_at.
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
alter table sessions add column if not exists user_agent text not null default '';
alter table sessions add column if not exists last_seen_ms bigint not null default 0;
alter table sessions add column if not exists ip text not null default '';
create unique index if not exists sessions_id on sessions (id);

-- Provider sign-in doors (AUTH.md). The provider-issued SUBJECT is the identity and (provider,
-- subject) is the key, so a provider that changes the address behind an account still resolves to
-- the same user; the email is only ever a hint. email_at_link records the address the door came in
-- on and is never read to resolve anyone.
create table if not exists user_identities (
  provider      text not null check (provider in ('google','apple')),
  subject       text not null,
  user_id       uuid not null references users(id) on delete cascade,
  email_at_link text not null default '',
  created_at    timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists user_identities_user on user_identities (user_id);

-- Personal MCP API keys: a long-lived per-user bearer token, the static-token fallback for
-- OAuth-less clients. Keyed by the digest of its secret; the raw token is never stored. `id` is the
-- public per-key handle the revoke endpoint addresses. expires_ms null = never expires.
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

-- What the key's bearer may reach: space-delimited `<product>:<level>`, the same spelling the
-- OAuth grants use. '' is the account-wide grant.
alter table mcp_keys add column if not exists scope text not null default '';

-- Soft close with a 30-day grace: `deleted_at` stamps the request. A within-grace magic-link
-- sign-in clears it, and authenticate refuses any session whose user carries it.
alter table users add column if not exists deleted_at timestamptz;

-- The per-user, per-client authorization record. granted_ms is set once and kept as the earliest;
-- last_used_ms advances as the client's tokens act. Neither lives on the rotating token rows.
create table if not exists oauth_grants (
  user_id      uuid not null references users(id) on delete cascade,
  client_id    text not null,
  granted_ms   bigint not null,
  last_used_ms bigint not null default 0,
  primary key (user_id, client_id)
);

-- The scope the human approved. It lives on the grant, not on the hourly-rotating tokens.
-- '' is the account-wide grant.
alter table oauth_grants add column if not exists scope text not null default '';

-- OAuth 2.1 for the MCP resource server: dynamically-registered public clients, single-use
-- PKCE-bound authorization codes, audience-bound opaque tokens. Only digests are at rest.
create table if not exists oauth_clients (
  client_id     text primary key,
  redirect_uris text[] not null,
  client_name   text not null default '',
  created_at    timestamptz not null default now()
);

-- The registration burst ceiling runs on the anonymous path, so it must stay an index range scan
-- over one hour and never a table scan. The retention sweep's TTL pass reads it too.
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
-- When this row's refresh token was spent. A rotated row is NOT deleted: it stays as a tombstone
-- with its access token expired to 0, until the retention sweep collects it, so presenting an
-- already-spent refresh token is recognisable and revokes the grant (OAuth 2.1 §4.14.2).
alter table oauth_tokens add column if not exists rotated_ms bigint;

-- Append-only stream of beacon events. session_key is the client-minted per-browser id; user_id is
-- resolved server-side from the cookie / Bearer token, never trusted from the body, null for a ghost.
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

-- Notes from anyone, signed-in or ghost. session_key is a client-minted correlation id, never
-- identity; user_id is resolved server-side, never trusted from the body, null for a ghost.
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

-- Exceptions that escaped an HTTP/WS handler; the per-handler try/catch paths never land here.
-- method/path/message are best-effort and actor is nullable — a handler often can't resolve a caller.
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
-- anonymous birth canvas. cost_nanos null = the model was absent from the price table, and
-- cost_floor_nanos is what the ceilings read instead, priced at the dearest rate we know. run_id
-- groups one tool loop's iterations into one logical operation. Failures record too.
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
-- Webhooks are the source of truth: every notification upserts here, so access gating reads this
-- database and never the Paddle API. A Windmill account bridges to a Paddle customer by EMAIL
-- (citext, matching users.email).
create table if not exists paddle_customers (
  customer_id text primary key,   -- "ctm_..."
  email       citext not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists paddle_customers_email on paddle_customers (email);

-- No foreign key to paddle_customers: Paddle does not order its deliveries, so a subscription
-- event can arrive before the customer event it references, and an orphan row reads as "no access".
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
-- Paddle retries a failed delivery for ~3 days, so an OLD event can land AFTER a newer one: every
-- write carries the event's occurred_at and the upsert refuses to go backwards.
alter table paddle_subscriptions add column if not exists occurred_at timestamptz;
-- Checkout stamps custom_data.user_id on the transaction and the webhook lands it here. Gating
-- reads this first and falls back to the email match for subscriptions created outside that flow.
alter table paddle_subscriptions add column if not exists user_id uuid;
create index if not exists paddle_subscriptions_user on paddle_subscriptions (user_id);

-- ── Roadmap (products/roadmap), continued ────────────────────────────────────────────────────

-- ── Tending runs (server-side agent edits) ──────────────────────────────────────────────────
-- One row per sentence someone told their tree (products/roadmap/domain/Tending.h). A tend run is a
-- job that outlives the socket, and this table is its durable state — the catch-up endpoint reads a
-- row long after the request that made it died. status is running/done/failed/refused; refusal ''
-- = none. started_at/finished_at are epoch ms from TendRun's own clock, not now(). (seq_from,
-- seq_to] is the run's footprint in the tree's op log.
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
-- Keep all calendar work in SQL via AT TIME ZONE: Postgres ships its own IANA database, so macOS
-- and CI's Linux agree where C++ calendar functions do not.
-- `next_due_at` is the materialized UTC instant of the next slot and the ONLY thing the sweep
-- queries; NULL whenever we cannot know when to send, so "unknown ⇒ never send" falls out of the
-- partial index. slot_minute is confined to 08:00–11:00 local so DST's nonexistent and ambiguous
-- local times are unreachable. pause_digest is the pause link's credential — a digest, never the secret.
create table if not exists reminder_subscription (
  user_id      uuid primary key references users(id) on delete cascade,
  enabled      boolean not null default false,
  iana_tz      text not null default '',
  slot_dow     int not null default 2 check (slot_dow between 1 and 7),      -- 1=Mon .. 7=Sun
  slot_minute  int not null default 540 check (slot_minute between 480 and 660),
  next_due_at  timestamptz,
  -- Hard bounce / spam complaint, set by Resend's delivery webhook and by nothing else; only a
  -- PERMANENT bounce or a complaint gets here (platform/domain/Mail.h holds that rule). It is a
  -- fact about the MAILBOX and never an edit to `enabled`, it gates reminders only and nothing in
  -- the sign-in path reads it, and turning reminders on again lifts it.
  suppressed   boolean not null default false,
  pause_digest text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists reminder_due on reminder_subscription (next_due_at)
  where enabled and not suppressed and next_due_at is not null;
create unique index if not exists reminder_pause on reminder_subscription (pause_digest)
  where pause_digest <> '';

-- One row per eligible user per week. The primary key IS the "at most one per 7 days" mutex, never
-- enforced by comparing timestamps at read time; the claim re-checks enabled/suppressed/deleted in
-- its own transaction, so someone who pauses mid-batch gets no row. A null sent_at is
-- indistinguishable from a lost update, so it must NEVER be auto-retried. decision is
-- 'sent' | 'skipped'; reason is 'ok' | 'no-ready-steps' | 'recently-active' | 'in-grace' |
-- 'too-late' | 'load-failed' | 'held' | 'send-failed', the last three stamped after the decision.
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
-- Read anonymously over HTTP and WS: the row must exist AND be public or read enforcement 404s it.
-- owner_id is NULL on purpose — an unowned tree is nobody's to write (canWrite,
-- platform/domain/Access.h) — and the ON CONFLICT means a row that was claimed will not self-heal.
-- Stamps are the genesis HLC ('1:0:genesis'); '0:0:' is the never-set / never-deleted sentinel.
-- Positions are null: the client lays the tree out radially from the DAG.
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
-- One page per user per LOCAL day; the (user, day) pair IS the key and no id is minted. Nothing is
-- shared: there is no visibility column and no share entity, and every read is scoped
-- `where user_id = $1`. Convergence across a user's own devices is last-writer-wins on
-- (stamp_ms, stamp_counter). body is plain text with soft line breaks kept.
create table if not exists journal_page (
  user_id       uuid not null references users(id) on delete cascade,
  day           date not null,                    -- the writer's local ISO day, the key
  body          text not null default '',
  mood          smallint not null default 0 check (mood between 0 and 5),      -- 0 = not set
  energy        smallint not null default 0 check (energy between 0 and 3),    -- 0 = not set
  source        text not null default 'typed',    -- typed | spoken
  stamp_ms      bigint not null default 0,         -- HLC physical ms  ┐ the LWW guard; a write
  stamp_counter bigint not null default 0,         -- HLC counter      ┘ never goes backwards
  stamp_actor   text not null default '',          -- HLC actor (the writing device/replica)
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);
create index if not exists journal_page_user_day on journal_page (user_id, day);
create index if not exists journal_page_user_stamp on journal_page (user_id, stamp_ms, stamp_counter);

-- Superseded bodies, append-only and shown to nobody: the safety net for the one lossy case LWW
-- admits, the same day edited on two offline devices. Bounded by the writer, not by a cron — every
-- superseding write prunes this table inside its own transaction (PgJournalRepository.cpp) to ten
-- revisions a day, five hundred rows and 8 MB per user, and ninety days of age. Nothing else
-- deletes from here, so a writer who stops keeps whatever their last write left.
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

-- ── Journal nudges (one a day at most; the TIME is the DEVICE's, never ours) ─────────────────
-- next_due_at is materialised by the DEVICE from its local rhythm — the server is handed the next
-- instant and the local day it belongs to, and needs no timezone. slot_day is both the "did they
-- already write today?" key and the ledger key. next_due_at is NULL whenever we cannot know when to
-- send, and the partial index turns "unknown ⇒ never send" into a fact no code special-cases.
-- pause_digest is the pause link's credential — the digest at rest, never the secret.
create table if not exists journal_nudge (
  user_id      uuid primary key references users(id) on delete cascade,
  enabled      boolean not null default false,
  channel      text not null default 'email',    -- email | inapp
  next_due_at  timestamptz,                       -- device-materialised; NULL ⇒ never send
  slot_day     date,                              -- the LOCAL day next_due_at belongs to
  paused_until timestamptz,                       -- "pause for a week", one tap
  -- Hard bounce / spam complaint, set by Resend's delivery webhook and by nothing else; only a
  -- PERMANENT bounce or a complaint gets here (platform/domain/Mail.h holds that rule). It is a
  -- fact about the MAILBOX and never an edit to `enabled`, it gates nudges only and nothing in the
  -- sign-in path reads it, and turning nudges on again lifts it.
  suppressed   boolean not null default false,
  pause_digest text not null default '',
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists journal_nudge_due on journal_nudge (next_due_at)
  where enabled and not suppressed and next_due_at is not null;
create unique index if not exists journal_nudge_pause on journal_nudge (pause_digest)
  where pause_digest <> '';

-- A decision ledger, not a send log: one row per eligible user per day. The primary key IS the
-- "at most one per day" mutex, never enforced by comparing timestamps at read time. A row whose
-- sent_at is null is indistinguishable from one whose mail landed but whose update was lost, so it
-- must NEVER be auto-retried. decision is 'sent' | 'skipped'; reason is 'ok' | 'already-wrote' |
-- 'paused' | 'too-late' | 'held' (the arming gate withheld a decided send) | 'send-failed'. There
-- is no 'lapsed' reason: the engine never nudges about a gap.
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

-- ── Journal echoes (Windmill One, computed server-side, nightly) ─────────────────────────────
-- A passage written tonight set beside an older passage of the writer's own about the same thing.
-- products/journal/ECHOES.md is the contract. Written only by the nightly EchoSweep and only for
-- subscribers, so everyone else's tables simply stay empty. Everything is PASSAGE-level.

-- Guarded on a column only the old shape has: this file is re-applied on every deploy, and an
-- unguarded drop would delete real echoes every time we ship.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_name = 'journal_echo' and column_name = 'trigger_lo') then
    drop table journal_echo;
  end if;
end $$;

drop table if exists journal_page_vector;

-- A sequence and not max(span_id)+1 per user: the nightly heartbeat and an operator rehearsal can
-- overlap, and a read-then-increment across two passes is a race with nothing holding a lock.
create sequence if not exists journal_span_id_seq;

-- One segmented passage of one page — the unit everything else keys on.
-- span_id is the IDENTITY; (day, ord) is only a coordinate. Re-derivation matches old passages to
-- new by normalised TEXT and carries span_id forward for survivors
-- (products/journal/domain/SpanReconcile.h); only genuinely new text mints.
-- vector is float32, LITTLE-ENDIAN, four bytes per dimension, in a bytea — never a real[].
-- text_sha256 digests the NORMALISED text (outer whitespace trimmed, internal runs collapsed),
-- because dismissals key on it: a dismissed pair must not come back through a re-segmentation.
-- Retrieval reads ONE embed_version only: cosine between two embedding spaces is meaningless.
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

-- cosine is what retrieval measured. relation is the curator's judgement and is comparative WITHIN
-- one call only: two rows' relation values are never meaningfully ordered against each other.
-- curator_version folds in the digest of the curator's own system prompt
-- (products/journal/adapters/llm/AnthropicCurator.cpp).
-- match_is_self false means the older passage is something the writer copied down, not their words.
-- check (match_day < trigger_day) makes reaching FORWARD unrepresentable.
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
-- The reverse edge: when a page's passages change, every page holding an echo INTO it must be
-- re-derived, and this index is what makes that a lookup rather than a history scan.
create index if not exists journal_echo_inbound on journal_echo (user_id, match_day);

-- The user told it to fade. Keyed on the CONTENT of both passages, never on span ids or days, so a
-- dismissal survives re-derivation, re-segmentation and a segmenter version bump.
create table if not exists journal_echo_dismissal (
  user_id      uuid not null references users(id) on delete cascade,
  trigger_hash bytea not null,
  match_hash   bytea not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, trigger_hash, match_hash)
);

-- What the reader said about ONE pairing. kind is 'opened' (they walked back to the older page),
-- 'useful' or 'not_useful'; it is in the primary key so the three answers coexist, and every insert
-- is ON CONFLICT DO NOTHING so pressing a button twice is one row. cosine, relation and
-- curator_version ride along so a row says which retrieval score and which model's judgement
-- produced a pairing a reader endorsed. ECHOES.md's z and family_size are NOT here and are
-- persisted nowhere — they are computed inside domain/EchoSelection and discarded.
-- Keyed on the span pair like journal_echo, not on content hashes like the dismissal above.
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

-- The reader was shown the upgrade offer on this page and declined it: this retires only the
-- ASKING, where journal_echo_dismissal retires the echoes themselves. Keyed on the DAY and not on a
-- passage hash — the offer belongs to the page, so rewriting the text must not put the question
-- back. Server-side rather than a localStorage flag so the answer travels to the reader's other
-- devices.
create table if not exists journal_echo_offer_dismissal (
  user_id    uuid not null references users(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- body_stamp_ms is the page HLC ms the derivation read; corpus_stamp is the user-level corpus stamp
-- (the newest body_stamp_ms across all their spans) it ran against, so a page is stale when the
-- corpus moved even though its own body did not. These two stamps ARE the "am I done" record:
-- NEVER advance them on a failed curate. status is ok | empty_ok | transport | rate_limited |
-- truncated | schema_invalid | refused; ok, empty_ok and refused advance them, the rest do not.
-- The due queries also skip a refused row on corpus movement, so only an edit to that body makes it
-- due again. attempts counts consecutive UNSETTLED failures — a refusal never counts up.
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
-- Which pipeline derived the page: neither the body nor the corpus moves when the PIPELINE does,
-- so these are what makes a page due again after a segmenter or embedder change. The empty default
-- reads as "not the current pipeline", so an existing archive is re-cut and re-embedded.
alter table journal_page_curation add column if not exists segment_version text not null default '';
alter table journal_page_curation add column if not exists embed_version   text not null default '';
-- The judging half: the curator's prompt and effort plus a digest of the selection knobs. Added a
-- few hours after the other two, because fixing two false positives and deploying the fix left the
-- pages carrying them — nothing about a curator or a threshold makes a page due.
alter table journal_page_curation add column if not exists judge_version   text not null default '';

-- ── Gym (products/gym) ───────────────────────────────────────────────────────────────────────
-- Every gym_* row is owner-scoped and cascades on account deletion. There is no visibility column:
-- every one of gym's routes stays `WHERE user_id = :caller`, and the one reader who is not the
-- owner comes in through gym_session_shares (below) — a capability that expires and is revoked by
-- deleting one row, never a stance on the session itself. All date/time work stays in SQL;
-- instants cross the wire and the domain as epoch-ms. Create order is FK order.

-- id is a STABLE slug ('back-squat'), never renamed, never displayed; name is the mutable display
-- string, so a rename is a metadata edit on one row and every set keeps pointing at the same id.
-- created_by NULL marks a catalog seed; every read is `created_by IS NULL OR created_by = :caller`.
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

-- What a lifter calls a SEEDED movement, per account. Seeds are global rows shared by every account
-- on the server, so `UPDATE gym_exercises SET name` is never written for a seed: a seed gets a line
-- here and every read coalesces it over the seed's name. A movement the lifter CREATED renames in
-- place on its own row. Renaming back to the seed name deletes the row rather than storing a copy.
-- On PgAccountFootprint's owned list in main.cpp, and both halves cascade.
create table if not exists gym_exercise_names (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- What this account used to call a movement; the picker searches aliases beside the current name.
-- The name is part of the primary key, which is what makes renaming BACK a delete of one row
-- (products/gym/adapters/postgres/PgCatalogRepository.cpp). The list is capped per movement by that
-- same write (domain/Training.h's kMaxAliases), because this row set ships on the catalog read.
-- On PgAccountFootprint's owned list in main.cpp, and it cascades from both sides.
create table if not exists gym_exercise_aliases (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, exercise_id, name)
);
create index if not exists gym_exercise_aliases_user on gym_exercise_aliases (user_id);

-- The plan. A routine is written as a WHOLE document in one transaction — the row and its entries
-- together — so a routine holding no entries is not a state this schema can be left in. The
-- client-minted id is the idempotency key.
create table if not exists gym_routines (
  id          text primary key,                     -- client-minted 'rt_<hex>'
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists gym_routines_user on gym_routines (user_id, position);
-- The concurrency token an agent's proposal is minted AGAINST: an apply lands only while the
-- routine still stands at the revision its diff was computed from, and a read-modify-write PUT
-- moves this number and supersedes the pending proposal in the same transaction. It moves on every
-- write that changes the document; a client reads it and never sends it.
alter table gym_routines add column if not exists revision int not null default 1;

-- The creation row of the routine's history. Both columns are written by the create and by nothing
-- else. created_entries is how many lines the routine was BUILT with, stored rather than counted at
-- read time so an edit cannot rewrite what the history reports. created_door is which AGENT door
-- made it; null is the lifter's own hand. created_at is written explicitly by the same insert, from
-- the service's clock rather than the database's; the default stays for any row a hand writes.
alter table gym_routines add column if not exists created_entries int;
alter table gym_routines add column if not exists created_door text
  check (created_door in ('mcp','ask'));

-- The same movement twice in one routine is two rows with two positions. Positions are dense and
-- 1-based, and a replace lays the whole run down again: entries have no id, their key IS their
-- position.
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

-- An agent never changes a routine: it mints a row here and nothing moves until the lifter taps
-- Apply. No tool at any grant level writes `applied` — only the two owner-scoped routes in
-- products/gym/routes.cpp do. base_revision and base_name are FROZEN at mint: an apply lands only
-- while gym_routines.revision still equals base_revision, and a routine that moved is SUPERSEDED,
-- never merged over. routine_id cascades, so a day leaving the program takes its ledger with it.
-- door / connection / agent are provenance; connection and agent are EMPTY from every door today,
-- because the MCP transport carries no per-connection identity.
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
-- One pending proposal per (routine, door, connection); a newer one supersedes the older. The
-- partial index is the arbiter, never an application check.
create unique index if not exists gym_proposals_one_pending
  on gym_proposals (routine_id, door, connection) where state = 'pending';
create index if not exists gym_proposals_routine on gym_proposals (routine_id, created_at desc);
create index if not exists gym_proposals_user on gym_proposals (user_id, state, created_at desc);

-- The rows are the document as well as the diff: rows 1..k are the run the routine takes on, in
-- order — kept, added and retargeted alike — and rows k+1..n are the lines the proposal takes away.
-- Every before_*/after_* pair mirrors gym_routine_entries' own columns and carries its meaning. The
-- whole `before` side is null on an added line and the whole `after` side on a removed one.
-- No CHECKs on the target columns: this is a copy of what a line asked for, and a bound tightened
-- on gym_routine_entries later must never make an already-minted proposal unreadable.
-- user_id rides here beside the proposal's own so this table joins PgAccountFootprint's owned list.
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

-- id is client-minted ('ses_<hex>') and IS the idempotency key: a double-tapped Start, an offline
-- replay and a retried POST all conflict on the PK and no-op. One open session per user is enforced
-- by the partial unique index, not by application memory: starting while another is open JOINS the
-- open session, unless the caller states it will not join, in which case the no-op is a refusal.
-- plan is a FROZEN jsonb copy of the routine at start, composed by the SERVER and never by a client
-- (null = ad-hoc); routine_id is informational (set null on delete) and the snapshot is the truth.
-- started_at/finished_at are client wall-clock instants.
create table if not exists gym_sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  routine_id  text references gym_routines(id) on delete set null,
  plan        jsonb,
  started_at  timestamptz not null,
  finished_at timestamptz,
  -- Who closed it: 'finish' is the lifter's word and final; 'stale' is the log's own four-hour
  -- guess, closed at the last landed set, and a set landing within four hours of finished_at
  -- continues that workout and moves finished_at forward (domain lateSetLands). NULL reads
  -- as 'finish'.
  closed_by   text check (closed_by in ('finish', 'stale'))
);
alter table gym_sessions add column if not exists closed_by text check (closed_by in ('finish', 'stale'));
create index if not exists gym_sessions_log on gym_sessions (user_id, started_at desc);
create unique index if not exists gym_sessions_one_open on gym_sessions (user_id)
  where finished_at is null;

-- ONE ROW PER SET THAT CURRENTLY STANDS; a correction rewrites the row and keeps what it replaced
-- in gym_set_revisions. The client-minted id ('set_<hex>') makes the flush queue replayable (ON
-- CONFLICT DO NOTHING), and a delete SPENDS the id for good: insertSet asks gym_set_revisions
-- whether the id names a deleted set before it writes (adapters/postgres/PgLogRepository.cpp).
-- set_number is server-assigned max+1 per (session, exercise), never count+1, and nothing renumbers
-- after a delete. Canonical unit is kg and there is no lb column; negative weight is legal
-- (band-assisted). Only WORKING sets count toward volume (products/gym/domain/Review.h).
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

-- What a correction replaced, and what a delete took out of the log. Fixing a set UPDATEs its row
-- in gym_sets and appends the version it replaced here; deleting one moves the row here whole,
-- marked `deleted`. The revision id is the one id in gym the server mints.
-- Nothing shows this table to a lifter: there is no trash and no recovery route. One write reads it,
-- and reads one column — an append asks whether the id it carries names a set this account DELETED.
-- set_id carries NO foreign key on purpose: a deleted set's row is gone from gym_sets and this table
-- outlives it. session_id and user_id keep theirs, so discarding a workout takes its revisions too.
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

-- The coach share. It is a separate table so no existing owner-scoped read has to be re-decided:
-- sharing cannot be reached from any query that does not name this table.
-- session_id is the primary key, which makes the mint idempotent: tapping Share twice sends one link
-- and not two capabilities to revoke separately. The token is MINTED BY THE SERVER (platform
-- TokenGenerator) and never accepted from a client, and it is stored in the clear rather than as a
-- digest because a repeat mint must hand back the SAME link. expires_at ends the capability
-- (30 days, domain/Training.h); revocation is deleting the row, and nothing is marked or swept.
create table if not exists gym_session_shares (
  session_id  text primary key references gym_sessions(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists gym_session_shares_user on gym_session_shares (user_id);

-- One row per account, and the only gym table that is not the log. Account-level, not device-local.
-- UNITS ARE A DISPLAY TRANSFORM AND NOTHING ELSE: every weight in this schema is kilograms, there
-- is no lb column anywhere, and no read in the product is scoped by this value. confirm_haptic /
-- confirm_sound record the lifter's INTENT and each surface honours what it can.
-- Every default here sits on the column AND in products/gym/domain/Preferences.h, which a client
-- reading before it has ever written is served: the two must not disagree. rest_seconds bounds match
-- a routine line's rest target, so the global dial and the program cannot ask for waits the other
-- refuses. Deliberately NOT in PgAccountFootprint's owned list.
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

-- Ask's threads: the server keeps the thread and the client sends one question.
-- title IS THE FIRST MESSAGE, VERBATIM, written ONCE at creation and never by a model — nothing in
-- this product summarises a lifter's words.
-- asked_at is the newest turn's instant, what the list sorts and dates by; created_at dates the
-- question that named the thread. Both are the SERVER's clock, unlike the log's instants.
-- On PgAccountFootprint's owned list in main.cpp.
create table if not exists gym_ask_threads (
  id         text primary key,                  -- client-minted 'thr_<hex>', the idempotency key
  user_id    uuid not null references users(id) on delete cascade,
  title      text not null,
  created_at timestamptz not null,
  asked_at   timestamptz not null
);
create index if not exists gym_ask_threads_user on gym_ask_threads (user_id, asked_at desc);

-- The turns, stored AS SENT, byte for byte; no summarisation anywhere.
-- Written a PAIR AT A TIME and only after an answer lands, so a failed ask leaves this table exactly
-- as it found it and the retry appends the question once.
-- user_id rides here beside the thread's own so this table joins PgAccountFootprint's owned list.
create table if not exists gym_ask_turns (
  thread_id   text not null references gym_ask_threads(id) on delete cascade,
  position    int  not null check (position >= 1),
  user_id     uuid not null references users(id) on delete cascade,
  from_lifter boolean not null,
  text        text not null,
  said_at     timestamptz not null,
  primary key (thread_id, position)
);

-- Which conversation minted this proposal. `on delete set null`: deleting a thread deletes the
-- conversation and not the consequence — an applied change stays in the routine's history, still
-- attributed to Ask by `door`, it just no longer opens a conversation that exists. Null for every
-- MCP-door proposal and for an Ask proposal whose thread was deleted; to a client both read the
-- same, as nothing here to open.
alter table gym_proposals add column if not exists thread_id text
  references gym_ask_threads(id) on delete set null;
create index if not exists gym_proposals_thread on gym_proposals (thread_id);

-- The catalog seed. step_kg by equipment: barbell 2.5 (smallest plate pair), dumbbell 2.0 (rack
-- gap), machine 5.0 (pin), cable 2.5, bodyweight 2.5 (belt plate), kettlebell 4.0. dip, pull-up and
-- muscle-up are distinct ids with "weighted" expressed by load, not identity.
-- ON CONFLICT (id) DO NOTHING so a redeploy never clobbers a renamed display name.
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
