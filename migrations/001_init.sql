-- deizmem, esquema inicial. Diseño en CLAUDE.md §4.

create extension if not exists unaccent;
create extension if not exists pgcrypto;

-- Full-text sin idioma (§7): simple + unaccent, sin stemming. Ninguna regla de un
-- idioma entra al índice.
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'dm_simple') then
    create text search configuration dm_simple (copy = simple);
    alter text search configuration dm_simple
      alter mapping for hword, hword_part, word with unaccent, simple;
  end if;
end $$;

create table owners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table pairing_codes (
  code_hash   text primary key,
  owner_id    uuid not null references owners(id),
  channel     text not null check (channel in ('mcp')),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id),
  channel     text not null,
  label       text,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  last_used_at timestamptz
);

-- Sin owner_id a propósito: un blob se dedupea por contenido.
create table blobs (
  sha256      text primary key,
  size        bigint not null,
  media_type  text not null,
  created_at  timestamptz not null default now()
);

create table domains (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id),
  slug        text not null,
  label       text not null,
  description text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (owner_id, slug)
);

create table memories (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references owners(id),
  source            text not null check (source in ('mcp', 'cli')),
  captured_at       timestamptz not null default now(),
  occurred_at       date,
  blob_sha256       text references blobs(sha256),
  filename          text,
  media_type        text,
  note              text,
  normalized_text   text,
  lane              text check (lane in ('inline', 'document', 'vision', 'audio', 'agent')),
  status            text not null default 'pending'
                    check (status in ('pending', 'ready', 'needs_text', 'failed')),
  status_detail     text,
  domain_id         uuid references domains(id),
  domain_confidence real,
  classified_by     text,
  needs_review      boolean not null default false,
  title             text,
  tags              text[] not null default '{}',
  facts_checked_at  timestamptz,
  hidden            boolean not null default false,
  check (blob_sha256 is not null or note is not null or normalized_text is not null)
);
create index memories_owner_idx on memories (owner_id, captured_at desc);
create index memories_status_idx on memories (owner_id, status);

-- Trozos: lo que se busca y lo que se cita.
create table chunks (
  id          bigserial primary key,
  owner_id    uuid not null references owners(id),
  memory_id   uuid not null references memories(id) on delete cascade,
  seq         int not null,
  content     text not null,
  tsv         tsvector generated always as (to_tsvector('dm_simple'::regconfig, content)) stored,
  unique (memory_id, seq)
);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_owner_idx on chunks (owner_id, memory_id);

create table fact_types (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references owners(id),
  slug            text not null,
  kind            text not null check (kind in ('estado', 'periodo')),
  cardinality     text not null default 'one' check (cardinality in ('one', 'many')),
  description     text not null,
  domain_slug     text,
  fields          jsonb not null,
  identity_field  text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (owner_id, slug),
  check (cardinality = 'one' or identity_field is not null),
  check (kind = 'periodo' or identity_field is not null)
);

create table facts (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references owners(id),
  memory_id      uuid not null references memories(id) on delete cascade,
  type_id        uuid not null references fact_types(id),
  identity       text not null default '',
  payload        jsonb not null,
  evidence       jsonb not null,
  valid_from     date,
  valid_until    date,
  superseded_by  uuid references facts(id) on delete set null,
  confidence     real,
  extracted_by   text not null,
  created_at     timestamptz not null default now(),
  unique (memory_id, type_id, identity)
);
create index facts_lookup_idx on facts (owner_id, type_id, identity);

-- La cola del worker. for update skip locked, sin Redis.
create table jobs (
  id          bigserial primary key,
  kind        text not null,
  payload     jsonb not null,
  run_after   timestamptz not null default now(),
  attempts    int not null default 0,
  locked_at   timestamptz,
  done_at     timestamptz,
  error       text
);
create index jobs_ready_idx on jobs (run_after) where done_at is null;

create table audit_log (
  id          bigserial primary key,
  owner_id    uuid not null references owners(id),
  action      text not null,
  target      text not null,
  detail      jsonb not null default '{}',
  at          timestamptz not null default now()
);
