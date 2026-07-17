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
