-- Windmill backend schema. A tree's lattice lives as per-entry rows (tree_nodes /
-- tree_edges / tree_kinds) so an edit writes only the rows it touched; tree_ops is
-- append-only history. trees.document is the legacy whole-tree jsonb snapshot, read only
-- to backfill rows on a tree's first post-migration open.
--
-- Ids are text, matching the domain's string ids (node ids like "renderer", tree slugs
-- like "windmill-roadmap"). Server-minted uuid ids + slugs arrive with accounts (§13).

create extension if not exists citext;

-- identity & orgs (Phase 1+). Auth is passwordless magic links (guidelines/auth.md):
-- "passwords never exist", so users carry no password_hash and no handle — an editable
-- name seeded from the email is the whole profile in v1.
create table if not exists users (
  id         uuid primary key,
  email      citext unique not null,
  name       text not null default '',
  created_at timestamptz not null default now()
);

-- Converge an older users table (email+password) onto the passwordless shape. Safe to
-- re-run: the columns only change on the first apply.
alter table users add column if not exists name text not null default '';
alter table users drop column if exists password_hash;
alter table users drop column if exists handle;

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

-- trees: title, ownership and the snapshot head. The title is an LWW register: `title_hlc`
-- is its stamp in canonical HLC text ('' = unset, the create-time baseline), and
-- `title_ms`/`title_counter` are the stamp's numeric split (the node_progress idiom) so the
-- write can be LWW-guarded in SQL — a save or rename lands a title only under a dominating
-- stamp, so a stale room cache in another process can never revert a newer rename.
-- `document` is the legacy jsonb blob — superseded by the per-entry tables below; kept
-- until every tree's rows are backfilled, then droppable.
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
-- visibility gates every read (domain/Access.h): 'private' is owner-only, 'unlisted'/'public'
-- are readable by anyone holding the id. New trees are PRIVATE, which is what someone writing a
-- plan down expects, and sharing is the deliberate act that opens it. This briefly defaulted to
-- 'unlisted' so that setting a tree private could be sold — taking a default away in order to
-- charge for it back, which is not a thing we do. Privacy is free. An existing table keeps
-- whatever each row already says; only the default for new rows moves.
alter table trees add column if not exists visibility text not null default 'private';
alter table trees alter column visibility set default 'private';

-- the registry list: a caller's live (not soft-deleted) trees, keyed by owner
create index if not exists trees_owner on trees (owner_id) where deleted_at is null;

-- The tree lattice, one row per CRDT entry. An edit upserts only the rows it touched —
-- the old whole-document write pushed the entire tree (descriptions can be KBs per node)
-- through MVCC/TOAST/WAL on every single edit. Rows are never deleted by a save: the
-- lattice is entry-grow-only (a delete is a tombstone stamp), so saves are pure upserts.
-- Stamps are the canonical HLC text ("physicalMs:counter:actor", '' = unset); they are
-- never compared in SQL — `present` is computed by the writer for read-side projections.
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
-- angular reorder (§F11): `ord` is a node's fractional-index sort key (opaque text, LWW by
-- `ord_hlc`), scoped to its parent. Converge a tree_nodes table that predates the column.
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

-- per-tree share unfurl card (og-tree-cards): the client renders its tree to a 1200×630 PNG
-- and uploads it; GET /og/:id.png serves it as the link's og:image (a missing card falls back
-- to the generic image). One row per tree, replaced on each re-upload — the bytes live inline
-- as bytea, well under a megabyte. No FK to trees: the row is addressed by tree id and read
-- behind the tree's own visibility gate, so a stray row for a deleted tree is simply unreachable.
create table if not exists tree_og_images (
  tree_id    text primary key,
  png        bytea not null,
  updated_at timestamptz not null default now()
);

-- append-only op log: activity, undo, reconnect replay (Phase 2)
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

-- per-user private progress overlay, a last-writer-wins register per node. `status` is a
-- stamped value including 'none' (a clear is a value, never a row delete) so a clear converges
-- across a user's devices and a stale mark can't resurrect it. `stamp_ms`/`stamp_counter` are
-- the HLC split out for a numeric LWW comparison — the room clock mints a unique (ms, counter)
-- per write, so the pair totally orders every write to a tree; the actor tiebreak is moot.
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

-- passwordless sign-in (guidelines/auth.md). A magic link is addressed by the digest of
-- its secret (the raw token is never at rest); it works once and lasts 15 minutes.
-- Lifetimes the domain owns are stored as epoch-millisecond bigints so no timezone maths
-- sits between the code and the row. consumed_ms is null until the link is spent.
create table if not exists magic_links (
  token_hash  text primary key,
  email       citext not null,
  created_ms  bigint not null,
  expires_ms  bigint not null,
  consumed_ms bigint,
  created_at  timestamptz not null default now()
);
-- the rate-limit query: unspent links for an email within the recent window
create index if not exists magic_links_email_created on magic_links (email, created_ms);
-- a pending fork may ride the link: the tree to copy into whatever account verify signs in
alter table magic_links add column if not exists fork_source text;

-- 90-day rolling sessions, one row per device, keyed by the digest of the cookie secret.
create table if not exists sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_ms bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user on sessions (user_id);

-- settings §5: session metadata (device/place/last-active) the "Sessions & devices" list
-- shows. `id` is the public per-session handle the revoke endpoint addresses (the digest
-- stays server-side); user_agent/ip are stored raw (the client formats device/place, the
-- server never geo-resolves); last_seen_ms rolls forward on every authenticated use, so a
-- row minted before this column existed reads 0 and the list coalesces it to created_at.
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
alter table sessions add column if not exists user_agent text not null default '';
alter table sessions add column if not exists last_seen_ms bigint not null default 0;
alter table sessions add column if not exists ip text not null default '';
create unique index if not exists sessions_id on sessions (id);

-- settings: personal MCP API keys. A long-lived per-user bearer token that authenticates MCP
-- requests as a static-token fallback for OAuth-less clients. Show-once, hash-at-rest: the key is
-- keyed by the digest of its secret (the raw token is never stored), listable and revocable,
-- scoped to its owner. `id` is the public per-key handle the revoke endpoint addresses.
-- expires_ms is nullable (unused in v1 = never expires) but resolveKey still honours it;
-- last_used_ms rolls forward on use (throttled). The users cascade makes a key vanish with its
-- account, and findActiveUser also refuses one whose account carries the §4 soft-close stamp.
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

-- settings §4 delete: a soft close with a 30-day grace. `deleted_at` stamps the request;
-- the account fully closes 30 days later. A within-grace magic-link sign-in clears it (the
-- undo), and authenticate refuses any session whose user carries it.
alter table users add column if not exists deleted_at timestamptz;

-- settings §2 connected tools: the per-user, per-client authorization record the grants
-- list reads. granted_ms is stable (set once, kept as the earliest); last_used_ms advances
-- as the client's tokens act — both live here, not on the rotation-prone oauth_tokens rows.
create table if not exists oauth_grants (
  user_id      uuid not null references users(id) on delete cascade,
  client_id    text not null,
  granted_ms   bigint not null,
  last_used_ms bigint not null default 0,
  primary key (user_id, client_id)
);

-- OAuth 2.1 authorization for the MCP resource server (MCP Authorization spec, 2025-06-18).
-- Dynamically-registered public clients, single-use PKCE-bound authorization codes, and
-- audience-bound opaque access/refresh tokens — only the digest of each secret is at rest.
create table if not exists oauth_clients (
  client_id     text primary key,
  redirect_uris text[] not null,
  client_name   text not null default '',
  created_at    timestamptz not null default now()
);

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

-- first-party funnel telemetry (event-spine): an append-only stream of beacon events.
-- session_key is the client-minted per-browser id; user_id is resolved server-side from
-- the wm_session cookie / Bearer token — never trusted from the body, null for a ghost.
create table if not exists events (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  client_ms   bigint,
  session_key text,
  user_id     uuid,
  name        text not null,
  props       jsonb
);
-- the funnel query: one event name over a time window
create index if not exists events_name_ts on events (name, ts);

-- the feedback door: one-click notes from anyone, signed-in or ghost. session_key is the
-- client-minted correlation id (never identity); user_id is resolved server-side from the
-- wm_session cookie / Bearer token — never trusted from the body, null for a ghost.
create table if not exists feedback (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  session_key text,
  user_id     uuid,
  message     text not null,
  email       text,
  context     text
);
-- the weekly read: newest feedback first
create index if not exists feedback_ts on feedback (ts);

-- the server-side safety net: an uncaught exception that escaped an HTTP/WS handler, so a broken
-- endpoint is queryable here instead of only in a container's stdout (the mirror of the client's
-- crash beacon). method/path/message are best-effort; actor is nullable — the exception handler
-- often can't resolve a caller. The per-handler try/catch paths never land here; this is only for
-- the exceptions nobody caught.
create table if not exists server_errors (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  method  text,
  path    text,
  status  int not null default 500,
  message text,
  actor   uuid
);
-- the triage read: newest errors first
create index if not exists server_errors_ts on server_errors (ts);

-- ── Paddle billing ──────────────────────────────────────────────────────────────────────────
-- Webhooks are the source of truth: every notification upserts here, so access gating reads this
-- database instead of round-tripping the Paddle API. The bridge from a Windmill account to a
-- Paddle customer is EMAIL (citext, matching users.email) — a user has no Paddle customer until
-- their first checkout, when customer.created arrives.
create table if not exists paddle_customers (
  customer_id text primary key,   -- "ctm_..."
  email       citext not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists paddle_customers_email on paddle_customers (email);

-- Deliberately NO foreign key to paddle_customers: Paddle does not order its deliveries, so a
-- subscription event can arrive before the customer event it references. Both tables converge on
-- the latest state through upserts, and an orphan row simply reads as "no access" until its
-- customer lands.
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
-- Paddle retries a failed delivery for ~3 days, so an OLD event can land AFTER a newer one (a
-- retried "active" arriving after a real "canceled" would hand back paid access). Every write
-- carries the event's occurred_at and the upsert refuses to go backwards.
alter table paddle_subscriptions add column if not exists occurred_at timestamptz;
-- Our checkout binds identity server-side: it stamps custom_data.user_id on the transaction, Paddle
-- carries it onto the subscription, and the webhook lands it here. Gating reads this first and falls
-- back to the email match only for subscriptions created outside that flow (e.g. by hand in the
-- Paddle dashboard). Converge a table that predates the column.
alter table paddle_subscriptions add column if not exists user_id uuid;
create index if not exists paddle_subscriptions_user on paddle_subscriptions (user_id);

-- ── The playable demo tree (F4) ─────────────────────────────────────────────────────────────
-- The hosted "Learn to sail" roadmap a stranger meets at #/demo — read anonymously over both
-- HTTP and WS, so the row must exist AND be public or read enforcement 404s it for every visitor.
-- Seeded as data (idempotent, re-applied each deploy): a lost row self-heals on the next deploy.
-- The demo is read-only for visitors — they fork their own copy — so this seed never races a live
-- edit. Stamps are the genesis HLC ('1:0:genesis'); '0:0:' is the never-set / never-deleted
-- sentinel and `present` is the writer's add-biased projection flag. Positions are null on purpose:
-- the client lays the tree out radially from the DAG. Only this one id is pinned public; the
-- dogfood tree (t_9362d9bc883e0a1e) stays private, owned by the MCP principal.
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

-- Force the demo live even if a pre-existing row is private OR soft-deleted: the INSERT above
-- no-ops on an existing row, so it can't repair one whose state drifted. Every read path filters
-- `deleted_at is null`, so a stray soft-delete reads byte-identical to absent — republish and
-- un-delete so the front door can never be dark while a row exists.
update trees set visibility = 'public', deleted_at = null where id = 't_9e407a96b5330ebe';
