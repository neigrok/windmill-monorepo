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
-- A sweep is a pure function of (now, these two tables); no schedule state lives in the process.
-- Keep all calendar work in SQL via AT TIME ZONE: Postgres ships its own IANA database, so macOS
-- and CI's Linux agree where C++ calendar functions do not.
--
-- `next_due_at` is the materialized UTC instant of the next slot and the ONLY thing the sweep
-- queries; NULL whenever we cannot know when to send (no timezone, reminders off), so
-- "unknown ⇒ never send" falls out of the partial index. slot_minute is confined to 08:00–11:00
-- local so DST's nonexistent and ambiguous local times are unreachable by construction.
-- pause_digest is the pause link's credential — the digest at rest, never the secret.
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

-- A decision ledger, not a send log: one row per user per week recording what we decided and why.
-- The claim re-checks enabled/suppressed/deleted inside its own transaction, so someone who pauses
-- mid-batch gets no row at all. The primary key IS the "at most one per 7 days" mutex; it is never
-- enforced by comparing timestamps at read time. A row whose sent_at is null is indistinguishable
-- from one whose mail landed but whose update was lost, so it must NEVER be auto-retried.
-- decision is 'sent' | 'skipped'; reason is 'ok' | 'no-ready-steps' | 'recently-active' |
-- 'in-grace' | 'too-late' | 'load-failed' (facts unreadable; the week is claimed anyway so the
-- pointer moves) | 'held' (the arming gate withheld a decided send) | 'send-failed'. The last
-- three are stamped after the decision.
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
-- The hosted "Learn to sail" roadmap at #/demo, read anonymously over HTTP and WS: the row must
-- exist AND be public or read enforcement 404s it for every visitor. owner_id is NULL on purpose
-- and that is what protects it — an unowned tree is nobody's to write (canWrite,
-- platform/domain/Access.h), so it is world-readable and editable by no account. The ON CONFLICT
-- means a row that was somehow claimed will NOT self-heal; an operator repairs that by hand.
-- Stamps are the genesis HLC ('1:0:genesis'); '0:0:' is the never-set / never-deleted sentinel.
-- Positions are null on purpose: the client lays the tree out radially from the DAG.
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

-- One kept pair. cosine is what retrieval measured; relation is the curator's judgement and is
-- comparative WITHIN one call only — each call mints its own private scale, so two rows' relation
-- values are never meaningfully ordered against each other. curator_version is what makes a chain
-- of mixed vintage debuggable and selectively rebuildable years later, and it is one column and not
-- two: the curator folds the digest of its own system prompt into the version string it stamps
-- (products/journal/adapters/llm/AnthropicCurator.cpp), so a separate prompt_hash beside it could
-- only ever restate that or contradict it. It was the latter — never once assigned, so every row
-- ever written carried '' — and the drop below converges the databases that already have it.
--
-- match_is_self carries the curator's speaker verdict: false means the older passage is something
-- the writer copied down — a pasted message, a lyric, a line said in session. Those are verbatim
-- page text and locate perfectly, so nothing else in the pipeline can catch them, and surfacing
-- one under "you wrote this" is a false attribution.
--
-- check (match_day < trigger_day) makes reaching FORWARD unrepresentable rather than merely
-- unimplemented: the journal may only ever remember, never predict or track.
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
-- the read endpoint: a range of pages and what each carries
create index if not exists journal_echo_page on journal_echo (user_id, trigger_day);
-- the reverse edge. When a page's passages change, every page holding an echo INTO it must be
-- re-derived, or fixing one typo in a January page permanently kills every echo pointing at it and
-- the graph decays with the user's own care for their archive. This index is what makes that a
-- lookup rather than a scan of the user's whole history.
create index if not exists journal_echo_inbound on journal_echo (user_id, match_day);

-- The user told it to fade. Keyed on the CONTENT of both passages, never on span ids or days, so a
-- dismissal survives re-derivation, re-segmentation and a segmenter version bump. A dismissed echo
-- returning is the most trust-destroying failure this feature has, and it is the one failure that
-- an id-keyed table would guarantee.
create table if not exists journal_echo_dismissal (
  user_id      uuid not null references users(id) on delete cascade,
  trigger_hash bytea not null,
  match_hash   bytea not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, trigger_hash, match_hash)
);

-- What the reader said about ONE pairing: 'opened' (they walked back to the older page), 'useful'
-- (they said so) or 'not_useful' (they retired it). This is the only place the feature learns
-- whether its curator is any good — dismissal alone cannot tell "wrong match" from "right match,
-- bad night", so the positive half has to be recorded too or the dataset is one-sided.
--
-- cosine, relation and curator_version ride along and are the whole reason this is a table rather
-- than a counter. Without them a row says "somebody liked something"; with them it says which
-- retrieval score and which model's judgement produced a pairing a reader endorsed. curator_version
-- matters most: rows read claude-sonnet-5/low/<tag> or claude-opus-5/high/<tag> after the
-- 2026-08-09 swap, so this table can answer whether that swap cost precision — the pre-ship gate in
-- ECHOES.md that has never been run.
--
-- ECHOES.md asks for z and family_size here too, and they are NOT here: neither is persisted
-- anywhere. Both are computed inside domain/EchoSelection and discarded, and journal_echo is not
-- being widened to chase them. What is recorded is what exists; the gap is stated rather than
-- papered over.
--
-- Keyed on the span pair like journal_echo itself, not on content hashes like the dismissal above.
-- The two want different things: a dismissal must survive a rewrite of the passage, whereas a
-- signal is a judgement ABOUT the pairing that was on screen, and reconciliation already carries a
-- span_id forward for any passage whose text survived. kind is in the primary key so the three
-- answers coexist, and every insert is ON CONFLICT DO NOTHING — pressing a button twice is one row.
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
-- the read path: which of a range's pairings the reader has marked useful, served back so no device
-- has to remember an answer it may not have been the one to give
create index if not exists journal_echo_signal_page
  on journal_echo_signal (user_id, trigger_day, kind);

-- "Not now." The reader was shown the upgrade offer on this page and declined it. Distinct from the
-- dismissal above in every way that matters: that one retires ECHOES, this one retires only the
-- ASKING. Their echoes and their honest cut stay exactly as they were; the page simply stops
-- selling.
--
-- Keyed on the DAY, not on a passage hash, and deliberately: the offer belongs to the page, not to
-- any pairing on it. Re-derive the page, re-segment it, rewrite every sentence — the reader still
-- said no to being asked here, and a content hash would put the question back the moment the text
-- moved. Do not "fix" this into a hash for consistency with journal_echo_dismissal.
--
-- And it is SERVER-side, not a localStorage flag, for the same reason: "we asked you to pay and you
-- said not now" is exactly the answer that has to survive the trip to another device. Per-device
-- means the same person gets asked again on their phone, which is nagging we do not do.
create table if not exists journal_echo_offer_dismissal (
  user_id    uuid not null references users(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- What happened to this page on its last pass, and what it was judged against. body_stamp_ms is the
-- page HLC ms the derivation read; corpus_stamp is the user-level corpus stamp (the newest
-- body_stamp_ms across all their spans) the curation was run against — a page whose echoes were
-- computed against an older corpus is stale even though its own body never moved, which is what
-- makes a backfilled year reach the pages that were already written.
--
-- These two stamps ARE the "am I done" record, so: NEVER advance them on a failed curate. status
-- is ok | empty_ok | transport | rate_limited | truncated | schema_invalid | refused. ok, empty_ok
-- and refused advance them; the rest do not. The shipped vector path advanced its stamp on
-- completion, and porting that idiom naively loses a page that failed at 02:14 forever.
--
-- refused is the odd one and it is deliberate: a vendor that declined to judge a body declines the
-- same body every six hours forever, so it settles the page instead of owing it another night — and
-- the due queries additionally skip a refused row on corpus movement, because the corpus stamp moves
-- every time the account writes ANY page and would otherwise reopen it nightly regardless of its own
-- stamps. Only an edit to that body makes it due again (products/journal/ECHOES.md, "A refusal is
-- final"). attempts therefore counts consecutive UNSETTLED failures — a refusal never counts up —
-- and rides out on every due page so the sweep can one day back off a page the vendor keeps failing;
-- nothing backs off on it yet, so today it is a diagnostic.
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
-- WHICH PIPELINE DERIVED THE PAGE. Added 2026-08-23, and the empty default is what makes the
-- migration work: every row already written reads as derived by a segmenter and an embedder that
-- are not the current ones, so the archive is re-cut and re-embedded over the following passes
-- rather than keeping units nobody would produce again. Before this, a prompt change or a model
-- swap reached only pages written after it — neither the body nor the corpus moves when the
-- PIPELINE does, so nothing made an existing page due and the change was silent.
alter table journal_page_curation add column if not exists segment_version text not null default '';
alter table journal_page_curation add column if not exists embed_version   text not null default '';
-- The judging half: the curator's prompt and effort plus a digest of the selection knobs. Added a
-- few hours after the other two, because fixing two false positives and deploying the fix left the
-- pages carrying them — nothing about a curator or a threshold makes a page due.
alter table journal_page_curation add column if not exists judge_version   text not null default '';

-- ── Gym (products/gym) ───────────────────────────────────────────────────────────────────────
-- The third room in the superapp: a training log whose one load-bearing feature is the durable
-- set write. Tables are gym_*, every row owner-scoped, and account deletion is the cascade.
-- There is still deliberately NO visibility column: a session row is legible to exactly one
-- account by construction, and every one of gym's owner-scoped routes stays
-- `WHERE user_id = :caller`. The one reader who is not the owner comes in through a SEPARATE
-- table, gym_session_shares (below) — a capability that expires and is revoked by deleting one
-- row, never a stance on the session itself. All date/time work stays in SQL (to_timestamp,
-- extract(epoch …), date_trunc); instants cross the wire and the domain as epoch-ms. Create order
-- is FK order: exercises → routines → routine_entries → sessions → sets → set_revisions →
-- session_shares (the architecture doc reads sessions first; the DDL cannot, because
-- gym_sessions.routine_id references gym_routines).

-- The identity table. id is a STABLE slug ('back-squat'), never renamed, never displayed;
-- name is the mutable display string. That separation IS the fix for Lift's worst bug family:
-- rename forked history, a typo forked history, 'Bench press' vs 'Bench Press' were two lifts
-- forever, and the coach could only address exercises by exact string. Here a rename is a
-- metadata edit on one row and every set keeps pointing at the same id.
-- Seeded with 64 movements in this migration (ON CONFLICT DO NOTHING — re-runnable, and user
-- edits to name survive redeploys). created_by NULL marks a seed; a movement a lifter creates
-- (POST /v1/gym/exercises) lands as a row with created_by = the owner and is visible only to
-- them — every read is `created_by IS NULL OR created_by = :caller`.
create table if not exists gym_exercises (
  id          text primary key,
  name        text not null,
  pattern     text not null check (pattern in
                ('squat','hinge','press','pull','carry','core','isolation')),
  equipment   text not null check (equipment in
                ('barbell','dumbbell','machine','cable','bodyweight','kettlebell')),
  step_kg     numeric(4,2) not null default 2.5,   -- per-movement increment, seeded and served.
                                                   -- READ BY NOTHING as of 2026-08-11: the ladder
                                                   -- retier took the fine step from the load band
                                                   -- (±2.5 above 20 kg), not from here. Reserved,
                                                   -- and not yet load-bearing anywhere
  created_by  uuid references users(id) on delete cascade,   -- null = catalog seed
  created_at  timestamptz not null default now()
);

-- What a lifter calls a SEEDED movement, per account. The 64 seeds are global rows shared by every
-- account on the server, so `UPDATE gym_exercises SET name` renames Back Squat for everyone — this
-- table is the whole of why that statement is never written for a seed. A movement the lifter
-- CREATED is theirs alone and renames in place on its own row; a seed gets a line here instead and
-- every read coalesces it over the seed's name.
-- The id never moves, which is the point the rename exists to demonstrate: every set, every routine
-- entry and every frozen plan snapshot still points at the same movement, so renaming Back Squat
-- keeps the history whole (§4). Renaming a movement BACK to its seed name deletes the row rather
-- than storing a copy of the seed's own string — an override that says nothing is not an override.
-- It is owner-scoped like every other gym row, it joins PgAccountFootprint's owned list in
-- main.cpp (a movement someone named is their data), and both halves cascade: closing the account
-- takes the line, and deleting a movement would take it too.
create table if not exists gym_exercise_names (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- What this account USED to call a movement (W10, 2026-08-13). Every gym has a machine with no real
-- name and a lifter who calls the incline bench "the slanty one", so renaming is not an admin chore
-- here — and the whole promise of a rename is that nothing is lost. The old name lands here and the
-- picker searches it beside the current one, so the word that is in a lifter's hands on Tuesday
-- still finds the movement they renamed on Sunday.
--
-- It is a ROW rather than a column beside gym_exercise_names for two reasons that each rule the
-- column out on their own: that table holds a line only for a SEED the account renamed — a movement
-- the lifter created renames on its own row and has no line there to hang an alias off — and a
-- lifter renames more than once, so one column would keep the oldest name or the newest and lose
-- the other. The name is part of the primary key, which is what makes renaming BACK a delete of one
-- row rather than a second copy of a name that is no longer a memory (products/gym/adapters/
-- postgres/PgCatalogRepository.cpp states the three statements). The list is capped per movement by
-- that same write (domain/Training.h's kMaxAliases): this row set ships on the catalog read, which
-- is the product's most-fired read, and a lifter's fiftieth try at a name is not muscle memory.
--
-- Owner-scoped like every other gym row, on PgAccountFootprint's owned list in main.cpp (a name
-- someone gave a movement is their data), and it cascades from both sides.
create table if not exists gym_exercise_aliases (
  user_id     uuid not null references users(id) on delete cascade,
  exercise_id text not null references gym_exercises(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, exercise_id, name)
);
create index if not exists gym_exercise_aliases_user on gym_exercise_aliases (user_id);

-- The plan. Entries are RELATIONAL, not a JSON blob — Lift persisted per-set pyramid targets as
-- an opaque blob ("the database can never query or aggregate it") and decode failures silently
-- returned [], losing the program. The one legitimate blob is the session's frozen snapshot
-- (below), which is a copy by definition. A routine is written as a WHOLE document in one
-- transaction — the row and its entries together — so a routine holding no entries is not a state
-- this schema can be left in, and the client-minted id is the idempotency key like every other.
create table if not exists gym_routines (
  id          text primary key,                     -- client-minted 'rt_<hex>'
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists gym_routines_user on gym_routines (user_id, position);
-- The concurrency token, added by W6 (2026-08-12) and load-bearing twice over. It is what an
-- agent's proposal is minted AGAINST — an apply lands only while the routine still stands at the
-- revision its diff was computed from — and it is what stops the mid-session "Save 87.5 to Push A",
-- a full read-modify-write PUT, from silently destroying that base: the PUT moves this number, the
-- pending proposal is superseded in the same transaction, and nobody merges a diff over a document
-- it no longer describes. It moves on every write that changes the document, the lifter's own and
-- an applied proposal alike; a client reads it and never sends it. `if not exists` because this run
-- is re-applied on every deploy and carries no migration machinery.
alter table gym_routines add column if not exists revision int not null default 1;

-- THE CREATION ROW OF THE ROUTINE'S HISTORY (W10, 2026-08-13), which §M30 draws as
-- `9 Aug · created by you · 4 movements`. Both columns are written by the create and by nothing
-- else, and both are NULLABLE because a day made before this wave cannot be asked what it was:
--   · created_entries is how many lines the routine was BUILT with. It is stored rather than
--     counted at read time because the count at read time is a different number the moment a lifter
--     edits the day — and a history row that quietly reported today's document as the one it was
--     created with would be the ledger lying about the past, which is the one thing a ledger is for.
--   · created_door is which AGENT door made it, and null is the lifter's own hand — the ordinary
--     case, the one §M is about, and the only one the app's route can produce. `create_routine` over
--     MCP is a real door onto this table (a day that does not exist yet takes nothing away, so it
--     lands immediately rather than as a proposal), and a history that said "created by you" about
--     it would be putting words in a lifter's mouth about their own program.
-- created_at is written explicitly by the same insert now, from the service's clock rather than the
-- database's, exactly as gym_proposals.created_at is: one clock decides, and a test can drive it.
-- The default stays for any row a hand writes.
alter table gym_routines add column if not exists created_entries int;
alter table gym_routines add column if not exists created_door text
  check (created_door in ('mcp','ask'));

-- The same movement twice in one routine — bench heavy, then bench back-off — is two rows with
-- two positions (Lift collapsed them into one set counter). Positions are dense and 1-based, and
-- a replace lays the whole run down again: entries have no id to churn, their key IS their
-- position. FOUR columns mean something by being null: a null target_sets is an OPEN line — the
-- movement is in the day and what to do with it is decided at the rack — a null target_reps is "as
-- many as you can" (the canon's `3 × max` — a chin-up names no rep target), a null target weight
-- means "whatever you did last time", and a null rest_seconds is the client's own default.
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
-- target_reps was `not null default 8` until routines met the chin-up, and target_sets was
-- `not null default 3` until a routine could be SAVED WHILE INCOMPLETE (W10, 2026-08-13). This run
-- is re-applied on every deploy and carries no ALTER machinery, so each change is its own pair of
-- idempotent statements beside the table: dropping a constraint or a default that is already gone
-- succeeds, so a second apply is a no-op, and a database created before these lines ends up shaped
-- exactly like one created after them. The default goes with the NOT NULL both times, because 8 is
-- a rep target nobody asked for and 3 is a set target nobody asked for — and each column's absence
-- now MEANS something, which a default would quietly fill in with a number the lifter never typed.
alter table gym_routine_entries alter column target_reps drop not null;
alter table gym_routine_entries alter column target_reps drop default;
alter table gym_routine_entries alter column target_sets drop not null;
alter table gym_routine_entries alter column target_sets drop default;

-- THE PROPOSAL LEDGER (W6, 2026-08-12). An agent reads this log, and when it wants to change a day
-- of the program it does not: it mints a row here, and nothing moves until the lifter opens the
-- diff and taps Apply. There is no tool at any grant level that applies one — Apply is not a
-- capability, it is a human act — so the only writers of `applied` are the two owner-scoped routes
-- in products/gym/routes.cpp.
--
-- base_revision and base_name are FROZEN at mint, exactly as a session's plan snapshot is: an apply
-- lands only while gym_routines.revision still equals base_revision, and a routine that moved since
-- is SUPERSEDED rather than merged over the top. A superseded row is not deleted — it drops into
-- the routine's dated history beside the applied and dismissed ones, so nothing piles up on a
-- lifter's Today and nothing vanishes out from under the History section that draws it.
--
-- FOR AS LONG AS THE ROUTINE STANDS, which is the honest end of that sentence. routine_id cascades,
-- so the day leaving the program takes its whole ledger with it — the applied rows that dated the
-- changes the lifter accepted included. That is the shape rather than an oversight: a day that has
-- left has no editor to draw a History section in, and it had none before this ledger existed. The
-- log is untouched either way (gym_sets keeps every set, gym_sessions keeps its frozen plan and
-- nulls its routine_id), which is the promise a removal card actually makes.
--
-- door / connection / agent are PROVENANCE, and they are columns rather than a fork on purpose: the
-- lifter's own Claude over MCP and gym's own Ask are two doors onto one object, and "a change
-- appeared in my Tuesday and I cannot tell whether it was my Claude or Windmill's coach" is the
-- exact failure this design exists to prevent. connection and agent are EMPTY today because the MCP
-- transport hands the tool layer an account and a grant and nothing that tells one connection from
-- another; they are here so that the day it does, one line fills them.
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
-- ONE PENDING PROPOSAL PER (routine, door, connection). A newer one supersedes the older, which is
-- what keeps a lifter's Today from filling up with an agent's second thoughts, and the partial
-- index is the arbiter rather than an application check — the same stance gym_sessions_one_open
-- takes. `connection` is '' from every door today, so today the rule reads "one pending proposal
-- per routine per door"; the column is what sharpens it the moment the transport carries an
-- identity, with no index change.
create unique index if not exists gym_proposals_one_pending
  on gym_proposals (routine_id, door, connection) where state = 'pending';
-- The routine editor's History section, newest first.
create index if not exists gym_proposals_routine on gym_proposals (routine_id, created_at desc);
-- Today's card: the pending proposals of one account, across routines.
create index if not exists gym_proposals_user on gym_proposals (user_id, state, created_at desc);

-- THE ROWS ARE THE DOCUMENT AS WELL AS THE DIFF, and that is the one structural decision here.
-- Rows 1..k are the run the routine takes on, in order — kept, added and retargeted alike — and
-- rows k+1..n are the lines the proposal takes away. So a proposal has exactly one stored
-- representation: the field-level diff a lifter reads (§D14 draws `sets 5 × 5 → 5 × 3`,
-- `− Cable Fly · removed from the routine`) and the document an Apply writes are the same rows read
-- two ways, and they cannot drift apart the way a stored diff beside a stored document would.
--
-- Every before_*/after_* pair mirrors gym_routine_entries' own columns and carries its meaning:
-- a null reps is `max`, a null weight is "whatever you did last time", a null rest falls back to the
-- lifter's global target. The whole `before` side is null on an added line and the whole `after`
-- side is null on a removed one.
--
-- No CHECKs on the target columns, and it is the reason gym_set_revisions carries none either: this
-- is a copy of what a line asked for, and a bound tightened on gym_routine_entries later must never
-- make an already-minted proposal unreadable. The entity refuses out-of-band values at the mint.
--
-- user_id rides here beside the proposal's own for one reason: PgAccountFootprint's list is about
-- what an account OWNS, and a table left off it is how the link door comes to delete real data the
-- day a row can outlive its parent. It cascades twice over and that is fine.
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

-- A session is started by the device with a CLIENT-MINTED id ('ses_<hex>'). The id IS the
-- idempotency key: a double-tapped Start, an offline replay, a retried POST all conflict on
-- the PK and no-op — Lift minted a phantom session from a double-tap and needed a guard
-- nobody wrote for a year. One open session per user is enforced by the partial unique index,
-- not by application memory: starting while another is open JOINS the open session, unless the
-- caller states it will not join (backfill and import mean "create exactly this past session"),
-- in which case the no-op is reported as a refusal.
-- plan is a FROZEN jsonb copy of the routine at start, composed by the SERVER from its own
-- routine row and never by a client (null = ad-hoc). Lift stored templateId
-- + a copied name, so it could say what you did and never what you were supposed to do, and
-- editing a template mid-workout rewrote the program's past. A snapshot is what makes
-- phase-3 plan-vs-actual possible at all. routine_id is informational (set null on delete);
-- the snapshot is the truth. started_at/finished_at are client wall-clock instants — offline
-- logging means the device's clock is the only honest one, and this is the owner's own data.
create table if not exists gym_sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  routine_id  text references gym_routines(id) on delete set null,
  plan        jsonb,
  started_at  timestamptz not null,
  finished_at timestamptz,
  -- Who closed it (2026-08-16): 'finish' is the lifter's word and final; 'stale' is the log's own
  -- four-hour guess, closed at the last landed set — and a set that lands late but continues that
  -- workout (within four hours of finished_at) is accepted and moves finished_at forward, because a
  -- phone in a basement holds sets the log never saw and the guess was made without them
  -- (domain lateSetLands). NULL is a row closed before this column existed, read as 'finish'.
  closed_by   text check (closed_by in ('finish', 'stale'))
);
alter table gym_sessions add column if not exists closed_by text check (closed_by in ('finish', 'stale'));
create index if not exists gym_sessions_log on gym_sessions (user_id, started_at desc);
create unique index if not exists gym_sessions_one_open on gym_sessions (user_id)
  where finished_at is null;

-- The unit of the whole product: ONE ROW PER SET THAT CURRENTLY STANDS, written by one device at a
-- time. A correction rewrites the row and keeps what it replaced in gym_set_revisions (below), so
-- every read of this table stays exactly what it was — the tonnage, the marks, the records, the
-- chart, the prefill and the export all recompute off the live rows and none of them projects a
-- chain. Nothing to converge, so no HLC and no lattice — the client-minted id ('set_<hex>') makes
-- the background-flush queue replayable (ON CONFLICT DO NOTHING), which is all offline needs.
-- The primary key is not the whole of that replayability any more, and W3 is why: a row can now
-- LEAVE this table, which frees its id, and a replayed append would then hand a lifter back the set
-- they deleted. So a delete SPENDS the id for good — insertSet asks gym_set_revisions whether this
-- id names a deleted set before it writes (products/gym/adapters/postgres/PgLogRepository.cpp).
-- kind / rpe / note land NOW though their UI is phase 2 — Lift's lesson is that this is a
-- schema decision, not a feature decision: a warmup must not count toward volume, and
-- band-assisted work logs NEGATIVE kg, which naive volume = weight × reps silently subtracts
-- from every total (Lift shipped exactly that). The volume contribution of a set kind is a
-- domain decision and the finish surface took it: WORKING sets only, and a warmup, a drop and a
-- failure count toward nothing (products/gym/domain/Review.h). The storage is decided here.
-- set_number is server-assigned max+1 per (session, exercise) — not count+1, and that choice is
-- what made W3's delete safe to build: deleting set 2 of 3 leaves 1 and 3, and count+1 would then
-- mint a second 3 (a bug Lift's own spec had backwards). Nothing RENUMBERS after a delete: a gap is
-- honest and the number a set was logged under is not a lifter's to rewrite.
-- Canonical unit is kg, numeric(6,2) so 72.5 is 72.5 forever; there is no lb column.
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
-- the prefill read and every per-exercise history: newest sets of one movement, one index
create index if not exists gym_sets_history  on gym_sets (user_id, exercise_id, completed_at desc);

-- What a correction replaced, and what a delete took out of the log. Fixing a set UPDATEs its row in
-- gym_sets and appends the version it replaced here; deleting one moves the row here whole, marked
-- `deleted`. So gym_sets keeps its one meaning and **nothing a lifter logged is ever destroyed** —
-- the two halves of the ruling that made W3 buildable without projecting a chain through ten reads.
--
-- The alternative — keeping gym_sets append-only and superseding a set with a tombstoned row — was
-- refused on blast radius: EVERY read of sets would then have to filter the superseded and resolve
-- the chain (session detail, the log's marks, the record page, the review, the statistics, the
-- prefill, the export, and every MCP projection), a tax paid forever on every future read, and one
-- forgotten projection shows a lifter a set twice or a number they corrected weeks ago.
--
-- NOTHING SHOWS THIS TABLE TO A LIFTER, and that is deliberate, not unfinished: there is no trash,
-- no recovery route, and no copy anywhere in the product that promises a set back. It exists so the
-- promise above is true, not so a screen can offer an undo it would then have to keep. The revision
-- id is the one id in gym the server mints — a kept row is not something a client names.
--
-- ONE WRITE READS IT, and it reads one column: an append asks whether the id it carries names a set
-- this account DELETED, because a delete has to survive the replay of the POST that logged the set.
-- That is not a door back to a deleted set — it hands nothing over, and refuses instead.
--
-- set_id carries NO foreign key on purpose: a deleted set's row is gone from gym_sets, and the whole
-- point of this table is to outlive it. session_id and user_id keep theirs, so closing an account
-- takes these rows with it and DISCARDING A WORKOUT TAKES ITS REVISIONS TOO — which is what keeps
-- `discard_session`'s own promise ("Permanent — nothing keeps a copy") true.
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
-- The columns carry no CHECKs: this is a copy of what a row already was, and a constraint tightened
-- on gym_sets later must never make the history of a set unwritable.
create index if not exists gym_set_revisions_set on gym_set_revisions (set_id, replaced_at);

-- The coach share, and it is a TABLE rather than a column on gym_sessions for one reason that
-- decides everything else: a column would put a stance on every session row, and every one of
-- gym's owner-scoped reads would then have to be re-decided in terms of it. A separate table
-- leaves every one of them exactly as it was — still `WHERE user_id = :caller`, still absent
-- byte-identical to forbidden — and adds one door beside them. Sharing cannot be reached by
-- accident from any existing query, because no existing query names this table.
-- session_id is the primary key, which is what makes the mint idempotent: tapping Share twice
-- sends one link and not two capabilities to revoke separately. The token is MINTED BY THE SERVER
-- (platform TokenGenerator, the same mint behind a session cookie) and never accepted from a
-- client, because a client that picks its own share token picks a guessable one. Unlike a session
-- or a magic link it is stored in the clear rather than as a digest — the mint must hand back the
-- SAME link on a repeat, which a digest cannot do — so what a database leak would expose here is a
-- set of live links, each to one workout, each expiring and revocable by its owner, and
-- none of them naming the account behind it. expires_at is the end of the capability (30 days,
-- domain/Training.h) and revocation is deleting the row: nothing is marked and nothing is swept.
create table if not exists gym_session_shares (
  session_id  text primary key references gym_sessions(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists gym_session_shares_user on gym_session_shares (user_id);

-- The settings of §I, one row per account, and the only gym table that is not the log. Five values,
-- and every one of them changes how the room behaves at the rack: what unit the lifter READS in,
-- what their gym is loaded with, how long they rest, and how a logged set confirms itself.
--
-- UNITS ARE A DISPLAY TRANSFORM AND NOTHING ELSE. There is no lb column here or anywhere in this
-- file: every weight in this schema is kilograms, forever, and this row cannot change that — it
-- changes what a screen prints. A lifter who switches to lb and back has the same log, byte for
-- byte, and no read in the product is scoped by this value. (products/gym/ARCHITECTURE.md §9.4 is
-- the canonical-units decision, unchanged by this table.)
--
-- Account-level rather than device-local, each column for its own reason: a lifter reads in one unit
-- everywhere; the plates are their GYM's and not their handset's; the rest target is their
-- program's. The confirmation pair is the one worth stating out loud — it records the lifter's
-- INTENT and each surface honours what it can (a native haptic where there is one, a sound where
-- there is not), so a surface that cannot vibrate says so where the row is drawn rather than moving
-- and doing nothing.
--
-- Every default here is the answer a lifter who never opens that screen gets, which is why they sit
-- on the columns AND in the domain (products/gym/domain/Preferences.h): a client reading before it
-- has ever written is served the domain's copy, and the two must not disagree. rest_seconds is null
-- by default and null MEANS something — no timer — because a timer nobody asked for that starts
-- beeping in a gym is the kind of thing this product does not do. Its band is the band a routine
-- line's rest target already carries, from one pair of constants, so the global dial and the program
-- cannot ask for waits the other refuses.
--
-- It is deliberately NOT in PgAccountFootprint's owned list, and platform/infra/main.cpp carries the
-- reason beside that list: settings are how an account is set up, never the artifact it holds.
create table if not exists gym_preferences (
  user_id         uuid primary key references users(id) on delete cascade,
  units           text not null default 'kg' check (units in ('kg','lb')),
  rest_seconds    int check (rest_seconds between 15 and 900),   -- null = no timer, and that is the default
  rest_sound      boolean not null default true,
  confirm_haptic  boolean not null default true,
  confirm_sound   boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- Equipment left this product on 2026-08-13. The bar weight and the plate set were an inventory the
-- lifter had to keep correct to get a loading readout that guided nothing a numeral did not already
-- say, and gyms are more or less the same — so the readout went, the settings rows above it went,
-- and these two columns go with them. Dropped rather than left standing: a column nothing reads is
-- the same lie as a stale comment, and the next reader would build from it.
alter table gym_preferences drop column if exists bar_weight_kg;
alter table gym_preferences drop column if exists plates_kg;

-- ASK'S THREADS (W11, 2026-08-13), AND THIS TABLE IS A REVERSAL. W7 shipped Ask stateless on
-- purpose: the client sent the whole conversation on every ask, so there was no table, no id and
-- nothing to garbage-collect. The owner reversed it for a product reason rather than a technical
-- one — a conversation about your bench plateau is worth more in six weeks than it was that
-- evening — so the server keeps the thread now, and the client sends one question.
--
-- title IS THE FIRST MESSAGE, VERBATIM, and that is the whole design of the list: a row is the
-- question in the lifter's own words plus what came of it, because that is what somebody comes
-- back looking for. It is written ONCE, at creation, and never by a model: nothing in this product
-- summarises a lifter's words, and a title the model wrote about somebody would be exactly the
-- narration §O exists to refuse.
--
-- asked_at is the newest turn's instant — what the list sorts and dates by — while created_at
-- dates the question that named the thread. Both are the SERVER's clock and not a device's, unlike
-- the log's instants: a conversation happens against our own vendor call, so there is no offline
-- write here for a device clock to be the honest one about.
--
-- Owner-scoped like every other gym row, on PgAccountFootprint's owned list in main.cpp — a thread
-- is a lifter's own words and an account holding one is not empty.
create table if not exists gym_ask_threads (
  id         text primary key,                  -- client-minted 'thr_<hex>', the idempotency key
  user_id    uuid not null references users(id) on delete cascade,
  title      text not null,
  created_at timestamptz not null,
  asked_at   timestamptz not null
);
create index if not exists gym_ask_threads_user on gym_ask_threads (user_id, asked_at desc);

-- The turns, stored AS SENT — byte for byte, punctuation and emoji included. No summarisation
-- anywhere, ever: what is stored is what was typed and what was answered, and the export hands
-- both back whole.
--
-- A PAIR AT A TIME, AND ONLY AFTER AN ANSWER LANDS. A question nobody answered is not a turn — the
-- same rule the day's ration already keeps, where a run that reached nobody is given back — so a
-- failed ask leaves this table exactly as it found it and the retry appends the question once.
--
-- user_id rides here beside the thread's own for the reason gym_proposal_changes carries one: the
-- footprint list is about what an account OWNS, and a table left off it is how the link door comes
-- to delete real data the day a row can outlive its parent.
create table if not exists gym_ask_turns (
  thread_id   text not null references gym_ask_threads(id) on delete cascade,
  position    int  not null check (position >= 1),
  user_id     uuid not null references users(id) on delete cascade,
  from_lifter boolean not null,
  text        text not null,
  said_at     timestamptz not null,
  primary key (thread_id, position)
);

-- WHICH CONVERSATION MINTED THIS PROPOSAL — and `on delete set null` is the whole of §O's rule that
-- deleting a thread deletes the conversation and not the consequence. An applied change stays in
-- the routine's history after its thread is gone, because that is a fact about the program rather
-- than a message: the history row still says the change came from Ask (`door`, which no delete
-- touches), it just no longer opens a conversation that exists.
--
-- It is null for every proposal from the MCP door, where there is no conversation on our side of
-- the wire at all, and null for an Ask proposal whose thread the lifter deleted. Those two are the
-- same absence and mean the same thing to a client: there is nothing here to open.
alter table gym_proposals add column if not exists thread_id text
  references gym_ask_threads(id) on delete set null;
-- The thread screen's own read: what this conversation proposed, and what became of each.
create index if not exists gym_proposals_thread on gym_proposals (thread_id);

-- The catalog seed: 64 movements across the seven patterns (the flat legs-vs-three-arm-buckets
-- lopsidedness of Lift's taxonomy is refused; pattern is the only classification). Steps by
-- equipment: barbell 2.5 (smallest plate pair), dumbbell 2.0 (rack gap), machine 5.0 (pin),
-- cable 2.5, bodyweight 2.5 (belt plate — and negative weight is legal for band-assisted work),
-- kettlebell 4.0. dip, pull-up and muscle-up are distinct ids with "weighted" expressed by
-- load, not identity — that keeps the phase-3 strength-tree chain expressible from logged sets.
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
