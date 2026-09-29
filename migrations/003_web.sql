-- The web is a third adapter: what it captures says so.
alter table memories drop constraint memories_source_check;
alter table memories add constraint memories_source_check check (source in ('mcp', 'cli', 'web'));
