-- Embedding spaces (CLAUDE.md §7). One row per (model, dimensions); vectors of
-- different spaces live side by side and are never compared with each other.
create extension if not exists vector;

create table embedding_spaces (
  id            serial primary key,
  model         text not null,
  dimensions    int not null check (dimensions between 1 and 4096),
  status        text not null check (status in ('building', 'active', 'retired')),
  created_at    timestamptz not null default now(),
  activated_at  timestamptz,
  unique (model, dimensions)
);
-- At most one active and one building space at a time.
create unique index embedding_spaces_one_active on embedding_spaces (status) where status in ('active', 'building');

-- No fixed dimension on the column: each space gets its own partial index with
-- the cast, created when the space is.
create table chunk_embeddings (
  chunk_id   bigint not null references chunks(id) on delete cascade,
  space_id   int not null references embedding_spaces(id) on delete cascade,
  embedding  vector not null,
  primary key (space_id, chunk_id)
);
