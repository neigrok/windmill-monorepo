-- Windmill backend schema. The tree document (trees.document jsonb) is the source of
-- truth; tree_ops is append-only history. Phase 0 uses trees + node_progress only;
-- the rest is created ahead for later phases.
--
-- Ids are text, matching the domain's string ids (node ids like "renderer", tree slugs
-- like "windmill-roadmap"). Server-minted uuid ids + slugs arrive with accounts (§13).

create extension if not exists citext;

-- identity & orgs (Phase 1+)
create table if not exists users (
  id            uuid primary key,
  email         citext unique not null,
  handle        text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

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

-- trees: the document IS the source of truth (loose-graph state; Phase 0 = projected TreeData)
create table if not exists trees (
  id          text primary key,
  org_id      uuid,
  owner_id    uuid,
  title       text not null default '',
  visibility  text not null default 'private',
  head_seq    bigint not null default 0,
  forked_from text,
  document    jsonb not null default '{"nodes":[]}'::jsonb,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- append-only op log: activity, undo, reconnect replay (Phase 2)
create table if not exists tree_ops (
  tree_id    text not null,
  seq        bigint not null,
  actor_id   uuid,
  op_id      uuid not null,
  kind       text not null,
  payload    jsonb not null,
  hlc        text not null,
  created_at timestamptz not null default now(),
  primary key (tree_id, seq),
  unique (tree_id, op_id)
);

-- per-user private progress overlay (LWW)
create table if not exists node_progress (
  tree_id    text not null,
  user_id    text not null,
  node_id    text not null,
  status     text not null,
  hlc        text not null default '',
  updated_at timestamptz not null default now(),
  primary key (tree_id, user_id, node_id)
);
