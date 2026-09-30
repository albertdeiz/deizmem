-- A file read with a password. Its text stays; nothing re-reads it without the
-- password, and the password itself is never stored (CLAUDE.md §5).
alter table memories add column password_protected boolean not null default false;
